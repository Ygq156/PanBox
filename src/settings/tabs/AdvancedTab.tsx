import { Row, Section } from '../../ui/parts'

/* ------------------------------------------------------------------ */
/* 高级                                                                */
/* ------------------------------------------------------------------ */

/**
 * 「高级」页签：恢复默认设置（要二次确认）与插件文件夹入口。
 *
 * 纯展示：确认态和真正执行重置的动作都在设置弹窗那层（重置要把主进程回的新设置
 * 同步给上层），这里只显示当前该显示哪两个按钮。
 */
export interface AdvancedTabProps {
  /** 「确认恢复」那一步展开没有 */
  confirmReset: boolean
  /** 展开 / 收起二次确认 */
  onConfirmReset: (v: boolean) => void
  /** 真正执行恢复默认设置 */
  onReset: () => void
  /** 打开插件文件夹（打不开时由设置弹窗在错误行里说明） */
  onOpenExtFolder: () => void
}

export function AdvancedTab({
  confirmReset,
  onConfirmReset,
  onReset,
  onOpenExtFolder,
}: AdvancedTabProps) {
  return (
    <Section title="重置">
      <div className="danger">
        <div className="danger-title">恢复默认设置</div>
        <div className="danger-desc">
          把设置改回出厂值。<b>登录凭证和你自己填的解析接口会保留</b>，不必重新登录四个网盘。
        </div>
        {confirmReset ? (
          <div className="row">
            <button className="danger-btn" onClick={onReset}>
              确认恢复
            </button>
            <button onClick={() => onConfirmReset(false)}>取消</button>
          </div>
        ) : (
          <div className="row">
            <button onClick={() => onConfirmReset(true)}>恢复默认设置…</button>
          </div>
        )}
      </div>
      <Row
        title="浏览器插件版本"
        desc="更新程序后，请在 chrome://extensions 里点一次「重新加载」。"
      >
        <button onClick={onOpenExtFolder}>打开插件文件夹</button>
      </Row>
    </Section>
  )
}