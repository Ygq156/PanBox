import type { ParseResponse, DownloadTask, Settings, Aria2Status } from './types'

export interface ParsePayload {
  text: string
  password?: string
}

export interface AddPayload {
  /** 主进程解析会话 id + 选中的文件 id（推荐路径） */
  sessionId?: string
  ids?: string[]
  /** 直接给直链的兜底路径 */
  files?: { url: string; name: string; dir?: string; headers?: Record<string, string> }[]
  netdisk: string
  source?: string
  /** 分享标题，用来建子目录 */
  title?: string
}

export interface BridgeStatus {
  running: boolean
  port: number
  host: string
  url: string
  error?: string
  added: number
  lastAddedName?: string
  lastAddedAt?: number
  lastError?: string
  paired: boolean
  pairedAt?: number
  /** 设置里有没有开这条通道 */
  enabled: boolean
  /** 配对令牌，插件高级选项里要填的就是它 */
  token: string
  /** 未打包的浏览器插件目录（「打开插件文件夹」按钮用） */
  extDir: string
  extExists: boolean
}

export interface ProxyStatus {
  mode: 'auto' | 'off' | 'custom'
  /** Windows 系统里读到的代理（'' = 系统没开代理） */
  system: string
  /** 设置里手填的那个 */
  custom: string
  /** 最终会用的那个（'' = 直连） */
  effective: string
}

export interface AppInfo {
  version: string
  /** false = 开发模式（npm start） */
  packaged: boolean
  autoStart: boolean
  /** 开发模式不写登录项，界面要据此提示「安装版才生效」 */
  autoStartApplied: boolean
  /** 便携版：登录项里记的路径换个位置就失效，界面要据此提醒 */
  portable: boolean
  platform: string
}

/** 回收站里的一条记录（删掉的下载文件） */
export interface TrashItem {
  id: string
  name: string
  /** 原来的完整路径，还原就挪回这里 */
  from: string
  size: number
  dir: boolean
  netdisk: string
  at: number
}

export interface UpdateInfo {
  ok: boolean
  current: string
  latest?: string
  hasUpdate?: boolean
  url?: string
  name?: string
  publishedAt?: string
  /** ok=false 时的原因（超时 / 被墙 / 限流…） */
  message?: string
}

/** 安装版自更新的状态（主进程 update:state / update:download / update:install） */
export interface UpdateState {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'latest' | 'error'
  /** 这次检查能不能就地更新（打包过的安装版才有） */
  canUpdate?: boolean
  version?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  message?: string
}

export interface PanboxAPI {
  parseShare(p: ParsePayload): Promise<ParseResponse>
  /** 界面丢掉一条解析结果时通知主进程释放对应会话缓存 */
  dropParseSession(sessionId: string): Promise<boolean>
  listDownloads(): Promise<DownloadTask[]>
  addDownloads(p: AddPayload): Promise<{ ok: boolean; added: string[]; errors: string[] }>
  pauseTask(gid: string): Promise<boolean>
  resumeTask(gid: string): Promise<boolean>
  refreshTask(gid: string): Promise<{ ok: boolean; gid?: string; message?: string }>
  removeTask(gid: string, deleteFile?: boolean): Promise<boolean>
  /** 删掉已下载完成的文件：文件进回收站，任务同时从队列移除 */
  deleteTaskFile(gid: string): Promise<{ ok: boolean; name?: string; size?: number; message?: string }>
  pauseAll(): Promise<boolean>
  resumeAll(): Promise<boolean>
  trashList(): Promise<TrashItem[]>
  trashRestore(id: string): Promise<{ ok: boolean; name?: string; path?: string; message?: string }>
  trashDelete(id: string): Promise<boolean>
  trashEmpty(): Promise<number>
  trashOpenDir(): Promise<string>
  getSettings(): Promise<Settings>
  setSettings(s: Partial<Settings>): Promise<Settings>
  /** 恢复默认设置（登录凭证与自备解析接口保留），返回恢复后的设置 */
  resetSettings(): Promise<Settings>
  pickDir(): Promise<string | null>
  openPath(p: string): Promise<string>
  aria2Status(): Promise<Aria2Status>
  restartAria2(): Promise<Aria2Status>
  openLogin(netdisk: string): Promise<{ ok: boolean; cookie?: string; count?: number; loggedIn?: boolean; message?: string }>
  clearLogin(netdisk: string): Promise<boolean>
  bridgeStatus(): Promise<BridgeStatus>
  bridgeStart(): Promise<BridgeStatus>
  bridgeOpenFolder(): Promise<{ ok: boolean; dir: string; message: string }>
  bridgeNewToken(): Promise<BridgeStatus>
  proxyStatus(): Promise<ProxyStatus>
  appInfo(): Promise<AppInfo>
  setAutoStart(on: boolean): Promise<{ ok: boolean; autoStart: boolean; applied: boolean }>
  checkUpdate(opts?: { manual?: boolean }): Promise<UpdateInfo>
  openRelease(url: string): Promise<{ ok: boolean; message?: string }>
  updateState(): Promise<UpdateState>
  updateAppCheck(): Promise<{ ok: boolean; message?: string }>
  updateDownload(): Promise<{ ok: boolean; message?: string }>
  updateInstall(): Promise<{ ok: boolean; message?: string }>
  onDownloadsUpdate(cb: (tasks: DownloadTask[]) => void): () => void
  onBridgePrefill(cb: (data: { url: string; netdisk: string }) => void): () => void
  onUpdateAvailable(cb: (data: { latest: string; current: string; url: string; name?: string; publishedAt?: string }) => void): () => void
  onUpdateState(cb: (data: UpdateState) => void): () => void
}

declare global {
  interface Window {
    panbox: PanboxAPI
  }
}

export const api: PanboxAPI =
  typeof window !== 'undefined' && window.panbox
    ? window.panbox
    : (new Proxy({}, {
        get() {
          return async () => {
            throw new Error('未检测到 Electron 桥接（preload 未加载）。请通过 npm start 启动桌面应用。')
          }
        },
      }) as PanboxAPI)

export function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(2)} ${units[i]}`
}

export function formatSpeed(bytesPerSec?: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '—'
  return `${formatSize(bytesPerSec)}/s`
}

export function formatEta(remaining: number, speed: number): string {
  if (!speed || speed <= 0 || remaining <= 0) return '—'
  const s = Math.round(remaining / speed)
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`
}
