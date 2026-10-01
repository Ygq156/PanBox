'use strict'

const { EventEmitter } = require('node:events')
const { app, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const aria2 = require('./aria2')
const seg = require('./segmentDownloader')

const META_FILE = () => path.join(app.getPath('userData'), 'tasks.json')
const POLL_MS = 800

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
    this._notifiedComplete = new Set()
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
      // 只保留最近 300 条
      const entries = [...this.meta.entries()].slice(-300)
      for (const [gid, v] of entries) obj[gid] = v
      fs.writeFileSync(META_FILE(), JSON.stringify(obj, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  remember(gid, info) {
    this.meta.set(gid, { ...(this.meta.get(gid) || {}), ...info, createdAt: Date.now() })
    this._saveMeta()
  }

  forget(gid) {
    this.meta.delete(gid)
    /* 一并忘掉「已经通知过完成」，这样同一个 gid 万一被复用还能再通知一次 */
    this._notifiedComplete.delete(gid)
    this._saveMeta()
  }

  /** 读某个任务的元信息（含 origin：重新解析直链所需的一切） */
  info(gid) {
    return this.meta.get(gid) || null
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this._tick().catch(() => {}), POLL_MS)
    this._tick().catch(() => {})
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  _normalize(st) {
    const m = this.meta.get(st.gid) || {}
    const f = (st.files && st.files[0]) || {}
    const name = m.name || f.path || path.basename(st.dir || '') || st.gid
    const total = Number(st.totalLength || 0) || Number(f.length || 0) || Number(st.filesize || 0)
    const completed = Number(st.completedLength || 0)
    return {
      gid: st.gid,
      name: String(name).replace(/^.*[\\/]/, ''),
      netdisk: m.netdisk || 'unknown',
      /** 哪个引擎在跑：'aria2' | 'seg'。暂停/继续/移除要按它路由 */
      engine: m.engine || (String(st.gid).startsWith('seg-') ? 'seg' : 'aria2'),
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
      /* aria2 的 RPC 偶尔会抽风（比如被 changeUri 动过之后会丢端点），
       * 单条失败不应该让整个列表空掉——所以各自兜底成空数组。 */
      const [active, waiting, stopped] = await Promise.all([
        aria2.tellActive().catch(() => []),
        aria2.tellWaiting(0, 200).catch(() => []),
        aria2.tellStopped(0, 100).catch(() => []),
      ])
      let segList = []
      try {
        segList = seg.list()
      } catch {
        /* ignore */
      }
      const all = [...active, ...waiting, ...stopped, ...segList].map((s) => this._normalize(s))
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
      this.emit('update', all)
    } finally {
      this.running = false
    }
  }

  list() {
    return this.tasks
  }

  async openFolder(dir) {
    try {
      await shell.openPath(dir)
      return ''
    } catch (e) {
      return String(e && e.message ? e.message : e)
    }
  }
}

module.exports = new TaskManager()
