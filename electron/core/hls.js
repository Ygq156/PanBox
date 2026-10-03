'use strict'

/**
 * 通用 HLS（m3u8）下载引擎 —— 不认站点，只认协议。
 *
 * 为什么必须有
 * ------------
 * 流媒体站点把视频切成几百上千个几秒的小分片，用一个 `.m3u8` 播放列表描述它们。
 * 在这之前 PanBox 眼里 `.m3u8` 就是一个普通网址：aria2 把它当文本下下来，
 * 用户拿到一个几 KB 的播放列表文件，什么也看不了。而 aria2 **官方至今不支持 HLS**
 * （手册全文 0 处提到 m3u8/HLS，issue #1271「please supports HLS」2018 年提的，到现在还开着），
 * 所以这不是「调个参数」能解决的，必须自己做一遍列表解析 + 分片并发 + 解密 + 拼接。
 *
 * 为什么是「通用」的
 * ----------------
 * HLS 是公开标准（RFC 8216）：只要实现了列表解析，**任何一个**用 HLS 的站点都能下，
 * 不需要为它写解析器。这正是 you-get / lux / yt-dlp / N_m3u8DL-RE 这些工具的做法 ——
 * 认协议，不认站点。相比之下逐个站点逆向是另一条路，边际收益递减（见项目里的逐站解析器）。
 *
 * 做什么 / 不做什么
 * ----------------
 * - 做：主列表选流、媒体列表解析、分片并发下载与重试、`#EXT-X-BYTERANGE`、
 *   `#EXT-X-MAP`（fMP4 初始化段）、AES-128 解密与密钥轮换、拼接落盘、暂停/继续/移除。
 * - 不做：SAMPLE-AES / CENC / Widevine 这类商业 DRM 解密 —— 那既是技术坑也是法律红线，
 *   正规工具（如 N_m3u8DL-RE）也是交给外部 mp4decrypt / Shaka Packager，自己不解。
 * - 不做：DASH（.mpd）。列表格式不同，第一版先只支持 HLS，遇到 .mpd 明确告知而不是
 *   当普通文件下下来（见 `classify`）。
 *
 * 接口形状
 * --------
 * 与 `segmentDownloader.js` 一样，对外做成 **aria2 的 `tellStatus` 形状**
 * （`gid / status / totalLength / completedLength / downloadSpeed / files[0].path`），
 * 这样 `taskManager` 能用同一套代码把三套引擎合并进一个列表。
 */

const { EventEmitter, once } = require('node:events')
const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { fetchBytes, fetchText, sleep } = require('./httpStream')

/** 同时下载的分片数。HLS 分片很小（几秒一个），8 条足够把大多数 CDN 跑满 */
const DEFAULT_CONNS = 8
const MAX_CONNS = 32
/** 单个分片的失败重试次数（含首次）。CDN 偶发 5xx 很常见，重试比失败划算 */
const SEG_TRIES = 3
/** 分片数上限：防呆。见过的正常 VOD 最多几千片，超过只能说明列表被拼坏了 */
const MAX_SEGS = 20000
/** 分片默认超时：分片普遍只有几百 KB，60 秒还没完说明连接已经死了 */
const SEG_TIMEOUT = 60000
/** 播放列表超时：列表本身很小，慢就是站点问题 */
const LIST_TIMEOUT = 30000

const sleepMs = sleep

/* ------------------------------------------------------------------ */
/* 播放列表解析                                                        */
/* ------------------------------------------------------------------ */

/**
 * 解析 `#EXT-X-...:A=1,B="x,y"` 这种属性串。
 * 必须自己写而不是 `split(',')`：`CODECS="avc1.4d401f,mp4a.40.2"` 里的逗号是值的一部分，
 * 用 split 会把一个属性拆成两个，选流时按 CODECS 判断就会出错。
 */
function parseAttrs(str) {
  const out = {}
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g
  let m
  while ((m = re.exec(str))) {
    const k = m[1].toUpperCase()
    let v = m[2]
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

/** 相对地址转绝对（播放列表里的分片地址几乎都是相对的） */
function absUrl(u, base) {
  try {
    return new URL(String(u).trim(), base).toString()
  } catch {
    return ''
  }
}

/** `#EXT-X-BYTERANGE:<长度>[@<起点>]`；起点省略时接着上一段的末尾（标准规定） */
function parseByteRange(str, prevEnd) {
  const s = String(str).trim()
  const at = s.indexOf('@')
  const len = Number(at < 0 ? s : s.slice(0, at))
  if (!Number.isFinite(len) || len <= 0) return null
  const off = at < 0 ? Number(prevEnd) || 0 : Number(s.slice(at + 1))
  if (!Number.isFinite(off) || off < 0) return null
  return { len, off }
}

/**
 * 解析一个 m3u8。返回：
 * - 主列表：`{ type:'master', variants:[{ url, bandwidth, resolution, codecs }] }`
 * - 媒体列表：`{ type:'media', segments:[{ url, dur, title, seq, key, range }], map, live, totalDur }`
 *
 * `key` 挂在**每个分片**上而不是整份列表上：标准允许中途换密钥（`#EXT-X-KEY` 可以出现多次），
 * 只在列表级别记一个密钥的话，换过密钥的直播/长视频会解出乱码。
 */
function parsePlaylist(text, baseUrl) {
  const src = String(text || '')
  if (!/#EXTM3U/.test(src.slice(0, 4096))) throw new Error('这不是 m3u8 播放列表')
  const lines = src.split(/\r?\n/)
  const variants = []
  const segments = []
  let pendingInf = null
  let pendingVariant = null
  let key = null
  let map = null
  let pendingRange = null
  let prevEnd = 0
  let mediaSequence = 0
  let endList = false
  let totalDur = 0

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const up = line.toUpperCase()
      if (up.startsWith('#EXT-X-STREAM-INF:')) {
        pendingVariant = parseAttrs(line.slice(line.indexOf(':') + 1))
      } else if (up.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = Number(line.slice(line.indexOf(':') + 1)) || 0
      } else if (up.startsWith('#EXTINF:')) {
        const v = line.slice(8).split(',')
        pendingInf = { dur: Number(v[0]) || 0, title: v.slice(1).join(',') }
      } else if (up.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(line.slice(line.indexOf(':') + 1))
        const method = String(a.METHOD || 'NONE').toUpperCase()
        if (method === 'NONE') key = null
        else if (method === 'AES-128') key = { method, uri: absUrl(a.URI, baseUrl), iv: a.IV || '' }
        else key = { method, unsupported: true }
      } else if (up.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(line.slice(line.indexOf(':') + 1))
        map = { url: absUrl(a.URI, baseUrl), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null }
      } else if (up.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = parseByteRange(line.slice(line.indexOf(':') + 1), prevEnd)
      } else if (up.startsWith('#EXT-X-ENDLIST')) {
        endList = true
      }
      continue
    }
    /* 非 # 行一定是地址：要么是主列表的流地址，要么是媒体列表的一个分片 */
    if (pendingVariant) {
      variants.push({
        url: absUrl(line, baseUrl),
        bandwidth: Number(pendingVariant.BANDWIDTH) || 0,
        resolution: pendingVariant.RESOLUTION || '',
        codecs: pendingVariant.CODECS || '',
      })
      pendingVariant = null
      continue
    }
    const u = absUrl(line, baseUrl)
    if (!u) continue
    if (pendingRange) prevEnd = pendingRange.off + pendingRange.len
    segments.push({
      url: u,
      dur: pendingInf ? pendingInf.dur : 0,
      title: pendingInf ? pendingInf.title : '',
      seq: mediaSequence + segments.length,
      key,
      range: pendingRange,
    })
    totalDur += pendingInf ? pendingInf.dur : 0
    pendingInf = null
    pendingRange = null
  }

  if (variants.length) return { type: 'master', variants }
  return { type: 'media', segments, map, live: !endList, totalDur }
}

/**
 * 主列表里挑一路流。
 * 默认挑码率最高的一路 —— 下载器的语义是「存下来」，能存最好的一路就存最好的；
 * 想省流量的人可以在界面上取消重下低码率那一路（各路的地址都在 `variants` 里）。
 * `maxHeight` 给了就只挑不超过它的最高一路。
 */
function pickVariant(variants, { maxHeight = 0 } = {}) {
  const list = (variants || []).filter((v) => v && v.url)
  if (!list.length) return null
  const height = (v) => Number(String(v.resolution || '').split('x')[1]) || 0
  const ok = maxHeight > 0 ? list.filter((v) => !height(v) || height(v) <= maxHeight) : list
  const pool = ok.length ? ok : list
  return pool.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0) || height(b) - height(a))[0]
}

/** 分片的 AES-128 IV：给了就用给的，没给按标准用「媒体序号」当 128 位大端整数 */
function ivFor(key, seq) {
  const hex = String((key && key.iv) || '').replace(/^0[xX]/, '')
  if (hex.length === 32) return Buffer.from(hex, 'hex')
  const b = Buffer.alloc(16)
  b.writeUInt32BE(Math.max(0, Number(seq) || 0) >>> 0, 12)
  return b
}

/**
 * 这个地址/响应类型是不是「要按协议处理」的东西。
 * 返回 `'hls'`（m3u8）、`'dash'`（.mpd，暂不支持但必须认出来）或 `''`（普通直链）。
 *
 * 为什么要连 dash 一起认出来：现在把 `.mpd` 丢给 aria2，用户拿到的是一个 XML。
 * 宁可明确告诉用户「这类暂不支持」，也不要给他一个打不开的文件。
 */
function classify(url, contentType = '', head = '') {
  const u = String(url || '')
  const ct = String(contentType || '').toLowerCase()
  const pathname = (() => {
    try {
      return new URL(u).pathname.toLowerCase()
    } catch {
      return u.toLowerCase()
    }
  })()
  if (/\.m3u8$/.test(pathname) || /mpegurl/.test(ct)) return 'hls'
  if (/\.mpd$/.test(pathname) || /dash\+xml/.test(ct)) return 'dash'
  /* 地址没后缀（`/playlist?token=…` 这种很常见）时看响应体的头几个字节 */
  if (/^#EXTM3U/.test(String(head || '').replace(/^\uFEFF/, ''))) return 'hls'
  return ''
}

/** 分片没有后缀时，按有没有 fMP4 初始化段决定存成 .mp4 还是 .ts */
function outName(name, { fmp4 = false, ext = '', url = '' } = {}) {
  const raw = String(name || '').trim()
  const e = String(ext || '') || (fmp4 ? '.mp4' : '.ts')
  let base = raw
  if (!base) {
    try {
      base = path.basename(new URL(url).pathname) || 'video'
    } catch {
      base = 'video'
    }
  }
  base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'video'
  if (base.toLowerCase().endsWith(e)) return base
  /* 播放列表/占位后缀一律以**实际容器**为准：`x.m3u8` 存成 ts/mp4 才打得开，
   * 插件猜的 `x.bin` 更不能留着当视频名。
   * 例外是「看着像后缀其实是名字的一部分」（`Interstellar.2014`）——
   * 数字结尾的段不算后缀，接在后面而不是替换掉。 */
  if (/\.[A-Za-z0-9]{1,6}$/.test(base) && !/\.\d{1,6}$/.test(base)) return base.replace(/\.[A-Za-z0-9]{1,6}$/, e)
  return base + e
}

/** 产物后缀取自分片地址 —— 音频流（.aac/.m4a/.mp3）不该被叫成 .ts */
function extForSegments(segs, fmp4) {
  if (fmp4) return '.mp4'
  const first = segs && segs[0] ? String(segs[0].url).split(/[?#]/)[0] : ''
  const m = /\.(ts|m4s|mp4|aac|m4a|mp3|ogg|opus|flac|wav)$/i.exec(first)
  if (!m) return '.ts'
  const s = m[1].toLowerCase()
  return s === 'm4s' ? '.mp4' : '.' + s
}

/* ------------------------------------------------------------------ */
/* 下载器                                                              */
/* ------------------------------------------------------------------ */

class HlsDownloader extends EventEmitter {
  constructor() {
    super()
    /** gid -> task */
    this.tasks = new Map()
    this._seq = 0
    /** 同时下载任务数上限（0 = 不限）。与分段引擎共用设置里的「同时下载数」 */
    this.limit = 0
    /** 排队中的 gid；插队就是把 gid 挪到队首 */
    this.queue = []
  }

  /* -------------------------- 对外接口 -------------------------- */

  /**
   * 新建一个 HLS 下载任务。
   * @param {object} opts
   *   `url` 播放列表地址；`headers` 请求头；`dir` 落盘目录；`name` 文件名（可空）；
   *   `connections` 分片并发；`proxy`/`insecure` 与其它引擎同义；
   *   `maxHeight` 选流高度上限（0 = 取最高码率）。
   * @returns {Promise<string>} gid
   */
  async add(opts = {}) {
    const url = String(opts.url || '')
    if (!/^https?:/i.test(url)) throw new Error('播放列表地址不是 http(s)')
    const gid = `hls-${Date.now().toString(36)}-${(this._seq++).toString(36)}`
    const dir = String(opts.dir || process.cwd())
    const t = {
      gid,
      url,
      headers: opts.headers && typeof opts.headers === 'object' ? { ...opts.headers } : {},
      dir,
      name: String(opts.name || ''),
      conns: Math.max(1, Math.min(MAX_CONNS, Number(opts.connections) || DEFAULT_CONNS)),
      proxy: String(opts.proxy || ''),
      insecure: !!opts.insecure,
      maxHeight: Number(opts.maxHeight) || 0,
      source: String(opts.source || ''),
      netdisk: String(opts.netdisk || ''),
      status: 'waiting',
      error: '',
      total: 0,
      done: 0,
      bytes: 0,
      segs: [],
      map: null,
      live: false,
      fmp4: false,
      keyCache: new Map(),
      ac: null,
      tmpDir: '',
      finalPath: '',
      startedAt: Date.now(),
      samples: [],
    }
    this.tasks.set(gid, t)
    this.queue.push(gid)
    await fsp.mkdir(dir, { recursive: true }).catch(() => {})
    this.kick()
    return gid
  }

  has(gid) {
    return this.tasks.has(String(gid))
  }

  /** 与分段引擎同形：给 taskManager 合并用 */
  list() {
    return [...this.tasks.values()].map((t) => this._status(t))
  }

  tellStatus(gid) {
    const t = this.tasks.get(String(gid))
    return t ? this._status(t) : null
  }

  activeCount() {
    return [...this.tasks.values()].filter((t) => t.status === 'active').length
  }

  setLimit(n) {
    this.limit = Math.max(0, Number(n) || 0)
    this.kick()
  }

  /** 插队：把排队中的任务挪到队首 */
  jumpTop(gid) {
    const id = String(gid)
    const i = this.queue.indexOf(id)
    if (i > 0) this.queue.splice(i, 1), this.queue.unshift(id)
    this.kick()
  }

  async pause(gid) {
    const t = this.tasks.get(String(gid))
    if (!t || t.status === 'complete' || t.status === 'error') return false
    t.status = 'paused'
    if (t.ac) t.ac.abort()
    const i = this.queue.indexOf(t.gid)
    if (i >= 0) this.queue.splice(i, 1)
    return true
  }

  async unpause(gid) {
    const t = this.tasks.get(String(gid))
    if (!t || t.status !== 'paused') return false
    t.status = 'waiting'
    if (!this.queue.includes(t.gid)) this.queue.push(t.gid)
    this.kick()
    return true
  }

  async pauseAll() {
    for (const t of this.tasks.values()) {
      if (t.status === 'active' || t.status === 'waiting') await this.pause(t.gid)
    }
  }

  async unpauseAll() {
    for (const t of this.tasks.values()) if (t.status === 'paused') await this.unpause(t.gid)
  }

  /** 移除任务：掐掉请求、删掉临时分片。已完成的**产物文件不动**（与其它引擎一致） */
  async remove(gid) {
    const t = this.tasks.get(String(gid))
    if (!t) return false
    /* 先标状态再 abort：_run 的 catch 靠 `status !== 'active'` 区分
     * 「被取消」和「真失败」，不标的话移除会被记成一次错误。 */
    t.status = 'removed'
    if (t.ac) t.ac.abort()
    const i = this.queue.indexOf(t.gid)
    if (i >= 0) this.queue.splice(i, 1)
    this.tasks.delete(t.gid)
    await this._dropTmp(t)
    return true
  }

  /**
   * 与分段引擎的 `flush()` 对齐。
   * 分段引擎要靠它把 `.panbox.json` 断点边车写盘；HLS 不需要 ——
   * 断点就在临时分片文件本身（下完一片就是一个文件），没有额外状态要存。
   */
  async flush() {
    return true
  }

  /**
   * 这条地址/响应类型是不是要按协议处理的。
   * 返回 `'hls' | 'dash' | ''` —— 与引擎自己认列表用的是同一份判据（见 classify）。
   */
  classifyUrl(url, contentType = '', head = '') {
    return classify(url, contentType, head)
  }

  /**
   * 地址没后缀、响应类型也认不出来时，抓开头 512 字节看看是不是播放列表。
   *
   * **只该在这一种情况下用**（别的线索全都没有，而插件说它是个播放列表）：
   * 每次调用都要多发一个请求，批量添加时一个个探过去是不可接受的。
   * 返回 `'hls' | 'dash' | ''`。
   */
  async sniff(url, { headers = {}, proxy = '', insecure = false, signal } = {}) {
    const r = await fetchBytes(url, {
      headers,
      proxy,
      insecure,
      signal,
      range: 'bytes=0-511',
      timeout: LIST_TIMEOUT,
      max: 4096,
    })
    return classify(url, r.headers['content-type'] || '', r.buf.toString('utf8'))
  }

  /* -------------------------- 调度 -------------------------- */

  kick() {
    const capacity = this.limit > 0 ? this.limit - this.activeCount() : Number.MAX_SAFE_INTEGER
    let room = capacity
    while (room > 0 && this.queue.length) {
      const gid = this.queue.shift()
      const t = this.tasks.get(gid)
      if (!t || t.status !== 'waiting') continue
      room--
      this._run(t)
    }
  }

  async _run(t) {
    t.status = 'active'
    t.ac = new AbortController()
    const signal = t.ac.signal
    try {
      await this._prepare(t, signal)
      if (t.status !== 'active') return /* 准备阶段被暂停/移除 */
      await this._downloadSegments(t, signal)
      if (t.status !== 'active') return
      await this._concat(t)
      /* 先清临时分片、再报「完成」：否则监听 complete 的一方马上去看磁盘，
       * 还会看见一个正在被删的 `.panbox-hls-<gid>` 目录（本机测试约 1/5 概率复现）。 */
      await this._dropTmp(t)
      t.status = 'complete'
      t.doneAt = Date.now()
      this.emit('complete', t.gid)
    } catch (e) {
      if (signal.aborted && t.status !== 'active') return /* 暂停导致的取消不算失败 */
      /* 失败也一样：状态一变就等于对外宣告结束了，磁盘上不该还留着临时目录 */
      await this._dropTmp(t)
      await this._fail(t, e)
    } finally {
      this.kick()
    }
  }

  /** 删掉这条任务的临时分片目录（产物文件不动） */
  async _dropTmp(t) {
    if (!t.tmpDir) return
    await fsp.rm(t.tmpDir, { recursive: true, force: true }).catch(() => {})
    t.tmpDir = ''
  }

  /** 取列表、选流、建立分片清单与临时目录 */
  async _prepare(t, signal) {
    const common = { headers: t.headers, proxy: t.proxy, insecure: t.insecure, signal, timeout: LIST_TIMEOUT }
    let { text, url } = await fetchText(t.url, common)
    let pl = parsePlaylist(text, url)
    if (pl.type === 'master') {
      const v = pickVariant(pl.variants, { maxHeight: t.maxHeight })
      if (!v) throw new Error('主列表里没有可用的流')
      const r = await fetchText(v.url, common)
      pl = parsePlaylist(r.text, r.url)
      url = r.url
      t.bandwidth = v.bandwidth
      t.resolution = v.resolution
    }
    if (pl.type !== 'media') throw new Error('播放列表里没有分片')
    if (!pl.segments.length) throw new Error(pl.live ? '这是直播列表，当前还没有可下的分片' : '播放列表里没有分片')
    if (pl.segments.length > MAX_SEGS) throw new Error(`分片太多（${pl.segments.length}），疑似列表异常`)
    for (const s of pl.segments) {
      if (s.key && s.key.unsupported) throw new Error(`暂不支持的分片加密方式（${s.key.method}）`)
    }
    t.segs = pl.segments
    t.map = pl.map
    t.live = pl.live
    t.total = pl.segments.length
    t.fmp4 = !!pl.map
    t.playlistUrl = url
    t.tmpDir = path.join(t.dir, `.panbox-hls-${t.gid}`)
    t.name = outName(t.name, { ext: extForSegments(t.segs, t.fmp4), url: t.url })
    t.finalPath = path.join(t.dir, t.name)
    await fsp.mkdir(t.tmpDir, { recursive: true })
  }

  /** 分片文件名：序号补零，方便肉眼查临时目录。初始化段单独一个名字（它不是分片） */
  _segPath(t, i) {
    if (i < 0) return path.join(t.tmpDir, 'init-segment')
    return path.join(t.tmpDir, `seg-${String(i).padStart(6, '0')}`)
  }

  async _downloadSegments(t, signal) {
    /* 临时目录是断点的唯一来源，所以进度必须**从这里重新数**：
     * 接着上次继续时若在旧的 done/bytes 上继续加，已存在的分片会被算两遍，
     * 进度条会超过 100%，速度也会跳。 */
    t.done = 0
    t.bytes = 0
    t.samples = []
    /* 断点续下：临时目录里已经存在且非空的分片直接跳过 */
    const todo = []
    for (let i = 0; i < t.segs.length; i++) {
      const p = this._segPath(t, i)
      let st = null
      try {
        st = await fsp.stat(p)
      } catch {
        /* 没有就是没下过 */
      }
      if (st && st.size > 0) {
        t.done++
        t.bytes += st.size
        continue
      }
      todo.push(i)
    }
    if (t.map) {
      const mp = this._segPath(t, -1)
      const have = await fsp.stat(mp).then((s) => s.size > 0).catch(() => false)
      if (!have) await this._fetchOne(t, { url: t.map.url, range: t.map.range, seq: 0, key: null }, mp, signal)
      t.mapDone = true
    }
    let cursor = 0
    let failure = null
    const worker = async () => {
      while (true) {
        if (failure) return
        const idx = cursor++
        if (idx >= todo.length) return
        const i = todo[idx]
        const seg = t.segs[i]
        const out = this._segPath(t, i)
        try {
          const bytes = await this._fetchOne(t, seg, out, signal)
          t.done++
          t.bytes += bytes
          t.samples.push({ at: Date.now(), bytes: t.bytes })
          if (t.samples.length > 40) t.samples.shift()
        } catch (e) {
          failure = failure || e
          return
        }
      }
    }
    const n = Math.max(1, Math.min(t.conns, todo.length))
    await Promise.all(Array.from({ length: n }, worker))
    if (failure) throw failure
  }

  /** 下**一个**分片（含重试与解密），返回落盘字节数 */
  async _fetchOne(t, seg, outPath, signal) {
    let last = null
    for (let attempt = 0; attempt < SEG_TRIES; attempt++) {
      if (signal.aborted) throw new Error('已取消')
      try {
        const range = seg.range ? `bytes=${seg.range.off}-${seg.range.off + seg.range.len - 1}` : ''
        const { buf, status } = await fetchBytes(seg.url, {
          headers: t.headers,
          range,
          proxy: t.proxy,
          insecure: t.insecure,
          timeout: SEG_TIMEOUT,
          signal,
          /* 带 Range 时若服务端不认（回 200 全量），多读一点自救；不带 Range 的分片正常只有几百 KB */
          max: seg.range ? seg.range.len + 1024 : 256 * 1024 * 1024,
        })
        let body = buf
        /* 服务端忽略 Range 回了整段：自己切出要的那一段（旧 CDN 上真见过） */
        if (seg.range && status === 200 && body.length > seg.range.len) body = body.subarray(seg.range.off, seg.range.off + seg.range.len)
        if (seg.key && seg.key.method === 'AES-128') body = await this._decrypt(t, seg, body)
        await fsp.writeFile(outPath, body)
        return body.length
      } catch (e) {
        last = e
        if (signal.aborted) throw e
        if (attempt < SEG_TRIES - 1) await sleepMs(400 * (attempt + 1))
      }
    }
    throw last || new Error('分片下载失败')
  }

  /** AES-128-CBC 解密（每个分片独立填充，PKCS7 由 Node 自己去掉） */
  async _decrypt(t, seg, body) {
    const uri = seg.key.uri
    let key = t.keyCache.get(uri)
    if (!key) {
      const r = await fetchBytes(uri, {
        headers: t.headers,
        proxy: t.proxy,
        insecure: t.insecure,
        timeout: LIST_TIMEOUT,
        max: 4 * 1024,
      })
      key = r.buf
      t.keyCache.set(uri, key)
    }
    if (key.length !== 16) throw new Error('密钥长度不是 16 字节，无法解密')
    const d = crypto.createDecipheriv('aes-128-cbc', key, ivFor(seg.key, seg.seq))
    return Buffer.concat([d.update(body), d.final()])
  }

  /** 把分片按顺序拼成最终文件（临时分片是分开下的，完成顺序是乱的，必须按下标拼） */
  async _concat(t) {
    const out = fs.createWriteStream(t.finalPath)
    /* 一段一段地灌，`out` 背压满了就等 drain。
     * 不用 stream.pipeline：它每拼一段都往同一个写出流上挂一组监听器，
     * 上千个分片会一路挂着（10 个就报 MaxListenersExceededWarning）。 */
    const append = async (p) => {
      for await (const chunk of fs.createReadStream(p)) {
        if (!out.write(chunk)) await once(out, 'drain')
      }
    }
    try {
      if (t.map) await append(this._segPath(t, -1))
      for (let i = 0; i < t.segs.length; i++) await append(this._segPath(t, i))
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())))
    } catch (e) {
      out.destroy()
      throw e
    }
  }

  async _fail(t, e) {
    if (t.status === 'removed') return
    t.status = 'error'
    t.error = String((e && e.message) || e)
    t.errorAt = Date.now()
    /* 'error' 是可选事件（taskManager 只看状态）。没人听还 emit 的话，
     * EventEmitter 会把它当未捕获异常直接把进程带崩。 */
    if (this.listenerCount('error')) this.emit('error', t.gid, t.error)
  }

  /* -------------------------- 状态 -------------------------- */

  /** aria2 `tellStatus` 形状 —— taskManager / 界面都按这套字段读 */
  _status(t) {
    /* 下完时用真实字节数当总量，进度条才会正好 100% */
    const isDone = t.status === 'complete' && t.bytes > 0
    const est = t.done > 0 && t.total > 0 ? Math.round((t.bytes / t.done) * t.total) : 0
    const total = isDone ? t.bytes : est
    const completed = isDone ? t.bytes : Math.min(t.bytes, total || t.bytes)
    const speed = this._speed(t)
    return {
      gid: t.gid,
      engine: 'hls',
      status: t.status,
      name: t.name,
      dir: t.dir,
      /* 分片总数 / 已完成分片数：界面想显示「第几片」时用得上 */
      numSegments: String(t.total || 0),
      completedSegments: String(t.done || 0),
      totalLength: String(total || 0),
      completedLength: String(completed || 0),
      downloadSpeed: String(speed),
      connections: String(t.conns),
      live: !!t.live,
      resolution: t.resolution || '',
      files: [{ path: t.finalPath || path.join(t.dir, t.name || 'video.ts'), length: String(total || 0), completedLength: String(completed || 0), selected: 'true' }],
      errorCode: t.status === 'error' ? '1' : '0',
      errorMessage: t.error || '',
    }
  }

  /** 最近 10 秒的平均速度（分片完成是离散事件，瞬时值会一跳一跳） */
  _speed(t) {
    const now = Date.now()
    const win = t.samples.filter((s) => now - s.at <= 10000)
    if (win.length < 2) return 0
    const dt = (win[win.length - 1].at - win[0].at) / 1000
    if (dt <= 0) return 0
    return Math.max(0, Math.round((win[win.length - 1].bytes - win[0].bytes) / dt))
  }
}

const inst = new HlsDownloader()
module.exports = inst
module.exports.__internals = { parsePlaylist, parseAttrs, parseByteRange, pickVariant, ivFor, classify, outName, extForSegments, absUrl, DEFAULT_CONNS, MAX_SEGS }