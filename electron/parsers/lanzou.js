'use strict'

/**
 * 蓝奏云 / 蓝奏云优享解析器。
 *
 * 规格来源：qaiu/netdisk-fast-download (MIT) 的 `LzTool.java` + `AcwScV2Generator.java`。
 * 2025 年起蓝奏云加了两道新关卡，缺任一步都只能拿到「验证并下载」HTML：
 *   1. 全站 ESA 反爬：页面带 `var arg1='...'`，必须算出 `acw_sc__v2` cookie 后重放请求
 *   2. 下载域二次验证：`{dom}/file/{url}` 返回验证页，需等约 2.2s 再 POST `{origin}/file/ajax.php`
 *      才能换到真正的 CDN 直链；过早提交只会得到 `url=?SignError`
 */

const { req, form, sleep, decodeEntities, humanSizeToBytes, Jar, UA_PC_CHROME, UA_MOBILE_ANDROID } = require('./util')
const { withArg1Retry, hasChallenge, extractArg1, acwScV2 } = require('./esa')
const browserCtx = require('./browserCtx')

const SHARE_RE =
  /^https?:\/\/(?:[a-zA-Z\d-]+\.)?(?:(?:lanzou[bcefghijklmopqtuvwxy]|lanzn|lanzv|lanosso|lanpv|lanwp|bakstotre|ulanzou|woozooo|dmpdmp|lanrar|webgetstore)\.com|t-is\.cn)\/(.+)$/i

const IFRAME_FN = /src\s*=\s*["'](\/fn\?[^"'\s>]+)["']/i
const P_WP_SIGN = /wp_sign\s*=\s*'([^']+)'/
const P_AJAXDATA = /ajaxdata\s*=\s*'([^']+)'/
const P_WEBSIGN = /'websign'\s*:\s*'([^']*)'/
const P_SIGN_ALL = /'sign'\s*:\s*'([^']+)'/g
const P_ISNGIS_ALL = /var\s+isngis\s*=\s*'([^']+)'/g
const P_VERIFY_FILE = /'file'\s*:\s*'([^']+)'/
const P_VERIFY_SIGN = /'sign'\s*:\s*'([^']+)'/
const P_OFF_MSG = /class="off1"><\/div>\s*<\/div>\s*([^<]{2,80})</
const P_AJAX_ABSOLUTE = /['"]((?:https?:)?\/\/[^'"\s<>]+\/ajax(?:m|file)\.php\?file=\d+)['"]/i
const P_AJAX_PATH = /(?:['"/]|^)(ajax(?:m|file)\.php\?file=\d+)/
const P_FI_NAME =
  /padding: 56px 0px 20px 0px;">(.*?)<|filenajax">(.*?)<|class="b"><span>(.*?)<\/span>/
const P_FI_SIZE =
  />文件大小：<\/span>(.*?)<br>|"n_filesize">大小：(.*?)<\/div>|文件大小：<\/div><div class="fileinforight">(.*?)<\/div>/
const P_TITLE = /<title>([\s\S]*?)<\/title>/i
const P_FILEMORE = /url\s*:\s*'(\/filemoreajax\.php\?file=\d+)'[\s\S]*?data\s*:\s*\{([^}]+)\}/

/* 下载域可以直接把文件本体回给你（实测用户那条 CDN 链接就是：200 +
 * `application/octet-stream` + 38MB 正文）。`util.req` 现在会**全局**识别这种
 * 「二进制本体」并丢掉正文（不读、也不撞 8MB 上限），这里只据此收下直链。
 * 反过来说，下载域那两种**真页面**（验证页 `down_r` + ajax.php、反爬挑战页）
 * 是 text/html，照旧读出来，所以不能一律不读。 */
function isFileResponse(r) {
  if (!r) return false
  if (r.isBinary) return true
  const cd = String(r.headers.get('content-disposition') || '')
  if (/attachment/i.test(cd)) return true
  const ct = String(r.headers.get('content-type') || '')
  return !!ct && !/^(?:text\/|application\/(?:xhtml\+xml|json|javascript|xml))/i.test(ct)
}

const AJAX_FALLBACK_ORIGINS = [
  'https://apifile.woozooo.com',
  'https://apifile.lanzouw.com',
  'https://w1.lanzn.com',
  'https://www.lanzoux.com',
  'https://wwww.lanzoux.com',
]

/* 只给 test/ 下的假站点用（本地 HTTP）。产品路径永远是 false —— 解析接口不许打内网。 */
let ALLOW_LOCAL = false

/* ------------------------------------------------------------------ */
/* 请求头                                                              */
/* ------------------------------------------------------------------ */

/* 下面三个 h() 都多接一个 url：挂了浏览器现场时（用户在插件里点了「把本页交给
 * PanBox」），把「真 UA / 真 Referer / 真 Accept 那一组」换进去 —— 反爬站点认的
 * 就是这个。没现场时完全按原样，行为与以前一致。 */
function pageHeaders(referer, url) {
  const h = {
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'max-age=0',
    DNT: '1',
    'Sec-CH-UA': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': UA_PC_CHROME,
  }
  if (referer) h.Referer = referer
  return url ? browserCtx.headersFor(h, url, referer) : h
}

function jsonAjaxHeaders(referer, origin, url) {
  const h = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/x-www-form-urlencoded',
    Pragma: 'no-cache',
    'Sec-CH-UA': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    /* 接口常换到另一台主机（apifile.woozooo.com），那时浏览器填的是 cross-site
     * 而不是 same-origin —— 写死了反而和真实请求不一样。 */
    'Sec-Fetch-Site': referer && origin && safeOrigin(referer) === origin ? 'same-origin' : 'cross-site',
    'User-Agent': UA_PC_CHROME,
    'X-Requested-With': 'XMLHttpRequest',
  }
  if (referer) h.Referer = referer
  if (origin) h.Origin = origin
  return url ? browserCtx.headersFor(h, url, referer) : h
}

function folderHeaders(referer, url) {
  const h = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Encoding': 'identity',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA_MOBILE_ANDROID,
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': 'Android',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: referer,
  }
  return url ? browserCtx.headersFor(h, url, referer) : h
}

/* 下直链时用的头：优先用浏览器现场那份 UA / Referer（CDN 有时也认这个） */
function cdnHeaders(url, fallbackReferer) {
  const h = { 'User-Agent': UA_PC_CHROME, Referer: fallbackReferer }
  return browserCtx.headersFor(h, url, fallbackReferer)
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function firstGroup(re, text) {
  const m = re.exec(String(text || ''))
  if (!m) return ''
  for (let i = 1; i < m.length; i++) if (m[i]) return m[i]
  return ''
}

function normalizeDom(dom) {
  let d = String(dom || '').trim()
  if (!d) return 'https://developer.lanzoug.com'
  if (d.startsWith('//')) d = 'https:' + d
  if (!/^https?:\/\//i.test(d)) d = 'https://' + d
  return d.replace(/\/+$/, '')
}

function isDirectLink(u) {
  return /^https?:\/\//i.test(String(u || '')) && !/SignError/i.test(String(u))
}

function matchShare(url) {
  const m = SHARE_RE.exec(String(url || '').trim())
  if (!m) return null
  return { key: m[1].replace(/[?#].*$/, ''), url: String(url).trim() }
}

function isFolderShare(key, html) {
  if (/^s\//i.test(key)) return true
  if (/^b[a-z0-9]+$/i.test(key) && !key.includes('/')) return true
  return /filemoreajax/.test(String(html || ''))
}

function computeName(html) {
  const raw = firstGroup(P_FI_NAME, html)
  return decodeEntities(raw.replace(/<[^>]*>/g, '').trim())
}

/** 取地址的源（用来判断「这次请求是不是打回分享页自己那台主机」） */
function safeOrigin(u) {
  try {
    return new URL(String(u)).origin
  } catch {
    return ''
  }
}

function computeSize(html) {
  return humanSizeToBytes(decodeEntities(firstGroup(P_FI_SIZE, html).trim()))
}

async function fetchPage(jar, url, referer) {
  return withArg1Retry(
    () => req(url, { headers: pageHeaders(referer, url), jar, timeout: 25000, allowLocal: ALLOW_LOCAL }),
    jar,
    { url, cookieFromContext: browserCtx.owns(url) },
  )
}

/* ------------------------------------------------------------------ */
/* 文件信息 → 直链（ajaxm.php / ajaxfile.php）                          */
/* ------------------------------------------------------------------ */

function fileAjaxTarget(html) {
  const abs = P_AJAX_ABSOLUTE.exec(String(html || ''))
  if (abs) {
    let t = abs[1]
    if (t.startsWith('//')) t = 'https:' + t
    return { target: t, absolute: t }
  }
  const rel = P_AJAX_PATH.exec(String(html || ''))
  if (rel) return { target: '/' + rel[1], absolute: null }
  return null
}

function ajaxOrigins(pageUrl, absolute) {
  const out = []
  if (absolute) {
    try {
      out.push(new URL(absolute).origin)
    } catch {
      /* ignore */
    }
  }
  try {
    const o = new URL(pageUrl).origin
    if (!out.includes(o)) out.push(o)
  } catch {
    /* ignore */
  }
  for (const o of AJAX_FALLBACK_ORIGINS) if (!out.includes(o)) out.push(o)
  return out
}

/** 从页面 HTML 里抽出 downprocess 的表单参数（三条分支，逐字照搬 LzTool） */
function extractAjaxFromHtml(html, pwd) {
  if (!html) return null
  const found = fileAjaxTarget(html)
  if (!found) return null
  const ajaxPath = found.absolute ? new URL(found.absolute).pathname + new URL(found.absolute).search : found.target
  const data = { action: 'downprocess' }

  const wp = P_WP_SIGN.exec(html)
  const ad = P_AJAXDATA.exec(html)
  let lastIsngis = null
  let m
  P_ISNGIS_ALL.lastIndex = 0
  while ((m = P_ISNGIS_ALL.exec(html))) if (m[1]) lastIsngis = m[1]

  if (wp) {
    data.sign = wp[1]
    if (ad) {
      data.websignkey = ad[1]
      data.signs = ad[1]
    }
    data.websign = firstGroup(P_WEBSIGN, html)
    data.kd = '1'
    data.ves = '1'
    if (pwd) data.p = pwd
  } else if (lastIsngis) {
    data.sign = lastIsngis
    data.kd = '1'
    if (pwd) data.p = pwd
  } else {
    const signs = []
    P_SIGN_ALL.lastIndex = 0
    while ((m = P_SIGN_ALL.exec(html))) signs.push(m[1])
    if (!signs.length) return null
    data.sign = signs.length > 1 ? signs[1] : signs[0]
    if (pwd) data.p = pwd
    data.kd = '1'
    const ad2 = P_AJAXDATA.exec(html)
    if (ad2) {
      data.websignkey = ad2[1]
      data.signs = ad2[1]
    }
  }
  return { path: ajaxPath, data, absolute: found.absolute }
}

/** 依次尝试各 ajax 主机；连接失败或「已超时」换下一个（业务错误不换） */
async function postAjax(jar, pageUrl, call, referer) {
  const origins = ajaxOrigins(pageUrl, call.absolute)
  let lastErr = null
  for (const origin of origins) {
    let r
    const target = origin + call.path
    /* 接口主机与分享页同主机时直接用原来的罐；换到别的主机（如 apifile.woozooo.com）
     * 就换成那台主机自己的罐 —— 分享页的 cookie 不该跟着请求跑到第三方域去。 */
    const sameHost = origin === safeOrigin(pageUrl)
    const tJar = sameHost ? jar : browserCtx.jarFor(target, browserCtx.cookieFor(target))
    const tReferer = sameHost ? referer || pageUrl : pageUrl
    try {
      r = await withArg1Retry(
        () =>
          req(target, {
            method: 'POST',
            headers: jsonAjaxHeaders(tReferer, origin, target),
            body: form(call.data),
            jar: tJar,
            allowLocal: ALLOW_LOCAL,
          }),
        tJar,
        { url: target, cookieFromContext: !sameHost && browserCtx.owns(target) },
      )
    } catch (e) {
      lastErr = e
      continue
    }
    let json
    try {
      json = JSON.parse(r.text)
    } catch {
      lastErr = new Error(`蓝奏接口返回非 JSON：${String(r.text).slice(0, 80)}`)
      continue
    }
    const info = String(json.inf || '')
    if (String(json.zt) !== '1' && /已超时|timeout/i.test(info)) {
      lastErr = new Error(info)
      continue
    }
    return json
  }
  throw lastErr || new Error('蓝奏云所有 ajax 域名均失败')
}

/* ------------------------------------------------------------------ */
/* 直链 → CDN（2025 新增的二次验证）                                     */
/* ------------------------------------------------------------------ */

async function verifyAjax(jar, downUrl, origin, html, attempt, ref = '') {
  const file = firstGroup(P_VERIFY_FILE, html)
  const sign = firstGroup(P_VERIFY_SIGN, html)
  if (!file || !sign) throw new Error('蓝奏验证页缺少 file/sign 参数')

  await sleep(attempt === 0 ? 2200 : 2000)
  const r = await req(origin + '/file/ajax.php', {
    method: 'POST',
    headers: jsonAjaxHeaders(downUrl, origin, origin + '/file/ajax.php'),
    body: form({ file, el: '2', sign }),
    jar,
    timeout: 25000,
    allowLocal: ALLOW_LOCAL,
  })
  let json = null
  try {
    json = JSON.parse(r.text)
  } catch {
    /* 忽略，走下面的重试 */
  }
  const got = json && typeof json.url === 'string' ? json.url : ''
  if (isDirectLink(got)) return got

  if (attempt < 1) {
    // SignError / 请求失败都必须重新拉验证页换新 sign，复用旧 sign 必然再失败
    const fresh = await req(downUrl, { headers: pageHeaders(origin + '/', downUrl), jar, redirect: 'manual', allowLocal: ALLOW_LOCAL })
    if (isDirectLink(fresh.location)) return fresh.location
    /* 这一跳也可能直接被回文件本体（正文已被 req 丢掉），那就没得重试了 */
    if (fresh.status === 200 && isFileResponse(fresh)) return downUrl
    const freshHtml = fresh.text || ''
    if (hasChallenge(freshHtml)) {
      const a = extractArg1(freshHtml)
      if (a) {
        jar.set('acw_sc__v2', acwScV2(a))
        return followFileUrl(jar, downUrl, true, ref)
      }
    }
    if (freshHtml && freshHtml.includes('down_r')) {
      return verifyAjax(jar, downUrl, origin, freshHtml, attempt + 1, ref)
    }
  }
  /* 二次验证也没换来直链 —— 再试插件抓到的「浏览器真的下过的那条」 */
  const fromBrowser = await tryBrowserUrls(jar, downUrl, ref)
  if (fromBrowser) return fromBrowser
  throw new Error('蓝奏二次验证未拿到直链（分享可能已过期或触发风控）')
}

async function followFileUrl(jar, downUrl, retried = false, ref = '') {
  const origin = new URL(downUrl).origin
  jar.set('down_ip', '1')

  let r
  try {
    r = await req(downUrl, {
      headers: pageHeaders(origin + '/', downUrl),
      jar,
      redirect: 'manual',
      timeout: 25000,
      allowLocal: ALLOW_LOCAL,
    })
  } catch (e) {
    /* 下载域这台主机有时不写真话：正文是几十 MB 的文件本体，`Content-Type` 却报成
     * `text/html` / 干脆没有。这时 `req` 会按「网页太大」把它掐掉（防止把整个文件
     * 读进内存）。掐掉这件事本身就说明**这个地址上放的是文件，不是网页** ——
     * 在蓝奏这条链路上正好就是要找的直链，收下它，别再往上抛「响应体过大」。 */
    if (/响应体过大/.test((e && e.message) || '')) return downUrl
    throw e
  }

  if (isDirectLink(r.location)) return r.location
  /* 没有 Location，返回的又不是网页 —— 这个地址本身就是直链（正文已由 req 丢掉） */
  if (r.status === 200 && isFileResponse(r)) return downUrl
  const html = r.text || ''
  if (hasChallenge(html)) {
    if (retried) throw new Error('蓝奏下载域反爬校验失败，请稍后重试')
    const a = extractArg1(html)
    if (!a) throw new Error('蓝奏下载域挑战页异常')
    jar.set('acw_sc__v2', acwScV2(a))
    return followFileUrl(jar, downUrl, true, ref)
  }
  if (html.includes('down_r') && html.includes('ajax.php')) {
    return verifyAjax(jar, downUrl, origin, html, 0, ref)
  }
  /* 走到这里说明按页面推出来的地址没给直链（挑战、验证、换链都试过了）。
   * 那就试试**浏览器自己真的请求过**的那几条文件地址 —— 一次性签名的下载
   * 地址程序是推不出来的，只有浏览器点出来那一条能用。 */
  const fromBrowser = await tryBrowserUrls(jar, downUrl, ref)
  if (fromBrowser) return fromBrowser
  throw new Error('蓝奏下载域未返回直链（分享可能已失效）')
}

/**
 * 试插件交过来的「浏览器真的请求过的文件地址」。
 * 只认**响应就是文件本体**的那些，别的（json、页面）一律不认 —— 免得把
 * 一个接口地址当成直链交给下载引擎。找到第一条能用的就返回它。
 *
 * Referer 用**分享页**：浏览器当时就是从分享页点出去下这个文件的，CDN 认的
 * 是它；拿下载域自己的 origin 去请求，恰好在这类「链接只在浏览器里活着」的
 * 站点上会被回绝。
 */
async function tryBrowserUrls(jar, downUrl, fallbackReferer) {
  const list = browserCtx.fileUrlsFor(downUrl)
  for (const u of list.slice(0, 6)) {
    try {
      const r = await req(u, {
        headers: cdnHeaders(u, fallbackReferer || new URL(downUrl).origin + '/'),
        jar: browserCtx.jarFor(u),
        redirect: 'manual',
        timeout: 20000,
        allowLocal: ALLOW_LOCAL,
      })
      if (r.status === 200 && isFileResponse(r)) return r.location && isDirectLink(r.location) ? r.location : u
    } catch {
      /* 这条不行就试下一条 */
    }
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* 目录分享                                                             */
/* ------------------------------------------------------------------ */

async function listFolder(jar, shareUrl, html, pwd) {
  const origin = new URL(shareUrl).origin
  const block = P_FILEMORE.exec(html)
  if (!block) throw new Error('未能从目录分享页提取列表参数（页面结构可能已变）')

  const data = {}
  const kvRe = /'(\w+)'\s*:\s*('(?:\\'|[^'])*'|\d+|\w+)/g
  let kv
  while ((kv = kvRe.exec(block[2]))) {
    const k = kv[1]
    const raw = kv[2]
    if (k === 'pwd') {
      data.pwd = pwd || ''
      continue
    }
    if (k === 'pg' || k === 'pgs') {
      data.pg = '1'
      continue
    }
    if (raw.startsWith("'")) {
      data[k] = raw.slice(1, -1).replace(/\\'/g, "'")
      continue
    }
    if (/^\d+$/.test(raw)) {
      data[k] = raw
      continue
    }
    const m = new RegExp(`var\\s+${raw}\\s*=\\s*'([^']*)'`).exec(html)
    data[k] = m ? m[1] : raw === 'pgs' ? '1' : raw
  }
  if (!data.fid || !data.t || !data.k) throw new Error('目录列表缺少 fid/t/k 参数')
  if (pwd) data.pwd = pwd

  const r = await req(origin + block[1], {
    method: 'POST',
    headers: folderHeaders(shareUrl, origin + block[1]),
    body: form(data),
    jar,
    allowLocal: ALLOW_LOCAL,
  })
  let json
  try {
    json = JSON.parse(r.text)
  } catch {
    throw new Error(`目录列表返回非 JSON：${String(r.text).slice(0, 80)}`)
  }
  if (String(json.zt) !== '1') {
    const e = new Error(json.info || '目录列表获取失败（可能需要提取码）')
    if (/密码|提取码/.test(String(json.info || ''))) e.needPassword = true
    throw e
  }
  return (json.text || []).map((it) => ({
    id: String(it.id),
    name: decodeEntities(String(it.name_all || it.name || '')),
    size: humanSizeToBytes(it.size),
    isDir: /folder/i.test(String(it.icon || '')),
    dir: '',
  }))
}

/** 目录里的文件：拼回 `{origin}/{fileId}` 再走一遍普通文件分享流程 */
async function openFolderChild(jar, origin, fileId, pwd) {
  const url = `${origin}/${fileId}`
  const page = await fetchPage(jar, url, origin + '/')
  return openFileHtml(jar, url, page.text, pwd)
}

/* ------------------------------------------------------------------ */
/* 单文件分享                                                           */
/* ------------------------------------------------------------------ */

async function openFileHtml(jar, shareUrl, html, pwd) {
  const origin = new URL(shareUrl).origin
  let infoHtml = html
  let infoBase = shareUrl

  const ifr = IFRAME_FN.exec(html)
  if (ifr) {
    const iframeUrl = new URL(ifr[1], origin + '/').href
    const r = await fetchPage(jar, iframeUrl, shareUrl)
    infoHtml = r.text
    infoBase = iframeUrl
  } else if (/down_p|id=["']pwd["']/.test(html)) {
    if (!pwd) {
      const e = new Error('该分享需要提取码')
      e.needPassword = true
      throw e
    }
  } else {
    const off = P_OFF_MSG.exec(html)
    throw new Error(off ? off[1].trim() : '未找到下载入口，可能分享已失效或被风控拦截')
  }

  const call = extractAjaxFromHtml(infoHtml, ifr ? null : pwd)
  if (!call) throw new Error(pwd ? '密码错误或分享已失效' : '页面里未找到下载参数')

  const json = await postAjax(jar, infoBase, call, shareUrl)
  if (String(json.zt) !== '1') throw new Error(json.inf || '蓝奏云解析失败')

  const dom = normalizeDom(json.dom)
  const downUrl = `${dom}/file/${json.url}`
  const name = String(json.inf || computeName(html) || '蓝奏云文件')
  const size = computeSize(html)

  return {
    shareId: matchShare(shareUrl)?.key || '',
    title: name || computeName(html),
    files: [{ id: '0', name, size, isDir: false, dir: '' }],
    resolve: async () => {
      /* 脚本里那次「点下载」是从分享页点出去的，插件抓到的备选地址也一样按
       * 这个 Referer 重放 —— CDN 认的是分享页，不是下载域自己。 */
      const cdn = await followFileUrl(jar, downUrl, false, origin + '/')
      return {
        url: cdn,
        headers: cdnHeaders(cdn, origin + '/'),
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function open(url, ctx = {}) {
  const hit = matchShare(url)
  if (!hit) throw new Error('不是有效的蓝奏云分享链接')
  const pwd = String(ctx.password || '').trim()
  /* 插件交过来过「浏览器现场」时，用浏览器此刻真的在用的那份 cookie —— 站点
   * 的反爬认的就是它（挑战页自算的 cookie 会时灵时不灵）。 */
  const jar = browserCtx.jarFor(url, ctx.cookie)

  const shareUrl = hit.url
  const origin = new URL(shareUrl).origin
  const page = await fetchPage(jar, shareUrl, origin + '/')
  const html = page.text
  const title = decodeEntities(firstGroup(P_TITLE, html).replace(/<[^>]*>/g, '').trim()) || hit.key

  if (isFolderShare(hit.key, html)) {
    const files = await listFolder(jar, shareUrl, html, pwd)
    return {
      shareId: hit.key,
      title,
      files,
      resolve: async (id) => {
        const one = await openFolderChild(jar, origin, id, pwd)
        return one.resolve(id)
      },
    }
  }

  const one = await openFileHtml(jar, shareUrl, html, pwd)
  return { ...one, title: one.title || title }
}

/* `_internals` 只给 test/ 下的定点测试用（假站点带端口，进不了 SHARE_RE，没法走 open()；
 * `allowLocal` 也是给假站点用的，产品路径永远不开）。产品代码一律只用 open()。 */
module.exports = {
  open,
  acwScV2,
  _internals: { fetchPage, openFileHtml, followFileUrl, cdnHeaders, listFolder, setAllowLocal: (v) => { ALLOW_LOCAL = !!v } },
}
