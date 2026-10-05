'use strict'
/* 给 release\<版本>\latest.yml 出离线签名（同目录写 latest.yml.sig，base64 单行）。
 *
 * 为什么要它：PanBox 的自更新走 electron-updater，只比对 latest.yml 里的 sha512，
 * 而 latest.yml 和安装包都在 GitHub 的同一条通道上 —— 谁拿到发布权限（或能伪造 TLS）
 * 就能换成任意安装包。所以元数据必须由**只在发版机上、仓库外面**的私钥签一次，
 * 客户端内置公钥验不过就拒更（见 electron/core/updateSig.js）。
 *
 * 用法：
 *   node tools\sign-update.js                      当前 package.json 版本 → release\<版本>\latest.yml
 *   node tools\sign-update.js <文件或目录>           指定 latest.yml（给 release\<版本> 目录也行）
 *   node tools\sign-update.js --verify [文件或目录]  用内置公钥验签（成功/失败都有明确输出与退出码）
 *   node tools\sign-update.js --key <私钥路径>       指定私钥
 * 环境变量 PANBOX_UPDATE_KEY = 私钥路径（优先级最高）。
 * 退出码：0 成功；1 失败；2 用法不对。
 *
 * 私钥默认位置（都是仓库外面，绝不入库）：
 *   1. <仓库同级的 panbox-secrets>\update-signing.key
 *   2. %USERPROFILE%\.panbox-secrets\update-signing.key
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { PUBLIC_KEY_B64 } = require('../electron/core/update-pubkey')

const ROOT = path.join(__dirname, '..')
const SIG_NAME = 'latest.yml.sig'
const YML_NAME = 'latest.yml'
/* Ed25519 公钥的 SPKI 头（12 字节）：内置的是 raw 32 字节，拼上它才是 Node 认的 DER */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function fail(msg, code) {
  console.log(msg)
  process.exit(code || 1)
}

function builtinPublicKey() {
  const raw = Buffer.from(PUBLIC_KEY_B64, 'base64')
  if (raw.length !== 32) fail('内置公钥不是 32 字节的 Ed25519 raw key，仓库里的 electron\\core\\update-pubkey.js 有问题。')
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' })
}

function fingerprint() {
  const raw = Buffer.from(PUBLIC_KEY_B64, 'base64')
  return 'SHA256:' + crypto.createHash('sha256').update(raw).digest('base64')
}

/* 用内置公钥验一段**原始字节**（签名是对字节签的，不能先解析成对象再验） */
function verifyWithBuiltin(buf, sigText) {
  const sig = Buffer.from(String(sigText || '').trim(), 'base64')
  if (sig.length !== 64) return false
  return crypto.verify(null, buf, builtinPublicKey(), sig)
}

function keyCandidates() {
  const list = []
  if (process.env.PANBOX_UPDATE_KEY) list.push(process.env.PANBOX_UPDATE_KEY)
  list.push(path.join(path.dirname(ROOT), 'panbox-secrets', 'update-signing.key'))
  list.push(path.join(os.homedir(), '.panbox-secrets', 'update-signing.key'))
  return list
}

function loadPrivateKey(explicit) {
  const list = explicit ? [explicit] : keyCandidates()
  for (const p of list) {
    if (!p || !fs.existsSync(p)) continue
    try {
      return { key: crypto.createPrivateKey(fs.readFileSync(p, 'utf8')), file: p }
    } catch (e) {
      fail('私钥读不出来（' + p + '）：' + ((e && e.message) || e))
    }
  }
  fail('没找到更新签名私钥，试过：\n  ' + list.join('\n  ') +
    '\n私钥只在发版机上，且必须放在仓库外面。先在发版机上生成一对（仓库里的 README/报告里有做法），或用 --key 指定路径。')
}

/* 参数：位置参数只认一个（要签/要验的 latest.yml），flag 见文件头 */
const argv = process.argv.slice(2)
let verify = false
let explicitKey = null
let target = null
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--verify') verify = true
  else if (a === '--key') { explicitKey = argv[++i] || null; if (!explicitKey) fail('--key 后面要跟私钥路径', 2) }
  else if (a === '-h' || a === '--help') { console.log('用法见 tools\\sign-update.js 文件头注释。'); process.exit(0) }
  else if (a.startsWith('--')) fail('不认识的参数：' + a, 2)
  else if (target) fail('只认一个路径参数，多了：' + a, 2)
  else target = a
}

/* 默认路径：不写死盘符，从脚本自己的位置推 release\<package.json 里的版本>\latest.yml */
function defaultYml() {
  let ver = ''
  try {
    ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''
  } catch (e) {
    fail('读不出 package.json 里的版本号：' + ((e && e.message) || e))
  }
  if (!ver) fail('package.json 里没有 version。')
  return path.join(ROOT, 'release', ver, YML_NAME)
}

const yml = target
  ? (fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, YML_NAME) : target)
  : defaultYml()
if (!fs.existsSync(yml)) fail('找不到 ' + yml + '（还没出包？或者路径写错了）')
if (!fs.statSync(yml).isFile()) fail(yml + ' 不是文件。')
const sigPath = path.join(path.dirname(yml), SIG_NAME)
const raw = fs.readFileSync(yml)

if (verify) {
  if (!fs.existsSync(sigPath)) fail('验签失败：缺少 ' + sigPath + '（这一版还没签过名）。')
  const sigText = fs.readFileSync(sigPath, 'utf8')
  const ok = verifyWithBuiltin(raw, sigText)
  console.log('验签对象：' + yml + '（' + raw.length + ' 字节）')
  console.log('签名文件：' + sigPath + '（' + sigText.trim().length + ' 个 base64 字符）')
  console.log('内置公钥指纹：' + fingerprint())
  if (!ok) fail('验签失败：签名和这个 latest.yml 对不上，或不是这把内置公钥签的。')
  console.log('验签通过：latest.yml 与内置公钥匹配。')
  process.exit(0)
}

const { key, file } = loadPrivateKey(explicitKey)
const sig = crypto.sign(null, raw, key)
const sigText = sig.toString('base64')
/* 先用内置公钥自验一次：私钥换了却忘了换内置公钥的话，这一版发上去会让所有新客户端拒更，
 * 与其等用户报「更新不了」，不如在这里当场拦下来。 */
if (!verifyWithBuiltin(raw, sigText)) {
  fail('私钥（' + file + '）与仓库里内置的公钥不配对（指纹 ' + fingerprint() +
    '），签名没写出去。要么换对私钥，要么把新公钥更新进 electron\\core\\update-pubkey.js。')
}
fs.writeFileSync(sigPath, sigText + '\n')
console.log('已签名：' + yml + '（' + raw.length + ' 字节）')
console.log('写出：' + sigPath + '（' + sigText.length + ' 个 base64 字符）')
console.log('私钥：' + file)
console.log('内置公钥指纹：' + fingerprint())
console.log('提示：发版时 latest.yml.sig 必须和 latest.yml、安装包一起传上 GitHub release，缺了客户端会拒更。')
