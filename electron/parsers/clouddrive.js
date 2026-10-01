'use strict'

const { req, reqJson, UA_PC_CHROME, UA_QUARK } = require('./util')

/**
 * 夸克 / UC 网盘：同一套 clouddrive 接口的两个站点。
 *
 * 规格来源：qaiu/netdisk-fast-download (MIT) 的 `QkTool.java` / `UcTool.java`，
 * 并用 LinkSwift 与 pan-{qk,uc}.http 抓包交叉验证。
 *
 * 两条路径（先试便宜的，失败才转存）：
 *   A. **游客直取**：用分享自身的 fid + share_fid_token 直接请求 file/download。
 *      小文件可行且不需要任何凭证；夸克超过 10MB 会返回 `code=23018`
 *      （因为它只肯对「你自己网盘里的 fid」发直链）。
 *   B. **转存后取**：把分享文件保存进自己网盘的 /PanBox，再从自己网盘取 dlink。
 *      需要用户自己的 Cookie。这一步是官方接口的既定流程，不涉及任何身份伪造。
 *
 * 站点差异（**不能共用**，UC 的列表端点和夸克完全不同）：
 *   quark: token `/1/clouddrive/share/sharepage/token`，列表 `/1/clouddrive/share/sharepage/detail`
 *   uc   : token `/1/clouddrive/share/sharepage/token`，列表 `/1/clouddrive/transfer_share/detail`
 */

const PRESETS = {
  quark: {
    netdisk: 'quark',
    label: '夸克',
    apiBase: 'https://drive-pc.quark.cn',
    webBase: 'https://pan.quark.cn',
    downloadReferer: 'https://pan.quark.cn/',
    pr: 'ucpro',
    fr: 'pc',
    entry: null,
    tokenPath: '/1/clouddrive/share/sharepage/token',
    detailPath: '/1/clouddrive/share/sharepage/detail',
    /** 必须用 PC 端 UA，否则游客态一律 23018 */
    ua: UA_QUARK,
    /** 最终 CDN 直链要带 Cookie */
    cdnNeedsCookie: true,
    /** 游客态可用（登录后 TTL 55 分钟） */
    cookieName: '__puus',
    shareRe: /(?:pan\.quark\.cn|drive-pc\.quark\.cn|quark\.cn)\/s\/([0-9a-zA-Z]+)/i,
    passcodeRe: /[?&](?:pwd|password|pw)=([0-9a-zA-Z]{4})/i,
  },
  uc: {
    netdisk: 'uc',
    label: 'UC',
    apiBase: 'https://pc-api.uc.cn',
    webBase: 'https://drive.uc.cn',
    downloadReferer: 'https://fast.uc.cn/',
    pr: 'UCBrowser',
    fr: 'pc',
    entry: 'ft',
    tokenPath: '/1/clouddrive/share/sharepage/token',
    detailPath: '/1/clouddrive/transfer_share/detail',
    ua: UA_PC_CHROME,
    /** UC 的 CDN 会拿你的 Cookie/Referer/IP 去 auth-cdn.uc.cn 回调鉴权，没有登录态直接 403
     *  （`RequestDeniedByCallback: require login [auth not found]`） */
    cdnNeedsCookie: true,
    cookieName: '__puus',
    shareRe: /(?:drive\.uc\.cn|fast\.uc\.cn|pc-api\.uc\.cn|\buc\.cn)\/s\/([0-9a-zA-Z]+)/i,
    passcodeRe: /[?&](?:pwd|password|pw)=([0-9a-zA-Z]{4})/i,
  },
}

/** 从 share(23018 之类的) 响应里提取返回码 */
function codeOf(j) {
  return Number((j && (j.code ?? j.status)) || 0)
}

function okOf(j) {
  if (!j) return false
  if (j.status !== undefined && Number(j.status) !== 200) return false
  if (j.code !== undefined && ![0, 200].includes(Number(j.code))) return false
  return true
}

function msgOf(j) {
  return String((j && (j.message || j.msg || j.error)) || '')
}

function makeParser(key) {
  const P = PRESETS[key]

  function qs(extra) {
    const u = new URLSearchParams()
    if (P.entry) u.set('entry', P.entry)
    u.set('fr', P.fr)
    u.set('pr', P.pr)
    for (const [k, v] of Object.entries(extra || {})) {
      if (v !== undefined && v !== null) u.set(k, String(v))
    }
    return u.toString()
  }

  const api = (path, extra) => `${P.apiBase}${path}?${qs(extra)}`

  function headers(cookie, json) {
    const h = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': P.ua,
      Origin: P.webBase,
      Referer: `${P.webBase}/`,
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    }
    if (json) h['Content-Type'] = 'application/json'
    if (cookie) h.Cookie = cookie
    return h
  }

  /** ① 取 stoken */
  async function getStoken(pwdId, passcode, cookie) {
    const body =
      key === 'uc'
        ? { share_for_transfer: true, pwd_id: pwdId, passcode: passcode || '' }
        : { pwd_id: pwdId, passcode: passcode || '' }
    const r = await reqJson(api(P.tokenPath, { __dt: Date.now() }), {
      method: 'POST',
      headers: headers(cookie, true),
      body: JSON.stringify(body),
    })
    const j = r.json || {}
    if (!okOf(j)) {
      const c = codeOf(j)
      const err = new Error(`获取分享令牌失败：${msgOf(j) || `code ${c}`}`)
      if (c === 31001 || /passcode|提取码|密码/i.test(msgOf(j))) err.needPassword = true
      if (c === 31002 || c === 41001) err.message = '分享链接已失效或已被删除'
      throw err
    }
    const d = j.data || {}
    const stoken = d.stoken || d.stoken_v2
    if (!stoken) throw new Error('分享令牌为空，链接可能已失效')
    return stoken
  }

  /** ② 列目录（分页拉全） */
  async function listDir(pwdId, stoken, passcode, pdirFid, cookie) {
    const out = []
    for (let page = 1; page <= 20; page++) {
      const extra =
        P.detailPath === '/1/clouddrive/transfer_share/detail'
          ? { pwd_id: pwdId, passcode: passcode || '', stoken, pdir_fid: pdirFid || '0', _page: page, _size: 100 }
          : {
              pwd_id: pwdId,
              stoken,
              pdir_fid: pdirFid || '0',
              force: '0',
              _page: page,
              _size: 100,
              _fetch_banner: '1',
              _fetch_share: '1',
              _fetch_total: '1',
              _sort: 'file_type:asc,updated_at:desc',
            }
      const r = await reqJson(api(P.detailPath, extra), { headers: headers(cookie) })
      const j = r.json || {}
      if (!okOf(j)) {
        const c = codeOf(j)
        const err = new Error(`读取分享目录失败：${msgOf(j) || `code ${c}`}`)
        if (c === 31001) err.needPassword = true
        throw err
      }
      const list = (j.data && j.data.list) || []
      out.push(...list)
      if (list.length < 100) break
    }
    return out
  }

  async function walk(pwdId, stoken, passcode, cookie) {
    const out = []
    const queue = [{ fid: '0', dir: '' }]
    let guard = 0
    while (queue.length && guard++ < 80) {
      const cur = queue.shift()
      const list = await listDir(pwdId, stoken, passcode, cur.fid, cookie)
      for (const it of list) {
        /* ⚠️ 极性陷阱：clouddrive 里 `file_type: 0` 才是目录，`file_type: 1` 是文件。
           反了的话每个文件都会被当成目录递归下去，最终 entries 恒为空。 */
        const isDir = it.dir === true || Number(it.file_type) === 0
        if (isDir) {
          queue.push({ fid: it.fid, dir: `${cur.dir}${it.file_name}/` })
        } else {
          out.push({
            fid: it.fid,
            fidToken: it.share_fid_token || it.fid_token,
            name: it.file_name,
            size: Number(it.size || 0),
            dir: cur.dir,
          })
        }
      }
    }
    return out
  }

  /** ③-A 游客直取：拿分享自身 fid + fid_token 要直链
   *  实测确认（2026-09）：**无 Cookie 也能拿到 download_url**，返回的是 `dl-guest-*.drive.quark.cn`
   *  的游客直链，`range_size=10485760`（单连接 10MB 分片）。*/
  async function dlinkDirect(pwdId, stoken, entries, cookie) {
    const r = await reqJson(api('/1/clouddrive/file/download', { __dt: Date.now() }), {
      method: 'POST',
      headers: headers(cookie, true),
      body: JSON.stringify({
        fids: entries.map((e) => e.fid),
        fids_token: entries.map((e) => e.fidToken),
        pwd_id: pwdId,
        stoken,
      }),
    })
    const j = r.json || {}
    if (process.env.PANBOX_DEBUG_DL) {
      try {
        require('node:fs').writeFileSync(
          `${process.env.PANBOX_DEBUG_DL}.${P.netdisk}.json`,
          JSON.stringify({ url: r.url, status: r.status, body: r.text.slice(0, 2000) }, null, 2),
        )
      } catch {
        /* ignore */
      }
    }
    if (!okOf(j)) return { error: codeOf(j), message: msgOf(j) || `HTTP ${r.status}` }
    const arr = (j.data && (Array.isArray(j.data) ? j.data : j.data.list)) || []
    const map = new Map()
    for (const it of arr) if (it && it.fid && it.download_url) map.set(it.fid, it.download_url)
    return { map, raw: arr.length, message: msgOf(j) }
  }

  /**
   * 转存的目标目录。
   *
   * `/1/clouddrive/folder/create` 实测 **404 Not Found**（夸克没有这个路径），
   * 参考实现（gopeed-extension-quark）同样是直接 `to_pdir_fid: "0"` 转存到根目录、
   * 下载完再删。所以这里只在根目录里找现成的 `PanBox` 文件夹，找不到就用根目录，
   * 真正的干净靠下载完成后的 `removeTransferred()`。
   */
  async function targetDir(cookie) {
    const r = await reqJson(
      api('/1/clouddrive/file/sort', {
        pdir_fid: '0',
        _page: '1',
        _size: '200',
        _sort: 'file_type:asc,updated_at:desc',
      }),
      { headers: headers(cookie) },
    ).catch(() => null)
    const list = (r && r.json && r.json.data && r.json.data.list) || []
    const hit = list.find((x) => x.file_name === 'PanBox' && (x.dir === true || Number(x.file_type) === 0))
    return hit ? hit.fid : '0'
  }

  /** 删除转存进用户网盘的副本。
   * 会重试：转存刚落盘时立刻删，夸克偶发回非 0（索引还没就绪），
   * 实测隔几秒再删就成功 —— 「用完就删」这条承诺不能因为一次抖动就断掉。 */
  async function removeFids(fids, cookie) {
    if (!fids || !fids.length) return false
    let last = null
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await reqJson(api('/1/clouddrive/file/delete'), {
        method: 'POST',
        headers: headers(cookie, true),
        body: JSON.stringify({ action_type: 2, filelist: fids.slice(), exclude_fids: [] }),
      }).catch(() => null)
      last = r
      if (r && r.json && r.json.code === 0) break
      if (attempt < 3) await new Promise((res) => setTimeout(res, 1200))
    }
    if (process.env.PANBOX_DEBUG_DL) {
      try {
        require('node:fs').writeFileSync(
          `${process.env.PANBOX_DEBUG_DL}.${P.netdisk}.delete.json`,
          JSON.stringify({ fids, response: last }, null, 2),
        )
      } catch {}
    }
    return !!(last && last.json && last.json.code === 0)
  }

  /* 转存进用户网盘的副本 fid，下载完成后由 removeTransferred() 回收 */
  const transferred = []

  /** 分页列出某目录（最多 5 页 ×100） */
  async function listAll(pdirFid, cookie) {
    const out = []
    for (let page = 1; page <= 5; page++) {
      const q = await reqJson(
        api('/1/clouddrive/file/sort', {
          pdir_fid: pdirFid,
          _page: page,
          _size: 100,
          _sort: 'file_type:asc,updated_at:desc',
        }),
        { headers: headers(cookie) },
      ).catch(() => null)
      const l = (q && q.json && q.json.data && q.json.data.list) || []
      out.push(...l)
      if (l.length < 100) break
    }
    return out
  }

  /** 转存后的文件名可能是 `x.zip` / `x(1).zip` / `x(2).zip`，都要认 */
  function sameName(fname, want) {
    if (fname === want) return true
    const i = String(want).lastIndexOf('.')
    const base = i > 0 ? want.slice(0, i) : want
    const ext = i > 0 ? want.slice(i) : ''
    if (fname === base + ext) return true
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${esc(base)}\\(\\d+\\)${esc(ext)}$`).test(fname)
  }

  /** ③-B 转存 → 轮询 → 从自己网盘取 dlink */
  async function dlinkByTransfer(pwdId, stoken, entries, cookie) {
    if (!cookie) {
      const e = new Error(
        `下载${P.label}网盘的文件需要先登录：请在「设置 → 网盘账号」里登录${P.label}（程序会用你自己的账号转存到 /PanBox 再取直链）。`,
      )
      e.needCookie = true
      throw e
    }
    const toFid = await targetDir(cookie)
    /* 转存前先拍一张目录快照：只有「转存之后新出现的文件」才是我们造的副本，
     * 才允许在下载完成后删除。同名老文件很可能是用户自己的东西，绝不能删。 */
    const beforeIds = new Set((await listAll(toFid, cookie)).map((x) => x.fid))
    const save = await reqJson(api('/1/clouddrive/share/sharepage/save'), {
      method: 'POST',
      headers: headers(cookie, true),
      body: JSON.stringify({
        fid_list: entries.map((e) => e.fid),
        fid_token_list: entries.map((e) => e.fidToken),
        to_pdir_fid: toFid,
        pwd_id: pwdId,
        stoken,
        pdir_fid: '0',
        scene: 'link',
      }),
    })
    const sj = save.json || {}
    if (!okOf(sj)) throw new Error(`转存失败：${msgOf(sj) || `code ${codeOf(sj)}`}`)
    const taskId = sj.data && (sj.data.task_id || sj.data.taskId)

    for (let i = 0; taskId && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const t = await reqJson(api('/1/clouddrive/task', { task_id: taskId, retry_index: i }), {
        headers: headers(cookie),
      }).catch(() => null)
      const d = (t && t.json && t.json.data) || {}
      if (Number(d.status) === 2 || Number(d.status) === 3) break
    }

    /* 转存响应里的 `save_as_top_fids` / `save_as_select_top_fids` 就是**落盘后的 fid**。
     * 早前踩过的坑：转存刚返回就拿着这个 fid 调 `file/download` 会回
     * `404 {"code":21001,"message":"file not found [38a61b16…]"}` —— 那不是 fid 错了，
     * 是索引还没就绪。下面的下载重试循环（10 次 × 900ms）就是为它准备的。
     * 只有拿不到 fid（比如转存的是目录、条目数对不上）时才退回**轮询目录**：
     * `/1/clouddrive/file/sort` 索引有延迟，转存刚返回时列目录还看不到新文件。
     * ⚠️ 曾经只用轮询，结果夸克索引慢于 25×700ms 时直接报「未返回下载直链」，
     * 而且那份副本因为没被登记而永久留在用户网盘里 —— 这条快路同时修掉了这两个问题。 */
    const taskData = (sj.data && sj.data.task_resp && sj.data.task_resp.data) || {}
    const saveAs = taskData.save_as || {}
    const hinted = [...(saveAs.save_as_top_fids || []), ...(saveAs.save_as_select_top_fids || [])]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)

    /**
     * 对一批 fid 取直链。`file/download` 偶尔会先回空（转存刚落盘、索引还没就绪），
     * 所以每个 fid 都重试；返回 Map<entryFid, url>。
     */
    async function downloadByFids(pairs) {
      const got = new Map()
      for (const it of pairs) {
        let dl = null
        for (let attempt = 0; attempt < 8; attempt++) {
          dl = await reqJson(api('/1/clouddrive/file/download'), {
            method: 'POST',
            headers: headers(cookie, true),
            body: JSON.stringify({ fids: [it.fid] }),
          }).catch(() => null)
          const a = (dl && dl.json && dl.json.data) || []
          if (a[0] && a[0].download_url) break
          if (attempt < 7) await new Promise((r) => setTimeout(r, 900))
        }
        if (process.env.PANBOX_DEBUG_DL) {
          try {
            require('node:fs').writeFileSync(
              `${process.env.PANBOX_DEBUG_DL}.${P.netdisk}.transfer.json`,
              JSON.stringify({ hit: { fid: it.fid, file_name: it.entry && it.entry.name }, response: dl }, null, 2),
            )
          } catch {}
        }
        const arr = (dl && dl.json && dl.json.data) || []
        if (arr[0] && arr[0].download_url) got.set(it.entry.fid, arr[0].download_url)
      }
      return got
    }

    /** 列目录、按文件名认领 → 返回可直接喂下载的 {entry, fid, ours} 列表 */
    async function collectByPolling() {
      let list = await listAll(toFid, cookie)
      let freshList = list.filter((x) => !beforeIds.has(x.fid))
      for (let i = 0; i < 25 && !freshList.length; i++) {
        await new Promise((r) => setTimeout(r, 700))
        list = await listAll(toFid, cookie)
        freshList = list.filter((x) => !beforeIds.has(x.fid))
      }
      debugDump(list, freshList, false)
      /* 只把「转存前不存在的新文件」登记为待删；命中的若是用户原有的同名文件则绝不删。 */
      const out = []
      for (const e of entries) {
        const fresh = freshList.find((x) => sameName(x.file_name, e.name))
        const hit = fresh || list.find((x) => sameName(x.file_name, e.name))
        if (hit) out.push({ entry: e, fid: hit.fid, ours: !!fresh })
      }
      return out
    }

    function debugDump(list, freshList, usedHint) {
      if (!process.env.PANBOX_DEBUG_DL) return
      try {
        require('node:fs').writeFileSync(
          `${process.env.PANBOX_DEBUG_DL}.save.json`,
          JSON.stringify(
            {
              saveStatus: save.status,
              saveJson: sj,
              taskId,
              saveAs,
              beforeCount: beforeIds.size,
              listCount: list.length,
              list: list.map((x) => ({ fid: x.fid, name: x.file_name, type: x.file_type })),
              freshCount: freshList.length,
              fresh: freshList.map((x) => ({ fid: x.fid, name: x.file_name, size: x.size })),
              hinted,
              searchExit: saveAs.search_exit,
              usedHint,
              want: entries.map((e) => ({ fid: e.fid, name: e.name })),
            },
            null,
            2,
          ),
        )
      } catch {}
    }

    const map = new Map()
    let usedHint = false
    let polled = []

    /* ── 快路：`share/save` 的响应里就带了落盘 fid（`save_as_top_fids`），
     * 省掉等目录索引的时间（`/file/sort` 是最终一致的，实测能慢到 25×700ms 都看不见新文件）。
     * ⚠️ 但这个 fid **不能盲信**：实测同一次转存，服务端有时给回一个拿去
     * `file/download` 就是 `404 code 21001 file not found` 的 fid。
     * 所以快路也是「试」出来的 —— 拿不到直链就退回轮询，绝不因为快路失败就报错。 */
    if (hinted.length === entries.length) {
      usedHint = true
      const pairs = entries.map((e, i) => ({ entry: e, fid: hinted[i], ours: true }))
      const got = await downloadByFids(pairs)
      for (const [k, v] of got) map.set(k, v)
    }

    /* ── 慢路：列目录、按名字认领。快路没拿全时走这里，它同时给出「哪个 fid 是我们造的」的可靠依据。 */
    if (map.size < entries.length) {
      polled = await collectByPolling()
      const todo = polled.filter((it) => !map.has(it.entry.fid))
      const got = await downloadByFids(todo)
      for (const [k, v] of got) map.set(k, v)
    }
    /* `search_exit === true`（查重命中）**不等于**「盘上没有新副本」：
     * 查重索引命中的可能是同内容但**已经被删/改名**的那一份，夸克照样会新落一份 `xxx(1).zip`。
     * 实测（`electron test/cleanup-quark-junk.js`）就抓到过这种泄漏：副本躺在用户网盘里
     * 永远没人回收。所以只要走了快路又没拿到轮询结果，就补一次列目录 ——
     * `collectByPolling()` 的 `ours` 判据（转存前不存在同名文件）是唯一可靠的回收依据，
     * 宁可多花一次列目录的时间，也不能把副本留在用户网盘里。 */
    if (!polled.length && usedHint) polled = await collectByPolling()
    if (!polled.length) debugDump([], [], usedHint)

    /* ── 登记待删。两套依据，都要求「这份副本确实是我们刚造的」：
     *   ① 轮询结果：转存前不存在同名文件 → ours=true（最可靠）；
     *   ② 快路：`search_exit === false` = 服务端没找到同名文件、确实新落了一份盘。
     *      `search_exit === true` 时**不再**直接放弃登记，而是靠上面补的那次轮询来判定。 */
    if (polled.length) {
      for (const it of polled) if (it.ours && map.has(it.entry.fid)) transferred.push(it.fid)
    } else if (usedHint && saveAs.search_exit === false) {
      entries.forEach((e, i) => {
        if (map.has(e.fid)) transferred.push(hinted[i])
      })
    } else if (usedHint && map.size) {
      console.warn(
        `[${P.netdisk}] search_exit=${saveAs.search_exit}，未登记回收（保守：绝不误删用户文件）`,
      )
    }

    return { map }
  }

  function cdnHeaders(cookie) {
    const h = {
      'User-Agent': P.ua,
      Referer: P.downloadReferer,
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    }
    if (P.cdnNeedsCookie && cookie) h.Cookie = cookie
    return h
  }

  /** 只读响应头就断开，绝不把文件体吸进内存 */
  function peek(url, headers, timeout = 20000) {
    return new Promise((resolve) => {
      let u
      try {
        u = new URL(url)
      } catch {
        return resolve({ status: 0 })
      }
      const mod = u.protocol === 'http:' ? require('node:http') : require('node:https')
      const r = mod.request(
        {
          method: 'GET',
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + u.search,
          headers: { ...headers, Range: 'bytes=0-1' },
          timeout,
        },
        (res) => {
          const st = res.statusCode
          res.destroy()
          resolve({ status: st })
        },
      )
      r.on('timeout', () => {
        r.destroy()
        resolve({ status: 0 })
      })
      r.on('error', () => resolve({ status: 0 }))
      r.end()
    })
  }

  /**
   * 最终闸门。夸克/UC 的 CDN 只认网页 JS 现场种的 `__puus`：凭证一旦失效，
   * 转存接口照样回 200，只有真正去 CDN 拉数据时才 412/403 —— 也就是
   * 「解析成功、下载必失败」。这里先用 Range 探一次，把沉默失败翻译成人话。
   */
  async function preflight(item, preset) {
    const r = await peek(item.url, item.headers || {})
    if (r.status === 401 || r.status === 403 || r.status === 412) {
      const e = new Error(
        `${preset.label}的下载直链被 CDN 拒绝（HTTP ${r.status}）：登录凭证已失效。` +
          `请在「设置 → 网盘账号」里重新登录${preset.label}，然后重新解析。`,
      )
      e.needCookie = true
      throw e
    }
  }

  return {
    netdisk: P.netdisk,

    test(url) {
      return P.shareRe.test(String(url))
    },

    async open(url, ctx = {}) {
      const m = P.shareRe.exec(String(url))
      if (!m) throw new Error('无法识别分享 ID')
      const pwdId = m[1]
      const cookie = ctx.cookie || ''
      let passcode = String(ctx.password || '').trim()
      if (!passcode) {
        const pm = P.passcodeRe.exec(String(url))
        if (pm) passcode = pm[1]
      }

      const stoken = await getStoken(pwdId, passcode, cookie)
      const entries = await walk(pwdId, stoken, passcode, cookie)
      if (!entries.length) throw new Error('分享内容为空或已失效')

      const files = entries.map((e, i) => ({
        id: String(i),
        name: e.name,
        size: e.size,
        isDir: false,
        dir: e.dir,
      }))

      /** 一批文件批量解析（点「开始下载」时一次算出来，省一轮 API）
       *  ⚠️ 调用方可能传两种东西：内部 entry（带 fidToken）或只是 `{id}`/`{fid}`
       *  形式的**会话下标**。统一在这里还原成 entry，否则会把下标当 fid 发出去，
       *  服务端回 `403 / 41020 转存文件token校验异常`。 */
      async function resolveMany(list) {
        const items = list
          .map((x) => {
            if (x && x.fidToken) return x
            const idx = Number(x && x.id !== undefined ? x.id : x.fid)
            return Number.isFinite(idx) ? entries[idx] : undefined
          })
          .filter(Boolean)
        if (!items.length) throw new Error('文件索引无效')

        /* 有两张「不用转存」的错觉，都已被实测否掉：
         *   1. 游客态 `/file/download` 确实会返回 download_url，但域名是 `dl-guest-*.drive.quark.cn`
         *      —— CDN 端一律 412（夸克 Tengine）/ 403（UC 的 OSS callback）拒绝，与 header、
         *      TLS 指纹、HTTP/2 都无关（用 Chromium 的 net.fetch 同样被拒）。
         *   2. 带 Cookie 走游客接口，拿到的还是 guest 域名。
         * 所以：**有凭证就直接转存**，没凭证才试游客直取，且拿到 guest 域名就当失败。 */
        let got
        if (cookie) {
          let transferErr = null
          got = await dlinkByTransfer(pwdId, stoken, items, cookie).catch((e) => {
            transferErr = e
            return null
          })
          /* 转存这条路也是会坏的：夸克的同名查重索引在副本被删掉之后仍会命中，
           * 于是 `share/save` 回 `search_exit: true` + 一个**已经不存在**的 fid，
           * 快路 `file/download` 回 `404 code 21001`，轮询列目录也找不到文件（实测）。
           * 这时退回「用分享自己的 fid 直接取直链」——带 Cookie 的 CDN 回调会放行
           * （游客态那条 dl-guest 直链才会被 412 拒）。 */
          if (!got || !got.map || !got.map.size) {
            const d = await dlinkDirect(pwdId, stoken, items, cookie).catch(() => null)
            if (d && d.map && d.map.size) got = d
            else if (transferErr && !(got && got.map && got.map.size)) throw transferErr
          }
        } else {
          got = await dlinkDirect(pwdId, stoken, items, cookie).catch((e) => ({ error: -1, message: e.message }))
          if (got.map && got.map.size) {
            const first = [...got.map.values()][0]
            if (/\/\/dl-guest/i.test(first)) {
              const e = new Error(
                `${P.label}网盘需要登录后才能下载：游客直链（dl-guest）会被 CDN 直接拒绝（412/403）。` +
                  `请在「设置 → 网盘账号」里登录${P.label}。`,
              )
              e.needCookie = true
              throw e
            }
          }
        }
        if (!got || !got.map || !got.map.size) {
          got = await dlinkByTransfer(pwdId, stoken, items, cookie).catch((e) => ({ error: -1, message: e.message }))
        }
        const out = []
        for (const e of items) {
          const u = got.map && got.map.get(e.fid)
          if (u) out.push({ entry: e, url: u, headers: cdnHeaders(cookie) })
        }
        if (!out.length) {
          throw new Error(
            `${P.label}网盘未返回下载直链${got.error ? `（code=${got.error} ${got.message || ''}）` : ''}，请确认已登录或稍后重试`,
          )
        }
        await preflight(out[0], P)
        return out
      }

      return {
        title: `${P.label}分享 ${pwdId}`,
        shareId: pwdId,
        files,
        resolve: async (id) => {
          const one = entries[Number(id)]
          if (!one) throw new Error('文件索引无效')
          const got = await resolveMany([one])
          return { url: got[0].url, headers: cdnHeaders(cookie) }
        },
        resolveMany,

        /** 下载完成后调用：把转存进来的副本从用户网盘删掉，别留一堆 `xxx(1).zip`。
         *  ⚠️ 绝不能在下载开始前调用——直接是 CDN 的签名链接，删了源文件可能当场失效。 */
        removeTransferred: () => removeFids(transferred, cookie),
      }
    },
  }
}

module.exports = { makeParser, PRESETS }
