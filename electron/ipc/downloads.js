'use strict'
/* 下载域：解析结果入队、队列操作（暂停/继续/插队/换直链/移除/删文件/全部暂停与继续），
 * 以及「换直链」那套内部实现（readdTask / refreshTask / 直链过期自动换链）。
 * 这一域 handler 最多、也最常改，单独成文件后动队列逻辑只读这一个文件。
 * 依赖里只有 boot/…/hostOf 这些 main.js 模块级局部来自 ctx，窗口 win 走 ctx.win() 现取。 */
const { ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const settings = require('../core/settings')
const aria2 = require('../core/aria2')
const seg = require('../core/segmentDownloader')
const hls = require('../core/hls')
const tasks = require('../core/taskManager')
const trash = require('../core/trash')
const proxy = require('../core/proxy')
const parsers = require('../parsers')
const { detectNetdisk, sanitizeFileName } = require('../parsers/util')
const identity = require('../parsers/identity')
/* 用户取消过的下载身份：投递（含分段探测失败后的回退、换直链）落地前要核对，
 * 否则会出现「删掉的任务过一会儿自己又开始下」（详见 core/cancelGuard.js） */
const cancelGuard = require('../core/cancelGuard')

/**
 * @param {object} ctx main.js 组装的主进程局部依赖（见 main.js 里 require('./ipc') 那处调用）
 */
function register(ctx) {
  /* 与原来 registerIpc 闭包里的同名局部一一对应；下面各 handler 与内部函数逐字照搬。
   * preempted 是主进程里那张「被插队挤下去的任务」表，必须与 resumePreempted 共用同一个 Map，
   * 所以整只传进来（解构拿到的是同一个引用）。win 会在运行期换窗口，一律走 ctx.win() 现取。 */
  const {
    boot,
    addResolved,
    localEngine,
    pickVictim,
    taskLabel,
    preempted,
    hardRemove,
    taskFile,
    purgeTask,
    recycleTransferCopy,
    cleanupRemember,
    cleanupTake,
    buildHeaders,
    segConnectionsFor,
    playlistKind,
    hostOf,
  } = ctx

  ipcMain.handle('downloads:add', async (_e, payload) => {
    const cfg = settings.load()
    const netdisk = (payload && payload.netdisk) || 'unknown'
    const source = (payload && payload.source) || ''
    let session = null
    try {
      if (payload && payload.sessionId && Array.isArray(payload.ids)) {
        session = await parsers.resolveFiles({ sessionId: payload.sessionId, ids: payload.ids })
      } else if (payload && Array.isArray(payload.files)) {
        session = payload.files
      }
    } catch (e) {
      return { ok: false, added: [], errors: [e && e.message ? e.message : String(e)] }
    }
    if (!session || !session.length) {
      return { ok: false, added: [], errors: ['没有可下载的文件'] }
    }

    const r = await addResolved(cfg, {
      session,
      netdisk,
      source,
      title: (payload && payload.title) || 'PanBox',
      sessionId: payload && payload.sessionId ? String(payload.sessionId) : '',
    })
    return { ok: r.added.length > 0, added: r.added, errors: r.errors }
  })

  ipcMain.handle('downloads:list', () => {
    const list = tasks.list()
    boot('tasks-list', 'n=' + list.length)
    return list
  })

  ipcMain.handle('downloads:pause', async (_e, gid) => {
    try {
      const en = localEngine(gid)
      await (en ? en.pause(gid) : aria2.pause(gid))
      tasks.kick()
      return { ok: true }
    } catch (e) {
      /* 原来吞成 false，界面拿到就什么也不做 —— 用户点了暂停没反应也不知道为什么 */
      return { ok: false, message: '暂停失败：' + ((e && e.message) || String(e)) }
    }
  })
  ipcMain.handle('downloads:resume', async (_e, gid) => {
    try {
      const en = localEngine(gid)
      await (en ? en.unpause(gid) : aria2.unpause(gid))
      tasks.kick()
      return { ok: true }
    } catch (e) {
      return { ok: false, message: '继续失败：' + ((e && e.message) || String(e)) }
    }
  })

  /* 插队 ⬆：把这条任务顶到最前面，必要时暂停一条正在下载的给它腾位置。
   * - 排队中的任务：aria2 用 changePosition(gid, 0, 0) 挪到队首；本地引擎有自己的队列，用 jumpTop()。
   * - 名额不够：各挑一条「进度最低」的 active 任务暂停，记进 preempted，等插队任务结束后自动恢复。
   * - 已经在下 / 已经结束的任务：只回报状态，不动队列。 */
  ipcMain.handle('downloads:jumpTop', async (_e, gid) => {
    const id = String(gid || '')
    if (!id) return { ok: false, message: '任务不存在' }
    const cfg = settings.load()
    const limit = Math.max(1, Number(cfg.maxConcurrent) || 1)
    const paused = []
    try {
      const en = localEngine(id)
      if (en) {
        const st0 = en.tellStatus(id)
        if (!st0) return { ok: false, message: '任务不存在' }
        if (st0.status === 'complete' || st0.status === 'error') {
          return { ok: false, message: `「${st0.name}」已经不在队列里了` }
        }
        if (st0.status === 'paused') await en.unpause(id)
        en.jumpTop(id)
        if (en.tellStatus(id).status === 'waiting' && en.activeCount() >= limit) {
          const victim = pickVictim(en.list(), id)
          if (victim) {
            await en.pause(victim.gid)
            paused.push({ gid: victim.gid, engine: en === hls ? 'hls' : 'seg', name: taskLabel(victim.gid) })
          }
        }
      } else {
        const st0 = await aria2.tellStatus(id).catch(() => null)
        if (!st0) return { ok: false, message: '任务不存在' }
        if (st0.status === 'complete' || st0.status === 'error') {
          return { ok: false, message: `「${taskLabel(id)}」已经不在队列里了` }
        }
        if (st0.status === 'paused') await aria2.unpause(id).catch(() => {})
        await aria2.changePosition(id, 0, 0).catch(() => {})
        const gs = await aria2.getGlobalStat().catch(() => null)
        if ((Number(gs && gs.numActive) || 0) >= limit) {
          const victim = pickVictim(await aria2.tellActive().catch(() => []), id)
          if (victim) {
            await aria2.pause(victim.gid).catch(() => {})
            paused.push({ gid: victim.gid, engine: 'aria2', name: taskLabel(victim.gid) })
          }
        }
      }
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) }
    }
    /* 被这次插队挤下去的任务要记着，等它下完再放回来。
     * 同一个任务可能被插队两次（连续点两下 ⬆）：第二次的名单必须**并进**上一条，
     * 整条覆盖会把第一次暂停的那些任务从记录里抹掉 —— 再也没人恢复它们，永远停在暂停。
     * 按 gid 去重，免得同一条被 pause/unpause 两遍。`at` 字段从来没人读过，去掉了。 */
    if (paused.length) {
      const rec = preempted.get(id)
      rec
        ? (rec.items = [...new Map([...rec.items, ...paused].map((p) => [p.gid, p])).values()])
        : preempted.set(id, { items: paused })
    }
    tasks.kick()
    let status = ''
    try {
      const en1 = localEngine(id)
      status = en1 ? en1.tellStatus(id).status : String((await aria2.tellStatus(id)).status || '')
    } catch {
      /* ignore */
    }
    return { ok: true, status, paused: paused.map((p) => p.name) }
  })

  /* 「换直链」：重新解析同一条分享、拿一条新的下载地址替换掉当前任务的地址。
   * 直链过期、或者某次分到的 CDN 节点太慢时用得上（也相当于迅雷客户端那套
   * 「重建任务重新调度节点」的合法等价物）。 */
  /**
 * 把「一条已经取到的新直链」重新排进队列，换掉原来的那条任务。
 *
 * 为什么是「移除 + 重新加入」而不是 aria2 的 `changeUri` 热替换：
 * 本机实测（aria2 1.37）对一个正在下载的任务调 `changeUri` 之后，aria2 进程会失联，
 * 紧接着所有 RPC 都报 `TypeError: fetch failed`，任务进度停在原地。
 * `.aria2` 控制文件还在，`--continue=true` 会让它从断点续传，不会白下。
 *
 * @param o     `tasks.info(gid).origin`（保存着来源、名字、引擎与原参数）
 * @param fresh `{url, headers}` 新地址
 * @returns `{gid, engine, was, live}`
 */
async function readdTask(gid, o, fresh) {
  /* 这一轮投递的起点：用来判断「取消」是不是发生在这之后（见下面的 cancelGuard 检查） */
  const startedAt = Date.now()
  /* 交给引擎的那份头补一层浏览器身份（换链换来的地址同样是「浏览器能用、程序不一定」
   * 那一类）；`fresh.headers` 保持原样，它跟着任务记录走。 */
  const send = identity.forRequest(fresh.url, fresh.headers || {})
  const header = buildHeaders(send)
  const opts = { ...(o.opts || {}) }
  delete opts.gid
  if (header.length) opts.header = header

  let st = null
  try {
    st = await aria2.tellStatus(gid)
  } catch {
    /* 任务可能已经被删了，或者本来就在本地引擎上，照样走重新加入的路径 */
  }
  const en0 = localEngine(gid)
  if (!st && en0) {
    try {
      st = en0.tellStatus(gid)
    } catch {
      /* ignore */
    }
  }
  const live = st && (st.status === 'active' || st.status === 'paused' || st.status === 'waiting')

  /* 旧 gid 的结果要从停止列表里清掉，否则旧任务会以「已停止」的形态赖在界面上
   * （重试次数与 downloads:remove / purgeTask 统一在 hardRemove 里） */
  await hardRemove(gid, { label: 'readd' })
  tasks.forget(gid)
  cleanupTake(o.name)
  /* 与「初次添加」保持同一套参数：连接数取设置里那份（0 = 不走分段引擎，退回 aria2），
   * 忽略证书也要跟着带上 —— 否则勾了「忽略证书错误」的任务换一次直链就又开始校验证书。 */
  const cfgNow = settings.load()
  const segConns = segConnectionsFor(cfgNow, o.netdisk)
  let ngid = ''
  let nengine = 'aria2'
  /* 换链换来的可能是一条播放列表地址（论文站不会，但通用直链会），判据与初次添加同一份 */
  if (playlistKind(fresh.url, { headers: fresh.headers, mime: fresh.mime }) === 'hls') {
    try {
      ngid = await hls.add({
        url: fresh.url,
        headers: send,
        dir: opts.dir,
        name: o.name,
        netdisk: o.netdisk,
        source: o.source,
        proxy: o.netdisk === 'direct' ? proxy.effective(cfgNow) : '',
        insecure: !!cfgNow.ignoreCert,
      })
      nengine = 'hls'
      boot('add-hls', o.name, `host=${hostOf(fresh.url)} refresh=1`)
    } catch (e) {
      boot('hls-fallback', 'refresh', o.name, (e && e.message) || String(e))
    }
  }
  if (!ngid && o.engine === 'seg' && segConns) {
    try {
      ngid = await seg.add({
        url: fresh.url,
        headers: send,
        dir: opts.dir,
        out: sanitizeFileName(o.name),
        connections: segConns,
        netdisk: o.netdisk,
        source: o.source,
        proxy: o.netdisk === 'direct' ? proxy.effective(cfgNow) : '',
        insecure: !!cfgNow.ignoreCert,
      })
      nengine = 'seg'
    } catch (e) {
      boot('seg-fallback', 'refresh', o.name, (e && e.message) || String(e))
    }
  }
  if (!ngid) {
    ngid = await aria2.addUri([fresh.url], opts)
    nengine = 'aria2'
  }
  /* 重新解析 + 重新入列慢起来要好几秒，用户完全可能在这中间把任务删掉。
   * 删了就把刚加进去的这条也撤掉，别让它在队列里自己复活。 */
  if (cancelGuard.cancelledAfter(opts.dir, o.name, startedAt)) {
    await hardRemove(ngid, { label: 'add-cancelled' }).catch(() => {})
    boot('add-cancelled', o.name, `gid=${ngid} where=readd`)
    return { gid: '', engine: nengine, was: st ? st.status : 'gone', live: !!live, cancelled: true }
  }
  tasks.remember(ngid, {
    name: o.name,
    netdisk: o.netdisk,
    source: o.source,
    dir: opts.dir,
    engine: nengine,
    origin: { ...o, engine: nengine },
  })
  tasks.kick()
  return { gid: ngid, engine: nengine, was: st ? st.status : 'gone', live: !!live }
}

/* 自动换过链的任务：换完还失败就不再折腾（同一个 gid 只自动重来一次）。
 * ⚠️ 这一段必须排在「注册 tasks.on('update')」之前执行完：事件回调是在另一个时机被调的，
 * 但按名引用的东西如果还没求值（const/let 还在 TDZ 里），回调一进去就 ReferenceError ——
 * 而那个异常会顺着 emit 冒进 _tick()，把这一轮的队列列表整个丢掉（界面就永远停在旧列表）。 */
var autoRefreshed = new Set()

/** 这条报错像不像「地址过期/被拒」：过期的地址重试多少次都是同样的错，换链才有意义 */
var looksLikeAddrExpired = function (t) {
  const code = String((t && t.errorCode) || '')
  if (!code || code === '0') return false
  /* aria2：16 = 文件已存在之类，22 = HTTP 响应头异常（403/404 都落这里） */
  return /^(19|22|23)$/.test(code)
}

/**
 * 「直链过期」这种失败自动换一次直链（只换一次，换完还失败就不再折腾）。
 *
 * 为什么需要：论文站预签名地址只有 5 分钟，夸克/百度这类网盘直链也会过期；
 * 一条已经躺在队列里的任务，用户过一会儿点「继续」时地址早就死了，
 * 引擎只会一遍遍重试同一个死地址，界面上停在 0%。
 *
 * @returns 真的发起了换链就返回 true
 */
var autoRefreshExpired = async function (list) {
  const busy = (list || []).some((t) => t.status === 'active' || t.status === 'waiting')
  if (busy) return false
  for (const t of list || []) {
    const gid = String(t.gid || '')
    if (!gid || t.status !== 'error') continue
    if (autoRefreshed.has(gid)) continue
    if (!looksLikeAddrExpired(t)) continue
    const meta = tasks.info(gid)
    const o = meta && meta.origin
    if (!o || !o.source) continue
    /* 只当「同一个 gid 不重复折腾」的备忘录用，别让它无限长大：
     * 满了就先丢掉最早的一批（Set 保持插入顺序）。 */
    if (autoRefreshed.size >= 500) {
      let n = 100
      for (const k of autoRefreshed) {
        autoRefreshed.delete(k)
        if (--n <= 0) break
      }
    }
    autoRefreshed.add(gid)
    boot('auto-refresh', o.name, `gid=${gid} code=${t.errorCode || ''}`)
    if (ctx.win() && !ctx.win().isDestroyed()) {
      ctx.win().webContents.send('downloads:notice', { text: `「${o.name}」的下载地址过期了，已换一条新的接着下` })
    }
    const r = await refreshTask(gid).catch(() => null)
    boot('auto-refresh-done', o.name, r && r.ok ? `ok gid=${r.gid}` : `fail ${(r && r.message) || ''}`)
    return true
  }
  return false
}

/**
 * 按「来源」重新取一条直链给这个任务换上（界面上那个「换直链」按钮走的就是这条）。
 * @returns `{ok, gid?, message, name?}`
 */
var refreshTask = async function (gid) {
  const meta = tasks.info(gid)
  const o = meta && meta.origin
  if (!o || !o.source) {
    return { ok: false, message: '这个任务没有可重新解析的来源（只有经「解析 → 开始下载」加入的任务支持换直链）' }
  }
  const cfg = settings.load()
  const url = String(o.url || '')
  const nd = detectNetdisk(url)
  let fresh = null
  let newSession = ''
  try {
    /* 论文站的投递地址是「签一次用 5 分钟」的：重新解析拿到的很可能还是同一条
     * （页面里的按钮地址不会变），但它 302 的终点每次都是新的 —— 所以这里先换新地址，
     * 换不出来再退回「重新解析一遍」。 */
    if (nd === 'ssrn' && parsers.PARSERS.ssrn && parsers.PARSERS.ssrn.isDelivery(url)) {
      /* Cookie 不用从别处找：主进程里那份浏览器现场（插件交过来的）就有，
       * resolveDelivery 自己会按主机去取。 */
      const got = await parsers.PARSERS.ssrn.resolveDelivery(url, { headers: o.headers || {} })
      if (got && got.ok) fresh = { url: got.url, headers: got.headers || {} }
    }
    if (!fresh) {
      const { results } = await parsers.parseShare({ text: o.source, password: '', settings: cfg })
      const r = (results || []).find((x) => x.ok)
      if (!r) throw new Error((results && results[0] && results[0].message) || '重新解析失败')
      const plain = (s) => String(s || '').replace(/^.*[\\/]/, '')
      let idx = r.files.findIndex((f) => f.name === o.name && String(f.dir || '') === String(o.dir || ''))
      if (idx < 0) idx = r.files.findIndex((f) => plain(f.name) === plain(o.name))
      if (idx < 0) throw new Error(`重新解析后没有找到同名文件：${o.name}`)
      const got = await parsers.resolveFiles({ sessionId: r.sessionId, ids: [String(idx)] })
      if (!got.length) throw new Error('重新解析没有拿到新直链')
      fresh = got[0]
      newSession = r.sessionId
    }
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e), name: o.name }
  }
  try {
    const r = await readdTask(gid, o, fresh)
    /* 用户在换链过程中把这条删了：新的那条也已经撤掉，不要再弹「已重新加入队列」 */
    if (r.cancelled) return { ok: false, message: `「${o.name}」已经被移除，没有再重新加入队列`, name: o.name }
    if (newSession) cleanupRemember(o.name, newSession)
    boot('refresh', o.name, `re-add ok gid=${r.gid} engine=${r.engine} was=${r.was} live=${r.live}`)
    return { ok: true, gid: r.gid, name: o.name, message: '已用新的下载地址重新加入队列（会从断点接着下）' }
  } catch (e) {
    boot('refresh-err', (e && e.stack) || String(e))
    return { ok: false, message: '换直链失败：' + ((e && e.message) || String(e)), name: o.name }
  }
}

/* 「直链过期」这种失败自动换一次直链的实现在 refreshTask()（见上面那段注释），
 * 这里只是界面点「换直链」时的手动入口 —— 手动点不设「只换一次」的限制，
 * 用户想再试一次就再试一次。 */
ipcMain.handle('downloads:refresh', async (_e, gid) => refreshTask(gid))
ipcMain.handle('downloads:remove', async (_e, gid, mode) => {
    /* mode（只在「已下载完成的任务」上有意义）：
     *   'trash'    —— 文件挪进回收站，任务从队列里移除
     *   'purge'    —— 文件和任务一起彻底删掉
     *   其它/缺省  —— 只把任务从队列里移除，磁盘上的文件留着
     * 没下完的任务一概不动磁盘（它还要靠分片文件续传）。 */
    const want = mode === 'trash' || mode === 'purge' ? mode : ''
    /* ⚠️ 必须**先**取名字再 forget：否则中途撤销任务时，那份转到用户网盘里的副本
     * 就再也没人认领，会永久留在 `/PanBox` 里。 */
    const meta = tasks.info(gid)

    let done = null
    if (want) {
      const f = await taskFile(gid).catch(() => null)
      if (!f || !f.path) return { ok: false, message: '找不到这个任务对应的文件' }
      if (f.status !== 'complete') return { ok: false, message: '这个任务还没下载完' }
      done = f
    }

    /* ① 先立墓碑、再摘任务。这条任务可能正走在「分段引擎探测失败 → 回退到 aria2 重新入列」
     * 或「换直链、换一个新 gid 重新加」的路上，那两步在落地前会来核对这里 ——
     * 没有墓碑的话，用户删掉的任务过一会儿会自己回来（见 core/cancelGuard.js）。
     * 身份用「磁盘上的目录 + 文件名」：已完成的任务直接有 meta；
     * 探测中的占位行没有 meta（分片引擎先登记、后探测），就现问一次引擎 ——
     * 它回报的 path 与这轮投递将要落盘的名字是同一个。 */
    let idDir = (meta && meta.dir) || ''
    let idName = (meta && meta.name) || ''
    if (!idName) {
      const st = await taskFile(gid).catch(() => null)
      if (st && st.path) {
        idDir = path.dirname(st.path)
        idName = path.basename(st.path)
      }
    }
    if (idName) cancelGuard.note(idDir, idName)

    /* ② 还在下载/排队中的任务：先停掉，并把结果从引擎的已停止列表里清干净。
     * ⚠️ 不清结果的话，taskManager 每 800ms 的 tellStopped 会把它原样读回来，
     * 界面上那个任务根本不会消失 —— 这就是「点了移除毫无反应」的根因。
     * 停引擎 + 清结果 + 重试这几步与 purgeTask / readdTask 共用 hardRemove。 */
    const stopped = await hardRemove(gid, { label: 'remove' })

    tasks.forget(gid)
    if (meta && meta.name) await recycleTransferCopy(meta.name, 'remove').catch(() => {})
    /* 立刻推一次，别让用户等下一个 800ms 轮询 */
    tasks.kick()

    /* ③ 文件去留：挪进回收站 / 直接删掉。任务已经摘干净了，这一步失败也不影响队列，
     * 但要把原因如实回报（文件被别的程序占用时删不掉）。 */
    let moved = null
    let wiped = false
    let gone = false
    let fileErr = ''
    if (done && want === 'trash') {
      try {
        moved = await trash.add(done.path, { netdisk: (meta && meta.netdisk) || '', gid })
        if (!moved) gone = true
      } catch (e) {
        fileErr = (e && e.message) || String(e)
      }
    } else if (done && want === 'purge') {
      try {
        /* force:true 只用来兜住「正好在这一刻被别人删掉」这种竞态；
         * 路径本来就对不上时不能靠它静默算成功 —— 先问一次在不在，如实回报。 */
        const existed = fs.existsSync(done.path)
        await fs.promises.rm(done.path, { recursive: true, force: true })
        wiped = true
        if (!existed) gone = true
      } catch (e) {
        fileErr = (e && e.message) || String(e)
      }
    }
    const label = (moved && moved.name) || (done && path.basename(done.path)) || (meta && meta.name) || ''
    boot(
      'remove',
      gid,
      `stopped=${stopped} mode=${want || '-'} name=${label}`,
      fileErr ? 'err=' + fileErr : gone ? 'gone=1' : '',
    )

    /* 只要引擎那边没抛（本地引擎 remove 成功 / aria2 的 remove 与清结果都走完）就算摘干净了。
     * message 一律把「队列这边怎么样、磁盘那边怎么样」讲全：这两件事会各自成功或失败。 */
    let message = ''
    if (fileErr) message = `「${label}」已从队列移除，但磁盘上的文件没能处理掉：${fileErr}`
    else if (gone) message = `「${label}」已从队列移除；磁盘上已经没有这个文件了`
    else if (want === 'trash') message = `已把「${label}」放进回收站，之后可以还原`
    else if (want === 'purge') message = `已彻底删除「${label}」`
    return {
      ok: stopped && !fileErr,
      moved: !!moved,
      wiped,
      gone,
      name: label,
      size: (moved && moved.size) || 0,
      id: (moved && moved.id) || '',
      message,
    }
  })
  /* ---- 回收站 ------------------------------------------------------ */
  /* 删「已完成的下载文件」：不抹盘，先把文件挪进回收站，再把任务从队列里移除。
   * 没下完的任务不给删（它还要靠分片文件续传）。 */
  ipcMain.handle('downloads:deleteFile', async (_e, gid) => {
    const meta = tasks.info(gid)
    const st = await taskFile(gid)
    if (!st || !st.path) return { ok: false, message: '找不到这个任务对应的文件' }
    if (st.status !== 'complete') return { ok: false, message: '只有已下载完成的任务才能删除文件' }
    let moved = null
    try {
      moved = await trash.add(st.path, { netdisk: (meta && meta.netdisk) || '', gid })
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) }
    }
    if (!moved) return { ok: false, message: '文件已经不在磁盘上了' }
    /* 与「移除」同一套：这条任务也可能正走在回退/换链重新入列的路上 */
    cancelGuard.note(path.dirname(st.path), path.basename(st.path))
    await purgeTask(gid)
    if (meta && meta.name) await recycleTransferCopy(meta.name, 'remove').catch(() => {})
    boot('delete-file', gid, `${moved.name} size=${moved.size}`)
    return { ok: true, name: moved.name, size: moved.size, id: moved.id }
  })

  ipcMain.handle('downloads:pauseAll', () =>
    Promise.all([
      aria2.pauseAll().catch(() => {}),
      seg.pauseAll().catch(() => {}),
      hls.pauseAll().catch(() => {}),
    ]).then(() => {
      tasks.kick()
      return true
    }),
  )
  ipcMain.handle('downloads:resumeAll', () =>
    Promise.all([
      aria2.unpauseAll().catch(() => {}),
      seg.unpauseAll().catch(() => {}),
      hls.unpauseAll().catch(() => {}),
    ]).then(() => {
      tasks.kick()
      return true
    }),
  )

  /* 「直链过期自动换链」不在任何通道里：它由 main.js 那条模块级的 tasks.on('update')
   * 调用（队列一变就跑），而它自己要用这一域的闭包，所以从这里交出去。
   * ⚠️ 拆文件时它一度只留在这里面，main.js 按名调不到 → 每 tick 抛 ReferenceError
   * 被 try/catch 吞掉，自动换链一次都没跑过。 */
  return { autoRefreshExpired }
}

module.exports = { register }