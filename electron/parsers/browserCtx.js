'use strict'

/**
 * 「浏览器现场」——插件把用户此刻在浏览器里那一页的凭据（该域正在用的
 * Cookie / User-Agent / Referer）交给主进程，解析分享页时当成自己的请求头。
 *
 * 为什么需要它：蓝奏云这类站点挂了阿里云 ESA 反爬。挑战脚本算出来的 cookie
 * 在纯 Node 里时灵时不灵，而**浏览器自己那套 cookie 一定有效**（页面就是它打开的）。
 * 插件不需要替站点做任何事，只要把浏览器已经在用的东西转交过来即可。
 *
 * 两条铁律：
 *   1. **只存内存**，绝不写盘、绝不进日志/设置/UI。用户关掉 PanBox 就没了。
 *   2. **按主机取用**：给 A 主机的 cookie 只会在请求 A 主机（或其子域）时带上，
 *      绝不会跟着请求跑到 B 主机去。
 */

const { Jar } = require('./util')

const TTL = 10 * 60 * 1000 /* 10 分钟：够用户点完「交给 PanBox」再看结果 */
const MAX_HOSTS = 40
const MAX_COOKIE = 64 * 1024
/* 每个主机最多记住多少条「浏览器真的请求过的文件地址」 */
const MAX_URLS = 40

/** host -> { cookie, referer, userAgent, headers, at } */
const store = new Map()

function normHost(u) {
  try {
    return new URL(String(u)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 某个主机是不是另一个主机的同一站点（www.a.com 之于 a.com） */
function sameSite(host, other) {
  if (!host || !other) return false
  return host === other || host.endsWith('.' + other) || other.endsWith('.' + host)
}

/**
 * 存一条浏览器现场。cookies 是 [{ host, cookie }]（省略 host 时按 url 的主机算）。
 * 返回真正存下来的主机数。
 */
function set(payload) {
  const url = String((payload && payload.url) || '')
  const host = normHost(url)
  if (!host) return 0
  const referer = String((payload && payload.referer) || '')
  const userAgent = String((payload && payload.userAgent) || '').slice(0, 400)
  const list = Array.isArray(payload && payload.cookies) ? payload.cookies : []
  /* 插件交过来的每一条 cookie 都按它自己声明的主机存下。分享页常常把文件放在
 * **完全另一家公司**的下载域上（蓝奏：分享页 lanrar.com、下载域 webgetstore.com），
 * 曾经这里要求 cookie 主机必须与页面主机「同站点」，于是这类下载域的现场被整条丢掉 ——
 * 表现就是「插件明明抓到了，PanBox 却像没看见」。 */
  const mapped = list
    .map((c) => ({
      host: String((c && c.host) || host).toLowerCase(),
      cookie: String((c && c.cookie) || '').slice(0, MAX_COOKIE),
    }))
    .filter((c) => c.host && c.cookie)
  /* 一条 cookie 都没有时，只要这次还带来了「浏览器此刻的身份」（UA / Referer /
 * 请求头），也按本主机存一条空 cookie 的现场：下载域就是靠它才认得出「是同一个人」。 */
  if (!mapped.length && payload && payload.cookie) {
    mapped.push({ host, cookie: String(payload.cookie).slice(0, MAX_COOKIE) })
  }
  if (!mapped.length && (userAgent || referer || Object.keys(pickHeaders(payload && payload.requestHeaders) || {}).length)) {
    mapped.push({ host, cookie: '' })
  }

  /* 跨主机的 API 凭据：插件把浏览器**真的发出去过**的 Authorization 按主机交过来
   * （`authByHost`）。有些网盘的接口主机跟页面主机不是一台（移动云盘：页面在
   * yun.139.com，接口在 share-kd-njs.yun.139.com，凭据在 `Authorization: Basic …` 头里），
   * 而 pageRequestHeaders 只交页面自己主机的头 —— 没有这条，那份凭据就传不过来。
   * 只收 Authorization 的**值**，按主机存，绝不跨主机取用。 */
  const authMap = {}
  const authIn = payload && payload.authByHost && typeof payload.authByHost === 'object' ? payload.authByHost : {}
  for (const [h, v] of Object.entries(authIn)) {
    const host2 = String(h || '').toLowerCase()
    const val = String(v == null ? '' : v).slice(0, 1024)
    if (!host2 || !val) continue
    if (Object.keys(authMap).length >= 8) break
    authMap[host2] = val
  }
  /* 只有 Authorization、连 cookie 都没有的主机（就是上面那种接口主机）也得建条目 */
  for (const h of Object.keys(authMap)) {
    if (!mapped.some((c) => c.host === h)) mapped.push({ host: h, cookie: '' })
  }

  const at = Date.now()
  /* 浏览器此刻真的在用的那套头（Accept / Sec-Fetch-* / Sec-CH-UA 这一组）。
   * 反爬看的就是它，所以插件会一起交过来；只留白名单之外的，长度也压住。 */
  const headers = pickHeaders(payload && payload.requestHeaders)
  let n = 0
  for (const c of mapped) {
    store.set(c.host, {
      cookie: c.cookie,
      referer,
      userAgent,
      headers,
      auth: authMap[c.host] || '',
      at,
    })
    n += 1
  }
  /* 顺手清过期的，再按时间淘汰，避免长期运行攒一堆凭据 */
  gc()
  if (store.size > MAX_HOSTS) {
    const byAge = [...store].sort((a, b) => a[1].at - b[1].at)
    for (const [h] of byAge.slice(0, store.size - MAX_HOSTS)) store.delete(h)
  }
  /* 插件如果一起交来了「这一页浏览器真的请求过的文件地址」，也记下来当备选 */
  if (payload && payload.urls) noteUrls(payload.urls)
  /* 以及**下载入口页**（蓝奏 `/fn?TOKEN`）—— 它让解析器绕开挂挑战的分享页 */
  if (payload && payload.fn) noteFn(payload)
  return n
}

function gc() {
  const now = Date.now()
  for (const [h, v] of store) if (now - v.at > TTL) store.delete(h)
}

/* ------------------------------------------------------------------ */
/* 浏览器里的下载入口（蓝奏 `/fn?TOKEN`）                               */
/* ------------------------------------------------------------------ */

/* 蓝奏分享页里的下载入口是一条 `/fn?TOKEN` iframe。分享页本身挂着 ESA 挑战，
 * 纯 Node 取会被回 400；但这条 `/fn` 页**没有挑战**，纯 Node 带上浏览器的
 * UA / Referer 就能取到整页文件信息，一路走到 CDN 直链。
 * 插件在页面里看得到它（`onBeforeSendHeaders` 里那个 sub_frame 请求），交过来即可。
 *
 * 与 cookie 一样的规矩：只存内存、按主机取用、过一会儿就扔（token 有时效）。 */
const FN_TTL = 12 * 60 * 1000
const FN_MAX_HOSTS = 40
const MAX_FN = 8
/** pageHost -> [{ url, at }] */
const fnStore = new Map()

/* 只认下载入口那一种形态：蓝奏各家域名 + `/fn?` 开头。别的地址一律不记 ——
 * 免得把浏览器的浏览记录顺手攒下来。 */
const FN_RE =
  /^https?:\/\/(?:[a-zA-Z\d-]+\.)?(?:(?:lanzou[bcefghijklmopqtuvwxy]|lanzn|lanzv|lanosso|lanpv|lanwp|bakstotre|ulanzou|woozooo|dmpdmp|lanrar|webgetstore)\.com|t-is\.cn)\/fn\?/i

function fnGc() {
  const now = Date.now()
  for (const [h, list] of fnStore) {
    const keep = list.filter((it) => now - it.at <= FN_TTL)
    if (keep.length) fnStore.set(h, keep)
    else fnStore.delete(h)
  }
}

/** 记下「浏览器在这一页里请求过的下载入口」。返回记下来的条数。 */
function noteFn(payload) {
  const pageUrl = String((payload && payload.url) || '')
  const pageHost = normHost(pageUrl)
  if (!pageHost) return 0
  const raw = Array.isArray(payload && payload.fn) ? payload.fn : payload && payload.fn ? [payload.fn] : []
  const now = Date.now()
  let list = fnStore.get(pageHost)
  if (!list) list = []
  let n = 0
  for (const it of raw) {
    const u = String((it && it.url) || it || '').trim()
    if (!FN_RE.test(u) || u.length > 2048) continue
    /* 入口页与分享页同一家站点（同一批域名）才认：不然就是拿别人的凭据去取别人的文件 */
    if (!sameSite(normHost(u), pageHost)) continue
    if (list.some((x) => x.url === u)) continue
    list.unshift({ url: u, at: now })
    n += 1
  }
  if (!n && !list.length) return 0
  list = list.filter((it) => now - it.at <= FN_TTL).slice(0, MAX_FN)
  fnStore.set(pageHost, list)
  fnGc()
  if (fnStore.size > FN_MAX_HOSTS) {
    const byAge = [...fnStore].sort((a, b) => (b[1][0]?.at || 0) - (a[1][0]?.at || 0))
    for (const [h] of byAge.slice(FN_MAX_HOSTS)) fnStore.delete(h)
  }
  return n
}

/** 这个分享页有没有浏览器交过来的下载入口（新的在前）；没有就返回 null */
function fnFor(url) {
  fnGc()
  const host = normHost(url)
  if (!host) return null
  for (const [h, list] of fnStore) {
    if (!sameSite(host, h)) continue
    const alive = list.filter((it) => Date.now() - it.at <= FN_TTL)
    if (alive.length) return { url: alive[0].url, at: alive[0].at }
  }
  return null
}

function clear() {
  store.clear()
  fnStore.clear()
}

/** 请求 url 时该用哪份现场：自己主机优先，其次同站点的主机（分享页与其 iframe 常见的组合） */
function lookup(url) {
  gc()
  const host = normHost(url)
  if (!host) return null
  const exact = store.get(host)
  if (exact) return exact
  for (const [h, v] of store) if (sameSite(host, h)) return v
  return null
}

/**
 * 拿一份「不管哪台主机」的浏览器身份，只用来填 UA。
 * 下载域常和分享页**完全不同域**（蓝奏：分享页 lanrar.com、文件在 webgetstore.com），
 * 同站点规则永远匹配不上，但 CDN 已经见过这个 UA 换了条链接出来 —— 换了个人来取它就拒。
 * cookie / Referer 绝不走这条：那是会串门的东西。
 */
function anyUserAgent() {
  gc()
  let best = ''
  let at = 0
  for (const [, v] of store) {
    if (v.userAgent && v.at >= at) {
      at = v.at
      best = v.userAgent
    }
  }
  return best
}

/**
 * 给某个地址挑出**属于它这个主机**的 cookie（绝不复用别家的：分享页在
 * wwbdm.lanzoub.com、ajax 在 apifile.woozooo.com 时，前者的 cookie 不能带去后者）。
 * 没有就返回空，调用方保持原样。
 */
function cookieFor(url) {
  gc()
  const host = normHost(url)
  if (!host) return ''
  /* 同站点（www.a.com 与 a.com）算同一台主机，其余一律不带 */
  for (const [h, v] of store) if (sameSite(host, h)) return v.cookie || ''
  return ''
}

/** 这份现场是不是就属于这个主机（用于决定要不要带上它的 Referer / UA）。
 *  与 cookieFor 同一套判定：同一站点的兄弟主机（www.a.com 与 a.com）算一台。 */
function owns(url) {
  const host = normHost(url)
  if (!host) return false
  if (store.has(host)) return true
  for (const h of store.keys()) if (sameSite(host, h)) return true
  return false
}

/**
 * 建一个请求用的 cookie 罐：浏览器现场（她此刻真的在用的那份）在前，
 * 用户手动配的 cookie 在后合并，站点新发的 Set-Cookie 会在请求过程中叠加上去。
 */
function jarFor(url, extraCookie) {
  const j = new Jar()
  const b = cookieFor(url)
  if (b) j.setFromString(b)
  if (extraCookie) j.setFromString(extraCookie)
  return j
}

/* ------------------------------------------------------------------ */
/* 请求头                                                              */
/* ------------------------------------------------------------------ */

/* 这些由调用方按请求语义决定，浏览器现场不覆盖：Cookie 走 jar、
 * 长度/编码/连接类交给 fetch 自己算。 */
const SKIP_HEADERS = new Set([
  'cookie',
  'content-length',
  'host',
  'connection',
  'accept-encoding',
  'origin',
  'referer',
  'user-agent',
])

/**
 * 把一个起点请求头补成「浏览器现场」的样子：站点自带的 x- token 头、
 * 真的 User-Agent、以及该主机自己的 Referer。
 *
 * @param {object} headers 调用方已备好的头（不会被修改）
 * @param {string} url     这次请求的目标地址
 * @param {string} fallbackReferer 没有现场时用的 Referer
 */
function headersFor(headers, url, fallbackReferer) {
  const out = { ...(headers || {}) }
  const v = lookup(url)
  const own = owns(url)
  const host = normHost(url)
  const pageHost = v ? normHost(v.referer) : ''
  if (v && own && host && pageHost && host === pageHost) {
    /* 浏览器那次导航请求真的在用的一套头：Accept / Accept-Language / Sec-Fetch-*
     * / Sec-CH-UA 这些，反爬会看。只在**同一台主机**上并 —— 别的主机上浏览器
     * 用的是另一套（Sec-Fetch-Site 都不一样），照搬过去反而露馅。 */
    Object.assign(out, mergeHeaders(out, v.headers))
  }
  if (v && own) {
    /* 只在这个主机就是分享页主机时沿用浏览器的 Referer —— 跨主机（例如
     * 分享页在 lanzoub.com、ajax 在 apifile.woozooo.com）照原样带过去，
     * 会把「一个站点的页面地址」泄露给另一个站点，而且反爬也未必认。 */
    if (v.referer && (!pageHost || sameSite(host, pageHost))) out.Referer = v.referer
  }
  /* UA：谁在现场就用谁的；现场是个空壳（例如只记了「浏览器下过的文件地址」，
   * 没有 UA）时，借最近一次见到的浏览器真身。
   * 下载域常常是「浏览器没导航过去、但链接是浏览器身份换出来的」那种主机：这时
   * 调用方给的是写死的 Chrome UA，而 CDN 已经见过另一副面孔换了条链接出来 ——
   * 换了个人来取它就拒。用户看到的就是「浏览器和 NDM 能下，PanBox 下不了」。 */
  const ua = (v && own && v.userAgent) || anyUserAgent()
  if (ua) out['User-Agent'] = ua
  /* 跨主机的 API 凭据（`authByHost`，只有 Authorization 的值）：**精确主机**命中才带，
   * 同一站点的兄弟主机也不行 —— 凭据是会把站点之间串起来的东西，与 cookie 一个规矩。 */
  const exact = store.get(host)
  if (exact && exact.auth && !out.Authorization && !out.authorization) out.Authorization = exact.auth
  if (!out.Referer && fallbackReferer) out.Referer = fallbackReferer
  return out
}

/**
 * 把浏览器现场里除 Cookie 外的头并进来（扩展侧抓到的那些 x- 头）。
 * 只并白名单外的东西，避免把 fetch 自己管的头写坏。
 */
function mergeHeaders(headers, extra) {
  const out = { ...(headers || {}) }
  for (const [k, val] of Object.entries(extra || {})) {
    const key = String(k).toLowerCase()
    if (SKIP_HEADERS.has(key)) continue
    if (val === undefined || val === null || val === '') continue
    out[String(k)] = String(val).slice(0, 2048)
  }
  return out
}

/** 插件交过来的请求头：只留 fetch / jar 不管的那些，条数与长度都压住 */
function pickHeaders(h) {
  if (!h || typeof h !== 'object') return null
  const out = mergeHeaders({}, h)
  const keys = Object.keys(out)
  if (keys.length > 40) for (const k of keys.slice(40)) delete out[k]
  return Object.keys(out).length ? out : null
}

/* ------------------------------------------------------------------ */
/* 浏览器真的请求过的「文件地址」                                       */
/* ------------------------------------------------------------------ */

/**
 * 有些站点的下载地址**只有浏览器自己点出来那一条能用**：一次性签名、
 * 会话里现算的 token……程序按页面推出来的那条可能过期、可能根本不是同一个。
 * 插件在浏览器里看到「响应是文件本体」（`Content-Disposition: attachment`
 * 或明确的二进制类型）时，把那条地址交过来，解析器可以拿它当备选。
 *
 * 与 cookie 同规矩：**只存内存**、**按主机取用**，不给别的主机用。
 * 但「文件在另一家公司域名上」（蓝奏：分享页 lanrar.com、文件在 webgetstore.com）
 * 这种最常见的情形里，下载域自己不会有现场条目 —— 这时也得把它记下来，否则
 * 插件明明抓到了、程序这边却一条备选都问不出来。
 */
function noteUrls(list) {
  const now = Date.now()
  const arr = Array.isArray(list) ? list : []
  let n = 0
  for (const it of arr) {
    const url = String((it && it.url) || it || '')
    if (!/^https?:\/\//i.test(url) || url.length > 2048) continue
    const host = normHost(url)
    if (!host) continue
    let v = store.get(host)
    if (!v) {
      v = { cookie: '', referer: '', userAgent: '', headers: {}, at: now, urls: [] }
      store.set(host, v)
    }
    if (!v.urls) v.urls = []
    if (v.urls.some((u) => u.url === url)) continue
    v.urls.unshift({ url, name: String((it && it.name) || '').slice(0, 200), at: now })
    if (v.urls.length > MAX_URLS) v.urls.length = MAX_URLS
    n += 1
  }
  return n
}

/** 这个主机上浏览器请求过的文件地址（新的在前）；没有就返回空数组 */
function fileUrlsFor(url) {
  const host = normHost(url)
  if (!host) return []
  for (const [h, v] of store) {
    if (!sameSite(host, h)) continue
    const list = (v.urls || []).filter((u) => Date.now() - u.at <= TTL)
    if (list.length) return list.map((u) => u.url)
  }
  return []
}

module.exports = {
  set,
  clear,
  lookup,
  cookieFor,
  jarFor,
  owns,
  headersFor,
  mergeHeaders,
  gc,
  noteUrls,
  fileUrlsFor,
  noteFn,
  fnFor,
  _store: store,
  _fn: fnStore,
}

/* 便于调试：只报「有几个主机、什么时间」，绝不吐凭据本身 */
module.exports.info = () => [...store].map(([host, v]) => ({ host, at: v.at, cookieLen: (v.cookie || '').length }))