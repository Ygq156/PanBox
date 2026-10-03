import type { DownloadTask } from './types'

/* ------------------------------------------------------------------ */
/* 队列整表的合并                                                      */
/* ------------------------------------------------------------------ */

/* 下载中主进程每 800ms 推一次整表，推来的是全新对象。队列行（TaskRow）是 memo 的，
 * 但它按引用比 `t`：每次都是新对象 → 每一行都跟着重渲染一遍，等于没 memo。
 * 这里在入口处把「字段没变的那几行」沿用上一次那个对象，引用没变，那一行才真的不动。
 * 字段全是标量，浅比较就够，也不需要在两处维护字段白名单。 */

/** 两条任务在所有字段上都一样？ */
function sameTask(a: DownloadTask, b: DownloadTask): boolean {
  if (a === b) return true
  const ka = Object.keys(a) as (keyof DownloadTask)[]
  const kb = Object.keys(b) as (keyof DownloadTask)[]
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/** 用新来的整表更新旧表：没变的行沿用旧对象；整表没变时连数组也原样返回 */
export function mergeTasks(prev: DownloadTask[], next: DownloadTask[]): DownloadTask[] {
  const was = new Map(prev.map((t) => [t.gid, t]))
  let changed = prev.length !== next.length
  const out = next.map((t) => {
    const old = was.get(t.gid)
    if (old && sameTask(old, t)) return old
    changed = true
    return t
  })
  return changed ? out : prev
}