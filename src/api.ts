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

export interface PanboxAPI {
  parseShare(p: ParsePayload): Promise<ParseResponse>
  listDownloads(): Promise<DownloadTask[]>
  addDownloads(p: AddPayload): Promise<{ ok: boolean; added: string[]; errors: string[] }>
  pauseTask(gid: string): Promise<boolean>
  resumeTask(gid: string): Promise<boolean>
  removeTask(gid: string, deleteFile?: boolean): Promise<boolean>
  pauseAll(): Promise<boolean>
  resumeAll(): Promise<boolean>
  getSettings(): Promise<Settings>
  setSettings(s: Partial<Settings>): Promise<Settings>
  pickDir(): Promise<string | null>
  openPath(p: string): Promise<string>
  aria2Status(): Promise<Aria2Status>
  restartAria2(): Promise<Aria2Status>
  openLogin(netdisk: string): Promise<{ ok: boolean; cookie?: string; count?: number; loggedIn?: boolean; message?: string }>
  clearLogin(netdisk: string): Promise<boolean>
  onDownloadsUpdate(cb: (tasks: DownloadTask[]) => void): () => void
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
