'use strict'

/**
 * 天翼云盘（189 / cloud.189.cn）分享解析。
 *
 * 规格来源：实地抓 `https://cloud.189.cn/web/share?code=<码>` 的接口 + H5 端
 * `h5.cloud.189.cn/share.html`，以及 21cn 订阅 SPA（`cloud.dlife.cn/content/h5/subscrip/`）
 * 里那段 axios 请求拦截器（签名算法）。三个接口：
 *
 *   1) 分享信息（匿名可读）
 *      POST https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action
 *      form {shareCode, accessCode, uuid}；Accept 必须是 application/json;charset=UTF-8，
 *      否则回 XML；POST 必须是表单（JSON body 会被当成 ShareInfoNotFound）。
 *      → res_code / fileName / fileSize / fileId / fileType / isFolder / mediaType /
 *        needAccessCode / shareId
 *   2) 列目录（要登录）
 *      GET https://cloud.189.cn/api/open/share/listShareDir.action
 *      {shareId, fileId, shareMode=1, isFolder=true, iconOption=5, orderBy=lastOpTime,
 *       descending=true, pageSize=60, pageNum=1, accessCode}
 *      → fileListAO.folderList[].{id,name,fileListSize} / fileList[].{id,name,size,mediaType}
 *      注意分享目录里的字段名是 id / name / size，不是 fileId / fileName / fileSize。
 *   3) 取直链（要登录）
 *      GET /api/open/file/getFileDownloadUrl.action?fileId&dt=1&shareId → fileDownloadUrl
 *      GET /api/open/file/getNewVlcVideoPlayUrl.action?fileId&type=4&dt=1&shareId → normal.url
 *
 * 登录态的签名（照抄 21cn SPA 的拦截器）：把「查询参数 + Timestamp + AccessToken」
 * 拼成 k=v 列表、按字符串排序、用 & 连接，取 md5；头里带
 * AccessToken / Timestamp(毫秒) / Sign-Type: 1 / Signature，Accept 同上是 json。
 *
 * 实测（2026-02，未登录）：
 *   - 匿名只能读到「分享信息」。公开单文件分享 FvMV7rBBfIzq → res_code 0、
 *     shareId 12352119146336、fileId 524321225683250810、文件名
 *     「智能云笔记-语音记录又快又全，智能总结纪要直出！.mp4」、292,013,164 字节。
 *   - 文件夹分享 fQZ7RjzMF73e（「04 家庭场景」，shareId 1247516402201）匿名调
 *     listShareDir 一律 `400 {"res_message":"Argument invalid"}`；换 H5 网关
 *     api.cloud.189.cn 并补上签名后变成 `InvalidSessionKey: sessionKey is null`
 *     —— 签名这道门过了，但列目录确实要登录会话。
 *   - 直链同理：H5 源码里 `if(!p.a.get("accessToken"))return void this.goLogin()`。
 *   - 所以这里的行为是：单文件分享匿名能列；文件夹分享与一切下载都提示去登录。
 *
 * 另：用户给的 `content.21cn.com/h5/subscrip/...shareCode=...` 是「订阅」页，
 * 背后就是普通 189 分享码；那条实测服务端回
 * `FileNotFound / shareUserRightcheck() - sessionKey=null, userId=null`，
 * 是分享本身已失效或只对订阅者开放，不是解析器的问题（拿公开码照样能解析）。
 */

const crypto = require('crypto')

const { req } = require('./util')
const identity = require('./identity')

const API = 'https://cloud.189.cn/api/open'
/** 一次分享最多收这么多条目 */
const MAX_FILES = 3000
const UA_189 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const SHARE_RE =
  /(?:cloud\.189\.cn\/(?:web\/share\?[^#]*?\bcode=|t\/)|content\.21cn\.com\/h5\/subscrip\/[^\s"']*?\bshareCode=)([A-Za-z0-9]+)/i

/** 189 的分享码只可能是这几种字符 */
function cleanCode(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '')
}

/**
 * 从 URL 里取分享码与提取码。支持
 *   https://cloud.189.cn/t/AvUNjqIZf6bm
 *   https://cloud.189.cn/web/share?code=AvUNjqIZf6bm
 *   https://content.21cn.com/h5/subscrip/index.html#/pages/own-home/index?uuid=…&shareCode=AvUNjqIZf6bm
 * 提取码取 ?accessCode= / ?pwd= / URL 末尾的 #xxxx。
 */
function parseShareUrl(url, explicit) {
  const s = String(url || '')
  const m = s.match(SHARE_RE)
  const code = cleanCode((m && m[1]) || '')
  if (!code) {
    const e = new Error('这个链接里没有天翼云盘的分享码')
    e.notFound = true
    throw e
  }
  let pwd = String(explicit || '')
  if (!pwd) {
    const q = s.match(/[?&#](?:accessCode|pwd|password|passcode)=([^&#]+)/i)
    if (q) pwd = decodeURIComponent(q[1])
  }
  return { code, pwd: pwd.trim(), shareUrl: s }
}

/**
 * 解析登录态。天翼云盘的网页把登录令牌放在 cookie/localStorage 的 accessToken 里，
 * 这里认：裸串、`{accessToken|access_token|token} = "…"` 的 JSON、
 * 以及整条 Cookie 串里 `accessToken=…` 那一段。
 */
function parseCred(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s)
      const t = j.accessToken || j.access_token || j.token || j.AccessToken
      if (t) return { token: String(t) }
    } catch {
      /* 落下去按别的形式试 */
    }
  }
  const m = s.match(/(?:^|[;\s])(?:access_?token|AccessToken)=([^;\s]+)/i)
  if (m) return { token: m[1] }
  if (/^[A-Za-z0-9._~+/-]{16,}={0,2}$/.test(s)) return { token: s }
  return null
}

/** 按 21cn SPA 的算法算签名：k=v 列表排序后用 & 连接，取 md5 */
function signature(params) {
  const list = Object.keys(params).map((k) => `${k}=${params[k]}`)
  list.sort()
  return crypto.createHash('md5').update(list.join('&')).digest('hex')
}

/** 登录态请求头；没有令牌时不带签名（匿名接口不校验） */
function signedHeaders(token, params) {
  const h = {
    'User-Agent': UA_189,
    Accept: 'application/json;charset=UTF-8',
    Referer: 'https://cloud.189.cn/web/main/',
  }
  if (!token) return h
  const ts = String(Date.now())
  const all = Object.assign({}, params, { Timestamp: ts, AccessToken: token })
  h.AccessToken = token
  h.Timestamp = ts
  h['Sign-Type'] = '1'
  h.Signature = signature(all)
  return h
}

/**
 * 补上「浏览器现场」的 Cookie 与请求头。
 *
 * 只在**没有自己凭证**（`token` 为空）时才借：天翼的接口认的是 `cookieUserSession`
 * （服务端原话 `cookieUserSession is null or invalid, cookieUserSession=null, userId=null`），
 * 而用户在浏览器里登着云盘时，扩展会把 `cloud.189.cn` 的 Cookie 与请求头交给 PanBox
 * （browserCtx，按主机、10 分钟）。有凭证就只用自己的那套，两套会话不混 —— identity.js 立的规矩。
 */
function withBrowser(url, headers, token) {
  if (token) return headers
  const h = identity.forRequest(url, headers, { referer: 'https://cloud.189.cn/web/main/' })
  /* 现场头会覆盖调用方的同名头（browserCtx.mergeHeaders 的规矩）：正文类型与 Accept 必须还是我们这一种 */
  if (headers['Content-Type']) h['Content-Type'] = headers['Content-Type']
  if (headers.Accept) h.Accept = headers.Accept
  return h
}

async function apiGet(path, params, token) {
  const qs = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')
  const url = `${API}${path}${qs ? `?${qs}` : ''}`
  const r = await req(url, { headers: withBrowser(url, signedHeaders(token, params), token), timeout: 30000 })
  let j
  try {
    j = JSON.parse(r.text)
  } catch {
    throw new Error(`天翼云盘接口返回的内容解析不了（HTTP ${r.status}）`)
  }
  return { status: r.status, j }
}

async function apiPostForm(path, form) {
  const url = `${API}${path}`
  const r = await req(url, {
    method: 'POST',
    headers: withBrowser(
      url,
      {
        'User-Agent': UA_189,
        Accept: 'application/json;charset=UTF-8',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Referer: 'https://cloud.189.cn/web/main/',
      },
      '',
    ),
    body: new URLSearchParams(form).toString(),
    timeout: 30000,
  })
  let j
  try {
    j = JSON.parse(r.text)
  } catch {
    throw new Error(`天翼云盘接口返回的内容解析不了（HTTP ${r.status}）`)
  }
  return { status: r.status, j }
}

function errOf(j, fallback) {
  const code = String((j && (j.res_code || j.errorCode)) || '')
  const msg = String((j && (j.res_message || j.errorMsg)) || '')
  return { code, msg, text: `${msg}${code}` }
}

/** 分享信息（匿名可读）。密码分享要用 accessCode 过 checkAccessCode。 */
async function shareInfo(code, pwd) {
  const uuid = crypto.randomUUID()
  const { j } = await apiPostForm('/share/getShareInfoByCodeV2.action', {
    shareCode: code,
    accessCode: pwd || '',
    uuid,
  })
  const res = String(j.res_code === undefined ? '' : j.res_code)
  if (res !== '0' && j.isFolder === undefined && !j.shareId) {
    const e = new Error(
      /FileNotFound/i.test(errOf(j).text)
        ? '这个天翼云盘分享已经失效或不存在了（服务端返回 FileNotFound）'
        : `天翼云盘读取分享失败：${errOf(j).msg || j.res_code || '未知错误'}`,
    )
    if (/AccessCode/i.test(errOf(j).text)) e.needPassword = true
    throw e
  }
  if (j.needAccessCode) {
    const e = new Error('这个天翼云盘分享需要提取码')
    e.needPassword = true
    throw e
  }
  return {
    shareId: String(j.shareId || ''),
    fileId: String(j.fileId || ''),
    fileName: String(j.fileName || ''),
    size: Number(j.fileSize) || 0,
    isFolder: !!j.isFolder,
    mediaType: j.mediaType,
    uuid,
  }
}

async function listDir(shareId, fileId, pwd, pageNum, token) {
  const params = {
    shareId: String(shareId),
    fileId: String(fileId),
    shareMode: 1,
    isFolder: true,
    iconOption: 5,
    orderBy: 'lastOpTime',
    descending: true,
    pageSize: 60,
    pageNum: pageNum || 1,
    accessCode: pwd || '',
  }
  const { j } = await apiGet('/share/listShareDir.action', params, token)
  const ao = j.fileListAO
  if (!ao) {
    const { code, msg } = errOf(j)
    /* 没带登录态时，服务端对文件夹分享一律拒（Argument invalid / InvalidSessionKey），
     * 如实告诉用户这一步要登录，别把服务端的错误码直接甩到界面上。
     * 例外：扩展交来过 cloud.189.cn 的现场（用户浏览器里登着云盘），那就不是「没登录态」，
     * 这时把服务端原话带出来，方便判断是会话还是参数的问题。 */
    if (!token) {
      const borrowed = identity.has(`${API}/share/listShareDir.action`)
      const e = new Error(
        borrowed
          ? `天翼云盘列目录失败：${msg || code || 'HTTP 异常'}`
          : '天翼云盘的文件夹分享要登录才能列目录（设置 → 天翼云盘 → 登录）；单文件分享不用登录',
      )
      e.needCookie = true
      throw e
    }
    if (/InvalidSessionKey|sessionKey/i.test(`${code}${msg}`)) {
      const e = new Error(
        '天翼云盘的登录态已经失效，重新登录一下（设置 → 天翼云盘 → 登录）',
      )
      e.needCookie = true
      throw e
    }
    throw new Error(`天翼云盘列目录失败：${msg || code || 'HTTP 异常'}`)
  }
  return ao
}

/** 递归收完整个分享（文件夹分享要登录态；单文件分享不走这里） */
async function walk(shareId, rootFileId, pwd, token) {
  const out = []
  const queue = [{ fileId: rootFileId, dir: '' }]
  while (queue.length) {
    const cur = queue.shift()
    let page = 1
    for (;;) {
      const ao = await listDir(shareId, cur.fileId, pwd, page, token)
      for (const f of ao.fileList || []) {
        out.push({
          id: String(f.id || ''),
          name: String(f.name || ''),
          size: Number(f.size) || 0,
          dir: cur.dir,
        })
        if (out.length >= MAX_FILES) return out
      }
      for (const d of ao.folderList || []) {
        queue.push({
          fileId: String(d.id || ''),
          dir: cur.dir ? `${cur.dir}/${d.name}` : String(d.name || ''),
        })
      }
      const count = Number(ao.count) || 0
      if (!(ao.fileList || []).length && !(ao.folderList || []).length) break
      if (page * 60 >= count) break
      page++
    }
  }
  return out
}

/** 取直链（要登录态） */
async function downloadUrl(shareId, fileId, token) {
  const { j } = await apiGet(
    '/file/getFileDownloadUrl.action',
    { fileId: String(fileId), dt: 1, shareId: String(shareId) },
    token,
  )
  if (j.fileDownloadUrl) return String(j.fileDownloadUrl)
  /* 视频类经常只有播放地址，兜一下 */
  const { j: v } = await apiGet(
    '/file/getNewVlcVideoPlayUrl.action',
    { fileId: String(fileId), type: 4, dt: 1, shareId: String(shareId) },
    token,
  )
  const u = (v.normal && v.normal.url) || v.url || ''
  if (u) return String(u)
  const { code, msg } = errOf(j)
  throw new Error(
    `天翼云盘没有返回下载地址：${msg || code || '未知错误'}（链接可能是敏感资源或被限速）`,
  )
}

async function open(url, ctx = {}) {
  const { code, pwd } = parseShareUrl(url, ctx.password)
  const cred = parseCred(ctx.cookie)
  const token = cred ? cred.token : ''

  const info = await shareInfo(code, pwd)

  let entries = []
  if (!info.isFolder) {
    /* 单文件分享：信息接口给的就是文件本身，不需要列目录 */
    if (!info.fileName) throw new Error('这个天翼云盘分享里没有文件')
    entries = [{ id: info.fileId, name: info.fileName, size: info.size, dir: '' }]
  } else {
    entries = await walk(info.shareId, info.fileId, pwd, token)
    if (!entries.length) throw new Error('这个天翼云盘分享里没有文件（可能是空目录）')
  }

  const byId = new Map(entries.map((e) => [String(e.id), e]))

  return {
    shareId: code,
    title: info.isFolder ? '天翼云盘分享' : info.fileName,
    files: entries.map((e) => ({
      id: String(e.id),
      name: e.dir ? `${e.dir}/${e.name}` : e.name,
      size: e.size,
      isDir: false,
      dir: e.dir,
    })),
    resolve: async (id) => {
      const e = byId.get(String(id))
      if (!e) throw new Error('文件索引无效')
      /* 没有自己凭证时，还可以借「浏览器现场」：用户浏览器里登着云盘，扩展会把
       * cloud.189.cn 的 Cookie 交过来，接口要的那个 cookieUserSession 就在里面。 */
      const borrow = identity.has(`${API}/file/getFileDownloadUrl.action`)
      if (!token && !borrow) {
        const err = new Error(
          '天翼云盘的下载要你自己的账号：在浏览器里登着云盘打开这个分享页，再用扩展把这一页交给 PanBox；或到设置 → 天翼云盘 里登录',
        )
        err.needCookie = true
        throw err
      }
      const u = await downloadUrl(info.shareId, e.id, token)
      return {
        url: u,
        headers: {
          'User-Agent': UA_189,
          Referer: 'https://cloud.189.cn/web/main/',
        },
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
  _internal: { shareInfo, listDir, walk, downloadUrl, signature, signedHeaders, MAX_FILES },
}
