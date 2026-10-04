'use strict'

/**
 * 「用户已经把这条下载取消了」的墓碑。
 *
 * 为什么需要它：一条任务从「界面上的行」到「真正交给引擎」之间有一段很长的路，
 * 而这条路上的每一步都可能被用户中途取消 ——
 *   - 分段引擎是先登记任务、后探测地址（探测最坏要 2~3 分钟，见 segmentDownloader
 *     的 `_prepare`），所以探测期间队列里已经有一行了，用户随时能删；
 *   - 探测失败时 addResolved 会**回退到 aria2 重新入列**（换一个 gid），
 *     readdTask（换直链）也是「删掉旧的、换一个新的 gid 重新加」。
 * 这两处都发生在用户点 ✕ 之后，如果没有一道「这条已经被取消了」的检查，
 * 下载就会自己冒回来 —— 用户看到的是「我明明删了，过一会儿它又自己开始下了」。
 *
 * 为什么不按 gid 记：取消发生时那条 gid 马上就要消失了（回退会换新 gid），
 * 而**身份**（下载目录 + 最终文件名）在交引擎之前就已经定稿，两处完全一致。
 * 所以这里按身份记，并带上时间戳 —— 只有「取消发生在这轮投递开始之后」才算数，
 * 免得用户删掉之后又重新添加同一个文件时被误伤。
 *
 * 只存内存：进程重启后没有任何在飞的投递，墓碑也就没有意义了。
 */

const TTL = 10 * 60 * 1000
const MAX = 200

/** key -> at（毫秒时间戳） */
const map = new Map()

function keyOf(dir, name) {
  const d = String(dir || '')
    .replace(/[\\/]+$/, '')
    .toLowerCase()
  const n = String(name || '').toLowerCase()
  if (!n) return ''
  return d + '\u0000' + n
}

function gc() {
  const now = Date.now()
  for (const [k, at] of map) if (now - at > TTL) map.delete(k)
}

/**
 * 记一条墓碑。`dir` + `name` 就是这次下载的最终身份（磁盘上的目录与文件名）。
 * 认不出身份时调用方不必调它 —— 没有墓碑只是回到「取消可能被投递盖过」的旧行为。
 * @returns {boolean} 是否记下了
 */
function note(dir, name) {
  const k = keyOf(dir, name)
  if (!k) return false
  gc()
  map.set(k, Date.now())
  if (map.size > MAX) {
    const byAge = [...map].sort((a, b) => a[1] - b[1])
    for (const [old] of byAge.slice(0, map.size - MAX)) map.delete(old)
  }
  return true
}

/**
 * 这个身份是不是在 `since` 之后被取消过。
 * @param {number} since 这轮投递开始的时间（投递之前发生的取消不算）
 */
function cancelledAfter(dir, name, since) {
  const k = keyOf(dir, name)
  if (!k) return false
  gc()
  const at = map.get(k)
  return !!at && at > Number(since || 0)
}

function clear(dir, name) {
  map.delete(keyOf(dir, name))
}

module.exports = { note, cancelledAfter, clear, TTL, _map: map }