'use strict'
/* 回收站域：列出 / 还原 / 彻底删除 / 清空回收站，以及打开回收站目录。
 * 单独成文件是因为这条线只跟 core/trash 打交道，改回收站行为不必翻队列那几百行。 */
const { ipcMain, shell } = require('electron')
const fs = require('node:fs')

const trash = require('../core/trash')

/**
 * @param {object} ctx main.js 组装的主进程局部依赖（见 main.js 里 require('./ipc') 那处调用）
 */
function register(ctx) {
  /* 与原来 registerIpc 闭包里的同名局部一一对应；下面各 handler 的函数体逐字照搬。 */
  const { boot } = ctx

  ipcMain.handle('trash:list', () => trash.list())

  ipcMain.handle('trash:restore', async (_e, id) => {
    const r = await trash.restore(id)
    boot('trash-restore', String(id), JSON.stringify({ ok: r.ok, name: r.name }))
    return r
  })

  ipcMain.handle('trash:delete', (_e, id) => trash.drop(id))
  ipcMain.handle('trash:empty', () => trash.empty())
  ipcMain.handle('trash:openDir', async () => {
    const dir = trash._trashDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    /* openPath 不抛异常，它**返回**错误串（打不开就回一句人看得懂的原因） */
    const err = await shell.openPath(dir).catch((e) => (e && e.message) || String(e))
    if (err) boot('trash-openDir', dir, err)
    return { dir, ok: !err, message: err || '' }
  })
}

module.exports = { register }