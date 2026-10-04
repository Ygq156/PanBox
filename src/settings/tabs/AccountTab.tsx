import { COOKIE_TARGETS, LOGIN_TARGETS, label } from '../../sites'
import type { Settings } from '../../types'
import { Row, Section } from '../../ui/parts'

/* ------------------------------------------------------------------ */
/* 网盘账号                                                            */
/* ------------------------------------------------------------------ */

/* 主进程把凭证打码后才发到界面（防止页面脚本读到原文）。这个串表示「本机已有一份，
 * 界面不回显」——保存时原样传回去，主进程认这个串就保留磁盘上那份。 */
export const COOKIE_MASK = '__PANBOX_KEEP__'

/**
 * 「网盘账号」页签：各家的登录状态 + 当前这一家的凭证输入框。
 *
 * 纯展示：登录、退出登录、切换当前网盘都由设置弹窗那层执行（它们要落盘 + 刷新
 * 主进程发回来的脱敏副本），这里只把用户点了什么交回去。
 */
export interface AccountTabProps {
  /** 当前编辑中的那份设置（只读它的 cookies） */
  s: Settings
  /** 当前正在编辑凭证的那个网盘 */
  cookieKey: string
  /** 登录窗口开着的时候，按钮不能再点 */
  loginBusy: boolean
  /** 上一次登录 / 退出登录的结果说明 */
  loginMsg: string
  /** 编辑框里的值是不是打码串（是的话不回显，只留占位提示） */
  maskedCookie: boolean
  /** 磁盘上那份还在不在：清空输入框时靠它决定退回打码串还是真的清空 */
  storedMasked: boolean
  /** 文本框这类改动：只改编辑中的那份，点「保存」才落盘 */
  onPatch: (p: Partial<Settings>) => void
  /** 换当前网盘 */
  onCookieKey: (k: string) => void
  /** 打开登录窗口（主进程负责抓凭证并落盘） */
  onLogin: () => void
  /** 退出登录：清浏览器分区，同时清掉配置里那份 */
  onLogout: () => void
}

export function AccountTab({
  s,
  cookieKey,
  loginBusy,
  loginMsg,
  maskedCookie,
  storedMasked,
  onPatch,
  onCookieKey,
  onLogin,
  onLogout,
}: AccountTabProps) {
  return (
    <Section title="网盘账号">
      {/* 各家各自的状态摆在一行里，不用来回切下拉才知道谁登过 */}
      <div className="acct-chips">
        {LOGIN_TARGETS.map((k) => {
          const on = !!(s.cookies[k] || '').trim()
          return (
            <button
              key={k}
              className={`acct-chip${cookieKey === k ? ' on' : ''}`}
              onClick={() => onCookieKey(k)}
              title={on ? `${label(k)}：本机已保存凭证` : `${label(k)}：还没有凭证，解析会走游客身份`}
            >
              <i className={on ? 'dot ok' : 'dot'} />
              {label(k)}
              <span className="dim">{on ? '已保存' : '未登录'}</span>
            </button>
          )
        })}
      </div>

      <Row stack title="账号" desc="凭证只存在这台电脑上。">
        <div className="acct-form">
          <div className="row">
            <select className="select" value={cookieKey} onChange={(e) => onCookieKey(e.target.value)}>
              {COOKIE_TARGETS.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
            {LOGIN_TARGETS.includes(cookieKey) && (
              <>
                <button disabled={loginBusy} onClick={onLogin}>
                  {loginBusy ? '请在弹出的窗口里登录…' : `登录${label(cookieKey)}`}
                </button>
                <button onClick={onLogout}>退出登录</button>
              </>
            )}
          </div>
          <input
            type="text"
            placeholder={maskedCookie ? '已保存，粘贴新凭证可换账号' : '粘贴凭证'}
            value={maskedCookie ? '' : s.cookies[cookieKey] ?? ''}
            onChange={(e) => {
              const v = e.target.value
              /* 清空输入框永远不等于「删凭证」：磁盘上本来有一份就退回那份（打码串），
               * 只有本来就什么都没有（或点「退出登录」）才会真的变成空。
               * 不然用户打一半反悔、或者手滑全选删掉，就得重新登录一遍。 */
              const val = v === '' ? (storedMasked ? COOKIE_MASK : '') : v
              onPatch({ cookies: { ...s.cookies, [cookieKey]: val } })
            }}
          />
          {loginMsg && <div className="desc">{loginMsg}</div>}
        </div>
      </Row>
    </Section>
  )
}