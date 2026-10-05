'use strict'
/* 自更新元数据的离线签名校验。
 *
 * 为什么必须有这一段：electron-updater 只按 latest.yml 里写的 sha512 校验安装包，而
 * latest.yml 和安装包走的是 GitHub 上同一条发布通道 —— 拿到发布权限（或能伪造 TLS）的人
 * 把两个文件一起换掉，sha512 照样对得上。所以客户端必须在**允许下载/安装之前**，
 * 用内置公钥（electron/core/update-pubkey.js）验一次 latest.yml 的签名：
 * 签过名的 latest.yml 才能决定「下哪个文件、sha512 是多少」，等于把安装包一起锁住。
 *
 * 约定：
 *   - 签名对象是 latest.yml 的**原始字节**，绝不能先解析成对象再验；
 *   - latest.yml.sig 是 Ed25519 签名的 base64 单行；
 *   - 缺 .sig 或验不过 → 一律拒更（宁可不更新，也不能装来源不明的东西）。
 *     ⚠️ 1.0.21 及更早的 release 没有 .sig，老客户端也没有这段校验，所以双方都不受影响。
 */
const crypto = require('node:crypto')
const https = require('node:https')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { PUBLIC_KEY_B64 } = require('./update-pubkey')

const YML_NAME = 'latest.yml'
const SIG_NAME = 'latest.yml.sig'
/* Ed25519 公钥的 SPKI 头（12 字节）：内置的是 raw 32 字节，拼上它才是 Node 认的 DER */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
/* latest.yml 只有几百字节；给足余量但不能无限收，免得被喂垃圾 */
const MAX_BYTES = 256 * 1024
const MAX_REDIRECTS = 5
const UA = 'PanBox-updater'

const DEFAULT_BASE = 'https://github.com/Ygq156/PanBox/releases/download/'

function builtinPublicKey() {
  const raw = Buffer.from(PUBLIC_KEY_B64, 'base64')
  if (raw.length !== 32) throw new Error('内置公钥不是 32 字节的 Ed25519 raw key')
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' })
}

/**
 * 用内置公钥验一段字节。
 * @param {Buffer} raw latest.yml 的原始字节
 * @param {string} sigText latest.yml.sig 的内容（base64，允许带换行）
 * @returns {{ok:boolean, reason?:'empty'|'mismatch'}}
 */
function verifyBytes(raw, sigText) {
  const sig = Buffer.from(String(sigText || '').trim(), 'base64')
  /* Ed25519 签名固定 64 字节；长度不对直接判死，别让 Buffer.from 的宽松解析蒙混过关 */
  if (sig.length !== 64) return { ok: false, reason: 'empty' }
  return crypto.verify(null, raw, builtinPublicKey(), sig) ? { ok: true } : { ok: false, reason: 'mismatch' }
}

/* 只对**本机回环**的 http 地址放行。真实更新通道（GitHub release）全是 https；
 * 放行回环是为了让本地回归能自建一个 feed（见 test/verify-update-inplace.js）。
 * 它不削弱这道门禁：回环流量出不了这台机器，而喂进来的 latest.yml 仍然必须带
 * 内置公钥能验过的签名 —— 能改本机回环应答的人本来就能直接改本机文件。 */
function isLoopbackHttp(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:') return false
    const h = u.hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
  } catch (e) {
    return false
  }
}

/* GET 一个 URL 的原始字节。github.com 的发布资产会 302 到 objects.githubusercontent.com，
 * 所以要自己跟着重定向走（main.js 里查 release 接口那处用不到，这里是必须的）。 */
function getBytes(url, timeout, redirects) {
  const mod = isLoopbackHttp(url) ? http : https
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method: 'GET', headers: { 'User-Agent': UA, Accept: '*/*' }, timeout },
      (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume()
          if (redirects <= 0) {
            reject(new Error('重定向次数过多'))
            return
          }
          resolve(getBytes(new URL(res.headers.location, url).href, timeout, redirects - 1))
          return
        }
        if (code !== 200) {
          res.resume()
          const e = new Error('HTTP ' + code)
          e.statusCode = code
          reject(e)
          return
        }
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > MAX_BYTES) {
            req.destroy(new Error('元数据文件过大'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve(Buffer.concat(chunks)))
      },
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.end()
  })
}

/* 读打包时生成的 app-update.yml（就在 resources 目录里，和 app.asar 同级）。
 * 只认我们需要的几个扁平键，不引 YAML 依赖；读不到就返回 {}。
 *
 * 为什么非要读它：electron-updater 给的 updateInfo.path / files[0].url 是**相对文件名**
 * （比如 PanBox-Setup-1.0.22.exe），拿它拼不出元数据目录；而「谁提供更新」这件事只有
 * 这份配置知道 —— 按 provider 猜（比如一律拼 GitHub 的 releases/download/v<版本>/）
 * 会在自定义 feed / generic 服务器上验错文件：验的是 GitHub 上那份，下的却是本地
 * feed 那份。这道门禁的意义就是「验的就是要装的那份」，所以必须按实际 provider 定位。 */
function readAppUpdateYml() {
  const cands = []
  try {
    if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'app-update.yml'))
  } catch (e) {
    /* 没有就算了 */
  }
  try {
    const { app } = require('electron')
    if (app && app.getAppPath) cands.push(path.join(path.dirname(app.getAppPath()), 'app-update.yml'))
  } catch (e) {
    /* 非 Electron 环境（纯 Node 回归）就跳过 */
  }
  for (const p of cands) {
    try {
      const txt = fs.readFileSync(p, 'utf8')
      const out = {}
      for (const line of txt.split(/\r?\n/)) {
        const m = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
        if (!m) continue
        let v = m[2].trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        out[m[1]] = v
      }
      if (Object.keys(out).length) return out
    } catch (e) {
      /* 试下一个候选 */
    }
  }
  return {}
}

/* 元数据（latest.yml / latest.yml.sig）所在目录。
 * 顺序：installerUrl 是绝对地址就用它的目录 → app-update.yml 里的 url（generic/自定义
 * feed 就是「latest.yml 所在目录」）→ app-update.yml 里的 owner/repo 拼 GitHub release
 * 目录 → 最后退回硬编码的本仓库 GitHub 地址（开发期、配置缺失时用）。 */
function channelBase(target) {
  const installer = String((target && target.installerUrl) || '')
  if (installer && /^[a-z][a-z0-9+.-]*:\/\//i.test(installer)) {
    try {
      const u = new URL(installer)
      u.pathname = u.pathname.replace(/\/[^/]*$/, '/')
      u.search = ''
      u.hash = ''
      return u.href
    } catch (e) {
      /* 地址不合法就往下走 */
    }
  }
  const ver = String((target && target.version) || '')
  const cfg = readAppUpdateYml()
  const url = String(cfg.url || '')
  if (url) return url.replace(/\/+$/, '') + '/'
  if (cfg.owner && cfg.repo && ver) {
    return 'https://github.com/' + cfg.owner + '/' + cfg.repo + '/releases/download/' + encodeURIComponent('v' + ver) + '/'
  }
  const tag = String((target && target.tag) || '') || (ver ? 'v' + ver : '')
  return tag ? DEFAULT_BASE + encodeURIComponent(tag) + '/' : ''
}

/* 签名已验过，这里只是把 version 抠出来做个一致性核对（解析结果不参与验签） */
function metaVersion(raw) {
  const m = /^version:\s*['"]?([0-9A-Za-z.+_-]+)['"]?\s*$/m.exec(raw.toString('utf8'))
  return m ? m[1] : ''
}

/**
 * 验一次自更新的元数据签名。
 * @param {{installerUrl?:string, tag?:string, version?:string, timeout?:number}} target
 *   installerUrl = electron-updater 给出的安装包地址（updateInfo.path / files[0].url）——
 *   多数 provider 给的是**相对文件名**，那种情况按 app-update.yml 里实际的 provider 定位
 * @returns {Promise<{ok:boolean, version?:string, message?:string, err?:Error}>}
 *   ok=false 时二选一：message 是可以直接给用户看的中文；err 是网络原始错误，
 *   交给 main.js 的 readableNetError 挑一句（保持和现有网络错误的文案一致）。
 */
async function checkUpdateSignature(target) {
  const t = (target && target.timeout) || 10000
  const base = channelBase(target)
  if (!base) return { ok: false, message: '拿不到新版的下载地址，这次不更新，请到项目下载页手动下载。' }

  let yml
  try {
    yml = await getBytes(base + YML_NAME, t, MAX_REDIRECTS)
  } catch (e) {
    if (e && e.statusCode === 404) return { ok: false, message: '更新服务器上还没有可用的新版文件。' }
    return { ok: false, err: e }
  }

  let sigText
  try {
    sigText = (await getBytes(base + SIG_NAME, t, MAX_REDIRECTS)).toString('utf8')
  } catch (e) {
    if (e && e.statusCode === 404) {
      return { ok: false, message: '这次的新版没有签名文件，无法确认来源，已拒绝更新，请到项目下载页手动下载。' }
    }
    return { ok: false, err: e }
  }

  const v = verifyBytes(yml, sigText)
  if (!v.ok) {
    return {
      ok: false,
      message: v.reason === 'empty'
        ? '新版签名文件读不出来，已拒绝更新，请到项目下载页手动下载。'
        : '新版签名校验没过，已拒绝更新，请到项目下载页手动下载。',
    }
  }

  const want = String((target && target.version) || '')
  const got = metaVersion(yml)
  if (want && got && want !== got) {
    return { ok: false, message: '更新信息和要装的版本对不上，已拒绝更新，请到项目下载页手动下载。' }
  }
  return { ok: true, version: got || want }
}

module.exports = { checkUpdateSignature, verifyBytes, YML_NAME, SIG_NAME }
