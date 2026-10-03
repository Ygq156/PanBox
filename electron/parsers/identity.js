'use strict'

/**
 * 一次请求的「身份」。
 *
 * 目标是让 PanBox 发出去的请求看起来就是**用户那台浏览器**发的：同一个 User-Agent、
 * 同一台主机自己的 Cookie、同一份 Referer。浏览器能下、PanBox 下不了，多数时候差的
 * 就是这三样 —— Cloudflare 的放行票（cf_clearance）、CDN 按 UA 签出来的地址、
 * 只认 Referer 的防盗链。
 *
 * 数据来自 browserCtx（插件在浏览器里抓到的现场，只存内存、10 分钟有效）。
 * 这里只做「按主机取用 + 合并」这一件事：
 *   - Cookie 绝不给别的主机用；同站点的兄弟主机（www.a.com 与 a.com）才算一台。
 *   - 现场的分量**低于**调用方自己的头：解析器明确给了值的字段不会被盖掉。
 *   - 这些头只用于内存里的这一次请求，**绝不写进任务记录**（那是要落盘的）。
 *
 * 跳转也是一条请求：地址 302 到别家主机时要把凭据摘掉（浏览器也不会把 A 站的 cookie
 * 发给 B 站）。自研引擎与解析层走 `core/netHosts.js` 那份实现；aria2 自己跟重定向，
 * 无法逐跳改头 —— 这是它的固有行为，不做额外处理。
 */

const { Jar } = require('./util')
const browserCtx = require('./browserCtx')

/**
 * 把两份 Cookie 串并成一份。同名以 extra 为准 —— 与 browserCtx.jarFor 的顺序一致：
 * 浏览器现场在前，调用方（用户配的凭证 / 解析器算出来的）在后。
 */
function mergeCookie(base, extra) {
  if (!base) return String(extra || '')
  if (!extra) return String(base || '')
  const j = new Jar(base)
  j.setFromString(extra)
  return j.toString()
}

/**
 * 给「马上要发出去的一次请求」配齐身份。
 *
 * @param {string} url 这次请求的目标地址（决定用哪台主机的现场）
 * @param {object} headers 调用方已经备好的头（不会被修改）
 * @param {{referer?: string}} [opts] referer：没有现场时用的 Referer
 * @returns {object} 新的头对象；现场里没有这个主机时基本就是原样
 */
function forRequest(url, headers, opts = {}) {
  const h = browserCtx.headersFor(headers, url, (opts && opts.referer) || '')
  const ctxCookie = browserCtx.cookieFor(url)
  if (ctxCookie) h.Cookie = mergeCookie(ctxCookie, h.Cookie)
  return h
}

/** 这个地址能不能用上浏览器现场（用来区分「没带身份」与「带了还是被拒」） */
function has(url) {
  return !!browserCtx.lookup(url)
}

/**
 * 把调用方自己的凭证并到头上（`forRequest` 之后调）。
 * 同名以调用方为准 —— 用户/解析器明确给的那份，比浏览器现场的更可信。
 */
function addCookie(headers, extra) {
  if (!extra) return { ...(headers || {}) }
  const h = { ...(headers || {}) }
  h.Cookie = mergeCookie(h.Cookie, extra)
  return h
}

module.exports = { forRequest, addCookie, mergeCookie, has }