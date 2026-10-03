'use strict'

/**
 * 自研分段下载器 —— 绕开 aria2 的 `--max-connection-per-server` 16 连接硬上限。
 *
 * 为什么需要它
 * ------------
 * 实测（本机，夸克 / UC 分享直链）：
 * 夸克 / UC 这类网盘的 CDN 是**按每条 TCP 连接**发额度的 ——
 *   夸克 ≈ 50 KB/s/连接，UC ≈ 64 KB/s/连接。
 * 总速度 ≈ 连接数 × 每连接额度，实测线性关系：
 *   夸克  16 连接 0.82 MB/s → 64 连接 3.30 → 128 连接 6.90 MB/s
 *   UC    8 连接 0.77 MB/s → 128 连接 3.85 MB/s
 * 而 aria2 的 `--max-connection-per-server` 最大只能填 16（填 60 直接报错），
 * 于是经过 aria2 永远被钉在 16 × 额度 ≈ 0.8 MB/s。这个模块就是来解这个天花板的。
 *
 * 反面教材（不要对它加连接数）
 * ----------------------------
 * 百度：8 连接 0.10 MB/s，32 连接起一律 HTTP 403 —— 它对高并发是**惩罚**而不是分摊，
 * 所以百度必须走低并发（见 main.js 里的 per-netdisk 默认值）。
 * 迅雷：并发上去会回 HTTP 503，同样走低并发。
 *
 * 设计要点
 * --------
 * - 用 `node:http(s)` 而不是 `fetch`：只有自己管 Agent 才能保证「N 个请求 = N 条 TCP
 *   连接」。全局 fetch（undici）在 HTTP/2 上会把并发请求复用进同一条连接，
 *   那样连接数就白加了。
 * - 文件按 `chunkSize` 等分成若干片，工作池里有几个空位就发几个 Range 请求；
 *   每片下完按绝对偏移写进目标文件。
 * - 断点续传靠同目录下的 `<文件名>.panbox.json`（记录分片大小与已完成的下标）。
 * - 状态对象刻意做成 aria2 `tellStatus` 的形状，好让 `taskManager` 无改动地合并两套引擎。
 * - 并发被服务端拒绝（403/412/429/503）时自动减半重试，最低降到 4 —— 这样即使某天
 *   某个网盘改了策略，也不会整个任务失败，只是慢一点。
 */

const { EventEmitter } = require('node:events')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
/* 「裸 GET + 跟重定向 + 走代理」这层与 HLS 引擎共用，见 httpStream.js */
const { sleep, openStream, readAll, httpError } = require('./httpStream')

const TICK_MS = 500
const PERSIST_MS = 2000
const MIN_CHUNK = 128 * 1024
const MAX_CHUNK = 4 * 1024 * 1024
/** 每个分片收数据时的攒批大小：socket 给的是 16KB 的小块，攒够这个数才写一次盘（writev） */
const FLUSH_BYTES = 256 * 1024
/** 单个分片的失败重试次数 */
const CHUNK_TRIES = 5

/* 「空档看门狗」。直连跨境线路的典型症状是「先冲一阵、然后几十秒一个字节都不来」，
 * 死等到 45 秒的连接超时只会把整条任务拖垮（实测直连 CDN 峰值能到 11 MB/s，平均却只有 0.9 MB/s）。
 * 这里只要超过 STALL_MS 没有新数据就掐掉这一片，worker 会换一条全新连接重下。
 * 注意计时窗口每收到一个数据块就往后推，所以「只是慢、但在持续动」的连接不会被误杀。
 * 要复现实验：PANBOX_SEG_STALL_MS=0 可关掉。 */
const STALL_MS = Math.max(0, Number(process.env.PANBOX_SEG_STALL_MS ?? 3000))
/** 并发被拒时最低降到几条 */
const MIN_CONN = 4
/** 探测真实大小时请求的字节数（`Range: bytes=0-0`） */
const PROBE_BYTES = 1
/** 「不支持分段下载」这个错误要能被上层认出来，好回退到 aria2 */
const NO_RANGE = 'NO_RANGE'



class SegmentDownloader extends EventEmitter {
  constructor() {
    super()
    /** gid -> task */
    this.tasks = new Map()
    this._seq = 0
    this._timer = null
    /** 同时下载数的上限（0 = 不限）。上层用设置里的「同时下载数」调 setLimit()。
     *  没有这个闸门时，10 个夸克任务会同时各开 192 条连接把线路和自己都打满。 */
    this.limit = 0
    /** 排队中的 gid，先来先下；插队就是把 gid 挪到队首 */
    this.queue = []
  }

  /* ------------------------------------------------------------------ */
  /* 对外：aria2 形状的接口                                               */
  /* ------------------------------------------------------------------ */

  /**
   * 加入下载。**会先探测一次（含 Range 支持与真实大小）再返回**，
   * 所以不支持分段下载的直链会在这里抛错，调用方可以据此回退到 aria2。
   */
  async add(opts) {
    const {
      url,
      headers = {},
      dir,
      out,
      connections = 96,
      netdisk = 'unknown',
      source = '',
      knownSize = 0,
      proxy = '',
      insecure = false,
    } = opts
    if (!url) throw new Error('缺少下载地址')
    const gid = 'seg-' + (++this._seq).toString(36) + '-' + crypto.randomBytes(4).toString('hex')

    const filePath = path.join(dir, out)
    const task = {
      gid,
      url,
      headers: { ...headers },
      /* 走不走代理由上层按设置决定（默认跟随 Windows 系统代理） */
      proxy: proxy || '',
      /* 是否跳过证书校验（默认否，由设置里的「忽略证书错误」决定，见 main.js addResolved） */
      insecure: !!insecure,
      /* 探测阶段选出来的实际出口：'direct' | 'proxy'（空串 = 还没探） */
      route: '',
      dir,
      out,
      filePath,
      partPath: filePath + '.panbox-part',
      sidecarPath: filePath + '.panbox.json',
      netdisk,
      source,
      status: 'waiting',
      errorCode: 0,
      errorMessage: '',
      total: Number(knownSize) || 0,
      completed: 0,
      liveBytes: 0,
      chunkSize: 0,
      chunkCount: 0,
      done: new Set(),
      inflight: new Set(),
      running: new Set(),
      connWanted: Math.max(1, Math.min(256, Number(connections) || 96)),
      connLimit: Math.max(1, Math.min(256, Number(connections) || 96)),
      active: 0,
      speed: 0,
      samples: [],
      fh: null,
      cursor: 0,
      _persistAt: 0,
      createdAt: Date.now(),
    }
    this.tasks.set(gid, task)
    this._ensureTimer()

    try {
      await this._prepare(task)
    } catch (e) {
      this.tasks.delete(gid)
      await this._close(task)
      throw e
    }
    if (task.status !== 'complete') this._enqueue(task)
    return gid
  }

  /** aria2 形状：一份列表把 active / waiting / paused / error / complete 全包了 */
  list() {
    return [...this.tasks.values()].map((t) => this._status(t))
  }

  tellStatus(gid) {
    const t = this.tasks.get(gid)
    if (!t) throw new Error(`GID ${gid} 不存在`)
    return this._status(t)
  }

  has(gid) {
    return this.tasks.has(gid)
  }

  /* ------------------------------------------------------------------ */
  /* 队列：并发上限、排队、插队                                          */
  /* ------------------------------------------------------------------ */

  /** 上层设置「同时下载数」。0 或非法值 = 不限（保留旧行为） */
  setLimit(n) {
    const v = Math.floor(Number(n))
    this.limit = Number.isFinite(v) && v > 0 ? v : 0
    this._pump()
    return this.limit
  }

  /** 正在下载的任务数（上层用它判断队列满没满） */
  activeCount() {
    let n = 0
    for (const t of this.tasks.values()) if (t.status === 'active') n++
    return n
  }

  /** 放进排队区（已经在排队的不重复放），状态显示为「等待中」。
   *  入队后立刻试着放行：有空闲名额就直接开跑，没有就老实排着。 */
  _enqueue(t) {
    t.status = 'waiting'
    if (!this.queue.includes(t.gid)) this.queue.push(t.gid)
    this._pump()
  }

  /** 出队开跑：状态与统计一次性复位 */
  _start(t) {
    t.status = 'active'
    t.connLimit = t.connWanted
    t.speed = 0
    t.samples = []
    t.active = 0
    this._pool(t).catch((e) => this._fail(t, e))
  }

  /** 有位置就把排队最前的任务放出去；limit 为 0 时全部放行。
   *  每条任务的收尾（_finish / _fail / pause / remove）都要调一次，名额才不会空着。 */
  _pump() {
    if (!this.queue.length) return
    let room = Infinity
    if (this.limit > 0) room = this.limit - this.activeCount()
    while (room > 0 && this.queue.length) {
      const gid = this.queue.shift()
      const t = this.tasks.get(gid)
      if (!t || t.status !== 'waiting') continue
      this._start(t)
      room--
    }
  }

  /** 插队：排队中的挪到队首（已经在下载/已结束的不动），返回它当前的状态 */
  jumpTop(gid) {
    const t = this.tasks.get(gid)
    if (!t) throw new Error('任务不存在')
    const i = this.queue.indexOf(gid)
    if (t.status === 'waiting') {
      /* 只处理还在排队的：先把原来的位置摘掉（本来就在队首时 splice 再 unshift 等价），
       * 再插到队首并立刻试着放行。非 waiting 的 gid 本就不在队列里，不用动。 */
      if (i >= 0) this.queue.splice(i, 1)
      this.queue.unshift(gid)
      this._pump()
    }
    return t.status
  }

  async pause(gid) {
    const t = this.tasks.get(gid)
    if (!t) throw new Error('任务不存在')
    if (t.status === 'active' || t.status === 'waiting') {
      const i = this.queue.indexOf(gid)
      if (i >= 0) this.queue.splice(i, 1)
      t.status = 'paused'
      this._settleLive(t)
      this._abortInflight(t)
      t.active = 0
      await this._persist(t, true)
      this._pump() /* 空出来的名额立刻给排队最前的任务 */
    }
    return true
  }

  async unpause(gid) {
    const t = this.tasks.get(gid)
    if (!t) throw new Error('任务不存在')
    if (t.status === 'paused') {
      this._enqueue(t)
      this._pump()
    }
    return true
  }

  async pauseAll() {
    for (const t of [...this.tasks.values()]) await this.pause(t.gid).catch(() => {})
    return true
  }

  async unpauseAll() {
    for (const t of [...this.tasks.values()]) await this.unpause(t.gid).catch(() => {})
    return true
  }

  /** 彻底移除（连同未下完的分片文件与断点信息） */
  async remove(gid) {
    const t = this.tasks.get(gid)
    if (!t) return false
    t.status = 'removed'
    this._abortInflight(t)
    const qi = this.queue.indexOf(gid)
    if (qi >= 0) this.queue.splice(qi, 1)
    this.tasks.delete(gid)
    await this._close(t)
    await fsp.rm(t.partPath, { force: true }).catch(() => {})
    await fsp.rm(t.sidecarPath, { force: true }).catch(() => {})
    this._pump()
    return true
  }

  /** 应用退出时把断点信息落盘，下次启动可以续传 */
  async flush() {
    for (const t of [...this.tasks.values()]) {
      if (t.status === 'active' || t.status === 'waiting') {
        t.status = 'paused'
        this._settleLive(t)
        this._abortInflight(t)
      }
      await this._persist(t, true).catch(() => {})
      await this._close(t)
    }
    this.queue = []
  }

  /* ------------------------------------------------------------------ */
  /* 状态包装                                                             */
  /* ------------------------------------------------------------------ */

  _progress(t) {
    return Math.min(t.total || 0, t.completed + t.liveBytes)
  }

  _status(t) {
    return {
      gid: t.gid,
      status: t.status,
      totalLength: String(t.total || 0),
      completedLength: String(this._progress(t)),
      downloadSpeed: String(Math.round(t.speed || 0)),
      connections: String(t.active || 0),
      /* 'direct' | 'proxy'，给界面显示「走代理」用 */
      route: t.route || '',
      filesize: String(t.total || 0),
      errorCode: t.errorCode ? String(t.errorCode) : '0',
      errorMessage: t.errorMessage || '',
      dir: t.dir,
      files: [
        {
          path: t.filePath,
          length: String(t.total || 0),
          completedLength: String(this._progress(t)),
        },
      ],
    }
  }

  _ensureTimer() {
    if (this._timer) return
    this._timer = setInterval(() => this._tick(), TICK_MS)
    if (this._timer.unref) this._timer.unref()
  }

  _tick() {
    const now = Date.now()
    for (const t of [...this.tasks.values()]) {
      if (t.fh && (t.status === 'active' || t.status === 'waiting')) this._persist(t).catch(() => {})
      if (t.status !== 'active' && t.status !== 'waiting') continue
      t.active = t.running.size
      t.samples.push({ t: now, n: this._progress(t) })
      while (t.samples.length > 2 && now - t.samples[0].t > 5000) t.samples.shift()
      const a = t.samples[0]
      const b = t.samples[t.samples.length - 1]
      const dt = (b.t - a.t) / 1000
      if (dt > 0.4) t.speed = Math.max(0, (b.n - a.n) / dt)
    }
  }

  /** 把「在飞分片已写入的字节」并进 completed（暂停/结束时调用，避免重复计数） */
  _settleLive(t) {
    t.liveBytes = 0
  }

  _abortInflight(t) {
    for (const ac of t.running) {
      try {
        ac.abort()
      } catch {
        /* ignore */
      }
    }
    t.running.clear()
    t.inflight.clear()
    t.active = 0
  }

  async _close(t) {
    if (t.fh) {
      const fh = t.fh
      t.fh = null
      await fh.close().catch(() => {})
    }
  }

  async _fail(t, e) {
    if (t.status === 'removed') return
    t.status = 'error'
    t.errorMessage = (e && e.message) || String(e)
    t.errorCode = t.errorCode || 1
    t.speed = 0
    /* 已停下的任务不该再报「N 连接」（界面副标题直接显示 connections） */
    t.active = 0
    this._abortInflight(t)
    await this._persist(t, true).catch(() => {})
    await this._close(t)
    this._pump() /* 让出名额 */
  }

  async _persist(t, force = false) {
    if (!t.chunkCount) return
    const now = Date.now()
    if (!force && now - t._persistAt < PERSIST_MS) return
    t._persistAt = now
    const body = {
      v: 1,
      url: t.url,
      total: t.total,
      chunkSize: t.chunkSize,
      chunkCount: t.chunkCount,
      out: t.out,
      done: [...t.done],
    }
    /* 断点写不下去就让它抛出去：这一片不算下好，任务如实报错。
     * 吞掉的话磁盘满了会一路「成功」到最后才炸。 */
    await fsp.writeFile(t.sidecarPath, JSON.stringify(body), 'utf8')
  }

  /* ------------------------------------------------------------------ */
  /* 主流程                                                               */
  /* ------------------------------------------------------------------ */

  /** 用指定的出口（proxy 为空串 = 直连）探一次：只请求 PROBE_BYTES 个字节 */
  async _probe(t, proxy, signal) {
    const res = await openStream(t.url, {
      headers: { ...t.headers, Range: `bytes=0-${PROBE_BYTES - 1}` },
      signal,
      timeout: 30000,
      proxy,
      insecure: t.insecure,
    })
    const cr = String(res.headers['content-range'] || '')
    const m = /\/(\d+)\s*$/.exec(cr)
    let total = 0
    let acceptRanges = false
    if (res.status === 206 && m) {
      total = Number(m[1])
      acceptRanges = true
    } else if (res.status === 200) {
      total = Number(res.headers['content-length'] || 0)
      acceptRanges = false
    }
    const status = res.status
    await readAll(res.stream, 2048)
    if (status >= 400) throw new Error(httpError(status))
    return { total, acceptRanges, status, finalUrl: res.url }
  }

  /** 探测大小、决定分片、打开（或恢复）分片文件 */
  async _prepare(t) {
    await fsp.mkdir(t.dir, { recursive: true }).catch(() => {})

    /* 目标文件已经完整存在 → 直接算完成 */
    try {
      const st = await fsp.stat(t.filePath)
      if (st.isFile() && st.size > 0 && (!t.total || st.size === t.total)) {
        t.total = t.total || st.size
        t.completed = st.size
        t.status = 'complete'
        return
      }
    } catch {
      /* 不存在，正常 */
    }

    const ac = new AbortController()
    let total = Number(t.total) || 0
    let acceptRanges = false
    /* 直连与代理互为备份：一边不通就换另一边再试。
     * 实测（2026-10-01，本机）：直连 github.com 会被 SNI 层重置（ETIMEDOUT / ECONNRESET），
     * 而走 Clash 系统代理能到 10 MB/s；反过来代理没开或被关掉时，直连才是唯一出路。
     * 所以在探测阶段就把路选好，选中的那条写回 t.proxy，后续所有分片都走它。 */
    const routes = t.proxy ? [t.proxy, ''] : ['']
    let best = null
    let lastErr = null
    for (const r of routes) {
      /* 每条路最多试 3 次：本机直连 github.com 的失败是**间歇性**的
       * （实测同一分钟内 39.4 s / 0.69 s / 20.7 s 三种结果），一次失败不代表这条路不通。 */
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const pr = await this._probe(t, r, ac.signal)
          if (pr.acceptRanges) {
            best = { r, pr }
            break
          }
          /* 这条路不认 Range：先记下，继续试下一条，万一另一条支持呢 */
          if (!best) best = { r, pr }
          break
        } catch (e) {
          lastErr = e
          if (attempt < 2) await sleep(400)
        }
      }
      if (best && best.pr.acceptRanges) break
    }
    /* 重定向只解一次，之后所有分片直接打终点 CDN。
     * 这是「同一条 GitHub 链接，NDM 有 5 MB/s 而 PanBox 只有 1 MB/s」的另一半原因：
     * github.com 那一跳在本机是间歇性被重置的，如果每个分片都从它开始跟 302，
     * 那么「换一条新连接重下」就永远要重新过一次鬼门关 —— 实测直连原始链接平均只有 0.68 MB/s，
     * 换成终点 CDN 直连能到 3.02 MB/s（128 连接，本机实测）。 */
    if (best && best.pr.finalUrl && best.pr.finalUrl !== t.url) {
      const from = new URL(t.url).host
      const to = new URL(best.pr.finalUrl).host
      t.originUrl = t.originUrl || t.url
      t.url = best.pr.finalUrl
      if (from !== to) console.log(`[seg] 重定向 ${from} → ${to}，后续分片直连终点`)
    }
    if (!best) {
      const err = new Error('探测文件大小失败：' + ((lastErr && lastErr.message) || lastErr))
      err.code = 'PROBE_FAILED'
      throw err
    }
    if (best.r !== t.proxy) {
      t.route = best.r ? 'proxy' : 'direct'
      console.log('[seg] ' + (best.r ? '直连不通，改用代理 ' + best.r : '代理不通，改用直连'))
    } else {
      t.route = t.proxy ? 'proxy' : 'direct'
    }
    t.proxy = best.r
    total = best.pr.total || total
    acceptRanges = best.pr.acceptRanges

    if (!total) throw new Error('服务端没有返回文件大小，无法分段下载')

    if (!acceptRanges) {
      const err = new Error(
        '这个直链不支持分段下载（服务端不认 Range），已回退到 aria2',
      )
      err.code = NO_RANGE
      throw err
    }

    /* 断点续传：读回上次的分片信息（分片大小与地址都必须一致才认） */
    const done = new Set()
    let chunkSize = 0
    try {
      const sc = JSON.parse(await fsp.readFile(t.sidecarPath, 'utf8'))
      if (sc && sc.v === 1 && Number(sc.total) === total && sc.url === t.url) {
        chunkSize = Number(sc.chunkSize) || 0
        for (const i of sc.done || []) if (i >= 0 && i < Number(sc.chunkCount)) done.add(Number(i))
      }
    } catch {
      /* 没有断点信息，从头来 */
    }

    if (!chunkSize) {
      /* 分片大小随并发走：片数至少是连接数的 2 倍，工作池才喂得饱 */
      const want = Math.floor(total / Math.max(1, t.connWanted * 2))
      chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.floor(want / 65536) * 65536 || MIN_CHUNK))
    }
    const chunkCount = Math.max(1, Math.ceil(total / chunkSize))

    t.total = total
    t.chunkSize = chunkSize
    t.chunkCount = chunkCount
    t.done = done
    t.completed = 0
    t.liveBytes = 0
    for (const i of done) t.completed += this._chunkLen(t, i)

    t.fh = await fsp.open(t.partPath, 'r+').catch(() => fsp.open(t.partPath, 'w+'))
    try {
      const st = await t.fh.stat()
      if (st.size !== total) await t.fh.truncate(total)
    } catch {
      /* ignore */
    }
  }

  _chunkLen(t, i) {
    const start = i * t.chunkSize
    return Math.min(t.chunkSize, t.total - start)
  }

  /** 工作池：保持 connLimit 个在飞的 Range 请求，直到所有分片下完 */
  async _pool(t) {
    const workers = []
    for (let k = 0; k < t.connLimit; k++) workers.push(this._worker(t, k))
    const results = await Promise.allSettled(workers)
    if (t.status !== 'active') return
    const bad = results.find((r) => r.status === 'rejected')
    if (bad) {
      await this._fail(t, bad.reason)
      return
    }
    if (t.done.size >= t.chunkCount) await this._finish(t)
    else await this._fail(t, new Error('还有分片没下完，但工作池已退出'))
  }

  async _worker(t, k) {
    while (t.status === 'active' && k < t.connLimit) {
      const idx = this._nextChunk(t)
      if (idx < 0) return
      let written = 0
      try {
        written = await this._fetchChunk(t, idx)
        await this._commitChunk(t, idx, written)
        t.errorCode = 0
        t.errorMessage = ''
      } catch (e) {
        t.inflight.delete(idx)
        t.liveBytes = Math.max(0, t.liveBytes - written)
        if (t.status !== 'active') return // pause / remove，安静退出
        const msg = (e && e.message) || String(e)
        /* 并发被服务端拒绝 → 减半重试。百度/迅雷这类「并发惩罚」靠这一步兜住，
         * 不至于因为连接数配高了就整个任务失败。 */
        if (/\b(403|412|429|503)\b/.test(msg) && t.connLimit > MIN_CONN) {
          t.connLimit = Math.max(MIN_CONN, Math.floor(t.connLimit / 2))
          t.errorMessage = `${msg}，已把并发降到 ${t.connLimit} 重试`
          await sleep(500)
          continue
        }
        throw new Error(`分片 ${idx} 失败：${msg}`)
      }
    }
  }

  /** 一片下完：先把这片字节刷到盘，再计入进度、写断点。
 *
 * 顺序不能反：断点里记着「这片下好了」，下次续传就会跳过它。要是字节还在系统
 * 缓存里没落盘就断电，续传会把一片空洞当成功，最后产出一个看着下完、其实坏了
 * 的文件。fsync 成功之后才允许它进 done。
 */
  async _commitChunk(t, idx, written) {
    t.inflight.delete(idx)
    t.liveBytes = Math.max(0, t.liveBytes - written)
    if (t.fh && t.status === 'active') await t.fh.sync()
    t.done.add(idx)
    t.completed += this._chunkLen(t, idx)
    await this._persist(t)
  }

  /** 取下一个待下分片（轮转扫描，避免所有 worker 都从 0 开始抢） */
  _nextChunk(t) {
    const n = t.chunkCount
    for (let k = 0; k < n; k++) {
      const i = (t.cursor + k) % n
      if (!t.done.has(i) && !t.inflight.has(i)) {
        t.inflight.add(i)
        t.cursor = (i + 1) % n
        return i
      }
    }
    return -1
  }

  /** 下好一片，返回实际写入的字节数 */
  async _fetchChunk(t, idx) {
    const start = idx * t.chunkSize
    const end = Math.min(t.total - 1, start + t.chunkSize - 1)
    const need = end - start + 1
    let lastErr = null
    for (let attempt = 0; attempt < CHUNK_TRIES; attempt++) {
      if (t.status !== 'active') throw new Error('已取消')
      const ac = new AbortController()
      t.running.add(ac)
      let written = 0
      let stallTimer = null
      let lastDataAt = Date.now()
      // 攒批写盘：socket 读出来是 16KB 一个 buffer，直接一个个 write 的话，
      // 1200MB 就是 7 万多次 write 系统调用（实测 sys 时间占引擎 CPU 的一大半）。
      // 攒到 FLUSH_BYTES 再写一次，系统调用数掉到 1/16，字节落盘顺序完全不变。
      let pend = []
      let pendLen = 0
      const flushPending = async () => {
        if (!pendLen) return
        const bufs = pend
        const at = start + written
        const n = pendLen
        pend = []
        pendLen = 0
        // writev：一次系统调用写多段，既不拷贝（concat 会多一份 FLUSH_BYTES 大小的临时内存），
        // 也不用为每个 16KB 小块各来一次 write
        const r = bufs.length === 1 ? await t.fh.write(bufs[0], 0, n, at) : await t.fh.writev(bufs, at)
        if (r && r.bytesWritten !== n) throw new Error(`写入不完整（${r.bytesWritten}/${n}）`)
        written += n
        t.liveBytes += n
      }
      // 停顿检测：一个计时窗口只建一次计时器（原来是每收到一个 buffer 就
      // clearTimeout + setTimeout，纯属给 libuv 的计时器堆添乱）
      const armStall = (stream) => {
        if (!STALL_MS) return
        lastDataAt = Date.now()
        if (stallTimer) return
        const tick = () => {
          stallTimer = null
          const idle = Date.now() - lastDataAt
          if (idle >= STALL_MS) {
            stream.destroy(new Error('长时间没有数据（停顿）'))
            return
          }
          stallTimer = setTimeout(tick, STALL_MS - idle)
          if (stallTimer.unref) stallTimer.unref()
        }
        stallTimer = setTimeout(tick, STALL_MS)
        if (stallTimer.unref) stallTimer.unref()
      }
      try {
        const res = await openStream(t.url, {
          headers: { ...t.headers, Range: `bytes=${start}-${end}` },
          signal: ac.signal,
          timeout: 45000,
          proxy: t.proxy,
          insecure: t.insecure,
        })
        if (res.status >= 400) {
          const body = await readAll(res.stream, 4096)
          const detail = body.length ? `：${body.toString('utf8').slice(0, 120)}` : ''
          throw new Error(httpError(res.status) + detail)
        }
        if (res.status === 200 && t.chunkCount > 1) {
          throw new Error('服务端不支持 Range（返回了 200 整文件）')
        }
        armStall(res.stream)
        for await (const buf of res.stream) {
          if (t.status !== 'active') throw new Error('已取消')
          if (!buf.length) continue
          const remain = need - written - pendLen
          if (remain <= 0) break
          const chunk = buf.length > remain ? buf.subarray(0, remain) : buf
          pend.push(chunk)
          pendLen += chunk.length
          armStall(res.stream)
          if (pendLen >= FLUSH_BYTES) {
            await flushPending()
            if (written >= need) break
          }
        }
        await flushPending()
        res.stream.destroy()
        if (written < need) throw new Error(`只收到 ${written}/${need} 字节`)
        return written
      } catch (e) {
        lastErr = e
        if (t.status !== 'active') throw e
        t.liveBytes = Math.max(0, t.liveBytes - written)
        await sleep(300 * (attempt + 1))
      } finally {
        if (stallTimer) clearTimeout(stallTimer)
        t.running.delete(ac)
      }
    }
    throw lastErr || new Error('未知错误')
  }

  async _finish(t) {
    t.completed = t.total
    t.liveBytes = 0
    t.status = 'complete'
    t.speed = 0
    /* 同上：下完了就不该再报连接数 */
    t.active = 0
    await this._close(t)
    try {
      await fsp.rm(t.filePath, { force: true })
      await fsp.rename(t.partPath, t.filePath)
    } catch (e) {
      await this._fail(t, new Error('下载完成但改名失败：' + ((e && e.message) || e)))
      return
    }
    await fsp.rm(t.sidecarPath, { force: true }).catch(() => {})
    this._pump() /* 下完了，把这个名额给排队中的下一条 */
  }
}

module.exports = new SegmentDownloader()
module.exports.NO_RANGE = NO_RANGE
/* 给测试用（test/verify-proxy.js 要单独验代理隧道，不想为此跑一次完整下载） */
module.exports.__openStream = openStream
