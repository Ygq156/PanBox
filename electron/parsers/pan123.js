'use strict'

/**
 * 123 云盘分享解析（唯一「真不限速」的盘，免费用户 CDN 直连 20+ MB/s）。
 *
 * 规格来源：qaiu/netdisk-fast-download (MIT) 的 123 云盘实现与抓包记录。
 *
 * 实测要点：`www.123pan.com` 对 API 路径一律回 404 HTML（前端 SPA 兜底路由），
 * 必须用裸域 `123pan.com`（或 `www.123pan.cn` / `api.123pan.cn`）；
 * `/b/api/share/get` 与 `/b/api/share/info` 并不校验 `auth-key` 签名。
 *
 * 游客态即可完成「分享 → 列表 → 直链」。签名函数 `encode123` 保留下来是为了对齐参照实现
 * （拿不到真实「要求签名」的响应，所以**没有**接上自动回退分支，见下面 crc32 一节）。
 * 硬限制：免费账号**每月提取流量 10GB**（服务端按账号算，客户端无法绕过）。
 */

const { req, reqJson, UA_PC_CHROME } = require('./util')

const CHAR_MAP = 'adefghlmyijnopkqrstubcvwsz'

const SHARE_RE =
  /https?:\/\/(?:[a-zA-Z\d-]+\.)?(?:123pan\.com|123pan\.cn|123panpay\.com|123684\.com|123865\.com|123912\.com|123592\.com)\/(?:(?:s|123pan)\/|(?:[^/?#]+\/)+)?([a-zA-Z0-9]+-[a-zA-Z0-9]+|[a-zA-Z0-9_-]+)(?:\.html)?/i

/**
 * **实测（2026）**：`www.123pan.com` 对 API 路径一律回 404 HTML（那是前端 SPA 的兜底路由），
 * 必须换成不带 `www.` 的裸域 `123pan.com`；`www.123pan.cn`、`api.123pan.cn` 也都能用。
 * 另外 `/b/api/share/get`、`/b/api/share/info` **不校验 `auth-key` 签名**（裸请求返回同样的 JSON），
 * 所以请求里不带签名。签名实现（crc32 / encode123）与 `smoke-parsers.js` 里那两条对参照实现的
 * 断言都还在，但**没有**「被拒绝就带签名重试」这条分支 —— 手上没有会拒绝的样本可验证。
 */
const API_HOST_CANDIDATES = ['123pan.com', 'www.123pan.cn', 'api.123pan.cn']


/* ------------------------------------------------------------------ */
/* crc32 + encode123 签名                                              */
/* ------------------------------------------------------------------ */

let CRC_TABLE = null
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  CRC_TABLE = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    CRC_TABLE[n] = c
  }
  return CRC_TABLE
}

/** 标准 CRC-32（IEEE），返回无符号 32 位整数 */
function crc32(str) {
  const t = crcTable()
  const buf = Buffer.from(String(str), 'utf8')
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/**
 * `encode123(url, way, version, timestamp)` → `"?<y>=<timeLong>-<a>-<finalCrc>"`
 * 把 timeLong 的每一位十进制数字映射到 CHAR_MAP，再对映射结果与整串各算一次 crc32。
 */
function encode123(url, way, version, timestampMs) {
  const randomInt = 1 + Math.floor(Math.random() * 10000000)
  const a = Math.floor((10000000 * randomInt) / 10000)
  const timeLong = Math.floor(Number(timestampMs) / 1000)

  let g = ''
  for (const ch of String(timeLong)) g += ch === '0' ? CHAR_MAP[0] : CHAR_MAP[Number(ch) - 1]
  const y = crc32(g)
  const finalCrc = crc32(`${timeLong}|${a}|${url}|${way}|${version}|${y}`)
  return `?${y}=${timeLong}-${a}-${finalCrc}`
}

/* ------------------------------------------------------------------ */

function apiHeaders(host, shareKey) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': UA_PC_CHROME,
    platform: 'web',
    'App-Version': '3',
    Referer: `https://${host.replace(/^api\./, 'www.')}/s/${shareKey}`,
    Origin: `https://${host.replace(/^api\./, 'www.')}`,
  }
}

function okOf(j) {
  return !!j && Number(j.code) === 0
}

function msgOf(j) {
  return String((j && (j.message || j.msg)) || '')
}

function isDirItem(it) {
  return Number(it.Type) === 0 || (!it.S3KeyFlag && !it.Etag && !Number(it.Size))
}

/** 轮询候选 API 域名，返回第一个吐出 JSON 的 */
async function pickApiHost(shareHost, shareKey) {
  const seen = new Set()
  const candidates = [...API_HOST_CANDIDATES, shareHost.replace(/^www\./, ''), shareHost]
  const probeUrl = (h) =>
    `https://${h}/b/api/share/info?shareKey=${encodeURIComponent(shareKey)}&` +
    `SharePwd=&ParentFileId=0&Page=1&limit=100&next=1&orderBy=file_name&orderDirection=asc`

  let firstErr = null
  for (const h of candidates) {
    if (!h || seen.has(h)) continue
    seen.add(h)
    try {
      const r = await req(probeUrl(h), { headers: apiHeaders(h, shareKey), timeout: 15000 })
      if (!/json/i.test(r.headers.get('content-type') || '')) continue
      return { host: h, preflight: JSON.parse(r.text) }
    } catch (e) {
      if (!firstErr) firstErr = e
    }
  }
  throw new Error(`123 云盘接口不可达：${firstErr ? firstErr.message : '所有候选域名都未返回 JSON'}`)
}

async function shareInfo(host, shareKey, pwd, cookie) {
  const url =
    `https://${host}/b/api/share/info?shareKey=${encodeURIComponent(shareKey)}` +
    `&SharePwd=${encodeURIComponent(pwd || '')}&ParentFileId=0&Page=1&limit=100&next=1` +
    `&orderBy=file_name&orderDirection=asc`
  const r = await reqJson(url, { headers: apiHeaders(host, shareKey) })
  return r.json || {}
}

async function listDir(host, shareKey, pwd, parentId, cookie) {
  const base = `https://${host}/b/api/share/get`
  const url =
    `${base}?limit=100&next=1&orderBy=file_name&orderDirection=asc` +
    `&shareKey=${encodeURIComponent(shareKey)}&SharePwd=${encodeURIComponent(pwd || '')}` +
    `&ParentFileId=${encodeURIComponent(parentId || '0')}&Page=1&event=homeListFile&operateType=1`
  const r = await reqJson(url, { headers: apiHeaders(host, shareKey) })
  const j = r.json || {}
  if (!okOf(j)) {
    const e = new Error(`123云盘列表失败：${msgOf(j) || `code ${j.code}`}`)
    if (Number(j.code) === 5103 || /密码|pwd|passcode/i.test(msgOf(j))) e.needPassword = true
    throw e
  }
  const info = (j.data && (j.data.InfoList || j.data.infoList)) || []
  const s3 = (j.data && j.data.S3KeyFlag) || ''
  return info.map((it) => ({ ...it, __s3: s3 }))
}

async function walk(host, shareKey, pwd, cookie) {
  const out = []
  const queue = [{ id: '0', dir: '' }]
  let guard = 0
  while (queue.length && guard++ < 60) {
    const cur = queue.shift()
    const list = await listDir(host, shareKey, pwd, cur.id, cookie)
    for (const it of list) {
      if (isDirItem(it)) {
        queue.push({ id: String(it.FileId), dir: `${cur.dir}${it.FileName}/` })
      } else {
        out.push({
          fileId: it.FileId,
          name: it.FileName,
          size: Number(it.Size || 0),
          s3: it.S3KeyFlag !== undefined ? it.S3KeyFlag : it.__s3,
          etag: it.Etag,
          dir: cur.dir,
        })
      }
    }
  }
  return out
}

async function getDownloadUrl(host, shareKey, entry, cookie) {
  const url = `https://${host}/b/api/share/download/info`
  const r = await reqJson(url, {
    method: 'POST',
    headers: { ...apiHeaders(host, shareKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ShareKey: shareKey,
      FileID: entry.fileId,
      S3keyFlag: String(entry.s3 ?? ''),
      Size: entry.size,
      Etag: entry.etag,
    }),
  })
  const j = r.json || {}
  if (!okOf(j)) throw new Error(`123云盘取直链失败：${msgOf(j) || `code ${j.code}`}`)
  let dl = j.data && (j.data.DownloadUrl || j.data.downloadUrl)
  if (!dl) throw new Error('123云盘未返回下载地址（可能超出免费月流量额度）')

  // 旧式响应把小段路径塞在 query 的 params 里，需要 Base64 解出来
  try {
    const u = new URL(dl)
    const params = u.searchParams.get('params')
    if (params) {
      const dec = Buffer.from(params, 'base64').toString('utf8')
      if (/^https?:\/\//i.test(dec)) dl = dec
      else if (/^https?:\/\//i.test(u.origin + dec)) dl = u.origin + dec
    }
  } catch {
    /* ignore */
  }
  return dl
}

async function open(url, ctx = {}) {
  const m = SHARE_RE.exec(String(url || '').trim())
  if (!m) throw new Error('不是有效的 123 云盘分享链接')
  const shareKey = m[1]
  let shareHost
  try {
    shareHost = new URL(url).hostname
  } catch {
    throw new Error('无法解析 123 云盘域名')
  }
  const pwd = String(ctx.password || '').trim()

  // 先探一次 share/info：既挑出能用的 API 域名，又拿分享名、提前发现提取码
  const picked = await pickApiHost(shareHost, shareKey)
  const host = picked.host
  const info = await shareInfo(host, shareKey, pwd, ctx.cookie)
  const title = (info.data && (info.data.ShareName || info.data.shareName)) || `123云盘分享 ${shareKey}`
  const hasPwd = !!(info.data && info.data.HasPwd)
  if (!okOf(info) && (Number(info.code) === 5103 || /密码|pwd/i.test(msgOf(info)))) {
    const e = new Error(`123 云盘分享需要提取码：${msgOf(info) || `code ${info.code}`}`)
    e.needPassword = true
    throw e
  }

  let entries
  try {
    entries = await walk(host, shareKey, pwd, ctx.cookie)
  } catch (e) {
    if (hasPwd && !pwd && !e.needPassword) e.needPassword = true
    throw e
  }
  if (!entries.length) throw new Error('123 云盘分享里没有文件（或链接已失效）')

  const files = entries.map((e, i) => ({
    id: String(i),
    name: e.name,
    size: e.size,
    isDir: false,
    dir: e.dir,
  }))

  return {
    shareId: shareKey,
    title,
    files,
    resolve: async (id) => {
      const e = entries[Number(id)]
      if (!e) throw new Error('文件索引无效')
      return {
        url: await getDownloadUrl(host, shareKey, e, ctx.cookie),
        headers: { 'User-Agent': UA_PC_CHROME },
      }
    },
  }
}

module.exports = { open, encode123, crc32, SHARE_RE }
