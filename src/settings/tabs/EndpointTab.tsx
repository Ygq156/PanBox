import type { Settings } from '../../types'
import { Section } from '../../ui/parts'
import { EndpointSection } from '../EndpointSection'

/* ------------------------------------------------------------------ */
/* 解析接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 「解析接口」页签：用户自备的解析接口列表。
 *
 * 纯展示：接口列表和「我知道自己在做什么」的确认都只是编辑中的设置项，
 * 改完点底部的「保存」才落盘，所以这里只交回 onPatch。
 */
export interface EndpointTabProps {
  /** 当前编辑中的那份设置（读 parseEndpoints / endpointAck） */
  s: Settings
  /** 文本框这类改动：只改编辑中的那份，点「保存」才落盘 */
  onPatch: (p: Partial<Settings>) => void
}

export function EndpointTab({ s, onPatch }: EndpointTabProps) {
  return (
    <Section title="用户自备的解析接口">
      <EndpointSection
        list={s.parseEndpoints || []}
        onChange={(next) => onPatch({ parseEndpoints: next })}
        ack={!!s.endpointAck}
        onAck={(v) => onPatch({ endpointAck: v })}
      />
    </Section>
  )
}