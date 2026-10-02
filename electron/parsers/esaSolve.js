'use strict'

/**
 * ESA 挑战页的「真做法」：挑战页里那段脚本自己会算出 `acw_sc__v2` 并写进
 * `document.cookie`，再 reload 同一个地址。这里把那一段脚本放进一个沙箱里执行，
 * 直接取它写出的值 —— 站点改算法时不用跟着改。
 *
 * 沙箱只提供脚本需要的浏览器对象（document.cookie / location / navigator /
 * setTimeout / atob 等），不碰文件、网络与进程；执行超时即放弃。
 */

const vm = require('vm')

/* 延迟取，避免与 esa.js 形成加载环 */
function esaMod() {
  return require('./esa')
}

const SCRIPT_TIMEOUT = 3000
const MAX_SCRIPT = 200 * 1024

/** 从 HTML 里取出所有 <script> 段（去掉 src 外链） */
function scriptsOf(html) {
  const out = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(String(html || '')))) {
    const attrs = m[1] || ''
    const code = m[2] || ''
    if (/\bsrc\s*=/i.test(attrs)) continue
    if (!code.trim()) continue
    if (code.length > MAX_SCRIPT) continue
    out.push(code)
  }
  return out
}

/** 在沙箱里跑一段挑战脚本，返回它写下的 cookie 名值对 */
function runScript(code, pageUrl) {
  const writes = []
  let reloads = 0
  let base
  try {
    base = new URL(String(pageUrl))
  } catch {
    base = { protocol: 'https:', host: '', hostname: '', pathname: '/', search: '' }
  }
  const location = {
    href: String(pageUrl),
    protocol: base.protocol,
    host: base.host,
    hostname: base.hostname,
    port: base.port || '',
    pathname: base.pathname,
    search: base.search,
    hash: '',
    reload() {
      reloads++
    },
    replace() {
      reloads++
    },
    assign() {
      reloads++
    },
  }
  const document = {
    get cookie() {
      return writes.join('; ')
    },
    set cookie(v) {
      const kv = String(v).split(';')[0].trim()
      if (kv.includes('=')) writes.push(kv)
    },
    location,
    referrer: '',
    readyState: 'loading',
    cookieEnabled: true,
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return { style: {}, setAttribute() {}, appendChild() {}, getContext: () => null }
    },
    getElementById: () => null,
    getElementsByTagName: () => [],
    querySelector: () => null,
    write() {},
    writeln() {},
  }
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
  const sandbox = {
    document,
    location,
    navigator: { userAgent: ua, appVersion: ua, platform: 'Win32', language: 'zh-CN', cookieEnabled: true },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    innerWidth: 1920,
    innerHeight: 1080,
    top: null,
    parent: null,
    setTimeout: (fn) => {
      if (typeof fn === 'function') {
        try {
          fn()
        } catch {
          /* 挑战脚本里被 setTimeout 包住的分支出错不影响已写下的 cookie */
        }
      }
      return 1
    },
    setInterval: () => 1,
    clearTimeout() {},
    clearInterval() {},
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    Date,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    TypeError,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    escape,
    unescape,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  sandbox.top = sandbox
  sandbox.parent = sandbox
  let err = null
  try {
    vm.runInNewContext(code, sandbox, { timeout: SCRIPT_TIMEOUT, filename: 'esa-challenge.js' })
  } catch (e) {
    err = e && e.message ? e.message : String(e)
  }
  const found = writes.map((c) => c.split('=')).find(([k]) => k === 'acw_sc__v2')
  return { cookie: found ? String(found[1]).trim() : '', err, reloads, writes }
}

/**
 * 解一次挑战页，返回 { arg1, cookie, from }。
 * cookie 优先用沙箱跑出来的值，跑不出来就退回 esa 的本地算法。
 * from: 'vm' | 'calc' | ''
 */
function solveChallenge(html, pageUrl) {
  const { acwScV2, extractArg1 } = esaMod()
  const arg1 = extractArg1(html)
  const codes = scriptsOf(html)
  const looksLikeChallenge = arg1 || /acw_sc__v2/.test(String(html || ''))
  if (looksLikeChallenge) {
    for (const code of codes) {
      if (!/acw_sc__v2|arg1/.test(code)) continue
      const r = runScript(code, pageUrl)
      if (r.cookie) return { arg1, cookie: r.cookie, from: 'vm' }
    }
  }
  if (arg1) {
    const cookie = acwScV2(arg1)
    if (cookie) return { arg1, cookie, from: 'calc' }
  }
  return { arg1, cookie: '', from: '' }
}

module.exports = { solveChallenge, runScript, scriptsOf, SCRIPT_TIMEOUT }