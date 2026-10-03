'use strict'
/* 登录域：打开各网盘登录窗口、退出登录，以及解析前的「凭证预热」（夸克/UC 的 __puus、
 * 迅雷的 captcha_token）。单独成文件是因为这几个函数共用 settings 里那份 cookie 罐的
 * 读写约定，凭证相关改动只看这一处，不必翻整个 registerIpc。
 *
 * register() 会把内部的 warmCredentials 交出去：parse:share 在建立解析会话前要用它
 * 刷新短效令牌（这是七个域之间唯一的依赖，由 ipc/index.js 转交）。 */
const { ipcMain } = require('electron')

const settings = require('../core/settings')
const login = require('../core/login')

/**
 * @param {object} ctx main.js 组装的主进程局部依赖（见 main.js 里 require('./ipc') 那处调用）
 */
function register(ctx) {
  /* 与原来 registerIpc 闭包里的同名局部一一对应；下面各 handler 与 warmCredentials 逐字照搬。 */
  const { boot } = ctx

  /**
 * 打开某个网盘的登录窗口。**凭证留在主进程**：登录窗口抓到的 Cookie 原文
 * 直接落盘（settings.save），回给渲染层只有「成没成、抓了几条」。
 * 界面需要的只是一句状态 —— 让原文经过 IPC 等于把它交给页面脚本。
 */
  ipcMain.handle('login:open', async (_e, netdisk) => {
    const r = await login.openLogin(netdisk, ctx.win())
    let saveErr = ''
    if (r && r.ok && r.cookie) {
      const w = settings.save({ cookies: { [String(netdisk)]: r.cookie } })
      if (!w.ok) saveErr = w.message
      boot('login', String(netdisk), 'saved len=' + String(r.cookie).length, w.ok ? 'ok' : 'save failed')
    }
    return {
      ok: !!(r && r.ok),
      loggedIn: !!(r && r.loggedIn),
      count: r && r.count,
      /* 登录成了但凭证没落盘 → 必须说出来，否则用户重启就得再登一次 */
      message: saveErr || (r && r.message),
    }
  })
  ipcMain.handle('login:clear', async (_e, netdisk) => {
    const nd = String(netdisk || '')
    const ok = await login.clearLogin(nd)
    if (ok) {
      /* 只清浏览器分区是不够的：解析器用的是 settings.json 里那份 Cookie，
       * 不清掉的话「退出登录」之后照样能解析、能下载。 */
      const jar = { ...(settings.load().cookies || {}) }
      if (jar[nd]) {
        delete jar[nd]
        const w = settings.save({ cookies: jar })
        boot('login-clear', nd, w && w.ok === false ? 'save failed: ' + w.message : 'cleared')
      }
    }
    return ok
  })

  /**
   * 夸克 / UC 的 CDN 需要网页 JS 现场生成的短效令牌（`__puus`）：夸克不带它一律 412
   * Precondition Failed，带上（哪怕只带这一个 cookie）立刻 206。令牌会过期，
   * 所以**在建立解析会话之前**先刷新一次，让解析器闭包里捕获到新鲜的一份。
   */
  async function warmCredentials(text) {
    const cfg = settings.load()
    const jar = { ...(cfg.cookies || {}) }
    const need = []
    if (jar.quark && /pan\.quark\.cn|quark\.cn/i.test(text)) need.push('quark')
    if (jar.uc && /drive\.uc\.cn|uc\.cn/i.test(text)) need.push('uc')
    if (jar.xunlei && /pan\.xunlei\.com/i.test(text)) {
      /* 迅雷预热要开一次网页版窗口（~2-6s），只在凭证里缺 captcha 令牌时才值得做。
       * 平时 fetchCaptcha 会拿它当种子换新令牌，所以存一份就够用很久。 */
      let missing = true
      try {
        const j = JSON.parse(jar.xunlei)
        missing = !j.captcha_token
      } catch {
        missing = true
      }
      if (missing) need.push('xunlei')
    }
    if (!need.length) return
    let changed = false
    for (const nd of need) {
      try {
        const r = await login.refreshCookie(nd)
        /* ⚠️ 这里绝对**不能**因为「这次预热没拿到登录态」就删掉用户已存的凭证。
         *
         * 0.6.6 及以前是 `if (r.loggedIn === false) delete jar[nd]`：隐藏窗口预热
         * 一旦超时（网络慢、令牌是会话型 cookie 重启后没了），就会把用户刚登录好的
         * 夸克/UC 凭证从 settings.json 里抹掉 —— 表现就是「每次退出重进都要重新登录」。
         * 现在只有**明确拿到登录态**时才覆盖；拿不到就原样保留，让解析器拿旧凭证去试，
         * 真失效了会由解析器给出「凭证已失效，请重新登录」的明确提示。 */
        if (r && r.loggedIn === true && r.header) {
          if (r.header !== jar[nd]) {
            jar[nd] = r.header
            changed = true
            boot('warm', nd, 'refreshed=' + r.refreshed, 'loggedIn=true', 'len=' + r.header.length)
          }
          continue
        }
        boot('warm-keep', nd, jar[nd] ? '预热未拿到登录态，保留原凭证' : '没有登录态，不收匿名凭证')
      } catch (e) {
        boot('warm-fail', nd, e && e.message ? e.message : String(e))
      }
    }
    if (changed) {
      const w = settings.save({ cookies: jar })
      if (!w.ok) boot('warm-save', 'save failed: ' + w.message)
    }
  }

  /* 交给 ipc/index.js 转给解析域：解析前刷新短效令牌（原 registerIpc 里它就是闭包局部） */
  return { warmCredentials }
}

module.exports = { register }