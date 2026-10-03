'use strict'
/* 解析域：分享链接解析，以及渲染层丢掉一条解析结果时清掉主进程里的会话缓存。
 * 单独成文件是因为解析入口的入参与返回结构总是跟着解析器一起改，改这条线只需读这里。
 * warmCredentials 由登录域提供（ipc/index.js 转交），本域不需要 main.js 的其它局部。 */
const { ipcMain } = require('electron')

const parsers = require('../parsers')
const settings = require('../core/settings')

/**
 * @param {{ warmCredentials: (text: string) => Promise<void> }} ctx
 *   只带一个函数：解析前刷新夸克/UC/迅雷的短效令牌（原 registerIpc 里的闭包局部）
 */
function register(ctx) {
  const { warmCredentials } = ctx

  ipcMain.handle('parse:share', async (_e, payload) => {
    try {
      const text = (payload && payload.text) || ''
      await warmCredentials(text)
      return await parsers.parseShare({
        text,
        password: payload && payload.password,
        settings: settings.load(),
      })
    } catch (e) {
      return {
        results: [
          { ok: false, netdisk: 'unknown', files: [], message: e && e.message ? e.message : String(e) },
        ],
      }
    }
  })

  /* 渲染层丢掉一条解析结果时，顺手把主进程里那份会话缓存也丢掉（否则要等 30 分钟 TTL）。 */
  ipcMain.handle('parse:drop', (_e, sessionId) => {
    if (sessionId) parsers.dropSession(String(sessionId))
    return true
  })
}

module.exports = { register }