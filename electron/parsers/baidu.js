'use strict'

/**
 * 百度网盘解析器（2026 版分享页）。
 *
 * ── 匿名解析（已验证，2026-09-27）─────────────────────────────────────────
 *   ① GET  `/share/init?surl=<surl>`            拿 BAIDUID / csrfToken
 *   ② POST `/share/verify?surl=<surl>&t=…`      有提取码时校验，服务端下发 **BDCLND** cookie
 *   ③ GET  `/s/<shareId>`（带上全部 cookie）     页面里 `<script id="locals-data">` 的 JSON
 *                                                就有完整 `file_list`
 *   旧的「直连 `/share/list` 拿目录」在 2026 年对游客一律回 `errno:2`（啊哦，链接出错了），
 *   必须走上面这条「先 verify 再请求分享页」的路径 —— 这也是真浏览器在做的事。
 *
 * ── 下载（必须登录）──────────────────────────────────────────────────────
 *   分享文件没有直链，官方路径是「转存到你自己的网盘 → 取 dlink」，需要 BDUSS。
 *   dlink 的 header 必须带 `User-Agent: pan.baidu.com`，否则 31326 防盗链。
 *
 * ── 速度真相（必须让用户知道）────────────────────────────────────────────
 *   dlink 是账号权限内的链接：免费账号 96~170KB/s，SVIP 才有 7~10MB/s（且每月 20GB 极速流量）。
 *   百度按**账号**维度限速，所以本程序对百度任务强制 `split=1`，多线程只会招致惩罚性降速。
 *   合法免费提速：百度网盘官方 PC 客户端「设置 → 传输 → 下载提速」。
 */

const { req, reqJson, decodeEntities, sleep } = require('./util')

/** 取 dlink 时必须伪装成 pan.baidu.com，否则 31326 防盗链 */
const BAIDU_UA = 'pan.baidu.com'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const APP_QS = 'channel=chunlei&web=1&app_id=250528&clienttype=0'

function parseShareId(url) {
  const s = String(url || '')
  const m = s.match(/\/s\/([0-9a-zA-Z_-]+)/) || s.match(/[?&]surl=([0-9a-zA-Z_-]+)/)
  if (!m) throw new Error('无法识别百度网盘分享 ID')
  const id = m[1]
  // 接口用的 surl 不带开头那个 1
  return { shareId: id, surl: id.startsWith('1') ? id.slice(1) : id }
}

const cookieOf = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ')
const mergeCookie = (a, b) => [a, b].filter(Boolean).join('; ')

/** 从分享页里抠出文件列表 JSON。百度两种模板并存：
 *   - 新版：`<script id="locals-data" type="application/json">{…}</script>`
 *   - 旧版：`locals.mset({…});`（`window.locals` 机制）
 */
function parseLocals(html) {
  const m = html.match(/id="locals-data"[^>]*>([\s\S]*?)<\/script>/)
  if (m) {
    try {
      return JSON.parse(m[1].trim())
    } catch {
      /* 落到旧版分支 */
    }
  }
  const at = html.indexOf('locals.mset(')
  if (at < 0) return null
  const start = html.indexOf('{', at)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  for (let k = start; k < html.length; k++) {
    const ch = html[k]
    if (inStr) {
      if (ch === '\\') k++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, k + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 百度把各种失败都塞在 errno 里，翻译成人话 */
function errnoText(eno, errmsg) {
  const MAP = {
    '-9': '提取码错误',
    '-12': '验证码错误',
    '-21': '分享已失效或被删除（也可能是分享方限制了访问）',
    '-62': '该分享需要短信验证码，只有网页端能通过',
    '-6': '登录凭证（BDUSS）已失效',
    '-7': '链接出错了（分享不存在或参数不对）',
    2: '链接出错了（分享不存在、需要提取码，或已被限制）',
    105: '分享链接已过期',
    10005: '分享链接已过期',
  }
  const key = Object.keys(MAP).find((k) => Number(k) === eno)
  return `${key ? MAP[key] : `百度返回 errno=${eno}`}${errmsg ? `：${errmsg}` : ''}`
}

module.exports = {
  netdisk: 'baidu',

  test(url) {
    return /(pan|yun|eyun)\.baidu\.com/i.test(String(url))
  },

  async open(url, ctx = {}) {
    const { shareId, surl } = parseShareId(url)
    const bduss = ctx.cookie || ''
    const h = {
      Referer: `https://pan.baidu.com/s/${shareId}`,
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(bduss ? { Cookie: bduss } : {}),
    }

    /* ① init：拿匿名 cookie */
    const init = await req(`https://pan.baidu.com/share/init?surl=${surl}`, { headers: { ...h, Referer: 'https://pan.baidu.com/' } })
    let cookie = mergeCookie(bduss, cookieOf(init))

    /* ② 有提取码就校验，成功后服务端下发 BDCLND，没有它分享页只会显示「提取文件」 */
    if (ctx.password) {
      const vr = await req(`https://pan.baidu.com/share/verify?surl=${surl}&t=${Date.now()}&${APP_QS}`, {
        method: 'POST',
        headers: {
          ...h,
          Cookie: cookie,
          Referer: `https://pan.baidu.com/share/init?surl=${surl}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `pwd=${encodeURIComponent(ctx.password)}&vcode=&vcode_str=`,
      })
      let vj = {}
      try {
        vj = JSON.parse(vr.text.trim())
      } catch {
        /* ignore */
      }
      if (vj.errno !== 0) {
        const e = new Error(errnoText(vj.errno, vj.err_msg))
        e.needPassword = true
        throw e
      }
      cookie = mergeCookie(cookie, cookieOf(vr))
    }

    /* ③ 请求分享页，文件列表就在 locals-data 里 */
    const page = await req(`https://pan.baidu.com/s/${shareId}`, {
      headers: { ...h, Referer: 'https://pan.baidu.com/', Cookie: cookie },
    })
    const locals = parseLocals(page.text)

    if (!locals || !Array.isArray(locals.file_list)) {
      const needPwd = /\/share\/init/.test(page.url) || /提取码|请输入访问密码/.test(page.text)
      const e = new Error(
        needPwd
          ? '这个百度分享需要提取码，请在右边的「提取码」框里填写后重试'
          : '无法读取百度分享内容（分享可能已失效或被限制访问）',
      )
      if (needPwd) e.needPassword = true
      throw e
    }
    if (Number(locals.errno || 0) !== 0) throw new Error(errnoText(locals.errno, locals.error))

    const share_uk = String(locals.share_uk || '')
    const shareid = String(locals.shareid || '')
    const bdstoken = String(locals.bdstoken || '')

    /** 把 API 返回的一条文件记录规整成内部结构。
     *  `path` 是分享内的绝对路径，`/share/list` 的 `dir` 参数必须原样用它（实测：拼 `/名字` 会回 errno:2）。 */
    const norm = (it, dir) => ({
      fsId: String(it.fs_id),
      name: decodeEntities(String(it.server_filename || '')),
      size: Number(it.size || 0),
      isDir: !!it.isdir,
      dir,
      rawPath: String(it.path || ''),
    })

    const root = (locals.file_list || []).map((it) => norm(it, ''))
    if (!root.length) throw new Error('百度分享里没有文件（分享可能已失效）')

    /* 子目录遍历：优先用 /share/list（带上 BDCLND/sekey），失败就只保留顶层 */
    const listDir = async (dirPath) => {
      const r = await reqJson(
        `https://pan.baidu.com/share/list?uk=${share_uk}&shareid=${shareid}&order=name&desc=0&showempty=0` +
          `&web=1&page=1&num=1000&dir=${encodeURIComponent(dirPath)}&t=${Date.now()}&bdstoken=${bdstoken}&${APP_QS}`,
        {
          headers: {
            ...h,
            Cookie: cookie,
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
        },
      )
      const j = r.json || {}
      if (j.errno !== 0) throw new Error(errnoText(j.errno, j.errmsg))
      return (j.list || []).map((it) => norm(it, dirPath === '/' ? '' : dirPath.replace(/^\//, '')))
    }

    const flat = []
    const walk = async (entries, depth) => {
      for (const e of entries) {
        if (e.isDir) {
          if (depth >= 5) continue
          let kids = []
          try {
            kids = await listDir(e.rawPath)
            const sub = e.dir ? `${e.dir}/${e.name}` : e.name
            for (const k of kids) k.dir = sub
          } catch {
            /* 子目录列不出来就跳过，不影响顶层文件下载 */
            continue
          }
          await walk(kids, depth + 1)
        } else {
          flat.push(e)
        }
      }
    }
    await walk(root, 0)
    if (!flat.length) throw new Error('百度分享里没有可下载的文件')

    const title = decodeEntities(String(locals.title || (root.length === 1 ? root[0].name : `百度分享 ${shareId}`)))

    const entries = flat
    /* 转存到用户自己网盘的文件——下载完必须删掉，否则会在用户的网盘里留一堆垃圾 */
    const transferred = []
    return {
      title,
      shareId,
      files: entries.map((e, i) => ({ id: String(i), name: e.name, size: e.size, isDir: false, dir: e.dir || '' })),
      resolve: async (id) => {
        const e = entries[Number(id)]
        if (!e) throw new Error('文件索引无效')
        if (!bduss) {
          const err = new Error(
            '百度网盘的文件没有直链，必须先「转存到你自己的网盘」才能取下载地址，所以需要登录。' +
              '请在「设置 → 网盘账号」里登录百度网盘。',
          )
          err.needCookie = true
          throw err
        }
        const dh = { ...h, Cookie: mergeCookie(cookie, bduss), Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }

        /* 1) 转存到自己网盘的 /PanBox */
        const transfer = await reqJson(
          `https://pan.baidu.com/share/transfer?shareid=${shareid}&from=${share_uk}&bdstoken=${bdstoken}&${APP_QS}`,
          {
            method: 'POST',
            headers: { ...dh, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `fsidlist=%5B${e.fsId}%5D&path=%2FPanBox`,
          },
        )
        const tj = transfer.json || {}
        // errno 12 = 目标目录已存在同名文件，视为成功
        if (tj.errno !== 0 && tj.errno !== 12) throw new Error(`转存失败（errno=${tj.errno}）：${tj.errmsg || tj.show_msg || ''}`)
        await sleep(900)

        /* 2) sign / timestamp */
        const tv = await reqJson(
          `https://pan.baidu.com/api/gettemplatevariable?${APP_QS}&fields=%5B%22sign%22%2C%22timestamp%22%5D`,
          { headers: dh },
        )
        const tvj = (tv.json && tv.json.result) || {}

        /* 3) 在 /PanBox 里找到转存后的 fs_id */
        const rootList = await reqJson(
          `https://pan.baidu.com/api/list?dir=%2FPanBox&order=time&desc=1&showempty=0&web=1&page=1&num=1000&t=${Date.now()}&bdstoken=${bdstoken}&${APP_QS}`,
          { headers: dh },
        )
        const rl = (rootList.json && rootList.json.list) || []
        const hit = rl.find((x) => x.server_filename === e.name) || rl[0]
        if (!hit) throw new Error('转存后未能在 /PanBox 里定位到文件')
        const fsId = String(hit.fs_id)
        const hitPath = String(hit.path || `/PanBox/${hit.server_filename}`)
        /* 转存前就存在的同名文件不算我们的（errno 12 分支）——只有新出现的才登记回收 */
        if (!(transfer.json || {}).errno && !transferred.some((x) => x.fsId === fsId)) {
          transferred.push({ fsId, path: hitPath, name: String(hit.server_filename || e.name) })
        }

        /* 4) 取 dlink */
        const dl = await reqJson(
          `https://pan.baidu.com/api/download?sign=${tvj.sign}&timestamp=${tvj.timestamp}&fidlist=%5B${hit.fs_id}%5D&type=dlink&${APP_QS}`,
          { headers: dh },
        )
        const dj = dl.json || {}
        if (dj.errno !== 0 || !dj.dlink || !dj.dlink[0]) {
          throw new Error(`取直链失败（errno=${dj.errno}）：${dj.errmsg || ''}`)
        }
        return {
          url: dj.dlink[0].dlink,
          headers: { Referer: 'https://pan.baidu.com/', 'User-Agent': BAIDU_UA, Cookie: mergeCookie(cookie, bduss) },
          _transferred: { fsId, cookie: mergeCookie(cookie, bduss) },
        }
      },
      /* 删掉我们转存到 /PanBox 的副本（下载完成后调用） */
      removeTransferred: async () => {
        if (!transferred.length || !bduss) return 0
        const delH = {
          ...h,
          Cookie: mergeCookie(cookie, bduss),
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        }
        let n = 0
        for (const t of transferred.splice(0)) {
          try {
            const r = await reqJson(
              `https://pan.baidu.com/api/filemanager?opera=delete&async=2&onnest=fail&bdstoken=${bdstoken}&${APP_QS}`,
              {
                method: 'POST',
                headers: delH,
                body: 'filelist=' + encodeURIComponent(JSON.stringify([t.path])),
              },
            )
            const info = (r.json && r.json.info) || []
            const bad = info.filter((x) => x && x.errno)
            if ((r.json || {}).errno === 0 && !bad.length) n++
            else
              console.error(
                `[baidu] 删除 /PanBox 副本失败：${t.path} ->`,
                JSON.stringify(r.json || r.text).slice(0, 200),
              )
          } catch (e) {
            console.error('[baidu] 删除 /PanBox 副本异常：', t.path, e && e.message)
          }
        }
        return n
      },
    }
  },
}
