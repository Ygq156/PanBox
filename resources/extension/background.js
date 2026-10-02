'use strict'

/**
 * PanBox 下载助手 —— 后台脚本（MV3 service worker）。
 *
 * 它只做三件事：
 *   1. 右键菜单：把这个链接 / 这个文件 / 这一页的文件链接交给 PanBox；
 *   2. 接管浏览器下载（可选）：浏览器刚开始下载就拦下来转给 PanBox，
 *      并且把浏览器自己用的 Referer / Cookie / User-Agent 一并带过去 ——
 *      「站点资源直接用下载链接下」的关键就在这里，很多站的直链离开这几个头
 *      就是 403。
 *   3. 跟本机 PanBox 的 127.0.0.1:7799 通道配对、投递任务。
 *
 * 它不会、也没有能力去改别人的网盘速度；它只是个「把请求转交出去」的搬运工。
 */

const DEFAULT_PORT = 7799
const BADGE_MS = 2500

const cfg = { port: DEFAULT_PORT, token: '', intercept: true, panel: true }

/* ------------------------------------------------------------------ */
/* 抓到的记录要熬过 service worker 休眠                                 */
/* ------------------------------------------------------------------ */

/* MV3 的 background 是个会被浏览器随时回收的 service worker：用户点开下载页、
 * 等浏览器把文件下完、再回头点面板 —— 中间那段时间它就被回收了，内存里记下的
 * 「这一页请求过哪些文件」全没了，面板于是空空如也。
 *
 * ⚠️ 这是实测踩出来的（不是理论）：拿 Edge 加载本插件、让页面去请求一个
 * `Content-Disposition: attachment` 的地址，事件确实到了、也记下了，但两秒后
 * 再问面板就是空数组 —— 因为 worker 在这中间被回收了。
 *
 * 所以抓到的记录同时写一份到 `chrome.storage.session`：它只存在内存里、关掉
 * 浏览器就没了（地址里的签名本来就短命），不落盘、不进设置。启动时再读回来。 */
const CAP_KEY = 'captured'
const CAP_MAX = 120

async function loadCaptured() {
  try {
    const got = await chrome.storage.session.get({ [CAP_KEY]: null })
    const arr = Array.isArray(got[CAP_KEY]) ? got[CAP_KEY] : []
    const now = Date.now()
    for (const r of arr) {
      if (!r || !r.url || now - (r.t || 0) > MEDIA_TTL) continue
      const m = mediaByTab.get(r.tabId)
      if (m) m.set(r.url, { t: r.t, kind: r.kind, ct: r.ct || '', size: r.size || 0, name: r.name || '', attach: !!r.attach })
      else {
        const nm = new Map()
        nm.set(r.url, { t: r.t, kind: r.kind, ct: r.ct || '', size: r.size || 0, name: r.name || '', attach: !!r.attach })
        mediaByTab.set(r.tabId, nm)
      }
    }
  } catch {
    /* 没有 session 存储权限/环境不支持时就当没有 —— 功能本身照旧 */
  }
}

async function saveCaptured() {
  try {
    const now = Date.now()
    const out = []
    for (const [tabId, m] of mediaByTab) {
      for (const [url, v] of m) {
        if (now - v.t > MEDIA_TTL) continue
        out.push({ tabId, url, t: v.t, kind: v.kind, ct: v.ct || '', size: v.size || 0, name: v.name || '', attach: !!v.attach })
        if (out.length >= CAP_MAX) break
      }
      if (out.length >= CAP_MAX) break
    }
    await chrome.storage.session.set({ [CAP_KEY]: out })
  } catch {
    /* 同上，存不下就算了 */
  }
}

/* worker 每次被唤醒都跑一遍：把还在有效期内的记录读回来 */
if (chrome.storage && chrome.storage.session) {
  try {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  } catch {
    /* 老版本浏览器没有这个方法 */
  }
}

/* ------------------------------------------------------------------ */
/* 与 PanBox 的通道                                                     */
/* ------------------------------------------------------------------ */

async function loadCfg() {
  const got = await chrome.storage.local.get({
    port: DEFAULT_PORT,
    token: '',
    intercept: true,
    panel: true,
  })
  cfg.port = Number(got.port) || DEFAULT_PORT
  cfg.token = String(got.token || '')
  /* 默认「接管」是开的：装完就该像 NDM 那样，浏览器里点下载直接进 PanBox。
   * 只有用户明确关掉（存了 false）才不接管。 */
  cfg.intercept = got.intercept !== false
  cfg.panel = got.panel !== false
  return cfg
}

function base() {
  return `http://127.0.0.1:${cfg.port}`
}

async function raw(path, init) {
  const res = await fetch(base() + path, { cache: 'no-store', ...(init || {}) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 不是 JSON 就只留 text */
  }
  return { status: res.status, ok: res.ok, json, text }
}

/**
 * 拉取配对令牌。只有带扩展 Origin 的请求能拿到，普通网页拿不到。
 * 必须同时确认对端**自称是 PanBox**（`app` 字段）：本机任何进程都能抢在 7799 上
 * 假冒服务端，只认「有没有 token」就等于把页面地址、Referer 与该域的 Cookie 交给它。
 */
async function pair() {
  let r
  try {
    r = await raw('/pair')
  } catch {
    return false
  }
  if (r.ok && r.json && r.json.app === 'PanBox' && r.json.token) {
    cfg.token = r.json.token
    await chrome.storage.local.set({ token: cfg.token })
    return true
  }
  return false
}

async function ping() {
  try {
    const r = await raw('/ping')
    return r.ok && r.json && r.json.app === 'PanBox'
  } catch {
    return false
  }
}

/**
 * 投递一条任务。403 时自动重新配对再试一次（用户重装/重置 PanBox 后 token 会变）。
 */
async function send(payload) {
  return post('/add', payload)
}

/**
 * 把「这一页的现场」交给 PanBox：地址、标题，以及浏览器此刻在这个域上用的
 * Referer / User-Agent / Cookie。有些站点（蓝奏云这类上了反爬的）只认浏览器
 * 自己那套凭据，PanBox 拿它去取页就能过。
 */
async function sendPageContext(payload) {
  return post('/page', payload)
}

async function post(path, payload) {
  await loadCfg()
  /* 没令牌就先配对；配不上说明 7799 上的不是 PanBox（或被别的程序占着），
   * 这时**不要**继续投递 —— 免得把页面地址与该域 Cookie 送给一个陌生进程。 */
  if (!cfg.token && !(await pair())) {
    return { ok: false, message: `连不上 PanBox：127.0.0.1:${cfg.port} 上的服务没有回应配对（端口被占用或 PanBox 版本过旧）` }
  }
  const body = JSON.stringify({ ...payload, token: cfg.token, via: payload.via || 'extension' })
  let r
  try {
    r = await raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  } catch (e) {
    return { ok: false, message: '连不上 PanBox（它没在运行？）' }
  }
  if (r.status === 403 && (await pair())) {
    const body2 = JSON.stringify({ ...payload, token: cfg.token, via: payload.via || 'extension' })
    r = await raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body2 })
  }
  if (r.json) return r.json
  return { ok: false, message: r.text || `HTTP ${r.status}` }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function baseName(url) {
  try {
    const u = new URL(url)
    let n = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    /* 有些站点把真实文件名塞在查询串里 */
    if (!n || !/\.[a-z0-9]{2,5}$/i.test(n)) {
      for (const k of ['filename', 'file', 'name', 'download']) {
        const v = u.searchParams.get(k)
        if (v && /\.[a-z0-9]{2,5}$/i.test(v)) {
          n = v
          break
        }
      }
    }
    return n || ''
  } catch {
    return ''
  }
}

async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url })
    if (!list.length) return ''
    return list.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

async function badge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: color || '#4c8dff' })
    await chrome.action.setBadgeText({ text: text || '' })
    if (text) setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), BADGE_MS)
  } catch {
    /* ignore */
  }
}

/** 页面里那些「一看就是文件」的链接 */
function collectFileLinks() {
  const exts =
    /\.(zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|apk|dmg|pkg|deb|rpm|pdf|epub|mobi|azw3|mp4|mkv|avi|mov|wmv|flv|webm|mp3|flac|wav|ape|m4a|torrent|bin|jar|crx|whl|onnx|safetensors|gguf|part[0-9]*)$/i
  const out = []
  const seen = new Set()
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href
    if (!/^https?:/i.test(href)) continue
    if (seen.has(href)) continue
    if (!exts.test(new URL(href).pathname)) continue
    seen.add(href)
    out.push({ url: href, name: (a.getAttribute('download') || a.textContent || '').trim().slice(0, 120) })
    if (out.length >= 80) break
  }
  /* 页面上没有 <a>，但页面本身是个文件（比如直接打开了 .zip 的下载页） */
  if (!out.length && exts.test(new URL(location.href).pathname)) out.push({ url: location.href, name: '' })
  return out
}

/* ------------------------------------------------------------------ */
/* 投递                                                                */
/* ------------------------------------------------------------------ */

/* 面板列表里的「文件」地址是浏览器真身换出来的，所以按条目自己记下的 UA / 分享页
 * 地址投递 —— 一条地址一个身份，别让面板当前开着哪一页去影响它。 */
async function handOver(items, info) {
  const referer = (info && info.pageUrl) || ''
  const title = (info && info.pageTitle) || ''
  let okCount = 0
  let last = null
  for (const it of items) {
    const name = it.name || baseName(it.url) || 'download.bin'
    const page = it.referer || referer
    last = await send({
      url: it.url,
      name,
      referer: page,
      pageTitle: title,
      cookie: await cookieFor(it.url, seen.get(it.url)),
      userAgent: it.ua || (seen.get(it.url) || {}).ua || navigator.userAgent,
      headers: page ? { Referer: page } : {},
    })
    if (last && last.ok) okCount += 1
  }
  if (okCount) badge(String(okCount), '#34c759')
  else badge('!', '#ff5b5b')
  return { okCount, last }
}

/* ------------------------------------------------------------------ */
/* 右键菜单                                                            */
/* ------------------------------------------------------------------ */

const MENUS = [
  { id: 'panbox-link', title: '用 PanBox 下载此链接', contexts: ['link'] },
  { id: 'panbox-media', title: '用 PanBox 下载此视频 / 音频', contexts: ['video', 'audio'] },
  { id: 'panbox-selection', title: '用 PanBox 下载选中的链接', contexts: ['selection'] },
  { id: 'panbox-page', title: '用 PanBox 下载本页所有文件链接', contexts: ['page'] },
]

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENUS) {
      try {
        chrome.contextMenus.create(m)
      } catch {
        /* 重复创建忽略 */
      }
    }
  })
}

chrome.runtime.onInstalled.addListener(buildMenus)
chrome.runtime.onStartup.addListener(buildMenus)
buildMenus()

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await loadCfg()
  const info2 = { pageUrl: info.pageUrl || (tab && tab.url) || '', pageTitle: (tab && tab.title) || '' }
  try {
    if (info.menuItemId === 'panbox-link' && info.linkUrl) {
      await handOver([{ url: info.linkUrl, name: baseName(info.linkUrl) }], info2)
    } else if (info.menuItemId === 'panbox-media' && info.srcUrl) {
      await handOver([{ url: info.srcUrl, name: baseName(info.srcUrl) }], info2)
    } else if (info.menuItemId === 'panbox-selection' && info.selectionText) {
      const urls = String(info.selectionText).match(/https?:\/\/[^\s"'<>）)]+/gi) || []
      if (urls.length) await handOver(urls.slice(0, 20).map((u) => ({ url: u, name: baseName(u) })), info2)
      else badge('!', '#ff5b5b')
    } else if (info.menuItemId === 'panbox-page' && tab && tab.id != null) {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectFileLinks })
      const links = (res && res.result) || []
      if (links.length) await handOver(links, info2)
      else badge('0', '#ff5b5b')
    }
  } catch (e) {
    badge('!', '#ff5b5b')
  }
})

/* ------------------------------------------------------------------ */
/* 接管浏览器下载                                                      */
/* ------------------------------------------------------------------ */

/* 浏览器已经为某个请求准备好的请求头（Referer、Cookie、User-Agent，
 * 以及站点自己塞的 token 头），在转交时把它们带上，成功率比插件自己拼高得多。
 * 只留最近 300 条、5 分钟。
 *
 * Cookie 也从这里取：这是浏览器**此刻真的在发**的那一份（含 HttpOnly），
 * 比事后用 chrome.cookies 拼更贴近现场，反爬站点认的就是它。 */
const TTL = 5 * 60 * 1000
const MAX_SEEN = 300
const seen = new Map()

function trimSeen() {
  if (seen.size <= MAX_SEEN) return
  const now = Date.now()
  for (const [k, v] of seen) if (now - v.t > TTL) seen.delete(k)
  while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value)
}

/* 分享页里的「下载入口」——蓝奏云是 `/fn?TOKEN` 那条 iframe。
 * 这是**整条链路里最值钱的一条地址**：分享页本身挂着阿里云 ESA 挑战，程序那边
 * 自算 cookie 去取会被回 400（它没浏览器那副指纹）；而这条 `/fn` 页没有挑战，
 * 交过去之后程序就能自己一路走到 CDN 直链。
 * 每次投递都附最近 3 条，按标签页存，过 10 分钟自动扔（token 有时效）。 */
const FN_TTL = 10 * 60 * 1000
const FN_MAX = 6
const fnByTab = new Map() /* tabId -> [{url,t}] */

function looksLikeEntry(u) {
  return /^https?:\/\/[^/?#]+\/fn\?[^#\s]{4,}/i.test(String(u || '')) && String(u).length <= 2048
}

function noteFnUrl(tabId, url) {
  if (tabId == null || tabId < 0 || !looksLikeEntry(url)) return
  let list = fnByTab.get(tabId)
  if (!list) list = []
  if (list.some((x) => x.url === url)) return
  list.unshift({ url, t: Date.now() })
  fnByTab.set(tabId, list.slice(0, FN_MAX))
}

function entryUrlsOf(tabId) {
  const now = Date.now()
  return (fnByTab.get(tabId) || [])
    .filter((x) => now - x.t <= FN_TTL)
    .map((x) => ({ url: x.url }))
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (!/^https?:/i.test(d.url)) return
    if (!['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'object', 'other'].includes(d.type)) return
    noteFnUrl(d.tabId, d.url)
    const h = {}
    for (const x of d.requestHeaders || []) h[String(x.name || '').toLowerCase()] = x.value
    /* 浏览器此刻的真身：下载域记录里要照着填，不能拿写死的 Chrome UA 去凑 */
    if (h['user-agent']) lastUA = String(h['user-agent']).slice(0, 400)
    /* 除 Cookie 外**一个都不丢**：反爬站点常看 Sec-Fetch-* / Sec-CH-UA / Accept 这一组，
     * 少一个就和「真浏览器」对不上。只掐掉长度异常的头，免得一条巨大 header 撑爆投递体。 */
    const keep = {}
    for (const [k, v] of Object.entries(h)) {
      if (k === 'cookie') continue
      const s = String(v == null ? '' : v)
      if (!s || s.length > 1024) continue
      keep[k] = s
      if (Object.keys(keep).length >= 40) break
    }
    seen.set(d.url, {
      t: Date.now(),
      tabId: d.tabId,
      referer: h.referer || h.origin || '',
      ua: h['user-agent'] || '',
      cookie: h.cookie || '',
      headers: keep,
    })
    trimSeen()
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['requestHeaders', 'extraHeaders'],
)

/**
 * 取「浏览器此刻在这个域上用的 Cookie」。
 * 先看 webRequest 现场抓到的（最真实，含 HttpOnly），没有再用 cookies API 拼。
 */
async function cookieFor(url, hint) {
  if (hint && hint.cookie) return hint.cookie
  for (const [u, v] of seen) {
    if (v.cookie && u === url) return v.cookie
  }
  return cookieHeader(url)
}

/** 这一页（含子框架）上，浏览器在各主机上用过的 Cookie，按主机去重后返回 */
function cookieMapForTab(tabId, hosts) {
  const out = new Map()
  if (tabId == null || tabId < 0) return out
  const now = Date.now()
  for (const [u, v] of seen) {
    if (v.tabId !== tabId || !v.cookie || now - v.t > TTL) continue
    let host = ''
    try {
      host = new URL(u).hostname
    } catch {
      continue
    }
    if (hosts && hosts.size && !hosts.has(host)) continue
    if (!out.has(host) || out.get(host).u !== u) out.set(host, { u, cookie: v.cookie })
  }
  return out
}

/** 去掉 #fragment：分享页的锚点不是真实地址，带着它去取页会被站点当成另一个页面 */
function stripHash(u) {
  const s = String(u || '')
  const i = s.indexOf('#')
  return i >= 0 ? s.slice(0, i) : s
}

/** 把某个地址的现场（Referer / UA / Cookie）整理出来 */
function contextFor(url, tabId) {
  const hint = seen.get(url) || {}
  return { referer: hint.referer || '', ua: hint.ua || '', cookie: hint.cookie || '', tabId: tabId != null ? tabId : hint.tabId }
}

/**
 * 这一页在浏览器里「作为导航请求」用过的那套请求头。
 * 优先精确命中页面地址；没有就取这个标签页里同主机的第一条，
 * 再没有就现造一套最小的（UA / Accept / Accept-Language）。
 */
async function pageRequestHeaders(url, tabId) {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    /* ignore */
  }
  let hit = null
  const now = Date.now()
  for (const [u, v] of seen) {
    if (!/^https?:/i.test(u) || now - v.t > TTL) continue
    let h = ''
    try {
      h = new URL(u).hostname
    } catch {
      continue
    }
    if (h !== host) continue
    if (u === url) {
      hit = v
      break
    }
    if (!hit && (tabId == null || tabId < 0 || v.tabId === tabId)) hit = v
  }
  const headers = { ...((hit && hit.headers) || {}) }
  if (!headers['accept-language']) headers['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.8'
  if (!headers.accept) headers.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  return { ua: (hit && hit.ua) || headers['user-agent'] || '', referer: (hit && hit.referer) || '', headers }
}

/* ------------------------------------------------------------------ */
/* 页面悬浮面板要用的素材：这一页浏览器真的请求过哪些媒体               */
/* ------------------------------------------------------------------ */

/* blob: 播放器（B 站 / YouTube / 抖音这类 MSE）在 DOM 里只有一个 blob: 地址，
 * 真的能下的地址藏在网络请求里 —— 只能在 webRequest 里记下来。
 *
 * ⚠️ 只按 URL 后缀找是不够的（v1.1.0 就栽在这里）：
 *   抖音的视频长这样 ——
 *     https://v3-web.douyinvod.com/xxxx/video/tos/cn/tos-cn-ve-15/yyyy/?a=6383&mime_type=video_mp4
 *   路径里根本没有 .mp4，靠后缀永远匹配不到，于是面板只捞到页面里那个
 *   「下载抖音 App」的链接。正确做法是**看响应头里的 Content-Type**：
 *   video/mp4、audio/mp4、application/vnd.apple.mpegurl…
 *   所以这里挂了两个监听：onBeforeRequest 按后缀兜底，
 *   onHeadersReceived 按响应类型收网（这才是能抓到抖音视频的那一个）。 */

const MEDIA_RE =
  /\.(m3u8|mpd|mp4|m4v|m4s|mkv|webm|flv|ts|mov|avi|wmv|mp3|m4a|flac|aac|ogg|opus|wav|wma)(?:$|[?#])/i

/* 响应类型命中这些 = 一定是媒体 */
const MEDIA_CT_RE = /^(video\/|audio\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|vnd\.ms-sstr))/i
/* 有些 CDN 拿 octet-stream 发 mp4 —— 只在请求类型确实是媒体时才认，
 * 免得把 .exe / .zip 这种也收进来。 */
const OCTET_RE = /^application\/octet-stream/i
/* `Content-Disposition: attachment` = 服务器明说「这是让人下载的文件」。
 * 这是**最可靠**的一条线索：蓝奏的下载域（exe2.webgetstore.com 这类 CDN）
 * 地址里既没有 .exe 也没有 video/，只有这个头能认出来。 */
const ATTACH_RE = /^\s*attachment\b/i

const MEDIA_TTL = 3 * 60 * 1000 /* 换视频后旧地址会失效；3 分钟足够，也顺便自动淘汰上一个视频 */
const MEDIA_MAX = 240

const mediaByTab = new Map() /* tabId -> Map<url, {t, kind, ct, size, name, attach}> */
const frameItems = new Map() /* tabId -> Map<frameId, items[]> */

/** `Content-Disposition: attachment; filename="xxx.exe"` → xxx.exe */
function nameFromDisposition(cd) {
  const s = String(cd || '')
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(s)
  if (m) {
    try {
      return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')).slice(0, 200)
    } catch {
      /* 编码坏了就用原样 */
    }
  }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(s)
  return m ? m[1].trim().slice(0, 200) : ''
}

function kindOfUrl(url, ct) {
  const c = String(ct || '')
  if (/\.(m3u8|mpd)(?:$|[?#])/i.test(url)) return 'stream'
  if (/^application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)/i.test(c)) return 'stream'
  if (/\.(ts|m4s)(?:$|[?#])/i.test(url)) return 'segment'
  if (/^(video|audio)\//i.test(c)) return 'media'
  if (MEDIA_RE.test(url)) return 'media'
  return 'file'
}

/* 这个标签页此刻的地址（下载域记录里要写「从哪一页点的」）。
 * 这里只能问 `seen`（onBeforeSendHeaders 每次请求都记了一条）——
 * 扩展的 webRequest 回调是同步的，等不了 chrome.tabs.get 的异步结果。 */
function pageUrlOf(tabId) {
  if (tabId == null || tabId < 0) return ''
  let best = ''
  let at = 0
  for (const [, v] of seen) {
    if (v.tabId !== tabId || !v.referer) continue
    if (v.t > at) {
      at = v.t
      best = v.referer
    }
  }
  return best
}

/* 最近一次真的看到过的 User-Agent（onBeforeSendHeaders 里带）。 */
let lastUA = ''

function rememberMedia(tabId, url, ct, size, name, attach) {
  let m = mediaByTab.get(tabId)
  if (!m) {
    m = new Map()
    mediaByTab.set(tabId, m)
  }
  const old = m.get(url)
  const c = ct || (old && old.ct) || ''
  const nm = name || (old && old.name) || ''
  m.set(url, {
    t: Date.now(),
    /* 服务器明说这是下载文件时，类型就按「文件」算，别被 .mp4 后缀带偏 */
    kind: attach ? 'file' : kindOfUrl(url, c),
    ct: c,
    size: Math.max(Number(size) || 0, (old && old.size) || 0),
    name: nm,
    attach: !!(attach || (old && old.attach)),
  })
  /* 下载域的现场：这个地址是浏览器真身换出来的，UA 与「从哪一页点的」都由浏览器
   * 自己说。PanBox 之后拿这条地址去下时，照着填就能和浏览器一模一样；不填这些，
   * 部分 CDN 会认成换了个人来取，直接拒。 */
  if (attach) {
    const rec = m.get(url)
    const page = pageUrlOf(tabId)
    if (page) rec.referer = page
    if (lastUA) rec.ua = lastUA
  }
  if (m.size > MEDIA_MAX) {
    const now = Date.now()
    for (const [k, v] of m) if (now - v.t > MEDIA_TTL) m.delete(k)
    while (m.size > MEDIA_MAX) m.delete(m.keys().next().value)
  }
  /* 只有「服务器明说可下载」的才值得写进 session 存储（量小、价值最高） */
  if (attach) saveCaptured()
}

function dropTab(tabId) {
  mediaByTab.delete(tabId)
  frameItems.delete(tabId)
}

/* 面板看到的那份列表：这一页浏览器真的请求过的（媒体 + 文件）。
 * 抽成函数是为了能被测试直接调用 —— 扩展自己发的 runtime 消息不会回到自己的
 * onMessage，面板那条路径在自动化里没法靠消息自问自答。 */
function mediaListView(tabId) {
  const out = []
  const have = new Set()
  const now = Date.now()
  /* 下载入口排最前：蓝奏这类站点的文件真正藏在那条 `/fn?TOKEN` 页里，
   * 它是**唯一能绕开分享页反爬**的东西 —— 交过去，程序就能一路走到直链。 */
  for (const it of entryUrlsOf(tabId)) {
    if (have.has(it.url)) continue
    have.add(it.url)
    out.push({ url: it.url, kind: 'entry', ct: '', size: 0, name: '' })
  }
  const m = tabId >= 0 ? mediaByTab.get(tabId) : null
  if (m) {
    for (const [url, v] of m) {
      if (now - v.t > MEDIA_TTL) continue
      if (have.has(url)) continue
      have.add(url)
      out.push({ url, kind: v.kind, ct: v.ct || '', size: v.size || 0, name: v.name || '', attach: !!v.attach })
    }
  }
  const f = tabId >= 0 ? frameItems.get(tabId) : null
  if (f) {
    for (const list of f.values()) {
      for (const it of list) {
        if (!it || !it.url || have.has(it.url)) continue
        have.add(it.url)
        out.push({ url: it.url, kind: it.kind || 'file', ct: '', size: 0 })
      }
    }
  }
  /* 能直接下的整段视频排最前，其次播放列表，再是分片，最后才是页面文件链接。
   * 同类型按体积从大到小 —— 抖音一页能抓到几十个 3KB 的 MSE 分片，
   * 真正要下的是那个几百 KB 起步的 video/mp4。 */
  const rank = { entry: -1, media: 0, stream: 1, segment: 2, file: 3 }
  out.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || (b.size || 0) - (a.size || 0))
  return out.slice(0, 200)
}

/** 这一页里「服务器明说可以下载」的地址（新的在前），交给 PanBox 当备选直链 */
function attachUrlsOf(tabId) {
  const m = tabId != null && tabId >= 0 ? mediaByTab.get(tabId) : null
  if (!m) return []
  const now = Date.now()
  return [...m]
    .filter(([, v]) => v.attach && now - v.t <= MEDIA_TTL)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, 20)
    .map(([url, v]) => ({
      url,
      name: v.name || '',
      size: v.size || 0,
      referer: v.referer || '',
      ua: v.ua || '',
    }))
}

chrome.tabs.onRemoved.addListener((tabId) => dropTab(tabId))

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId == null || d.tabId < 0) return
    /* 顶层文档开始加载 = 换页了，上一个页面的记录全部作废 */
    if (d.type === 'main_frame') {
      dropTab(d.tabId)
      return
    }
    if (!/^https?:/i.test(d.url)) return
    if (!(MEDIA_RE.test(d.url) || d.type === 'media')) return
    rememberMedia(d.tabId, d.url, '', 0)
  },
  { urls: ['http://*/*', 'https://*/*'] },
)

/* 收网的那一个：按响应 Content-Type 认媒体（抖音视频只有这一步能抓到），
 * 并按 `Content-Disposition: attachment` 认「这就是个可下载文件」 */
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId == null || d.tabId < 0) return
    if (!/^https?:/i.test(d.url)) return
    let ct = ''
    let cd = ''
    let len = 0
    for (const h of d.responseHeaders || []) {
      const n = String(h.name || '').toLowerCase()
      if (n === 'content-type') ct = String(h.value || '')
      else if (n === 'content-disposition') cd = String(h.value || '')
      else if (n === 'content-length') len = Math.max(len, Number(h.value) || 0)
      else if (n === 'content-range') {
        const m = /\/(\d+)\s*$/.exec(String(h.value || ''))
        if (m) len = Math.max(len, Number(m[1]) || 0)
      }
    }
    if (ATTACH_RE.test(cd)) {
      /* 服务器明说要下载：不管什么类型都记下来 —— 这是「插件抓到真实下载
       * 链接」的主力，蓝奏/123 这类 CDN 地址里没有任何后缀可认。 */
      rememberMedia(d.tabId, d.url, ct, len, nameFromDisposition(cd), true)
      return
    }
    const media =
      MEDIA_CT_RE.test(ct) || (OCTET_RE.test(ct) && (d.type === 'media' || d.type === 'xmlhttprequest' || d.type === 'other'))
    if (!media) return
    rememberMedia(d.tabId, d.url, ct, len)
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders', 'extraHeaders'],
)

/* SPA（抖音、B 站、微博…）换内容是 pushState，文档并没有重新加载，
 * 内容脚本自己不会知道。这里把导航事件转告给页面，让它立刻重扫；
 * 并且顺手清掉上一个视频的记录，否则面板会一直列着已经失效的地址。 */
function notifyNavigated(tabId, clear) {
  if (tabId == null || tabId < 0) return
  if (clear) {
    mediaByTab.delete(tabId)
    frameItems.delete(tabId)
  }
  try {
    chrome.tabs.sendMessage(tabId, { type: 'panbox:navigated', clear: !!clear }).catch(() => {})
  } catch {
    /* 没有内容脚本（设置页、空白页）就算了 */
  }
}

if (chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) notifyNavigated(d.tabId, true)
  })
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId === 0) notifyNavigated(d.tabId, true)
  })
}

/* ------------------------------------------------------------------ */
/* 接管浏览器下载                                                      */
/* ------------------------------------------------------------------ */

chrome.downloads.onCreated.addListener(async (item) => {
  await loadCfg()
  if (!cfg.intercept) return
  /* blob:/data: 这种是页面自己生成的，交给 PanBox 没有意义 */
  if (!/^https?:/i.test(item.url || '')) return
  const hint = seen.get(item.url) || {}
  /* 先把浏览器这次下载按住，等 PanBox 明确收下了才真的丢掉它；
   * 要是 PanBox 没开，再把它放回去 —— 绝不能让用户的下载凭空消失。 */
  let cancelled = false
  try {
    await chrome.downloads.cancel(item.id)
    cancelled = true
  } catch {
    /* 已经结束了 */
  }

  const fromPath = (item.filename || '').split(/[\\/]/).pop() || ''
  const r = await send({
    url: item.url,
    name: fromPath || baseName(item.url) || 'download.bin',
    referer: item.referrer || hint.referer || '',
    pageTitle: '',
    cookie: await cookieFor(item.url, hint),
    userAgent: hint.ua || navigator.userAgent,
    size: item.totalBytes || 0,
    mime: item.mime || '',
    headers: item.referrer || hint.referer ? { Referer: item.referrer || hint.referer } : {},
    via: 'intercept',
  })
  if (r && r.ok) {
    setTimeout(() => chrome.downloads.erase({ id: item.id }).catch(() => {}), 500)
    badge('✓', '#34c759')
  } else {
    badge('!', '#ff5b5b')
    if (cancelled) {
      try {
        await chrome.downloads.download({ url: item.url, filename: fromPath || undefined })
      } catch {
        /* 回退也失败了，只能算了 */
      }
    }
  }
})

/* ------------------------------------------------------------------ */
/* 给 popup 用的消息接口                                               */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  ;(async () => {
    await loadCfg()
    if (!msg || !msg.type) return reply({ ok: false, message: '未知消息' })
    if (msg.type === 'status') {
      const alive = await ping()
      if (alive && !cfg.token) await pair()
      return reply({
        ok: true,
        alive,
        port: cfg.port,
        intercept: cfg.intercept,
        panel: cfg.panel,
        paired: !!cfg.token,
      })
    }
    if (msg.type === 'set') {
      const patch = {}
      if (msg.port != null) patch.port = Number(msg.port) || DEFAULT_PORT
      if (msg.intercept != null) patch.intercept = !!msg.intercept
      if (msg.panel != null) patch.panel = !!msg.panel
      if (msg.token != null) patch.token = String(msg.token)
      await chrome.storage.local.set(patch)
      await loadCfg()
      return reply({
        ok: true,
        port: cfg.port,
        intercept: cfg.intercept,
        panel: cfg.panel,
        paired: !!cfg.token,
      })
    }
    /* ---- 页面悬浮面板 ---- */
    if (msg.type === 'items') {
      /* 子框架上报自己发现的媒体/文件（面板只在顶层框架画） */
      const tabId = _sender && _sender.tab ? _sender.tab.id : -1
      if (tabId != null && tabId >= 0) {
        let f = frameItems.get(tabId)
        if (!f) {
          f = new Map()
          frameItems.set(tabId, f)
        }
        f.set((_sender && _sender.frameId) || 0, Array.isArray(msg.items) ? msg.items.slice(0, 120) : [])
      }
      return reply({ ok: true })
    }
    if (msg.type === 'mediaList') {
      const tabId = _sender && _sender.tab ? _sender.tab.id : -1
      return reply({ ok: true, items: mediaListView(tabId) })
    }
    if (msg.type === 'sendUrls') {
      const tabId = _sender && _sender.tab ? _sender.tab.id : -1
      const items = (Array.isArray(msg.items) ? msg.items : [])
        .filter((x) => x && /^https?:/i.test(x.url || ''))
        .slice(0, 80)
      if (!items.length) return reply({ ok: false, count: 0, message: '没有可投递的地址' })
      /* 先把这一页的现场交过去（cookie / 真 UA / 下载入口），再投地址：
       * 只给一条地址的话，PanBox 手里没有能过反爬的东西，只能报「未找到下载入口」。 */
      const ctxR = await deliverPageContext(tabId, msg.referer || '', msg.title || '')
      const r = await handOver(items, { pageUrl: msg.referer || '', pageTitle: msg.title || '' })
      return reply({
        ok: r.okCount > 0,
        count: r.okCount,
        last: r.last,
        context: !!(ctxR && ctxR.ok),
        message: r.okCount ? '' : '投递失败：确认 PanBox 正在运行',
      })
    }
    if (msg.type === 'pair') {
      const ok = await pair()
      return reply({ ok, paired: !!cfg.token })
    }
    if (msg.type === 'sendUrl') {
      const sTab = _sender && _sender.tab ? _sender.tab : null
      const tabId = msg.tabId != null ? msg.tabId : sTab ? sTab.id : -1
      await deliverPageContext(tabId, msg.referer || (sTab && sTab.url) || '', msg.title || '')
      const r = await handOver([{ url: msg.url, name: baseName(msg.url) }], { pageUrl: msg.referer || '', pageTitle: msg.title || '' })
      return reply({ ok: r.okCount > 0, count: r.okCount, last: r.last })
    }
    if (msg.type === 'sendPage') {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, func: collectFileLinks })
      const links = (res && res.result) || []
      if (!links.length) return reply({ ok: false, count: 0, message: '这一页没找到文件链接' })
      const r = await handOver(links, { pageUrl: msg.referer || '', pageTitle: msg.title || '' })
      return reply({ ok: r.okCount > 0, count: r.okCount, last: r.last })
    }
    /* 把这一页的现场交给 PanBox：地址 + 该域（含子框架域）浏览器正在用的
     * User-Agent / Referer / Cookie。蓝奏云这类上了反爬的分享页，只有浏览器
     * 自己那套凭据取得到页面。 */
    if (msg.type === 'pageContext') {
      const sTab = _sender && _sender.tab ? _sender.tab : null
      const tabId = msg.tabId != null ? msg.tabId : sTab ? sTab.id : -1
      return reply(await deliverPageContext(tabId, msg.url || (sTab && sTab.url) || '', msg.title || (sTab && sTab.title) || ''))
    }
    return reply({ ok: false, message: '未知消息类型 ' + msg.type })
  })()
  return true /* 异步回复 */
})

/* 把这一页的现场交给 PanBox：地址 + 该域（含子框架域）浏览器正在用的
 * User-Agent / Referer / Cookie，外加这一页浏览器真的请求到过的文件地址与
 * 下载入口。蓝奏云这类上了反爬的分享页，只有浏览器自己那套凭据取得到页面；
 * 而那条 `/fn?TOKEN` 入口页浏览器自己请求过，没有挑战。
 * 面板投递文件时也走它 —— 否则 PanBox 手上只有一条地址，什么都过不去。 */
async function deliverPageContext(tabId, rawUrl, title) {
  /* 以浏览器里真实的页面地址为准（popup 传来的可能是 Referer） */
  let url = stripHash(rawUrl || '')
  if (!/^https?:/i.test(url)) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
    url = stripHash((t && t.url) || '')
  }
  if (!/^https?:/i.test(url)) return { ok: false, message: '只能投递 http(s) 页面' }
  if (tabId == null || tabId < 0) {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true })
    tabId = t && t.id != null ? t.id : -1
  }

  /* 这一页访问过的所有主机都带上 cookie（分享页、ajax 域、下载域常常三家） */
  const cookies = []
  for (const [host, v] of cookieMapForTab(tabId, null)) cookies.push({ host, cookie: v.cookie })
  let pageHost = ''
  try {
    pageHost = new URL(url).hostname
  } catch {
    /* ignore */
  }
  const hostSet = new Set(cookies.map((c) => c.host))
  /* 页面自己的主机一定有：现场没抓到（比如刚打开就点）就用 cookies API 补一份 */
  if (pageHost && !hostSet.has(pageHost)) {
    const c = await cookieHeader(url)
    if (c) cookies.push({ host: pageHost, cookie: c })
  }
  const ctx = contextFor(url, tabId)
  const rh = await pageRequestHeaders(url, tabId)
  const r = await sendPageContext({
    url,
    title: String(title || ''),
    referer: ctx.referer || rh.referer || '',
    userAgent: rh.ua || ctx.ua || navigator.userAgent,
    requestHeaders: rh.headers,
    cookies,
    /* 这一页浏览器**真的请求到过**的文件地址（Content-Disposition 认出来的
     * 那些）。解析器推不出来的、一次性签名的下载地址就在这里面 —— PanBox
     * 按自己那套推出来的地址拿不到直链时，会拿这些当备选。 */
    urls: attachUrlsOf(tabId),
    /* 这一页的**下载入口**（蓝奏 `/fn?TOKEN` 那条 iframe）。分享页反爬过不去时，
     * 程序拿这条入口页就能自己走完剩下的路 —— 它是浏览器自己 requested 过的，
     * 没有挑战。 */
    fn: entryUrlsOf(tabId),
    via: 'page',
  })
  if (r && r.ok) badge('✓', '#34c759')
  return r
}
