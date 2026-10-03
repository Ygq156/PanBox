/* 主机名与「凭据该不该带」这一件事。
 *
 * 为什么单独一个文件：下载引擎（core/httpStream.js）和解析层（parsers/util.js）
 * 都要在跟重定向时做同一个判断 —— 跳到别家主机就把 Cookie / Authorization 摘掉。
 * 两处各写一遍迟早会走偏，所以规则只留这一份。
 *
 * 规矩来自浏览器：cookie 是**按站点**发的，A 站拿到的凭据不会跟着 302 送给 B 站。
 * PanBox 的下载地址经常 302 到另一家 CDN，照抄整份头等于把用户在某站的会话送出去。
 */

/** 取主机名（小写）；不是合法 URL 就给空串 */
function hostnameOf(u) {
  try {
    return new URL(String(u)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 两个主机是不是同一站：www.a.com 之于 a.com 算同一站，a.com 之于 b.com 不算 */
function sameSite(a, b) {
  const x = String(a || '').toLowerCase()
  const y = String(b || '').toLowerCase()
  if (!x || !y) return false
  return x === y || x.endsWith('.' + y) || y.endsWith('.' + x)
}

/** 摘掉凭据：cookie 与 authorization */
function withoutCreds(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase()
    if (key === 'cookie' || key === 'authorization') continue
    out[k] = v
  }
  return out
}

/** 请求 `url` 时该用哪份头：与 `from` 同站用原样，跨站摘掉凭据 */
function headersForHop(headers, from, url) {
  return sameSite(hostnameOf(from), hostnameOf(url)) ? headers : withoutCreds(headers)
}

module.exports = { hostnameOf, sameSite, withoutCreds, headersForHop }