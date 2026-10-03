import type { Settings } from '../../types'
import { NumberRow, Row, Section, Switch } from '../../ui/parts'
import { ProxySection } from '../ProxySection'

/* ------------------------------------------------------------------ */
/* 网络                                                                */
/* ------------------------------------------------------------------ */

/**
 * 「网络」页签：出口代理 / 证书 / 其它。
 *
 * 代理那一块自己会去问主进程当前实际用的是哪条路（ProxySection），
 * 所以这里把整份设置原样转发给它；本页签自己不存状态、不做副作用。
 */
export interface NetworkTabProps {
  /** 当前编辑中的那份设置（原样转给 ProxySection） */
  s: Settings
  /** 逐行的保存失败原因 */
  rowErr: Record<string, string>
  /** 开关 / 数字这类改动：立刻落盘，失败会退回改前的值 */
  onInstant: (p: Partial<Settings>, key: string) => void
  /** 文本框这类改动：只改编辑中的那份，点「保存」才落盘 */
  onPatch: (p: Partial<Settings>) => void
}

export function NetworkTab({ s, rowErr, onInstant, onPatch }: NetworkTabProps) {
  return (
    <>
      <Section title="代理">
        <ProxySection s={s} patch={onPatch} />
      </Section>
      <Section title="证书">
        <Row
          title="忽略证书错误"
          desc="打开后不校验证书，只在必要时用。"
          err={rowErr.ignoreCert}
        >
          <Switch checked={!!s.ignoreCert} onChange={(v) => onInstant({ ignoreCert: v }, 'ignoreCert')} />
        </Row>
      </Section>
      <Section title="其它">
        <Row stack title="自定义 User-Agent">
          <input type="text" value={s.userAgent} onChange={(e) => onPatch({ userAgent: e.target.value })} />
        </Row>
        <NumberRow
          title="aria2 RPC 端口"
          value={s.aria2Port}
          min={1024}
          max={65535}
          onCommit={(n) => onInstant({ aria2Port: n }, 'aria2Port')}
          err={rowErr.aria2Port}
        />
      </Section>
    </>
  )
}