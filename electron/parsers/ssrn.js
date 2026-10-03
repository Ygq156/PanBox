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
 *  生产环境起点就是自己，等于原样返回；测试时才真的换。
 *  `base` 只给一处的回退用（见 deliveryIsFresh），平时不传。 */
function onSite(url, base) {
  try {
    const u = new URL(url)
    const b = new URL(base || siteBase())
    return new URL(u.pathname + u.search, b).toString()
  } catch {
    return url
  }
}

/** 这条地址是不是 SSRN 的「投递」地址（还需要 302 一次才到真文件）。
 *  插件抓下来的常常就是这种，而它**会过期**：302 的终点是 5 分钟有效的预签名地址。 */
function isDelivery(url) {
  return /\/Delivery\.cfm\//i.test(String(url || ''))
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

/**
 * 把一条投递地址换成**此刻可用**的真地址（预签名 S3 那条）。
 *
 * 为什么必须有这一步：插件抓到的那条 `/sol3/Delivery.cfm/…` 本身是长期地址，但它
 * 302 的终点是 5 分钟就失效的预签名地址；用户点开面板、看两眼、再点下载，那条抓下来
 * 的预签名地址往往已经死了，引擎拿到只会得到 403。所以下载前一律重新换一次。
 *
 * @param url     投递地址（`/sol3/Delivery.cfm/…`）
 * @param payload 浏览器身份（`{cookie, headers, referer, userAgent}`），由插件/解析现场给；
 *                另有 `siteUrl`：**浏览器现场是按哪条地址存的**。只在测试里两者才会不同
 *                （解析器把主机重写成假站点时，现场仍存在真站那个主机名下）。
 * @returns `{url, name, headers, ok}`；`ok=false` 时 `url` 仍是可下的一条（但可能需要浏览器身份）
 */
async function resolveDelivery(url, payload = {}) {
  const target = deliveryNeedsSite(url) ? url : onSite(url)
  const siteUrl = payload.siteUrl || target
  const withCookie = { ...(payload.headers || {}) }
  if (payload.referer && !withCookie.Referer) withCookie.Referer = payload.referer
  if (payload.userAgent && !withCookie['User-Agent']) withCookie['User-Agent'] = payload.userAgent
  /* cookie 罐**无条件**建：现场里存着的那份（插件交过来放进去的）和调用方这次额外带的
   * 合并到一起。以前写成「payload 里有 cookie 才建罐」，于是"现场里有身份、这一次没另带"
   * 就把现场整个丢了 —— 表现是投递请求裸奔过去吃 403。 */
  const jar = browserCtx.jarFor(siteUrl, payload.cookie)
  const headers = { ...pageHeaders(siteUrl, siteBase() + '/'), ...withCookie }
  try {
    const probe = await req(target, {
      method: 'GET',
      /* 不给 fallbackReferer：终点常常已经换到别家公司的主机上（download.ssrn.com 或 S3），
       * 把论文页地址当 Referer 带过去既是跨站泄露，也不是浏览器会做的事。 */
      headers: { ...headers, Range: 'bytes=0-0' },
      jar,
      timeout: 30000,
      noBody: true,
      allowLocal: !!process.env.PANBOX_SSRN_BASE,
    })
    if (probe.status >= 200 && probe.status < 300) {
      const finalUrl = probe.url || target
      return {
        ok: true,
        url: finalUrl,
        name: nameOf(probe.headers.get('content-disposition'), '', abstractIdOf(url)),
        /* 预签名地址自带签名，头不需要跟着走 */
        headers: {},
      }
    }
    return { ok: false, url: target, name: '', headers }
  } catch {
    return { ok: false, url: target, name: '', headers }
  }
}

/** 已经是真地址了（预签名那条，自带 `X-Amz-Signature` 之类的签名参数）就不要再换一次 ——
 *  换了反而会把签名参数丢掉。判据是**签名参数**，不是「在不在 ssrn.com 上」：
 *  测试里那条假地址也不在 ssrn.com 上，但它仍然需要被 302 一次。 */
function deliveryNeedsSite(url) {
  return !/[?&](x-amz-signature|x-amz-credential|signature|token)=/i.test(String(url || ''))
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

module.exports = {
  netdisk: 'ssrn',

  test(url) {
    return !!abstractIdOf(url)
  },

  /* 给「换直链」与插件那条路用：把抓到的投递地址换成此刻可用的真地址 */
  resolveDelivery,
  isDelivery,

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
        /* 现场用重写前的 `delivery` 取：那是浏览器真正待过的主机（测试里主机被换成假站点，
         * 现场仍存在真站名下；两边都传真站地址，生产环境行为不变）。 */
        const got = await resolveDelivery(probeUrl, { cookie: ctx.cookie, headers: pageHeaders(delivery), siteUrl: delivery })
        if (got.ok) {
          return {
            url: got.url,
            /* 预签名地址自带签名，身份一概不用带（带了反而可能被 CDN 判成异常） */
            headers: {},
            name: got.name || name,
          }
        }
        /* 没换出来（挑战没过、或者本来就没身份）：把投递地址连同浏览器身份交下去，
         * 让引擎自己跟那一次 302。 */
        return {
          url: delivery,
          headers: pageHeaders(delivery, url),
          name,
          /* 备用地址：投递地址走不通时，引擎还有这一条可以试（可能是刚才那条预签名
           * 地址，也可能就是同一条投递地址 —— 重复的那条会被引擎忽略）。 */
          urls: [{ url: got.url, headers: got.headers }],
        }
      },
    }
  },
}