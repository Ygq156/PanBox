'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/**
 * aria2 JSON-RPC 客户端 + aria2c 子进程生命周期管理。
 */
class Aria2 {
  constructor() {
    this.proc = null
    this.port = 6800
    this.secret = crypto.randomBytes(12).toString('hex')
    this.exePath = ''
    this.logTail = []
    this._starting = null
  }

  get endpoint() {
    return `http://127.0.0.1:${this.port}/jsonrpc`
  }

  setOptions({ exePath, port }) {
    this.exePath = exePath
    if (port) this.port = port
  }

  async rpc(method, params = [], timeout = 15000) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'panbox',
      method,
      params: [`token:${this.secret}`, ...params],
    })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ac.signal,
      })
      const json = await res.json()
      if (json.error) {
        const err = new Error(json.error.message || 'aria2 RPC 错误')
        err.code = json.error.code
        throw err
      }
      return json.result
    } finally {
      clearTimeout(timer)
    }
  }

  buildArgs(cfg) {
    const dir = cfg.downloadDir
    const args = [
      '--enable-rpc',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${this.port}`,
      `--rpc-secret=${this.secret}`,
      '--rpc-allow-origin-all=false',
      '--rpc-max-request-size=16M',
      `--dir=${dir}`,
      '--continue=true',
      '--file-allocation=none',
      '--auto-file-renaming=false',
      '--allow-overwrite=false',
      '--always-resume=false',
      '--max-resume-failure-tries=0',
      `--max-concurrent-downloads=${cfg.maxConcurrent}`,
      `--split=${cfg.split}`,
      `--max-connection-per-server=${cfg.maxConnectionPerServer}`,
      `--min-split-size=${cfg.minSplitSize}`,
      '--max-tries=5',
      '--retry-wait=3',
      '--connect-timeout=20',
      '--timeout=60',
      '--lowest-speed-limit=0',
      '--disk-cache=64M',
      '--check-certificate=false',
      '--check-integrity=false',
      '--content-disposition-default-utf8=true',
      '--user-agent=' + (cfg.userAgent || 'PanBox/0.1'),
      '--follow-metalink=false',
      '--seed-time=0',
      '--bt-save-metadata=false',
      '--summary-interval=0',
      '--console-log-level=warn',
      '--log-level=warn',
      '--quiet=false',
    ]
    return args
  }

  async start(cfg) {
    if (this._starting) return this._starting
    this._starting = (async () => {
      await this.stop()
      this.port = cfg.aria2Port || this.port

      if (!this.exePath || !fs.existsSync(this.exePath)) {
        throw new Error(`找不到 aria2c.exe：${this.exePath || '(未配置路径)'}`)
      }
      try {
        fs.mkdirSync(cfg.downloadDir, { recursive: true })
      } catch {
        /* ignore */
      }

      const args = this.buildArgs(cfg)
      this.logTail = []
      this.proc = spawn(this.exePath, args, {
        windowsHide: true,
        cwd: path.dirname(this.exePath),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const onData = (buf) => {
        const s = buf.toString('utf8')
        this.logTail.push(s)
        if (this.logTail.length > 40) this.logTail.shift()
      }
      this.proc.stdout.on('data', onData)
      this.proc.stderr.on('data', onData)
      this.proc.on('exit', () => {
        this.proc = null
      })

      // 等 RPC 就绪
      let lastErr
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300))
        try {
          const v = await this.rpc('aria2.getVersion', [], 3000)
          return v
        } catch (e) {
          lastErr = e
          if (!this.proc) break
        }
      }
      throw new Error(
        `aria2 启动失败：${lastErr ? lastErr.message : '超时'}\n${this.logTail.join('').slice(-600)}`,
      )
    })()
    try {
      return await this._starting
    } finally {
      this._starting = null
    }
  }

  async stop() {
    if (this.proc) {
      try {
        await this.rpc('aria2.shutdown', [], 3000)
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 400))
      if (this.proc) {
        try {
          this.proc.kill()
        } catch {
          /* ignore */
        }
      }
      this.proc = null
    }
  }

  /** 加入下载。options 支持 header / out / dir 等 aria2 原生选项 */
  addUri(uris, options = {}) {
    return this.rpc('aria2.addUri', [uris, options])
  }

  tellActive() {
    return this.rpc(
      'aria2.tellActive',
      [
        [
          'gid',
          'status',
          'totalLength',
          'completedLength',
          'downloadSpeed',
          'connections',
          'filesize',
          'errorCode',
          'errorMessage',
          'dir',
          'files',
          'bittorrent',
        ],
      ],
      8000,
    )
  }

  tellWaiting(offset = 0, num = 200) {
    return this.rpc('aria2.tellWaiting', [offset, num, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'connections', 'errorCode', 'errorMessage', 'dir', 'files']], 8000)
  }

  tellStopped(offset = 0, num = 100) {
    return this.rpc('aria2.tellStopped', [offset, num, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'connections', 'errorCode', 'errorMessage', 'dir', 'files']], 8000)
  }

  /** 单个任务的状态（「换直链」需要先知道任务当前是不是还活着） */
  tellStatus(gid) {
    return this.rpc(
      'aria2.tellStatus',
      [gid, ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'connections', 'errorCode', 'errorMessage', 'dir', 'files']],
      8000,
    )
  }

  getGlobalStat() {
    return this.rpc('aria2.getGlobalStat')
  }

  pause(gid) {
    return this.rpc('aria2.pause', [gid])
  }

  unpause(gid) {
    return this.rpc('aria2.unpause', [gid])
  }

  pauseAll() {
    return this.rpc('aria2.pauseAll')
  }

  unpauseAll() {
    return this.rpc('aria2.unpauseAll')
  }

  remove(gid) {
    return this.rpc('aria2.forceRemove', [gid]).catch(() => this.rpc('aria2.remove', [gid]))
  }

  /**
   * 把一条任务从 aria2 的结果列表里**彻底**清除。
   *
   * ⚠️ 只调 `remove` / `forceRemove` 是不够的：那两个方法对「已完成 / 已出错」的任务
   * 会直接报错（它不在活动列表里），对「正在下载」的任务则只是把它**挪进**停止列表。
   * 而 taskManager 每 800ms 会 `tellStopped` 把停止列表读回来，于是任务永远赖在界面上
   * —— 用户看到的现象就是「点了移除，毫无反应」。
   */
  removeDownloadResult(gid) {
    return this.rpc('aria2.removeDownloadResult', [gid])
  }

  purgeDownloadResult() {
    return this.rpc('aria2.purgeDownloadResult').catch(() => null)
  }

  changeGlobalOption(opts) {
    return this.rpc('aria2.changeGlobalOption', [opts])
  }

  /** 换掉某个任务的下载地址（fileIndex 从 1 开始）。用于「直链过期 / 想换节点」时重新解析。 */
  changeUri(gid, fileIndex, delUris = [], addUris = [], position = 1) {
    const params = [gid, fileIndex, delUris, addUris]
    if (addUris.length && (delUris.length || position > 1)) params.push(position)
    return this.rpc('aria2.changeUri', params)
  }

  /** 改单个任务的选项（header / user-agent 等） */
  changeOption(gid, opts) {
    return this.rpc('aria2.changeOption', [gid, opts])
  }
}

module.exports = new Aria2()
