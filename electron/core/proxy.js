'use strict'

/**
 * 代理探测与归一化。
 *
 * 为什么需要这个文件：实测发现 NDM 之所以下 GitHub 能到 5 MB/s，而 PanBox 只有 1 MB/s
 * （甚至经常直接 0 B/s、报 SSL/TLS handshake failure），差别不在连接数，而在**代理**：
 * NDM 会跟随 Windows 的系统代理（WinINET 设置 → 本机 Clash 127.0.0.1:7897），
 * PanBox 的 aria2 与自研分段引擎都是裸连，而被墙的线路裸连基本不可用。
 *
 * 实测对照（同一个 GitHub 66 MB 资源，aria2 -x16 -s16）：
 *   直连           → SSL/TLS handshake failure，0 B/s
 *   --all-proxy=…  → 7.9 → 9.9 MiB/s，63 MiB 约 7 秒下完
 *
 * 所以这里读的是**系统代理**，而不是自己维护一份代理配置。
 */

const { execFileSync } = require('node:child_process')

const WININET = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
/** 系统代理的缓存时长：注册表查询要起一个 reg.exe 进程，不值得每次下载都问一遍 */
const TTL = 60 * 1000
/** 这些主机永远不走代理：本地测试服务器、局域网设备 */
const NO_PROXY = 'localhost,127.0.0.1,::1'

let cache = { at: 0, value: null }

function readReg(name) {
  try {
    const out = execFileSync('reg.exe', ['query', WININET, '/v', name], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`).exec(out)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

/**
 * 把注册表里的写法统一成 `http://host:port`。
 * 可能是 `127.0.0.1:7897`，也可能是 `http=1.2.3.4:8080;https=1.2.3.4:9090`。
 */
function normalize(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  let hostport = s
  if (s.includes('=')) {
    const parts = {}
    for (const seg of s.split(';')) {
      const i = seg.indexOf('=')
      if (i > 0) parts[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim()
    }
    hostport = parts.https || parts.http || Object.values(parts).find(Boolean) || ''
  }
  if (!hostport) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostport)) return hostport
  return 'http://' + hostport
}

/** 读 Windows 系统代理；没开或读不到就返回 '' */
function systemProxy({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && cache.value !== null && now - cache.at < TTL) return cache.value
  let value = ''
  try {
    if (readReg('ProxyEnable').toLowerCase() === '0x1') value = normalize(readReg('ProxyServer'))
  } catch {
    value = ''
  }
  cache = { at: now, value }
  return value
}

/**
 * 按设置算出这次要用的代理。
 * `proxyMode`: `auto`（跟随系统，默认）| `off`（从不）| `custom`（用 `proxy` 字段）
 */
function effective(cfg) {
  const mode = (cfg && cfg.proxyMode) || 'auto'
  if (mode === 'off') return ''
  if (mode === 'custom') return normalize((cfg && cfg.proxy) || '')
  return systemProxy()
}

/** 这个主机要不要绕过代理（本机 + 局域网一律直连） */
function shouldBypass(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h === '::1') return true
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || h.endsWith('.home')) return true
  if (!h.includes('.')) return true // 裸主机名（NAS、路由器）也按内网处理
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true // link-local
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  return false
}

module.exports = {
  systemProxy,
  normalize,
  effective,
  shouldBypass,
  NO_PROXY,
  WININET,
  clearCache: () => {
    cache = { at: 0, value: null }
  },
}
