'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

contextBridge.exposeInMainWorld('panbox', {
  parseShare: (p) => invoke('parse:share', p),

  listDownloads: () => invoke('downloads:list'),
  addDownloads: (p) => invoke('downloads:add', p),
  pauseTask: (gid) => invoke('downloads:pause', gid),
  resumeTask: (gid) => invoke('downloads:resume', gid),
  refreshTask: (gid) => invoke('downloads:refresh', gid),
  removeTask: (gid) => invoke('downloads:remove', gid),
  pauseAll: () => invoke('downloads:pauseAll'),
  resumeAll: () => invoke('downloads:resumeAll'),

  getSettings: () => invoke('settings:get'),
  setSettings: (s) => invoke('settings:set', s),
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

  onDownloadsUpdate: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('downloads:update', h)
    return () => ipcRenderer.removeListener('downloads:update', h)
  },

  /* 浏览器插件投递进来一个「网盘分享链接」时，主进程把它送到这里，
   * 由界面填进链接输入框，让用户自己勾选要下的文件 */
  onBridgePrefill: (cb) => {
    const h = (_e, data) => cb(data)
    ipcRenderer.on('bridge:prefill', h)
    return () => ipcRenderer.removeListener('bridge:prefill', h)
  },
})
