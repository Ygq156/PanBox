'use strict'

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DEFAULT_UA } = require('../parsers/util')

const FILE = () => path.join(app.getPath('userData'), 'settings.json')

function defaultDownloadDir() {
  let base
  try {
    base = app.getPath('downloads')
  } catch {
    base = path.join(os.homedir(), 'Downloads')
  }
  return path.join(base, 'PanBox')
}

const DEFAULTS = () => ({
  downloadDir: defaultDownloadDir(),
  maxConcurrent: 3,
  split: 16,
  maxConnectionPerServer: 16,
  minSplitSize: '1M',
  userAgent: DEFAULT_UA,
  cookies: {},
  aria2Port: 6800,
  openFolderWhenDone: false,
  /* 点右上角 × 之后留在后台继续跑（窗口隐藏到托盘）。
   * 默认开：PanBox 的下载主力是 aria2 与自研分段引擎，关掉窗口不该把下载掐死，
   * 浏览器插件的本地通道也要一直在。真正退出走托盘菜单的「退出」。 */
  closeToTray: true,
  /* 用户自备的「网盘解析接口」（见 electron/parsers/custom.js 顶部注释）。
   * 默认空 —— 程序不内置、也不推荐任何具体解析站。 */
  parseEndpoints: [],
  // 「解析接口」的用户承诺开关：默认关，必须在设置页勾选后才允许保存启用中的接口
  endpointAck: false,
  /* 自研分段下载器的连接数（按网盘）。
   * 为什么需要它：夸克/UC 的 CDN 是**按每条 TCP 连接**发额度的（实测夸克 ≈50KB/s/连接、
   * UC ≈64KB/s/连接），而 aria2 的 `--max-connection-per-server` 上限只有 16，
   * 于是被钉死在 16 × 0.05 ≈ 0.8 MB/s。这个引擎自己开连接，不受那个上限约束。
   * 百度不在此表 —— 它是**账号级总量**限速，加连接只会招致 403（实测 16/24 连接直接 403）。 */
  segConnections: { quark: 96, uc: 96, direct: 128 },
  /* 百度走 aria2，连接数单独一个开关。默认 1 = 只吃账号本来的额度、不招惹惩罚性限速；
   * 超级会员可以往上调（油小猴那类脚本也是「建议开通超级会员后使用」，道理一样）。 */
  baiduConnections: 1,
  /* 代理。为什么默认跟着系统走：实测同一个 GitHub 66 MB 资源，
   * 裸连是 0 B/s（SSL/TLS handshake failure），跟着系统代理（Clash）能到 10 MB/s。
   * NDM 之所以快，就是因为它跟随 WinINET 系统代理。见 electron/core/proxy.js。 */
  proxyMode: 'auto',
  proxy: '',
  /* 忽略证书错误。默认**关**：两个下载引擎（aria2 的 --check-certificate、自研分段器的
   * rejectUnauthorized）与解析请求都按 Node/aria2 的默认校验证书。以前是硬编码不校验，
   * 公共 WiFi 或系统代理里的中间人能静默替换下载内容（含 .exe/.msi）。
   * 只有确实遇到「证书过期/自签的网盘 CDN」时才在设置里打开，代价是失去这一层保护。 */
  ignoreCert: false,
  /* 浏览器插件接收通道（见 electron/core/bridge.js）。
   * 默认开：它只监听 127.0.0.1，公网与局域网都连不上，而且投递任务要带令牌。 */
  bridgeEnabled: true,
  bridgePort: 7799,
  bridgeToken: '',
})

let cache = null

/* ------------------------------------------------------------------ */
/* 给渲染层看的脱敏副本                                                */
/* ------------------------------------------------------------------ */

/** 渲染层拿到的 cookie 是打码串；原样回传时主进程据此识别「用户没改这一格」 */
const COOKIE_MASK = '__PANBOX_KEEP__'

/** 给列表/设置页显示用的打码：只露尾巴 4 位，方便用户认出「是哪一个账号」 */
function maskCookieValue(v) {
  const s = String(v || '')
  if (!s) return ''
  return s.length <= 4 ? COOKIE_MASK : COOKIE_MASK /* 保持定长，避免从长度反推 */
}

/**
 * 渲染层不该拿到账号级凭证原文：百度 BDUSS、夸克/UC __puus、迅雷 access_token
 * 一旦能在页面上被脚本读到，就等于账号失守（而且 settings:get 是渲染层随时可调的 IPC）。
 * 所以 cookie 出主进程前一律打码，回传时再按「打码串 = 保持原值」还原。
 */
function forRenderer(cfg) {
  const out = { ...cfg }
  const cookies = {}
  for (const [k, v] of Object.entries(cfg.cookies || {})) cookies[k] = v ? maskCookieValue(v) : ''
  out.cookies = cookies
  return out
}

/**
 * 把渲染层提交的 cookie 合并回真实值：打码串 → 保留旧值，空串 → 清除，其它 → 新值。
 * 只合并已知的网盘键，防止渲染层往 cookies 里塞任意键。
 */
function mergeCookies(incoming, current) {
  const out = { ...(current || {}) }
  for (const [k, v] of Object.entries(incoming || {})) {
    const s = v === undefined || v === null ? '' : String(v)
    if (s === COOKIE_MASK) continue /* 打码串 = 用户没动这一格 */
    out[k] = s
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 主进程侧的字段白名单与范围                                          */
/* ------------------------------------------------------------------ */

/**
 * settings:set 的入参校验。渲染层能改的东西必须是「用户本来就能在设置页改的」，
 * 且类型/范围正确 —— 这样即便渲染层被注入脚本，也不能把 downloadDir 指到启动目录、
 * 把 proxy 指到攻击者的 MITM、或塞一个 3 字符的 bridgeToken。
 * @returns {{ok:true, value:object}|{ok:false, message:string}}
 */
function sanitizePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, message: '设置必须是对象' }
  }
  const d = DEFAULTS()
  const out = {}
  const str = (v, max, name) => {
    if (typeof v !== 'string') throw new Error(`${name} 必须是字符串`)
    const s = v.trim()
    if (s.length > max) throw new Error(`${name} 过长`)
    return s
  }
  const int = (v, lo, hi, name) => {
    const n = Number(v)
    if (!Number.isFinite(n) || Math.floor(n) !== n) throw new Error(`${name} 必须是整数`)
    if (n < lo || n > hi) throw new Error(`${name} 必须在 ${lo}~${hi} 之间`)
    return n
  }
  const bool = (v, name) => {
    if (typeof v !== 'boolean') throw new Error(`${name} 必须是布尔值`)
    return v
  }
  try {
    if ('downloadDir' in patch) {
      const s = str(patch.downloadDir, 512, '下载目录')
      if (!s) throw new Error('下载目录不能为空')
      if (!path.isAbsolute(s)) throw new Error('下载目录必须是绝对路径')
      out.downloadDir = path.resolve(s)
    }
    if ('maxConcurrent' in patch) out.maxConcurrent = int(patch.maxConcurrent, 1, 16, '同时下载数')
    if ('split' in patch) out.split = int(patch.split, 1, 64, '单任务连接数')
    if ('maxConnectionPerServer' in patch) {
      out.maxConnectionPerServer = int(patch.maxConnectionPerServer, 1, 16, '单服务器连接数')
    }
    if ('minSplitSize' in patch) {
      const s = str(patch.minSplitSize, 16, '最小分片')
      if (!/^\d+[KMG]$/i.test(s)) throw new Error('最小分片要写成 1M / 512K 这样')
      out.minSplitSize = s.toUpperCase()
    }
    if ('userAgent' in patch) out.userAgent = str(patch.userAgent, 512, 'User-Agent')
    if ('aria2Port' in patch) out.aria2Port = int(patch.aria2Port, 1024, 65535, 'aria2 端口')
    if ('openFolderWhenDone' in patch) out.openFolderWhenDone = bool(patch.openFolderWhenDone, '完成后打开目录')
    if ('closeToTray' in patch) out.closeToTray = bool(patch.closeToTray, '关闭到后台')
    if ('ignoreCert' in patch) out.ignoreCert = bool(patch.ignoreCert, '忽略证书错误')
    if ('endpointAck' in patch) out.endpointAck = bool(patch.endpointAck, '解析接口承诺')
    if ('baiduConnections' in patch) out.baiduConnections = int(patch.baiduConnections, 1, 16, '百度连接数')
    if ('proxyMode' in patch) {
      const s = str(patch.proxyMode, 16, '代理模式')
      if (!['auto', 'off', 'custom'].includes(s)) throw new Error('代理模式只能是 auto / off / custom')
      out.proxyMode = s
    }
    if ('proxy' in patch) {
      const s = str(patch.proxy, 256, '代理地址')
      if (s && !/^(https?|socks5?):\/\/[^\s/]+/i.test(s)) throw new Error('代理地址要写成 http://主机:端口')
      out.proxy = s
    }
    if ('bridgeEnabled' in patch) out.bridgeEnabled = bool(patch.bridgeEnabled, '插件通道开关')
    if ('bridgePort' in patch) out.bridgePort = int(patch.bridgePort, 1024, 65535, '插件通道端口')
    if ('bridgeToken' in patch) {
      /* 令牌就是本机通道唯一的那道门，不能由渲染层随手设成短串/空串。
       * 想换令牌走 bridge:newToken（或留空 = 保持原值）。 */
      const s = str(patch.bridgeToken, 128, '配对令牌')
      if (!s) {
        /* 保持原值 */
      } else if (s.length < 16) {
        throw new Error('配对令牌至少 16 位（请用「重新生成」按钮）')
      } else {
        out.bridgeToken = s
      }
    }
    if ('segConnections' in patch) {
      const src = patch.segConnections
      if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('分段连接数必须是对象')
      const seg = { ...d.segConnections }
      for (const [k, v] of Object.entries(src)) {
        if (!(k in d.segConnections)) continue /* 未知网盘键直接忽略 */
        seg[k] = int(v, 0, 256, `分段连接数(${k})`) /* 0 = 该网盘退回 aria2，是设置页允许的取值 */
      }
      out.segConnections = seg
    }
    if ('cookies' in patch) {
      const src = patch.cookies
      if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('cookies 必须是对象')
      const out2 = {}
      for (const [k, v] of Object.entries(src)) {
        if (!/^[a-z0-9_-]{1,24}$/i.test(k)) continue
        const s = v === undefined || v === null ? '' : String(v)
        out2[k] = s.length > 4096 ? s.slice(0, 4096) : s
      }
      out.cookies = out2
    }
    if ('parseEndpoints' in patch) {
      const src = patch.parseEndpoints
      if (!Array.isArray(src)) throw new Error('解析接口必须是数组')
      if (src.length > 20) throw new Error('解析接口最多 20 条')
      out.parseEndpoints = src.map((ep) => {
        const e = ep && typeof ep === 'object' ? ep : {}
        const o = {
          name: String(e.name || '').slice(0, 64),
          url: String(e.url || '').trim().slice(0, 1024),
          method: String(e.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
          enabled: e.enabled !== false,
        }
        if (!/^https?:\/\//i.test(o.url)) throw new Error(`解析接口地址必须是 http(s)：${o.url.slice(0, 60)}`)
        for (const k of ['headers', 'body', 'field', 'contentType', 'dlHeaders']) {
          if (e[k] !== undefined && e[k] !== null) o[k] = typeof e[k] === 'string' ? e[k].slice(0, 4096) : e[k]
        }
        if (Array.isArray(e.netdisks)) o.netdisks = e.netdisks.filter((x) => typeof x === 'string').slice(0, 24)
        if (e.allowLocal === false) o.allowLocal = false /* 只有显式关掉才带这个字段 */
        return o
      })
    }
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) }
  }
  return { ok: true, value: out }
}

function load() {
  if (cache) return cache
  const base = DEFAULTS()
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
      cache = {
        ...base,
        ...raw,
        cookies: { ...base.cookies, ...(raw.cookies || {}) },
        /* segConnections 必须按 key 合并：老用户的这份配置是在 direct 这一项存在之前存的，
         * 整表覆盖会让 direct 掉成 0，直链于是退回 aria2 的 16 线程。 */
        segConnections: { ...base.segConnections, ...(raw.segConnections || {}) },
      }
    } else {
      cache = base
    }
  } catch {
    cache = base
  }
  return cache
}

function save(partial) {
  const cur = load()
  const next = { ...cur, ...(partial || {}) }
  if (partial && partial.cookies) next.cookies = { ...cur.cookies, ...partial.cookies }
  if (partial && partial.segConnections) next.segConnections = { ...cur.segConnections, ...partial.segConnections }
  cache = next
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true })
    fs.writeFileSync(FILE(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* 配置写不进去也不该让程序崩掉 */
  }
  try {
    fs.mkdirSync(next.downloadDir, { recursive: true })
  } catch {
    /* ignore */
  }
  return next
}

module.exports = {
  load,
  save,
  defaultDownloadDir,
  /* 渲染层脱敏 / 入参校验（IPC 用，见 electron/main.js 的 settings:get / settings:set） */
  forRenderer,
  sanitizePatch,
  mergeCookies,
  COOKIE_MASK,
}
