import { api } from '../../api'
import type { AppInfo, UpdateInfo, UpdateState } from '../../api'
import type { Settings } from '../../types'
import { Row, Section, Switch } from '../../ui/parts'

/* ------------------------------------------------------------------ */
/* 更新                                                                */
/* ------------------------------------------------------------------ */

/** 「更新」页签自己那一套检查结果（安装版走自更新状态 auto，便携版走这个） */
export type UpdateCheckState = {
  state: 'idle' | 'checking' | 'latest' | 'new' | 'error'
  data?: UpdateInfo
}

/**
 * 「更新」页签：版本信息、检查 / 下载 / 安装按钮、自动检查开关。
 *
 * 纯展示：两条更新通道的状态都由设置弹窗那层维护（主进程会推状态过来），
 * 这里只根据状态决定显示哪一段文案；只有「打开某页」这类纯动作自己调 api。
 */
export interface UpdateTabProps {
  /** 当前编辑中的那份设置（读 autoCheckUpdate） */
  s: Settings
  /** 逐行的保存失败原因 */
  rowErr: Record<string, string>
  /** 程序版本与安装方式（开发模式 / 便携版 / 安装版）；还没读到是 null */
  info: AppInfo | null
  /** 便携版那条通道的检查结果 */
  upd: UpdateCheckState
  /** 安装版就地更新的状态（主进程推过来的） */
  auto: UpdateState
  /** 「检查更新」按钮的忙碌态 */
  checking: boolean
  /** 安装版才能就地更新：决定显示哪一条通道的内容 */
  canAutoUpdate: boolean
  /** 开关这类改动：立刻落盘，失败会退回改前的值 */
  onInstant: (p: Partial<Settings>, key: string) => void
  /** 检查一次更新 */
  onCheck: () => void
  /** 下载更新包（失败时由设置弹窗把状态改成出错） */
  onDownloadUpdate: () => void
  /** 打开插件文件夹（打不开时由设置弹窗在错误行里说明） */
  onOpenExtFolder: () => void
}

export function UpdateTab({
  s,
  rowErr,
  info,
  upd,
  auto,
  checking,
  canAutoUpdate,
  onInstant,
  onCheck,
  onDownloadUpdate,
  onOpenExtFolder,
}: UpdateTabProps) {
  return (
    <>
      <Section title="版本">
        <Row
          title={`PanBox ${info ? info.version : '…'}`}
          desc={info ? (info.packaged ? (info.portable ? '便携版' : '安装版') : '开发模式（npm start）') : '读取中…'}
        >
          <button disabled={checking} onClick={onCheck}>
            {checking ? '正在检查…' : '检查更新'}
          </button>
        </Row>
        <div className="updbox" aria-live="polite">
          {canAutoUpdate ? (
            <>
              {auto.state === 'idle' && <div className="desc">点上面的「检查更新」查一次。</div>}
              {auto.state === 'checking' && <div className="desc">正在检查…</div>}
              {auto.state === 'latest' && <div className="desc">已是最新版本（{auto.version || (info ? info.version : '')}）。</div>}
              {auto.state === 'available' && (
                <>
                  <div className="upd-title">发现新版本 {auto.version}</div>
                  <div className="desc">装好后程序文件就地替换，设置、任务和登录状态都保留。</div>
                </>
              )}
              {auto.state === 'downloading' && (
                <>
                  <div className="desc">正在下载 {auto.percent ? auto.percent.toFixed(0) : 0}%</div>
                  <div className="bar">
                    <i style={{ transform: `scaleX(${(auto.percent || 0) / 100})` }} />
                  </div>
                </>
              )}
              {auto.state === 'downloaded' && <div className="desc">下载完成，点「重启并安装」。</div>}
              {auto.state === 'error' && <div className="desc">更新失败：{auto.message || '未知原因'}</div>}
              <div className="row">
                {(auto.state === 'available' || auto.state === 'downloading' || auto.state === 'error') && (
                  <button
                    className="primary"
                    disabled={auto.state === 'downloading'}
                    onClick={onDownloadUpdate}
                  >
                    {auto.state === 'downloading' ? '正在下载' : '下载更新'}
                  </button>
                )}
                {auto.state === 'downloaded' && (
                  <button className="primary" onClick={() => api.updateInstall()}>
                    重启并安装
                  </button>
                )}
                <button onClick={() => api.openRelease('https://github.com/Ygq156/PanBox/releases/latest')}>打开发布页</button>
              </div>
            </>
          ) : (
            <>
              {upd.state === 'idle' && <div className="desc">点上面的「检查更新」查一次。</div>}
              {upd.state === 'checking' && <div className="desc">正在检查…</div>}
              {upd.state === 'latest' && (
                <div className="desc">已是最新版本（{upd.data?.latest ?? upd.data?.current}）。</div>
              )}
              {upd.state === 'new' && (
                <>
                  <div className="upd-title">发现新版本 {upd.data?.latest}</div>
                  <div className="desc">便携版请下载新包替换。</div>
                  <div className="row">
                    <button className="primary" onClick={() => api.openRelease(upd.data?.url || '')}>
                      打开发布页
                    </button>
                  </div>
                </>
              )}
              {upd.state === 'error' && (
                <>
                  <div className="upd-title err">检查失败</div>
                  <div className="desc">可能是访问不到 GitHub（{upd.data?.message || '网络不通'}）。</div>
                  <div className="row">
                    <button onClick={onCheck}>重试</button>
                    <button onClick={() => api.openRelease('https://github.com/Ygq156/PanBox/releases/latest')}>
                      打开发布页
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <Row
          title="自动检查更新"
          err={rowErr.autoCheckUpdate}
        >
          <Switch
            checked={s.autoCheckUpdate !== false}
            onChange={(v) => onInstant({ autoCheckUpdate: v }, 'autoCheckUpdate')}
          />
        </Row>
      </Section>
      <Section title="链接">
        <Row title="项目主页 / 源码">
          <div className="row">
            <button onClick={() => api.openRelease('https://github.com/Ygq156/PanBox')}>打开 GitHub</button>
            <button onClick={onOpenExtFolder}>插件文件夹</button>
          </div>
        </Row>
      </Section>
    </>
  )
}