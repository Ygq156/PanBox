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

const AJAX_FALLBACK_ORIGINS = [
  'https://apifile.lanzouw.com',
  'https://w1.lanzn.com',
  'https://www.lanzoux.com',
  'https://wwww.lanzoux.com',
]

/* ------------------------------------------------------------------ */
/* 请求头                                                              */
/* ------------------------------------------------------------------ */

function pageHeaders(referer) {
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
  return h
}

function jsonAjaxHeaders(referer, origin) {
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
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': UA_PC_CHROME,
    'X-Requested-With': 'XMLHttpRequest',
  }
  if (referer) h.Referer = referer
  if (origin) h.Origin = origin
  return h
}

function folderHeaders(referer) {
  return {
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

function computeSize(html) {
  return humanSizeToBytes(decodeEntities(firstGroup(P_FI_SIZE, html).trim()))
}

async function fetchPage(jar, url, referer) {
  return withArg1Retry(() => req(url, { headers: pageHeaders(referer), jar, timeout: 25000 }), jar)
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
    try {
      r = await withArg1Retry(
        () =>
          req(origin + call.path, {
            method: 'POST',
            headers: jsonAjaxHeaders(referer || pageUrl, origin),
            body: form(call.data),
            jar,
          }),
        jar,
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

async function verifyAjax(jar, downUrl, origin, html, attempt) {
  const file = firstGroup(P_VERIFY_FILE, html)
  const sign = firstGroup(P_VERIFY_SIGN, html)
  if (!file || !sign) throw new Error('蓝奏验证页缺少 file/sign 参数')

  await sleep(attempt === 0 ? 2200 : 2000)
  const r = await req(origin + '/file/ajax.php', {
    method: 'POST',
    headers: jsonAjaxHeaders(downUrl, origin),
    body: form({ file, el: '2', sign }),
    jar,
    timeout: 25000,
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
    const fresh = await req(downUrl, { headers: pageHeaders(origin + '/'), jar, redirect: 'manual' })
    if (isDirectLink(fresh.location)) return fresh.location
    if (hasChallenge(fresh.text)) {
      const a = extractArg1(fresh.text)
      if (a) {
        jar.set('acw_sc__v2', acwScV2(a))
        return followFileUrl(jar, downUrl, true)
      }
    }
    if (fresh.text && fresh.text.includes('down_r')) {
      return verifyAjax(jar, downUrl, origin, fresh.text, attempt + 1)
    }
  }
  throw new Error('蓝奏二次验证未拿到直链（分享可能已过期或触发风控）')
}

async function followFileUrl(jar, downUrl, retried = false) {
  const origin = new URL(downUrl).origin
  jar.set('down_ip', '1')

  const r = await req(downUrl, {
    headers: pageHeaders(origin + '/'),
    jar,
    redirect: 'manual',
    timeout: 25000,
  })

  if (isDirectLink(r.location)) return r.location

  const html = r.text || ''
  if (hasChallenge(html)) {
    if (retried) throw new Error('蓝奏下载域反爬校验失败，请稍后重试')
    const a = extractArg1(html)
    if (!a) throw new Error('蓝奏下载域挑战页异常')
    jar.set('acw_sc__v2', acwScV2(a))
    return followFileUrl(jar, downUrl, true)
  }
  if (html.includes('down_r') && html.includes('ajax.php')) {
    return verifyAjax(jar, downUrl, origin, html, 0)
  }
  throw new Error('蓝奏下载域未返回直链（分享可能已失效）')
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
    headers: folderHeaders(shareUrl),
    body: form(data),
    jar,
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
      const cdn = await followFileUrl(jar, downUrl)
      return {
        url: cdn,
        headers: { 'User-Agent': UA_PC_CHROME, Referer: origin + '/' },
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
  const jar = new Jar(ctx.cookie)

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

module.exports = { open, acwScV2 }
