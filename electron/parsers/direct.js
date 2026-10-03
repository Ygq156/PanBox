'use strict'

const { req, withExt, urlBaseName } = require('./util')

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
      const r = await req(url, { method: 'HEAD', timeout: 15000, cookie: ctx.cookie, allowLocal: ALLOW_LOCAL })
      const cd = r.headers.get('content-disposition') || ''
      ct = r.headers.get('content-type') || ''
      let m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
      if (m) {
        try {
          name = decodeURIComponent(m[1])
        } catch {
          name = m[1]
        }
      }
      size = Number(r.headers.get('content-length') || 0)
      headers = { Referer: new URL(url).origin + '/' }
    } catch {
      /* HEAD 不被支持时忽略，交给 aria2 自己猜 */
    }

    if (!name) name = nameFromUrl(url)
    name = withExt(name, ct)

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
      resolve: async () => ({ url, headers }),
    }
  },
}
