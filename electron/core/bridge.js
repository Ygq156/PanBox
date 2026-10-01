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
 *   GET  /pair   -> { ok, token }   仅当请求来自 chrome-extension:// / moz-extension://
 *                                    或没有 Origin 头的本机工具，网页拿不到
 *   POST /add    -> 需要 token，body 是 JSON：
 *        { url, name?, referer?, cookie?, userAgent?, headers?, pageTitle?, title? }
 *                    -> { ok, kind, message, name, size }
 *   OPTIONS *    -> CORS 预检
 *
 * 为什么要有 token：CORS 拦不住「网页把请求发出去」这件事（只拦读响应），
 * 而任何网页都能朝 127.0.0.1 发请求。没有 token 的话，一个恶意页面就能往
 * 下载队列里塞任务。token 只发给带扩展 Origin 的请求，所以网页拿不到。
 */

const http = require('node:http')
const crypto = require('node:crypto')

const DEFAULT_PORT = 7799
const MAX_BODY = 512 * 1024

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

function isExtensionOrigin(origin) {
  return /^(chrome|moz|safari-web|ms-browser)-extension:\/\//i.test(String(origin || ''))
}

class Bridge {
  constructor() {
    this.server = null
    this.port = DEFAULT_PORT
    this.token = ''
    this.error = ''
    this.pairedAt = 0
    this.added = 0
    this.lastAddedName = ''
    this.lastAddedAt = 0
    this.lastError = ''
  }

  get running() {
    return !!this.server && this.server.listening
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
  async start(cfg, onAdd) {
    const port = Number((cfg && cfg.port) || DEFAULT_PORT)
    this.token = ensureToken(cfg && cfg.token)
    this.onAdd = onAdd
    if (this.running && this.port === port) return this.status()
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

    this.server = server
    if (!this.running) this.server = null
    return this.status()
  }

  async stop() {
    const s = this.server
    this.server = null
    if (!s) return true
    await new Promise((r) => s.close(() => r()))
    return true
  }

  _cors(res, origin) {
    /* 预检与读响应都可能来自扩展页面；扩展的 Origin 是 chrome-extension://<id>，
     * 这里不做白名单（token 才是门），但要允许浏览器把响应交给扩展脚本。 */
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-panbox-token')
    res.setHeader('Access-Control-Max-Age', '600')
    res.setHeader('Vary', 'Origin')
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
      if (!isExtensionOrigin(origin) && origin) {
        this._json(res, 403, { ok: false, message: '只给浏览器插件配对' })
        return
      }
      this.pairedAt = Date.now()
      this._json(res, 200, { ok: true, token: this.token, app: 'PanBox' })
      return
    }

    if (p === '/add') {
      if (req.method !== 'POST') {
        this._json(res, 405, { ok: false, message: '请用 POST' })
        return
      }
      const raw = await this._readBody(req)
      let body
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        this._json(res, 400, { ok: false, message: 'body 不是合法 JSON' })
        return
      }
      const sent = body.token || req.headers['x-panbox-token'] || u.searchParams.get('token')
      if (!sent || !sameToken(sent, this.token)) {
        this.lastError = 'token 不匹配'
        this._json(res, 403, { ok: false, message: '配对令牌不对：请在 PanBox 的「浏览器插件」里点「重新配对」' })
        return
      }
      if (!body.url || !/^https?:\/\//i.test(String(body.url))) {
        this._json(res, 400, { ok: false, message: 'url 必须是 http(s) 地址' })
        return
      }
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

    this._json(res, 404, { ok: false, message: '未知路径 ' + p })
  }
}

module.exports = new Bridge()
module.exports.DEFAULT_PORT = DEFAULT_PORT
module.exports.ensureToken = ensureToken
module.exports.isExtensionOrigin = isExtensionOrigin
