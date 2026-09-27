'use strict'

/**
 * 迅雷云盘（pan.xunlei.com/s/xxxx）分享解析。
 *
 * 规格来源：chanha666/JieXi（Kotlin，唯一完整实现）+ alist 的 thunder 驱动交叉验证。
 * 签名算法已用官方 fallback 三元组离线断言通过；captcha/init 已实测对**匿名**请求
 * 返回 200 + 真实 captcha_token，因此下面的常量是「在真服务器上跑通过的」。
 *
 * ── 实测结论（2026-09-27，匿名、无任何账号）──────────────────────────────
 *   ✅ `GET  /drive/v1/share`        只要一个和 action 绑定的 captcha_token，
 *                                    **不需要 Bearer**，`pass_code` 直接当参数传
 *   ✅ `GET  /drive/v1/share/detail` 同上，能递归列出子目录，返回文件真实 size / hash
 *   ❌ `POST /drive/v1/share/restore` → 401 unauthenticated（转存必须登录）
 *   ❌ `GET  /drive/v1/files/{id}`    → 401 unauthenticated（取直链必须登录）
 *
 * 即：**游客可以完整浏览分享（含体积），下载需要登录**。这与夸克/UC 的体验一致，
 * 所以无凭证时我们照常返回文件列表，只在「开始下载」时抛 needCookie。
 *
 * ── 签名 ─────────────────────────────────────────────────────────────
 *   captcha_sign = "1." + md5^10( APP_CLIENT_ID + APP_CLIENT_VERSION +
 *                                 APP_PACKAGE_NAME + deviceId + timestampMs , CAPTCHA_SALTS )
 *   device_sign  = "div101." + deviceId + md5( sha1( deviceId + PACKAGE_NAME + APPID + APP_KEY ) )
 *   （md5^10 表示按顺序 `h = md5(h + salt[i])` 迭代 10 次，小写 hex）
 *
 * ── 凭证 ─────────────────────────────────────────────────────────────
 *   迅雷的 pan 接口用 **Bearer token**，不是 cookie。token 存在浏览器 **localStorage**
 *   （`credentials_<client_id>`）里，所以 settings.cookies.xunlei 存的是一个 JSON 字符串：
 *   `{"access_token":"…","refresh_token":"…","user_id":"…","device_id":"…"}`
 */

const crypto = require('node:crypto')
const { req, reqJson, deepFind, sleep } = require('./util')

const AUTH_BASE = 'https://xluser-ssl.xunlei.com'
const PAN_BASE = 'https://api-pan.xunlei.com'

const APP_CLIENT_ID = 'Xp6vsxz_7IYVw2BB'
const APP_CLIENT_VERSION = '8.31.0.9726'
const APP_PACKAGE_NAME = 'com.xunlei.downloadprovider'
const APPID = '40'
const APP_KEY = '34a062aaa22f906fca4fefe9fb3a3021'

/** 10 个 salt，顺序敏感（JieXi `XunleiConstants.kt:27-38`，与 alist thunder 驱动一致） */
const CAPTCHA_SALTS = [
  '9uJNVj/wLmdwKrJaVj/omlQ',
  'Oz64Lp0GigmChHMf/6TNfxx7O9PyopcczMsnf',
  'Eb+L7Ce+Ej48u',
  'jKY0',
  'ASr0zCl6v8W4aidjPK5KHd1Lq3t+vBFf41dqv5+fnOd',
  'wQlozdg6r1qxh0eRmt3QgNXOvSZO6q/GXK',
  'gmirk+ciAvIgA/cxUUCema47jr/YToixTT+Q6O',
  '5IiCoM9B1/788ntB',
  'P07JH0h6qoM6TSUAK2aL9T5s2QBVeY9JWvalf',
  '+oK0AN',
]

const APP_UA =
  'Mozilla/5.0 (Linux; Android 12; M2004J7AC Build/SP1A.210812.016; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 Mobile Safari/537.36 ' +
  'xunlei/v8.31.0.9726 appid/40'

/** 直链下载只需要这个 UA，不需要 Referer（alist 实证）。换成 Chrome UA 会被回 HTTP 503。 */
const DL_UA = 'Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)'

/** 网盘网页版 client_id（抓包实证；同时也是 localStorage 里 `credentials_<client_id>` 的后缀） */
const WEB_CLIENT_ID = 'Xqp0kJBXWhwaTpB6'
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const SHARE_RE = /pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)/i
const PWD_RE = /[?&](?:pwd|password|pass_code)=([A-Za-z0-9]+)/i

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex')

function buildDeviceSign(deviceId) {
  return 'div101.' + deviceId + md5(sha1(deviceId + APP_PACKAGE_NAME + APPID + APP_KEY))
}

function buildCaptchaSign(deviceId, timestampMs, clientId) {
  let h = (clientId || APP_CLIENT_ID) + APP_CLIENT_VERSION + APP_PACKAGE_NAME + deviceId + String(timestampMs)
  for (const salt of CAPTCHA_SALTS) h = md5(h + salt)
  return '1.' + h
}

const newDeviceId = () => crypto.randomBytes(16).toString('hex')

/* ------------------------------------------------------------------ */
/* 凭证                                                                */
/* ------------------------------------------------------------------ */

/** 解出 JWT 的 payload：access_token 是 JWT，`aud` = 签发它的 client_id，`sub` = user_id */
function jwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1]
    if (!part) return null
    const b = part.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** 从 settings.cookies.xunlei 解析出凭证；兼容直接粘贴 access_token 的情况 */
function readCred(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s)
      if (j && j.access_token) {
        const p = jwtPayload(j.access_token) || {}
        return {
          accessToken: String(j.access_token),
          refreshToken: String(j.refresh_token || ''),
          userId: String(j.user_id || p.sub || ''),
          deviceId: String(j.device_id || j.deviceid || ''),
          /* ⚠️ access_token 的 aud 就是签发它的 client_id，必须原样回传。
             实测：网盘网页版登录拿到的凭证 aud = `XpQpkJBXWhaTpB6`，
             而安卓 App（我们用的这套算法）的 client_id = `Xp6vsxz_7IYVw2BB`；
             凭证配上错误的 client_id 会被服务端回 `验证码无效（client_id not match）`。 */
          clientId: String(j.client_id || p.aud || ''),
          /* 网页版那枚「带 client info」的完整 captcha_token（localStorage 里 `captcha_<client_id>`）。
           * 空 token 去 init 只能拿到 282 字符的残废 token，服务端会回
           * `验证码无效（no client info found）`；拿完整 token 去 init 能换回可用的新 token。 */
          captchaToken: String(j.captcha_token || ''),
        }
      }
    } catch {
      /* fallthrough */
    }
  }
  // 纯 token 字符串：deviceId 只能临时生成（大概率会被服务端拒绝，但至少给出明确报错）
  if (/^[A-Za-z0-9._-]{16,}$/.test(s)) {
    const p = jwtPayload(s) || {}
    return { accessToken: s, refreshToken: '', userId: String(p.sub || ''), deviceId: '', clientId: String(p.aud || '') }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 请求管道                                                            */
/* ------------------------------------------------------------------ */

function baseHeaders(scheme, deviceId, cred, clientId) {
  if (scheme === 'web') {
    /* 网页版方案：桌面 Chrome UA + 网页版 client_id + 浏览器实际用的 device_id。
     * 抓包实证：网页版就是这么发的（Bearer + x-device-id + x-client-id + x-captcha-token）。 */
    const h = {
      'User-Agent': WEB_UA,
      Accept: 'application/json, text/plain, */*',
      'X-Device-Id': deviceId,
      'X-Client-Id': clientId || WEB_CLIENT_ID,
      Origin: 'https://pan.xunlei.com',
      Referer: 'https://pan.xunlei.com/',
    }
    if (cred && cred.accessToken) h.Authorization = 'Bearer ' + cred.accessToken
    return h
  }
  const h = {
    'User-Agent': APP_UA,
    Accept: 'application/json;charset=UTF-8',
    'X-Device-Id': deviceId,
    'X-Client-Id': clientId || APP_CLIENT_ID,
    'X-Client-Version': APP_CLIENT_VERSION,
    Origin: 'https://pan.xunlei.com',
    Referer: 'https://pan.xunlei.com/',
  }
  if (cred && cred.accessToken) h.Authorization = 'Bearer ' + cred.accessToken
  return h
}

/**
 * 取 captcha_token。两种方案差别很大（都是真服务器实测）：
 *   - `app`（安卓 App，匿名）：必须带 meta + 10 盐 captcha_sign，否则 400 invalid captcha_sign
 *   - `web`（网盘网页版，需登录）：**极简 body、不要 captcha_sign**，Content-Type 还得是 text/plain
 *     （带上 sign 反而 400 invalid captcha_sign —— 这是「登录后迅雷反而下不动」的根因）
 */
async function fetchCaptcha(deviceId, action, userId, clientId, scheme, seed) {
  if (scheme === 'web') {
    const r = await reqJson(`${AUTH_BASE}/v1/shield/captcha/init`, {
      method: 'POST',
      headers: {
        'User-Agent': WEB_UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'text/plain;charset=UTF-8',
        Origin: 'https://pan.xunlei.com',
        Referer: 'https://pan.xunlei.com/',
      },
      body: JSON.stringify({
        client_id: clientId || WEB_CLIENT_ID,
        action,
        device_id: deviceId,
        // 用已有完整 token 做种子 → 换回一枚可用的新 token；空种子只能拿到残废 token
        captcha_token: seed || '',
      }),
      timeout: 25000,
    })
    const j = r.json || {}
    if (!j.captcha_token) throw new Error(`迅雷 captcha 初始化失败：${r.text.slice(0, 120)}`)
    return j.captcha_token
  }

  const cid = clientId || APP_CLIENT_ID
  const ts = Date.now()
  const r = await reqJson(`${AUTH_BASE}/v1/shield/captcha/init`, {
    method: 'POST',
    headers: {
      'User-Agent': APP_UA,
      Accept: 'application/json;charset=UTF-8',
      'Content-Type': 'application/json',
      'X-Client-Id': cid,
      'X-Device-Id': deviceId,
      'X-Client-Version': APP_CLIENT_VERSION,
    },
    body: JSON.stringify({
      client_id: cid,
      action,
      device_id: deviceId,
      redirect_uri: 'xlaccsdk01://xunlei.com/callback?state=harbor',
      meta: {
        client_version: APP_CLIENT_VERSION,
        package_name: APP_PACKAGE_NAME,
        timestamp: String(ts),
        captcha_sign: buildCaptchaSign(deviceId, ts, cid),
        user_id: String(userId || ''),
      },
      captcha_token: '',
    }),
    timeout: 25000,
  })
  const j = r.json || {}
  if (!j.captcha_token) throw new Error(`迅雷 captcha 初始化失败：${r.text.slice(0, 120)}`)
  return j.captcha_token
}

/**
 * 带 captcha 的 pan 调用。响应统一从 `data` 取（无 data 则用根对象）；
 * `captcha_invalid` 时重取一次 captcha 再试。
 */
async function panCall({ path, method = 'GET', action, deviceId, cred, clientId, scheme, body, timeout = 30000 }) {
  const sch = scheme || (cred && cred.accessToken ? 'web' : 'app')
  const cid = clientId || (cred && cred.clientId) || (sch === 'web' ? WEB_CLIENT_ID : APP_CLIENT_ID)
  let last = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await fetchCaptcha(
      deviceId,
      action || `${method}:${path.split('?')[0]}`,
      cred && cred.userId,
      cid,
      sch,
      sch === 'web' ? (cred && cred.captchaToken) || '' : '',
    )
    // 换到的新 token 存回凭证，让同一次运行里的后续调用继续自举
    if (sch === 'web' && cred) cred.captchaToken = token
    const headers = { ...baseHeaders(sch, deviceId, cred, cid), 'X-Captcha-Token': token }
    if (body) headers['Content-Type'] = 'application/json'
    const r = await reqJson(`${PAN_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      timeout,
    })
    const j = r.json || {}
    const err = String(j.error || '')
    last = { r, j }
    if (err === 'captcha_invalid' && attempt === 0) {
      await sleep(400)
      continue
    }
    if (err === 'captcha_invalid' && sch === 'web') {
      const e = new Error(
        '迅雷云盘的登录凭证需要重新验证（captcha 令牌已失效）。' +
          '请在「设置 → 网盘账号」里重新登录一次迅雷云盘，然后重新解析。',
      )
      e.needCookie = true
      throw e
    }
    if (err === 'unauthenticated') {
      const e = new Error('迅雷云盘需要登录：分享可以匿名浏览，但转存/取直链必须用你自己的账号。')
      e.needCookie = true
      throw e
    }
    if (err) {
      throw new Error(
        `迅雷云盘接口报错：${j.error_description || j.message || err}${j.error_details?.[0]?.detail ? '（' + j.error_details[0].detail + '）' : ''}`,
      )
    }
    return j.data !== undefined && j.data !== null ? j.data : j
  }
  throw new Error(`迅雷云盘请求失败：${last?.r?.text?.slice(0, 160) || '未知错误'}`)
}

/* ------------------------------------------------------------------ */
/* 分享解析                                                            */
/* ------------------------------------------------------------------ */

function toEntry(f) {
  const isDir = f.kind === 'drive#folder'
  return {
    id: String(f.id || ''),
    name: String(f.name || '未命名'),
    size: isDir ? 0 : Number(f.size || 0),
    isDir,
    hash: String(f.hash || ''),
    raw: f,
  }
}

async function open(url, ctx = {}) {
  const u = String(url || '').trim()
  const m = SHARE_RE.exec(u)
  if (!m) throw new Error('不是有效的迅雷云盘分享链接')
  const shareId = m[1]

  const cred = readCred(ctx.cookie)
  /* 两套方案（均由真服务器实测确定，不可混用 —— 混用就是之前
   * 「登录后反而解析失败（client_id not match / invalid captcha_sign）」的根因）：
   *   - 无凭证 → `app`：安卓 App 的 client_id + 10 盐 captcha_sign。**能匿名列分享/详情**，
   *     但转存与取直链一律 401 unauthenticated。
   *   - 有凭证 → `web`：网盘网页版的 client_id + 极简 captcha body（不要 sign）+ Bearer。
   *     列分享、转存、取直链全部可用。网页版 client_id **匿名调用会被回
   *     `验证码无效（no client info found）`**，所以匿名时只能走 app 方案。 */
  const scheme = cred && cred.accessToken ? 'web' : 'app'
  // 登录态下必须沿用浏览器里的 device_id（captcha 与设备绑定）；匿名则每次随机
  const deviceId = (cred && cred.deviceId && /^[0-9a-f]{32}$/i.test(cred.deviceId) ? cred.deviceId : '') || newDeviceId()
  const clientId = scheme === 'web' ? cred.clientId || WEB_CLIENT_ID : APP_CLIENT_ID

  const pwd = String(ctx.password || '').trim() || (PWD_RE.exec(u)?.[1] ?? '')

  const listShare = (parentId, passToken) =>
    panCall({
      path:
        parentId === undefined
          ? `/drive/v1/share?share_id=${encodeURIComponent(shareId)}&pass_code=${encodeURIComponent(pwd)}` +
            `&limit=100&thumbnail_size=SIZE_SMALL`
          : `/drive/v1/share/detail?share_id=${encodeURIComponent(shareId)}&parent_id=${encodeURIComponent(parentId)}` +
            `&pass_code_token=${encodeURIComponent(passToken || '')}&limit=100&thumbnail_size=SIZE_SMALL`,
      action: parentId === undefined ? 'GET:/drive/v1/share' : 'GET:/drive/v1/share/detail',
      deviceId,
      cred,
      clientId,
      scheme,
    })

  const root = await listShare(undefined)

  const status = String(root.share_status || '')
  if (status === 'PASS_CODE_ERROR') {
    const e = new Error('迅雷云盘提取码错误')
    e.needPassword = true
    throw e
  }
  if (status === 'PASS_CODE_NEED' || status === 'PASS_CODE_EMPTY') {
    if (!pwd) {
      const e = new Error('该迅雷分享需要提取码')
      e.needPassword = true
      throw e
    }
    const e = new Error(pwd ? '迅雷云盘提取码错误' : '该迅雷分享需要提取码')
    e.needPassword = true
    throw e
  }
  if (status && status !== 'OK') throw new Error(`迅雷分享状态异常：${status} ${root.share_status_text || ''}`)

  const passToken = String(root.pass_code_token || '')
  const rootFiles = Array.isArray(root.files) ? root.files.map(toEntry) : []
  if (!rootFiles.length) throw new Error('迅雷分享里没有文件（分享可能已失效或提取码不对）')

  const title = rootFiles.length === 1 ? rootFiles[0].name : `迅雷分享 ${shareId}`

  // 递归展开目录（有层数上限，避免异常分享把请求打爆）
  const flat = []
  async function walk(entries, dirPath, depth) {
    for (const e of entries) {
      if (e.isDir) {
        if (depth >= 6) continue
        const sub = await listShare(e.id, passToken)
        const kids = Array.isArray(sub.files) ? sub.files.map(toEntry) : []
        const p = dirPath ? `${dirPath}/${e.name}` : e.name
        await walk(kids, p, depth + 1)
      } else {
        flat.push({ ...e, dir: dirPath })
      }
    }
  }
  if (rootFiles.every((f) => f.isDir)) {
    await walk(rootFiles, '', 0)
  } else if (rootFiles.some((f) => f.isDir)) {
    await walk(rootFiles, '', 0)
  } else {
    flat.push(...rootFiles)
  }
  if (!flat.length) throw new Error('迅雷分享里没有可下载的文件')

  const files = flat.map((f, i) => ({
    id: String(i),
    name: f.name,
    size: f.size,
    isDir: false,
    dir: f.dir || '',
  }))

  /** 转存到用户自己网盘的文件，下载完成后要删掉（与夸克/UC 的回收机制同一套） */
  const transferred = []

  return {
    shareId,
    title,
    files,
    resolve: makeResolver({ shareId, passToken, flat, cred, deviceId, transferred }),
    removeTransferred: () => removeTransferred(transferred),
  }
}

/* ------------------------------------------------------------------ */
/* 取直链（需要登录）                                                  */
/* ------------------------------------------------------------------ */

function makeResolver({ shareId, passToken, flat, cred, deviceId, transferred }) {
  return async function resolve(id) {
    const e = flat[Number(id)]
    if (!e) throw new Error('文件不存在')

    if (!cred || !cred.accessToken) {
      const err = new Error(
        '迅雷云盘的分享只能匿名浏览：文件名和体积都能读到，但**转存/取直链必须登录**。' +
          '请在「设置 → 网盘账号」里登录迅雷云盘（程序会用你自己的账号转存到 /PanBox 再取直链，下载完自动删除）。',
      )
      err.needCookie = true
      throw err
    }

    // ① 转存到根目录
    const restored = await panCall({
      path: '/drive/v1/share/restore',
      method: 'POST',
      action: 'POST:/drive/v1/share/restore',
      deviceId,
      cred,
      body: {
        share_id: shareId,
        pass_code_token: passToken,
        parent_id: '',
        ancestor_ids: [],
        file_ids: [e.id],
        specify_parent_id: true,
      },
    })
    /* 转存会把「分享内的文件 id」映射到「你网盘里的新文件 id」，直接给在
     * `params.trace_file_ids` 里（一个 JSON **字符串**，如
     * `{"VNANFk…A1":"VP2XR0nLGTrAlEVfHLVKV7OPA1"}`）。拿到它就不用再轮询根目录了。 */
    const traceRaw =
      (restored.params && restored.params.trace_file_ids) || deepFind(restored, 'trace_file_ids')
    let fid = ''
    try {
      const map = typeof traceRaw === 'string' ? JSON.parse(traceRaw) : traceRaw
      if (map && typeof map === 'object') fid = String(map[e.id] || Object.values(map)[0] || '')
    } catch {
      /* 落到下面的轮询兜底 */
    }
    if (!fid && traceRaw && typeof traceRaw === 'string' && !traceRaw.startsWith('{')) fid = traceRaw

    if (!fid) {
      // 兜底：按文件名在根目录里轮询找新文件
      const listFiles = () =>
        panCall({
          path:
            '/drive/v1/files?parent_id=&filters=%7B%22trashed%22%3A%7B%22eq%22%3Afalse%7D%7D&with_audit=true&limit=200' +
            '&thumbnail_size=SIZE_SMALL&page_token=',
          action: 'get:/drive/v1/files',
          deviceId,
          cred,
        })
      const same = (a, b) => {
        if (a === b) return true
        const stem = (s) => String(s).replace(/(\.[^.]*)$/, '')
        const ext = (s) => (/(\.[^.]*)$/.exec(String(s)) || ['', ''])[0]
        const re = new RegExp(
          '^' + stem(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( \\(\\d+\\))?' + ext(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
        )
        return re.test(a)
      }
      let hit = null
      for (let i = 0; i < 20 && !hit; i++) {
        const page = await listFiles()
        const arr = Array.isArray(page) ? page : page.files || []
        hit = arr.map(toEntry).find((x) => !x.isDir && same(x.name, e.name))
        if (!hit) await sleep(600)
      }
      if (!hit) {
        const st = String(restored.restore_status || '')
        throw new Error(
          `迅雷转存后没有在网盘里找到该文件（restore_status=${st || '未知'}，可能是账号空间不足）：` +
            JSON.stringify(restored).slice(0, 200),
        )
      }
      fid = hit.id
    }
    transferred.push({ fid, deviceId, cred })

    // ③ 取直链
    const detail = await panCall({
      path:
        `/drive/v1/files/${encodeURIComponent(fid)}?_magic=2021&usage=PLAY&thumbnail_size=SIZE_LARGE` +
        `&with=hdr10&with=subtitle_files&with=task&with=public_share_tag`,
      action: `get:/drive/v1/files/${fid}`,
      deviceId,
      cred,
    })
    const link =
      (detail.links && detail.links['application/octet-stream'] && detail.links['application/octet-stream'].url) ||
      detail.web_content_link ||
      deepFind(detail, 'web_content_link')
    if (!link) throw new Error('迅雷没有返回下载直链（文件可能被审核或需要会员）')

    return {
      url: String(link),
      headers: { 'User-Agent': DL_UA },
    }
  }
}

/** 删除转存副本（下载完成后调用） */
async function removeTransferred(items) {
  const list = (Array.isArray(items) ? items : [items]).filter((x) => x && x.fid)
  if (!list.length) return false
  const { deviceId, cred } = list[0]
  if (!cred || !cred.accessToken) return false
  await panCall({
    path: '/drive/v1/files:batchDelete',
    method: 'POST',
    action: 'POST:/drive/v1/files:batchDelete',
    deviceId,
    cred,
    body: { ids: list.map((x) => x.fid), space: '' },
  })
  return true
}

module.exports = { open, removeTransferred, buildCaptchaSign, buildDeviceSign, CAPTCHA_SALTS, APP_CLIENT_ID, APP_CLIENT_VERSION, APP_PACKAGE_NAME }
