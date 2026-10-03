import { api, formatSpeed } from '../api'
import type { Aria2Status } from '../types'

/* ------------------------------------------------------------------ */
/* 顶栏                                                                */
/* ------------------------------------------------------------------ */

/**
 * 主界面顶栏：引擎状态、队列速度、版本号、重连与设置入口。
 *
 * 纯展示：引擎状态、队列统计、版本号都由 App 传进来；这里只有「重新拉起引擎」
 * 会自己调 api（模块级 import，不是 App 的状态）。
 */
export interface HeaderBarProps {
  /** aria2 引擎在不在 */
  aria2Running: boolean
  /** 引擎版本（没连上时是空） */
  aria2Version?: string
  /** 正在下载的任务数（>0 时状态行里追加一段速度） */
  activeCount: number
  /** 所有下载中任务的速度合计（字节/秒） */
  speed: number
  /** 程序版本（空串就不显示那一格） */
  ver: string
  /** 有未读的新版本（设置按钮上挂一个小点） */
  hasNewVer: boolean
  /** 重连引擎的结果要写回 App 的引擎状态 */
  onAria2: (v: Aria2Status) => void
  /** 打开设置弹窗 */
  onOpenSettings: () => void
}

export function HeaderBar({
  aria2Running,
  aria2Version,
  activeCount,
  speed,
  ver,
  hasNewVer,
  onAria2,
  onOpenSettings,
}: HeaderBarProps) {
  return (
    <div className="header">
      <div className="logo">
        Pan<span>Box</span>
      </div>
      <div className={`dot${aria2Running ? ' on' : ''}`} />
      <div className="status">
        {aria2Running ? `aria2 已就绪 ${aria2Version ?? ''}` : 'aria2 未连接'}
        {activeCount > 0 ? ` · ${activeCount} 个任务下载中 · ${formatSpeed(speed)}` : ''}
      </div>
      {/* 版本号常驻标题栏：报障时一眼能说清装的是哪一版，不用再猜 */}
      {ver ? <div className="ver" title="程序版本">v{ver}</div> : null}
      {!aria2Running && (
        <button
          className="ghost tiny"
          title="重新拉起 aria2 下载引擎"
          onClick={async () => onAria2(await api.restartAria2())}
        >
          重连引擎
        </button>
      )}
      <div className="grow" />
      <button className="ghost" onClick={onOpenSettings}>
        ⚙ 设置
        {hasNewVer ? <span className="navdot" /> : null}
      </button>
    </div>
  )
}