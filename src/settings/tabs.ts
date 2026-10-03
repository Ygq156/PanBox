/* ------------------------------------------------------------------ */
/* 设置页签的模块级常量                                                */
/* ------------------------------------------------------------------ */

/** 分类。组数与每屏条目数是照调研（lx-music / shadcn-admin / Motrix）定的：一屏放得下一组。 */
export const SET_TABS = [
  { id: 'general', name: '通用' },
  { id: 'download', name: '下载' },
  { id: 'net', name: '网络' },
  { id: 'account', name: '网盘账号' },
  { id: 'ext', name: '浏览器插件' },
  { id: 'update', name: '更新' },
  { id: 'endpoint', name: '解析接口' },
  { id: 'adv', name: '高级' },
] as const

export type TabId = (typeof SET_TABS)[number]['id']

/** 回收站保留期限的可选档位（天）。0 = 永不自动删；跟主进程 settings.js 的 0~3650 取值域一致。 */
export const RETENTION_CHOICES = [0, 7, 14, 30, 60, 90]