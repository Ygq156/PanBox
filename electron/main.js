'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const settings = require('./core/settings')
const aria2 = require('./core/aria2')
const tasks = require('./core/taskManager')
const parsers = require('./parsers')
const login = require('./core/login')

/** 下载文件名 -> 解析会话 id：任务 complete 时用来回收「转存副本」 */
const downloadsCleanup = new Map()

/* 启动诊断日志：打包版是 GUI 子系统程序，stdout 拿不到，只能写文件。 */
const BOOT_LOG = process.env.PANBOX_BOOT_LOG || path.join(require('node:os').tmpdir(), 'panbox-boot.log')
function boot(...a) {
  try {
    fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`)
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (e) => boot('UNCAUGHT', e && e.stack ? e.stack : String(e)))
process.on('unhandledRejection', (e) => boot('UNHANDLED', e && e.stack ? e.stack : String(e)))
boot('=== boot ===', 'pid=' + process.pid, 'isPackaged=' + app.isPackaged, 'exe=' + process.execPath)

const isDev = !app.isPackaged
let win = null
let aria2Ready = false
let aria2Error = ''

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

function aria2ExePath() {
  const rel = path.join('aria2', 'aria2c.exe')
  const candidates = isDev
    ? [path.join(__dirname, '..', 'resources', rel)]
    : [path.join(process.resourcesPath, rel), path.join(__dirname, '..', 'resources', rel)]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return candidates[0]
}

function indexHtml() {
  return path.join(__dirname, '..', 'dist', 'index.html')
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function sanitizeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 180) || 'unnamed'
}

function buildHeaders(obj) {
  const out = []
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue
    out.push(`${k}: ${v}`)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* aria2 生命周期                                                      */
/* ------------------------------------------------------------------ */

async function startAria2() {
  const cfg = settings.load()
  aria2.setOptions({ exePath: aria2ExePath(), port: cfg.aria2Port })
  try {
    const v = await aria2.start(cfg)
    aria2Ready = true
    aria2Error = ''
    tasks.start()
    return { running: true, version: v && v.version }
  } catch (e) {
    aria2Ready = false
    aria2Error = e && e.message ? e.message : String(e)
    return { running: false, error: aria2Error }
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: '#0f1115',
    title: 'PanBox 网盘快取',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    win = null
  })

  const devUrl = process.env.PANBOX_DEV_URL
  if (isDev && devUrl) win.loadURL(devUrl)
  else win.loadFile(indexHtml())
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('settings:get', () => settings.load())

  ipcMain.handle('settings:set', async (_e, partial) => {
    const before = settings.load()
    const after = settings.save(partial || {})
    try {
      fs.mkdirSync(after.downloadDir, { recursive: true })
    } catch {
      /* ignore */
    }
    if (String(after.aria2Port) !== String(before.aria2Port)) {
      await startAria2()
    } else {
      await aria2
        .changeGlobalOption({
          'max-concurrent-downloads': String(after.maxConcurrent),
          split: String(after.split),
          'max-connection-per-server': String(after.maxConnectionPerServer),
          'min-split-size': after.minSplitSize,
          dir: after.downloadDir,
          'user-agent': after.userAgent,
        })
        .catch(() => {})
    }
    return after
  })

  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.load().downloadDir,
    })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  ipcMain.handle('shell:openPath', async (_e, p) => {
    const dir = p || settings.load().downloadDir
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    return shell.openPath(dir)
  })

  ipcMain.handle('aria2:status', async () => {
    if (!aria2Ready) return { running: false, error: aria2Error }
    try {
      const v = await aria2.rpc('aria2.getVersion', [], 4000)
      return { running: true, version: v.version }
    } catch (e) {
      return { running: false, error: e && e.message ? e.message : String(e) }
    }
  })

  ipcMain.handle('aria2:restart', () => startAria2())

  ipcMain.handle('login:open', async (_e, netdisk) => login.openLogin(netdisk, win))
  ipcMain.handle('login:clear', async (_e, netdisk) => login.clearLogin(netdisk))
  ipcMain.handle('login:refresh', async (_e, netdisk) => {
    const r = await login.refreshCookie(netdisk, { force: true }).catch(() => null)
    if (r && r.header) settings.save({ cookies: { ...settings.load().cookies, [netdisk]: r.header } })
    return r ? { ok: true, count: r.list.length, loggedIn: r.loggedIn } : { ok: false }
  })

  /**
   * 夸克 / UC 的 CDN 需要网页 JS 现场生成的短效令牌（`__puus`）：夸克不带它一律 412
   * Precondition Failed，带上（哪怕只带这一个 cookie）立刻 206。令牌会过期，
   * 所以**在建立解析会话之前**先刷新一次，让解析器闭包里捕获到新鲜的一份。
   */
  async function warmCredentials(text) {
    const cfg = settings.load()
    const jar = { ...(cfg.cookies || {}) }
    const need = []
    if (jar.quark && /pan\.quark\.cn|quark\.cn/i.test(text)) need.push('quark')
    if (jar.uc && /drive\.uc\.cn|uc\.cn/i.test(text)) need.push('uc')
    if (!need.length) return
    let changed = false
    for (const nd of need) {
      try {
        const r = await login.refreshCookie(nd)
        /* 分区里没有登录态时收回来的只是匿名 cookie（UC 匿名访问也会种
         * `UDRIVE_TRANSFER_SESS` 之类），留着它只会让 UI 误以为「已经登录」，
         * 所以直接丢掉，让 needCookie 提示正常浮出来。 */
        if (r && r.loggedIn === false) {
          if (jar[nd]) {
            delete jar[nd]
            changed = true
            boot('warm-drop', nd, '匿名凭证已丢弃')
          }
          continue
        }
        if (r && r.header && r.header !== jar[nd]) {
          jar[nd] = r.header
          changed = true
          boot('warm', nd, 'refreshed=' + r.refreshed, 'loggedIn=' + r.loggedIn, 'len=' + r.header.length)
        }
      } catch (e) {
        boot('warm-fail', nd, e && e.message ? e.message : String(e))
      }
    }
    if (changed) settings.save({ cookies: jar })
  }

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

  ipcMain.handle('downloads:add', async (_e, payload) => {
    const cfg = settings.load()
    const added = []
    const errors = []
    const netdisk = (payload && payload.netdisk) || 'unknown'
    const source = (payload && payload.source) || ''
    let session = null
    try {
      if (payload && payload.sessionId && Array.isArray(payload.ids)) {
        session = await parsers.resolveFiles({ sessionId: payload.sessionId, ids: payload.ids })
      } else if (payload && Array.isArray(payload.files)) {
        session = payload.files
      }
    } catch (e) {
      return { ok: false, added: [], errors: [e && e.message ? e.message : String(e)] }
    }
    if (!session || !session.length) {
      return { ok: false, added: [], errors: ['没有可下载的文件'] }
    }

    const shareTitle = sanitizeName((payload && payload.title) || 'PanBox')
    /* 只有一个文件、且它没有目录归属时，直接落在下载根目录。
     * 否则会出现「下载目录/文件名/文件名」这种多此一举的嵌套——
     * 蓝奏优享这类「分享标题就等于文件名」的网盘必然踩到。 */
    const nest = session.length > 1 || session.some((f) => f.dir)

    for (const f of session) {
      const subdir = nest
        ? path.join(cfg.downloadDir, shareTitle, ...(f.dir ? String(f.dir).split(/[\\/]/).filter(Boolean).map(sanitizeName) : []))
        : cfg.downloadDir
      try {
        fs.mkdirSync(subdir, { recursive: true })
      } catch {
        /* ignore */
      }
      const isBaidu = netdisk === 'baidu'
      const options = {
        dir: subdir,
        out: sanitizeName(f.name),
        continue: 'true',
        // 百度按「账号」维度限速：并发调大只会招致几小时~几天的惩罚性降速
        split: String(isBaidu ? 1 : cfg.split),
        'max-connection-per-server': String(isBaidu ? 1 : cfg.maxConnectionPerServer),
        'min-split-size': cfg.minSplitSize,
        'user-agent': cfg.userAgent,
        'check-certificate': 'false',
      }
      const header = buildHeaders(f.headers)
      if (header.length) options.header = header
      try {
        const gid = await aria2.addUri([f.url], options)
        tasks.remember(gid, { name: f.name, netdisk, source, dir: subdir })
        /* 夸克/UC 是「转存→取直链」，用户网盘里会多一份拷贝；登记下来，
         * 等这个任务 complete 时回收（见下面的 tasks.on('update')）。 */
        if (payload && payload.sessionId) downloadsCleanup.set(String(f.name), payload.sessionId)
        added.push(gid)
      } catch (e) {
        errors.push(`${f.name}: ${e && e.message ? e.message : e}`)
      }
    }
    await tasks._tick().catch(() => {})
    return { ok: added.length > 0, added, errors }
  })

  ipcMain.handle('downloads:list', () => tasks.list())
  ipcMain.handle('downloads:pause', (_e, gid) => aria2.pause(gid).then(() => true).catch(() => false))
  ipcMain.handle('downloads:resume', (_e, gid) => aria2.unpause(gid).then(() => true).catch(() => false))
  ipcMain.handle('downloads:remove', async (_e, gid) => {
    const r = await aria2.remove(gid).then(() => true).catch(() => false)
    tasks.forget(gid)
    return r
  })
  ipcMain.handle('downloads:pauseAll', () => aria2.pauseAll().then(() => true).catch(() => false))
  ipcMain.handle('downloads:resumeAll', () => aria2.unpauseAll().then(() => true).catch(() => false))
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock()
boot('lock=' + gotLock)
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    boot('whenReady, resourcesPath=' + process.resourcesPath, 'indexHtml=' + indexHtml(), 'exists=' + fs.existsSync(indexHtml()), 'aria2=' + aria2ExePath(), 'aria2Exists=' + fs.existsSync(aria2ExePath()))
    registerIpc()
    createWindow()
    boot('window created')

    tasks.on('update', (list) => {
      if (win && !win.isDestroyed()) win.webContents.send('downloads:update', list)
      /* 下载完成 → 回收转存副本，别让用户网盘里堆 `xxx(1).zip`。
       * ⚠️ 这里必须用模块级的 `downloadsCleanup`：
       * 之前误写成了 `downloads:add` 处理函数里的局部别名 `cleanupOn`，
       * 那个作用域在监听器里根本不存在 → 每 tick 抛 ReferenceError 被吞掉，
       * 回收从来没真正跑过。 */
      for (const t of list) {
        if (!t || t.status !== 'complete') continue
        const sid = downloadsCleanup.get(String(t.name))
        if (!sid) continue
        downloadsCleanup.delete(String(t.name))
        parsers
          .cleanupDownloaded(sid)
          .then((ok) => boot('recycle', t.name, 'ok=' + ok))
          .catch((e) => boot('recycle-err', t.name, String((e && e.message) || e)))
      }
    })

    /* 首次完成：可选自动打开下载目录 */
    tasks.on('complete', (t) => {
      boot('complete', String(t.name))
      if (settings.load().openFolderWhenDone && win && !win.isDestroyed()) {
        shell.openPath(t.dir || settings.load().downloadDir).catch(() => {})
      }
    })

    const cfg = settings.load()
    try {
      fs.mkdirSync(cfg.downloadDir, { recursive: true })
    } catch {
      /* ignore */
    }
    await startAria2()
    boot('aria2 ready=' + aria2Ready + ' err=' + aria2Error)
    if (win && !win.isDestroyed()) win.webContents.send('aria2:update', { running: aria2Ready, error: aria2Error })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  /* 退出前把「已下载完成但还没轮到回收」的转存副本补收一次，
   * 免得用户关得快就留下一份垃圾。**只收已 complete 的**：
   * 没下完的任务还需要那份转存文件来续传，绝不能删。 */
  let quitting = false
  app.on('before-quit', async (e) => {
    if (!quitting) {
      const sids = new Set()
      for (const t of tasks.list()) {
        if (!t || t.status !== 'complete') continue
        const sid = downloadsCleanup.get(String(t.name))
        if (sid) {
          sids.add(sid)
          downloadsCleanup.delete(String(t.name))
        }
      }
      if (sids.size) {
        e.preventDefault()
        quitting = true
        const rs = await Promise.all([...sids].map((sid) => parsers.cleanupDownloaded(sid).catch(() => false)))
        boot('recycle-quit', [...sids].join(','), 'ok=' + rs.filter(Boolean).length)
        app.quit()
        return
      }
    }
    tasks.stop()
    await aria2.stop()
  })
}
