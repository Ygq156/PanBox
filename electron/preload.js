'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/* ⚠️ 必须收**变参**再原样转发。以前写成 `(channel, payload) => ipcRenderer.invoke(channel, payload)`，
 * 于是 `removeTask(gid, mode)` 的 mode 被悄悄丢掉，主进程里「彻底删除 / 放进回收站」
 * 整段代码永远进不去 —— 队列行消失了，磁盘上的文件却还在（用户看到的就是「删了但没删」）。 */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('panbox', {
  parseShare: (p) => invoke('parse:share', p),
  /* 界面丢掉一条解析结果时通知主进程释放对应会话 */
  dropParseSession: (sessionId) => invoke('parse:drop', sessionId),

  listDownloads: () => invoke('downloads:list'),
  addDownloads: (p) => invoke('downloads:add', p),
  pauseTask: (gid) => invoke('downloads:pause', gid),
  resumeTask: (gid) => invoke('downloads:resume', gid),
  /* 插队：把这条任务顶到最前（队满时暂停一条正在下载的给它腾位置，稍后自动恢复） */
  jumpTask: (gid) => invoke('downloads:jumpTop', gid),
  refreshTask: (gid) => invoke('downloads:refresh', gid),
  /* 移除任务。第二个参数只管「已完成的任务」磁盘上那个文件：trash=进回收站，purge=彻底删，不给=留着 */
  removeTask: (gid, mode) => invoke('downloads:remove', gid, mode),
  /* 删掉已下完的文件：文件进回收站，任务同时从队列移除 */
  deleteTaskFile: (gid) => invoke('downloads:deleteFile', gid),
  pauseAll: () => invoke('downloads:pauseAll'),
  resumeAll: () => invoke('downloads:resumeAll'),

  /* 回收站 */
  trashList: () => invoke('trash:list'),
  trashRestore: (id) => invoke('trash:restore', id),
  trashDelete: (id) => invoke('trash:delete', id),
  trashEmpty: () => invoke('trash:empty'),
  trashOpenDir: () => invoke('trash:openDir'),

  getSettings: () => invoke('settings:get'),
  setSettings: (s) => invoke('settings:set', s),
  resetSettings: () => invoke('settings:reset'),
  pickDir: (kind) => invoke('dialog:pickDir', kind),
  openPath: (p) => invoke('shell:openPath', p),

  aria2Status: () => invoke('aria2:status'),
  restartAria2: () => invoke('aria2:restart'),

  openLogin: (netdisk) => invoke('login:open', netdisk),
  clearLogin: (netdisk) => invoke('login:clear', netdisk),

  bridgeStatus: () => invoke('bridge:status'),
  bridgeStart: () => invoke('bridge:start'),
  bridgeOpenFolder: () => invoke('bridge:openFolder'),
  bridgeNewToken: () => invoke('bridge:newToken'),
  bridgeNewPairCode: () => invoke('bridge:newPairCode'),
  proxyStatus: () => invoke('proxy:status'),

  /* 版本 / 开机自启动 / 检查更新（见 electron/main.js 的 app:* 与 update:* 通道） */
  appInfo: () => invoke('app:info'),
  setAutoStart: (on) => invoke('app:setAutoStart', on),
  checkUpdate: (opts) => invoke('update:check', opts),
  openRelease: (url) => invoke('update:open', url),
  /* 安装版就地更新（见 electron/main.js 的 update:* 通道） */
  updateState: () => invoke('update:state'),
  updateAppCheck: () => invoke('update:appCheck'),
  updateDownload: () => invoke('update:download'),
  updateInstall: () => invoke('update:install'),

  onDownloadsUpdate: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('downloads:update', h)
    return () => ipcRenderer.removeListener('downloads:update', h)
  },

  /* 启动后自动检查发现新版本（主进程只会发一次，失败不发） */
  onUpdateAvailable: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('update:available', h)
    return () => ipcRenderer.removeListener('update:available', h)
  },

  /* 自更新的进度/结果（下载中、已下载、出错） */
  onUpdateState: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('update:state', h)
    return () => ipcRenderer.removeListener('update:state', h)
  },

  /* 主进程在后台替用户做了什么（比如直链过期、自动换了一条），
   * 用一句话讲清就行，不需要用户点任何东西 */
  onDownloadsNotice: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('downloads:notice', h)
    return () => ipcRenderer.removeListener('downloads:notice', h)
  },

  /* 浏览器插件投递进来一个「网盘分享链接」时，主进程把它送到这里，
   * 由界面填进链接输入框，让用户自己勾选要下的文件 */
  onBridgePrefill: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('bridge:prefill', h)
    return () => ipcRenderer.removeListener('bridge:prefill', h)
  },
})
