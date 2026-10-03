'use strict'
/* 桥接域：浏览器扩展用的本地桥（状态/启动/打开扩展目录/换配对令牌）与 aria2 子进程
 * （状态/重启），外加设置页要看的系统代理状态。单独成文件是因为这三块都绕不开
 * 「子进程 + 端口 + 令牌」这些进程外资源，排障时基本只会看这一个文件。 */
const { ipcMain, shell } = require('electron')

const settings = require('../core/settings')
const proxy = require('../core/proxy')
const bridge = require('../core/bridge')
const aria2 = require('../core/aria2')

/**
 * @param {object} ctx main.js 组装的主进程局部依赖（见 main.js 里 require('./ipc') 那处调用）
 */
function register(ctx) {
  /* 与原来 registerIpc 闭包里的同名局部一一对应；下面各 handler 的函数体逐字照搬。
   * aria2Ready / aria2Error 被 startAria2 赋值，必须走 ctx 现取，不能解构。 */
  const { boot, bridgeInfo, startBridge, extensionDir, startAria2 } = ctx

  ipcMain.handle('bridge:status', () => bridgeInfo())

  ipcMain.handle('bridge:start', async () => {
    await startBridge()
    return bridgeInfo()
  })

  ipcMain.handle('bridge:openFolder', async () => {
    const dir = extensionDir()
    const err = await shell.openPath(dir)
    return { ok: !err, dir, message: err || '' }
  })

  ipcMain.handle('bridge:newToken', async () => {
    const saved = settings.save({ bridgeToken: bridge.ensureToken('') })
    await startBridge()
    if (!saved.ok) boot('bridge-token', 'save failed: ' + saved.message)
    return bridgeInfo()
  })

  /* 设置页要显示「系统代理是多少、当前实际用哪个」。每次现读一遍注册表（fresh=true），
   * 因为用户可能刚在 Clash 里改了端口。 */
  ipcMain.handle('proxy:status', async () => {
    const cfg = settings.load()
    return {
      mode: cfg.proxyMode || 'auto',
      system: proxy.systemProxy({ fresh: true }),
      custom: cfg.proxy || '',
      effective: proxy.effective(cfg),
    }
  })

  ipcMain.handle('aria2:status', async () => {
    if (!ctx.aria2Ready) return { running: false, error: ctx.aria2Error }
    try {
      const v = await aria2.rpc('aria2.getVersion', [], 4000)
      return { running: true, version: v.version }
    } catch (e) {
      return { running: false, error: e && e.message ? e.message : String(e) }
    }
  })

  ipcMain.handle('aria2:restart', () => startAria2())
}

module.exports = { register }