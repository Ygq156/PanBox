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

/** 拉取配对令牌。只有带扩展 Origin 的请求能拿到，普通网页拿不到。 */
async function pair() {
  const r = await raw('/pair')
  if (r.ok && r.json && r.json.token) {
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
  await loadCfg()
  if (!cfg.token) await pair()
  const body = JSON.stringify({ ...payload, token: cfg.token, via: payload.via || 'extension' })
  let r
  try {
    r = await raw('/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  } catch (e) {
    return { ok: false, message: '连不上 PanBox（它没在运行？）' }
  }
  if (r.status === 403 && (await pair())) {
    const body2 = JSON.stringify({ ...payload, token: cfg.token, via: payload.via || 'extension' })
    r = await raw('/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body2 })
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

async function handOver(items, info) {
  const referer = (info && info.pageUrl) || ''
  const title = (info && info.pageTitle) || ''
  let okCount = 0
  let last = null
  for (const it of items) {
    const name = it.name || baseName(it.url) || 'download.bin'
    last = await send({
      url: it.url,
      name,
      referer,
      pageTitle: title,
      cookie: await cookieHeader(it.url),
      userAgent: navigator.userAgent,
      headers: referer ? { Referer: referer } : {},
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

/* 浏览器已经为某个请求准备好的请求头（尤其是 Referer 和一些站点自带的 token），
 * 在转交时把它们带上，成功率比插件自己拼要高得多。只留最近 300 条、5 分钟。 */
const TTL = 5 * 60 * 1000
const seen = new Map()

chrome.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (!/^https?:/i.test(d.url)) return
    if (!['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'object', 'other'].includes(d.type)) return
    const h = {}
    for (const x of d.requestHeaders || []) h[x.name.toLowerCase()] = x.value
    seen.set(d.url, { t: Date.now(), referer: h.referer || h.origin || '', ua: h['user-agent'] || '' })
    if (seen.size > 300) {
      const now = Date.now()
      for (const [k, v] of seen) if (now - v.t > TTL) seen.delete(k)
      while (seen.size > 300) seen.delete(seen.keys().next().value)
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['requestHeaders', 'extraHeaders'],
)

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

const MEDIA_TTL = 3 * 60 * 1000 /* 换视频后旧地址会失效；3 分钟足够，也顺便自动淘汰上一个视频 */
const MEDIA_MAX = 240

const mediaByTab = new Map() /* tabId -> Map<url, {t, kind, ct, size}> */
const frameItems = new Map() /* tabId -> Map<frameId, items[]> */

function kindOfUrl(url, ct) {
  const c = String(ct || '')
  if (/\.(m3u8|mpd)(?:$|[?#])/i.test(url)) return 'stream'
  if (/^application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)/i.test(c)) return 'stream'
  if (/\.(ts|m4s)(?:$|[?#])/i.test(url)) return 'segment'
  if (/^(video|audio)\//i.test(c)) return 'media'
  if (MEDIA_RE.test(url)) return 'media'
  return 'file'
}

function rememberMedia(tabId, url, ct, size) {
  let m = mediaByTab.get(tabId)
  if (!m) {
    m = new Map()
    mediaByTab.set(tabId, m)
  }
  const old = m.get(url)
  const c = ct || (old && old.ct) || ''
  m.set(url, {
    t: Date.now(),
    kind: kindOfUrl(url, c),
    ct: c,
    size: Math.max(Number(size) || 0, (old && old.size) || 0),
  })
  if (m.size > MEDIA_MAX) {
    const now = Date.now()
    for (const [k, v] of m) if (now - v.t > MEDIA_TTL) m.delete(k)
    while (m.size > MEDIA_MAX) m.delete(m.keys().next().value)
  }
}

function dropTab(tabId) {
  mediaByTab.delete(tabId)
  frameItems.delete(tabId)
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

/* 收网的那一个：按响应 Content-Type 认媒体（抖音视频只有这一步能抓到） */
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId == null || d.tabId < 0) return
    if (!/^https?:/i.test(d.url)) return
    let ct = ''
    let len = 0
    for (const h of d.responseHeaders || []) {
      const n = String(h.name || '').toLowerCase()
      if (n === 'content-type') ct = String(h.value || '')
      else if (n === 'content-length') len = Math.max(len, Number(h.value) || 0)
      else if (n === 'content-range') {
        const m = /\/(\d+)\s*$/.exec(String(h.value || ''))
        if (m) len = Math.max(len, Number(m[1]) || 0)
      }
    }
    const media =
      MEDIA_CT_RE.test(ct) ||
      (OCTET_RE.test(ct) && (d.type === 'media' || d.type === 'xmlhttprequest' || d.type === 'other'))
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
    cookie: await cookieHeader(item.url),
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
      const out = []
      const have = new Set()
      const now = Date.now()
      const m = tabId >= 0 ? mediaByTab.get(tabId) : null
      if (m) {
        for (const [url, v] of m) {
          if (now - v.t > MEDIA_TTL) continue
          if (have.has(url)) continue
          have.add(url)
          out.push({ url, kind: v.kind, ct: v.ct || '', size: v.size || 0 })
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
      const rank = { media: 0, stream: 1, segment: 2, file: 3 }
      out.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || (b.size || 0) - (a.size || 0))
      return reply({ ok: true, items: out.slice(0, 200) })
    }
    if (msg.type === 'sendUrls') {
      const items = (Array.isArray(msg.items) ? msg.items : [])
        .filter((x) => x && /^https?:/i.test(x.url || ''))
        .slice(0, 80)
      if (!items.length) return reply({ ok: false, count: 0, message: '没有可投递的地址' })
      const r = await handOver(items, { pageUrl: msg.referer || '', pageTitle: msg.title || '' })
      return reply({
        ok: r.okCount > 0,
        count: r.okCount,
        last: r.last,
        message: r.okCount ? '' : '投递失败：确认 PanBox 正在运行',
      })
    }
    if (msg.type === 'pair') {
      const ok = await pair()
      return reply({ ok, paired: !!cfg.token })
    }
    if (msg.type === 'sendUrl') {
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
    return reply({ ok: false, message: '未知消息类型 ' + msg.type })
  })()
  return true /* 异步回复 */
})
