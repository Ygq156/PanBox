import { SEG_TARGETS, label } from '../../sites'
import type { Settings } from '../../types'
import { NumBox, NumberRow, Row, Section } from '../../ui/parts'

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

/**
 * 「下载」页签：aria2 的几个并发参数 + 分段引擎每个网盘的连接数。
 *
 * 纯展示：数字框只在失焦 / 回车时把结果交回去（onInstant 立刻落盘），
 * 文本框交回 onPatch 暂存。这里没有状态、没有副作用。
 */
export interface DownloadTabProps {
  /** 当前编辑中的那份设置 */
  s: Settings
  /** 逐行的保存失败原因 */
  rowErr: Record<string, string>
  /** 数字 / 开关这类改动：立刻落盘，失败会退回改前的值 */
  onInstant: (p: Partial<Settings>, key: string) => void
  /** 文本框这类改动：只改编辑中的那份，点「保存」才落盘 */
  onPatch: (p: Partial<Settings>) => void
}

export function DownloadTab({ s, rowErr, onInstant, onPatch }: DownloadTabProps) {
  return (
    <>
      <Section title="aria2（百度 / 迅雷 / 蓝奏云走这条）">
        <NumberRow
          title="同时下载任务数"
          value={s.maxConcurrent}
          min={1}
          max={20}
          onCommit={(n) => onInstant({ maxConcurrent: n }, 'maxConcurrent')}
          err={rowErr.maxConcurrent}
        />
        <NumberRow
          title="单任务分片数（split）"
          value={s.split}
          min={1}
          max={64}
          onCommit={(n) => onInstant({ split: n }, 'split')}
          err={rowErr.split}
        />
        <NumberRow
          title="每服务器最大连接数"
          value={s.maxConnectionPerServer}
          min={1}
          max={64}
          onCommit={(n) => onInstant({ maxConnectionPerServer: n }, 'maxConnectionPerServer')}
          err={rowErr.maxConnectionPerServer}
        />
        <Row stack title="最小分片大小">
          <input
            type="text"
            placeholder="1M"
            value={s.minSplitSize}
            onChange={(e) => onPatch({ minSplitSize: e.target.value })}
          />
        </Row>
      </Section>

      <Section title="分段引擎（夸克 / UC / 直链走这条）">
        <Row
          stack
          title="每个网盘的连接数"
          desc="填 0 就改用 aria2。"
          err={rowErr.segConnections}
        >
          <div className="ep-netdisks">
            {SEG_TARGETS.map((k) => (
              <span key={k} className="seg-conn">
                <span className="ep-hint">{label(k)}</span>
                <NumBox
                  value={s.segConnections?.[k] ?? 0}
                  min={0}
                  max={256}
                  onCommit={(n) =>
                    onInstant(
                      { segConnections: { ...(s.segConnections || {}), [k]: n } },
                      'segConnections',
                    )
                  }
                />
              </span>
            ))}
          </div>
        </Row>
        <NumberRow
          title="百度网盘并发（默认 1）"
          desc="超级会员可调到 4~8；速度变成 0 就是被限了，调回 1。"
          value={s.baiduConnections ?? 1}
          min={1}
          max={16}
          onCommit={(n) => onInstant({ baiduConnections: n }, 'baiduConnections')}
          err={rowErr.baiduConnections}
        />
      </Section>
    </>
  )
}