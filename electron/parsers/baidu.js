'use strict'

const { req, reqJson, decodeEntities, sleep } = require('./util')

/**
 * 百度网盘解析器。
 *
 * 现实约束（必须让用户知道）：
 *  - 分享文件的取直链必须走「转存到你自己的网盘 → 取 dlink」，而这一步需要登录态（BDUSS）。
 *  - dlink 是账号权限内的链接：免费账号 96~170KB/s，SVIP 才有 7~10MB/s。本程序不做任何身份伪造。
 *  - 推荐的免费提速办法是打开百度网盘官方客户端的「设置 → 传输 → 下载提速」。
 */

const BAIDU_UA = 'pan.baidu.com'
const APP_QS = 'channel=chunlei&web=1&app_id=250528&clienttype=0'

function parseShareId(url) {
  const s = String(url || '')
  let m = s.match(/\/s\/([0-9a-zA-Z_-]+)/) || s.match(/[?&]surl=([0-9a-zA-Z_-]+)/)
  if (!m) throw new Error('无法识别百度网盘分享 ID')
  let id = m[1]
  // 百度接口用的 surl 不带开头那个 1
  const surl = id.startsWith('1') ? id.slice(1) : id
  return { shareId: id, surl }
}

function parseYunData(html) {
  const out = {}
  const grab = (key, re) => {
    const m = html.match(re)
    if (m) out[key] = m[1]
  }
  grab('shareid', /"shareid"\s*:\s*"?(\d+)"?/)
  grab('share_uk', /"share_uk"\s*:\s*"?(\d+)"?/)
  grab('uk', /"uk"\s*:\s*"?(\d+)"?/)
  grab('bdstoken', /"bdstoken"\s*:\s*"([0-9a-f]+)"/)
  grab('loginstate', /"loginstate"\s*:\s*(\d+)/)
  grab('title', /"shareid":\d+,"title":"([^"]*)"/)
  // 新版页面把数据放在 locals 里
  const lm = html.match(/locals\s*=\s*\{[\s\S]{0,4000}?\}/)
  if (lm) {
    const block = lm[0]
    if (!out.shareid) {
      const m2 = block.match(/"shareid"\s*:\s*"?(\d+)"?/)
      if (m2) out.shareid = m2[1]
    }
    if (!out.share_uk) {
      const m2 = block.match(/"share_uk"\s*:\s*"?(\d+)"?/)
      if (m2) out.share_uk = m2[1]
    }
  }
  return out
}

module.exports = {
  netdisk: 'baidu',

  test(url) {
    return /(pan|yun|eyun)\.baidu\.com/i.test(String(url))
  },

  async open(url, ctx = {}) {
    const { shareId, surl } = parseShareId(url)
    const cookie = ctx.cookie
    const referer = `https://pan.baidu.com/s/${shareId}`
    const headers = {
      Referer: referer,
      'User-Agent': ctx.userAgent || BAIDU_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(cookie ? { Cookie: cookie } : {}),
    }

    const page = await req(referer, { headers })
    const yun = parseYunData(page.text)

    if (ctx.password) {
      const t = Date.now()
      const vr = await reqJson(
        `https://pan.baidu.com/share/verify?surl=${surl}&t=${t}&${APP_QS}`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: `pwd=${encodeURIComponent(ctx.password)}&vcode=&vcode_str=`,
        },
      )
      const j = vr.json || {}
      if (j.errno !== 0) {
        const e = new Error(`提取码校验失败（errno=${j.errno}）`)
        if (j.errno === -9 || j.errno === -62) e.needPassword = true
        throw e
      }
    }

    if (!yun.shareid || !yun.share_uk) {
      const err = new Error(
        '无法读取分享信息。百度网盘分享页需要登录态才能取得 shareid/share_uk —— 请在「设置 → 网盘 Cookie」填入你自己的 BDUSS，或先在浏览器登录百度网盘后复制完整 Cookie。',
      )
      err.needCookie = true
      throw err
    }

    const listing = await reqJson(
      `https://pan.baidu.com/share/list?uk=${yun.share_uk}&shareid=${yun.shareid}&order=other&desc=1&showempty=0&web=1&page=1&num=1000&dir=%2F&t=${Date.now()}&bdstoken=${yun.bdstoken || ''}&${APP_QS}`,
      { headers: { ...headers, Accept: 'application/json' } },
    )
    const lj = listing.json || {}
    if (lj.errno !== 0) {
      /* 百度把「失效 / 无权限 / 需验证」都塞在 errno 里，原样抛出等于没说人话 */
      const eno = lj.errno
      const MAP = {
        '-9': '提取码错误',
        '-21': '分享已失效或被删除（也可能是分享方限制了访问）',
        '-62': '该分享需要短信验证码，只有网页端能通过',
        '-6': '登录凭证（BDUSS）已失效',
        105: '分享链接已过期',
        10005: '分享链接已过期',
      }
      // eslint-disable-next-line eqeqeq
      const key = Object.keys(MAP).find((k) => Number(k) === eno)
      const e = new Error(`${key ? MAP[key] : `读取分享目录失败（errno=${eno}）`}${lj.errmsg ? `：${lj.errmsg}` : ''}`)
      if (eno === -9 || eno === -62) e.needPassword = true
      if (!cookie && eno === -6) e.needCookie = true
      throw e
    }
    const list = lj.list || []
    const entries = list.map((it) => ({
      fsId: it.fs_id,
      name: it.server_filename,
      size: Number(it.size || 0),
      isDir: !!it.isdir,
      path: it.path,
    }))

    return {
      title: decodeEntities(yun.title || `百度分享 ${shareId}`),
      shareId,
      files: entries.map((e, i) => ({
        id: String(i),
        name: e.name,
        size: e.size,
        isDir: e.isDir,
        dir: '',
      })),
      resolve: async (id) => {
        const e = entries[Number(id)]
        if (!e) throw new Error('文件索引无效')
        if (!cookie) {
          const err = new Error('百度网盘取直链需要登录 Cookie（设置 → 网盘 Cookie 填 BDUSS）')
          err.needCookie = true
          throw err
        }
        // 1) 转存到自己网盘
        const transfer = await reqJson(
          `https://pan.baidu.com/share/transfer?shareid=${yun.shareid}&from=${yun.share_uk}&bdstoken=${yun.bdstoken || ''}&${APP_QS}`,
          {
            method: 'POST',
            headers: {
              ...headers,
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: `fsidlist=%5B${e.fsId}%5D&path=%2FPanBox`,
          },
        )
        const tj = transfer.json || {}
        if (tj.errno !== 0 && tj.errno !== 12) {
          throw new Error(`转存失败（errno=${tj.errno}）：${tj.errmsg || tj.show_msg || ''}`)
        }
        await sleep(800)
        // 2) 取 sign / timestamp
        const tv = await reqJson(
          `https://pan.baidu.com/api/gettemplatevariable?${APP_QS}&fields=%5B%22sign%22%2C%22timestamp%22%5D`,
          { headers: { ...headers, Accept: 'application/json' } },
        )
        const tvj = (tv.json && tv.json.result) || {}
        // 3) 在新目录里找到转存后的 fs_id
        const rootList = await reqJson(
          `https://pan.baidu.com/api/list?dir=%2FPanBox&order=time&desc=1&showempty=0&web=1&page=1&num=1000&t=${Date.now()}&bdstoken=${yun.bdstoken || ''}&${APP_QS}`,
          { headers: { ...headers, Accept: 'application/json' } },
        )
        const rl = (rootList.json && rootList.json.list) || []
        const hit = rl.find((x) => x.server_filename === e.name) || rl[0]
        if (!hit) throw new Error('转存后未能定位文件')
        // 4) 取 dlink
        const dl = await reqJson(
          `https://pan.baidu.com/api/download?sign=${tvj.sign}&timestamp=${tvj.timestamp}&fidlist=%5B${hit.fs_id}%5D&type=dlink&${APP_QS}`,
          { headers: { ...headers, Accept: 'application/json' } },
        )
        const dj = dl.json || {}
        if (dj.errno !== 0 || !dj.dlink || !dj.dlink[0]) {
          throw new Error(`取直链失败（errno=${dj.errno}）：${dj.errmsg || ''}`)
        }
        return {
          url: dj.dlink[0].dlink,
          headers: {
            Referer: 'https://pan.baidu.com/',
            'User-Agent': BAIDU_UA,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        }
      },
    }
  },
}
