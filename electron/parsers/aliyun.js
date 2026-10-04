'use strict'

/**
 * 阿里云盘分享解析。
 *
 * 规格来源：本机实测（2026-10）+ AList/OpenList 的 aliyundrive_share 驱动 + 官方分享页 bundle。
 *
 * 实测要点（都在这台机器上真跑过）：
 *  - **匿名就能列目录**：`POST /v2/share_link/get_share_token` 只要 `{share_id, share_pwd}`
 *    就给一枚 2 小时有效的 `share_token`（不需要登录），带上它调
 *    `POST /adrive/v3/file/list`（`x-share-token`）就能翻目录，`marker` 翻页。
 *  - **取直链这一步必须带用户自己的登录态**：拿分享令牌冒充 `Authorization: Bearer`
 *    试过，回的是 `AccessTokenInvalid: not login`；官方前端的直链解析器缺省就是
 *    `tokenType:"auth"`。老接口 `/v2/file/get_share_link_download_url` 的
 *    `file_id_list` 形态已经 **410** 下线（官方 bundle 里连这个字符串都没有了）。
 *    所以这里照 AList/OpenList 现在还在跑的那套来：`POST api.alipan.com/v2/file/
 *    get_share_link_download_url`，body 是单个 `file_id` + `drive_id` + `share_id`，
 *    头带 `Authorization` + `x-share-token` + `X-Canary`，响应取 `download_url`；
 *    这一步没给地址再退到官方前端的 `/v2/file/get_download_url`（取 `url`）。
 *  - **接口打得快会被风控**：连着翻十几个目录会拿到
 *    `429 {"code":"BlockException","message":"rule:TooManyRequests"}`，
 *    所以列目录之间留间隔（≤4 次/秒），取直链间隔更长，429/5xx 退避重试。
 */

const { req, reqJson, sleep, UA_PC_CHROME } = require('./util')

const API = 'https://api.aliyundrive.com'
const API_PDS = 'https://api.alipan.com'
const AUTH = 'https://auth.alipan.com'
const AUTH_ALT = 'https://auth.aliyundrive.com'
/* 官方前端与 AList 都带这个头，源码注释写着是用来「放宽限速」的 */
const CANARY = 'client=web,app=share,version=v2.3.1'
const REFERER = 'https://www.aliyundrive.com/'

const SHARE_RE =
  /https?:\/\/(?:www\.)?(?:aliyundrive|alipan)\.com\/s\/([a-zA-Z0-9]+)(?:\/folder\/([a-zA-Z0-9]+))?/i

/** 分享页自己发的就是这套头（Referer/Origin 少了会被风控拦） */
function apiHeaders() {
  return {
    'User-Agent': UA_PC_CHROME,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/json',
    Referer: REFERER,
    Origin: REFERER.replace(/\/$/, ''),
  }
}

/**
 * 429（风控）与 5xx 退避重试；其余状态原样返回给调用方判断。
 * 限速这件事按实测来：正常请求之间也要留够间隔（列目录 ≤4 次/秒），
 * 一旦吃到 429 就退得狠一点（3 秒起步），不然会被一路拦住。
 */
async function reqRetry(url, opts, tries = 4) {
  let last = null
  for (let i = 0; i < tries; i++) {
    if (!i) {
      await sleep(300)
    } else {
      const prev = String((last && last.text) || '')
      const blocked = (last && last.status === 429) || /BlockException|TooManyRequests/.test(prev)
      await sleep(blocked ? 3000 * i : 800 * i)
    }
    last = await reqJson(url, opts)
    const text = String(last.text || '')
    const blocked = last.status === 429 || /BlockException|TooManyRequests/.test(text)
    if (!blocked && last.status < 500) return last
  }
  return last
}

function msgOf(j) {
  return String((j && (j.message || j.error_description || j.code)) || '')
}

/** 从分享地址里取分享 ID 与提取码（提取码也可能由调用方单独传进来） */
function parseShareUrl(url, password) {
  const m = SHARE_RE.exec(String(url || ''))
  if (!m) throw new Error('这条地址看起来不是阿里云盘分享链接')
  let pwd = String(password || '').trim()
  if (!pwd) {
    const q = /[?&]pwd=([a-zA-Z0-9]+)/i.exec(String(url))
    if (q) pwd = q[1]
  }
  return { shareId: m[1], folderId: m[2] || '', pwd }
}

/**
 * 把设置里存的凭证串解析成 `{ refreshToken, accessToken }`。
 * 一键登录存进来的是网页 localStorage 里的 `token`（一段 JSON），
 * 也允许用户手贴其中任意一种令牌。
 */
function parseCred(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (s.startsWith('{')) {
    /* 这段是登录窗口写进来的凭证 JSON：里面没有令牌就当作「没登录」，
     * 不能退回去当裸令牌用（`Bearer {}` 只会换来一个看不懂的报错）。 */
    try {
      const j = JSON.parse(s)
      const refreshToken = j.refresh_token || j.refreshToken || ''
      const accessToken = j.access_token || j.accessToken || ''
      return refreshToken || accessToken ? { refreshToken, accessToken } : null
    } catch {
      return null
    }
  }
  return { refreshToken: '', accessToken: s }
}

/** 拿一个能用的 access_token：先用凭证里那枚，过期了就用 refresh_token 换一枚 */
const tokenCache = new Map()
async function accessToken(cred) {
  const key = cred.refreshToken || cred.accessToken
  const hit = tokenCache.get(key)
  if (hit && hit.exp > Date.now() + 60 * 1000) return hit.value
  if (cred.accessToken && /^ey[A-Za-z0-9._-]+$/.test(cred.accessToken)) {
    /* access_token 本身就是 JWT，能直接读出到期时间就不用白跑一次刷新 */
    try {
      const p = JSON.parse(Buffer.from(cred.accessToken.split('.')[1], 'base64url').toString())
      if (p.exp && p.exp * 1000 > Date.now() + 60 * 1000) {
        tokenCache.set(key, { value: cred.accessToken, exp: p.exp * 1000 })
        return cred.accessToken
      }
    } catch {
      /* 读不出来就按刷新走 */
    }
  }
  if (!cred.refreshToken) {
    const e = new Error('阿里云盘的下载需要先用你的账号登录一下（设置里点「登录」）')
    e.needCookie = true
    throw e
  }
  /* 换令牌：新域名 auth.alipan.com 是主力，老域名留作退路 */
  let r = await reqRetry(`${AUTH}/v2/account/token`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: cred.refreshToken }),
  })
  if (!(r.json && r.json.access_token) && AUTH_ALT !== AUTH) {
    r = await reqRetry(`${AUTH_ALT}/v2/account/token`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: cred.refreshToken }),
    })
  }
  const j = r.json || {}
  if (!j.access_token) {
    const e = new Error(`阿里云盘的登录态过期了，请重新登录一次（${msgOf(j) || r.status}）`)
    e.needCookie = true
    throw e
  }
  tokenCache.set(key, { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 7200) * 1000 })
  return j.access_token
}

function sharesHeaders(shareToken, shareId) {
  return {
    ...apiHeaders(),
    'x-share-token': shareToken,
    'x-device-id': 'panbox',
    'X-Canary': CANARY,
    Referer: `https://www.aliyundrive.com/s/${shareId}`,
  }
}

/**
 * 取一条直链。两条路都试，先试 AList/OpenList 还在用的那条分享直链接口，
 * 再退到官方前端用的 `/v2/file/get_download_url`。
 * @returns {Promise<string>} 下载地址（没有就是空串）
 */
async function downloadUrl(shareId, shareToken, token, file) {
  const body = {
    share_id: shareId,
    drive_id: file.driveId,
    file_id: file.fileId,
    expire_sec: 600,
  }
  const tries = [
    /* AList/OpenList 的 aliyundrive_share 驱动：Authorization 用的是 "Bearer\t<token>" */
    { url: `${API_PDS}/v2/file/get_share_link_download_url`, auth: `Bearer\t${token}`, body },
    { url: `${API_PDS}/v2/file/get_share_link_download_url`, auth: `Bearer ${token}`, body },
    { url: `${API}/v2/file/get_download_url`, auth: `Bearer ${token}`, body: { ...body, expire_sec: 900 } },
  ]
  let lastMsg = ''
  for (const t of tries) {
    let r
    try {
      r = await reqRetry(t.url, {
        method: 'POST',
        headers: {
          ...sharesHeaders(shareToken, shareId),
          Authorization: t.auth,
        },
        body: JSON.stringify(t.body),
      })
    } catch (e) {
      /* 一条候选自己失败（实测 `api.alipan.com/v2/file/get_share_link_download_url`
       * 会回 HTTP 410 + 空体，`reqJson` 抛「接口返回不是合法 JSON」）不能把整条链掐断，
       * 否则后面两条候选根本没机会试。记下话继续下一条。 */
      lastMsg = (e && e.message) || String(e)
      continue
    }
    const j = r.json || {}
    const dl =
      j.download_url ||
      j.url ||
      (Array.isArray(j.items) && j.items[0] && (j.items[0].download_url || j.items[0].url)) ||
      ''
    if (dl) return dl
    lastMsg = msgOf(j) || String(r.text || '').slice(0, 120) || `HTTP ${r.status}`
    /* 需要重新登录这类，别接着试第二条了 —— 换个接口也是一样的结果 */
    if (/TokenVerifyFailed|AccessTokenInvalid|not login|refresh_token/i.test(lastMsg)) break
  }
  throw new Error(`阿里云盘没给出下载地址（${lastMsg}）`)
}

async function getShareToken(shareId, pwd) {
  const r = await reqRetry(`${API}/v2/share_link/get_share_token`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ share_id: shareId, share_pwd: pwd || '' }),
  })
  const j = r.json || {}
  if (j.share_token) return j.share_token
  const msg = msgOf(j) || String(r.text || '').slice(0, 120)
  if (/share_pwd|password|提取码|密码/i.test(msg)) {
    const e = new Error('这个分享要提取码')
    e.needPassword = true
    throw e
  }
  throw new Error(`打不开这个分享（HTTP ${r.status}${msg ? '：' + msg : ''}）`)
}

/** 一页一页翻到底：返回 `{ items, next_marker }` */
async function listOnce(shareId, shareToken, parentId, marker) {
  const r = await reqRetry(`${API}/adrive/v3/file/list`, {
    method: 'POST',
    headers: sharesHeaders(shareToken, shareId),
    body: JSON.stringify({
      share_id: shareId,
      parent_file_id: parentId,
      limit: 100,
      marker: marker || '',
      order_by: 'name',
      order_direction: 'ASC',
    }),
  })
  const j = r.json || {}
  if (r.status !== 200 || !Array.isArray(j.items)) {
    const msg = msgOf(j) || String(r.text || '').slice(0, 120)
    throw new Error(`列目录失败（HTTP ${r.status}${msg ? '：' + msg : ''}）`)
  }
  return { items: j.items, next: j.next_marker || '' }
}

/* 一次分享最多收这么多条目：目录特别大的分享不至于把会话内存拖爆 */
const MAX_FILES = 3000

async function walk(shareId, shareToken, rootId) {
  const out = []
  const stack = [{ id: rootId, dir: '' }]
  while (stack.length) {
    const cur = stack.shift()
    let marker = ''
    do {
      const { items, next } = await listOnce(shareId, shareToken, cur.id, marker)
      for (const it of items) {
        const name = String(it.name || '')
        if (it.type === 'folder') stack.push({ id: it.file_id, dir: cur.dir ? `${cur.dir}/${name}` : name })
        else if (it.type === 'file') {
          out.push({ fileId: it.file_id, name, size: Number(it.size) || 0, dir: cur.dir, driveId: it.drive_id })
          if (out.length >= MAX_FILES) return out
        }
      }
      marker = next
    } while (marker)
  }
  return out
}

async function open(url, ctx = {}) {
  const { shareId, folderId, pwd } = parseShareUrl(url, ctx.password)
  const shareToken = await getShareToken(shareId, pwd)
  const entries = await walk(shareId, shareToken, folderId || 'root')
  if (!entries.length) throw new Error('这个分享里没有文件（可能是个空目录，或者链接已失效）')

  /* 文件夹链接（/s/xxx/folder/yyy）按「根目录」显示，去掉那一段共同前缀 */
  const title = folderId ? '阿里云盘分享（子目录）' : '阿里云盘分享'
  const files = entries.map((e, i) => ({
    id: String(i),
    name: e.dir ? `${e.dir}/${e.name}` : e.name,
    size: e.size,
    isDir: false,
    dir: e.dir,
  }))

  return {
    shareId,
    title,
    files,
    resolve: async (id) => {
      const e = entries[Number(id)]
      if (!e) throw new Error('文件索引无效')
      const cred = parseCred(ctx.cookie)
      if (!cred) {
        const err = new Error('阿里云盘的分享要下载，得先用你的账号登录一下（设置 → 阿里云盘 → 登录）')
        err.needCookie = true
        throw err
      }
      const token = await accessToken(cred)
      /* 取直链要登录态；分享令牌一起带上，服务端才知道是「这个分享里的这个文件」 */
      const dl = await downloadUrl(shareId, shareToken, token, e)
      return {
        url: dl,
        headers: { 'User-Agent': UA_PC_CHROME, Referer: 'https://www.alipan.com/' },
        name: e.name,
      }
    },
  }
}

module.exports = {
  open,
  parseShareUrl,
  parseCred,
  SHARE_RE,
  _internal: { apiHeaders, sharesHeaders, accessToken, downloadUrl, tokenCache },
}