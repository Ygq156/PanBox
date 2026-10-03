'use strict'
/* IPC 注册总入口：按域调用各模块的 register(ctx)，把原来那一个 760 行的 registerIpc
 * 拆成一域一个文件。main.js 只负责组装 ctx（只有它才有的模块级依赖）并调用这里，
 * 所以 main.js 不再随下载/更新/设置这些域的增长而变长。 */
const settings = require('./settings')
const update = require('./update')
const bridge = require('./bridge')
const login = require('./login')
const parse = require('./parse')
const downloads = require('./downloads')
const trash = require('./trash')

/**
 * @param {object} ctx main.js 组装的主进程局部依赖（含 win() 取值函数与几个 getter）
 */
function registerIpc(ctx) {
  /* 注册先后与原 registerIpc 里的域顺序一致；各通道互不相干，ipcMain.handle 先后
   * 不构成行为差异（39 个通道没有重名）。 */
  settings.register(ctx)
  update.register(ctx)
  bridge.register(ctx)
  /* 登录域把内部的 warmCredentials 交出来：parse:share 在建立解析会话前要用它刷新
   * 夸克/UC/迅雷的短效令牌。这是各域之间唯一的依赖，在这里转交。 */
  const { warmCredentials } = login.register(ctx)
  parse.register({ warmCredentials })
  const { autoRefreshExpired } = downloads.register(ctx)
  trash.register(ctx)
  /* 「直链过期自动换链」跟着队列变化跑、不在任何通道里，得由 main.js 那条模块级的
   * tasks.on('update') 调用；它要用下载域的闭包，所以从这里交回给 main.js。 */
  return { autoRefreshExpired }
}

module.exports = registerIpc