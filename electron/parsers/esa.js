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

const { solveChallenge } = require('./esaSolve')

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
 * 挑战没过时站点回的也是这张小错误页（HTTP 400 + “Error : Time Out”），
 * 它不带 `var arg1`，光看正文会被当成正常响应，所以单独认一下。
 */
function isChallengeRejected(r) {
  if (!r || !r.text) return false
  if (Number(r.status) !== 400) return false
  return /Error\s*:\s*Time\s*Out/i.test(String(r.text).slice(0, 4096))
}

/**
 * 站点判「校验超时」时给用户的说法。带上浏览器那份还是被拒，说明站点另有判据
 * （连接指纹那类），本机再算多少遍都一样 —— 只能告诉他怎么再做一次。
 */
function rejectedError(fromContext, _round) {
  if (fromContext) {
    return new Error(
      '站点没接受浏览器这份校验（HTTP 400 Error : Time Out）。请确认插件投递的就是当前正打开着这个分享页的那个标签页，然后再点一次解析；也可以过一会儿重试',
    )
  }
  return new Error('反爬校验未通过（站点返回 HTTP 400 Error : Time Out），请稍后重试或重新复制分享链接')
}

/**
 * 发一次请求；如果撞上 ESA 挑战页，就把 `acw_sc__v2` 写进 jar 并重放。
 * cookie 优先由挑战页自带脚本在沙箱里跑出来（见 esaSolve.js），跑不出来才用本地算法。
 * 重放仍被判过期（HTTP 400 Error : Time Out）时，再取一张新挑战页重试一次。
 * @param {(opts:object)=>Promise<object>} send 接受 {jar} 的发送函数
 */
async function withArg1Retry(send, jar, ctxFor) {
  /* 手里这份 acw_sc__v2 是**浏览器现场**给的（不是本机算的）：那它就是站点
   * 认可的那一份，本机再算几遍也派生不出第二个能过的值。 */
  const fromContext = !!(jar && ctxFor && ctxFor.cookieFromContext)
  let r = await send()
  /* 第一次就被判「校验超时」：罐里本来就有一份（浏览器给的、或上一页留下的），
   * 站点说它不认。这不是页面内容，不能当页面交给调用方。 */
  if (isChallengeRejected(r)) throw rejectedError(fromContext, 1)
  if (!hasChallenge(r.text)) return r
  const solved = solveChallenge(r.text, (ctxFor && ctxFor.url) || '')
  if (!solved.cookie && !fromContext) throw new Error('反爬校验页异常：未能提取 arg1')
  if (solved.cookie && jar && !fromContext) jar.set('acw_sc__v2', solved.cookie)
  r = await send()
  if (hasChallenge(r.text)) {
    if (fromContext && jar && typeof jar.del === 'function') jar.del('acw_sc__v2')
    throw new Error('反爬校验失败（acw_sc__v2 未被接受），请稍后重试')
  }
  if (!isChallengeRejected(r)) return r
  /* 带的就是浏览器现场那份，站点还是判「超时」：说明站点另有判据（连接指纹
   * 那类），本机再算再试都是白跑几轮请求 —— 不如直接说清该怎么办。 */
  if (fromContext) throw rejectedError(true, 2)
  /* 带上 acw_sc__v2 重放，站点仍然判校验过期：换一张新挑战页再试一次，
   * 挑战页本身是短效的，隔了几百毫秒就可能作废。要拿新挑战页就得先把
   * 手里的 acw_sc__v2 摘掉，否则站点不会重新发挑战（照旧回 400）。 */
  const rejected = r
  let retried = false
  if (jar && typeof jar.del === 'function') {
    jar.del('acw_sc__v2')
    const fresh = await send({ noChallengeRetry: true }).catch(() => null)
    if (fresh && hasChallenge(fresh.text)) {
      const again = solveChallenge(fresh.text, (ctxFor && ctxFor.url) || '')
      if (again.cookie) jar.set('acw_sc__v2', again.cookie)
      r = await send()
      retried = true
      if (!hasChallenge(r.text) && !isChallengeRejected(r)) return r
    }
  }
  /* 到这里还是没过：这不是「页面里找不到下载入口」，直接说清是反爬没过，
   * 免得用户以为是分享失效。重试过就报第一次那张 400，状态码别串成重试那一次的。 */
  if (hasChallenge(r.text)) throw new Error('反爬校验失败（acw_sc__v2 未被接受），请稍后重试')
  throw new Error(`反爬校验未通过（站点返回 HTTP ${(retried ? rejected : r).status} Error : Time Out），请稍后重试或重新复制分享链接`)
}

module.exports = { acwScV2, extractArg1, hasChallenge, isChallengeRejected, withArg1Retry, solveChallenge }
