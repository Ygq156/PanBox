import { useCallback, useEffect, useState } from 'react'
import { api, formatSize } from '../api'
import type { TrashItem } from '../api'
import { errText } from '../ui/text'

/* ------------------------------------------------------------------ */
/* 回收站：删掉的下载文件先挪进这里，可以还原                                 */
/* ------------------------------------------------------------------ */

export function TrashModal({ retentionDays, onClose }: { retentionDays: number; onClose: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems(await api.trashList())
    } catch (e) {
      setMsg(`读取失败：${errText(e)}`)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      setMsg(await fn())
      await load()
    } catch (e) {
      setMsg(`出错了：${errText(e)}`)
    }
    setBusy(false)
  }

  const total = (items || []).reduce((n, it) => n + (it.size || 0), 0)

  return (
    <div className="mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal trash">
        <h2>
          回收站
          <button className="x" onClick={onClose} title="关闭">
            ✕
          </button>
        </h2>

        <div className="trash-body">
          {items === null ? (
            <div className="empty">读取中…</div>
          ) : items.length === 0 ? (
            <div className="empty">
              回收站是空的。
              <br />
              在下载队列里删掉的文件会先放到这里。
            </div>
          ) : (
            items.map((it) => (
              <div className="trash-row" key={it.id}>
                <div className="tcell">
                  <div className="tname" title={it.from}>
                    {it.name}
                  </div>
                  <div className="tsub">
                    {formatSize(it.size)} · {new Date(it.at).toLocaleString()}
                    {it.leftDays === null ? '' : ` · ${it.leftDays} 天后自动清理`}
                  </div>
                </div>
                <button
                  className="tiny"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await api.trashRestore(it.id)
                      return r.ok ? `已还原到 ${r.path || '原位置'}` : `还原失败：${r.message || '未知原因'}`
                    })
                  }
                >
                  还原
                </button>
                <button
                  className="tiny del"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api.trashDelete(it.id)
                      return `已彻底删除「${it.name}」`
                    })
                  }
                >
                  彻底删除
                </button>
              </div>
            ))
          )}
        </div>

        <div className="trash-foot">
          <span className="trash-count">{items ? `${items.length} 个文件 · ${formatSize(total)}` : ''}</span>
          <span className="trash-count">{retentionDays > 0 ? `超过 ${retentionDays} 天自动清理` : '不自动清理'}</span>
          {msg && <span className="trash-warn">{msg}</span>}
          <span className="grow" />
          <button
            className="tiny"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.trashOpenDir()
                /* 打不开就如实说（比如目录被删了、系统没有关联程序），别假装打开了 */
                if (!r.ok) throw new Error(r.message || '没能打开目录')
                return `已打开 ${r.dir}`
              })
            }
          >
            打开目录
          </button>
          <button
            className="tiny del"
            disabled={busy || !items || items.length === 0}
            onClick={() =>
              run(async () => {
                const n = await api.trashEmpty()
                return `已彻底删除 ${n} 个文件`
              })
            }
          >
            清空
          </button>
        </div>
      </div>
    </div>
  )
}