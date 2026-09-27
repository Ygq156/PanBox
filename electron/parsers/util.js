'use strict'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

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
    redirect = 'follow',
    timeout = 25000,
    cookie,
    jar,
  } = opts

  const h = { 'User-Agent': DEFAULT_UA, ...headers }
  const ck = jar ? jar.toString(cookie) : cookie
  if (ck) h['Cookie'] = ck

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(url, { method, headers: h, body, redirect, signal: ac.signal })
    if (jar) jar.absorb(res.headers)
    const text = await res.text()
    return {
      status: res.status,
      headers: res.headers,
      location: res.headers.get('location') || '',
      text,
      url: res.url,
    }
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `请求超时：${url}` : `${e && e.message ? e.message : e}`
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
  detectNetdisk,
  extractUrls,
  extractPassword,
  stripTags,
  decodeEntities,
  humanSizeToBytes,
  deepFind,
  sleep,
}
