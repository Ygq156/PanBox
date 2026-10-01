'use strict'

/**
 * 自定义解析接口 —— 让用户自己接一个「网盘解析站」。
 *
 * ## 为什么需要这个
 * PanBox 内置的解析器走的是「用**你自己的账号**登录 → 转存 → 取签名直链」。
 * 这条路拿到的速度上限就是你这个账号本身的档位（夸克 0.6–1.4 MB/s、百度 0.1 MB/s），
 * 服务端按账号限速，客户端再怎么加线程都没用——这是实测过的结论。
 *
 * 而市面上有一类「解析站」：你把分享链接发过去，它用自己的（通常是 SVIP）账号
 * 取出一条直链还给你。这条直链的限速档位是**它的**账号，不是你的，所以能跑满。
 * Motrix / Gopeed 这类下载器之所以「不用登录还能跑满」，走的正是这条路——
 * 下载器本身不解析，解析在别人的服务器上。
 *
 * 本模块就是那个「把分享链接转发给一个用户自备的接口，再把拿到的直链交给 aria2」的适配层。
 * **PanBox 不内置、也不推荐任何具体解析站**，接口地址完全由用户提供，
 * 性质等同于浏览器允许用户访问任意网站。请自行确认所用服务的合规性。
 *
 * ## 接口契约（尽量宽容，常见形状都认）
 * 请求：`GET|POST <用户填的地址>`，地址与请求体里可用占位符：
 *   `{url}` 完整分享链接  `{pwd}` 提取码  `{shareId}` 分享 ID  `{netdisk}` 网盘代号
 * 响应：JSON。直链的常见字段会被自动识别
 *   （`url` / `dlink` / `download_url` / `downurl` / `link` / `direct_url` …），
 *   也支持数组形式（目录分享一次返回多个文件）。用户也可以显式指定 `field`（如 `data.url`）。
 */

const { req, detectNetdisk } = require('./util')

/**
 * 常见「直链」字段名，按优先级排列。
 * 末尾那几个（directLink / downLink / parserUrl …）是照着同类「解析站」常见的
 * 响应字段补的，例如：
 *   {code,msg,success,data:{shareKey,directLink,cacheHit,expires}}   ← /json/parser 风格
 *   {code,msg,data:{downLink,apiLink,cacheHitTotal,…}}               ← /v2/linkInfo 风格
 * 少了它们，这类接口返回的 JSON 会被当成「没找到下载直链」。
 * 注意 apiLink 在那种格式里不是下载地址，所以故意不收录。
 */
const LINK_KEYS = [
  'url',
  'dlink',
  'directLink',
  'directlink',
  'downLink',
  'downlink',
  'downloadLink',
  'downloadlink',
  'download_url',
  'downloadUrl',
  'downurl',
  'downUrl',
  'direct_url',
  'directUrl',
  'real_url',
  'realUrl',
  'realLink',
  'file_url',
  'fileUrl',
  'dl_url',
  'dlurl',
  'dlUrl',
  'parserUrl',
  'parser_url',
  'link',
  'src',
]

/** 常见「文件名」字段名 */
const NAME_KEYS = ['name', 'filename', 'file_name', 'fileName', 'server_filename', 'title', 'fs_name']

/** 常见「体积」字段名 */
const SIZE_KEYS = ['size', 'filesize', 'file_size', 'fileSize', 'length', 'total', 'total_size']

/** 接口自己的「成功」状态码（不同站不一样，宽进） */
const OK_CODES = new Set([0, 1, 200, 2000, '0', '1', '200', '2000', 'ok', 'success'])

const MAX_FILES = 200

function firstOf(obj, keys) {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function toSize(v) {
  if (typeof v === 'number' && isFinite(v)) return v
  const m = String(v == null ? '' : v).trim().match(/^([\d.]+)\s*([KMGTP]?)B?$/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!isFinite(n)) return 0
  const unit = (m[2] || '').toUpperCase()
  return Math.round(n * ({ '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }[unit] || 1))
}

/** 支持 `data.url` / `data.list[0].url` 这种点号+下标路径 */
function pickByPath(root, path) {
  if (!path) return undefined
  let cur = root
  for (const seg of String(path).split('.')) {
    if (cur === undefined || cur === null) return undefined
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg)
    if (!m) return undefined
    if (m[1]) cur = cur[m[1]]
    for (const i of m[2].match(/\d+/g) || []) {
      if (cur === undefined || cur === null) return undefined
      cur = cur[Number(i)]
    }
  }
  return cur
}

/**
 * 在响应里把所有「带直链的文件」捞出来。
 * 深度优先、最多 6 层，遇到一个含直链字段的对象就收下并不再往里钻。
 */
function scan(node, depth, out, seen) {
  if (node === null || node === undefined || depth > 6 || out.length >= MAX_FILES) return
  if (Array.isArray(node)) {
    for (const it of node) scan(it, depth + 1, out, seen)
    return
  }
  if (typeof node !== 'object') return
  const link = firstOf(node, LINK_KEYS)
  if (typeof link === 'string' && /^https?:\/\//i.test(link)) {
    if (!seen.has(link)) {
      seen.add(link)
      out.push({ url: link, name: firstOf(node, NAME_KEYS), size: toSize(firstOf(node, SIZE_KEYS)) })
    }
    return
  }
  for (const v of Object.values(node)) scan(v, depth + 1, out, seen)
}

/** 接口自己的错误码：存在 code/status 且明显不是成功值时抛出来，别让用户对着「没有直链」猜。 */
function checkCode(j, ep) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return
  const code = firstOf(j, ['code', 'status', 'errno', 'ret', 'result_code'])
  if (code === undefined) return
  if (OK_CODES.has(code)) return
  const msg = firstOf(j, ['msg', 'message', 'error', 'errmsg', 'info', 'error_description', 'show_msg'])
  throw new Error(`接口返回失败（code=${code}${msg ? '：' + String(msg).slice(0, 120) : ''}）`)
}

/** 用占位符渲染模板；`encode` 为真时把值做 URL 编码（地址里用） */
function fill(tpl, vars, encode) {
  return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (_m, k) => {
    const v = vars[k]
    if (v === undefined || v === null) return ''
    return encode ? encodeURIComponent(String(v)) : String(v)
  })
}

/** 把可能是 JSON 字符串的字段（请求头/下载头）解析成对象 */
function asObject(v) {
  if (!v) return {}
  if (typeof v === 'object') return v
  try {
    const o = JSON.parse(String(v))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

function shareIdOf(url) {
  const m = String(url || '').match(/\/(?:s|surl)\/([0-9a-zA-Z_-]+)/)
  if (m) return m[1]
  const m2 = String(url || '').match(/[?&](?:surl|shareid|share_id|surl)=([0-9a-zA-Z_-]+)/)
  return m2 ? m2[1] : ''
}

/** 这个接口是否适用于这条链接 */
function applies(ep, netdisk) {
  if (!ep || ep.enabled === false || !ep.url) return false
  const list = Array.isArray(ep.netdisks) ? ep.netdisks.filter(Boolean) : []
  /* 直链（普通 http 文件）永远不往解析接口送 —— 那本来就能直接下，
   * 送过去只会把一个能用的链接弄坏。除非用户明确勾了「直链」。 */
  if (netdisk === 'direct') return list.includes('direct') || list.includes('*')
  if (!list.length) return true // 留空 = 所有网盘
  return list.includes('*') || list.includes(netdisk)
}

/** 挑出所有适用于这条链接、且启用中的接口（按用户在设置里的顺序） */
function matchEndpoints(endpoints, url) {
  const netdisk = detectNetdisk(url)
  return (Array.isArray(endpoints) ? endpoints : []).filter((ep) => applies(ep, netdisk))
}

async function callOne(ep, url, ctx) {
  const vars = {
    url,
    pwd: ctx.password || '',
    shareId: shareIdOf(url),
    netdisk: detectNetdisk(url),
  }
  const target = fill(ep.url, vars, true)
  const method = String(ep.method || 'GET').toUpperCase()
  const headers = { ...asObject(ep.headers) }
  let body
  if (method === 'POST') {
    body = fill(ep.body || 'url={url}&pwd={pwd}', vars, false)
    const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
    if (!hasCt) headers['Content-Type'] = ep.contentType || 'application/x-www-form-urlencoded'
  }

  const r = await req(target, {
    method,
    headers,
    body,
    timeout: 30000,
    redirect: 'follow',
    /* 解析接口的地址是**用户自己**填的：本机跑一个 alist / 自建解析接口是常见用法，
     * 所以要放行本机/内网地址（默认放行；用户想收紧可以在接口配置里写 allowLocal:false）。
     * 真正要防的是「远端响应决定下一跳」—— 那些地方在 parsers/util.js 的 assertOutbound()
     * 和 segmentDownloader 的入参校验里，没有这个豁免。 */
    allowLocal: ep.allowLocal !== false,
  })

  /* 有些接口直接 302 到直链 */
  if (r.location && /^https?:\/\//i.test(r.location)) {
    return { files: [{ url: r.location, name: '', size: 0 }], title: '' }
  }

  let j
  try {
    j = JSON.parse(r.text)
  } catch {
    const hint = String(r.text || '')
      .replace(/\s+/g, ' ')
      .slice(0, 160)
    throw new Error(`接口没有返回 JSON（HTTP ${r.status}）：${hint || '(空响应)'}`)
  }

  checkCode(j, ep)

  /* 用户显式指定了字段就只认那个字段，否则自动扫描 */
  let files = []
  if (ep.field) {
    const v = pickByPath(j, ep.field)
    if (Array.isArray(v)) {
      files = v
        .map((it) => ({
          url: typeof it === 'string' ? it : (firstOf(it || {}, LINK_KEYS) || ''),
          name: typeof it === 'object' && it ? firstOf(it, NAME_KEYS) : '',
          size: typeof it === 'object' && it ? toSize(firstOf(it, SIZE_KEYS)) : 0,
        }))
        .filter((x) => /^https?:\/\//i.test(String(x.url)))
    } else if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
      files = [{ url: v, name: String(firstOf(j, NAME_KEYS) || ''), size: toSize(firstOf(j, SIZE_KEYS)) }]
    }
  } else {
    const seen = new Set([target])
    scan(j, 0, files, seen)
  }

  if (!files.length) {
    throw new Error(`接口响应里没找到下载直链（HTTP ${r.status}）：${JSON.stringify(j).slice(0, 200)}`)
  }
  const title = String(firstOf(j, NAME_KEYS) || firstOf((j && j.data) || {}, NAME_KEYS) || '')
  if (!title && files.length === 1) files[0].name = files[0].name || ''
  return { files, title }
}

/**
 * 把分享链接交给用户配置的解析接口。
 * @param {string} url 分享链接
 * @param {{password?:string, endpoints?:Array, userAgent?:string}} ctx
 */
async function open(url, ctx = {}) {
  const eps = matchEndpoints(ctx.endpoints, url)
  if (!eps.length) {
    const e = new Error('没有配置可用的自定义解析接口')
    e.notApplicable = true
    throw e
  }
  const errs = []
  for (const ep of eps) {
    const label = ep.name || ep.url
    try {
      const out = await callOne(ep, url, ctx)
      const netdisk = detectNetdisk(url)
      const dlHeaders = { ...asObject(ep.dlHeaders) }
      if (!Object.keys(dlHeaders).some((k) => k.toLowerCase() === 'user-agent')) {
        dlHeaders['User-Agent'] = ctx.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
      const entries = out.files.map((f, i) => ({
        name: String(f.name || '').trim() || `解析返回的文件 ${i + 1}`,
        url: f.url,
        size: f.size || 0,
      }))
      return {
        shareId: shareIdOf(url),
        title: out.title || entries[0].name || '自定义解析',
        netdisk,
        /** 标记「这条直链来自自定义接口」：下载时**不要**再套百度的单线程限制 */
        viaEndpoint: true,
        endpointName: ep.name || ep.url,
        files: entries.map((e, i) => ({
          id: String(i),
          name: e.name,
          size: e.size,
          isDir: false,
          dir: '',
          url: e.url,
          headers: dlHeaders,
        })),
        resolveMany: async (list) => {
          const out2 = []
          for (const x of list) {
            const idx = Number(x && x.id !== undefined ? x.id : x.fid)
            const e = entries[idx]
            if (!e) continue
            out2.push({ entry: { name: (x && x.name) || e.name }, url: e.url, headers: dlHeaders })
          }
          return out2
        },
        resolve: async (id) => {
          const e = entries[Number(id)]
          if (!e) throw new Error('文件索引无效')
          return { url: e.url, headers: dlHeaders, viaEndpoint: true }
        },
        removeTransferred: null,
      }
    } catch (e) {
      errs.push(`${label} → ${e && e.message ? e.message : String(e)}`)
    }
  }
  throw new Error('自定义解析接口都失败了：' + errs.join('；'))
}

module.exports = { open, matchEndpoints, shareIdOf, pickByPath, scan, fill, LINK_KEYS, NAME_KEYS, SIZE_KEYS }
