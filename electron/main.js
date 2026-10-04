'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell, session, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const https = require('node:https')

const settings = require('./core/settings')
const aria2 = require('./core/aria2')
const seg = require('./core/segmentDownloader')
const hls = require('./core/hls')
const tasks = require('./core/taskManager')
const trash = require('./core/trash')
/* 用户取消过的下载身份：投递（尤其是分段探测失败后回退 aria2）落地前要核对，
 * 否则会出现「删掉的任务过一会儿自己又开始下」（见 core/cancelGuard.js） */
const cancelGuard = require('./core/cancelGuard')
const { looksLikeHtml } = require('./core/htmlFile')
const parsers = require('./parsers')
const login = require('./core/login')
const bridge = require('./core/bridge')
const proxy = require('./core/proxy')
const {
  detectNetdisk,
  setOutboundProxy,
  req,
  withExt,
  hasKnownExt,
  contentTypeExt,
  urlBaseName,
  sanitizeFileName,
} = require('./parsers/util')
const { probeUrl, PROBE_TIMEOUT } = require('./parsers/probe')
const browserCtx = require('./parsers/browserCtx')
const identity = require('./parsers/identity')

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
 * 起因（本机实测）：
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
 * 这条任务跑在哪个**本地引擎**上（分段 / HLS）。
 * 不是本地引擎就返回 null —— 交给 aria2。
 *
 * 为什么要按 gid 路由：三套引擎的 gid 互不认识，
 * 把本地引擎的 gid 丢给 aria2 只会静默失败（界面上看就是「点了没反应」）。
 */
function localEngine(gid) {
  const g = String(gid)
  const m = tasks.info(g)
  if (m && m.engine === 'hls') return hls
  if (m && m.engine === 'seg') return seg
  if (seg.has(g)) return seg
  if (hls.has(g)) return hls
  if (g.startsWith('hls-')) return hls
  if (g.startsWith('seg-')) return seg
  return null
}

/* ------------------------------------------------------------------ */
/* 插队（把一条排队中的任务顶到最前面）                                 */
/* ------------------------------------------------------------------ */

/**
 * 插队记录：gid -> { at, items: [{ gid, engine }] }。
 * aria2 和分段引擎都没有「抢占」接口：队列满时想让插队任务立刻开跑，
 * 只能暂停一条正在下载的任务把名额腾出来（这是 aria2 前端通用的做法）。
 * 让位的任务记在这里，等插队任务跑完（不再是 active/waiting）时自动恢复，
 * 省得用户再去手动点一次「继续」。
 */
const preempted = new Map()

/** 挑一个让位对象：正在下载、进度比例最低的那条（快下完的不要动） */
function pickVictim(list, skipGid) {
  const live = (list || []).filter((t) => t && t.status === 'active' && String(t.gid) !== String(skipGid))
  if (!live.length) return null
  /* aria2 的 tellActive 给的是 totalLength/completedLength（都是字符串），
     分段引擎的 _status 也是同一套字段；total/filesize/completed 只作兜底。 */
  const ratio = (t) => {
    const total = Number(t.totalLength) || Number(t.total) || Number(t.filesize) || 0
    const done = Number(t.completedLength) || Number(t.completed) || 0
    return total > 0 ? done / total : 0
  }
  return live.sort((a, b) => ratio(a) - ratio(b))[0]
}

/** 让位任务在界面上的名字（取不到就退回 gid） */
function taskLabel(gid) {
  const m = tasks.info(gid)
  if (m && m.name) return String(m.name)
  const en = localEngine(gid)
  if (en) {
    try {
      const st = en.tellStatus(gid)
      const p = st && st.files && st.files[0] && st.files[0].path
      if (p) return path.basename(String(p))
      if (st && st.name) return String(st.name)
    } catch {
      /* ignore */
    }
  }
  return String(gid)
}

/**
 * 插队任务跑完（或被暂停/失败/移除）之后，把当初让位的任务恢复回来。
 * - 只在让位任务**仍然是 paused** 时恢复：用户自己点过「继续」的绝不覆盖。
 * - 插队任务从列表里消失（被移除）时也算结束，但连续 3 次看不到才认，
 *   免得因为某次列表还没刷新就把名额提前还回去。
 */
async function resumePreempted(list) {
  if (!preempted.size) return
  for (const [jumped, rec] of [...preempted]) {
    const t = (list || []).find((x) => String(x.gid) === String(jumped))
    if (!t) {
      rec.misses = (rec.misses || 0) + 1
      if (rec.misses < 3) continue
    } else {
      const st = String(t.status || '')
      if (st === 'active' || st === 'waiting') {
        rec.misses = 0
        continue
      }
    }
    preempted.delete(jumped)
    for (const p of rec.items) {
      try {
        const en = p.engine === 'seg' || p.engine === 'hls' ? localEngine(p.gid) : null
        if (en) {
          const s = en.has(p.gid) ? en.tellStatus(p.gid) : null
          if (s && s.status === 'paused') await en.unpause(p.gid)
        } else {
          const s = await aria2.tellStatus(p.gid).catch(() => null)
          if (s && s.status === 'paused') await aria2.unpause(p.gid).catch(() => {})
        }
      } catch {
        /* ignore */
      }
    }
    tasks.kick()
  }
}

/* 启动诊断日志：打包版是 GUI 子系统程序，stdout 拿不到，只能写文件。
 * **必须带上限**：超过 MAX 只留尾部 KEEP。教训：曾有个测试进程在断掉的 stdout
 * 管道上自旋刷了 148 万行未捕获异常，把 %TEMP% 里这个文件顶到 911 MB。 */
const BOOT_LOG = process.env.PANBOX_BOOT_LOG || path.join(require('node:os').tmpdir(), 'panbox-boot.log')
const BOOT_LOG_MAX = 2 * 1024 * 1024
const BOOT_LOG_KEEP = 512 * 1024
let bootBytes = -1
function bootTrim() {
  try {
    const st = fs.statSync(BOOT_LOG)
    if (st.size <= BOOT_LOG_MAX) {
      bootBytes = st.size
      return
    }
    const from = Math.max(0, st.size - BOOT_LOG_KEEP)
    const buf = Buffer.allocUnsafe(st.size - from)
    const fd = fs.openSync(BOOT_LOG, 'r')
    try {
      fs.readSync(fd, buf, 0, buf.length, from)
    } finally {
      fs.closeSync(fd)
    }
    fs.writeFileSync(BOOT_LOG, buf)
    bootBytes = buf.length
  } catch {
    bootBytes = 0
  }
}
function boot(...a) {
  try {
    if (bootBytes < 0 || bootBytes > BOOT_LOG_MAX) bootTrim()
    const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`
    fs.appendFileSync(BOOT_LOG, line)
    bootBytes += Buffer.byteLength(line)
  } catch {
    /* ignore */
  }
}
/* 底层模块（taskManager / 下载引擎）也要能往这本日志里写：它们不该反过来 require 主进程，
 * 于是把写日志这件事挂到 global 上。队列轮询出的错必须留痕 —— 以前那些错被 .catch(()=>{})
 * 吞掉，界面看起来只是「队列永远是 0」，谁也查不出为什么。 */
global.__pbBoot = boot
/* 打包版常从控制台/脚本里启动，启动它的父进程一退出 stdout 管道就断了，之后任何
 * console.* 都会抛 EPIPE —— 未被吞掉就会在 uncaughtException 里自旋。 */
for (const s of [process.stdout, process.stderr]) {
  if (s && typeof s.on === 'function') s.on('error', () => {})
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
  /* 便携版优先用 exe 旁边那份固定路径的（浏览器记的就是它） */
  if (portableExt && fs.existsSync(path.join(portableExt, 'manifest.json'))) return portableExt
  const candidates = isDev
    ? [path.join(__dirname, '..', 'resources', 'extension')]
    : [path.join(process.resourcesPath, 'extension'), path.join(__dirname, '..', 'resources', 'extension')]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return candidates[0]
}

/** 便携版把程序解压到临时目录，`process.resourcesPath` 每次启动都不一样 —— 照着那个
 *  路径去「加载已解压的扩展程序」，下次开机原路径就没了，浏览器里那条扩展直接失效。
 *  所以便携版一启动就把插件抄一份到 exe 旁边固定名字的目录，设置页指向那份。
 *  非便携版返回 null（装在 Program Files 里，不能往那儿写）。 */
function portableExeDir() {
  const d = process.env.PORTABLE_EXECUTABLE_DIR
  return d && path.isAbsolute(d) ? d : null
}

function portableExtDir() {
  const d = portableExeDir()
  return d ? path.join(d, 'PanBox插件') : null
}

/** 把插件抄到便携版 exe 旁边（每次都覆盖，插件随版本更新）。返回目标目录或 null。 */
function syncPortableExtension() {
  const out = portableExtDir()
  if (!out) return null
  const src = extensionDir()
  /* 目标可能就是源（有人把便携版解到同一层）：那就什么都不用做 */
  if (path.resolve(src) === path.resolve(out)) return out
  if (!fs.existsSync(path.join(src, 'manifest.json'))) return null
  try {
    /* 整目录递归抄：插件里有多少个文件由插件自己说了算，这里不维护一份清单 */
    fs.cpSync(src, out, {
      recursive: true,
      filter: (s) => path.basename(s) !== 'README.txt',
    })
    return out
  } catch (e) {
    boot('portable-ext-err', (e && e.message) || String(e))
    return null
  }
}

/* 便携版用的那份插件目录（同步成功后才有；没成功就还是用包内那份临时路径） */
let portableExt = null

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 这个名字缺后缀时，问一下地址「你是什么」。服务器没给 `content-disposition`
 * 文件名的时候，浏览器就是这么做决定的：URL 最后一段当名字，**响应类型补后缀**
 * （`…/epdf/10.1145/3345768.3355908` → `3345768.3355908.pdf`）。PanBox 以前只取
 * 名字不补后缀，用户拿到一个没后缀的文件，得自己改名才能打开。
 *
 * 只要响应头，正文一个字节都不读；失败了就算了，名字保持原样。
 */
async function ctOf(url, headers) {
  if (!/^https?:\/\//i.test(url)) return { ct: '', cdName: '' }
  const p = await probeUrl(url, { headers, allowLocal: allowLocalReq() })
  return { ct: p.ct, cdName: p.name }
}

/**
 * 提交下载之前把文件名定下来。检查顺序（前面的说了算）：
 *   ① 插件/解析器给的名字 —— 它问过服务器，比这里猜的准；
 *   ② 服务器这次自己给的文件名（`content-disposition`）；
 *   ③ 按响应类型补后缀；
 *   ④ 名字本身有后缀，就一个字都不动。
 * 只在「网盘」以外的地址上问 —— 网盘直链的名字由各自的解析器定，地址是一次性签名，
 * 多问一次白花站点资源还可能提前作废。
 */
async function resolveFileName(f, netdisk, headers) {
  let name = sanitizeFileName(f.name || '')
  const url = f.url || ''
  if (!url || netdisk !== 'direct' || isLocalUrl(url)) return name
  /* 名字是「地址路径最后一段」那种猜出来的（插件与解析器都这么兜底），
   * 而地址其实把真名写在查询串上时，用查询串那个（见 util.urlBaseName）。
   * 真的文件名（服务器给的、有后缀的）一律不动。 */
  const fromUrl = urlBaseName(url)
  if (fromUrl && hasKnownExt(fromUrl) && !hasKnownExt(name)) name = sanitizeFileName(fromUrl)
  if (name && hasKnownExt(name)) return name
  const got = await ctOf(url, headers || {})
  /* 留一句给「下下来没有后缀」这类反馈用：一眼能看出这次有没有问出响应类型 */
  boot('name-ext', name || '(空)', 'ct=' + (got.ct || '-'))
  if (got.cdName) {
    const cd = sanitizeFileName(got.cdName)
    /* 服务器自己给的文件名优先，除非它自己也没后缀而我们有类型线索 */
    if (cd && (hasKnownExt(cd) || !contentTypeExt(got.ct))) return cd
  }
  return sanitizeFileName(withExt(name, got.ct))
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
    const trayOn = boot0.trayIcon !== false
    /* 开机自启动默认「收在托盘」：登录时自己把窗口弹出来很打扰。
     * 只有在设置里明确勾了「启动时显示主窗口」才显示，或用户关掉了「关闭到后台」/「托盘图标」。 */
    if (STARTUP_HIDDEN && trayOn && boot0.closeToTray && !boot0.startupShowWindow) {
      boot('startup-hidden', '开机自启动，收在托盘里')
      ensureTray()
      return
    }
    win.show()
    /* 托盘图标默认开：不然「关窗口留在后台」之后用户找不到程序（首次启动也没有托盘入口） */
    if (trayOn) ensureTray()
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
    const cfgNow = settings.load()
    /* 关了托盘图标就没有「叫回窗口」的入口了，这时候关窗口必须真的退出 */
    if (!cfgNow.closeToTray || cfgNow.trayIcon === false) return
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
 * 文件有哪些可下的地址：主地址 + 解析器给的备用地址（去掉重复的）。
 * 顺序就是尝试顺序。
 *
 * 每条候选带两份头：
 *   - `headers`：解析器给的原样。它会写进任务记录（落盘）、也会出现在界面报错里。
 *   - `send`   ：真正交给引擎的那份 —— 再补一层浏览器身份（同站 cookie + 浏览器 UA +
 *                该主机的 Referer）。浏览器点得下来的地址，程序拿同一副身份去取才算数；
 *                而浏览器现场的 cookie 只存内存，绝不跟着记录落盘。
 */
function fileCandidates(f) {
  const list = [{ url: f.url, headers: f.headers || {} }]
  for (const u of Array.isArray(f.urls) ? f.urls : []) {
    if (!u || !u.url || u.url === list[0].url) continue
    if (list.some((x) => x.url === u.url)) continue
    list.push({ url: u.url, headers: u.headers || {} })
  }
  for (const c of list) c.send = identity.forRequest(c.url, c.headers)
  return list
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 本机地址（测试用的假站点）不做预检：那些站点的 HEAD 行为千奇百怪，白折腾。
 *  PANBOX_PROBE_LOCAL=1 时连本机地址也问一次 —— 只有端到端测试会开。 */
function allowLocalReq() {
  return process.env.PANBOX_PROBE_LOCAL === '1'
}

function isLocalUrl(url) {
  const h = hostOf(url)
  const local = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
  return local && !allowLocalReq()
}

/**
 * 预检一条地址：先 `HEAD`，被拒不认时用 `Range: bytes=0-0` 的 `GET` 再确认一次。
 *
 * 为什么要多这一步：下载引擎（尤其 aria2）遇到 403/404 会**反复重试**，用户看到的
 * 是一条卡在 0% 的任务，而不是「这条地址不行」。这里提前判定，就能直接换备用地址。
 * 只在有备用地址时才值得做（见 addResolved），否则等于白白多一次请求。
 */
async function handable(url, headers) {
  if (isLocalUrl(url)) return { ok: true, status: 0, finalUrl: url }
  const ua = headers['User-Agent'] || settings.load().userAgent || ''
  const h = ua ? { ...headers, 'User-Agent': ua } : headers
  const p = await probeUrl(url, { headers: h, timeout: PROBE_TIMEOUT })
  /* 网络层的错（`err` 有值、status 为 0）留给引擎去重试：它比这里更清楚要不要等一会儿 */
  if (!p.status && p.err) return { ok: true, status: 0, finalUrl: url }
  return { ok: p.usable, status: p.status, finalUrl: p.usable ? p.url || url : url }
}

/**
 * 从候选里挑第一条能用的。只有一条候选时不做预检（不白花一次请求）。
 * 全被拒时返回最后一条：让引擎自己去试、把真实报错交给用户看。
 *
 * 预检用的必须是 `send` —— 与随后真正下载用的是同一副身份。拿裸头去探、
 * 再拿带身份的头去下，会出现「探测说 403、其实下得动」这种自相矛盾的结论。
 */
async function firstHandable(cands, name) {
  if (cands.length < 2) return cands[0]
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]
    const pr = await handable(c.url, c.send)
    if (pr.ok) {
      if (i) boot('url-candidate', name, `改用备用地址 host=${hostOf(c.url)}`)
      return { ...c, url: pr.finalUrl || c.url }
    }
    boot('url-rejected', name, `host=${hostOf(c.url)} status=${pr.status}`)
  }
  return cands[cands.length - 1]
}

/**
 * 这条直链该不该按流媒体协议处理。
 * 返回 `'hls' | 'dash' | ''`，判据在 hls.js 里（与引擎自己认列表用的是同一份）。
 * 只看地址后缀与响应类型，**不发额外请求** —— 一批上千个文件时每个候选都探一次体太贵。
 */
function playlistKind(url, f = {}) {
  const h = (f && f.headers) || {}
  const ct = h['content-type'] || h['Content-Type'] || (f && f.mime) || ''
  return hls.classifyUrl(url, ct)
}

/**
 * 把一批已经拿到直链的文件真正排进下载队列。
 * 两个入口共用：渲染层的 `downloads:add`，和浏览器插件的 HTTP 通道（bridge）。
 */
async function addResolved(cfg, { session, netdisk, source, title, sessionId }) {
  const added = []
  const errors = []
  /* 定稿后的名字（与落盘、队列显示的是同一个），给调用方回话用 */
  const names = []
  const shareTitle = sanitizeFileName(title || 'PanBox')
  /* 只有一个文件、且它没有目录归属时，直接落在下载根目录。
   * 否则会出现「下载目录/文件名/文件名」这种多此一举的嵌套——
   * 蓝奏优享这类「分享标题就等于文件名」的网盘必然踩到。 */
  const nest = session.length > 1 || session.some((f) => f.dir)

  /* 「这批里有没有来自用户自己的解析接口」整批只算一次。
   * 以前写在下面的 for 循环里 → 千文件就是百万次回调，而且是在 IPC 主线程上。 */
  const perEndpoint = session.some((x) => x.viaEndpoint)

  for (const f of session) {
    /* 名字在这里定稿：缺后缀的按响应类型补上（详见 resolveFileName）。
     * 定稿之后再算目录、落盘名、队列名，三处都是同一个名字。 */
    f.name = await resolveFileName(f, netdisk, f.headers)
    const subdir = nest
      ? path.join(
            cfg.downloadDir,
            shareTitle,
            ...(f.dir ? String(f.dir).split(/[\\/]/).filter(Boolean).map(sanitizeFileName) : [])
          )
      : cfg.downloadDir
    try {
      fs.mkdirSync(subdir, { recursive: true })
    } catch {
      /* ignore */
    }
    /* 百度按「账号」维度限速：并发调大只会招致几小时~几天的惩罚性降速。
     * 但如果这条直链是用户自己的「解析接口」给的（别人的会员账号出的链），
     * 那限速档位就不是用户的账号了，再限成单线程等于白配——所以跳过这个限制。 */
    const isBaidu = netdisk === 'baidu' && !perEndpoint
    /* 不用分段引擎的那几家，aria2 的并发也要按网盘调（默认 16 会招来 503/403）。
     * 百度默认仍然是 1：它按「账号」维度限速，并发调大只会招致几小时~几天的惩罚性降速。
     * 但如果你本来就是超级会员（或开了客户端「下载提速」），账号本身有额度，
     * 那 1 条就变成人为上限了 —— 所以设置里有 cfg.baiduConnections 让你自己调上去。 */
    const split = isBaidu ? Math.max(1, Number(cfg.baiduConnections) || 1) : perEndpoint ? cfg.split : ARIA2_SPLIT_OVERRIDE[netdisk] || cfg.split
    const options = {
      dir: subdir,
      out: sanitizeFileName(f.name),
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
      /* 这一轮投递的起点。下面这段可能要跑很久（分段引擎是先登记任务、后探测地址，
       * 探测最坏 2~3 分钟），用户完全可能在这中间把队列里那行删掉；探测失败回退
       * aria2 之前要能看出来「这条已经取消了」（见 core/cancelGuard.js）。 */
      const addStartedAt = Date.now()
      /* 主地址 + 备用地址。与初次添加同一套规矩：分段引擎先试，它自己会探测（探测不通过
       * 就在 add() 里抛错），所以这里按候选顺序逐条试，一条都不行才回退 aria2。
       * aria2 没有「探测」这个环节，遇到 403 只会反复重试卡在 0%，所以先用 handable()
       * 把明显不能下的候选挑掉。 */
      const cands = fileCandidates(f)
      let pick = cands[0]
      let gid = ''
      let engine = 'aria2'
      /* HLS 播放列表必须交 HLS 引擎：aria2 官方不支持 m3u8（下下来是一个几 KB 的
       * 列表文件，用户什么也看不了），分段引擎也只是把它当普通文件存。 */
      let plKind = cands.length ? playlistKind(cands[0].url, f) : ''
      /* 插件说这条是播放列表、可地址没后缀、响应类型也不认识（有些 CDN 干脆不给类型）：
       * 才值得多发一次请求抓开头几百字节确认。只在这一种情况下探，别的都不探。 */
      if (!plKind && f.stream && cands.length) {
        plKind = await hls
          .sniff(cands[0].url, {
            headers: cands[0].send,
            proxy: useProxy,
            insecure: !!cfg.ignoreCert,
          })
          .catch(() => '')
        if (plKind) boot('sniff-playlist', f.name, `kind=${plKind} host=${hostOf(cands[0].url)}`)
      }
      if (plKind === 'hls') {
        gid = await hls.add({
          url: cands[0].url,
          headers: cands[0].send,
          dir: subdir,
          name: f.name,
          proxy: useProxy,
          insecure: !!cfg.ignoreCert,
          netdisk,
          source,
        })
        engine = 'hls'
        boot('add-hls', f.name, `host=${hostOf(cands[0].url)}`)
      } else if (plKind === 'dash') {
        /* 宁可明确说不支持，也不要给用户一个打不开的 XML */
        throw new Error('DASH（.mpd）格式暂不支持，请换 HLS 或普通直链')
      }
      if (!gid && segConns && cands.length) {
        for (let i = 0; i < cands.length && !gid; i++) {
          try {
            gid = await seg.add({
              url: cands[i].url,
              headers: cands[i].send,
              dir: subdir,
              out: sanitizeFileName(f.name),
              connections: segConns,
              netdisk,
              source,
              proxy: useProxy,
              insecure: !!cfg.ignoreCert,
            })
            engine = 'seg'
            pick = cands[i]
            /* 和下面的 add-aria2 对称：日志里必须看得出这条到底交给了哪个引擎 */
            boot('add-seg', f.name, `host=${hostOf(cands[i].url)} conns=${segConns}`)
            if (i) boot('url-candidate', f.name, `分段引擎改用备用地址 host=${hostOf(cands[i].url)}`)
          } catch (e) {
            /* 不支持 Range（老服务器）、或者探测失败 → 换下一条候选，都不行再回退 aria2 */
            boot('seg-fallback', netdisk, f.name, `host=${hostOf(cands[i].url)} ` + ((e && e.message) || String(e)))
            gid = ''
          }
        }
      }
      if (!gid) {
        pick = await firstHandable(cands, f.name)
        const opts2 = { ...options }
        const h2 = buildHeaders(pick.send)
        if (h2.length) opts2.header = h2
        else delete opts2.header
        gid = await aria2.addUri([pick.url], opts2)
        engine = 'aria2'
        /* 这条不能只写进 boot：用户看到的报错得能分辨是哪个站拒的 */
        boot('add-aria2', f.name, `host=${hostOf(pick.url)} cands=${cands.length}`)
        /* 写进 options 的那份头留解析器原样（它跟着 origin 落盘）：浏览器现场的
         * cookie 只用上面 opts2 这一份，进引擎，不落盘。 */
        options.header = buildHeaders(pick.headers)
      }
      /* 交引擎之前那一步可能很慢（探测、重试），用户在这中间把这条删掉是常有的事。
       * 删了就把刚刚加进去的这条也撤掉，别让它换个 gid 复活成队列里的一行。 */
      if (cancelGuard.cancelledAfter(subdir, f.name, addStartedAt)) {
        await hardRemove(gid, { label: 'add-cancelled' }).catch(() => {})
        boot('add-cancelled', f.name, `gid=${gid} engine=${engine}`)
        continue
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
          /* 这次真正交给引擎的那条地址。「换直链」时先拿它判断是什么站
           * （插件抓来的投递地址 `/Delivery.cfm/…` 需要就地换新签名，而不是重新解析一遍）。 */
          url: pick.url,
          headers: pick.headers || {},
          opts: { ...options },
        },
      })
      /* 夸克/UC 是「转存→取直链」，用户网盘里会多一份拷贝；登记下来，
       * 等这个任务 complete 时回收（见下面的 tasks.on('update')）。
       * 用 cleanupRemember 而不是直接 set：同名任务不会互相覆盖记录。 */
      cleanupRemember(f.name, sessionId)
      added.push(gid)
      names.push(f.name)
    } catch (e) {
      errors.push(`${f.name}: ${e && e.message ? e.message : e}`)
    }
  }
  tasks.kick()
  return { added, errors, names }
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
  /* ⚠️ 判据是**站点在不在那张网盘表里**，不是「nd 不等于 direct」。
   * 之前写成 `nd !== 'direct' && nd !== 'unknown'`，于是每加一个「不是网盘、
   * 但有专门解析器」的站点（mdpi / ssrn 这类论文站）都会被当成分享链接，
   * 插件交过来的下载地址会被塞进「请用户勾选」那条路 —— 对一个单文件直链
   * 来说那是死路。 */
  if (parsers.SHARE_NETDISKS.has(nd)) {
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

  /**
   * 站点自己的「下载按钮」地址往往**不是**文件地址：MDPI 的按钮在 www.mdpi.com 上，
   * 后面站着 Akamai —— 引擎拿着它直连只会吃 403；真正的文件在 mdpi-res.com 的 CDN 上。
   * 论文站这类「有专门解析器、但网址本身不是文件」的站点，先让解析器把真地址换出来，
   * 再交给引擎。换不出来（站点改版、挑战过不去）就退回原地址，行为与以前一致。
   */
  let finalUrl = url
  let finalName = ''
  let finalSize = 0
  let viaParser = ''
  if (nd !== 'direct' && parsers.PARSERS[nd]) {
    let sid = ''
    try {
      const one = (await parsers.parseShare({ text: url, settings: cfg })).results[0]
      sid = one && one.sessionId ? one.sessionId : ''
      if (one && one.ok && one.files && one.files.length) {
        const got = await parsers.resolveFiles({ sessionId: one.sessionId, ids: [one.files[0].id] })
        if (got.length && got[0].url) {
          finalUrl = got[0].url
          finalName = got[0].name || one.files[0].name || ''
          finalSize = Number(got[0].size || one.files[0].size || 0)
          viaParser = nd
          for (const [k, v] of Object.entries(got[0].headers || {})) if (v && !headers[k]) headers[k] = v
        }
      }
    } catch (e) {
      boot('bridge-add-parse', nd, (e && e.message) || String(e))
    } finally {
      /* 会话只是这条路上的一次性缓存，用完就丢（不留着等 gc） */
      if (sid) parsers.dropSession(sid)
    }
  }

  let name = sanitizeFileName(finalName || (p && p.name) || '')
  if (!name) {
    try {
      const seg2 = new URL(url).pathname.split('/').filter(Boolean).pop() || ''
      name = sanitizeFileName(decodeURIComponent(seg2))
    } catch {
      name = ''
    }
  }
  /* 插件从响应头里读到过类型就先用上（ACM 那类地址最后一段是个编号，没有后缀）。
   * 没读到也不要紧：addResolved 提交前会自己问一次。 */
  name = sanitizeFileName(withExt(name, (p && p.mime) || ''))
  if (!name) name = 'download.bin'

  const session = [
    {
      id: '0',
      name,
      size: finalSize || Number((p && p.size) || 0),
      isDir: false,
      dir: '',
      url: finalUrl,
      headers,
      /* 插件探到的响应类型与它的分类都带下去：地址没后缀时，
       * 「这是不是播放列表」只能靠这两条线索（见下面 addResolved 里的 playlistKind / sniff）。 */
      mime: (p && p.mime) || '',
      stream: p && p.kind === 'stream' ? 1 : 0,
    },
  ]
  /* 论文站这类「地址本身就是会过期的投递地址」的：提交前先问站点要一条新的。
   * 插件抓到的那条往往是几分钟前点的按钮地址，那时它就差一步到 5 分钟有效期了。 */
  if (nd === 'ssrn' && parsers.PARSERS.ssrn && parsers.PARSERS.ssrn.isDelivery(finalUrl)) {
    try {
      const got = await parsers.PARSERS.ssrn.resolveDelivery(finalUrl, {
        cookie: p && p.cookie,
        headers,
        userAgent: (p && p.userAgent) || '',
      })
      if (got && got.ok) {
        session[0].url = got.url
        /* 预签名地址自带签名和有效期，不需要再带 Cookie / Referer；
         * 留着旧头反而可能把一张「只认签名」的地址带歪。 */
        session[0].headers = { ...got.headers }
        viaParser = 'ssrn'
        boot('bridge-add-fresh', name, `host=${hostOf(got.url)} cookie=${got.cookieLen || 0}`)
      } else {
        /* 换不出来只能把投递地址交下去，引擎多半会 403 —— 日志里留一句，才分得清
         * 是「没带浏览器身份」还是「带了但站点还是拒」。 */
        boot(
          'bridge-add-fresh-miss',
          name,
          `status=${(got && got.status) || 0} cookie=${(got && got.cookieLen) || 0} clearance=${got && got.hasClearance ? 1 : 0}`
        )
      }
    } catch (e) {
      boot('bridge-add-fresh-err', name, (e && e.message) || String(e))
    }
  }
  const r = await addResolved(cfg, {
    session,
    netdisk: viaParser || 'direct',
    source: (p && p.referer) || '',
    title: (p && p.pageTitle) || name,
  })
  if (!r.added.length) return { ok: false, message: r.errors[0] || '加入下载队列失败' }
  /* 回话用定稿后的名字：面板上显示的和队列里、磁盘上的保持一致 */
  const done = r.names[0] || name
  return { ok: true, kind: 'direct', name: done, gid: r.added[0], message: `已加入下载队列：${done}` }
}

/**
 * 插件「把这一页交给 PanBox」。
 *
 * 站点上了反爬（蓝奏云这类挂 ESA 的）时，纯程序算出来的 cookie 可能被打回，
 * 而浏览器自己那份一定有效 —— 页面就是它打开的。这里只做两件事：把浏览器
 * 此刻在这一页用的身份记进**内存**，然后把窗口叫出来、把地址填好等用户点解析。
 * 不落盘、不进日志、不替用户决定下什么。
 */
async function bridgePage(p) {
  const raw = String((p && p.url) || '')
  let url = raw
  try {
    const u = new URL(raw)
    u.hash = ''
    url = u.toString()
  } catch {
    return { ok: false, message: '只接受 http(s) 页面地址' }
  }
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: '只接受 http(s) 页面地址' }

  const n = browserCtx.set({ ...p, url })
  /* 把「交上来几个主机」和「其中哪几个带了 Authorization」都写进启动日志：
   * 移动云盘取直链就差这一条头，出问题时先看这行，不用再猜插件有没有生效。 */
  boot('bridge-page', 'hosts=' + n,
    'auth=' + (browserCtx.authHosts ? browserCtx.authHosts().join(',') || '（没有）' : '?'),
    'url=' + url.slice(0, 80))

  const nd = detectNetdisk(url)
  const isShare = parsers.SHARE_NETDISKS.has(nd)
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('bridge:prefill', {
      url,
      netdisk: isShare ? nd : '',
      message: isShare
        ? '已收到这一页的浏览器身份，点「解析」看看里面有什么'
        : '已收到这一页的浏览器身份，把要解析的分享链接粘进来再点「解析」',
    })
  }
  return {
    ok: true,
    kind: isShare ? 'share' : 'page',
    message: isShare ? '已交给 PanBox，点「解析」看看里面有什么' : '已收到这一页的浏览器身份，把分享链接粘进来即可',
  }
}

/** 拿（必要时生成）桥的配置。令牌只存在本机 settings.json 里。 */
function bridgeCfg() {
  const cfg = settings.load()
  if (!cfg.bridgeToken) cfg.bridgeToken = settings.save({ bridgeToken: bridge.ensureToken('') }).cfg.bridgeToken
  return cfg
}

async function startBridge() {
  const cfg = bridgeCfg()
  if (!cfg.bridgeEnabled) {
    await bridge.stop().catch(() => {})
    return bridge.status()
  }
  const st = await bridge.start({ port: cfg.bridgePort, token: cfg.bridgeToken }, bridgeAdd, bridgePage)
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

/** 一个任务在磁盘上的真实文件路径（本地引擎与 aria2 的 tellStatus 都带 files[0].path） */
async function taskFile(gid) {
  let st = null
  try {
    st = await aria2.tellStatus(gid)
  } catch {
    /* 可能不在 aria2 上（本地引擎的任务），也可能已经没了 */
  }
  const en = localEngine(gid)
  if (!st && en) {
    try {
      st = en.tellStatus(gid)
    } catch {
      /* 两边都没有 */
    }
  }
  if (!st) return null
  const f = (st.files && st.files[0]) || {}
  return { status: String(st.status || ''), path: f.path || '', dir: st.dir || '' }
}



/**
 * 把一条任务从引擎里彻底拿掉（不只是暂停）。
 *
 * 本地引擎（seg/hls）自己就会连临时文件一起清，直接 `remove` 即可；aria2 要两步：
 * 先 `remove`（停止），再 `removeDownloadResult` —— 后者把结果从「已停止」列表里清掉，
 * 不清的话下一轮 `tellStopped` 又把它读回来，界面上看起来像「点了移除没反应」。
 *
 * aria2 的 `removeDownloadResult` 在 `remove` 刚发出的瞬间可能报「找不到」，
 * 所以要重试几次。以前这段在三个地方各写了一遍：一处重试 4×250ms、一处只 catch 一次，
 * 于是「移除」偶尔会留下一条已停止的幽灵任务 —— 现在统一走这里。
 *
 * 清不掉也不许抛：任务在引擎里已经是停止态，调用方按「已移除」继续处理，
 * 只在 boot 日志里留一笔。
 * @returns {Promise<boolean>} 引擎那边是否真的清掉了（本地引擎 remove 的返回值 / aria2 清结果成功）
 */
async function hardRemove(gid, { retries = 4, label = '' } = {}) {
  const en = localEngine(gid)
  if (en) {
    const r = await en.remove(gid).catch(() => false)
    return !!r
  }
  await aria2.remove(gid).catch(() => {})
  const tries = Math.max(1, Number(retries) || 1)
  for (let i = 0; i < tries; i++) {
    try {
      await aria2.removeDownloadResult(gid)
      return true
    } catch {
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 250))
    }
  }
  boot('hard-remove-miss', label || String(gid || ''))
  return false
}

/** 把任务从队列与引擎里彻底清掉（与 downloads:remove 同一套动作，删文件后复用） */
async function purgeTask(gid) {
  await hardRemove(gid, { label: 'purge' })
  tasks.forget(gid)
  tasks.kick()
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
    /* 这里失败不能吞：界面上的并发数、分片大小、下载目录、UA 都是靠这一条推给
     * aria2 的，吞掉就是「用户改了、界面也是新值、实际还是老参数」。
     * 分段引擎那份在下面 setLimit / 按任务给，不受影响。 */
    try {
      await aria2.changeGlobalOption({
        'max-concurrent-downloads': String(after.maxConcurrent),
        split: String(after.split),
        'max-connection-per-server': String(after.maxConnectionPerServer),
        'min-split-size': after.minSplitSize,
        dir: after.downloadDir,
        'user-agent': after.userAgent,
      })
    } catch (e) {
      throw new Error('设置已经存下来，但没能推给 aria2：' + ((e && e.message) || String(e)))
    }
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
  /* 回收站目录换了（或者下载目录换了 —— 老位置的回收站要跟着搬）：重新指一次，
   * 并把旧目录里还在的内容搬进新目录。 */
  if (String(after.trashDir) !== String(before.trashDir) || String(after.downloadDir) !== String(before.downloadDir)) {
    trash.configure({ dir: after.trashDir, downloadDir: after.downloadDir })
    purgeTrash('settings')
  }
  /* 托盘图标开关：关掉立刻撤图标，打开立刻建出来 */
  if (!!after.trayIcon !== !!before.trayIcon) {
    if (after.trayIcon === false) destroyTray()
    else ensureTray()
  }
  /* 保留天数改了：立刻按新期限清一次（把期限调短能马上生效），并让索引里的剩余天数刷新 */
  if (Number(after.trashRetentionDays) !== Number(before.trashRetentionDays)) {
    trash.setRetention(after.trashRetentionDays)
    purgeTrash('settings')
  }
  /* 「同时下载数」也要管住本地引擎：aria2 在上面走 changeGlobalOption，它有原生队列；
     分段引擎与 HLS 引擎各有自己的队列（setLimit），改了上限立刻把排队中的任务放出去。 */
  if (Number(after.maxConcurrent) !== Number(before.maxConcurrent)) {
    seg.setLimit(after.maxConcurrent)
    hls.setLimit(after.maxConcurrent)
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
    /* ⚠️ 别叫 req：上面第 18 行从 parsers/util 引进来的 req() 是同名的模块级函数，
     * 在这里遮蔽它，以后有人在函数里调 req(url, …) 会去调这个 ClientRequest，报错还很难看懂。 */
    const httpReq = https.request(
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
          if (body.length > 512 * 1024) httpReq.destroy()
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
    httpReq.on('timeout', () => {
      httpReq.destroy(new Error('请求超时'))
    })
    httpReq.on('error', (e) => {
      resolve({ ok: false, current, message: (e && e.message) || String(e) })
    })
    httpReq.end()
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

/** 关掉「显示托盘图标」时把图标撤掉（设置页改一下就能立刻看到效果） */
function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}

/**
 * 回收站到期清理。启动时、设置里改了保留天数时、以及每 6 小时各做一次。
 * 删不掉的条目（文件被别的程序占用）会留在索引里，下次再试 —— 这里只记一行日志。
 */
function purgeTrash(why) {
  try {
    const r = trash.purgeExpired()
    if (r.removed || r.kept) boot('trash-purge', String(why), 'removed=' + r.removed, 'kept=' + r.kept)
  } catch (e) {
    boot('trash-purge-err', String(why), String((e && e.message) || e))
  }
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
    /* 解析请求跟随系统代理：Node 自带的 fetch 不读 Windows 代理设置，直连状态下
     * 有些站点（本机实测 papers.ssrn.com）连挑战页都拿不到，只会超时。 */
    const px = setOutboundProxy(proxy.effective(settings.load()))
    boot('outbound-proxy', px.proxy || '(直连)', px.ok ? 'ok' : '失败：' + (px.message || ''))
    /* 便携版：把插件抄到 exe 旁边（固定路径），否则浏览器里那条扩展每次开机都失效 */
    if (portableExeDir()) {
      portableExt = syncPortableExtension()
      boot('portable-ext', portableExt || '未同步', 'src=' + extensionDir())
    }
/* ---- IPC 注册：各域拆到 electron/ipc/*.js，只有 main.js 才有的局部在这里组装成 ctx ----
     * ⚠️ 下面带 getter/setter 的这几项在运行期会被整体重新赋值（updState 由 updTell 换新对象、
     * autoChecked 由更新流程写、isQuitting 由 before-quit 写、aria2Ready/aria2Error 由 startAria2
     * 写），各域里解构快照会拿到过期值，所以必须现取；win 在重建窗口时会换对象，同样传取值函数。
     * preempted 是 Map，必须与下面的 resumePreempted 共用同一个，所以整只传进去。
     * 拿回来的 autoRefreshExpired 是下载域里的实现，下面那条模块级 tasks.on('update')
     * 要用它 —— 拆文件时它一度只留在下载域内部，主进程按名调不到，每 tick 抛
     * ReferenceError 被下面的 try/catch 吞掉，「直链过期自动换链」等于没接线。 */
    const { autoRefreshExpired } = require('./ipc')({
      win: () => win,
      boot,
      get updState() { return updState },
      get autoChecked() { return autoChecked },
      set autoChecked(v) { autoChecked = v },
      get isQuitting() { return isQuitting },
      set isQuitting(v) { isQuitting = v },
      get aria2Ready() { return aria2Ready },
      get aria2Error() { return aria2Error },
      checkUpdate,
      readableNetError,
      updTell,
      canAutoUpdate,
      applyRuntimeSettings,
      applyAutoStart,
      OPEN_PATH_BLOCKED_EXT,
      bridgeInfo,
      startBridge,
      extensionDir,
      startAria2,
      addResolved,
      localEngine,
      pickVictim,
      taskLabel,
      preempted,
      hardRemove,
      taskFile,
      purgeTask,
      recycleTransferCopy,
      cleanupRemember,
      cleanupTake,
      buildHeaders,
      segConnectionsFor,
      playlistKind,
      hostOf,
    })
    initAutoUpdater()
    /* 回收站索引跟着用户数据走；回收目录默认也在用户数据目录下（设置里可改），
     * 不在下载目录里造文件夹。configure 里会顺手把老位置的回收站内容搬过来。 */
    trash.configure({
      indexPath: path.join(app.getPath('userData'), 'trash.json'),
      dir: settings.load().trashDir,
      downloadDir: settings.load().downloadDir,
      retentionDays: settings.load().trashRetentionDays,
    })
    createWindow()
    boot('window created')

    /* 回收站到期清理：启动先扫一次（load() 里也会扫），之后每 6 小时一次。
     * unref 掉，别让它拖着进程不退出。 */
    purgeTrash('startup')
    const trashTimer = setInterval(() => purgeTrash('timer'), 6 * 60 * 60 * 1000)
    if (trashTimer.unref) trashTimer.unref()

    /* 本地引擎的并发上限跟着设置走（0/非法值 = 不限，保留旧行为） */
    seg.setLimit(settings.load().maxConcurrent)
    hls.setLimit(settings.load().maxConcurrent)

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

    /* 上一次记进 boot 日志的队列条数（见 tasks-update 那条去重） */
    let lastListCount = -1
    tasks.on('update', (list) => {
      /* ⚠️ 这个回调里抛出的异常会顺着 emit 冒进 taskManager 的 _tick()，
       * 把这一轮算好的列表整个丢掉（界面就停在旧列表，看起来像「队列永远是 0」）。
       * 所以每件事都各自兜住，谁也不许把异常放出去。 */
      try {
        resumePreempted(list).catch(() => {})
      } catch (e) {
        boot('update-handler-err', 'resumePreempted ' + ((e && e.message) || String(e)))
      }
      try {
        autoRefreshExpired(list).catch((e) => boot('update-handler-err', 'autoRefreshExpired ' + ((e && e.message) || String(e))))
      } catch (e) {
        boot('update-handler-err', 'autoRefreshExpired ' + ((e && e.message) || String(e)))
      }
      try {
        if (win && !win.isDestroyed()) win.webContents.send('downloads:update', list)
      } catch (e) {
        boot('update-handler-err', 'send ' + ((e && e.message) || String(e)))
      }
      /* 队列条数记一笔：以后有人报「队列是空的」，看日志就能分清是没算出来还是没送到界面。
       * 只在**条数变化**时写：这条日志的意义就是「算出来的条数是多少」，
       * 而下载中每 800ms 进度都在变、指纹一定会变，不去重就是每 800ms 一次同步落盘。 */
      const nList = Array.isArray(list) ? list.length : -1
      if (nList !== lastListCount) {
        lastListCount = nList
        boot('tasks-update', 'n=' + nList)
      }
    })

    /** 给界面发一条提示行（渲染层按原话显示，见 `src/App.tsx` 里的 `downloads:notice`） */
    function notice(text) {
      if (!win || win.isDestroyed()) return
      win.webContents.send('downloads:notice', { text: String(text) })
    }

    /* 下载完成 → 回收转存副本，别让用户网盘里堆 `xxx(1).zip`；顺便按需打开下载目录。
     * 这个事件每个 gid 只发一次，所以不用像以前那样在每个 tick 里扫全表。
     * ⚠️ 必须用模块级的 `downloadsCleanup`：之前误写成了 `downloads:add` 处理函数里的
     * 局部别名 `cleanupOn`，那个作用域在监听器里根本不存在 → 每 tick 抛 ReferenceError
     * 被吞掉，回收从来没真正跑过。 */
    tasks.on('complete', async (t) => {
      boot('complete', String(t.name))
      recycleTransferCopy(t.name, 'complete')
      /* 用户把「页面地址」当下载地址投进来时（X / YouTube / Pinterest 的页面链接最常这样投），
       * 服务器回的就是网页本身，落盘叫 `xx.html`。不说一句的话，用户只会觉得「下载坏了」——
       * 这里如实讲清楚它是什么、以及真要下视频该怎么做。complete 每个 gid 只发一次。
       *
       * 但**光看后缀不够**：影视站的播放器把真列表包在 `播放器站/?url=cdn/…/index.m3u8` 里，
       * 服务器回 text/html，落盘却叫 `dxfbk.m3u8`（面板也就照这个名字显示）——用户点它、
       * 下到一个 16 KB 的「列表」，改成什么后缀都放不出来。所以再**看一眼产物开头的字节**，
       * 两种情况都如实说，只是话不一样。 */
      const namedHtml = /\.html?$/i.test(String(t.name || ''))
      let bodyHtml = false
      if (!namedHtml) {
        try {
          const f = await taskFile(t.gid)
          if (f && f.path) bodyHtml = await looksLikeHtml(f.path)
        } catch (e) {
          /* 看一眼产物失败（比如刚下完就被移走）不该影响后面那些提示 */
          boot('html-check-fail', (e && e.message) || String(e))
        }
      }
      if (namedHtml || bodyHtml) {
        boot('html-not-file', String(t.name), namedHtml ? 'by-name' : 'by-body')
        notice(
          namedHtml
            ? `「${t.name}」是网页本身（HTML），不是视频/文件 —— 多半投的是页面地址。要下视频：先把视频播起来，再用浏览器插件面板选播放列表或分片。`
            : `「${t.name}」打开是网页（HTML），不是视频 —— 这条地址是个播放器页面，视频藏在它里面。要下这个视频：回面板的「视频 / 播放列表」里换一条列表（通常是 CDN 域名上那条 index.m3u8 / mixed.m3u8）再下一次。`,
        )
      }
      /* 流媒体引擎也有话要说：这一路只有画面、音轨没取回来、或者声音只能单独存一个文件。
       * 从前这些话只进了 console（打包版没人接），用户拿到一个没声音的文件却不知道原因。 */
      const en = localEngine(t.gid)
      const st = en ? en.tellStatus(t.gid) : null
      if (st && st.note) {
        boot('hls-note', String(st.note))
        notice(`「${t.name}」：${st.note}`)
      }
      if (settings.load().openFolderWhenDone && win && !win.isDestroyed()) {
        const dir = t.dir || settings.load().downloadDir
        /* openPath 不抛异常，失败时返回原因 —— 吞掉的话「下完自动打开目录」这个
         * 开关坏掉了也没人知道（日志里留一条，界面不再打扰用户） */
        shell
          .openPath(dir)
          .then((err) => {
            if (err) boot('open-folder-fail', dir, err)
          })
          .catch((e) => boot('open-folder-fail', dir, (e && e.message) || String(e)))
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
    const cfgNow = settings.load()
    if (!cfgNow.closeToTray || cfgNow.trayIcon === false) app.quit()
  })

  /* 退出前把「已下载完成但还没轮到回收」的转存副本补收一次，
   * 免得用户关得快就留下一份垃圾。**只收已 complete 的**：
   * 没下完的任务还需要那份转存文件来续传，绝不能删。 */
  let cleanupDone = false
  /* 分段引擎落断点、桥停监听、aria2 收子进程都是异步的，而 Electron 不等
   * async 事件监听器 —— 不挡一下，进程可能在 shutdown 发出去之前就没了，
   * 留下一个占着端口的 aria2c，下次启动就报「aria2 启动失败」。
   * 挡两次：回收站那次（本来就有），以及最后这轮收尾。 */
  let shutdownDone = false
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
    if (shutdownDone) return
    e.preventDefault()
    shutdownDone = true
    tasks.stop()
    /* 本地引擎要把断点信息落盘、关掉文件句柄，下次启动才能接着下 */
    await seg.flush().catch(() => {})
    await hls.flush().catch(() => {})
    /* 元信息是攒着写的（见 taskManager._scheduleMetaSave），退出前一定要落一次 */
    tasks.flushMeta()
    await bridge.stop().catch(() => {})
    await aria2.stop().catch(() => {})
    boot('quit', 'cleanup done')
    app.quit()
  })
}
