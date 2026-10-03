'use strict'

const { req } = require('./util')
const browserCtx = require('./browserCtx')

/* ------------------------------------------------------------------ */
/* SSRN（papers.ssrn.com）                                             */
/* ------------------------------------------------------------------ */

/* 这一站有两层门槛，缺一层都下不动：
 *
 * 1）**直连根本上不去**。实测（同一台机器、同一时刻）：`papers.ssrn.com` 与
 *    `download.ssrn.com` 直接 fetch 一律 `UND_ERR_CONNECT_TIMEOUT`，走系统代理
 *    （本机 127.0.0.1:7897）才能连上。Node 自带的 fetch 不读 Windows 代理设置，
 *    所以出口代理由 `util.setOutboundProxy` 在启动时统一装好（见 main.js）。
 *
 * 2）**站点的 Cloudflare 挑战**。走代理后文章页返回 403 + `cf-mitigated: challenge`。
 *    用户浏览器能下，是因为那份 profile 里已经通过了挑战、持有 `cf_clearance`。
 *    这份 Cookie 拿不到（Chromium 的 cookie 库读不出来），只能靠插件把浏览器
 *    此刻在用的那一份交过来（`/page` 或下载投递都会带）。
 *
 * 挑战过了之后的链路是一条普通 302：
 *   /sol3/Delivery.cfm/SSRN_ID<修订号>_code<作者号>.pdf?abstractid=<号>&mirid=1
 *     → https://download.ssrn.com/<日期路径>/ssrn_id<号>_code<号>.pdf?<AWS 预签名参数>
 *
 * 预签名那条地址**自带签名、5 分钟有效、不需要任何 Cookie**，所以解析时先把它
 * 换出来（HEAD 跟一次重定向即可），下载引擎拿到的就是一条干净的地址；换不出来
 * 也不致命 —— 把 Delivery.cfm 那条连同浏览器身份一起交下去，让引擎自己跟。 */

/** 测试用：把站点起点与投递地址换成本机假站点。生产环境不设这两个变量。 */
function siteBase() {
  return String(process.env.PANBOX_SSRN_BASE || 'https://papers.ssrn.com').replace(/\/+$/, '')
}

/** 把一条 ssrn.com 上的地址换成「当前生效的站点起点」上的同一条地址。
 *  生产环境起点就是自己，等于原样返回；测试时才真的换。 */
function onSite(url) {
  try {
    const u = new URL(url)
    const b = new URL(siteBase())
    return new URL(u.pathname + u.search, b).toString()
  } catch {
    return url
  }
}

/** 文章页地址 → 稿件号；认不出来返回 '' */
function abstractIdOf(url) {
  try {
    const u = new URL(url)
    if (!/(^|\.)ssrn\.com$/i.test(u.hostname)) return ''
    const q = u.searchParams.get('abstract_id') || u.searchParams.get('abstractid') || ''
    if (/^\d{4,12}$/.test(q)) return q
    /* 有的入口把号写在路径里：/sol3/papers.cfm?abstract_id=… 之外还有 /Delivery.cfm/… */
    const m = /\/(?:papers|Delivery)\.cfm\/?[^?#]*?(\d{4,12})/i.exec(u.pathname)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

/* 页面里那条真的投递链接。SSRN 用普通 <a href>，不做 JS 拼地址，
 * 所以从 HTML 里找 `/Delivery.cfm/` 就够了；找不到再退化成自己拼一条。 */
function deliveryFromHtml(html, id) {
  const s = String(html || '')
  const m = /href\s*=\s*["']([^"']*\/Delivery\.cfm\/[^"']+)["']/i.exec(s)
  if (m) {
    try {
      return new URL(m[1].replace(/&amp;/g, '&'), siteBase()).toString()
    } catch {
      /* 地址畸形就往下走兜底 */
    }
  }
  const m2 = /["'](https?:\/\/[^"']*\/Delivery\.cfm\/[^"']+)["']/i.exec(s)
  if (m2) {
    try {
      return new URL(m2[1].replace(/&amp;/g, '&')).toString()
    } catch {
      /* ignore */
    }
  }
  return defaultDelivery(id)
}

/** 没有页面可抓时的兜底地址（拿不到修订号与作者号，但 SSRN 只按稿件号也能出文件） */
function defaultDelivery(id) {
  return `${siteBase()}/sol3/Delivery.cfm/SSRN_ID${id}.pdf?abstractid=${id}&mirid=1`
}

/** `Content-Disposition` / 页面标题 → 文件名 */
function nameOf(cd, title, id) {
  const s = String(cd || '')
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(s)
  if (m) {
    try {
      return decode(clean(m[1]))
    } catch {
      /* 编码坏了就用原样 */
    }
  }
  m = /filename\s*=\s*"?([^";]+)"?/i.exec(s)
  if (m) return clean(m[1])
  const t = String(title || '').trim()
  if (t) {
    /* 页面标题常是 `Title by Author :: SSRN` 这种，取 `::` 前面那段 */
    const head = t.split(/\s*::\s*/)[0].replace(/\s+/g, ' ').trim()
    if (head && head.length <= 160) return clean(head + '.pdf')
  }
  return `ssrn-${id}.pdf`
}

function clean(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function decode(s) {
  try {
    return decodeURIComponent(String(s).trim().replace(/^"|"$/g, ''))
  } catch {
    return String(s).trim().replace(/^"|"$/g, '')
  }
}

/** 页面 <title> 里那句论文名（只是给列表看着顺眼，拿不到就算了） */
function titleFromHtml(html) {
  const m = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(String(html || ''))
  return m ? m[1].replace(/\s+/g, ' ').trim() : ''
}

/** 这一站上浏览器此刻的身份（UA / Referer / 挑战相关的头）；没有现场就是空对象 */
function pageHeaders(url, fallbackReferer) {
  return browserCtx.headersFor({}, url, fallbackReferer) || {}
}

module.exports = {
  netdisk: 'ssrn',

  test(url) {
    return !!abstractIdOf(url)
  },

  async open(url, ctx = {}) {
    const id = abstractIdOf(url)
    if (!id) throw new Error('这不是 SSRN 的文章页地址（形如 https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4308687）')

    const jar = browserCtx.jarFor(url, ctx.cookie)
    const pageUrl = onSite(url)
    let html = ''
    let title = ''
    let delivery = ''
    try {
      /* 文章页要给**完整**的浏览器身份：Cloudflare 的挑战是按 IP + UA + Cookie 绑的，
       * 少一样就回到「请稍候…」。cookie 走 jar（同主机才带），别的头走 headersFor。 */
      const r = await req(pageUrl, {
        headers: pageHeaders(url, siteBase() + '/'),
        jar,
        timeout: 30000,
        allowLocal: !!process.env.PANBOX_SSRN_BASE,
      })
      if (r.status === 200 && !r.isBinary) {
        html = r.text
        title = titleFromHtml(html)
        delivery = deliveryFromHtml(html, id)
      }
    } catch {
      /* 连不上/被拦：不在这里报错 —— 直链还能靠插件抓到的地址或兜底地址，
       * 真正失败要让用户看到的是「解析这一步」的原因，而不是一句笼统的失败。 */
    }
    if (!delivery) delivery = defaultDelivery(id)

    const name = nameOf('', title, id)
    return {
      title: title || `SSRN ${id}`,
      shareId: url,
      files: [{ id: '0', name, size: 0, isDir: false, dir: '' }],
      resolve: async () => {
        /* 先试着把预签名地址换出来：那条地址不带 Cookie、也没有 5 分钟之外的约束，
         * 下载引擎拿着它最省事。换不出来就把投递地址连同浏览器身份一起交下去。 */
        const probeUrl = onSite(delivery)
        try {
          const probe = await req(probeUrl, {
            method: 'GET',
            /* 这里**不给** fallbackReferer：目标常常已经被 302 换到了另一家公司的主机上
             * （download.ssrn.com 或 S3），把论文页地址当 Referer 带过去既是跨站泄露，
             * 也不是浏览器会做的事。同一个主机上的现场（真有的话）仍然会带上。 */
            headers: { ...pageHeaders(probeUrl), Range: 'bytes=0-0' },
            jar,
            timeout: 30000,
            noBody: true,
            allowLocal: !!process.env.PANBOX_SSRN_BASE,
          })
          if (probe.status >= 200 && probe.status < 300) {
            /* 探测时跟到的最后一跳就是**真的要下的那条**（预签名 S3 地址）；
             * 生产环境返回给引擎的是它，测试环境里它落在假站点上，要换回真域名。 */
            const finalUrl = probe.url || probeUrl
            const nm = nameOf(probe.headers.get('content-disposition'), title, id)
            return {
              url: finalUrl,
              headers: { 'User-Agent': pageHeaders(probeUrl)['User-Agent'] || '' },
              name: nm,
            }
          }
        } catch {
          /* 交给下面的回退 */
        }
        return { url: delivery, headers: pageHeaders(delivery, url), name }
      },
    }
  },
}