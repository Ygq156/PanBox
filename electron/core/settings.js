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
  /* 浏览器插件接收通道（见 electron/core/bridge.js）。
   * 默认开：它只监听 127.0.0.1，公网与局域网都连不上，而且投递任务要带令牌。 */
  bridgeEnabled: true,
  bridgePort: 7799,
  bridgeToken: '',
})

let cache = null

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

module.exports = { load, save, defaultDownloadDir }
