'use strict'
/* 更新域：便携版/开发模式「查 GitHub release」与安装版的 electron-updater 自更新
 * （查新版 / 下载 / 重启安装），外加更新状态广播。单独成文件是因为自更新这条线夹着
 * updState / autoChecked / isQuitting 三个会被整体重新赋值的模块级状态，集中在一处才好对照。 */
const { ipcMain, shell } = require('electron')
const { autoUpdater } = require('electron-updater')

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

  /* 安装版查新版：走 electron-updater 的 feed（下载自己在 GitHub 上比版本），
   * 不再依赖匿名 GitHub 接口的 60 次/小时限流 */
  ipcMain.handle('update:appCheck', async () => {
    if (!canAutoUpdate()) return { ok: false, message: '这个版本只能手动下载新版' }
    try {
      await autoUpdater.checkForUpdates()
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
      /* 还没查过就现查一次；查完仍没有新版就不必下 */
      if (ctx.updState.state !== 'available') {
        await autoUpdater.checkForUpdates()
        if (ctx.updState.state !== 'available') return { ok: false, message: '已是最新版本' }
      }
      autoUpdater.downloadUpdate().catch((e) => updTell({ state: 'error', message: readableNetError(e) }))
      return { ok: true }
    } catch (e) {
      const message = readableNetError(e)
      updTell({ state: 'error', message })
      return { ok: false, message }
    }
  })

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