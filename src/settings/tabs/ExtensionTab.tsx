import { BridgeSection } from '../BridgeSection'
import { Section } from '../../ui/parts'

/* ------------------------------------------------------------------ */
/* 浏览器插件                                                          */
/* ------------------------------------------------------------------ */

/**
 * 「浏览器插件」页签：只是给接收通道套一层标题。
 *
 * 这一页不需要任何 props —— 通道开没开、端口是多少由 BridgeSection 自己问主进程。
 */
export function ExtensionTab() {
  return (
    <Section title="浏览器插件接收通道">
      <BridgeSection />
    </Section>
  )
}