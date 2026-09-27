'use strict'

/**
 * 阿里云 ESA / 加速乐式反爬（蓝奏云全站、蓝奏优享都在用）。
 *
 * 挑战页里会带 `var arg1='<40 位 hex>'`，算法是：
 *   1. 按 posList 做一次「逆位置重排」得到 arg2
 *   2. 与固定 mask 逐字节异或，输出 40 位小写 hex
 *   3. 结果写进 cookie `acw_sc__v2` 后**原样重放**同一个请求
 *
 * 算法逐字取自 qaiu/netdisk-fast-download (MIT) 的
 * `cn.qaiu.util.AcwScV2Generator.acwScV2Simple`。
 */

const POS_LIST = [
  15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23, 25,
  13, 6, 11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17, 5, 3,
  28, 34, 37, 12, 36,
]

const MASK = '3000176000856006061501533003690027800375'

const ARG1_MARK = "var arg1='"

/** 从挑战页 HTML 里取 arg1（取不到返回 ''） */
function extractArg1(html) {
  const begin = String(html || '').indexOf("arg1='")
  if (begin === -1) return ''
  const start = begin + 6
  const end = String(html).indexOf("';", start)
  if (end === -1 || end <= start) return ''
  return String(html).slice(start, end)
}

function acwScV2(arg1) {
  const out = new Array(40).fill('')
  for (let i = 0; i < arg1.length; i++) {
    for (let j = 0; j < POS_LIST.length; j++) {
      if (POS_LIST[j] === i + 1) out[j] = arg1[i]
    }
  }
  const arg2 = out.join('')
  const len = Math.min(arg2.length, MASK.length)
  let result = ''
  for (let i = 0; i < len; i += 2) {
    const a = parseInt(arg2.slice(i, i + 2), 16)
    const b = parseInt(MASK.slice(i, i + 2), 16)
    if (Number.isNaN(a) || Number.isNaN(b)) continue
    result += (a ^ b).toString(16).padStart(2, '0')
  }
  return result
}

function hasChallenge(html) {
  return String(html || '').includes(ARG1_MARK)
}

/**
 * 发一次请求；如果撞上 ESA 挑战页，就把 acw_sc__v2 写进 jar 并重放一次。
 * @param {(opts:object)=>Promise<object>} send 接受 {jar} 的发送函数
 */
async function withArg1Retry(send, jar, ctxFor) {
  let r = await send()
  if (!hasChallenge(r.text)) return r
  const arg1 = extractArg1(r.text)
  if (!arg1) throw new Error('反爬校验页异常：未能提取 arg1')
  if (jar) jar.set('acw_sc__v2', acwScV2(arg1))
  r = await send()
  if (hasChallenge(r.text)) throw new Error('反爬校验失败（acw_sc__v2 未被接受），请稍后重试')
  return r
}

module.exports = { acwScV2, extractArg1, hasChallenge, withArg1Retry, POS_LIST, MASK }
