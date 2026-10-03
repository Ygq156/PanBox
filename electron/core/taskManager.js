'use strict'

const { EventEmitter } = require('node:events')
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const aria2 = require('./aria2')
const seg = require('./segmentDownloader')
const hls = require('./hls')

const META_FILE = () => path.join(app.getPath('userData'), 'tasks.json')
/** 有任务在跑时的轮询间隔 */
const POLL_MS = 800
/** 空闲时的轮询间隔（没人下载时没必要每 800ms 敲一次 aria2） */
const IDLE_MS = 2500
/** 心跳计数没变化时，最多隔这么久兜底拉一次完整列表 */
const FULL_MS = 30000
/** tasks.json 最多留多少条元信息 */
const META_MAX = 300
/** 元信息攒多久写一次盘（见 _scheduleMetaSave） */
const META_SAVE_MS = 500

/**
 * 把 aria2 的三份列表（active/waiting/stopped）合并成 UI 用的任务数组，
 * 并贴上我们自己记录的业务元信息（网盘类型、来源链接、显示名）。
 */
class TaskManager extends EventEmitter {
  constructor() {
    super()
    this.meta = new Map() // gid -> { name, netdisk, source, dir, createdAt }
    this.tasks = []
    this.timer = null
    this.running = false
    this.stopped = false
    /** 上一次广播出去的内容指纹：没变就不广播 */
    this._sig = ''
    this._notifiedComplete = new Set()
    /* 轮询节流用：上一次看到的「已停止」条数、上一次全量拉取的时间、有没有被要求立刻拉一次 */
    this._lastStopped = -1
    this._lastFull = 0
    this._force = false
    this._loop = null
    /* 三份列表各自的上一次结果 + 计数：只拉数量变了的那一份，见 _tick() */
    this._lists = { active: [], waiting: [], stopped: [] }
    this._lastActive = -1
    this._lastWaiting = -1
    this._stoppedAt = 0
    this._hadLists = false
    /* 分段引擎任务的「gid:状态」指纹。引擎任务的状态跃迁（在下 → 完成/暂停/失败）
     * 不会改变 aria2 的任何计数，必须靠它触发合并与推送，见 _tick() */
    this._lastSegSig = ''
    /* 元信息落盘状态：_metaDirty=有待写的改动，_metaTimer=合并写盘的定时器 */
    this._metaDirty = false
    this._metaTimer = null
    this._loadMeta()
  }

  _loadMeta() {
    try {
      if (fs.existsSync(META_FILE())) {
        const obj = JSON.parse(fs.readFileSync(META_FILE(), 'utf8'))
        for (const [gid, v] of Object.entries(obj)) this.meta.set(gid, v)
      }
    } catch {
      /* ignore */
    }
  }

  _saveMeta() {
    try {
      const obj = {}
      /* 只保留 300 条，而且留**最近动过的**那 300 条。
       * 以前是 `[...this.meta.entries()].slice(-300)`（留最早插入的 300 条）——
       * Map.set 改一个已存在的键**不会**把它挪到末尾，所以「先入队、之后一直在更新」
       * 的任务反而可能被这一刀切掉，正在下载的那条的元信息（重解析直链要用的 origin）
       * 就这样没了。按 createdAt 排序取最新 300 条。 */
      const entries = [...this.meta.entries()].sort(
        (a, b) => ((b[1] && b[1].createdAt) || 0) - ((a[1] && a[1].createdAt) || 0),
      )
      for (const [gid, v] of entries.slice(0, META_MAX)) obj[gid] = v
      fs.writeFileSync(META_FILE(), JSON.stringify(obj, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  /**
   * 攒一攒再写盘。
   * `remember()` 是**按文件**调的（main.js 的 addResolved 里一千个文件就一千次），
   * 而 _saveMeta 每次都要把整张表 JSON.stringify 一遍再全量重写 —— 一千个文件就是
   * 一千次全量写盘，全在 IPC 主线程上。这里合并成 500ms 一次。
   * 落盘时机有三处兜底，丢数据的窗口极小：定时器到点、_tick() 末尾、退出前 flushMeta()。
   */
  _scheduleMetaSave() {
    this._metaDirty = true
    if (this._metaTimer) return
    this._metaTimer = setTimeout(() => {
      this._metaTimer = null
      this.flushMeta()
    }, META_SAVE_MS)
  }

  /** 立刻把待写的元信息落盘（退出、_tick 收尾都走它）。没脏活时什么都不做。 */
  flushMeta() {
    if (this._metaTimer) {
      clearTimeout(this._metaTimer)
      this._metaTimer = null
    }
    if (!this._metaDirty) return
    this._metaDirty = false
    this._saveMeta()
  }

  remember(gid, info) {
    this.meta.set(gid, { ...(this.meta.get(gid) || {}), ...info, createdAt: Date.now() })
    this._scheduleMetaSave()
  }

  forget(gid) {
    this.meta.delete(gid)
    /* 一并忘掉「已经通知过完成」，这样同一个 gid 万一被复用还能再通知一次 */
    this._notifiedComplete.delete(gid)
    this._scheduleMetaSave()
  }

  /** 读某个任务的元信息（含 origin：重新解析直链所需的一切） */
  info(gid) {
    return this.meta.get(gid) || null
  }

  /**
   * 空闲时没必要每 800ms 敲一次 aria2。用 setTimeout 自链代替 setInterval，
   * 节奏才能跟着任务状态走：有任务在跑 800ms，没人下载 2.5s。
   */
  start() {
    if (this.timer) return
    this.stopped = false
    const loop = async () => {
      /* 这里以前是 `.catch(() => {})`：只要 _tick 抛一次（比如某个事件回调按名引用了
       * 还没求值的 const），错误就没了痕迹，队列只是静悄悄地不再更新。现在留一条日志。 */
      await this._tick().catch((e) => {
        if (typeof global.__pbBoot === 'function') {
          global.__pbBoot('tasks-tick-err', (e && e.message) || String(e), (e && e.stack ? String(e.stack).split('\n')[1] || '' : ''))
        }
      })
      if (this.stopped) return
      const busy = this.tasks.some((t) => t.status === 'active' || t.status === 'waiting')
      this.timer = setTimeout(loop, busy ? POLL_MS : IDLE_MS)
    }
    this._loop = loop
    loop()
  }

  /** 用户刚做了操作（加入 / 暂停 / 移除…）：别等下一个轮询周期，立刻拉一次 */
  kick() {
    this._force = true
    if (!this._loop || this.stopped) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this._loop()
    }
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this._loop = null
    /* 停下之后不会再有 _tick 了，攒着的元信息在这里落一次（main.js 退出流程还会再兜一次） */
    this.flushMeta()
  }

  _normalize(st) {
    const m = this.meta.get(st.gid) || {}
    const f = (st.files && st.files[0]) || {}
    /* 本地引擎（分段 / HLS）自己知道最终落盘名：HLS 必须抓到播放列表才知道
     * 产物是 .ts 还是 .mp4/.aac，remember 时记下的名字只是投递那一刻的猜测。
     * 所以这类任务以引擎报的路径为准 —— 界面上的名字才与磁盘上的文件一致。 */
    const local = m.engine === 'seg' || m.engine === 'hls' || /^(seg|hls)-/.test(String(st.gid))
    const name = (local && f.path) || m.name || f.path || path.basename(st.dir || '') || st.gid
    const total = Number(st.totalLength || 0) || Number(f.length || 0) || Number(st.filesize || 0)
    const completed = Number(st.completedLength || 0)
    return {
      gid: st.gid,
      name: String(name).replace(/^.*[\\/]/, ''),
      netdisk: m.netdisk || 'unknown',
      /** 哪个引擎在跑：'aria2' | 'seg' | 'hls'。暂停/继续/移除要按它路由 */
      engine: m.engine || (String(st.gid).startsWith('seg-') ? 'seg' : String(st.gid).startsWith('hls-') ? 'hls' : 'aria2'),
      /** 实际出口：'direct' | 'proxy'（分段引擎探测完才知道；aria2 任务不带这个字段） */
      route: st.route || '',
      source: m.source,
      dir: st.dir || '',
      total,
      completed,
      speed: Number(st.downloadSpeed || 0),
      status: st.status,
      errorCode: st.errorCode && st.errorCode !== '0' ? String(st.errorCode) : undefined,
      errorMessage: st.errorMessage || undefined,
      connections: st.connections ? Number(st.connections) : undefined,
      filesize: Number(f.length || 0) || undefined,
    }
  }

  async _tick() {
    if (this.running) return
    this.running = true
    try {
      /* 先用一个极小的心跳（getGlobalStat 的响应只有两三百字节）问一下有没有变化。
       * 三份列表的响应大得多 —— stopped 里每条任务都带 files/files[].uris（完整直链），
       * 几十条已完成任务就是几十 KB，每 800ms 解析一遍纯属白烧 CPU。 */
      let gs = null
      try {
        gs = await aria2.getGlobalStat()
      } catch {
        gs = null
      }
      let segList = []
      let hlsList = []
      try {
        segList = seg.list()
      } catch {
        /* ignore */
      }
      try {
        hlsList = hls.list()
      } catch {
        /* ignore */
      }
      /* 本地引擎的任务合并成一份：它们与 aria2 的任务同形（gid/status/进度），
       * 界面与暂停/继续/移除都不需要知道底下是哪一套引擎。 */
      const engineList = [...segList, ...hlsList]
      const segBusy = engineList.some((t) => t.status === 'active' || t.status === 'waiting')
      /* 引擎任务的指纹只看 gid + 状态（在下时的进度由 segBusy 那条路覆盖）。
       * 「在下 → 完成」如果正好发生在两次 tick 之间，aria2 的三个计数一个都不会动，
       * 只看 gs 会误判成「什么都没变」而跳过合并 —— 界面就会一直停在过期的
       * 「下载中 N%」上，直到下一次 30 秒兜底刷新（实测就是这个让插件测试超时）。 */
      const segSig = engineList.map((t) => `${t.gid}:${t.status}`).join('|')
      const segChanged = segSig !== this._lastSegSig
      const nStopped = gs ? Number(gs.numStopped || 0) : -1
      /* 下面判断 stopped 列表该不该拉要用「上一轮的条数」，先存下来 */
      const prevStopped = this._lastStopped
      const now = Date.now()
      /* kick() 的「立刻拉一次」用掉之前先记下来：下面拉哪几份列表也要看它 */
      const kicked = this._force
      const changed =
        !gs ||
        kicked ||
        segChanged ||
        segBusy ||
        nStopped !== prevStopped ||
        Number(gs.numActive || 0) > 0 ||
        Number(gs.numWaiting || 0) > 0
      this._force = false
      if (!changed && now - this._lastFull < FULL_MS) return
      this._lastStopped = nStopped
      this._lastSegSig = segSig
      this._lastFull = now

      /* aria2 的 RPC 偶尔会抽风（比如被 changeUri 动过之后会丢端点），
       * 单条失败不应该让整个列表空掉——所以失败时沿用上一次的结果。
       * aria2 根本没起来时连问都不用问（问也是三条连接被拒）。 */
      let active = this._lists.active
      let waiting = this._lists.waiting
      let stopped = this._lists.stopped
      if (gs) {
        const nActive = Number(gs.numActive || 0)
        const nWaiting = Number(gs.numWaiting || 0)
        const force = kicked || !this._hadLists
        /* 只拉「数量变了」的那一份列表：
         *   - 有在下的就必须每轮拉 active（进度在变）
         *   - active/waiting 归零的那一轮也要拉一次，才能拿到收尾状态
         *   - stopped 只在条数跳变时拉（它只增不减，条数没变内容就没变），30s 再兜底全量刷一次
         * 这样稳态下载时每 800ms 只有一次心跳 + 一次 tellActive，而不是三份列表全拉。 */
        const wantActive = force || nActive > 0 || this._lastActive > 0
        const wantWaiting = force || nWaiting > 0 || this._lastWaiting > 0
        const wantStopped = force || nStopped !== prevStopped || now - this._stoppedAt >= FULL_MS
        const got = await Promise.all([
          wantActive ? aria2.tellActive().catch(() => null) : null,
          wantWaiting ? aria2.tellWaiting(0, 200).catch(() => null) : null,
          wantStopped ? aria2.tellStopped(0, 100).catch(() => null) : null,
        ])
        if (got[0]) active = got[0]
        if (got[1]) waiting = got[1]
        if (got[2]) stopped = got[2]
        if (got[2]) this._stoppedAt = now
        this._lastActive = nActive
        this._lastWaiting = nWaiting
        this._hadLists = true
      } else {
        active = []
        waiting = []
        stopped = []
        this._hadLists = false
      }
      this._lists = { active, waiting, stopped }
      const all = [...active, ...waiting, ...stopped, ...engineList].map((s) => this._normalize(s))
      // 稳定排序：下载中 / 排队 / 暂停 在前，其次按加入时间倒序
      const rank = { active: 0, waiting: 1, paused: 2, error: 3, complete: 4, removed: 5 }
      all.sort((a, b) => {
        const ra = rank[a.status] ?? 9
        const rb = rank[b.status] ?? 9
        if (ra !== rb) return ra - rb
        const ca = (this.meta.get(a.gid) || {}).createdAt || 0
        const cb = (this.meta.get(b.gid) || {}).createdAt || 0
        return cb - ca
      })
      this.tasks = all

      for (const t of all) {
        if (t.status === 'complete' && !this._notifiedComplete.has(t.gid)) {
          this._notifiedComplete.add(t.gid)
          /* 首次变为 complete 时广播一次，给「下载完成后打开文件夹」和转存副本回收用 */
          this.emit('complete', t)
        }
      }

      /* 内容没变就不广播。空闲时每 800ms 全量推一次，渲染层会白白重建一遍列表，
       * 那点垃圾正是把内存慢慢推高的东西。 */
      const sig = all
        .map((t) => `${t.gid}|${t.status}|${t.completed}|${t.speed}|${t.connections || ''}|${t.route || ''}`)
        .join('\n')
      if (sig !== this._sig) {
        this._sig = sig
        this.emit('update', all)
      }
    } finally {
      this.running = false
      /* 每轮收尾顺手把元信息写掉：入队是「remember ×N + kick()」，
       * 紧接着的这一轮 _tick 就把这一批落盘了，不必等 debounce 定时器。 */
      this.flushMeta()
    }
  }

  list() {
    return this.tasks
  }
}

module.exports = new TaskManager()
