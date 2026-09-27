'use strict'

const path = require('node:path')
const { req } = require('./util')

/**
 * 通用直链解析器：用户直接粘贴 http(s) 文件直链时使用。
 * 名称优先从 Content-Disposition 取，其次从 URL 路径取。
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
    try {
      const r = await req(url, { method: 'HEAD', timeout: 15000, cookie: ctx.cookie })
      const cd = r.headers.get('content-disposition') || ''
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

    if (!name) {
      try {
        const u = new URL(url)
        name = decodeURIComponent(path.posix.basename(u.pathname)) || 'download.bin'
      } catch {
        name = 'download.bin'
      }
    }

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
        },
      ],
      resolve: async () => ({ url, headers }),
    }
  },
}
