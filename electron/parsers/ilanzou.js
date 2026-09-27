'use strict'

/**
 * 蓝奏云优享版（www.ilanzou.com/s/xxxx，旧名「飞机盘」）。
 *
 * 规格来源：qaiu/netdisk-fast-download (MIT) 的 `IzTool.java` + `AESUtils.java`。
 *
 * 两个极易踩的点：
 *   1. **必须先用同一个 uuid 打一次会员接口**（`unproved//buy/vip/list`，注意双斜杠），
 *      否则后续 `recommend/list` 拿不到数据——这是 2024-05-12 的规则变更。
 *   2. 时间戳与文件 id 都要 AES 加密：key = ASCII `lanZouY-disk-app`，
 *      AES-128-ECB/PKCS5Padding → **小写 hex**。
 *      `downloadId = AES(fileIds|userId)`、`auth = AES(fileIds|nowMs)`、`timestamp = AES(nowMs)`
 */

const crypto = require('node:crypto')
const { req, Jar, UA_PC_CHROME, decodeEntities, humanSizeToBytes } = require('./util')
const { acwScV2, extractArg1 } = require('./esa')

const AES_KEY = 'lanZouY-disk-app'
const API = 'https://api.ilanzou.com/unproved/'
const SHARE_RE = /^https?:\/\/(?:www\.)?ilanzou\.com\/s\/([A-Za-z0-9]+)/i

function aesHex(plain) {
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(AES_KEY, 'utf8'), null)
  return Buffer.concat([c.update(String(plain), 'utf8'), c.final()]).toString('hex')
}

function izHeaders() {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    DNT: '1',
    Origin: 'https://www.ilanzou.com/',
    Referer: 'https://www.ilanzou.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'User-Agent': UA_PC_CHROME,
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  }
}

/** POST 一次；若撞上 ESA 挑战，把 acw_sc__v2 写进 jar 后重放 */
async function post(jar, url) {
  let r = await req(url, { method: 'POST', headers: izHeaders(), jar, timeout: 25000 })
  if (r.text.includes("var arg1='")) {
    const a = extractArg1(r.text)
    if (a) {
      jar.set('acw_sc__v2', acwScV2(a))
      r = await req(url, { method: 'POST', headers: izHeaders(), jar, timeout: 25000 })
    }
  }
  return r
}

function parseJson(r, what) {
  try {
    return JSON.parse(r.text)
  } catch {
    throw new Error(`蓝奏优享 ${what} 返回非 JSON：${String(r.text).slice(0, 100)}`)
  }
}

function entryOf(it) {
  return {
    raw: it,
    id: String(it.fileId ?? it.id ?? it.folderId ?? ''),
    name: decodeEntities(String(it.fileName || it.name || it.fileNameAll || '未命名')),
    // 实测：蓝奏优享的 fileSize 单位是 **KB**（15 → 下载得到 15360 字节）
    size: Number(it.fileSize || it.size || 0) * 1024,
    isDir: Number(it.fileType) === 2,
    // 注意：`fileIds` / `userId` 只在 **分享层**（list[0]）上，fileList 的每一项只有 `fileId`。
    fileId: String(it.fileId ?? ''),
  }
}

async function open(url, ctx = {}) {
  const m = SHARE_RE.exec(String(url || '').trim())
  if (!m) throw new Error('不是有效的蓝奏优享分享链接')
  const shareId = m[1]
  const pwd = String(ctx.password || '').trim()
  const jar = new Jar(ctx.cookie)
  const uuid = crypto.randomUUID().toLowerCase()

  // ① 固定 UUID 先打会员接口（规则要求，响应忽略）
  const ts1 = aesHex(Date.now())
  await post(jar, `${API}/buy/vip/list?devType=6&devModel=Chrome&uuid=${uuid}&extra=2&timestamp=${ts1}`).catch(
    () => null,
  )

  // ② 分享列表
  const base =
    `${API}recommend/list?devType=6&devModel=Chrome&uuid=${uuid}&extra=2&timestamp=${ts1}` +
    `&shareId=${encodeURIComponent(shareId)}&type=0&offset=1&limit=60`
  const listUrl = pwd ? `${base}&code=${encodeURIComponent(pwd)}` : base

  const json = parseJson(await post(jar, listUrl), '分享列表')
  if (Number(json.code) !== 200) {
    const e = new Error(json.msg || json.message || `蓝奏优享返回 code=${json.code}`)
    if (/密码|提取码|code/i.test(String(json.msg || '')) && !pwd) e.needPassword = true
    throw e
  }

  const first = (json.list || [])[0]
  if (!first) throw new Error('蓝奏优享分享列表为空（分享可能已失效）')

  // 分享层字段：`fileIds` / `userId` 只在这一层有；fileList 里的每一项只有 fileId
  const shareFileIds = String(first.fileIds ?? '')
  const shareUserId = String(first.userId ?? '')

  let entries = (first.fileList || []).map(entryOf)
  const title = decodeEntities(String((first.fileList || [])[0]?.fileName || first.shareName || shareId))

  // 目录分享：再拉一层 /share/list
  if (entries.length === 1 && entries[0].isDir) {
    const folderId = entries[0].fileId || entries[0].raw.folderId
    const tsF = aesHex(Date.now())
    const dirUrl =
      `${API}/share/list?devType=6&devModel=Chrome&uuid=${uuid}&extra=2&timestamp=${tsF}` +
      `&shareId=${encodeURIComponent(shareId)}&folderId=${encodeURIComponent(String(folderId))}&offset=1&limit=60`
    const dj = parseJson(await post(jar, dirUrl), '目录列表')
    if (Number(dj.code) !== 200) throw new Error(dj.msg || '蓝奏优享目录列表获取失败')
    entries = (dj.list || dj.data || []).map(entryOf)
  }

  if (!entries.length) throw new Error('蓝奏优享分享里没有文件')

  const files = entries.map((e, i) => ({
    id: String(i),
    name: e.name,
    size: e.isDir ? 0 : e.size,
    isDir: false,
    dir: '',
  }))

  return {
    shareId,
    title,
    files,
    resolve: async (id) => {
      const e = entries[Number(id)]
      if (!e) throw new Error('文件不存在')
      const nowTs = Date.now()
      const ts2 = aesHex(nowTs)
      // IzTool 用的是分享层的 fileIds；单文件分享里它与 fileId 相同。
      // 多文件分享必须用逐文件的 fileId，否则下载到的永远是同一个文件。
      const fidStr = entries.length > 1 && e.fileId ? e.fileId : shareFileIds || e.fileId
      const downloadId = aesHex(`${fidStr}|${shareUserId}`)
      const auth = aesHex(`${fidStr}|${nowTs}`)
      const redirectUrl =
        `${API}file/redirect?downloadId=${downloadId}&enable=1&devType=6&uuid=${uuid}` +
        `&timestamp=${ts2}&auth=${auth}&shareId=${encodeURIComponent(shareId)}`

      const r = await req(redirectUrl, { method: 'GET', headers: izHeaders(), jar, redirect: 'manual', timeout: 25000 })
      let loc = r.location
      if (!loc && r.text) {
        const mm = /"url"\s*:\s*"([^"]+)"/.exec(r.text)
        if (mm) loc = mm[1].replace(/\\\//g, '/')
      }
      if (!loc) {
        // 实测：分享方的源文件已被删除/移走时，接口回 {"msg":"下载异常，请联系客服","code":-1}
        const apiMsg = (() => {
          try {
            return JSON.parse(r.text).msg || ''
          } catch {
            return ''
          }
        })()
        if (apiMsg) throw new Error(`蓝奏优享取直链失败：${apiMsg}（通常是分享方的源文件已被删除或移动）`)
        throw new Error('蓝奏优享未返回下载地址（可能分享已过期）')
      }
      if (loc.startsWith('//')) loc = 'https:' + loc
      return {
        url: loc,
        headers: { 'User-Agent': UA_PC_CHROME, Referer: 'https://www.ilanzou.com/' },
      }
    },
  }
}

module.exports = { open, aesHex }
