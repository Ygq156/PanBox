import { api } from '../../api'
import type { Settings } from '../../types'
import { Row, Section, Switch } from '../../ui/parts'
import { RETENTION_CHOICES } from '../tabs'

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

/**
 * 「通用」页签：启动 / 关闭 / 下载位置 / 回收站。
 *
 * 纯展示：开关与数字的即时保存、文本框的暂存都由设置弹窗那层拿着，
 * 这里只把「用户改了什么」交回去（onInstant / onPatch），自己不存任何状态。
 */
export interface GeneralTabProps {
  /** 当前编辑中的那份设置 */
  s: Settings
  /** 「开机自启动」这一行的补充说明（开发模式 / 便携版才需要解释） */
  autoStartDesc?: string
  /** 逐行的保存失败原因（主进程校验不过时挂在这一行上） */
  rowErr: Record<string, string>
  /** 开关 / 下拉这类改动：立刻落盘，失败会退回改前的值 */
  onInstant: (p: Partial<Settings>, key: string) => void
  /** 文本框这类改动：只改编辑中的那份，点「保存」才落盘 */
  onPatch: (p: Partial<Settings>) => void
  /** 开机自启动要真写系统登录项，走单独的通道 */
  onToggleAutoStart: (on: boolean) => void
}

export function GeneralTab({
  s,
  autoStartDesc,
  rowErr,
  onInstant,
  onPatch,
  onToggleAutoStart,
}: GeneralTabProps) {
  return (
    <>
      <Section title="启动">
        <Row title="开机自启动" desc={autoStartDesc} err={rowErr.autoStart}>
          <Switch checked={!!s.autoStart} onChange={onToggleAutoStart} />
        </Row>
        {!!s.autoStart && (
          <Row
            indent
            title="启动时显示主窗口"
          >
            <Switch
              checked={!!s.startupShowWindow}
              onChange={(v) => onInstant({ startupShowWindow: v }, 'startupShowWindow')}
            />
          </Row>
        )}
      </Section>
      <Section title="关闭">
        <Row
          title="显示托盘图标"
          desc={
            s.trayIcon === false
              ? '关掉后没有托盘入口，关闭窗口会直接退出。'
              : '托盘图标可以叫回窗口、打开下载目录、退出程序。'
          }
          err={rowErr.trayIcon}
        >
          <Switch
            checked={s.trayIcon !== false}
            onChange={(v) => onInstant({ trayIcon: v }, 'trayIcon')}
          />
        </Row>
        <Row
          title="关闭窗口后留在后台下载"
          desc={s.trayIcon === false ? undefined : '要完全退出：托盘图标右键 →「退出」。'}
          err={rowErr.closeToTray}
        >
          <Switch
            checked={s.closeToTray !== false}
            disabled={s.trayIcon === false}
            onChange={(v) => onInstant({ closeToTray: v }, 'closeToTray')}
          />
        </Row>
        <Row title="下载完成后打开下载目录">
          <Switch
            checked={!!s.openFolderWhenDone}
            onChange={(v) => onInstant({ openFolderWhenDone: v }, 'openFolderWhenDone')}
          />
        </Row>
      </Section>
      <Section title="下载位置">
        <Row stack title="下载目录">
          <div className="row">
            <input
              type="text"
              value={s.downloadDir}
              onChange={(e) => onPatch({ downloadDir: e.target.value })}
            />
            <button
              onClick={async () => {
                const dir = await api.pickDir()
                if (dir) onPatch({ downloadDir: dir })
              }}
            >
              选择…
            </button>
          </div>
        </Row>
      </Section>
      <Section title="回收站">
        <Row stack title="回收站目录" err={rowErr.trashDir}>
          <div className="row">
            <input
              type="text"
              value={s.trashDir || ''}
              onChange={(e) => onPatch({ trashDir: e.target.value })}
            />
            <button
              onClick={async () => {
                const dir = await api.pickDir('trash')
                if (dir) onPatch({ trashDir: dir })
              }}
            >
              选择…
            </button>
          </div>
        </Row>
        <Row
          title="自动清理"
          desc="超过期限的文件从回收站里彻底删除。"
          err={rowErr.trashRetentionDays}
        >
          <select
            className="select"
            value={String(RETENTION_CHOICES.includes(Number(s.trashRetentionDays)) ? Number(s.trashRetentionDays) : 30)}
            onChange={(e) => onInstant({ trashRetentionDays: Number(e.target.value) }, 'trashRetentionDays')}
          >
            {RETENTION_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d === 0 ? '永不' : `${d} 天`}
              </option>
            ))}
          </select>
        </Row>
      </Section>
    </>
  )
}