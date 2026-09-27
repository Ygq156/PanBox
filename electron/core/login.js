'use strict'

/**
 * 内置登录窗口：为需要凭证的网盘（夸克 / UC / 百度）打开一个独立分区的浏览器窗口，
 * 用户在里面正常登录（扫码或账号密码），登录完成后：
 *   - 命中该网盘的登录态 cookie 特征 → 自动收下并关闭；
 *   - 用户手动关闭窗口 → 也照样收下当前分区里的 cookie（容错路径）。
 *
 * 使用独立 partition（`persist:login-<netdisk>`），与主窗口 session 隔离，
 * 也不写入用户系统浏览器的任何数据。
 */

const { BrowserWindow, session } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SITES = {
  quark: {
    name: '夸克网盘',
    url: 'https://pan.quark.cn/',
    domains: ['pan.quark.cn', 'drive-pc.quark.cn', 'quark.cn'],
    // 夸克的登录态：__pus / __puus 系列
    logged: (list) => list.some((c) => /^__(puus|pus|uid)$/.test(c.name)),
  },
  uc: {
    name: 'UC网盘',
    url: 'https://drive.uc.cn/',
    domains: ['drive.uc.cn', 'pc-api.uc.cn', 'uc.cn'],
    /* UC 登录后会下发 __puus / __pus 以及 UDRIVE_* 令牌。
     * 注意：匿名访问也会种下 `UDRIVE_TRANSFER_SESS`，它**不是**登录标志（实测误报过），
     * 所以这里要求 __puus/__pus 有值，或出现 TRANSFER_SESS 之外的 UDRIVE_ 令牌。 */
    logged: (list) =>
      list.some((c) => /^(__puus|__pus)$/.test(c.name) && c.value && c.value.length > 8) ||
      list.some((c) => /^UDRIVE_/.test(c.name) && c.name !== 'UDRIVE_TRANSFER_SESS' && c.value && c.value.length > 20),
  },
  baidu: {
    name: '百度网盘',
    url: 'https://pan.baidu.com/',
    domains: ['pan.baidu.com', 'baidu.com'],
    // 百度登录态：BDUSS 是唯一硬指标
    logged: (list) => list.some((c) => c.name === 'BDUSS' && c.value && c.value.length > 20),
  },
}

function cookieHeader(list) {
  const seen = new Map()
  for (const c of list) seen.set(c.name, c.value)
  return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function pickCookies(all, domains) {
  return all.filter((c) =>
    domains.some((d) => c.domain === d || c.domain === '.' + d || c.domain.endsWith('.' + d) || c.domain.replace(/^\./, '') === d),
  )
}

/**
 * @param {'quark'|'uc'|'baidu'} netdisk
 * @param {BrowserWindow|null} parent
 * @returns {Promise<{ok:boolean, cookie?:string, count?:number, message?:string}>}
 */
async function openLogin(netdisk, parent) {
  const site = SITES[netdisk]
  if (!site) return { ok: false, message: '该网盘暂不支持内置登录' }

  const partition = `persist:login-${netdisk}`
  const ses = session.fromPartition(partition)

  return new Promise((resolve) => {
    let settled = false
    let win = null
    let timer = null

    const finish = (payload) => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      try {
        if (win && !win.isDestroyed()) win.destroy()
      } catch {
        /* ignore */
      }
      resolve(payload)
    }

    const harvest = async () => {
      const all = await ses.cookies.get({})
      const mine = pickCookies(all, site.domains)
      const header = cookieHeader(mine)
      return { header, list: mine, loggedIn: site.logged(mine) }
    }

    win = new BrowserWindow({
      width: 980,
      height: 760,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: false,
      title: `登录${site.name} — 登录完成后本窗口会自动关闭`,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    win.loadURL(site.url).catch(() => {})

    timer = setInterval(async () => {
      try {
        const { header, list, loggedIn } = await harvest()
        if (loggedIn) {
          finish({ ok: true, cookie: header, count: list.length, loggedIn: true })
        }
      } catch {
        /* ignore */
      }
    }, 1000)

    win.on('closed', async () => {
      if (settled) return
      try {
        const { header, list, loggedIn } = await harvest()
        if (!header) return finish({ ok: false, message: `没有拿到 ${site.name} 的 Cookie（可能未登录成功）` })
        // 手动关闭也收下，但要如实告诉调用方「有没有检测到明确的登录态」
        finish({ ok: true, cookie: header, count: list.length, loggedIn })
      } catch (e) {
        finish({ ok: false, message: e && e.message ? e.message : String(e) })
      }
    })

    // 兜底：5 分钟没有任何结果就放弃，避免计时器常驻
    setTimeout(() => {
      if (!settled) finish({ ok: false, message: '登录超时（5 分钟）' })
    }, 5 * 60 * 1000)
  })
}

/** 清掉某个网盘的登录分区（退出登录） */
async function clearLogin(netdisk) {
  const site = SITES[netdisk]
  if (!site) return false
  const ses = session.fromPartition(`persist:login-${netdisk}`)
  await ses.clearStorageData({ storages: ['cookies'] })
  return true
}

/**
 * 需要「网页 JS 现场生成」的短效令牌。
 *
 * 夸克是最典型的例子：`__puus` 由 pan.quark.cn 的前端脚本算出并种下，**CDN（dl-*-zb.drive.quark.cn）
 * 只认它**——不带 `__puus` 一律 412 Precondition Failed，带上（哪怕只带这一个 cookie）立刻 206。
 * 而 `__puus` 会过期，settings.json 里存的那份迟早失效，所以每次取直链前都要「暖」一次。
 */
const FRESH = {
  quark: { name: '__puus', minTtlSec: 2 * 3600, warmMs: 12000 },
  uc: { name: '__puus', minTtlSec: 2 * 3600, warmMs: 12000 },
  baidu: null,
}

/**
 * 让网盘首页把短效令牌重新种进登录分区，然后回收完整 cookie。
 * 令牌还足够新时直接返回，不打开窗口。
 *
 * @param {'quark'|'uc'|'baidu'} netdisk
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<null|{header:string, list:any[], loggedIn:boolean, refreshed:boolean}>}
 */
async function refreshCookie(netdisk, opts = {}) {
  const site = SITES[netdisk]
  if (!site) return null
  const partition = `persist:login-${netdisk}`
  const ses = session.fromPartition(partition)
  const freshener = FRESH[netdisk]

  const harvest = async () => {
    const all = await ses.cookies.get({})
    const mine = pickCookies(all, site.domains)
    return { header: cookieHeader(mine), list: mine, loggedIn: site.logged(mine) }
  }

  const freshEnough = async () => {
    if (!freshener) return false
    const c = (await ses.cookies.get({ name: freshener.name }))[0]
    return !!(c && c.value && c.expirationDate && c.expirationDate - Date.now() / 1000 > freshener.minTtlSec)
  }

  if (!opts.force && (await freshEnough())) {
    return { ...(await harvest()), refreshed: false }
  }

  let win = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 780,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    await win.loadURL(site.url).catch(() => {})
    if (freshener) {
      const deadline = Date.now() + freshener.warmMs
      while (Date.now() < deadline) {
        await sleep(700)
        if (await freshEnough()) break
      }
    }
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {
      /* ignore */
    }
  }

  const got = await harvest()
  return { ...got, refreshed: true }
}

module.exports = { openLogin, clearLogin, refreshCookie, SITES }
