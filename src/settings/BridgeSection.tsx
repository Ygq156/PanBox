import { useEffect, useState } from 'react'
import { api } from '../api'
import type { BridgeStatus } from '../api'
import { Field } from '../ui/parts'
import { errText } from '../ui/text'

/* ------------------------------------------------------------------ */
/* 浏览器插件                                                          */
/* ------------------------------------------------------------------ */

/** 插件把网页里的下载任务投给本机 PanBox。这段只负责三件事：通没通、目录在哪、配对令牌。 */
export function BridgeSection() {
  const [st, setSt] = useState<BridgeStatus | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      setSt(await api.bridgeStatus())
    } catch {
      /* 主进程没起这条通道时忽略 */
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      setMsg(await fn())
      await refresh()
    } catch (e) {
      setMsg(`出错了：${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const state = !st ? 'gray' : !st.enabled ? 'gray' : st.running ? 'ok' : 'err'
  const stateText = !st
    ? '读取中…'
    : !st.enabled
      ? '已关闭'
      : st.running
        ? `运行中 · ${st.host}:${st.port}`
        : `没有起来${st.error ? `：${st.error}` : ''}`

  return (
    <Field
      label="浏览器插件（在网页里直接下资源）"
      hint={
        <>
          安装：打开 <code>chrome://extensions</code>（Edge 是 <code>edge://extensions</code>）→ 开发者模式 →
          加载已解压的扩展程序 → 选「打开插件文件夹」里的目录；装好或更新后点一次「重新加载」。
        </>
      }
    >
      <div className="stack">
        <div className="stack-row">
          <span className={`badge ${state === 'ok' ? 'ok' : state === 'err' ? 'err' : 'gray'}`}>{stateText}</span>
          <span className="ep-hint">{st ? (st.added > 0 ? `已接收 ${st.added} 个任务` : '还没有收到过任务') : ''}</span>
        </div>

        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.bridgeOpenFolder()
                return r.ok ? `已打开插件文件夹：${r.dir}` : `打不开：${r.message || '未知原因'}`
              })
            }
          >
            打开插件文件夹
          </button>
          <button disabled={busy} onClick={() => run(async () => ((await api.bridgeStart()) ? '已重新开始监听' : '没起来'))}>
            重新检测
          </button>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => ((await api.bridgeNewToken()) ? '已换新令牌，请到插件「高级」里重新填一次' : '没换成'))
            }
          >
            重新配对
          </button>
        </div>

        {st && (
          <div className="stack-row">
            <span className="ep-hint">配对令牌</span>
            <input type="text" readOnly value={st.token} onFocus={(e) => e.currentTarget.select()} />
          </div>
        )}

        {!st?.extExists && <div className="hint err">插件文件夹里没找到 manifest.json，可能是安装不完整。</div>}
        {msg && <div className="hint ok">{msg}</div>}
      </div>
    </Field>
  )
}