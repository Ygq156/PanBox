export type Netdisk =
  | 'lanzou'
  | 'ilanzou'
  | 'quark'
  | 'uc'
  | 'baidu'
  | 'xunlei'
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
  /** 这条结果的直链来自用户自备的「解析接口」而不是内置解析 */
  viaEndpoint?: boolean
  /** 命中的接口名 */
  endpointName?: string
  /** 配了解析接口但调用失败时的原因（此时已退回内置解析） */
  endpointError?: string
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
  /** 哪个引擎在跑：'aria2' 或 'seg'（自研分段下载器） */
  engine?: 'aria2' | 'seg'
}

/**
 * 一条用户自备的「网盘解析接口」（解析站）。
 * 请求地址 / 请求体 / 请求头里可用占位符：{url} {pwd} {shareId} {netdisk}
 */
export interface ParseEndpoint {
  /** 稳定 id，UI 里用来做 key */
  id: string
  /** 展示名 */
  name: string
  /** 接口地址，如 https://example.com/api?url={url}&pwd={pwd} */
  url: string
  method?: 'GET' | 'POST'
  /** POST 时的请求体模板 */
  body?: string
  contentType?: string
  /** 额外请求头，JSON 字符串或对象 */
  headers?: Record<string, string> | string
  /** 取直链的字段路径（如 data.url）；留空则自动识别常见字段 */
  field?: string
  /** 下载直链时要带的请求头（JSON），留空则只用 User-Agent */
  dlHeaders?: Record<string, string> | string
  /** 适用的网盘；留空 = 全部（直链除外，需要在列表里显式勾选） */
  netdisks?: string[]
  enabled?: boolean
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
  /** 用户自备的网盘解析接口，优先于内置解析 */
  parseEndpoints: ParseEndpoint[]
  /**
   * 是否已勾选并同意「解析接口用户承诺」（只用它下载自己有权下载的内容、
   * 不用于规避网盘会员/限速机制、不转售他人资源）。
   * 有启用中的接口但这里为 false 时，设置页不允许保存。
   */
  endpointAck?: boolean
  /**
   * 自研分段下载器的连接数（按网盘）。
   * 夸克/UC 的 CDN 按每条连接发额度，aria2 只能开到 16 条，
   * 所以这两个网盘改用自研引擎开更多连接。百度不在此列（账号级限速，加连接会 403）。
   */
  segConnections?: Record<string, number>
  /**
   * 浏览器插件接收通道（见 electron/core/bridge.js）。
   * 只监听 127.0.0.1，投递任务要带 bridgeToken。
   */
  bridgeEnabled?: boolean
  bridgePort?: number
  bridgeToken?: string
}

export interface Aria2Status {
  running: boolean
  version?: string
  error?: string
}
