'use strict'

/**
 * 落盘凭证的加密壳。
 *
 * 起因：`settings.json` 里的网盘 cookie（百度 BDUSS、夸克 `__puus`、迅雷 access_token…）
 * 和 `tasks.json` 里「换直链」要用的请求头，以前是明文 JSON。同机任何一个能读这个文件的
 * 东西（别的用户程序、同步盘、备份工具、被随手打包进崩溃报告的文件）都等于拿到了账号。
 * 现在一律过 Electron 的 safeStorage：Windows 上它落到 DPAPI，密钥绑当前用户账户，
 * 把文件拷到别的机器或别的用户目录下都解不开。
 *
 * 两条硬约束，都是实测结论：
 *
 * 1. `app.whenReady()` **之前** `safeStorage.isEncryptionAvailable()` 是 false，
 *    `encryptString()` 也会抛。所以加密不能只靠「写的时候顺手做」——ready 之前写的那次
 *    只能是明文，要在 ready 之后由 `settings.reseal()` / `taskManager.reloadMeta()`
 *    补做一遍（见 main.js 的 whenReady）。
 *
 * 2. **解不开的时候绝不回写空值**。密文原样留在内存里（这一轮跑起来用不了是事实，
 *    但下一次启动的 save() 不会把它抹掉），用户重新登录会自然覆盖它。宁可凭证"暂时不可用"，
 *    也不能因为一次读不出来就把用户的登录态删掉。
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, safeStorage } = require('electron')

/** 单值密文前缀（settings.json 的 cookies 逐值加密用这个） */
const PREFIX = 'enc1:'

/** 整份文件加密的外壳键（tasks.json 这类整表加密用这个） */
const ENVELOPE_KEY = '__panboxEnc'
const ENVELOPE_VER = 1

/** 现在能不能做加密/解密。ready 之前一定是 false。 */
function available() {
  try {
    if (!app || typeof app.isReady !== 'function' || !app.isReady()) return false
    return !!(safeStorage && safeStorage.isEncryptionAvailable())
  } catch {
    return false
  }
}

/**
 * 密钥是不是真的落在盘上（= 下一个进程也解得开）。
 *
 * 这是「敢不敢写密文」的唯一判据，必须比 `available()` 严：临时 profile 里实测
 * `encryptString` 能用、同进程往返也对，但 `Local State` **自始至终没被创建** ——
 * 说明密钥只在进程内，写下去的密文下一个进程必然报
 * `Error while decrypting the ciphertext provided to safeStorage.decryptString.`。
 * 写坏数据的代价是用户的登录态整份丢掉，远大于「这一轮继续用明文」，所以拿不准就退回明文。
 *
 * 真实 profile 里 `Local State` 有 `os_crypt.encrypted_key`（DPAPI 包着的密钥）⇒ 判为可靠。
 */
function keyDurable() {
  if (!available()) return false
  /* 非 Windows 的钥匙串由系统托管（kwallet / libsecret），没有 Local State 这个概念 */
  if (process.platform !== 'win32') return true
  try {
    const p = path.join(app.getPath('userData'), 'Local State')
    if (!fs.existsSync(p)) return false
    return /"encrypted_key"\s*:\s*"[^"]{16,}"/.test(fs.readFileSync(p, 'utf8'))
  } catch {
    return false
  }
}

/** 这个字符串是不是我们写出去的密文 */
function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX)
}

/**
 * 加密单个值。加不了（not ready / 抛错）就原样返回明文 ——
 * 落盘的安全等级降一格，但绝不把用户的凭证弄丢。
 */
function encryptText(v) {
  const s = v === undefined || v === null ? '' : String(v)
  if (!s) return ''
  if (isEncrypted(s)) return s /* 已经是密文（比如这一轮解不开、原样留着的），别再套一层 */
  if (!keyDurable()) return s
  try {
    const enc = PREFIX + safeStorage.encryptString(s).toString('base64')
    /* 再当场解回来验一遍（防的是「密钥变了 / 密文被截断」这类意外）。 */
    if (safeStorage.decryptString(Buffer.from(enc.slice(PREFIX.length), 'base64')) !== s) return s
    return enc
  } catch {
    return s
  }
}

/**
 * 解密单个值。
 * @returns {string|null} 明文；`null` = 有密文但现在解不开（调用方必须原样保留密文）
 */
function decryptText(v) {
  const s = v === undefined || v === null ? '' : String(v)
  if (!s) return ''
  if (!isEncrypted(s)) return s /* 老版本的明文配置 */
  if (!available()) return null
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(PREFIX.length), 'base64'))
  } catch {
    return null
  }
}

/** cookies 表：逐值解密（解不开的原样保留密文） */
function decryptCookies(cookies) {
  const out = {}
  for (const [k, v] of Object.entries(cookies || {})) {
    const s = v === undefined || v === null ? '' : String(v)
    if (!s) {
      out[k] = ''
      continue
    }
    const plain = decryptText(s)
    out[k] = plain === null ? s : plain
  }
  return out
}

/** cookies 表：逐值加密（写盘用） */
function encryptCookies(cookies) {
  const out = {}
  for (const [k, v] of Object.entries(cookies || {})) out[k] = encryptText(v)
  return out
}

/** 这张表里还有没有明文值（= 需要 reseal 一次把它加密掉） */
function hasPlaintext(cookies) {
  for (const v of Object.values(cookies || {})) {
    const s = v === undefined || v === null ? '' : String(v)
    if (s && !isEncrypted(s)) return true
  }
  return false
}

/** 写盘前把整份配置加工好（cookies 加密，其余字段原样） */
function sealConfig(cfg) {
  return { ...cfg, cookies: encryptCookies(cfg.cookies) }
}

/**
 * 整份对象加密（tasks.json 用）。
 * 加不了就返回原对象明文 —— 与加密前行为一致，不会更糟。
 */
function sealObject(obj) {
  if (!keyDurable()) return obj
  try {
    const text = JSON.stringify(obj)
    const env = { [ENVELOPE_KEY]: ENVELOPE_VER, data: safeStorage.encryptString(text).toString('base64') }
    /* 同 encryptText：落盘前当场验一次，解不回来就退回明文，免得下一次启动读不出任务元信息 */
    if (safeStorage.decryptString(Buffer.from(env.data, 'base64')) !== text) return obj
    return env
  } catch {
    return obj
  }
}

/**
 * 打开整份对象。
 * @returns {{ok:true, value:object, legacy?:boolean}|{ok:false, reason:string}}
 *   `ok:false` 表示磁盘上是密文但现在解不开 —— 调用方**不要**用空表覆盖它。
 */
function openObject(parsed) {
  const v = parsed
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: true, value: {}, legacy: true }
  if (v[ENVELOPE_KEY] !== ENVELOPE_VER) return { ok: true, value: v, legacy: true }
  if (typeof v.data !== 'string' || !v.data) return { ok: false, reason: 'bad-envelope' }
  if (!available()) return { ok: false, reason: 'not-ready' }
  try {
    const out = JSON.parse(safeStorage.decryptString(Buffer.from(v.data, 'base64')))
    if (!out || typeof out !== 'object' || Array.isArray(out)) return { ok: false, reason: 'bad-payload' }
    return { ok: true, value: out }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'decrypt-failed' }
  }
}

module.exports = {
  PREFIX,
  ENVELOPE_KEY,
  available,
  keyDurable,
  isEncrypted,
  encryptText,
  decryptText,
  decryptCookies,
  encryptCookies,
  hasPlaintext,
  sealConfig,
  sealObject,
  openObject,
}
