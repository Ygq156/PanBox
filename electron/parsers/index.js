'use strict'

const crypto = require('node:crypto')
const { detectNetdisk, extractUrls, extractPassword } = require('./util')

const direct = require('./direct')
const lanzou = require('./lanzou')
const ilanzou = require('./ilanzou')
const quark = require('./quark')
const uc = require('./uc')
const pan123 = require('./pan123')
const baidu = require('./baidu')
const xunlei = require('./xunlei')
const custom = require('./custom')

const PARSERS = {
  direct,
  lanzou,
  ilanzou,
  quark,
  uc,
  '123pan': pan123,
  baidu,
  xunlei,
  /** 用户自备的「网盘解析站」适配层（见 custom.js 顶部注释） */
  custom,
}

/** 会话缓存：解析出来的目录树和「取直链」闭包留在主进程，渲染层只拿到可序列化的部分 */
const sessions = new Map()
/** sessionId -> { netdisk, session, createdAt }：下载完成后要回收的「转存副本」 */
const recycler = new Map()
const SESSION_TTL = 30 * 60 * 1000
/** 会话：30 分钟没用就丢；回收器：留着等长下载收尾，但也不能无限攒 */
const SESSION_MAX = 500
const RECYCLER_TTL = 90 * 60 * 1000
const RECYCLER_MAX = 500

function gc() {
  const now = Date.now()
  for (const [k, v] of sessions) if (now - v.createdAt > SESSION_TTL) sessions.delete(k)
  /* 回收器以前**永远不清理**：每点一次下载就多一条，闭包还攥着整个文件树，
   * 长时间挂着的实例内存只涨不落。这里给它一个 TTL 与条数上限。
   * 只丢「会话已经没了、而且已经放过很久」的条目：还在会话里的那条要留着，
   * 用户点「换直链」时才算得出新的回收时机。 */
  for (const [k, v] of recycler) {
    if (!sessions.has(k) && now - (v.createdAt || 0) > RECYCLER_TTL) recycler.delete(k)
  }
  if (recycler.size > RECYCLER_MAX) {
    const oldest = [...recycler.entries()]
      .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
      .slice(0, recycler.size - RECYCLER_MAX)
    for (const [k] of oldest) recycler.delete(k)
  }
  /* 会话同样防一手：正常用不会攒到 500（每次解析 GC 一次），
   * 但批量粘贴几百条链接时别让 Map 无限涨。 */
  if (sessions.size > SESSION_MAX) {
    const oldest = [...sessions.entries()]
      .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
      .slice(0, sessions.size - SESSION_MAX)
    for (const [k] of oldest) sessions.delete(k)
  }
}

/* 已经认得出域名、但**没有实现**解析器的网盘。
 * 必须在这里显式拦掉，否则会被下面的「兜底当直链」分支接手，
 * 拿分享页 URL 去 HEAD 一番，给用户一个莫名其妙的结果。 */
const KNOWN_UNSUPPORTED = {
  aliyun: '阿里云盘',
  tianyi: '天翼云盘',
  yidong: '移动云盘',
  pan115: '115 网盘',
  weiyun: '腾讯微云',
}

function pickParser(url) {
  const nd = detectNetdisk(url)
  const p = PARSERS[nd]
  if (p) return { parser: p, netdisk: nd }
  if (KNOWN_UNSUPPORTED[nd]) return { parser: null, netdisk: nd, unsupported: KNOWN_UNSUPPORTED[nd] }
  // 兜底：直接当直链
  if (/^https?:\/\//i.test(url)) return { parser: direct, netdisk: 'direct' }
  return null
}

/**
 * 解析一段文本中的**所有**分享链接（支持一行一个批量粘贴）。
 * 每条链接各返回一个结果；成功的会写入会话缓存，供下载时换直链。
 */
async function parseShare({ text, password, settings }) {
  gc()
  const urls = extractUrls(text)
  if (!urls.length) {
    return {
      results: [
        { ok: false, netdisk: 'unknown', files: [], message: '没有检测到任何 http(s) 链接' },
      ],
    }
  }
  const pwd = (password || extractPassword(text) || '').trim()
  const cfg = settings || {}
  const cookies = cfg.cookies || {}
  const results = []

  for (const url of urls) {
    const t = Date.now()
    const hit = pickParser(url)
    if (hit && hit.unsupported) {
      results.push({
        ok: false,
        netdisk: 'unknown',
        files: [],
        source: url,
        message: `暂不支持${hit.unsupported}：这个网盘的解析器还没实现（本项目当前支持蓝奏云 / 蓝奏优享 / 夸克 / UC / 百度 / 迅雷 / 123云盘 / 直链）。`,
      })
      continue
    }
    if (!hit) {
      results.push({ ok: false, netdisk: 'unknown', files: [], source: url, message: `不支持的链接：${url}` })
      continue
    }
    const { parser, netdisk } = hit
    const ctx = {
      password: pwd,
      cookie: cookies[netdisk],
      userAgent: cfg.userAgent,
      endpoints: cfg.parseEndpoints || [],
    }
    /* 用户为这个网盘配了「解析接口」就**优先**用它：内置解析虽然也能成，但拿到的是
     * 用户自己账号档位的直链（夸克 0.6–1.4 MB/s、百度 0.1 MB/s），而配接口的目的
     * 恰恰是要绕开这个档位。接口失败就退回内置解析，别让用户两手空空。 */
    const viaEps = custom.matchEndpoints(ctx.endpoints, url)
    try {
      let open = null
      let via = ''
      let endpointError = ''
      if (viaEps.length) {
        try {
          open = await custom.open(url, ctx)
          via = open.endpointName || viaEps[0].name || viaEps[0].url
        } catch (e) {
          endpointError = e && e.message ? e.message : String(e)
          open = null
        }
      }
      if (!open) open = await parser.open(url, ctx)
      const sessionId = crypto.randomUUID()
      sessions.set(sessionId, { ...open, netdisk, source: url, createdAt: Date.now() })
      results.push({
        ok: true,
        netdisk,
        shareId: open.shareId,
        title: open.title,
        sessionId,
        source: url,
        files: open.files,
        elapsed: Date.now() - t,
        viaEndpoint: !!(via || open.viaEndpoint),
        endpointName: via || open.endpointName || undefined,
        endpointError: endpointError || undefined,
      })
    } catch (e) {
      results.push({
        ok: false,
        netdisk,
        files: [],
        source: url,
        message: e && e.message ? e.message : String(e),
        needPassword: !!(e && e.needPassword),
        needCookie: !!(e && e.needCookie),
        elapsed: Date.now() - t,
      })
    }
  }
  return { results }
}

/**
 * 把「批量解析」的结果按文件名索引成「一个名字最多对应一条结果」。
 * 同名文件在网盘分享里很常见（`第01集.mp4` 放两个目录、`data.bin` 重名…），
 * 以前这里直接 `new Map(名字 -> 结果)`，重名时后者覆盖前者，于是**同一份直链被发给了两个
 * 不同的 id** —— UI 上看不出任何异常，用户却会拿到两个内容相同的文件（其中一个压根不是他要的）。
 * 现在重名一律不给结果，调用方会退回逐条解析（按 id 精确取），宁可多一轮 API 也不下错文件。
 */
function indexResolved(got) {
  const seen = new Map()
  const dup = new Set()
  for (const g of got || []) {
    const n = g && g.entry ? g.entry.name : undefined
    if (n === undefined || n === null) continue
    if (seen.has(n)) dup.add(n)
    else seen.set(n, g)
  }
  for (const n of dup) seen.delete(n)
  return seen
}

/** 把会话里的文件解析成直链（有批量能力的解析器一次算完，省一轮 API / 少触发风控） */
async function resolveFiles({ sessionId, ids }) {
  const s = sessions.get(sessionId)
  if (!s) throw new Error('解析会话已过期，请重新解析链接')
  /* 「用过了」就续命：长下载期间用户点「换直链」、或过一会儿再下第二个文件，
   * 都不该因为首次解析已经过了 30 分钟就回「解析会话已过期」。 */
  s.createdAt = Date.now()
  const wanted = []
  for (const id of ids) {
    const meta = s.files.find((f) => f.id === String(id))
    if (meta) wanted.push(meta)
  }
  if (!wanted.length) return []

  const out = []
  /* 来自「自定义解析接口」的直链：下载时**不能**再套百度那套单线程限制——
   * 用户配接口就是为了跑满带宽，限成单线程等于白配。 */
  const viaEndpoint = !!s.viaEndpoint
  const done = new Set()
  if (typeof s.resolveMany === 'function') {
    const got = await s.resolveMany(wanted.map((m) => ({ id: m.id, name: m.name })))
    const byName = indexResolved(got)
    for (const m of wanted) {
      const g = byName.get(m.name)
      if (!g) continue
      done.add(String(m.id))
      out.push({
        id: String(m.id),
        name: m.name,
        dir: m.dir || '',
        size: m.size || 0,
        url: g.url,
        headers: g.headers || {},
        viaEndpoint: viaEndpoint || !!g.viaEndpoint,
      })
    }
  }

  /* 批量没覆盖到的（解析器不给批量、或重名没法唯一定位）就逐条按 id 取：
   * id 是索引，一定指得准，这样既不误配也不会漏文件。 */
  for (const m of wanted) {
    if (done.has(String(m.id))) continue
    const r = await s.resolve(String(m.id))
    out.push({
      id: String(m.id),
      name: m.name,
      dir: m.dir || '',
      size: m.size || 0,
      url: r.url,
      headers: r.headers || {},
      viaEndpoint: viaEndpoint || !!(r && r.viaEndpoint),
    })
  }
  /* 夸克/UC/迅雷/百度的「转存」会在用户自己的网盘里留一份整文件拷贝。
   * 登记一个回收器，等 aria2 报 complete 后由主进程触发删除，
   * 否则每下一次同一个分享就多一个 `xxx(1).zip`（实测已把网盘塞了 6 份）。
   * 每次取直链都重登一次（带新时间戳）：长下载会被反复刷新，不会被 gc 当成陈旧条目丢掉。 */
  if (out.length && typeof s.removeTransferred === 'function') {
    recycler.set(sessionId, { netdisk: s.netdisk, session: s, createdAt: Date.now() })
  }
  return out
}

/**
 * 主动丢掉一条解析会话：渲染层把某条解析结果从界面上删掉时调用。
 * 不调用也不会错（gc 会按 TTL 清），但它能立刻释放主进程里缓存的目录树与闭包。
 * ⚠️ **不动 recycler**：界面上的解析结果正是「点开始下载」那一刻收走的，此时
 * recycler 里已经登记了这次下载产生的转存副本，必须留着让下载完成后能删掉它。
 * 副本的回收只由 downloads:remove / before-quit / cleanupDownloaded 负责。
 */
function dropSession(sessionId) {
  const s = sessions.get(sessionId)
  if (s && typeof s.dispose === 'function') {
    try {
      s.dispose()
    } catch {
      /* ignore */
    }
  }
  sessions.delete(sessionId)
}

/**
 * 下载完成后回收「转存」在用户自己网盘里留下的副本。
 * 用独立的 recycler 而不是 sessions，是因为长下载可能超过会话的 30 分钟 TTL。
 */
async function cleanupDownloaded(sessionId) {
  const r = recycler.get(sessionId)
  if (!r) return false
  recycler.delete(sessionId)
  try {
    return await r.session.removeTransferred()
  } catch {
    return false
  }
}

module.exports = { parseShare, resolveFiles, dropSession, cleanupDownloaded, PARSERS, indexResolved, _maps: { sessions, recycler } }
