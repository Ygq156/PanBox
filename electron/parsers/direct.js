'use strict'

const { urlBaseName, withExt, sanitizeFileName } = require('./util')
const { probeUrl } = require('./probe')
const identity = require('./identity')

/* 只给「假站点起在本机」的测试用（见 test\verify-name-ext.js）：产品路径永远关闭，
 * 免得远端响应把我们引去打内网（见 util.js 里 assertOutbound 的注释）。 */
const ALLOW_LOCAL = !!process.env.PANBOX_DIRECT_BASE || process.env.PANBOX_PROBE_LOCAL === '1'

/**
 * 名字兜底：服务器没给文件名时，先看地址里有没有把文件名写在查询串上
 * （`…/download?file=3345768.3355908` 这种很常见），最后才拿路径最后一段。
 */
function nameFromUrl(url) {
  return urlBaseName(url) || 'download.bin'
}

/**
 * 通用直链解析器：用户直接粘贴 http(s) 文件直链时使用。
 * 名称优先从 Content-Disposition 取，其次从 URL 路径取；
 * 两者都没给后缀时按响应类型补一个（浏览器就是这么定的，
 * 例如 `…/epdf/10.1145/3345768.3355908` 会存成 `3345768.3355908.pdf`）。
 */
module.exports = {
  netdisk: 'direct',

  test(url) {
    return /^https?:\/\//i.test(url)
  },

  async open(url, ctx = {}) {
    let name = ''
    let size = 0
    let headers = {}
    let ct = ''
    try {
      /* 只问一次响应头（HEAD，站点不认时 probeUrl 自己换 Range 的 GET）：
       * 名字、体积、响应类型都在里面。身份用**浏览器现场那份** —— 直链常常挂在
       * Cloudflare 这类墙后面（用户报的 ACM 就是），只有带着浏览器那副 UA / cookie
       * 才看得到响应头；用户自己配的凭证排在现场之后合并。 */
      const h = identity.addCookie(identity.forRequest(url, {}), ctx.cookie)
      const p = await probeUrl(url, { headers: h, allowLocal: ALLOW_LOCAL })
      ct = p.ct
      name = p.name
      size = p.size
      headers = { Referer: new URL(url).origin + '/' }
    } catch {
      /* 连地址都不合法时忽略，交给 aria2 自己猜 */
    }

    if (!name) name = nameFromUrl(url)
    name = sanitizeFileName(withExt(name, ct))

    return {
      title: name,
      shareId: url,
      files: [
        {
          id: '0',
          name,
          size,
          isDir: false,
          dir: '',
          /* 探到的响应类型要带出去：主进程靠它判断这条是不是 HLS 播放列表
           * （地址没后缀时后缀与类型是仅有的线索，见 main.js 的 playlistKind）。 */
          mime: ct,
        },
      ],
      /* 直链也带上用户为「直链」配的那份凭证：以前只有探测带、真正下载不带，
       * 于是「探测说能下、下载 403」——那些需要凭证的直链就是这么失败的。 */
      resolve: async () => ({ url, headers: identity.addCookie(headers, ctx.cookie) }),
    }
  },
}
