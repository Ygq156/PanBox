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
    // 解析器实际会打这些 host，收割时按这些 URL 作用域取 cookie（见 harvestCookies）
    cookieUrls: ['https://pan.quark.cn/', 'https://drive-pc.quark.cn/'],
    // 夸克的登录态：__pus / __puus 系列
    logged: (list) => list.some((c) => /^__(puus|pus|uid)$/.test(c.name)),
  },
  uc: {
    name: 'UC网盘',
    url: 'https://drive.uc.cn/',
    domains: ['drive.uc.cn', 'pc-api.uc.cn', 'uc.cn'],
    cookieUrls: ['https://drive.uc.cn/', 'https://pc-api.uc.cn/'],
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
    /* ⚠️ 百度必须按 URL 作用域收割：`cookies.get({})` 会把 passport.baidu.com /
     * pcs.baidu.com 等域的 cookie（STOKEN_BFESS、PTOKEN、UBI、HMACCOUNT…）一起塞进来，
     * 发给 pan.baidu.com 时百度直接判 errno=-6（身份验证错误）——实测：
     *   全量 2068 字符 → errno=-6；按 https://pan.baidu.com/ 作用域 1410 字符 → errno=0。
     * 浏览器自己也只发作用域内那 13 条。 */
    cookieUrls: ['https://pan.baidu.com/'],
    // 百度登录态：BDUSS 是唯一硬指标
    logged: (list) => list.some((c) => c.name === 'BDUSS' && c.value && c.value.length > 20),
  },
  xunlei: {
    name: '迅雷云盘',
    url: 'https://pan.xunlei.com/',
    domains: ['pan.xunlei.com', 'xunlei.com'],
    /* 迅雷的 pan 接口用 Bearer token，**不是 cookie** —— 凭证存在浏览器 localStorage 里
     * （`credentials_<client_id>` / `deviceid`）。所以这里不用 cookie 收割，改成读 localStorage，
     * 并存成一个 JSON 字符串塞进 settings.cookies.xunlei（复用现有的凭证管道）。 */
    async read(ses, win) {
      if (!win || win.isDestroyed()) return { header: '', list: [], loggedIn: false }
      const raw = await win.webContents
        .executeJavaScript(
          `(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k) } return JSON.stringify(o) })()`,
          true,
        )
        .catch(() => '{}')
      let store = {}
      try {
        store = JSON.parse(raw || '{}')
      } catch {
        /* ignore */
      }
      let cred = null
      let clientId = ''
      for (const [k, v] of Object.entries(store)) {
        if (!/^credentials_/.test(k)) continue
        try {
          const j = JSON.parse(v)
          if (j && j.access_token) {
            cred = j
            // 键名后缀就是网页版真正使用的 client_id（实测 Xqp0kJBXWhwaTpB6，与 JWT aud 不一定相同）
            clientId = k.slice('credentials_'.length)
            break
          }
        } catch {
          /* ignore */
        }
      }
      if (!clientId && cred) {
        try {
          const p = JSON.parse(Buffer.from(String(cred.access_token).split('.')[1], 'base64url').toString())
          clientId = p.aud || p.client_id || ''
        } catch {
          /* ignore */
        }
      }
      /* device_id：网页版用的是 cookie `deviceid`（形如 `wdi10.<32位hex><2位>`）里去掉前缀的 32 位 hex。
       * localStorage 里那个 `deviceid` 实测取不到，必须从 cookie 拿。 */
      let deviceId = ''
      try {
        const all = await ses.cookies.get({})
        const c = all.find((x) => x.name === 'deviceid' && x.value)
        if (c) {
          const m = /^wdi\d+\.([0-9a-f]{32})/i.exec(c.value)
          deviceId = m ? m[1] : c.value
        }
      } catch {
        /* ignore */
      }
      if (!deviceId) deviceId = store.deviceid || store.device_id || (cred && (cred.deviceid || cred.device_id)) || ''
      if (!cred || !cred.access_token) return { header: '', list: [], loggedIn: false }
      let userId = cred.user_id || cred.sub || ''
      if (!userId) {
        // 有些版本把 user_id 放在别的 key 里
        for (const [k, v] of Object.entries(store)) {
          if (/user_?id$/i.test(k) && /^\d{4,}$/.test(String(v))) {
            userId = String(v)
            break
          }
        }
      }
      /* 迅雷的 pan 接口要一个「带 client info 的完整 captcha_token」（~784 字符）。
       * **空 token 去 init 只能拿到 282 字符的残废 token**，服务端回
       * `验证码无效（no client info found）`。网页版把这个完整 token 存在
       * localStorage 的 `captcha_<client_id>` 里（值是 `{"token":"ck0.…"}`），
       * 实测直接拿来用就是 200。所以这里顺手一并收割。 */
      let captchaToken = ''
      try {
        const raw2 = store['captcha_' + clientId]
        if (raw2) {
          const o = JSON.parse(raw2)
          captchaToken = String((o && (o.token || o.captcha_token)) || '')
        }
      } catch {
        /* ignore */
      }
      if (!captchaToken) {
        for (const [k, v] of Object.entries(store)) {
          if (!/^captcha_/.test(k)) continue
          const m = /ck0\.[A-Za-z0-9_.\-]+/.exec(String(v))
          if (m) {
            captchaToken = m[0]
            break
          }
        }
      }

      const blob = JSON.stringify({
        access_token: cred.access_token,
        refresh_token: cred.refresh_token || '',
        user_id: String(userId || ''),
        device_id: String(deviceId || ''),
        client_id: String(clientId || ''),
        captcha_token: captchaToken,
      })
      return { header: blob, list: [{ name: 'access_token', value: cred.access_token }], loggedIn: true }
    },
  },
}

function cookieHeader(list) {
  const seen = new Map()
  for (const c of list) seen.set(c.name, c.value)
  return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * 按 **URL 作用域** 收割 cookie —— 等价于浏览器真正会发给该站点的集合。
 *
 * 这里不能用 `cookies.get({})` + 域名后缀过滤：那会把别的子域专属的 cookie 也带上，
 * 百度的接口会因此判「身份验证错误」(errno=-6)。详见 SITES.baidu 的注释。
 *
 * @param {import('electron').Session} ses
 * @param {{url:string, cookieUrls?:string[]}} site
 */
async function harvestCookies(ses, site) {
  const urls = site.cookieUrls && site.cookieUrls.length ? site.cookieUrls : [site.url]
  const seen = new Map()
  for (const url of urls) {
    const list = await ses.cookies.get({ url })
    for (const c of list) if (!seen.has(c.name)) seen.set(c.name, c)
  }
  return [...seen.values()]
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
    let giveUp = null

    const finish = (payload) => {
      if (settled) return
      settled = true
      /* 两个计时器都要清：只清轮询的话，那个 5 分钟的兜底定时器会一直挂着，
       * 闭包里还攥着窗口与 finish，登录成功十秒后它才醒 —— 白占一份内存，
       * 也让「登录窗口关了没有」这类判断变得不好推理。 */
      if (timer) clearInterval(timer)
      if (giveUp) clearTimeout(giveUp)
      timer = null
      giveUp = null
      try {
        if (win && !win.isDestroyed()) win.destroy()
      } catch {
        /* ignore */
      }
      resolve(payload)
    }

    const harvest = async () => {
      if (typeof site.read === 'function') return site.read(ses, win)
      const mine = await harvestCookies(ses, site)
      return { header: cookieHeader(mine), list: mine, loggedIn: site.logged(mine) }
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
    giveUp = setTimeout(() => {
      if (!settled) finish({ ok: false, message: '登录超时（5 分钟）' })
    }, 5 * 60 * 1000)
  })
}

/** 清掉某个网盘的登录分区（退出登录）
 *
 * 「退出登录」必须两处一起清：浏览器分区（persist:login-*）和 settings.json 里
 * 那份 Cookie。只清前者的话，解析与下载照样能拿着旧 Cookie 成功 —— 用户会觉得
 * 这个按钮没用。本次运行内预热过的标记也一并忘掉。
 */
async function clearLogin(netdisk) {
  const site = SITES[netdisk]
  if (!site) return false
  const ses = session.fromPartition(`persist:login-${netdisk}`)
  await ses.clearStorageData({ storages: ['cookies', 'localstorage'] })
  warmedAt.delete(netdisk)
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
  quark: { name: '__puus', minTtlSec: 2 * 3600, warmMs: 15000 },
  uc: { name: '__puus', minTtlSec: 2 * 3600, warmMs: 15000 },
  baidu: null,
  // 迅雷没有短效 cookie，凭证在 localStorage 里，每次重读一遍即可
  xunlei: { name: '', minTtlSec: 0, warmMs: 0 },
}

/**
 * 本进程内「这个令牌是我刚预热出来的」记录：netdisk -> { value, at }。
 *
 * 为什么需要它：`__puus` 这类令牌**多半是会话型 cookie（没有 expirationDate）**，
 * Chromium 不会把它写进磁盘，程序一重启分区里就没有了 —— 于是 `freshEnough()` 永远为假，
 * 「每次解析都开一次隐藏窗口预热」既慢又容易失败（失败还会被上层当成「没登录」）。
 * 只要**本次运行内**刚预热过、分区里那个值也没变，就认为它够新。
 */
const warmedAt = new Map()

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
    if (typeof site.read === 'function') return site.read(ses, null)
    const mine = await harvestCookies(ses, site)
    return { header: cookieHeader(mine), list: mine, loggedIn: site.logged(mine) }
  }

  const cookieNow = async () => {
    if (!freshener || !freshener.name) return null
    return (await ses.cookies.get({ name: freshener.name }))[0] || null
  }

  const freshEnough = async () => {
    const c = await cookieNow()
    if (!c || !c.value) return false
    /* ① 有明确有效期且还够久 → 直接用 */
    if (c.expirationDate && c.expirationDate - Date.now() / 1000 > freshener.minTtlSec) return true
    /* ② 会话型 cookie：只要**本次运行内**刚预热出这个值，就当它够新 */
    const w = warmedAt.get(netdisk)
    if (w && w.value === c.value && Date.now() - w.at < freshener.minTtlSec * 1000) return true
    return false
  }

  const rememberWarm = async () => {
    const c = await cookieNow()
    if (c && c.value) warmedAt.set(netdisk, { value: c.value, at: Date.now() })
    else warmedAt.delete(netdisk)
  }

  if (!opts.force && (await freshEnough())) {
    const h = await harvest()
    if (h && h.loggedIn) return { ...h, refreshed: false }
  }

  const needRead = typeof site.read === 'function'
  let win = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 780,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        /* 关键：隐藏窗口默认会被 Chromium 降频（计时器被拉长到 1 秒甚至 1 分钟一档）。
         * `__puus` 是页面脚本现场算出来种下的，降频会让「前台几百毫秒」的预热
         * 拖到十几秒还没完成 —— 上层就会以为用户没登录（0.6.6 之前每次重启后
         * 首次解析都失败、甚至把已存的凭证抹掉，根因就在这里）。 */
        backgroundThrottling: false,
      },
    })
    /* 先把页面等出来再轮询令牌：SPA 首屏要几秒，之前是从打开窗口那一刻就开始掐 12 秒，
     * 网络稍慢就必然超时。 */
    const pageSettled = new Promise((resolve) => {
      let done = false
      const fin = () => {
        if (!done) {
          done = true
          resolve(true)
        }
      }
      win.webContents.once('did-finish-load', fin)
      win.webContents.once('did-fail-load', fin)
      setTimeout(fin, 15000)
    })
    await win.loadURL(site.url).catch(() => {})
    await pageSettled
    if (freshener && freshener.name) {
      const deadline = Date.now() + freshener.warmMs
      while (Date.now() < deadline) {
        await sleep(700)
        if (await freshEnough()) break
      }
      await rememberWarm()
    } else if (needRead) {
      // localStorage 型凭证：页面加载完还要等前端脚本把 token 写进去
      await sleep(2000)
    }
    if (needRead) {
      const got = await site.read(ses, win)
      return { ...got, refreshed: true }
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
