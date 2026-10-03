import siteTable from '../electron/parsers/sites.json'

/* ------------------------------------------------------------------ */
/* 站点表                                                              */
/* ------------------------------------------------------------------ */

/* 站点表：一个站点「叫什么、能干什么」只写这一份（electron/parsers/sites.json），
 * 主进程与界面都读它。以前这套清单在本文件里有四份（名字、能登录、能手贴凭证、
 * 能配解析接口），主进程里还有两份（分享链接、认得出但没实现），加一个站要改六处。 */
type SiteInfo = {
  label: string
  share?: boolean
  supported?: boolean
  login?: boolean
  cookie?: boolean
  endpoint?: boolean
  seg?: boolean
}
const SITES = siteTable.sites as Record<string, SiteInfo>
const byFlag = (flag: keyof SiteInfo) =>
  Object.entries(SITES)
    .filter(([, v]) => v[flag])
    .map(([k]) => k)

const NETDISK_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(SITES).map(([k, v]) => [k, v.label]),
)

export const label = (k: string) => NETDISK_LABEL[k] ?? k

/** 能一键开登录窗抓凭证的网盘，同时也是「网盘账号」下拉的顺序 */
export const LOGIN_TARGETS = byFlag('login')
/** 只能手贴凭证的网盘 */
export const COOKIE_TARGETS = [...byFlag('login'), ...byFlag('cookie')]

/** 走自研分段引擎的网盘。百度不在此列 —— 它是账号级总量限速，加连接只会招 403。 */
export const SEG_TARGETS = byFlag('seg')

/** 「解析接口」可以勾选的网盘（顶层域名会被自动识别成这些代号） */
export const EP_NETDISKS = byFlag('endpoint')