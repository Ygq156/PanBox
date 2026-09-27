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
  segConnections: { quark: 96, uc: 96 },
})

let cache = null

function load() {
  if (cache) return cache
  const base = DEFAULTS()
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
      cache = { ...base, ...raw, cookies: { ...base.cookies, ...(raw.cookies || {}) } }
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
