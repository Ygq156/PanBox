'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell, session, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const https = require('node:https')

const settings = require('./core/settings')
const aria2 = require('./core/aria2')
const seg = require('./core/segmentDownloader')
const tasks = require('./core/taskManager')
const trash = require('./core/trash')
const parsers = require('./parsers')
const login = require('./core/login')
const bridge = require('./core/bridge')
const proxy = require('./core/proxy')
const { detectNetdisk } = require('./parsers/util')

/* 安装版可以就地更新：electron-updater 走 NSIS，安装器会静默跑旧卸载器
 * （`/S /KEEP_APP_DATA --updated`，见 app-builder-lib 的 installUtil.nsh），
 * 只换程序目录里的文件，`%APPDATA%\PanBox`（设置、任务、网盘登录分区）原样保留。
 * 便携版做不到自更新（解包到临时目录再运行），继续走「打开发布页」。 */
const { autoUpdater } = require('electron-updater')
const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE
/** 自更新只在「打包过的安装版」里启用 */
const canAutoUpdate = () => app.isPackaged && !isPortable

/* ------------------------------------------------------------------ */
/* 进程 / 内存精简（必须在 app ready 之前设置才生效）                     */
/* ------------------------------------------------------------------ */

/**
 * 界面就是一张深色列表：没有动画、没有半透明模糊、没有 canvas。
 * 软件光栅完全够用，而关掉硬件加速会**整整少一个 GPU 进程**
 * （实测空闲态 91–105 MB，占全部内存的四分之一）。
 */
app.disableHardwareAcceleration()
/* 软件合成没必要单开一个进程，并回主进程再省一个进程（实测 ~77 MB） */
app.commandLine.appendSwitch('in-process-gpu')

/* 用不到的 Chromium 子系统，关掉省内存也省启动时间。
 * 注意别把 CalculateNativeWinOcclusion 关掉——那个是窗口最小化后省 CPU 的。 */
app.commandLine.appendSwitch(
  'disable-features',
  'MediaSessionService,HardwareMediaKeyHandling,Translate,BackForwardCache,AudioServiceOutOfProcess',
)
/* 崩溃上报和域名预取对本地下载器没有意义 */
app.commandLine.appendSwitch('disable-breakpad')
app.commandLine.appendSwitch('disable-domain-reliability')
app.commandLine.appendSwitch('no-pings')

/** 下载产物文件名 -> 解析会话 id，交给下面的 recycleTransferCopy 消费 */
const downloadsCleanup = new Map()
/* 已经登记过的 key（以文件名为键）。同名任务（第二次下同一个文件、
 * 或者转存出两个同名文件）以前会把 Map 里那条记录**覆盖掉**，
 * 结果是先完成的那份转存副本永远回收不了 —— 用户网盘里白留一份。
 * 现在同名就走 name~2、name~3 这样的备用键。 */
const cleanupKeysBy = new Map()

/** 给某个文件名分配一个还没被占用的 key（正常情况下就是文件名本身） */
function _cleanupKeyFor(name) {
  const k = String(name)
  const used = cleanupKeysBy.get(k)
  if (!used || !used.size) return k
  let n = 2
  while (used.has(`${k}~${n}`)) n++
  return `${k}~${n}`
}

/** 登记「这个任务完成后要回收哪次转存」（下载创建时调用） */
function cleanupRemember(name, sessionId) {
  if (!sessionId) return ''
  const k = String(name)
  const key = _cleanupKeyFor(k)
  downloadsCleanup.set(key, String(sessionId))
  if (!cleanupKeysBy.has(k)) cleanupKeysBy.set(k, new Set())
  cleanupKeysBy.get(k).add(key)
  return key
}

/** 取出「这个文件名对应的转存会话」但**不删除**（换直链时要用它，任务还没结束） */
function cleanupPeek(name) {
  const k = String(name)
  const used = cleanupKeysBy.get(k)
  if (used) {
    /* 从后往前：同名的多条记录里，最后登记的那条才是「这个任务」的那条 */
    const keys = [...used]
    for (let i = keys.length - 1; i >= 0; i--) {
      const sid = downloadsCleanup.get(keys[i])
      if (sid) return sid
    }
  }
  return downloadsCleanup.get(k) || ''
}

/** 取出并注销（任务完成 / 用户删除任务时调用） */
function cleanupTake(name) {
  const k = String(name)
  const used = cleanupKeysBy.get(k)
  const keys = used && used.size ? [...used] : [k]
  /* 从后往前取第一条「真的存在」的记录：同名多条时，最后登记的才是这个任务的 */
  for (let i = keys.length - 1; i >= 0; i--) {
    if (!downloadsCleanup.has(keys[i])) continue
    const sid = downloadsCleanup.get(keys[i]) || ''
    downloadsCleanup.delete(keys[i])
    const set = cleanupKeysBy.get(k)
    if (set) {
      set.delete(keys[i])
      if (!set.size) cleanupKeysBy.delete(k)
    }
    return sid
  }
  return ''
}
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
const SEG_CONNECTIONS = { quark: 192, uc: 96, direct: 128 }

/**
 * 某个网盘该用自研分段引擎开多少连接（0 = 不用这个引擎，继续走 aria2）。
 * 用户可在设置里覆盖 `settings.segConnections`。约定：
 * 表里**没有**这个网盘 → 不走分段引擎；表里有且 **> 0** 才走。
 */
function segConnectionsFor(cfg, netdisk) {
  /* 必须「合并」而不是「覆盖」：老用户的 settings.json 是在 direct 这一项存在之前存的
   * （实测用户盘上是 {"quark":96,"uc":96}），整表覆盖会让 direct 掉成 0 →
   * 直链退回 aria2 的 split=16，这就是「NDM 是 32、我的软件是 16」的直接原因。 */
  const table = { ...SEG_CONNECTIONS, ...((cfg && cfg.segConnections) || {}) }
  const n = Number(table[netdisk] || 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 这几家的 aria2 并发要单独调（默认的 16 会招来 503/403） */
const ARIA2_SPLIT_OVERRIDE = { baidu: 1, xunlei: 8 }

/** shell:openPath 不允许打开的可执行/脚本类扩展名（Windows 上「打开」= 执行） */
const OPEN_PATH_BLOCKED_EXT = /^\.(exe|com|bat|cmd|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|lnk|url|reg|hta|cpl|dll|jar|sh)$/i

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
  const sid = cleanupTake(key)
  if (!sid) return false
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
/* 托盘。为什么要有：下载引擎是要长时间跑的（aria2 + 自研分段器），
 * 关窗口就退出会把没下完的任务全掐死；同时浏览器插件的本地通道也要一直在。
 * 默认「点 × 收进托盘」，真退出走托盘菜单里的「退出 PanBox」。可在设置里关掉。 */
let tray = null
/* 真正要退出了（托盘退出 / 系统关机 / app.quit()）。窗口的 close 处理靠它放行。 */
let isQuitting = false
/* 开机自启动拉起来的这次运行：直接待命在托盘里，别在用户刚开机时弹一个窗口出来。
 * 只有「点 × 收进托盘」开着时才这么干 —— 否则用户既没窗口也没托盘，等于没启动。 */
const STARTUP_HIDDEN = process.argv.includes('--startup')
let aria2Ready = false
let aria2Error = ''

/* 自更新状态机：idle → checking → available → downloading → downloaded / error / latest。
 * 界面按这个渲染「下载并安装」那一条。 */
let updState = { state: 'idle' }

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

/** Windows 保留设备名：这些名字（含带扩展名的形式）不能作为文件名 */
const WIN_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function sanitizeName(s) {
  let name =
    String(s || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^\.+/, '_')
      .trim()
      .slice(0, 180) || 'unnamed'
  /* Windows 上文件名不能以点或空格结尾（会被静默截断，导致落盘名和任务名对不上，
   * 后续「换直链/续传」按名字找不到文件） */
  name = name.replace(/[. ]+$/, '')
  if (!name) name = 'unnamed'
  /* 设备名：NUL / CON / COM1 … 会被 Windows 当成设备，写进去等于丢弃数据 */
  const base = name.replace(/\.[^.]*$/, '')
  if (WIN_DEVICE_NAMES.test(base)) name = `_${name}`
  return name
}

function buildHeaders(obj) {
  const out = []
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue
    /* 请求头是拼成字符串交给 aria2 / 自研分段的：里面有 CR/LF 就能凭空插一行
     * 新的请求头（cookie/referer 都来自页面与接口响应，是外部输入）。 */
    const key = String(k).replace(/[\r\n:]/g, '').trim()
    const val = String(v).replace(/[\r\n]/g, ' ').trim()
    if (!key) continue
    out.push(`${key}: ${val}`)
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

/**
 * 给渲染层上 CSP。以前没有任何 CSP：渲染层一旦出现注入点（比如某天有人给
 * 任务名加了 dangerouslySetInnerHTML），脚本就能直接 fetch 外网把账号 cookie 发出去 /
 * 用 img 打点。这里按「界面只需要自己的脚本、自己的样式、本地图片」来收紧。
 * 只对应用自己的窗口生效：登录窗口（core/login.js）要跑网盘页面，不在这里处理。
 */
function applyCsp() {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    /* React 的行内 style 属性（进度条宽度）需要 unsafe-inline */
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    /* 界面只通过 IPC 跟主进程说话，不需要任何网络出口 */
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...(details.responseHeaders || {}), 'Content-Security-Policy': [csp] } })
  })
}

function createWindow() {
  applyCsp()
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
      /* 界面里没有 <webview>，关掉可以少一类「渲染层加载任意页面」的入口 */
      webviewTag: false,
    },
  })
  win.once('ready-to-show', () => {
    const boot0 = settings.load()
    /* 开机自启动默认「收在托盘」：登录时自己把窗口弹出来很打扰。
     * 只有在设置里明确勾了「启动时显示主窗口」才显示，或用户关掉了「关闭到后台」。 */
    if (STARTUP_HIDDEN && boot0.closeToTray && !boot0.startupShowWindow) {
      boot('startup-hidden', '开机自启动，收在托盘里')
      ensureTray()
      return
    }
    win.show()
  })
  win.on('closed', () => {
    win = null
  })
  /* 点 × 不退出，收进托盘继续下载（设置里可以关掉这个行为）。
   * 注意判 isQuitting：托盘菜单的「退出」、系统关机都走 app.quit()，
   * 那时候必须真的关掉窗口，否则程序退不出去。
   * 这里刻意**不弹任何提示**：用户点 × 的本意就是「收起来别烦我」，
   * 托盘图标本身已经说明它还在跑（气泡还会被 Windows 记成一条通知）。 */
  win.on('close', (e) => {
    if (isQuitting) return
    if (!settings.load().closeToTray) return
    e.preventDefault()
    win.hide()
    ensureTray()
  })

  /* 导航管控：界面是单页应用，任何「整页跳转」都不是正常行为
   * （任务列表里的链接都是走主进程/系统浏览器）。外链一律拦下并交给系统浏览器，
   * 其余跳转直接拒绝，避免渲染层被导航到一个外部页面后继承 preload 的能力。 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = isDev ? process.env.PANBOX_DEV_URL : ''
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {})
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
    /* 不用分段引擎的那几家，aria2 的并发也要按网盘调（默认 16 会招来 503/403）。
     * 百度默认仍然是 1：它按「账号」维度限速，并发调大只会招致几小时~几天的惩罚性降速。
     * 但如果你本来就是超级会员（或开了客户端「下载提速」），账号本身有额度，
     * 那 1 条就变成人为上限了 —— 所以设置里有 cfg.baiduConnections 让你自己调上去。 */
    const split = isBaidu ? Math.max(1, Number(cfg.baiduConnections) || 1) : perEndpoint ? cfg.split : ARIA2_SPLIT_OVERRIDE[netdisk] || cfg.split
    const options = {
      dir: subdir,
      out: sanitizeName(f.name),
      continue: 'true',
      split: String(split),
      'max-connection-per-server': String(split),
      'min-split-size': cfg.minSplitSize,
      'user-agent': cfg.userAgent,
      /* 默认必须校验证书（false = 校验）。用户显式勾了「忽略证书错误」才关。 */
      'check-certificate': cfg.ignoreCert ? 'false' : 'true',
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
            insecure: !!cfg.ignoreCert,
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
       * 等这个任务 complete 时回收（见下面的 tasks.on('update')）。
       * 用 cleanupRemember 而不是直接 set：同名任务不会互相覆盖记录。 */
      cleanupRemember(f.name, sessionId)
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

/** 一个任务在磁盘上的真实文件路径（aria2 与分段引擎的 tellStatus 都带 files[0].path） */
async function taskFile(gid) {
  let st = null
  try {
    st = await aria2.tellStatus(gid)
  } catch {
    /* 可能不在 aria2 上（分段引擎的任务），也可能已经没了 */
  }
  if (!st) {
    try {
      st = seg.tellStatus(gid)
    } catch {
      /* 两边都没有 */
    }
  }
  if (!st) return null
  const f = (st.files && st.files[0]) || {}
  return { status: String(st.status || ''), path: f.path || '', dir: st.dir || '' }
}

/** 把任务从队列与引擎里彻底清掉（与 downloads:remove 同一套动作，删文件后复用） */
async function purgeTask(gid) {
  if (isSegTask(gid)) {
    await seg.remove(gid).catch(() => {})
  } else {
    await aria2.remove(gid).catch(() => {})
    for (let i = 0; i < 4; i++) {
      try {
        await aria2.removeDownloadResult(gid)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
  }
  tasks.forget(gid)
  await tasks._tick().catch(() => {})
}

function registerIpc() {
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
    const after = settings.save(patch || {})
    try {
      fs.mkdirSync(after.downloadDir, { recursive: true })
    } catch {
      /* ignore */
    }
    /* 代理是 aria2 的**命令行参数**，改不了运行时（changeGlobalOption 不支持 all-proxy），
     * 所以只要代理设置变了就得重启 aria2 子进程。 */
    await applyRuntimeSettings(before, after)
    /* 回给渲染层的一律是脱敏副本：settings:get 早就这么做了，这里漏掉的话
     * 「保存」之后界面手里就攥着一份凭证原文，等于白脱敏。 */
    return settings.forRenderer(after)
  })

  /* 开机自启动：设置改了立刻写登录项（打包版才真写，开发模式只记日志） */
  ipcMain.handle('app:setAutoStart', async (_e, on) => {
    const checked = settings.sanitizePatch({ autoStart: !!on })
    if (!checked.ok) throw new Error(checked.message)
    settings.save(checked.value)
    applyAutoStart(settings.load())
    return { ok: true, autoStart: !!settings.load().autoStart, applied: app.isPackaged }
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    autoStart: !!settings.load().autoStart,
    /* 开发模式没写注册表，界面要据此说明「安装版才生效」 */
    autoStartApplied: app.isPackaged,
    /* 便携版：登录项里记的是解包后的临时路径，换个位置/换台机器就失效，
     * 界面要据此给一句提醒（见设置页「开机自启动」那行） */
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
    platform: process.platform,
  }))

  /* 恢复默认设置：默认值这份知识只在主进程里（见 settings.resetDefaults）。
   * 登录凭证与用户自备的解析接口会被保留，其余回默认值。 */
  ipcMain.handle('settings:reset', async () => {
    const before = settings.load()
    const after = settings.resetDefaults()
    boot('settings-reset', 'restore defaults')
    await applyRuntimeSettings(before, after)
    return settings.forRenderer(after)
  })

  /* 便携版/开发模式：查 GitHub 的公开 release 接口，拿到发布页自己去下 */
  ipcMain.handle('update:check', async (_e, opts) => {
    const manual = !!(opts && opts.manual)
    const r = await checkUpdate(manual)
    if (r && r.ok) autoChecked = true
    boot('update-check', 'manual=' + manual, JSON.stringify({ ok: r.ok, current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, message: r.message }))
    return r
  })

  ipcMain.handle('update:open', async (_e, url) => {
    /* 只允许打开这个仓库下的地址 —— 不能让渲染层拿它当任意 URL 的跳板 */
    const u = String(url || '')
    if (!/^https:\/\/github\.com\/Ygq156\/PanBox(\/|$)/i.test(u)) return { ok: false, message: '只允许打开本项目的下载页' }
    await shell.openExternal(u).catch(() => {})
    return { ok: true }
  })

  /* ---- 自更新（只有安装版有）---- */
  ipcMain.handle('update:state', () => ({ ...updState, canUpdate: canAutoUpdate() }))

  /* 安装版查新版：走 electron-updater 的 feed（下载自己在 GitHub 上比版本），
   * 不再依赖匿名 GitHub 接口的 60 次/小时限流 */
  ipcMain.handle('update:appCheck', async () => {
    if (!canAutoUpdate()) return { ok: false, message: '这个版本只能手动下载新版' }
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (e) {
      const message = readableNetError(e)
      updTell({ state: 'error', message })
      return { ok: false, message }
    }
  })

  ipcMain.handle('update:download', async () => {
    if (!canAutoUpdate()) return { ok: false, message: '这个版本只能手动下载新版' }
    /* 已经下好过一次（缓存在本机）就别重复下，直接等用户点「重启并安装」 */
    if (updState.state === 'downloaded') return { ok: true }
    try {
      /* 还没查过就现查一次；查完仍没有新版就不必下 */
      if (updState.state !== 'available') {
        await autoUpdater.checkForUpdates()
        if (updState.state !== 'available') return { ok: false, message: '已是最新版本' }
      }
      autoUpdater.downloadUpdate().catch((e) => updTell({ state: 'error', message: readableNetError(e) }))
      return { ok: true }
    } catch (e) {
      const message = readableNetError(e)
      updTell({ state: 'error', message })
      return { ok: false, message }
    }
  })

  ipcMain.handle('update:install', async () => {
    if (!canAutoUpdate()) return { ok: false, message: '这个版本只能手动下载新版' }
    if (updState.state !== 'downloaded') return { ok: false, message: '还没下载完' }
    /* 先立 isQuitting：托盘那套「点 × 只收进托盘」的逻辑看到它才肯真的退出 */
    isQuitting = true
    /* 必须 quitAndInstall(true, true)：PanBox 是 assisted 安装器，
     * 静默（/S）跑完得靠 --force-run 才会把程序重新拉起来。 */
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 800)
    return { ok: true }
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
        /* ⚠️ 这里绝对**不能**因为「这次预热没拿到登录态」就删掉用户已存的凭证。
         *
         * 0.6.6 及以前是 `if (r.loggedIn === false) delete jar[nd]`：隐藏窗口预热
         * 一旦超时（网络慢、令牌是会话型 cookie 重启后没了），就会把用户刚登录好的
         * 夸克/UC 凭证从 settings.json 里抹掉 —— 表现就是「每次退出重进都要重新登录」。
         * 现在只有**明确拿到登录态**时才覆盖；拿不到就原样保留，让解析器拿旧凭证去试，
         * 真失效了会由解析器给出「凭证已失效，请重新登录」的明确提示。 */
        if (r && r.loggedIn === true && r.header) {
          if (r.header !== jar[nd]) {
            jar[nd] = r.header
            changed = true
            boot('warm', nd, 'refreshed=' + r.refreshed, 'loggedIn=true', 'len=' + r.header.length)
          }
          continue
        }
        boot('warm-keep', nd, jar[nd] ? '预热未拿到登录态，保留原凭证' : '没有登录态，不收匿名凭证')
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
  /* 渲染层丢掉一条解析结果时，顺手把主进程里那份会话缓存也丢掉（否则要等 30 分钟 TTL）。 */
  ipcMain.handle('parse:drop', (_e, sessionId) => {
    if (sessionId) parsers.dropSession(String(sessionId))
    return true
  })
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
      cleanupTake(o.name)
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
      if (newSession) cleanupRemember(o.name, newSession)
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
  /* ---- 回收站 ------------------------------------------------------ */
  /* 删「已完成的下载文件」：不抹盘，先把文件挪进回收站，再把任务从队列里移除。
   * 没下完的任务不给删（它还要靠分片文件续传）。 */
  ipcMain.handle('downloads:deleteFile', async (_e, gid) => {
    const meta = tasks.info(gid)
    const st = await taskFile(gid)
    if (!st || !st.path) return { ok: false, message: '找不到这个任务对应的文件' }
    if (st.status !== 'complete') return { ok: false, message: '只有已下载完成的任务才能删除文件' }
    let moved = null
    try {
      moved = await trash.add(st.path, { netdisk: (meta && meta.netdisk) || '', gid })
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) }
    }
    if (!moved) return { ok: false, message: '文件已经不在磁盘上了' }
    await purgeTask(gid)
    if (meta && meta.name) await recycleTransferCopy(meta.name, 'remove').catch(() => {})
    boot('delete-file', gid, `${moved.name} size=${moved.size}`)
    return { ok: true, name: moved.name, size: moved.size, id: moved.id }
  })

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
    await shell.openPath(dir).catch(() => {})
    return dir
  })

  ipcMain.handle('downloads:pauseAll', () =>
    Promise.all([aria2.pauseAll().catch(() => {}), seg.pauseAll().catch(() => {})]).then(() => true),
  )
  ipcMain.handle('downloads:resumeAll', () =>
    Promise.all([aria2.unpauseAll().catch(() => {}), seg.unpauseAll().catch(() => {})]).then(() => true),
  )
}

/* ------------------------------------------------------------------ */
/* 托盘 / 窗口显隐                                                      */
/* ------------------------------------------------------------------ */

/** 托盘图标：`build/` 不进安装包，所以打包版从 extraResources 里取。 */
function trayIconPath() {
  const packed = path.join(process.resourcesPath || '', 'tray.png')
  if (app.isPackaged && fs.existsSync(packed)) return packed
  const dev = path.join(__dirname, '..', 'resources', 'tray.png')
  if (fs.existsSync(dev)) return dev
  // 兜底：仓库里的应用图标（打包版里没有，只在开发目录有效）
  const fallback = path.join(__dirname, '..', 'build', 'icon.png')
  return fs.existsSync(fallback) ? fallback : ''
}

/** 把主窗口弄出来（没有就新建，有就恢复+聚焦）。托盘菜单、二次启动、activate 都用它。 */
function showMain() {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function quitApp() {
  isQuitting = true
  app.quit()
}

/* ------------------------------------------------------------------ */
/* 开机自启动 / 检查更新                                                */
/* ------------------------------------------------------------------ */

/**
 * 把配置里的值真正推到运行中的部件上：aria2 全局参数（代理只能靠重启子进程换）、
 * 插件通道监听、开机自启动登录项。
 * settings:set 与 settings:reset 都走这一条路 —— 两处各写一遍，日后必然改一处漏一处。
 */
async function applyRuntimeSettings(before, after) {
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
  applyAutoStart(after)
  /* 下载目录换了，回收站跟着搬到新目录下 */
  if (String(after.downloadDir) !== String(before.downloadDir)) {
    trash.configure({ downloadDir: after.downloadDir })
  }
}

/**
 * 把设置里的「开机自启动」写进 Windows 的登录项（macOS/Linux 上 Electron 也认这套 API）。
 *
 * - 打包版注册安装后的真实 exe；**portable 版**必须用 `PORTABLE_EXECUTABLE_FILE`
 *   （portable 运行时会被解包到 %TEMP%，注册那个临时路径重启就失效了）。
 * - 参数固定带 `--startup`：启动时看到它就直接收进托盘，不弹主窗口。
 * - 开发模式不写注册表（注册 electron.exe 没有任何意义），只记日志。
 */
function applyAutoStart(cfg) {
  const on = !!(cfg && cfg.autoStart)
  if (!app.isPackaged) {
    boot('autostart', 'dev-skip', 'want=' + on)
    return
  }
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  try {
    const args = ['--startup']
    const cur = app.getLoginItemSettings({ path: exe, args })
    if (!!cur.openAtLogin === on) {
      boot('autostart', 'unchanged', 'on=' + on)
      return
    }
    app.setLoginItemSettings({ openAtLogin: on, path: exe, args, name: 'PanBox' })
    boot('autostart', 'set', 'on=' + on, exe)
  } catch (e) {
    boot('autostart-err', (e && e.message) || String(e))
  }
}

const UPDATE_REPO = 'Ygq156/PanBox'
const RELEASE_PAGE = `https://github.com/${UPDATE_REPO}/releases`
/** 自动检查在本次运行里最多只做一次（手动点「检查更新」不受限制） */
let autoChecked = false

function verParts(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
}
function isNewer(a, b) {
  const A = verParts(a)
  const B = verParts(b)
  for (let i = 0; i < 3; i++) {
    if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0)
  }
  return false
}

/**
 * 查 GitHub Releases 的公开接口（匿名、不带任何本机信息，只发一个 UA）。
 * 这里只负责「有没有新版」；装不装、什么时候装都交给用户点。
 *
 * @param {boolean} manual 用户手点的（失败要把原因说出来；自动检查失败就静默）
 */
function checkUpdate(manual) {
  return new Promise((resolve) => {
    const current = app.getVersion()
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${UPDATE_REPO}/releases/latest`,
        method: 'GET',
        headers: { 'User-Agent': `PanBox/${current} (+https://github.com/${UPDATE_REPO})`, Accept: 'application/vnd.github+json' },
        timeout: manual ? 10000 : 6000,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          body += c
          if (body.length > 512 * 1024) req.destroy()
        })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, current, message: `GitHub 返回 HTTP ${res.statusCode}` })
            return
          }
          let j = null
          try {
            j = JSON.parse(body)
          } catch (e) {
            resolve({ ok: false, current, message: '返回内容不是合法 JSON' })
            return
          }
          const latest = String(j.tag_name || j.name || '').replace(/^v/i, '')
          resolve({
            ok: true,
            current,
            latest,
            hasUpdate: !!latest && isNewer(latest, current),
            url: j.html_url || RELEASE_PAGE,
            name: j.name || '',
            publishedAt: j.published_at || '',
          })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('请求超时'))
    })
    req.on('error', (e) => {
      resolve({ ok: false, current, message: (e && e.message) || String(e) })
    })
    req.end()
  })
}

/* ---- 自更新：状态推给界面，实际动作由用户点了才做 ---- */

function updTell(patch) {
  updState = { ...updState, ...patch }
  boot('updater', JSON.stringify(updState))
  if (win && !win.isDestroyed()) win.webContents.send('update:state', { ...updState, canUpdate: canAutoUpdate() })
}

/* 网络错误的原文又长又带内部路径，挑一句用户看得懂的 */
function readableNetError(e) {
  const raw = String((e && e.message) || e || '')
  boot('updater-error', raw.slice(0, 300))
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return '连不上更新服务器，检查网络或代理。'
  if (/ETIMEDOUT|timeout/i.test(raw)) return '连接更新服务器超时，稍后再试。'
  if (/404/.test(raw)) return '更新服务器上还没有可用的新版文件。'
  if (/sha512|checksum|integrity/i.test(raw)) return '下载的文件校验没过，请重试。'
  if (/net::ERR|ECONNRESET|socket hang up/i.test(raw)) return '下载中断，请重试。'
  return raw.replace(/^Error:\s*/, '').slice(0, 120) || '未知原因'
}

function initAutoUpdater() {
  if (!canAutoUpdate()) return
  /* 用户点「下载」才下；装完的重启也由 update:install 显式触发 */
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => updTell({ state: 'checking', message: '' }))
  autoUpdater.on('update-available', (i) => updTell({ state: 'available', version: (i && i.version) || '', message: '' }))
  autoUpdater.on('update-not-available', (i) => updTell({ state: 'latest', percent: 0, version: (i && i.version) || app.getVersion(), message: '' }))
  autoUpdater.on('download-progress', (p) =>
    updTell({
      state: 'downloading',
      percent: (p && p.percent) || 0,
      transferred: (p && p.transferred) || 0,
      total: (p && p.total) || 0,
      bytesPerSecond: (p && p.bytesPerSecond) || 0,
    }),
  )
  autoUpdater.on('update-downloaded', (i) => updTell({ state: 'downloaded', percent: 100, version: (i && i.version) || updState.version || '', message: '' }))
  autoUpdater.on('error', (e) => updTell({ state: 'error', message: readableNetError(e) }))
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray
  const p = trayIconPath()
  let img = nativeImage.createFromPath(p || undefined)
  if (img.isEmpty()) img = nativeImage.createEmpty()
  else img = img.resize({ width: 16, height: 16 })
  tray = new Tray(img)
  tray.setToolTip('PanBox 网盘快取')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主界面', click: () => showMain() },
      {
        label: '打开下载目录',
        click: () => {
          try {
            shell.openPath(settings.load().downloadDir)
          } catch {
            /* ignore */
          }
        },
      },
      { type: 'separator' },
      { label: '退出 PanBox', click: () => quitApp() },
    ]),
  )
  // 左键单击/双击都能把窗口叫回来
  tray.on('click', () => showMain())
  tray.on('double-click', () => showMain())
  return tray
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
    showMain()
  })

  app.whenReady().then(async () => {
    boot('whenReady, resourcesPath=' + process.resourcesPath, 'indexHtml=' + indexHtml(), 'exists=' + fs.existsSync(indexHtml()), 'aria2=' + aria2ExePath(), 'aria2Exists=' + fs.existsSync(aria2ExePath()))
    registerIpc()
    initAutoUpdater()
    /* 回收站索引跟着用户数据走，回收目录放在下载目录里（用户能在资源管理器里直接看到） */
    trash.configure({
      indexPath: path.join(app.getPath('userData'), 'trash.json'),
      downloadDir: settings.load().downloadDir,
    })
    createWindow()
    boot('window created')

    /* 开机自启动：每次启动都把登录项跟设置对齐一次（用户在别处删了登录项也能补回来） */
    applyAutoStart(settings.load())

    /* 启动后顺带查一次有没有新版本：延迟 4 秒，别跟启动抢网络；
     * 只在「自动检查更新」开着、而且这次运行还没查过时做一次，失败静默。 */
    setTimeout(async () => {
      if (autoChecked) return
      if (settings.load().autoCheckUpdate === false) return
      autoChecked = true
      /* 安装版：交给更新器自己比版本，结果通过 update:state 推到「设置 → 更新」；
       * 便携版没有就地更新，只能读 GitHub 接口后提示用户自己去下 */
      if (canAutoUpdate()) {
        autoUpdater.checkForUpdates().catch((e) => boot('updater-auto-err', String((e && e.message) || e)))
        return
      }
      const r = await checkUpdate(false)
      if (r && r.ok && r.hasUpdate && win && !win.isDestroyed()) {
        win.webContents.send('update:available', { latest: r.latest, current: r.current, url: r.url, name: r.name, publishedAt: r.publishedAt })
      }
    }, 4000)

    tasks.on('update', (list) => {
      if (win && !win.isDestroyed()) win.webContents.send('downloads:update', list)
    })

    /* 下载完成 → 回收转存副本，别让用户网盘里堆 `xxx(1).zip`；顺便按需打开下载目录。
     * 这个事件每个 gid 只发一次，所以不用像以前那样在每个 tick 里扫全表。
     * ⚠️ 必须用模块级的 `downloadsCleanup`：之前误写成了 `downloads:add` 处理函数里的
     * 局部别名 `cleanupOn`，那个作用域在监听器里根本不存在 → 每 tick 抛 ReferenceError
     * 被吞掉，回收从来没真正跑过。 */
    tasks.on('complete', (t) => {
      boot('complete', String(t.name))
      recycleTransferCopy(t.name, 'complete')
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
      showMain()
    })
  })

  /* 窗口全关了要不要退出，取决于「关闭到后台」这个设置：
   * 打开时留在托盘继续下载（下载引擎与插件通道都在主进程，跟窗口无关）；
   * 关掉时保持老行为，关窗口就退出。 */
  app.on('window-all-closed', () => {
    if (isQuitting) return
    if (!settings.load().closeToTray) app.quit()
  })

  /* 退出前把「已下载完成但还没轮到回收」的转存副本补收一次，
   * 免得用户关得快就留下一份垃圾。**只收已 complete 的**：
   * 没下完的任务还需要那份转存文件来续传，绝不能删。 */
  let cleanupDone = false
  app.on('before-quit', async (e) => {
    /* 先立旗：窗口的 close 处理看到它才会真的关窗，而不是收进托盘 */
    isQuitting = true
    if (!cleanupDone) {
      const sids = new Set()
      for (const t of tasks.list()) {
        if (!t || t.status !== 'complete') continue
        const sid = cleanupTake(String(t.name))
        if (sid) {
          sids.add(sid)
        }
      }
      if (sids.size) {
        e.preventDefault()
        cleanupDone = true
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
