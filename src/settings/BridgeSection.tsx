import { useEffect, useState } from 'react'
import { api } from '../api'
import type { BridgeStatus, PairCode } from '../api'
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
  const [pair, setPair] = useState<PairCode | null>(null)
  const [left, setLeft] = useState(0)

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

  /* 配对码只活 120 秒，界面得自己走完这段时间 —— 否则用户会对着一个已经作废的码反复输 */
  useEffect(() => {
    if (!pair) return
    const tick = () => setLeft(Math.max(0, Math.ceil((pair.expiresAt - Date.now()) / 1000)))
    tick()
    const h = window.setInterval(tick, 1000)
    return () => window.clearInterval(h)
  }, [pair])

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
              run(async () => {
                const r = await api.bridgeNewPairCode()
                setPair(r)
                return '配对码已生成，在插件里填这 6 位数字。'
              })
            }
          >
            生成配对码
          </button>
          <button
            disabled={busy}
            onClick={() =>
              run(async () =>
                (await api.bridgeNewToken())
                  ? '已换新令牌，插件要重新配对：点「生成配对码」，把码填进插件。'
                  : '没换成'
              )
            }
          >
            重新配对
          </button>
        </div>

        {pair && (
          <div className="stack">
            <div className="stack-row">
              <span className="ep-hint">配对码{left > 0 ? `（剩余 ${left} 秒）` : '（已过期）'}</span>
              <span className="pair-code">{pair.code}</span>
            </div>
            <div className="ep-hint">
              {left > 0
                ? '在浏览器里打开 PanBox 插件，把这 6 位数字填进「配对码」，再点「配对」。'
                : '这个码不能再用了，点「生成配对码」再来一个。'}
            </div>
          </div>
        )}

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