'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

contextBridge.exposeInMainWorld('panbox', {
  parseShare: (p) => invoke('parse:share', p),
  /* 界面丢掉一条解析结果时通知主进程释放对应会话 */
  dropParseSession: (sessionId) => invoke('parse:drop', sessionId),

  listDownloads: () => invoke('downloads:list'),
  addDownloads: (p) => invoke('downloads:add', p),
  pauseTask: (gid) => invoke('downloads:pause', gid),
  resumeTask: (gid) => invoke('downloads:resume', gid),
  refreshTask: (gid) => invoke('downloads:refresh', gid),
  removeTask: (gid) => invoke('downloads:remove', gid),
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
  pickDir: () => invoke('dialog:pickDir'),
  openPath: (p) => invoke('shell:openPath', p),

  aria2Status: () => invoke('aria2:status'),
  restartAria2: () => invoke('aria2:restart'),

  openLogin: (netdisk) => invoke('login:open', netdisk),
  clearLogin: (netdisk) => invoke('login:clear', netdisk),

  bridgeStatus: () => invoke('bridge:status'),
  bridgeStart: () => invoke('bridge:start'),
  bridgeOpenFolder: () => invoke('bridge:openFolder'),
  bridgeNewToken: () => invoke('bridge:newToken'),
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

  /* 浏览器插件投递进来一个「网盘分享链接」时，主进程把它送到这里，
   * 由界面填进链接输入框，让用户自己勾选要下的文件 */
  onBridgePrefill: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('bridge:prefill', h)
    return () => ipcRenderer.removeListener('bridge:prefill', h)
  },
})
