export type Netdisk =
  | 'lanzou'
  | 'ilanzou'
  | 'quark'
  | 'uc'
  | 'baidu'
  | 'aliyun'
  | '123pan'
  | 'direct'
  | 'unknown'

export interface ParsedFile {
  /** 解析器内部唯一 id */
  id: string
  name: string
  size: number
  isDir: boolean
  /** 相对于分享根的路径，例如 "电影/2024/" */
  dir: string
  /** 直链。可能在解析阶段就拿到，也可能需要点下载时才惰性解析 */
  url?: string
  /** 下载该直链时必须附带的请求头（Referer / UA / Cookie 等） */
  headers?: Record<string, string>
}

export interface ParseResult {
  ok: boolean
  netdisk: Netdisk
  shareId?: string
  title?: string
  /** 扁平化的可下载文件列表 */
  files: ParsedFile[]
  /** 主进程里的解析会话 id：下载时用它换直链，避免重复解析 */
  sessionId?: string
  /** 这条结果来自哪个分享链接 */
  source?: string
  message?: string
  needPassword?: boolean
  needCookie?: boolean
  /** 解析耗时（毫秒） */
  elapsed?: number
}

export interface ParseResponse {
  results: ParseResult[]
}

export type TaskStatus =
  | 'active'
  | 'waiting'
  | 'paused'
  | 'complete'
  | 'error'
  | 'removed'

export interface DownloadTask {
  gid: string
  name: string
  netdisk: Netdisk
  /** 分享链接来源，便于溯源 */
  source?: string
  dir: string
  total: number
  completed: number
  /** 字节/秒 */
  speed: number
  status: TaskStatus
  errorCode?: string
  errorMessage?: string
  connections?: number
  filesize?: number
}

export interface Settings {
  downloadDir: string
  maxConcurrent: number
  split: number
  maxConnectionPerServer: number
  minSplitSize: string
  userAgent: string
  /** netdisk -> 用户自备的 Cookie 字符串 */
  cookies: Record<string, string>
  aria2Port: number
  /** 完成后是否自动打开下载目录 */
  openFolderWhenDone: boolean
}

export interface Aria2Status {
  running: boolean
  version?: string
  error?: string
}
