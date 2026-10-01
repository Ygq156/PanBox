'use strict'

const dns = require('node:dns').promises

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/* ------------------------------------------------------------------ */
/* 出站请求护栏                                                        */
/* ------------------------------------------------------------------ */

/** 解析（或重定向到）本机/局域网地址的拦截。 */
const MAX_RESP_SIZE = Number(process.env.PANBOX_MAX_RESP || 8 * 1024 * 1024) || 8 * 1024 * 1024

/** 日志/错误里出现的 URL 去掉 query —— 分享链接的 ?pwd= 与直链签名都在 query 里 */
function safeUrl(u) {
  try {
    const x = new URL(String(u))
    return `${x.protocol}//${x.host}${x.pathname}`
  } catch {
    return '(非法地址)'
  }
}

/** 这个 host 是不是「本机或局域网」的字面量地址 */
function isPrivateHost(host) {
  const h = String(host || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
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

/** 带上限的响应体读取：被控/被黑的服务器塞一个超大响应不能把主进程读爆 */
async function readTextCapped(res, limit) {
  const buf = Buffer.from(await readAll(res.body, limit))
  return buf.toString('utf8')
}

/** 把 Web ReadableStream 读成 Buffer，超过 limit 直接抛错（不静默截断） */
async function readAll(readable, limit) {
  const chunks = []
  let n = 0
  if (!readable) return Buffer.alloc(0)
  for await (const chunk of readable) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    n += b.length
    if (n > limit) throw new Error(`响应体过大（超过 ${Math.round(limit / 1024 / 1024)}MB），已中止`)
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
      res = await fetch(current, { method, headers: h, body, redirect: 'manual', signal: ac.signal })
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
    const text = await readTextCapped(res, MAX_RESP_SIZE)
    return {
      status: res.status,
      headers: res.headers,
      location: res.headers.get('location') || '',
      text,
      url: res.url || current,
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

const LANZOU_HOSTS = [
  'lanzou', 'lanzo', 'lanzn', 'lanzv', 'lanosso', 'lanpv', 'lanwp', 'bakstotre',
  'ulanzou', 'woozooo', 'dmpdmp', 'lanrar', 'webgetstore', 'lanzoui', 'lanzoux',
  'lanzouw', 'lanzoue', 'lanzoup', 'lanzoub', 'lanzouc', 'lanzouf', 'lanzoug',
  'lanzouh', 'lanzouj', 'lanzouk', 'lanzoul', 'lanzoum', 'lanzoun', 'lanzouo',
  'lanzouq', 'lanzour', 'lanzous', 'lanzout', 'lanzouu', 'lanzouv', 'lanzouy',
  'lanzouz', 't-is.cn',
]

const MATCHERS = [
  { netdisk: 'baidu', re: /(pan\.baidu\.com|yun\.baidu\.com|eyun\.baidu\.com)/i },
  { netdisk: 'xunlei', re: /(pan\.xunlei\.com|pan-thunder\.com|(^|\/\/)xunlei\.com\/s\/)/i },
  { netdisk: 'ilanzou', re: /(www\.)?ilanzou\.com/i },
  { netdisk: 'quark', re: /(pan\.quark\.cn|drive-pc\.quark\.cn|quark\.cn)/i },
  { netdisk: 'uc', re: /((fast|drive|pc-api)\.uc\.cn|\buc\.cn\/s\/)/i },
  { netdisk: 'aliyun', re: /(aliyundrive\.com|alipan\.com)/i },
  /* 下面是「认得出域名、但没有实现解析器」的网盘。它们出现在 MATCHERS 里**只为**让
   * pickParser 命中 index.js 的 KNOWN_UNSUPPORTED 分支，回一句「暂不支持××」；
   * 不列的话会掉进「兜底当直链」分支，拿分享页 URL 去 HEAD，给用户一个莫名其妙的结果。 */
  { netdisk: 'tianyi', re: /(cloud\.189\.cn|189\.cn\/t\/)/i },
  { netdisk: 'yidong', re: /(caiyun\.139\.com|139\.com\/m\/i)/i },
  { netdisk: 'pan115', re: /(115\.com|115cdn\.com|anxia\.com)/i },
  { netdisk: 'weiyun', re: /(share\.weiyun\.com|weiyun\.com)/i },
  { netdisk: '123pan', re: /(123pan\.com|123pan\.cn|123panpay\.com|123684\.com|123865\.com|123912\.com|123592\.com)/i },
]

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

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '').trim()
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

/** 带 Referer 的简单 JSON 头（夸克/UC/123 用） */
function apiHeaders({ ua = UA_PC_CHROME, referer, extra = {} } = {}) {
  const h = { Accept: 'application/json, text/plain, */*', 'User-Agent': ua, ...extra }
  if (referer) {
    h.Referer = referer
    h.Origin = new URL(referer).origin
  }
  return h
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
  apiHeaders,
  form,
  Jar,
  req,
  reqJson,
  assertOutbound,
  isPrivateHost,
  safeUrl,
  detectNetdisk,
  extractUrls,
  extractPassword,
  stripTags,
  decodeEntities,
  humanSizeToBytes,
  deepFind,
  sleep,
}
