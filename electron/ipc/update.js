'use strict'
/* 更新域：便携版/开发模式「查 GitHub release」与安装版的 electron-updater 自更新
 * （查新版 / 下载 / 重启安装），外加更新状态广播。单独成文件是因为自更新这条线夹着
 * updState / autoChecked / isQuitting 三个会被整体重新赋值的模块级状态，集中在一处才好对照。 */
const { ipcMain, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const { checkUpdateSignature } = require('../core/updateSig')

/**
 * @param {object} ctx main.js 组装的主进程局部依赖（见 main.js 里 require('./ipc') 那处调用）
 */
function register(ctx) {
  /* 与原来 registerIpc 闭包里的同名局部一一对应；下面各 handler 的函数体逐字照搬。 */
  const { boot, checkUpdate, readableNetError, updTell, canAutoUpdate } = ctx
  /* ⚠️ updState / autoChecked / isQuitting 在 main.js 里会被整体重新赋值（updTell、
   * update 事件回调、before-quit），所以必须走 ctx 现取，不能在这里解构快照。 */

  /* 便携版/开发模式：查 GitHub 的公开 release 接口，拿到发布页自己去下 */
  ipcMain.handle('update:check', async (_e, opts) => {
    const manual = !!(opts && opts.manual)
    const r = await checkUpdate(manual)
    if (r && r.ok) ctx.autoChecked = true
    boot('update-check', 'manual=' + manual, JSON.stringify({ ok: r.ok, current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, message: r.message }))
    return r
  })

  ipcMain.handle('update:open', async (_e, url) => {
    /* 只允许打开这个仓库下的地址 —— 不能让渲染层拿它当任意 URL 的跳板 */
    const u = String(url || '')
    if (!/^https:\/\/github\.com\/Ygq156\/PanBox(\/|$)/i.test(u)) return { ok: false, message: '只允许打开本项目的下载页' }
    await shell.openExternal(u).catch(() => {})
    return { ok: true }
  })

  /* ---- 自更新（只有安装版有）---- */
  ipcMain.handle('update:state', () => ({ ...ctx.updState, canUpdate: canAutoUpdate() }))

  /* 自更新签名门禁：latest.yml 和安装包在同一条发布通道上，所以「下哪个包、sha512 是多少」
   * 全由这份元数据说了算 —— 它必须由内置公钥验过才准下载。1.0.21 及更老的 release 没有
   * .sig，那是老客户端的事；新客户端一律按「没有签名就不更新」办。 */
  /* 已经验过的版本号（同一版只远程验一次；验失败的不记，下次重来） */
  let signedVersion = ''

  /**
   * 回到 electron-updater 取元数据的**同一处**（按 app-update.yml 实际的 provider 定位：
   * generic 就是它的 url 目录，github 就是 releases/download/v<版本>/），取 latest.yml 与
   * latest.yml.sig 验签 —— 验的字节必须就是它随后要按 sha512 下载的那份元数据。
   * @param {object|null} info electron-updater 的 updateInfo（拿它的安装包地址/版本号定位元数据）
   * @returns {Promise<{ok:boolean, message?:string}>} ok=false 时 message 已经是给用户看的中文
   */
  async function passedSignatureCheck(info) {
    const u = info || {}
    const version = String(u.version || ctx.updState.version || '')
    if (version && version === signedVersion) return { ok: true }
    const r = await checkUpdateSignature({
      installerUrl: u.path || (u.files && u.files[0] && u.files[0].url) || '',
      tag: u.tag || '',
      version,
    })
    if (!r.ok) return { ok: false, message: r.message || readableNetError(r.err) }
    signedVersion = r.version || version
    boot('update-sig', 'verified ' + (r.version || version))
    return { ok: true }
  }

  /* 安装版查新版：走 electron-updater 的 feed（下载自己在 GitHub 上比版本），
   * 不再依赖匿名 GitHub 接口的 60 次/小时限流 */
  ipcMain.handle('update:appCheck', async () => {
    if (!canAutoUpdate()) return { ok: false, message: '这个版本只能手动下载新版' }
    try {
      const res = await autoUpdater.checkForUpdates()
      /* 查出来有新版的才需要验签（「已是最新」时没有东西可验） */
      if (ctx.updState.state === 'available') {
        const sig = await passedSignatureCheck(res && res.updateInfo)
        if (!sig.ok) {
          updTell({ state: 'error', message: sig.message })
          return { ok: false, message: sig.message }
        }
      }
      return { ok: true }
    } catch (e) {
      const message = readableNetError(e)
      updTell({ state: 'error', message })
      return { ok: false, message }
    }
  })

  ipcMain.handle('update:download', async () => {
    if (!canAutoUpdate()) return { ok: false, message: '这个版本只能手动下载新版' }
    /* 已经下好过一次（缓存在本机）就别重复下，直接等用户点「重启并安装」 */
    if (ctx.updState.state === 'downloaded') return { ok: true }
    try {
      let info = null
      /* 还没查过就现查一次；查完仍没有新版就不必下 */
      if (ctx.updState.state !== 'available') {
        const res = await autoUpdater.checkForUpdates()
        if (ctx.updState.state !== 'available') return { ok: false, message: '已是最新版本' }
        info = res && res.updateInfo
      }
      /* 允许下载之前必须验过签名：查版这一步刚验过的走缓存，否则按状态里的版本现验一次 */
      const sig = await passedSignatureCheck(info)
      if (!sig.ok) {
        updTell({ state: 'error', message: sig.message })
        return { ok: false, message: sig.message }
      }
      autoUpdater.downloadUpdate().catch((e) => updTell({ state: 'error', message: readableNetError(e) }))
      return { ok: true }
    } catch (e) {
      const message = readableNetError(e)
      updTell({ state: 'error', message })
      return { ok: false, message }
    }
  })
  /* update:install 只认 state === 'downloaded'，而这个状态只能由上面这段验过签名的
   * downloadUpdate() 走出来（initAutoUpdater 里 autoDownload 是 false），所以不用再验一遍。 */

  ipcMain.handle('update:install', async () => {
    if (!canAutoUpdate()) return { ok: false, message: '这个版本只能手动下载新版' }
    if (ctx.updState.state !== 'downloaded') return { ok: false, message: '还没下载完' }
    /* 先立 isQuitting：托盘那套「点 × 只收进托盘」的逻辑看到它才肯真的退出 */
    ctx.isQuitting = true
    /* 必须 quitAndInstall(true, true)：PanBox 是 assisted 安装器，
     * 静默（/S）跑完得靠 --force-run 才会把程序重新拉起来。 */
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 800)
    return { ok: true }
  })
}

module.exports = { register }