'use strict'

const { req, filenameFromHeaders } = require('./util')

/* ------------------------------------------------------------------ */
/* 探地址：只读响应头，一个字节正文都不读                                  */
/* ------------------------------------------------------------------ */
/*
 * 六个解析器以前各写一遍这件事（direct / mdpi / lanzou / ssrn / clouddrive，
 * 外加主进程的 ctOf 与 handable —— 后两个是同一件事的两份实现），每处的
 * 超时（15/20/25/30 秒）、是否跟重定向、要不要带 Range、判定「能用」的状态码
 * 范围都不一样：同一条地址换个入口进来，结论可能相反。
 *
 * 收敛到这一处之后，加一个站只要说「我要探这条地址」，不用再决定这些。
 */

/** 「问一句就走」的超时：名字、可达性这类顺路的探测，不能把用户的解析界面卡住 */
const PROBE_TIMEOUT = 15000
/** 要走代理、要跟一次 302（论文站的投递地址、下载域的一次性直链）给宽一点 */
const PROBE_TIMEOUT_LONG = 30000
/** 只想知道「通不通」时读一个字节就够 —— 比 GET 整个头再掐断更省站点资源 */
const PROBE_RANGE = 'bytes=0-0'

/**
 * 探一条地址。**永远不抛**：探不到就返回 `ok=false` 与真实 status，由调用方决定兜底。
 *
 * @param url            要探的地址
 * @param method         'HEAD'（默认，最省流量）或 'GET'
 * @param range          带不带 `Range: bytes=0-0`（GET 时默认不带：
 *                       蓝奏那条下载域要靠完整响应的 `content-length` 才知道文件多大，
 *                       带了 Range 就只剩 1 字节了）
 * @param headers/jar/cookie/redirect/allowLocal/timeout  透传给 util.req
 * @returns { ok, usable, status, url, headers, name, size, ct, err }
 *   - `ok`     2xx（拿到了响应头，这条地址基本能用）
 *   - `usable` 2xx/3xx（能交给下载引擎；引擎自己会跟重定向）
 *   - `url`    跟完重定向之后的最终地址（引擎要拿它去下载）
 *   - `name`   响应头里的文件名（抠不到是空串）
 */
async function probeUrl(url, opts = {}) {
  const {
    method = 'HEAD',
    range = false,
    headers = {},
    jar,
    cookie,
    redirect,
    allowLocal = false,
    timeout = PROBE_TIMEOUT,
  } = opts

  const head = { ok: false, usable: false, status: 0, url, headers: null, name: '', size: 0, ct: '', err: '' }
  /* 站点不认 HEAD 是常态（省流量的代价）：405 / 501 时换带 Range 的 GET 再问一次。
   * 其它状态码是站点的回答（403 就是 403），不再折腾。 */
  const order = method === 'HEAD' ? ['HEAD', 'GET'] : ['GET']
  let last = head
  for (const m of order) {
    const h = range || (m === 'GET' && method === 'HEAD') ? { ...headers, Range: PROBE_RANGE } : { ...headers }
    let r
    try {
      r = await req(url, { method: m, headers: h, jar, cookie, redirect, timeout, noBody: true, allowLocal })
    } catch (e) {
      last = { ...head, err: (e && e.message) || String(e) }
      continue
    }
    /* 只要响应头：正文（哪怕是一个字节）立刻掐断，别让套接字挂在这儿 */
    try {
      await r.body?.cancel()
    } catch {
      /* ignore */
    }
    const hit = {
      ok: r.status >= 200 && r.status < 300,
      usable: r.status >= 200 && r.status < 400,
      status: r.status,
      url: r.url || url,
      headers: r.headers,
      name: filenameFromHeaders(r.headers),
      size: Number(r.headers.get('content-length') || 0) || 0,
      ct: r.headers.get('content-type') || '',
      err: '',
    }
    if (hit.ok || m === 'GET' || (r.status !== 405 && r.status !== 501)) return hit
    last = hit
  }
  return last
}

module.exports = { probeUrl, PROBE_TIMEOUT, PROBE_TIMEOUT_LONG, PROBE_RANGE }