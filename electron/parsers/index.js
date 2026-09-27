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

const PARSERS = {
  direct,
  lanzou,
  'lanzou-xy': ilanzou,
  ilanzou,
  quark,
  uc,
  '123pan': pan123,
  baidu,
  xunlei,
}

/** 会话缓存：解析出来的目录树和「取直链」闭包留在主进程，渲染层只拿到可序列化的部分 */
const sessions = new Map()
/** sessionId -> { netdisk, session }：下载完成后要回收的「转存副本」 */
const recycler = new Map()
const SESSION_TTL = 30 * 60 * 1000

function gc() {
  const now = Date.now()
  for (const [k, v] of sessions) if (now - v.createdAt > SESSION_TTL) sessions.delete(k)
}

function pickParser(url) {
  const nd = detectNetdisk(url)
  const p = PARSERS[nd]
  if (p) return { parser: p, netdisk: nd }
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
    if (!hit) {
      results.push({ ok: false, netdisk: 'unknown', files: [], source: url, message: `不支持的链接：${url}` })
      continue
    }
    const { parser, netdisk } = hit
    try {
      const open = await parser.open(url, {
        password: pwd,
        cookie: cookies[netdisk],
        userAgent: cfg.userAgent,
      })
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

/** 把会话里的文件解析成直链（有批量能力的解析器一次算完，省一轮 API / 少触发风控） */
async function resolveFiles({ sessionId, ids }) {
  const s = sessions.get(sessionId)
  if (!s) throw new Error('解析会话已过期，请重新解析链接')
  const wanted = []
  for (const id of ids) {
    const meta = s.files.find((f) => f.id === String(id))
    if (meta) wanted.push(meta)
  }
  if (!wanted.length) return []

  const out = []
  if (typeof s.resolveMany === 'function') {
    const got = await s.resolveMany(wanted.map((m) => ({ id: m.id, name: m.name })))
    /* 夸克/UC 的「转存」会在用户自己的网盘里留一份整文件拷贝。
     * 这里登记一个回收器，等 aria2 报 complete 后由主进程触发删除，
     * 否则每下一次同一个分享就多一个 `xxx(1).zip`（实测已把网盘塞了 6 份）。 */
    if (typeof s.removeTransferred === 'function') recycler.set(sessionId, { netdisk: s.netdisk, session: s })
    const byName = new Map(got.map((g) => [g.entry && g.entry.name, g]))
    for (const m of wanted) {
      const g = byName.get(m.name)
      if (!g) continue
      out.push({
        id: String(m.id),
        name: m.name,
        dir: m.dir || '',
        size: m.size || 0,
        url: g.url,
        headers: g.headers || {},
      })
    }
    if (out.length) return out
  }

  for (const m of wanted) {
    const r = await s.resolve(String(m.id))
    out.push({
      id: String(m.id),
      name: m.name,
      dir: m.dir || '',
      size: m.size || 0,
      url: r.url,
      headers: r.headers || {},
    })
  }
  // 逐条解析的解析器（迅雷）同样会转存副本，这里补登记回收器
  if (out.length && typeof s.removeTransferred === 'function') {
    recycler.set(sessionId, { netdisk: s.netdisk, session: s })
  }
  return out
}

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
  recycler.delete(sessionId)
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

module.exports = { parseShare, resolveFiles, dropSession, cleanupDownloaded, PARSERS }
