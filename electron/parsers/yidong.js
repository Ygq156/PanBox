'use strict'

/**
 * 移动云盘（中国移动云盘 / 139）分享解析。
 *
 * 规格来源：OpenListTeam/OpenList `drivers/139`（`util.go` 的 sharePost / yun139EncryptedRequest /
 * shareGetFilesWithRef / shareGetLinkWithRef，`driver.go:48-50` 的注释）。分享接口在
 * `https://share-kd-njs.yun.139.com/yun-share`，请求体是 AES-128-CBC 加密的
 * base64(iv‖密文)：密钥就是 ASCII 串「PVGDwmcvfs1uV3d1」，明文是**按键名排序后的紧凑 JSON**
 * （数字按 %v 输出，字符串若本身是 JSON 会先解析再排序重排）。响应首字符是 `{` 就当明文
 * JSON，否则 base64 解码后取前 16 字节作 IV 解密。少一个字段顺序不对，服务端就只回一句
 * 「解析失败」，所以下面 sortedStringify 的细节是照抄的，不要随手改。
 *
 * 三个接口（都在上面那个 host 下）：
 *   - 列目录 POST /richlifeApp/devapp/IOutLink/getOutLinkInfoV6
 *       body {getOutLinkInfoReq:{account, linkID, passwd, pCaID}}（pCaID 空按 "root"）
 *       → data.caLst[]（目录：caID/caName）+ data.coLst[]（文件：coID/coName/coSize）
 *   - 预览地址 POST /richlifeApp/devapp/IOutLink/getContentInfoFromOutLink
 *       body {getContentInfoFromOutLinkReq:{contentId, linkID, passwd, account}}
 *       → data.contentInfo.presentURL（只有可预览的内容才有）
 *   - 直链 POST /richlifeApp/devapp/IOutLink/dlFromOutLinkV3
 *       body {dlFromOutLinkReqV3:{account, linkID, passwd, coIDLst:{item:[coID]}}}
 *       → data.extInfo.cdnDownloadURL / data.redrURL / data.downloadURL
 *     这一步要账号：登录态是 `Authorization: Basic <base64("pc:账号:令牌")>`。
 *
 * 实测（用户给的 https://yun.139.com/shareweb/#/w/i/2wFGyEMJ6PCiu，未登录，2026-02）：
 *   - 列目录可用：resultCode "0"、nodNum 22（22 个目录）；进一层也正常，文件名与字节数对得上
 *     （网盘资源库.apk 62,095,544B、AI网盘搜索.apk 14,659,597B…）。pCaID 给 "root" 或空都能列。
 *   - 取直链不行：dlFromOutLinkV3 未登录返回 resultCode "200000401"、
 *     desc「IP鉴权失败、用户账号鉴权失败」。⇒ 下载要用户自己的账号（与 OpenList 的代码路径一致）。
 *   - 预览地址（presentURL）只对可预览内容存在，普通文件是空串；它给的是转码预览，
 *     不能当原片直链用，所以这里不做「拿预览顶替下载」这种事，登录态缺失时如实报错。
 */

const crypto = require('crypto')
const zlib = require('node:zlib')

const { req } = require('./util')

const SHARE_API = 'https://share-kd-njs.yun.139.com/yun-share'
/** 密钥就是这 16 个 ASCII 字符（OpenList 里绕了一圈 hex.EncodeToString 再解码，结果一样） */
const AES_KEY = Buffer.from('PVGDwmcvfs1uV3d1', 'utf8')
/** 服务端按这个 UA / 设备串发接口；换掉会更容易被风控拦 */
const UA_139 =
  'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
const DEVICE_INFO = '||9|12.27.0|firefox|140.0|||linux unknown|1920X526|zh-CN|||'

/** 一次分享最多收这么多条目，避免超大分享把会话内存拖爆 */
const MAX_FILES = 3000

/* ------------------------------------------------------------------ */
/* 加密那一层                                                          */
/* ------------------------------------------------------------------ */

/**
 * 按键名排序的紧凑 JSON。数字不加引号，字符串若是 JSON 文本会先解析后重排
 * —— 与 OpenList 的 sortedJsonStringify 一致。
 */
function sortedStringify(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') {
    try {
      return sortedStringify(JSON.parse(v))
    } catch {
      return JSON.stringify(v)
    }
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(sortedStringify).join(',')}]`
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${sortedStringify(v[k])}`)
    .join(',')}}`
}

function encryptBody(obj) {
  const iv = crypto.randomBytes(16)
  const c = crypto.createCipheriv('aes-128-cbc', AES_KEY, iv)
  const body = Buffer.concat([
    c.update(Buffer.from(sortedStringify(obj), 'utf8')),
    c.final(),
  ])
  return Buffer.concat([iv, body]).toString('base64')
}

function decryptBody(text) {
  const s = String(text || '').trim()
  if (s.startsWith('{')) return JSON.parse(s)
  const buf = Buffer.from(s, 'base64')
  if (buf.length <= 16) throw new Error('接口返回内容太短，认不出来')
  const d = crypto.createDecipheriv('aes-128-cbc', AES_KEY, buf.subarray(0, 16))
  const plain = Buffer.concat([d.update(buf.subarray(16)), d.final()])
  /* 有些接口的明文本身还压了一层 gzip（前两字节 1f 8b），照着解一下再当 JSON 读 */
  const body = plain[0] === 0x1f && plain[1] === 0x8b ? zlib.gunzipSync(plain) : plain
  return JSON.parse(body.toString('utf8'))
}

/* ------------------------------------------------------------------ */
/* 链接与凭证                                                          */
/* ------------------------------------------------------------------ */

/**
 * 从分享链接里取分享编号与口令。认识这几种写法：
 *   https://yun.139.com/shareweb/#/w/i/<编号>
 *   https://yun.139.com/shareweb/w/i/<编号>       （没有 # 的写法）
 *   https://caiyun.139.com/m/i?<编号>             （短链把编号直接当查询串）
 *   https://caiyun.139.com/m/i/<编号>
 * 口令（访问码）跟在后面：#口令 或 ?pwd=口令；调用方传进来的 password 作兜底。
 */
function parseShareUrl(url, password) {
  const raw = String(url || '').trim()
  if (!/139\.com/i.test(raw)) throw new Error('不是移动云盘的分享链接')

  let linkId = ''
  let m = raw.match(/\/(?:w|m)\/i\/([A-Za-z0-9_-]{4,})/i)
  if (m) linkId = m[1]
  if (!linkId) {
    m = raw.match(/\/(?:w|m)\/i\?([A-Za-z0-9_-]{4,})/i)
    if (m) linkId = m[1]
  }
  if (!linkId) {
    m = raw.match(/[?&](?:id|linkId|linkID|shareId|code)=([A-Za-z0-9_-]{4,})/i)
    if (m) linkId = m[1]
  }
  if (!linkId) throw new Error('这个移动云盘链接里找不到分享编号')

  let pwd = ''
  for (const part of raw.split('#').slice(1)) {
    if (/^(?:\/)?(?:w|m)\/i\//i.test(part)) continue
    pwd = decodeURIComponent(part.replace(/^(?:pwd|password|code|accessCode)=/i, ''))
    break
  }
  if (!pwd) {
    m = raw.match(/[?&](?:pwd|password|accessCode)=([^&#]+)/i)
    if (m) pwd = decodeURIComponent(m[1])
  }
  return { linkId, pwd: pwd || String(password || '').trim() }
}

/** 令牌里能看出账号就带出来（`Basic base64("pc:账号:令牌")`） */
function accountOf(v) {
  const s = String(v || '').replace(/^(?:basic|bearer)\s+/i, '').trim()
  try {
    const plain = Buffer.from(s, 'base64').toString('utf8')
    const parts = plain.split(':')
    if (parts.length >= 3 && parts[0] === 'pc') return parts[1]
  } catch {
    /* 不是 base64 就算了 */
  }
  return ''
}

function credOf(v) {
  const token = String(v || '').trim()
  if (!token) return null
  return { token, account: accountOf(token) }
}

/**
 * 认设置里存的那份凭证：`{authorization}` / `{token}` 这类 JSON，或直接的令牌串
 * （可带 `Basic ` 前缀，也可不带）。
 */
function parseCred(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (s.startsWith('{')) {
    let j
    try {
      j = JSON.parse(s)
    } catch {
      return null
    }
    for (const k of ['authorization', 'Authorization', 'token', 'accessToken', 'authToken']) {
      if (typeof j[k] === 'string' && j[k].trim()) return credOf(j[k])
    }
    return null
  }
  return credOf(s)
}

function apiHeaders(token) {
  const h = {
    'User-Agent': UA_139,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'X-Deviceinfo': DEVICE_INFO,
    'hcy-cool-flag': '1',
    'CMS-DEVICE': 'default',
    'x-m4c-caller': 'PC',
    'X-Yun-Api-Version': 'v1',
    Origin: 'https://yun.139.com',
    Referer: 'https://yun.139.com/',
  }
  if (token) h.Authorization = /^basic\s/i.test(token) ? token : `Basic ${token}`
  return h
}

/* ------------------------------------------------------------------ */
/* 接口                                                                */
/* ------------------------------------------------------------------ */

async function sharePost(pathname, body, token) {
  const r = await req(`${SHARE_API}${pathname}`, {
    method: 'POST',
    headers: apiHeaders(token),
    body: encryptBody(body),
    timeout: 30000,
  })
  if (r.status !== 200) {
    throw new Error(`移动云盘接口返回 HTTP ${r.status}`)
  }
  let j
  try {
    j = decryptBody(r.text)
  } catch (e) {
    throw new Error(`移动云盘接口返回的内容解析不了：${e.message}`)
  }
  const code = j.resultCode === undefined || j.resultCode === null ? '' : String(j.resultCode)
  if (code && code !== '0') {
    const err = new Error(j.desc || j.message || `移动云盘接口报错（${code}）`)
    if (/鉴权|登录|auth|account/i.test(`${j.desc || ''}${j.message || ''}${code}`)) err.needCookie = true
    throw err
  }
  return j
}

async function listLevel(linkId, pwd, caID, token, account) {
  const j = await sharePost(
    '/richlifeApp/devapp/IOutLink/getOutLinkInfoV6',
    {
      getOutLinkInfoReq: {
        account: account || '',
        linkID: linkId,
        passwd: pwd || '',
        pCaID: caID || 'root',
      },
    },
    token,
  )
  const d = j.data || {}
  return { dirs: d.caLst || [], files: d.coLst || [] }
}

async function walk(linkId, pwd, token, account) {
  const out = []
  const queue = [{ caID: 'root', dir: '' }]
  while (queue.length) {
    const cur = queue.shift()
    const { dirs, files } = await listLevel(linkId, pwd, cur.caID, token, account)
    for (const f of files) {
      out.push({
        coID: String(f.coID || ''),
        name: String(f.coName || ''),
        size: Number(f.coSize) || 0,
        dir: cur.dir,
      })
      if (out.length >= MAX_FILES) return out
    }
    for (const d of dirs) {
      queue.push({
        caID: d.caID,
        dir: cur.dir ? `${cur.dir}/${d.caName}` : String(d.caName || ''),
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 解析入口                                                            */
/* ------------------------------------------------------------------ */

async function open(url, ctx = {}) {
  const { linkId, pwd } = parseShareUrl(url, ctx.password)
  const cred = parseCred(ctx.cookie)
  const token = cred ? cred.token : ''
  const account = cred ? cred.account : ''

  const entries = await walk(linkId, pwd, token, account)
  if (!entries.length) {
    throw new Error('这个分享里没有文件（可能是个空目录，或者链接已失效）')
  }

  const files = entries.map((e, i) => ({
    id: String(i),
    name: e.dir ? `${e.dir}/${e.name}` : e.name,
    size: e.size,
    isDir: false,
    dir: e.dir,
  }))

  return {
    shareId: linkId,
    title: '移动云盘分享',
    files,
    resolve: async (id) => {
      const e = entries[Number(id)]
      if (!e) throw new Error('文件索引无效')

      /* 有登录态就走取直链那一步（这一步才给的是原片地址） */
      if (token) {
        try {
          const j = await sharePost(
            '/richlifeApp/devapp/IOutLink/dlFromOutLinkV3',
            {
              dlFromOutLinkReqV3: {
                account: account || '',
                linkID: linkId,
                passwd: pwd || '',
                coIDLst: { item: [e.coID] },
              },
            },
            token,
          )
          const d = j.data || {}
          const u =
            (d.extInfo && d.extInfo.cdnDownloadURL) || d.redrURL || d.downloadURL || ''
          if (u) {
            return {
              url: u,
              headers: { 'User-Agent': UA_139, Referer: 'https://yun.139.com/' },
              name: e.name,
            }
          }
        } catch {
          /* 令牌过期、账号不符之类：落到下面如实报「要登录」，不要拿预览地址顶替 */
        }
      }

      const err = new Error(
        '移动云盘的分享要下载，得先用你的账号登录一下（设置 → 移动云盘 → 登录）',
      )
      err.needCookie = true
      throw err
    },
  }
}

const SHARE_RE = /139\.com\/(?:shareweb\/)?(?:#\/?)?(?:w|m)\/i\//i

module.exports = {
  open,
  parseShareUrl,
  parseCred,
  SHARE_RE,
  _internal: { sortedStringify, encryptBody, decryptBody, apiHeaders, accountOf, MAX_FILES },
}
