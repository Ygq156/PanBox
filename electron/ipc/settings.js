'use strict'
/* 设置域：设置的读/写/恢复默认、开机自启动与应用信息，外加设置页用到的「选目录 / 打开路径」
 * 两个系统对话框。这些通道都是「改设置页」时会一起动的东西，单独成文件后只读这一百多行就够。
 * 依赖里只有 boot / applyRuntimeSettings / applyAutoStart / OPEN_PATH_BLOCKED_EXT 来自 main.js，
 * 窗口会重建所以 win 走 ctx.win() 现取。 */
const { app, dialog, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const settings = require('../core/settings')

/**
 * @param {object} ctx main.js 组装的主进程局部依赖（见 main.js 里 require('./ipc') 那处调用）
 */
function register(ctx) {
  /* 与原来 registerIpc 闭包里的同名局部一一对应；下面各 handler 的函数体逐字照搬。 */
  const { boot, applyRuntimeSettings, applyAutoStart, OPEN_PATH_BLOCKED_EXT } = ctx

  /* 渲染层拿到的是脱敏副本：cookies 逐键打码（回传时打码串 = 保持原值，见 settings.js）。
   * 这样即便渲染层被注入脚本，也读不到百度 BDUSS / 夸克 __puus / 迅雷 access_token 原文。 */
  ipcMain.handle('settings:get', () => settings.forRenderer(settings.load()))

  ipcMain.handle('settings:set', async (_e, partial) => {
    const before = settings.load()
    /* 白名单 + 类型/范围校验：渲染层只能改用户在设置页本来就能改的东西。
     * 想换配对令牌请走 bridge:newToken，这里不接受短令牌/空令牌。 */
    const checked = settings.sanitizePatch(partial || {})
    if (!checked.ok) throw new Error(checked.message)
    const patch = checked.value
    /* cookies 单独合并：打码串（用户没动那一格）保留旧值，空串清除，其它为新值 */
    if (patch.cookies) patch.cookies = settings.mergeCookies(patch.cookies, before.cookies)
    const saved = settings.save(patch || {})
    const after = saved.cfg
    try {
      fs.mkdirSync(after.downloadDir, { recursive: true })
    } catch {
      /* ignore */
    }
    /* 代理是 aria2 的**命令行参数**，改不了运行时（changeGlobalOption 不支持 all-proxy），
     * 所以只要代理设置变了就得重启 aria2 子进程。 */
    await applyRuntimeSettings(before, after)
    if (!saved.ok) {
      /* 内存里已经按新值跑了，但下次启动会回到旧值。要说出去，不能让用户以为存住了。 */
      throw new Error(saved.message || '设置没能写进磁盘')
    }
    /* 回给渲染层的一律是脱敏副本：settings:get 早就这么做了，这里漏掉的话
     * 「保存」之后界面手里就攥着一份凭证原文，等于白脱敏。 */
    return settings.forRenderer(after)
  })

  /* 开机自启动：设置改了立刻写登录项（打包版才真写，开发模式只记日志） */
  ipcMain.handle('app:setAutoStart', async (_e, on) => {
    const checked = settings.sanitizePatch({ autoStart: !!on })
    if (!checked.ok) throw new Error(checked.message)
    const saved = settings.save(checked.value)
    applyAutoStart(settings.load())
    return { ok: true, autoStart: !!settings.load().autoStart, message: saved.ok ? '' : saved.message }
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    autoStart: !!settings.load().autoStart,
    /* 便携版：登录项里记的是解包后的临时路径，换个位置/换台机器就失效，
     * 界面要据此给一句提醒（见设置页「开机自启动」那行） */
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
  }))

  /* 恢复默认设置：默认值这份知识只在主进程里（见 settings.resetDefaults）。
   * 登录凭证与用户自备的解析接口会被保留，其余回默认值。 */
  ipcMain.handle('settings:reset', async () => {
    const before = settings.load()
    const saved = settings.resetDefaults()
    const after = saved.cfg
    boot('settings-reset', 'restore defaults', saved.ok ? 'ok' : 'save failed')
    await applyRuntimeSettings(before, after)
    if (!saved.ok) throw new Error(saved.message || '设置没能写进磁盘')
    return settings.forRenderer(after)
  })

  ipcMain.handle('dialog:pickDir', async (_e, kind) => {
    const trash = kind === 'trash'
    const r = await dialog.showOpenDialog(ctx.win(), {
      title: trash ? '选择回收站目录' : '选择下载目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: trash ? settings.load().trashDir : settings.load().downloadDir,
    })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  /* 打开目录/文件。这个通道以前把渲染层给的任意字符串直接交给 shell.openPath ——
   * 在 Windows 上打开一个 .exe/.bat/.lnk 就是**执行程序**，等于给渲染层一个任意代码执行入口。
   * 现在只允许「下载目录之内」的路径，并挡掉可执行/脚本类扩展名。 */
  ipcMain.handle('shell:openPath', async (_e, p) => {
    const root = path.resolve(settings.load().downloadDir)
    const dir = p ? path.resolve(String(p)) : root
    const rel = path.relative(root, dir)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('只能打开下载目录里的内容')
    }
    if (OPEN_PATH_BLOCKED_EXT.test(path.extname(dir))) {
      throw new Error('出于安全考虑，不打开可执行文件')
    }
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    return shell.openPath(dir)
  })
}

module.exports = { register }