'use strict'

const dns = require('node:dns').promises
/* 跟重定向时「凭据只发给本站」这条规矩与下载引擎共用一份实现 */
const { headersForHop } = require('../core/netHosts')

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/* ------------------------------------------------------------------ */
/* 出站请求护栏                                                        */
/* ------------------------------------------------------------------ */

/** 解析（或重定向到）本机/局域网地址的拦截。 */
const MAX_RESP_SIZE = Number(process.env.PANBOX_MAX_RESP || 8 * 1024 * 1024) || 8 * 1024 * 1024

/* ------------------------------------------------------------------ */
/* 出站走不走系统代理                                                  */
/* ------------------------------------------------------------------ */

/* Node 自带的 fetch（undici）**不读 Windows 系统代理** —— 系统开着代理时，
 * 解析请求仍然是本机直连。实测后果（2026-10，同一台机器、同一时刻）：
 *   papers.ssrn.com / download.ssrn.com  直连 → UND_ERR_CONNECT_TIMEOUT
 *                                        走代理 → 能连上（403 = 站点的挑战，不是网络问题）
 * 也就是说直连状态下这两个域连「站点的反爬页」都拿不到，用户看到的是「请求超时」。
 * 所以跟随系统代理这件事必须显式装上，不能指望运行时自动。 */
let proxyInstalled = ''

/**
 * 让 util.req 的出站跟随系统代理。由 electron/main.js 在启动时喂一次
 * （代理配置属于 settings/main 那一层，parsers 不该自己去读设置）。
 * @param {string} uri 形如 `http://127.0.0.1:7897`；空字符串 = 直连
 */
function setOutboundProxy(uri) {
  const want = String(uri || '').trim()
  if (want === proxyInstalled) return { ok: true, changed: false, proxy: want }
  proxyInstalled = want
  if (!want) return { ok: true, changed: true, proxy: '' }
  try {
    /* 延迟 require：只有真的要装代理时才碰 undici。
     * noProxy 必须带上本机 —— 否则假站点测试与 bridge（127.0.0.1:7799）也会被塞进代理。 */
    const { ProxyAgent, setGlobalDispatcher } = require('undici')
    setGlobalDispatcher(new ProxyAgent({ uri: want, noProxy: 'localhost,127.0.0.1,::1' }))
    return { ok: true, changed: true, proxy: want }
  } catch (e) {
    return { ok: false, changed: true, proxy: '', message: (e && e.message) || String(e) }
  }
}

/** 现在装的是哪个代理（空 = 直连）。给测试与诊断用。 */
function outboundProxy() {
  return proxyInstalled
}

/** 日志/错误里出现的 URL 去掉 query —— 分享链接的 ?pwd= 与直链签名都在 query 里 */
function safeUrl(u) {
  try {
    const x = new URL(String(u))
    return `${x.protocol}//${x.host}${x.pathname}`
  } catch {
    return '(非法地址)'
  }
}

/** 把 IPv4-mapped IPv6（::ffff:127.0.0.1 / ::ffff:7f00:1 两种写法）折算回 IPv4 */
function unmapV4(h) {
  const s = String(h || '').toLowerCase()
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)
  if (m) return m[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s)
  if (!hex) return ''
  const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16)
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
}

/** 这个 host 是不是「本机或局域网」的字面量地址 */
function isPrivateHost(host) {
  const raw = String(host || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  const h = unmapV4(raw) || raw
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '::') return true
  /* IPv6：fc00::/7 唯一本地地址、fe80::/10 链路本地 */
  if (h.includes(':')) return /^(fc|fd|fe8|fe9|fea|feb)/.test(h)
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false /* 普通域名：交给 assertOutbound 做 DNS 解析再判 */
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true /* 100.64/10 CGNAT */
  if (a === 169 && b === 254) return true /* 链路本地 */
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/**
 * 出站准入：只允许 http(s)，且默认拒绝本机/局域网地址。
 *
 * 为什么：网盘页面/接口的响应里会带「下一步去哪儿」（蓝奏的 json.dom、页面里的
 * P_AJAX_ABSOLUTE、夸克的 download_url）。如果不去校验，被黑掉或被中间人的响应就能
 * 指挥主进程带着用户 Cookie 去打 127.0.0.1:7799 或 192.168.x.x —— 内网探测 + 凭据外发。
 *
 * allowLocal 只对**本机字面量**生效（用户自己把解析接口指向 localhost 是合理用法）；
 * 域名解析到内网（DNS rebinding）一律拒绝，因为那正是攻击手法。
 */
async function assertOutbound(url, { allowLocal = false } = {}) {
  let u
  try {
    u = new URL(String(url))
  } catch {
    throw new Error(`出站地址不是合法 URL：${safeUrl(url)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只允许 http(s) 出站，拒绝 ${u.protocol}//`)
  }
  if (isPrivateHost(u.hostname)) {
    if (allowLocal && u.protocol === 'http:') return
    throw new Error(`拒绝访问本机/局域网地址：${u.hostname}（如确有需要，请在解析接口设置里允许）`)
  }
  let addrs = []
  try {
    addrs = await dns.lookup(u.hostname, { all: true })
  } catch {
    return /* 解析不了就交给 fetch 去报错，别在这里编错误信息 */
  }
  if (addrs.some((a) => isPrivateHost(a.address))) {
    throw new Error(`拒绝访问解析到内网的地址：${u.hostname}`)
  }
}

/* 只认「确实是网页/文本」的类型；空类型也按网页处理（老站点常常不写 content-type）。
 * 明确是二进制（文件本体、安装包、压缩包、影音、字体、PDF…）的一律不读正文。 */
const TEXTUAL_TYPE =
  /^(?:text\/|application\/(?:xhtml\+xml|json|[a-z0-9.+-]*\+?json|javascript|ecmascript|xml|x-www-form-urlencoded))/i
/** 类型没写、只给了大小的情况：超过这个大小也不读了 */
const HUGE_BODY = 32 * 1024 * 1024

/**
 * 这个响应是不是「二进制本体」——安装包、压缩包、影音、字体之类。
 * 这类响应读正文没有任何意义（正文里不会有网页结构），只会：
 *   ① 把几十 MB 甚至几 GB 读进主进程；
 *   ② 撞上 8MB 上限，报出「响应体过大」这种用户看不懂的错。
 * 所以判定为二进制时**直接丢弃**：不读字节，也不因为大小报错。
 */
function isBinaryBody(headers, size) {
  const ct = String((headers && headers.get && headers.get('content-type')) || '').trim()
  if (ct) return !TEXTUAL_TYPE.test(ct)
  const n = Number(size || 0)
  return Number.isFinite(n) && n > HUGE_BODY
}

/** 把响应体丢掉、连接回收。调用过一次之后这个响应就不能再读了。 */
async function dropBody(res) {
  try {
    await res?.body?.cancel()
  } catch {
    /* 已经断了就算了 */
  }
}

/** 带上限的响应体读取：被控/被黑的服务器塞一个超大响应不能把主进程读爆。
 *  二进制本体（见 isBinaryBody）不进这里 —— 调用方应先判定并丢弃。 */
async function readTextCapped(res, limit, what) {
  const buf = Buffer.from(await readAll(res.body, limit, what))
  return buf.toString('utf8')
}

/** 把 Web ReadableStream 读成 Buffer，超过 limit 直接抛错（不静默截断）。
 *  what 只用于把「是哪个地址、拿到了什么」补进错误文案，不改判定。 */
async function readAll(readable, limit, what) {
  const chunks = []
  let n = 0
  if (!readable) return Buffer.alloc(0)
  for await (const chunk of readable) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    n += b.length
    if (n > limit) {
      throw new Error(`响应体过大（超过 ${Math.round(limit / 1024 / 1024)}MB），已中止${what ? `：${what}` : ''}`)
    }
    chunks.push(b)
  }
  return Buffer.concat(chunks)
}

/**
 * 带超时的 fetch 封装。所有网盘解析都走这里，便于统一加 UA / Cookie / Referer。
 */
/** 极简 cookie 罐：蓝奏云的 acw_sc__v2 / down_ip、夸克的 __pugs 都要跨请求带上 */
class Jar {
  constructor(init) {
    this.c = new Map()
    if (init) this.setFromString(init)
  }
  set(k, v) {
    this.c.set(String(k), String(v))
  }
  get(k) {
    return this.c.get(k)
  }
  del(k) {
    this.c.delete(String(k))
  }
  setFromString(s) {
    for (const part of String(s || '').split(';')) {
      const i = part.indexOf('=')
      if (i > 0) this.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
    }
  }
  /** 把响应的 Set-Cookie 全部吸收进来 */
  absorb(headers) {
    if (!headers) return
    let list = []
    try {
      list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
    } catch {
      list = []
    }
    for (const line of list || []) {
      const first = String(line).split(';')[0]
      const i = first.indexOf('=')
      if (i > 0) this.set(first.slice(0, i).trim(), first.slice(i + 1).trim())
    }
  }
  toString(extra) {
    const parts = [...this.c].map(([k, v]) => `${k}=${v}`)
    if (extra) parts.push(String(extra))
    return parts.join('; ')
  }
}

async function req(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 25000,
    cookie,
    jar,
    /* 'manual' = 不跟重定向，把 3xx 原样返回给调用方（蓝奏/优享要靠 Location 头自己走下一步）。
     * 'follow'（默认）= 自己跟，但每一跳都过 assertOutbound（fetch 自带的 follow 做不到这点）。 */
    redirect = 'follow',
    /* 是否允许这条请求打向本机/局域网地址。默认 false —— 远端响应不该把请求
     * 带去内网（见下面 assertOutbound 的注释）。只有用户**自己**在设置里把解析
     * 接口或直链指向内网时，才由调用方显式放开。 */
    allowLocal = false,
    /* 只要响应头，正文交给调用方自己决定读不读。
     * 少数探测型调用方（只看 Location / 类型，不看正文）用它省一次读取；
     * 打开后返回值里的 `body` 就是原始流，读取请用 readTextCapped(res, MAX_RESP_SIZE)。 */
    noBody = false,
  } = opts

  const h = { 'User-Agent': DEFAULT_UA, ...headers }
  const ck = jar ? jar.toString(cookie) : cookie
  if (ck) h['Cookie'] = ck

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    /* 自己跟重定向（以前交给 fetch 的 redirect:'follow'）：这样每一跳都能校验
     * 目标地址，避免「网盘接口/页面返回一个 302 到 127.0.0.1 或 192.168.x.x」时，
     * 主进程带着 Cookie 打过去（内网探测 + 凭据外发）。最多 5 跳，与浏览器一致。
     * redirect:'manual' 的调用方（蓝奏/优享）保持原样：只请求一次，3xx 交给它们自己处理。 */
    let current = String(url)
    let res = null
    const maxHop = redirect === 'manual' ? 0 : 5
    for (let hop = 0; ; hop++) {
      await assertOutbound(current, { allowLocal })
      /* 凭据只发给「本站」：跳到别家主机就摘掉 Cookie / Authorization
       * （浏览器也不会把 A 站的 cookie 发给 B 站）。需要自己跨站带 cookie 的流程
       * —— 蓝奏、优享 —— 走 redirect:'manual'，由它们自己决定带什么，不受这条影响。 */
      res = await fetch(current, {
        method,
        headers: headersForHop(h, url, current),
        body,
        redirect: 'manual',
        signal: ac.signal,
      })
      const code = res.status
      const loc = res.headers.get('location')
      if (redirect === 'manual') break
      if (code >= 300 && code < 400 && loc) {
        if (hop >= maxHop) throw new Error('重定向次数过多')
        const next = new URL(loc, current).toString()
        if (jar) jar.absorb(res.headers)
        try {
          await res.body?.cancel()
        } catch {
          /* ignore */
        }
        current = next
        continue
      }
      break
    }
    if (jar) jar.absorb(res.headers)
    /* 超限时把「哪个地址、什么类型」写进错误里：页面类请求拿到超大响应时，
     * 光一句「响应体过大」看不出是链接过期、被反爬拦了，还是服务端直接回了文件。 */
    const respWhat = `${safeUrl(current)} 返回 HTTP ${res.status} ${res.headers.get('content-type') || '未知类型'}`
    const size = Number(res.headers.get('content-length') || 0)
    /* 二进制本体一律不读正文（它不可能是网页）。这是**全局兜底**：任何解析器、
     * 任何一步请求到「文件本体」时都不会再撞 8MB 上限、也不会白读几十 MB。 */
    const binary = !noBody && isBinaryBody(res.headers, size)
    if (binary) await dropBody(res)
    const text = noBody || binary ? '' : await readTextCapped(res, MAX_RESP_SIZE, respWhat)
    return {
      status: res.status,
      headers: res.headers,
      location: res.headers.get('location') || '',
      size,
      text,
      url: res.url || current,
      /* noBody 时正文还没读，原样交给调用方（判定出不是网页就直接丢掉） */
      body: res.body,
      /* 与服务端返回的文件本体同名的那条地址：调用方可以直接把它当直链 */
      isBinary: binary,
      /* 超限/超时那类错误文案里用的那句「哪个地址、什么类型」 */
      what: respWhat,
    }
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `请求超时：${safeUrl(current)}` : `${e && e.message ? e.message : e}`
    throw new Error(msg)
  } finally {
    clearTimeout(timer)
  }
}

async function reqJson(url, opts = {}) {
  const r = await req(url, opts)
  try {
    return { ...r, json: JSON.parse(r.text) }
  } catch {
    throw new Error(`接口返回不是合法 JSON（HTTP ${r.status}）：${r.text.slice(0, 160)}`)
  }
}

/* ------------------------------------------------------------------ */
/* 网盘识别                                                            */
/* ------------------------------------------------------------------ */

/* 站点表（sites.json）是「一个站点怎么认、能干什么」的唯一出处：
 * 这里只把它的 match 串编译成正则、按 detect 的先后排好（谁先匹配到算谁的）。 */
const SITES = require('./sites.json')

/* 两个容易踩的点，改表时别忘：
 * ① 蓝奏分享页里的**下载入口**（`/fn?TOKEN` 那条 iframe）要认成蓝奏云，不能掉进
 *    「兜底当直链」——它不是文件本体，是一条页。
 * ② 论文站（mdpi / ssrn）域名的边界必须卡住：`mdpi.com` 后面只能是 `/ ? #` 或结尾，
 *    否则 `notmdpi.com` / `mdpi.com.evil.com` 也会被认成它（这是**真的**踩过的坑）。
 * ③ 认得出域名、但没实现解析器的网盘（阿里云盘等）也必须在表里：漏了就会掉进
 *    「兜底当直链」，拿分享页地址去 HEAD，给用户一个莫名其妙的结果。 */
const MATCHERS = SITES.detect.map((netdisk) => {
  const s = SITES.sites[netdisk]
  if (!s || !s.match) throw new Error(`sites.json 里 ${netdisk} 没有 match，却在 detect 名单里`)
  return { netdisk, re: new RegExp(s.match, 'i') }
})

/** 蓝奏云换过无数次域名，认不出来就按主机名里的一小段特征兜 —— 这份名单也在站点表里。 */
const LANZOU_HOSTS = (SITES.sites.lanzou && SITES.sites.lanzou.hosts) || []

function detectNetdisk(url) {
  const u = String(url || '').trim()
  if (!u) return 'unknown'
  for (const m of MATCHERS) if (m.re.test(u)) return m.netdisk
  try {
    const host = new URL(u.startsWith('http') ? u : `https://${u}`).hostname.toLowerCase()
    if (LANZOU_HOSTS.some((h) => host.includes(h))) return 'lanzou'
  } catch {
    /* ignore */
  }
  if (/^https?:\/\//i.test(u) && /\.(zip|rar|7z|exe|msi|apk|pdf|mp4|mkv|iso|tar|gz|txt|jpg|png|mp3|flac)$/i.test(u)) {
    return 'direct'
  }
  if (/^https?:\/\//i.test(u)) return 'direct'
  return 'unknown'
}

/** 从整段粘贴文本里抽出所有链接（一行一个，或夹杂说明文字） */
function extractUrls(text) {
  const out = []
  const re = /https?:\/\/[^\s"'<>）)，,、]+/gi
  let m
  while ((m = re.exec(String(text || '')))) {
    out.push(m[0].replace(/[.,;:]+$/, ''))
  }
  return [...new Set(out)]
}

/** 尝试从文本中提取提取码：?pwd=xxxx / 提取码: xxxx / 密码：xxxx */
function extractPassword(text) {
  const s = String(text || '')
  let m = s.match(/[?&]pwd=([0-9a-zA-Z]{2,12})/i)
  if (m) return m[1]
  m = s.match(/(?:提取码|访问码|密码|passcode|pwd)\s*[:：=]?\s*([0-9a-zA-Z]{2,12})/i)
  if (m) return m[1]
  return ''
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** 把 "1.5M" / "2G" 这类人类可读大小转成字节 */
function humanSizeToBytes(s) {
  if (typeof s === 'number') return s
  const m = String(s || '').trim().match(/^([\d.]+)\s*([KMGTP]?)B?$/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!isFinite(n)) return 0
  const unit = (m[2] || '').toUpperCase()
  const mul = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }[unit] || 1
  return Math.round(n * mul)
}

/** 取 JSON 里任意层级的值 */
function deepFind(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined
  for (const k of keys) if (obj[k] !== undefined) return obj[k]
  for (const v of Object.values(obj)) {
    const r = deepFind(v, keys, depth + 1)
    if (r !== undefined) return r
  }
  return undefined
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 常见 UA */
const UA_PC_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const UA_QUARK =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch'
const UA_MOBILE_ANDROID =
  'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Mobile Safari/537.36'

/* ---- 文件名：从响应类型补后缀 --------------------------------------
 * 浏览器（Chromium 的 net::GetSuggestedFilename）在「服务器没给 content-disposition
 * 文件名」时，会拿 URL 最后一段当名字，**再用响应类型补一个后缀**。所以
 * `https://dl.acm.org/doi/epdf/10.1145/3345768.3355908` 在浏览器里存下来是
 * `3345768.3355908.pdf`。PanBox 以前只做前半步：名字取到了，后缀没了 ——
 * 用户拿到一个没有后缀的文件，得自己改名。
 *
 * 这张表只覆盖「文件本体」类型：text/html、application/json 这类是网页/接口，
 * 给它们补 .html / .json 只会把「这其实不是文件」这件事藏起来。表里没有的类型
 * 补 .bin —— 至少比没有后缀强，用户一眼也能看出这不是原生后缀。
 */
const WEB_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/json',
  'text/json',
  'application/xml',
  'text/xml',
])
const MIME_FOR_APPS = new Map([
  ['pdf', 'pdf'],
  ['x-pdf', 'pdf'],
  ['zip', 'zip'],
  ['x-zip', 'zip'],
  ['x-zip-compressed', 'zip'],
  ['x-7z-compressed', '7z'],
  ['x-rar-compressed', 'rar'],
  ['vnd.rar', 'rar'],
  ['x-tar', 'tar'],
  ['gzip', 'gz'],
  ['x-gzip', 'gz'],
  ['x-bzip2', 'bz2'],
  ['x-xz', 'xz'],
  ['x-msdownload', 'exe'],
  ['x-msdos-program', 'exe'],
  ['x-msi', 'msi'],
  ['java-archive', 'jar'],
  ['vnd.android.package-archive', 'apk'],
  ['x-apple-diskimage', 'dmg'],
  ['epub+zip', 'epub'],
  ['msword', 'doc'],
  ['vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['vnd.ms-excel', 'xls'],
  ['vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['vnd.ms-powerpoint', 'ppt'],
  ['vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['rtf', 'rtf'],
  ['x-mobipocket-ebook', 'mobi'],
  ['vnd.amazon.ebook', 'azw'],
  ['ogg', 'ogg'],
  ['x-flac', 'flac'],
  ['x-iso9660-image', 'iso'],
  ['x-firmware', 'bin'],
  ['octet-stream', 'bin'],
  ['x-binary', 'bin'],
])

/** `application/pdf; charset=utf-8` → `pdf` */
function contentTypeExt(ct) {
  const s = String(ct || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!s || WEB_TYPES.has(s)) return ''
  const m = /^([a-z0-9.-]+)\/(.+)$/.exec(s)
  if (!m) return ''
  const major = m[1]
  let sub = m[2]
  if (major === 'application') {
    const hit = MIME_FOR_APPS.get(sub)
    if (hit) return hit
    /* `image/svg+xml`、`application/vnd.foo+json` 这种带后缀标记的，取 `+` 前那段 */
    sub = sub.replace(/\+.*$/, '')
    if (sub.startsWith('x-')) sub = sub.slice(2)
    return /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'bin'
  }
  return sub.replace(/\+.*$/, '').replace(/^x-/, '')
}

/* 认得出的扩展名。用来判断「名字里是不是已经有后缀了」：
 * 表里认得的（.pdf、.bin…）当然是；表外的只要不像编号（`a.ndjson`）也算，
 * 免得给它叠成 `a.ndjson.pdf`。而**纯数字那段不算后缀** —— `3345768.3355908`
 * 与 `v1.0.6` 的最后一段都是编号，这正是 ACM 那条地址要补 .pdf 的原因。 */
const KNOWN_EXTS = new Set(
  (
    'pdf zip rar 7z tar gz bz2 xz zst exe msi apk ipa dmg iso jar deb rpm appimage ' +
    'doc docx xls xlsx ppt pptx rtf odt ods epub mobi azw azw3 txt md csv json xml html htm ' +
    'png jpg jpeg gif bmp webp svg ico tif tiff heic avif ' +
    'mp3 wav flac aac ogg opus m4a wma ape ' +
    'mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts m3u8 m4s rmvb ' +
    'bin dat img cue nrg vhd vmdk pak cab txz tbz lz4 br'
  ).split(' ')
)

/** 名字最后那一段像不像后缀：`a.pdf`→true、`3345768.3355908`→false */
function hasKnownExt(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''))
  if (!m) return false
  const ext = m[1].toLowerCase()
  if (KNOWN_EXTS.has(ext)) return true
  return !/^\d+$/.test(ext)
}

/**
 * 名字没有后缀时，按响应类型补一个（浏览器就是这么定文件名的）。
 * 有后缀的一律不动 —— 站点给的名字优先。
 */
function withExt(name, ct) {
  const s = String(name || '').trim()
  if (!s || hasKnownExt(s)) return s
  const ext = contentTypeExt(ct)
  return ext ? `${s}.${ext}` : s
}

/**
 * 从地址里抠出一个「像文件名」的东西：先看查询串（`…/download?file=x.pdf` 很常见），
 * 再看路径最后一段。取不到就给空串，由调用方决定兜底叫什么。
 */
function urlBaseName(url) {
  let u
  try {
    u = new URL(String(url || ''))
  } catch {
    return ''
  }
  for (const k of ['filename', 'file', 'name', 'download', 'title']) {
    const v = u.searchParams.get(k)
    if (!v || !v.trim()) continue
    try {
      const d = decodeURIComponent(v).trim()
      if (d && !d.includes('/')) return d
    } catch {
      /* 编码坏了就往下走 */
    }
  }
  try {
    return decodeURIComponent(require('node:path').posix.basename(u.pathname)) || ''
  } catch {
    return ''
  }
}

/* ---- 文件名：从响应头抠出来、洗成各平台都写得出去的名字 ----------------
 * 这两件事以前在 5 个地方各写一遍（main.js、direct、lanzou、mdpi、ssrn），
 * 每处的正则、截断长度、非法字符表都不一样 —— 同一台服务器给的同一个名字，
 * 从哪条路进来可能得到不同的结果（漏掉控制字符、把 `a.ndjson` 当成有后缀、
 * 遇到 `NUL` 这种设备名直接写不进盘）。收敛到一份，取各处最严的那个。
 */

/**
 * `Content-Disposition` → 文件名。认 `filename*=UTF-8''…`（RFC 5987，值是百分号编码）
 * 与 `filename="…"` 两种写法。参数可以是 `util.req` 回来的 Headers，也可以是普通对象。
 * 抠不到就返回空串，由调用方兜底。
 */
function filenameFromHeaders(headers) {
  const raw0 =
    headers && typeof headers.get === 'function' ? headers.get('content-disposition') : (headers || {})['content-disposition']
  const s = String(raw0 || '')
  if (!s) return ''
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(s)
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(s)
  const raw = String((star ? star[1] : plain ? plain[1] : '') || '')
    .trim()
    .replace(/^"|"$/g, '')
  if (!raw) return ''
  /* `filename*` 那条按标准一定是编码过的；`filename=` 那条标准上不该编码，实测有站点编，
   * 所以「看着像编码就试着解，解不开就用原样」—— 不猜，也不因为一个坏 % 丢掉整个名字。 */
  if (star || /%[0-9a-f]{2}/i.test(raw)) {
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return raw
}

/** Windows 保留设备名：这些名字（含带扩展名的形式）不能作为文件名 */
const WIN_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 洗成能落盘的文件名：非法字符与控制字符换成 `_`、连续空白收成一个空格、
 * 掐掉结尾的点与空格（Windows 会静默截断，导致落盘名和任务名对不上，
 * 后续「换直链/续传」按名字找不到文件）、避开设备名。空名字给 `unnamed`。
 *
 * @param s   原始名字
 * @param max 长度上限（NTFS 单段 255，默认 180 给路径留余量）
 */
function sanitizeFileName(s, { max = 180 } = {}) {
  let name = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
  name = name.replace(/[. ]+$/, '')
  if (!name) return 'unnamed'
  const base = name.replace(/\.[^.]*$/, '')
  return WIN_DEVICE_NAMES.test(base) ? `_${name}` : name
}

function form(data) {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

module.exports = {
  DEFAULT_UA,
  UA_PC_CHROME,
  UA_QUARK,
  UA_MOBILE_ANDROID,
  form,
  Jar,
  req,
  reqJson,
  setOutboundProxy,
  outboundProxy,
  readTextCapped,
  MAX_RESP_SIZE,
  isBinaryBody,
  dropBody,
  assertOutbound,
  isPrivateHost,
  safeUrl,
  detectNetdisk,
  extractUrls,
  extractPassword,
  decodeEntities,
  humanSizeToBytes,
  deepFind,
  sleep,
  contentTypeExt,
  hasKnownExt,
  withExt,
  urlBaseName,
  filenameFromHeaders,
  sanitizeFileName,
}
