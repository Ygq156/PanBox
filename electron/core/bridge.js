'use strict'

/**
 * 浏览器插件接收通道（本地 HTTP，默认 127.0.0.1:7799）。
 *
 * 目的：让浏览器里的「下载这个链接」能像 NDM 那样直接落到 PanBox 的下载队列里，
 * 而不是被浏览器自己的下载器接管（浏览器不给插件提供「改下载目录/加线程」的能力，
 * 也不让插件转交 Referer / Cookie，只有本机程序做得到）。
 *
 * 协议（全部只监听回环地址，公网访问不到）：
 *   GET  /ping   -> { ok, app:'PanBox', version, running:true }          不给任何密钥
 *   POST /pair   -> { ok, token, app:'PanBox' }   body 是 { code }
 *                    只认下面钉死的那个扩展源，且要带上 PanBox 设置里生成的 6 位配对码
 *                    （120 秒有效、一次性）。配对码本身从不经过 HTTP 出去，所以先在 7799
 *                    上占坑、自称 PanBox 的本机进程也拿不到它。
 *   POST /add    -> 需要 token，body 是 JSON：
 *        { url, name?, referer?, cookie?, userAgent?, headers?, pageTitle?, title? }
 *                    -> { ok, kind, message, name, size }
 *   POST /page   -> 需要 token，「把这一页的现场交给 PanBox」：
 *        { url, title?, referer?, userAgent?, cookies?: [{host, cookie}], requestHeaders? }
 *                    -> { ok, message }
 *                    凭据只进内存、不落盘、不进日志；用于取那些只认浏览器的分享页。
 *   OPTIONS *    -> CORS 预检
 *
 * 为什么要有 token：CORS 拦不住「网页把请求发出去」这件事（只拦读响应），
 * 而任何网页都能朝 127.0.0.1 发请求。没有 token 的话，一个恶意页面就能往
 * 下载队列里塞任务。token 只在「固定扩展源 + 正确的配对码」同时成立时发一次，
 * 所以网页拿不到，冒充 PanBox 的本机进程也拿不到。
 */

const http = require('node:http')
const crypto = require('node:crypto')

const DEFAULT_PORT = 7799
const MAX_BODY = 512 * 1024

/* 配对码：6 位数字、120 秒有效、用一次就废。
 * 只有 6 位，本机进程硬猜 10^6 次总能撞上，所以再加一条：连续错 5 次这张码直接作废，
 * 想继续试就只能回到 PanBox 窗口重新生成 —— 攻击者拿不到窗口里的码，试错也没有收益。 */
const PAIR_CODE_TTL = 120 * 1000
const PAIR_CODE_MAX_TRIES = 5

function ensureToken(token) {
  if (token && String(token).length >= 16) return String(token)
  return crypto.randomBytes(20).toString('hex')
}

/** 定长比较，避免按字符比较泄露 token 前缀 */
function sameToken(a, b) {
  const x = crypto.createHash('sha256').update(String(a || '')).digest()
  const y = crypto.createHash('sha256').update(String(b || '')).digest()
  return crypto.timingSafeEqual(x, y)
}

/* ------------------------------------------------------------------ */
/* 插件身份：只认这一个源                                              */
/* ------------------------------------------------------------------ */

/* resources/extension/manifest.json 里的 "key" 把扩展 ID 钉死成下面这串：同一份代码装到
 * 哪台机器、从哪个目录加载、重装几次，源都不变。这样 /pair 才能对着一个精确的源校验，
 * 而不是「任何自称是扩展的源」——后者等于没校验（任何已安装的扩展都能来领 token）。
 *
 * ID 由 key 按 Chrome 的算法算出来：
 *   key 是 base64 的 SPKI DER；sha256(DER) 取前 16 字节；每个 nibble n 写成字符 'a' + n。
 * 本仓库这份 key：sha256 = 5701ea40b4845d091fc2ea92d48b5e0242917b9fe380b10f4b7f72c08e1446b8
 *                 前 16 字节 = 5701ea40b4845d091fc2ea92d48b5e02  ->  fhabokealeiefnajbpmcokjcneilfoac
 * 换 key 就会换 ID：必须同时改这里和 manifest.json，用户也得重新加载一次扩展。 */
const EXTENSION_ID = 'fhabokealeiefnajbpmcokjcneilfoac'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`

/** 宽松的「长得像扩展源」。只给 _cors 用（决定回不回 ACAO）；
 *  配对那一步必须用上面的 EXTENSION_ORIGIN 精确比对，不能用这个。 */
function isExtensionOrigin(origin) {
  return /^(chrome|moz|safari-web|ms-browser)-extension:\/\//i.test(String(origin || ''))
}

/* 本机回环地址的各种写法（Host 头里出现这些才算「本机来的」） */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

class Bridge {
  constructor() {
    this.server = null
    this.port = DEFAULT_PORT
    /* 正在进行中的一次 start()（并发进来的第二次要等它，见 start） */
    this._starting = null
    this.token = ''
    this.error = ''
    this.pairedAt = 0
    /* 当前待用的配对码。只在这里（主进程内存）存在，绝不写进任何 HTTP 响应 */
    this.pairCode = ''
    this.pairCodeExp = 0
    this.pairCodeTries = 0
    this.added = 0
    this.lastAddedName = ''
    this.lastAddedAt = 0
    this.lastError = ''
  }

  get running() {
    return !!this.server && this.server.listening
  }

  /**
   * 生成一张新的配对码，给设置界面显示用。只经主进程 IPC 返回，绝不通过 HTTP 发出去 ——
   * 这正是这次修复的要害：码只在 PanBox 自己的窗口里可见。
   */
  newPairCode(ttlMs) {
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : PAIR_CODE_TTL
    const n = crypto.randomInt(0, 1000000)
    this.pairCode = String(n).padStart(6, '0')
    this.pairCodeExp = Date.now() + ttl
    this.pairCodeTries = 0
    return { ok: true, code: this.pairCode, expiresAt: this.pairCodeExp, ttl }
  }

  /** /pair 的准入判定：源必须精确等于插件源，码必须在有效期内且用定长比较对上 */
  _pairDenied(res, reason) {
    this.pairCodeTries += 1
    /* 猜错次数超限就把码作废：6 位空间不大，不能让本机进程无限试 */
    if (this.pairCodeTries >= PAIR_CODE_MAX_TRIES) {
      this.pairCode = ''
      this.pairCodeExp = 0
    }
    /* 响应里不带任何区分信息：是没生成、过期了、还是码不对，一律同一句话 */
    this._json(res, 403, { ok: false, message: reason })
  }

  status() {
    return {
      running: this.running,
      port: this.port,
      host: '127.0.0.1',
      url: `http://127.0.0.1:${this.port}`,
      error: this.running ? '' : this.error,
      added: this.added,
      lastAddedName: this.lastAddedName,
      lastAddedAt: this.lastAddedAt,
      lastError: this.lastError,
      paired: this.pairedAt > 0,
      pairedAt: this.pairedAt,
    }
  }

  /**
   * @param {{port?:number, token:string}} cfg
   * @param {(payload:object)=>Promise<object>} onAdd 由 main.js 提供，负责真正建任务
   */
  async start(cfg, onAdd, onPage) {
    const port = Number((cfg && cfg.port) || DEFAULT_PORT)
    this.token = ensureToken(cfg && cfg.token)
    this.onAdd = onAdd
    this.onPage = onPage
    if (this.running && this.port === port) return this.status()
    /* 并发保护：`bridge:start` 这条 IPC 与 applyRuntimeSettings 可能同时进来。
     * 两边都过了上面那道判断，就会各建一个 server、各 listen 一次 —— 第二个必然
     * EADDRINUSE（写法复刻 aria2 的 _starting）。 */
    if (this._starting) {
      await this._starting.catch(() => {})
      if (this.running && this.port === port) return this.status()
    }
    const p = this._startServer(port)
    this._starting = p
    try {
      return await p
    } finally {
      if (this._starting === p) this._starting = null
    }
  }

  /** start() 的真身。不对外 —— 调它之前必须已经过了 _starting 那道闸。 */
  async _startServer(port) {
    await this.stop()

    this.port = port
    this.error = ''
    const server = http.createServer((req, res) => {
      this._handle(req, res).catch((e) => {
        this.lastError = (e && e.message) || String(e)
        try {
          this._json(res, 500, { ok: false, message: this.lastError })
        } catch {
          /* 响应已经发过了 */
        }
      })
    })
    server.on('error', (e) => {
      this.error =
        e && e.code === 'EADDRINUSE'
          ? `端口 ${port} 被占用（可能是另一个 PanBox，或别的程序）`
          : (e && e.message) || String(e)
    })

    await new Promise((resolve) => {
      let done = false
      const fin = () => {
        if (!done) {
          done = true
          resolve()
        }
      }
      server.once('listening', fin)
      server.once('error', fin)
      /* 只绑回环：局域网里的其它机器连不上 */
      server.listen(port, '127.0.0.1')
    })

    /* ⚠️ 只有真的在监听才认它。
     * 以前是无条件 `this.server = server; if (!this.running) this.server = null`：
     * listen 失败（EADDRINUSE）时 this.running 是 false，于是把 this.server 清成 null ——
     * 而**上一个**启动成功的 server 还在监听、还占着端口，只是引用没了：
     * 通道其实还活着，但 status 永远是 running=false（界面报「端口被占用」、插件
     * 认不出 PanBox），stop() 也关不掉它，之后再 start 永远 EADDRINUSE。 */
    if (server.listening) this.server = server
    else {
      try {
        server.close()
      } catch {
        /* 没监听成功，关不掉也无所谓 */
      }
    }
    return this.status()
  }

  async stop() {
    const s = this.server
    this.server = null
    if (!s) return true
    /* 只 close() 是不够的：插件（Chrome 扩展）走的是 keep-alive 连接，
     * `close()` 要等所有连接自己断开才回调 —— 那可能永远等不到，
     * 于是 bridge.stop() 一挂，退出流程与 applyRuntimeSettings 全卡在这里。
     * 先主动掐断连接，再留一个 1 秒兜底。 */
    await new Promise((r) => {
      let done = false
      const fin = () => {
        if (!done) {
          done = true
          r()
        }
      }
      try {
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections()
      } catch {
        /* 老内核没有这个方法 */
      }
      const timer = setTimeout(fin, 1000)
      if (timer.unref) timer.unref()
      try {
        s.close(fin)
      } catch {
        clearTimeout(timer)
        fin()
      }
    })
    return true
  }

  /**
   * 请求的 Host 必须是本机地址。
   *
   * 为什么必须有这一道：`/pair` 老版只靠 Origin 判断「是不是插件」，而浏览器对**同源 GET
   * 不发 Origin**。攻击者只要把自己的域名（TTL=0）重绑到 127.0.0.1，受害者页面里的
   * `fetch('/pair')` 就成了同源请求、不带 Origin，于是能读到配对令牌，再用它 POST /add
   * 往下载队列里塞任意 URL —— DNS rebinding。（/pair 现在还要配对码了，但这一条拦的是
   * 整个回环通道的「谁在跟我说话」，与具体端点无关，留着。）
   * 而 Host 头是浏览器**无法伪造**的：
   * 重绑之后请求里的 Host 仍然是 evil.com:7799（或 IP 字面量），不是 127.0.0.1/localhost。
   */
  _hostAllowed(req) {
    const raw = String(req.headers.host || '').trim().toLowerCase()
    if (!raw) return false
    const host = raw.startsWith('[')
      ? raw.slice(0, raw.indexOf(']') + 1) /* IPv6 字面量：[::1]:7799 */
      : raw.split(':')[0]
    return LOCAL_HOSTS.has(host)
  }

  _cors(res, origin) {
    /* 预检与读响应都可能来自扩展页面；扩展的 Origin 是 chrome-extension://<id>。
     * 早期版本这里回显任意 Origin，等于给「任何网页」发了读响应的许可；现在收成白名单：
     * 只认扩展源。本机工具（curl / 脚本）没有 Origin，浏览器也不会因为缺 ACAO 就拦它们，
     * 所以收紧这一条不影响扩展配对与投递。 */
    if (isExtensionOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', String(origin))
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-panbox-token')
    res.setHeader('Access-Control-Max-Age', '600')
  }

  _json(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let n = 0
      const chunks = []
      req.on('data', (c) => {
        n += c.length
        if (n > MAX_BODY) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  async _handle(req, res) {
    const origin = req.headers.origin || ''
    this._cors(res, origin)
    const u = new URL(req.url || '/', `http://127.0.0.1:${this.port}`)
    const p = u.pathname.replace(/\/+$/, '') || '/'

    /* Host 校验放在最前面：它不是「某个端点」的防护，而是整个回环通道的准入。
     * 先设 CORS 再判 Host，是为了让被拒的响应也能被扩展读出原因（若真出问题好排查）。 */
    if (!this._hostAllowed(req)) {
      this._json(res, 403, { ok: false, message: '只接受来自本机（127.0.0.1 / localhost）的请求' })
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (p === '/' || p === '/ping') {
      this._json(res, 200, { ok: true, app: 'PanBox', running: true, version: this.version || '' })
      return
    }

    if (p === '/pair') {
      /* 老版本这里是 GET /pair，谁问给谁 token（只看 Origin 长得像不像扩展），
       * 于是任意本机进程先在 7799 占坑、自称 PanBox 就能把 cookie 骗走。
       * 现在只认 POST + 精确扩展源 + 用户从 PanBox 窗口里念过来的配对码。 */
      if (req.method !== 'POST') {
        this._json(res, 405, { ok: false, message: '请用 POST 提交配对码' })
        return
      }
      /* 带 Origin 的必须精确是本扩展：网页 fetch 一定带自己的源，挡的就是它。
       * 但「没带 Origin」不当成攻击特征——本机进程本来就随便伪造 Origin，这条拦不住它；
       * 真正拦它的是下面那把只有 PanBox 窗口里才看得到的 6 位配对码。
       * 这样写也避免了「扩展万一不发 Origin 就直接功能回归」的风险。 */
      if (origin && String(origin) !== EXTENSION_ORIGIN) {
        this._json(res, 403, { ok: false, message: '配对失败：请求来源不是 PanBox 的浏览器插件' })
        return
      }
      let sent = ''
      try {
        const raw = await this._readBody(req)
        sent = String((JSON.parse(raw || '{}') || {}).code || '')
      } catch {
        sent = ''
      }
      const live = !!this.pairCode && Date.now() < this.pairCodeExp
      if (!live || !sent || !sameToken(sent, this.pairCode)) {
        this._pairDenied(res, '配对失败：请在 PanBox 的「设置 → 浏览器插件」里生成配对码后重试')
        return
      }
      /* 一次性：用掉就作废，过期时间一并清掉 */
      this.pairCode = ''
      this.pairCodeExp = 0
      this.pairCodeTries = 0
      this.pairedAt = Date.now()
      this._json(res, 200, { ok: true, token: this.token, app: 'PanBox' })
      return
    }

    if (p === '/add') {
      const body = await this._authedBody(req, res)
      if (!body) return
      let out
      try {
        out = await this.onAdd(body)
      } catch (e) {
        out = { ok: false, message: (e && e.message) || String(e) }
      }
      if (out && out.ok) {
        this.added += 1
        this.lastAddedName = out.name || ''
        this.lastAddedAt = Date.now()
        this.lastError = ''
      } else if (out && out.message) {
        this.lastError = out.message
      }
      this._json(res, out && out.ok ? 200 : 400, out || { ok: false })
      return
    }

    /* 「把这一页交给 PanBox」：插件把浏览器此刻在这一页用的身份（Cookie / UA / 请求头）
     * 交过来，解析那些只认浏览器的分享页时就能直接复用。凭据只进内存，不落盘。 */
    if (p === '/page') {
      const body = await this._authedBody(req, res)
      if (!body) return
      let out
      try {
        out = this.onPage ? await this.onPage(body) : { ok: false, message: '这一版 PanBox 还不支持' }
      } catch (e) {
        out = { ok: false, message: (e && e.message) || String(e) }
      }
      if (!(out && out.ok) && out && out.message) this.lastError = out.message
      this._json(res, out && out.ok ? 200 : 400, out || { ok: false })
      return
    }

    this._json(res, 404, { ok: false, message: '未知路径 ' + p })
  }

  /**
   * `/add` 与 `/page` 共用的前四步：POST + JSON body + 配对令牌 + url 必须是 http(s)。
   * 以前两边是 22 行逐字复制，改一处漏一处就会出现「一个端点收紧了、另一个没有」。
   *
   * 不通过时已经回过响应了，调用方拿到 null 直接 return。
   *
   * @returns {Promise<object|null>}
   */
  async _authedBody(req, res) {
    if (req.method !== 'POST') {
      this._json(res, 405, { ok: false, message: '请用 POST' })
      return null
    }
    const raw = await this._readBody(req)
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      this._json(res, 400, { ok: false, message: 'body 不是合法 JSON' })
      return null
    }
    const sent = body.token || req.headers['x-panbox-token']
    if (!sent || !sameToken(sent, this.token)) {
      this.lastError = 'token 不匹配'
      this._json(res, 403, { ok: false, message: '配对令牌不对：请在 PanBox 的「设置 → 浏览器插件」里生成配对码，再到插件里配对一次' })
      return null
    }
    if (!body.url || !/^https?:\/\//i.test(String(body.url))) {
      this._json(res, 400, { ok: false, message: 'url 必须是 http(s) 地址' })
      return null
    }
    return body
  }
}

module.exports = new Bridge()
module.exports.ensureToken = ensureToken
