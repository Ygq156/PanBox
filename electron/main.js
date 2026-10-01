'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const settings = require('./core/settings')
const aria2 = require('./core/aria2')
const seg = require('./core/segmentDownloader')
const tasks = require('./core/taskManager')
const parsers = require('./parsers')
const login = require('./core/login')
const bridge = require('./core/bridge')
const proxy = require('./core/proxy')
const { detectNetdisk } = require('./parsers/util')

/** 下载产物文件名 -> 解析会话 id，交给下面的 recycleTransferCopy 消费 */
const downloadsCleanup = new Map()
/* 有些网盘的下载需要先把文件「转存」到用户自己的网盘，取完直链再删。 */
const { cleanupDownloaded } = parsers

/**
 * 哪些网盘该用自研分段下载器，以及开多少条连接。
 *
 * 起因（实测见 test/probe-quark-threads2.js、test/probe-thread-scaling.js）：
 * 夸克和 UC 的 CDN 是**按每条 TCP 连接**发额度的 ——
 *   夸克 ≈ 50 KB/s/连接：16 连接 0.82 MB/s → 64 连接 3.30 → 128 连接 6.90
 *   UC   ≈ 64 KB/s/连接：8 连接 0.77 MB/s → 128 连接 3.85（提速 5 倍）
 * 而 aria2 的 `--max-connection-per-server` **最大只能填 16**（填 60 直接报错），
 * 于是经过 aria2 永远被钉在 16 × 额度 ≈ 0.8 MB/s —— 这不是网盘只给 0.8，
 * 是 aria2 只肯开 16 条连接。
 *
 * 所以这两家改走 `core/segmentDownloader.js`（自己管连接，不受 16 限制）。
 * 其余网盘**没有**这个收益，继续走 aria2：
 *   百度 1 条和 8 条都是 0.08 MB/s（账号级总量限速），16 条起直接 403；
 *   迅雷 8 条最好，16 条以上回 503；
 *   直链/网盘直链在 16 条时已经接近服务端上限（npmmirror 16→3.99、64→4.86 MB/s）。
 */
const SEG_CONNECTIONS = { quark: 96, uc: 96 }

/**
 * 某个网盘该用自研分段引擎开多少连接（0 = 不用这个引擎，继续走 aria2）。
 * 用户可在设置里覆盖 `settings.segConnections`。约定：
 * 表里**没有**这个网盘 → 不走分段引擎；表里有且 **> 0** 才走。
 */
function segConnectionsFor(cfg, netdisk) {
  const table = (cfg && cfg.segConnections) || SEG_CONNECTIONS
  const n = Number(table[netdisk] || 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 这几家的 aria2 并发要单独调（默认的 16 会招来 503/403） */
const ARIA2_SPLIT_OVERRIDE = { baidu: 1, xunlei: 8 }

/**
 * 回收某次下载对应的转存副本（幂等：同一名字只回收一次）。
 *
 * 触发时机有三处，缺一不可：
 *   ① 下载完成（`tasks.on('update')` 里 status === 'complete'）
 *   ② 用户**撤销/删除**任务（`downloads:remove`）——否则中途取消会把副本永久留在用户网盘里
 *   ③ 程序退出前对已完成任务兜底（`before-quit`）
 *
 * @param {string} name 下载产物文件名
 * @param {string} tag  日志来源标记
 */
async function recycleTransferCopy(name, tag) {
  const key = String(name)
  const sid = downloadsCleanup.get(key)
  if (!sid) return false
  downloadsCleanup.delete(key)
  try {
    const ok = await cleanupDownloaded(sid)
    boot('recycle', key, `${tag} ok=${ok}`)
    return !!ok
  } catch (e) {
    boot('recycle-err', key, tag, String((e && e.message) || e))
    return false
  }
}

/**
 * 这个任务跑在哪个引擎上（'aria2' 还是 'seg'）。
 * 暂停/继续/移除都要按它路由 —— 两个引擎的 gid 互不认识，
 * 把 seg 的 gid 丢给 aria2 只会静默失败（界面上看就是「点了没反应」）。
 */
function isSegTask(gid) {
  const m = tasks.info(gid)
  if (m && m.engine) return m.engine === 'seg'
  if (seg.has(gid)) return true
  return String(gid).startsWith('seg-')
}

/* 启动诊断日志：打包版是 GUI 子系统程序，stdout 拿不到，只能写文件。 */const BOOT_LOG = process.env.PANBOX_BOOT_LOG || path.join(require('node:os').tmpdir(), 'panbox-boot.log')
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

/** 浏览器插件（未打包的扩展目录）在哪儿 —— 「设置 → 浏览器插件」上的按钮就打开它 */
function extensionDir() {
  const candidates = isDev
    ? [path.join(__dirname, '..', 'resources', 'extension')]
    : [path.join(process.resourcesPath, 'extension'), path.join(__dirname, '..', 'resources', 'extension')]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return candidates[0]
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
  /* 代理每次启动都重新算（设置可能刚改过，系统代理也可能刚换） */
  cfg.proxy = proxy.effective(cfg)
  boot('proxy', cfg.proxy ? 'using ' + cfg.proxy : '(direct)')
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

/**
 * 把一批已经拿到直链的文件真正排进下载队列。
 * 两个入口共用：渲染层的 `downloads:add`，和浏览器插件的 HTTP 通道（bridge）。
 */
async function addResolved(cfg, { session, netdisk, source, title, sessionId }) {
  const added = []
  const errors = []
  const shareTitle = sanitizeName(title || 'PanBox')
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
    /* 百度按「账号」维度限速：并发调大只会招致几小时~几天的惩罚性降速。
     * 但如果这条直链是用户自己的「解析接口」给的（别人的会员账号出的链），
     * 那限速档位就不是用户的账号了，再限成单线程等于白配——所以跳过这个限制。 */
    const perEndpoint = session.some((x) => x.viaEndpoint)
    const isBaidu = netdisk === 'baidu' && !perEndpoint
    /* 不用分段引擎的那几家，aria2 的并发也要按网盘调（默认 16 会招来 503/403） */
    const split = isBaidu ? 1 : perEndpoint ? cfg.split : ARIA2_SPLIT_OVERRIDE[netdisk] || cfg.split
    const options = {
      dir: subdir,
      out: sanitizeName(f.name),
      continue: 'true',
      split: String(split),
      'max-connection-per-server': String(split),
      'min-split-size': cfg.minSplitSize,
      'user-agent': cfg.userAgent,
      'check-certificate': 'false',
    }
    const header = buildHeaders(f.headers)
    if (header.length) options.header = header
    /* 代理只给「普通直链」用。为什么不给网盘 CDN：那些直链可能是按 IP 授权的，
     * 而解析请求走的是本机直连（undici 不读系统代理），换出口 IP 有被拒的风险。
     * 用户报的 GitHub 慢恰好就是 direct，所以这样已经解决问题。 */
    const useProxy = netdisk === 'direct' ? proxy.effective(cfg) : ''
    if (useProxy) options['all-proxy'] = useProxy
    const segConns = perEndpoint ? 0 : segConnectionsFor(cfg, netdisk)
    try {
      let gid = ''
      let engine = 'aria2'
      if (segConns && f.url) {
        try {
          gid = await seg.add({
            url: f.url,
            headers: f.headers || {},
            dir: subdir,
            out: sanitizeName(f.name),
            connections: segConns,
            netdisk,
            source,
            proxy: useProxy,
          })
          engine = 'seg'
        } catch (e) {
          /* 不支持 Range（老服务器）、或者探测失败 → 回退 aria2，别让任务加不进来 */
          boot('seg-fallback', netdisk, f.name, (e && e.message) || String(e))
          gid = ''
        }
      }
      if (!gid) {
        gid = await aria2.addUri([f.url], options)
        engine = 'aria2'
      }
      tasks.remember(gid, {
        name: f.name,
        netdisk,
        source,
        dir: subdir,
        engine,
        /* 重新解析直链所需的一切：网盘直链（夸克/UC/百度/迅雷）会过期，
         * 或者节点太慢时，可以「换直链」重新取一条。 */
        origin: {
          source,
          netdisk,
          title: shareTitle,
          name: f.name,
          dir: f.dir || '',
          engine,
          opts: { ...options },
        },
      })
      /* 夸克/UC 是「转存→取直链」，用户网盘里会多一份拷贝；登记下来，
       * 等这个任务 complete 时回收（见下面的 tasks.on('update')）。 */
      if (sessionId) downloadsCleanup.set(String(f.name), sessionId)
      added.push(gid)
    } catch (e) {
      errors.push(`${f.name}: ${e && e.message ? e.message : e}`)
    }
  }
  await tasks._tick().catch(() => {})
  return { added, errors }
}

/* ------------------------------------------------------------------ */
/* 浏览器插件接收通道                                                   */
/* ------------------------------------------------------------------ */

/**
 * 插件投递进来的一条下载。
 * - 普通 http(s) 文件地址：直接交给下载引擎（带上插件抓到的 Referer / Cookie / UA，
 *   很多站点的直链离开这几个请求头就会 403 —— 这正是浏览器自带下载器给不出来的东西）。
 * - 网盘分享链接：**不在这里擅自决定下哪些文件**，只把窗口叫到最前面并预填链接，
 *   让用户自己勾选。网盘要转存、要凭证，交给通道自动做既不透明也容易出事。
 */
async function bridgeAdd(p) {
  const url = String((p && p.url) || '')
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: '只接受 http(s) 地址' }

  const nd = detectNetdisk(url)
  if (nd && nd !== 'direct' && nd !== 'unknown') {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('bridge:prefill', { url, netdisk: nd })
    }
    return { ok: true, kind: 'share', name: '', message: '这是网盘分享链接，已在 PanBox 里打开，请勾选要下载的文件' }
  }

  const cfg = settings.load()
  const headers = { ...((p && p.headers) || {}) }
  if (p && p.referer && !headers.Referer) headers.Referer = p.referer
  if (p && p.userAgent) headers['User-Agent'] = p.userAgent
  if (p && p.cookie) headers.Cookie = p.cookie

  let name = sanitizeName((p && p.name) || '')
  if (!name) {
    try {
      const seg2 = new URL(url).pathname.split('/').filter(Boolean).pop() || ''
      name = sanitizeName(decodeURIComponent(seg2))
    } catch {
      name = ''
    }
  }
  if (!name) name = 'download.bin'

  const session = [{ id: '0', name, size: Number((p && p.size) || 0), isDir: false, dir: '', url, headers }]
  const r = await addResolved(cfg, {
    session,
    netdisk: 'direct',
    source: (p && p.referer) || '',
    title: (p && p.pageTitle) || name,
  })
  if (!r.added.length) return { ok: false, message: r.errors[0] || '加入下载队列失败' }
  return { ok: true, kind: 'direct', name, gid: r.added[0], message: `已加入下载队列：${name}` }
}

/** 拿（必要时生成）桥的配置。令牌只存在本机 settings.json 里。 */
function bridgeCfg() {
  const cfg = settings.load()
  if (!cfg.bridgeToken) cfg.bridgeToken = settings.save({ bridgeToken: bridge.ensureToken('') }).bridgeToken
  return cfg
}

async function startBridge() {
  const cfg = bridgeCfg()
  if (!cfg.bridgeEnabled) {
    await bridge.stop().catch(() => {})
    return bridge.status()
  }
  const st = await bridge.start({ port: cfg.bridgePort, token: cfg.bridgeToken }, bridgeAdd)
  boot('bridge', 'running=' + st.running, 'port=' + st.port, st.error || '')
  return st
}

function bridgeInfo() {
  const cfg = bridgeCfg()
  const dir = extensionDir()
  return {
    ...bridge.status(),
    enabled: !!cfg.bridgeEnabled,
    token: cfg.bridgeToken,
    extDir: dir,
    extExists: fs.existsSync(path.join(dir, 'manifest.json')),
  }
}

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
    /* 代理是 aria2 的**命令行参数**，改不了运行时（changeGlobalOption 不支持 all-proxy），
     * 所以只要代理设置变了就得重启 aria2 子进程。 */
    const proxyChanged =
      String(after.proxyMode) !== String(before.proxyMode) || String(after.proxy) !== String(before.proxy)
    if (String(after.aria2Port) !== String(before.aria2Port) || proxyChanged) {
      if (proxyChanged) proxy.clearCache()
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
    /* 插件通道的开关/端口/令牌变了就重开监听（端口占用等问题会反映在 bridge.status().error 里） */
    if (
      after.bridgeEnabled !== before.bridgeEnabled ||
      String(after.bridgePort) !== String(before.bridgePort) ||
      String(after.bridgeToken) !== String(before.bridgeToken)
    ) {
      await startBridge().catch(() => {})
    }
    return after
  })

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
    settings.save({ bridgeToken: bridge.ensureToken('') })
    await startBridge()
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
    if (jar.xunlei && /pan\.xunlei\.com/i.test(text)) {
      /* 迅雷预热要开一次网页版窗口（~2-6s），只在凭证里缺 captcha 令牌时才值得做。
       * 平时 fetchCaptcha 会拿它当种子换新令牌，所以存一份就够用很久。 */
      let missing = true
      try {
        const j = JSON.parse(jar.xunlei)
        missing = !j.captcha_token
      } catch {
        missing = true
      }
      if (missing) need.push('xunlei')
    }
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

    const r = await addResolved(cfg, {
      session,
      netdisk,
      source,
      title: (payload && payload.title) || 'PanBox',
      sessionId: payload && payload.sessionId ? String(payload.sessionId) : '',
    })
    return { ok: r.added.length > 0, added: r.added, errors: r.errors }
  })

  ipcMain.handle('downloads:list', () => tasks.list())
  ipcMain.handle('downloads:pause', (_e, gid) =>
    (isSegTask(gid) ? seg.pause(gid) : aria2.pause(gid)).then(() => true).catch(() => false),
  )
  ipcMain.handle('downloads:resume', (_e, gid) =>
    (isSegTask(gid) ? seg.unpause(gid) : aria2.unpause(gid)).then(() => true).catch(() => false),
  )

  /* 「换直链」：重新解析同一条分享、拿一条新的下载地址替换掉当前任务的地址。
   * 直链过期、或者某次分到的 CDN 节点太慢时用得上（也相当于迅雷客户端那套
   * 「重建任务重新调度节点」的合法等价物）。 */
  ipcMain.handle('downloads:refresh', async (_e, gid) => {
    const meta = tasks.info(gid)
    const o = meta && meta.origin
    if (!o || !o.source) {
      return { ok: false, message: '这个任务没有可重新解析的来源（只有经「解析 → 开始下载」加入的任务支持换直链）' }
    }
    const cfg = settings.load()
    let fresh = null
    let newSession = ''
    try {
      const { results } = await parsers.parseShare({ text: o.source, password: '', settings: cfg })
      const r = (results || []).find((x) => x.ok)
      if (!r) throw new Error((results && results[0] && results[0].message) || '重新解析失败')
      const plain = (s) => String(s || '').replace(/^.*[\\/]/, '')
      let idx = r.files.findIndex((f) => f.name === o.name && String(f.dir || '') === String(o.dir || ''))
      if (idx < 0) idx = r.files.findIndex((f) => plain(f.name) === plain(o.name))
      if (idx < 0) throw new Error(`重新解析后没有找到同名文件：${o.name}`)
      const got = await parsers.resolveFiles({ sessionId: r.sessionId, ids: [String(idx)] })
      if (!got.length) throw new Error('重新解析没有拿到新直链')
      fresh = got[0]
      newSession = r.sessionId
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) }
    }

    const header = buildHeaders(fresh.headers)
    const opts = { ...(o.opts || {}) }
    delete opts.gid
    if (header.length) opts.header = header

    let st = null
    try {
      st = await aria2.tellStatus(gid)
    } catch {
      /* 任务可能已经被删了，或者本来就在分段引擎上，照样走重新加入的路径 */
    }
    if (!st) {
      try {
        st = seg.tellStatus(gid)
      } catch {
        /* ignore */
      }
    }
    const live = st && (st.status === 'active' || st.status === 'paused' || st.status === 'waiting')
    try {
      /* ⚠️ 这里**故意不用** aria2 的 `changeUri` 热替换。
       * 实测（aria2 1.37，见 test/ui-refresh.js 的 B 分支）：对一个正在下载的任务调
       * `changeUri` 之后，aria2 进程会失联——紧接着所有 RPC 都报 `TypeError: fetch failed`，
       * 任务进度停在原地。所以统一改成「先移除、再用新地址重新加入」：
       * `.aria2` 控制文件还在，`--continue=true` 会让它从断点续传，不会白下。 */
      if (isSegTask(gid)) {
        await seg.remove(gid).catch(() => {})
      } else {
        await aria2.remove(gid).catch(() => {})
        /* 同样要把旧 gid 的结果从停止列表里清掉，否则旧任务会以「已停止」的形态赖在界面上 */
        await aria2.removeDownloadResult(gid).catch(() => {})
      }
      tasks.forget(gid)
      downloadsCleanup.delete(String(o.name))
      let ngid = ''
      let nengine = 'aria2'
      if (o.engine === 'seg') {
        try {
          ngid = await seg.add({
            url: fresh.url,
            headers: fresh.headers || {},
            dir: opts.dir,
            out: sanitizeName(o.name),
            connections: segConnectionsFor(settings.load(), o.netdisk) || 96,
            netdisk: o.netdisk,
            source: o.source,
            proxy: o.netdisk === 'direct' ? proxy.effective(settings.load()) : '',
          })
          nengine = 'seg'
        } catch (e) {
          boot('seg-fallback', 'refresh', o.name, (e && e.message) || String(e))
        }
      }
      if (!ngid) {
        ngid = await aria2.addUri([fresh.url], opts)
        nengine = 'aria2'
      }
      tasks.remember(ngid, {
        name: o.name,
        netdisk: o.netdisk,
        source: o.source,
        dir: opts.dir,
        engine: nengine,
        origin: { ...o, engine: nengine },
      })
      if (newSession) downloadsCleanup.set(String(o.name), newSession)
      await tasks._tick().catch(() => {})
      boot('refresh', o.name, `re-add ok gid=${ngid} engine=${nengine} was=${st ? st.status : 'gone'} live=${!!live}`)
      return { ok: true, gid: ngid, message: '已用新的下载地址重新加入队列（会从断点接着下）' }
    } catch (e) {
      boot('refresh-err', (e && e.stack) || String(e))
      return { ok: false, message: '换直链失败：' + ((e && e.message) || String(e)) }
    }
  })
  ipcMain.handle('downloads:remove', async (_e, gid) => {
    /* ⚠️ 必须**先**取名字再 forget：否则中途撤销任务时，那份转到用户网盘里的副本
     * 就再也没人认领，会永久留在 `/PanBox` 里。 */
    const meta = tasks.info(gid)
    const onSeg = isSegTask(gid)

    /* ① 还在下载/排队中的任务：先停掉（forceRemove 对已停止的任务会报错，所以吞掉） */
    let stopped = false
    let purged = false
    if (onSeg) {
      /* 分段引擎：remove 本身就会停掉在飞请求、关掉文件、清掉分片与断点 */
      stopped = await seg.remove(gid).catch(() => false)
      purged = stopped
    } else {
      try {
        await aria2.remove(gid)
        stopped = true
      } catch {
        /* 任务早就不在活动列表里了（已完成/已失败/已停止），正常情况 */
      }

      /* ② 关键一步：把结果从 aria2 的停止列表里清掉。
       * 不做这一步的话，taskManager 每 800ms 的 tellStopped 会把它原样读回来，
       * 界面上那个任务根本不会消失 —— 这就是「点了移除毫无反应」的根因。
       * 刚停掉的任务结果不一定立刻可清，所以重试几次。 */
      for (let i = 0; i < 4 && !purged; i++) {
        try {
          await aria2.removeDownloadResult(gid)
          purged = true
        } catch {
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    }

    tasks.forget(gid)
    if (meta && meta.name) await recycleTransferCopy(meta.name, 'remove').catch(() => {})
    /* 立刻推一次，别让用户等下一个 800ms 轮询 */
    await tasks._tick().catch(() => {})
    boot('remove', gid, `stopped=${stopped} purged=${purged} name=${(meta && meta.name) || ''}`)

    /* 只要 aria2 的结果清掉了就算成功；停不掉也没关系（本来就已停止） */
    return purged || stopped
  })
  ipcMain.handle('downloads:pauseAll', () =>
    Promise.all([aria2.pauseAll().catch(() => {}), seg.pauseAll().catch(() => {})]).then(() => true),
  )
  ipcMain.handle('downloads:resumeAll', () =>
    Promise.all([aria2.unpauseAll().catch(() => {}), seg.unpauseAll().catch(() => {})]).then(() => true),
  )
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
        recycleTransferCopy(t.name, 'complete')
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

    await startBridge().catch((e) => boot('bridge-err', String((e && e.message) || e)))

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
    /* 分段引擎要把断点信息落盘、关掉文件句柄，下次启动才能接着下 */
    await seg.flush().catch(() => {})
    await bridge.stop().catch(() => {})
    await aria2.stop()
  })
}
