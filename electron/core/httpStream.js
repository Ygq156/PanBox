'use strict'

/**
 * 共用的 HTTP(S) 取流层 —— 分段下载器与 HLS 引擎都用它。
 *
 * 为什么单独一层
 * --------------
 * 原来这套「裸 GET + 自己跟重定向 + 走代理」的代码写在 `segmentDownloader.js` 里，
 * HLS 引擎要用同一套能力（同一份代理规则、同一份超时与取消语义、同一份证书策略），
 * 与其抄一遍，不如抽出来。抄一遍的代价不是多几十行，而是**两处行为会慢慢漂开**：
 * 某天给分段下载加了「本机地址绕过代理」，HLS 那边就会莫名其妙地被代理掉。
 *
 * 设计要点
 * --------
 * - 用 `node:http(s)` 而不是 `fetch`：只有自己管 Agent 才能保证「N 个请求 = N 条 TCP
 *   连接」（`agent:false`）。全局 fetch（undici）在 HTTP/2 上会把并发请求复用进
 *   同一条连接，连接数就白加了。
 * - 默认按 Node 的规矩校验证书，只有用户在设置里显式勾选「忽略证书错误」才关掉。
 * - 本机地址（localhost/127.0.0.1/::1）永远绕过代理，否则本地测试服务器会被代理掉。
 */

const http = require('node:http')
const https = require('node:https')
const { shouldBypass } = require('./proxy')
/* 跟重定向时「凭据只发给本站」这条规矩，解析层（parsers/util.js）也要用同一份 */
const { headersForHop } = require('./netHosts')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 裸的 HTTP(S) GET，只暴露「状态码 + 响应头 + 响应流」。
 * `agent:false` 让每个请求都新开一条 socket —— 这正是我们要的「N 请求 = N 连接」。
 * 自己跟重定向（最多 5 跳），因为 node:https 不会跟。
 *
 * `proxy`（`http://host:port`，可选）走 HTTP 代理：
 *   - http 目标 → 直接把绝对 URI 交给代理（`GET http://host/path`）
 *   - https 目标 → 先 `CONNECT host:443` 建隧道，再在**这条 socket 上**跑 TLS
 * 为什么必须有：GitHub 这类被墙的资源裸连是 0 B/s（SSL/TLS handshake failure），
 * 走系统代理能到 10 MB/s（实测，见 electron/core/proxy.js 顶部注释）。
 * 本机地址（localhost/127.0.0.1/::1）永远绕过代理，否则本地测试服务器会被代理掉。
 */
function openStream(url, { headers = {}, signal, timeout = 30000, redirects = 5, proxy = '', insecure = false } = {}) {
  /* 默认按 Node 的规矩校验证书。以前这里硬编码 rejectUnauthorized:false，
   * 等于把所有直链内容暴露给任何中间人（公共 WiFi / 系统代理都能静默换文件）；
   * 只有用户在设置里显式勾选「忽略证书错误」才关掉。 */
  const tls = insecure ? { rejectUnauthorized: false } : {}
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return reject(new Error('下载地址不是合法 URL'))
    }

    let px = null
    if (proxy && !shouldBypass(parsed.hostname)) {
      try {
        px = new URL(proxy)
      } catch {
        px = null
      }
    }

    const fail = (e) => reject(e)
    const onRes = (res) => {
      const code = res.statusCode || 0
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        /* 同站（含 www. 这类兄弟主机）照旧带上凭据，会话与防盗链都需要它；
           换到别家主机就摘掉 —— 浏览器也不会把 A 站的 cookie 发给 B 站。 */
        const nh = headersForHop(headers, url, next)
        return openStream(next, { headers: nh, signal, timeout, redirects: redirects - 1, proxy, insecure }).then(resolve, reject)
      }
      resolve({ status: code, headers: res.headers, stream: res, url })
    }
    /* 每个请求都要能被 timeout / abort 掐掉，三种走法共用同一套收尾 */
    const armReq = (req) => {
      req.on('timeout', () => req.destroy(new Error('连接超时')))
      req.on('error', fail)
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('已取消'))
          return
        }
        signal.addEventListener('abort', () => req.destroy(new Error('已取消')), { once: true })
      }
      req.end()
    }

    if (!px) {
      const mod = parsed.protocol === 'http:' ? http : https
      return armReq(mod.request(parsed, { method: 'GET', headers, agent: false, ...tls, timeout }, onRes))
    }

    const pxPort = Number(px.port) || (px.protocol === 'https:' ? 443 : 80)
    const auth = px.username
      ? 'Basic ' + Buffer.from(`${decodeURIComponent(px.username)}:${decodeURIComponent(px.password)}`).toString('base64')
      : ''
    const pxMod = px.protocol === 'https:' ? https : http

    if (parsed.protocol === 'http:') {
      return armReq(
        pxMod.request(
          {
            host: px.hostname,
            port: pxPort,
            method: 'GET',
            path: parsed.toString(),
            headers: { ...headers, Host: parsed.host, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
            agent: false,
            ...tls,
            timeout,
          },
          onRes,
        ),
      )
    }

    const target = `${parsed.hostname}:${parsed.port || 443}`
    const connectReq = pxMod.request({
      host: px.hostname,
      port: pxPort,
      method: 'CONNECT',
      path: target,
      headers: { Host: target, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
      agent: false,
      ...tls,
      timeout,
    })
    connectReq.on('connect', (res, socket, head) => {
      if ((res.statusCode || 0) !== 200) {
        socket.destroy()
        return fail(new Error(`代理拒绝 CONNECT（HTTP ${res.statusCode}）`))
      }
      if (head && head.length) socket.unshift(head)
      const req = https.request(
        {
          socket,
          agent: false,
          /* host/port 必须显式给：只挂 socket 的话 Node 不会自己补 `Host:` 头，
           * 而 GitHub 这类站点没有正确的 Host 会直接回 404（踩过）。 */
          host: parsed.hostname,
          port: parsed.port || 443,
          servername: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: { ...headers, Host: parsed.host },
          ...tls,
        },
        onRes,
      )
      armReq(req)
    })
    armReq(connectReq)
  })
}

/** 读一小段响应体（探测用），读完主动断掉 */
async function readAll(stream, limit = 1 << 20) {
  const chunks = []
  let n = 0
  try {
    for await (const c of stream) {
      chunks.push(c)
      n += c.length
      if (n >= limit) break
    }
  } catch {
    /* ignore */
  }
  stream.destroy()
  return Buffer.concat(chunks)
}

/** 读完整段响应体（分片 / 播放列表用）。`max` 只是防呆上限，正常远达不到 */
async function readWhole(stream, max = 512 * 1024 * 1024) {
  const chunks = []
  let n = 0
  for await (const c of stream) {
    chunks.push(c)
    n += c.length
    if (n > max) {
      stream.destroy()
      throw new Error(`响应体过大（超过 ${Math.round(max / 1048576)}MB），已中止`)
    }
  }
  return Buffer.concat(chunks)
}

/** 把 HTTP 状态码翻译成人话 */
function httpError(status) {
  const map = {
    401: '需要登录（401）',
    403: '被拒绝（403）——通常是并发太高或直链已过期',
    404: '文件不存在（404）',
    412: '被 CDN 拒绝（412）——游客直链或并发过高',
    416: '分段范围无效（416）',
    429: '请求太频繁（429）',
    503: '服务端暂时不可用（503）——通常是并发太高',
  }
  return map[status] || `HTTP ${status}`
}

/**
 * 取一整段响应体（可选 `Range`），非 2xx 直接抛。
 * 分片下载、HLS 分片、密钥文件都走这里 —— 状态码判断只有这一处。
 */
async function fetchBytes(url, { headers = {}, range = '', proxy = '', insecure = false, timeout = 30000, signal, max } = {}) {
  const h = { ...headers }
  if (range) h.Range = range
  const res = await openStream(url, { headers: h, signal, timeout, proxy, insecure })
  if (res.status < 200 || res.status >= 300) {
    res.stream.destroy()
    throw new Error(httpError(res.status))
  }
  const buf = await readWhole(res.stream, max)
  return { buf, status: res.status, headers: res.headers, url: res.url }
}

/** 取文本（播放列表 / 密钥清单）。`max` 给播放列表一个足够大的默认值 */
async function fetchText(url, opts = {}) {
  const { buf, headers, url: finalUrl } = await fetchBytes(url, { max: 8 * 1024 * 1024, ...opts })
  return { text: buf.toString('utf8'), headers, url: finalUrl }
}

module.exports = { sleep, openStream, readAll, readWhole, httpError, fetchBytes, fetchText }