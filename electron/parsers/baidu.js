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

    const DIR = '/PanBox'
    const dh = { ...h, Cookie: mergeCookie(cookie, bduss), Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    const fh = { ...dh, 'Content-Type': 'application/x-www-form-urlencoded' }

    /** 列自己网盘里的目录（/api/list）。目录不存在时返回 []（errno -9 / -7）。 */
    const listOwn = async (dirPath) => {
      const r = await reqJson(
        `https://pan.baidu.com/api/list?dir=${encodeURIComponent(dirPath)}&order=time&desc=1&showempty=0` +
          `&web=1&page=1&num=1000&t=${Date.now()}&bdstoken=${bdstoken}&${APP_QS}`,
        { headers: dh },
      )
      const j = r.json || {}
      if (j.errno !== 0 && j.errno !== -9 && j.errno !== -7) throw new Error(errnoText(j.errno, j.errmsg))
      return j.list || []
    }

    /** `/share/transfer` 要求目标目录**已经存在**（实测不存在时报 `errno=2 转存路径不存在`），所以先建。 */
    const ensureDir = async (dirPath) => {
      const probe = await reqJson(
        `https://pan.baidu.com/api/list?dir=${encodeURIComponent(dirPath)}&order=time&desc=1&showempty=0` +
          `&web=1&page=1&num=1&t=${Date.now()}&bdstoken=${bdstoken}&${APP_QS}`,
        { headers: dh },
      )
      if ((probe.json || {}).errno === 0) return
      const mk = await reqJson(`https://pan.baidu.com/api/create?bdstoken=${bdstoken}&${APP_QS}`, {
        method: 'POST',
        headers: fh,
        body: `path=${encodeURIComponent(dirPath)}&isdir=1&block_list=%5B%5D&size=`,
      })
      const mj = mk.json || {}
      // errno -8 = 目录已存在
      if (mj.errno !== 0 && mj.errno !== -8) {
        throw new Error(`创建目录 ${dirPath} 失败（errno=${mj.errno}）：${mj.errmsg || mj.show_msg || ''}`)
      }
      await sleep(600)
    }

    /** 同名冲突时百度会存成 `名字(1).ext`，所以要能把 `名字(2).zip` 认回 `名字.zip`。 */
    const variant = (n) => {
      const m = /^(.*?)(?:\((\d+)\))?(\.[^.]+)$/.exec(String(n))
      return m ? { base: m[1], ext: m[3] } : null
    }

    /**
     * 批量解析：**一次**转存 + **一次** filemetas 把一整批文件全拿下来。
     *
     * 旧实现是每个文件各转存一次、各取一次 dlink —— 一个 8 文件的目录分享要打 16 轮 API，
     * 又慢又更容易触发百度风控。`/share/transfer` 的 `fsidlist` 和 `/api/filemetas` 的 `fsids`
     * 本来就支持数组，批量是顺手的事。
     *
     * @param {Array<{id?:string,name?:string,fsId?:string}>} list 文件索引或内部 entry
     * @returns {Promise<Array<{entry:object,url:string|null,headers:object}>>} 与入参同序
     */
    const resolveManyBatch = async (list) => {
      const items = list
        .map((x) => {
          if (x && x.fsId) return x
          const idx = Number(x && x.id !== undefined ? x.id : x.fid)
          return Number.isFinite(idx) ? entries[idx] : undefined
        })
        .filter(Boolean)
      if (!items.length) throw new Error('文件索引无效')
      if (!bduss) {
        const err = new Error(
          '百度网盘的文件没有直链，必须先「转存到你自己的网盘」才能取下载地址，所以需要登录。' +
            '请在「设置 → 网盘账号」里登录百度网盘。',
        )
        err.needCookie = true
        throw err
      }

      await ensureDir(DIR)
      /* 转存**之前**先记下目录里已有的 fs_id —— 只有新出现的才是我们转存进去的副本，
       * 绝不能把用户本来就有的同名文件当成副本删掉。 */
      const beforeIds = new Set((await listOwn(DIR)).map((x) => String(x.fs_id)))

      /* 1) 一次转存整批文件到自己的 /PanBox */
      const transfer = await reqJson(
        `https://pan.baidu.com/share/transfer?shareid=${shareid}&from=${share_uk}&bdstoken=${bdstoken}&${APP_QS}`,
        {
          method: 'POST',
          headers: fh,
          body: `fsidlist=%5B${items.map((x) => x.fsId).join(',')}%5D&path=${encodeURIComponent(DIR)}`,
        },
      )
      const tj = transfer.json || {}
      /* errno 12 = 目标目录已存在同名文件；errno 4 = "文件已转存"（同一份额里同一个文件之前转过）。
       * 两者都视为成功——复用 /PanBox 里已有的那份继续取直链。
       * 注意：这种情况命中的文件在 beforeIds 里，**不会**被登记回收（绝不删用户本来就有的东西）。 */
      if (tj.errno !== 0 && tj.errno !== 12 && tj.errno !== 4) {
        throw new Error(`转存失败（errno=${tj.errno}）：${tj.errmsg || tj.show_msg || ''}`)
      }
      await sleep(900)

      /* 2) 在 /PanBox 里把每个文件认领到具体的 fs_id。
       * `used` 保证两个不同的文件不会同时认领到同一份副本。 */
      const owned = await listOwn(DIR)
      const fresh = owned.filter((x) => !beforeIds.has(String(x.fs_id)))
      const used = new Set()
      const claimed = []
      for (const e of items) {
        const want = variant(e.name)
        const pick = (pool) =>
          pool.find((x) => !used.has(String(x.fs_id)) && x.server_filename === e.name) ||
          (want
            ? pool.find((x) => {
                if (used.has(String(x.fs_id))) return false
                const v = variant(x.server_filename)
                return v && v.base === want.base && v.ext === want.ext
              })
            : null)
        /* 单文件时允许退化成「新出现的第一份」；多文件时绝不乱认领（宁可报错，也不下错文件） */
        const hit =
          pick(fresh) || pick(owned) || (items.length === 1 ? fresh.find((x) => !used.has(String(x.fs_id))) : null)
        if (!hit) {
          claimed.push({ entry: e, fsId: null })
          continue
        }
        used.add(String(hit.fs_id))
        const fsId = String(hit.fs_id)
        /* 只有**新出现**的文件才登记回收（命中用户原有的同名文件时绝不删） */
        if (!beforeIds.has(fsId) && !transferred.some((x) => x.fsId === fsId)) {
          transferred.push({
            fsId,
            path: String(hit.path || `${DIR}/${hit.server_filename}`),
            name: String(hit.server_filename || e.name),
          })
        }
        claimed.push({ entry: e, fsId })
      }

      /* 3) 取 dlink（**一次请求拿回整批**）。
       * ⚠️ 2026 年 `/api/download?type=dlink&sign=…` 已经失效：`/api/gettemplatevariable`
       * 不再返回 `sign` 字段（`fields=["sign"]` 回空数组），少了 sign 就只会得到 errno=113/2。
       * 现在网页端用的是 **`/api/filemetas?dlink=1&fsids=[…]`**，实测 errno=0 并直接给出
       * `https://d.pcs.baidu.com/file/…?fid=…&sign=…` 直链。 */
      const links = new Map()
      const fsIds = claimed.map((c) => c.fsId).filter(Boolean)
      if (fsIds.length) {
        const fm = await reqJson(`https://pan.baidu.com/api/filemetas?dlink=1&fsids=%5B${fsIds.join(',')}%5D&${APP_QS}`, {
          headers: dh,
        })
        const fj = fm.json || {}
        if (fj.errno !== 0) throw new Error(`取直链失败（errno=${fj.errno}）：${fj.errmsg || ''}`)
        for (const it of fj.info || []) links.set(String(it.fs_id), it.dlink)
      }

      const dheaders = {
        Referer: 'https://pan.baidu.com/',
        'User-Agent': BAIDU_UA,
        Cookie: mergeCookie(cookie, bduss),
      }
      return claimed.map((c) => ({ entry: c.entry, url: links.get(c.fsId) || null, headers: dheaders }))
    }

    return {
      title,
      shareId,
      files: entries.map((e, i) => ({ id: String(i), name: e.name, size: e.size, isDir: false, dir: e.dir || '' })),
      resolveMany: resolveManyBatch,
      resolve: async (id) => {
        const out = await resolveManyBatch([{ id }])
        const r = out[0]
        if (!r || !r.url) throw new Error('取直链失败：未能解析出下载地址')
        return { url: r.url, headers: r.headers }
      },
      /* 删掉我们转存到 /PanBox 的副本（下载完成后调用）。
       * 一次请求把整批路径都删掉（`filelist` 收数组），失败才退化成逐个删。 */
      removeTransferred: async () => {
        if (!transferred.length || !bduss) return 0
        const delH = {
          ...h,
          Cookie: mergeCookie(cookie, bduss),
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        }
        const del = async (paths) => {
          const r = await reqJson(
            `https://pan.baidu.com/api/filemanager?opera=delete&async=2&onnest=fail&bdstoken=${bdstoken}&${APP_QS}`,
            {
              method: 'POST',
              headers: delH,
              body: 'filelist=' + encodeURIComponent(JSON.stringify(paths)),
            },
          )
          const info = (r.json && r.json.info) || []
          const bad = info.filter((x) => x && x.errno)
          return { ok: (r.json || {}).errno === 0 && !bad.length, raw: r.json || r.text, bad }
        }
        const todo = transferred.splice(0)
        let n = 0
        try {
          const one = await del(todo.map((t) => t.path))
          if (one.ok) return todo.length
          /* 批量失败（常见于某个路径已不存在）→ 退化成逐个删，尽量把能删的都删掉 */
          console.error('[baidu] 批量删除 /PanBox 副本未全部成功，改为逐个删除：', JSON.stringify(one.raw).slice(0, 200))
        } catch (e) {
          console.error('[baidu] 批量删除 /PanBox 副本异常，改为逐个删除：', e && e.message)
        }
        for (const t of todo) {
          try {
            const r = await del([t.path])
            if (r.ok) n++
            else console.error(`[baidu] 删除 /PanBox 副本失败：${t.path} ->`, JSON.stringify(r.raw).slice(0, 200))
          } catch (e) {
            console.error('[baidu] 删除 /PanBox 副本异常：', t.path, e && e.message)
          }
        }
        return n
      },
    }
  },
}
