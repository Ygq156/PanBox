'use strict'

/**
 * 「转存 → 等落盘 → 认领 → 删副本」里四件与站点无关的事。
 *
 * 为什么不做「通用引擎」
 * --------------------
 * 这套流程夸克/UC、百度、迅雷三家都有，但每一步的地址、签名、目标目录、
 * 分享凭证类型、名字判据、删除请求形状**都不一样**（详见各家文件里的注释）。
 * 真做成「引擎 + 十个钩子」，每家仍要写一份差不多的适配器，读起来比各家自己
 * 写一遍还费劲 —— 三个用户的抽象不值得。所以这里只收真正一样的东西：
 * 轮询、重试、名字判据、副本台账。HTTP 一律留在站点侧。
 *
 * 台账为什么重要
 * --------------
 * 「下载完把转存进来的副本删掉」这条承诺有个前提：删的必须是**我们刚转存的**那份。
 * 三家都遇到过「用户网盘里本来就有同名文件」的情况，认错就会删用户的东西。
 * 于是：转存前拍快照 → 只登记快照之外的新 id。这条护栏以前各家各写一遍，
 * 迅雷那份漏了（只剩按名字找第一个匹配项），所以这里把它做成登记的必经一步。
 */

const { sleep } = require('./util')

/**
 * 反复问，问出结果就停。
 *
 * `fn` 抛错会往上抛 —— 该不该把「这一轮没问成」咽下去由调用方决定
 * （夸克的任务轮询自己 `.catch(() => null)`，迅雷的列目录则要让真错误透出来，
 * 否则「验证码没过」会被伪装成「找不到文件」）。
 *
 * @param {(i:number)=>Promise<any>} fn 第 i 轮（从 0 开始）
 * @param {{attempts?:number, intervalMs?:number, until?:(v:any)=>boolean, delayFirst?:boolean}} [o]
 */
async function pollUntil(fn, { attempts = 20, intervalMs = 600, until = (v) => !!v, delayFirst = false } = {}) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    /* 转存刚落盘时第一次问必然没结果（夸克的任务接口、迅雷的目录索引都这样），
     * 这个时候先等再问能省掉一轮白问。 */
    if (i || delayFirst) await sleep(intervalMs)
    last = await fn(i)
    if (until(last)) return last
  }
  return last
}

/**
 * 反复试，试成就停。用于「索引还没就绪 → 隔几秒再试」这类抖动，
 * 与 pollUntil 的区别是它关心的是**返回值**，不是「等状态变成某个值」。
 */
async function retryAsync(fn, { attempts = 4, intervalMs = 1200, ok = (v) => !!v } = {}) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(intervalMs)
    last = await fn(i)
    if (ok(last)) return last
  }
  return last
}

/**
 * 把文件名拆成「基名 + 扩展名」，并摘掉服务端为同名文件加的重名后缀。
 *
 * `x(1).zip`（夸克）与 `x (1).zip`（迅雷）都见过，所以空格要不要认是参数：
 * 认宽一点只会「可能多认一份同名的新副本」，认窄一点会「找不到自己刚转存的文件」。
 * 删除侧另有快照护栏兜着，所以这里偏宽。
 */
function nameParts(name, { spaced = true } = {}) {
  let s = String(name == null ? '' : name)
  const dup = (spaced ? /(?:\s*)\((\d+)\)(\.[^.]*)?$/ : /\((\d+)\)(\.[^.]*)?$/).exec(s)
  if (dup) s = s.slice(0, dup.index) + (dup[2] || '')
  const i = s.lastIndexOf('.')
  return i > 0 ? { base: s.slice(0, i), ext: s.slice(i) } : { base: s, ext: '' }
}

/** 两个名字是不是同一个文件（允许尾部重名后缀的差异） */
function sameFile(a, b, opts) {
  if (a === b) return true
  const x = nameParts(a, opts)
  const y = nameParts(b, opts)
  return !!x.base && x.base === y.base && x.ext === y.ext
}

/**
 * 转存副本的台账：转存前拍快照，只登记快照之外的新 id。
 *
 * 用法（三家一致）：
 *   const rec = new Reclaimer()
 *   rec.snapshot(现有文件 id)      // 转存**之前**
 *   ...转存...
 *   rec.claim(新文件的 id, {...})  // 认领时登记；不是新出现的就不登记
 *   ...下载完...
 *   rec.items / rec.take()         // 交给各家的删除请求
 */
class Reclaimer {
  constructor() {
    /** 转存前已存在的 id（没拍过快照就是 null） */
    this.before = null
    /** 待删副本：`[{ id, ...站点自己的字段 }]` */
    this.items = []
  }

  /** 转存**之前**调用。没收下快照就不允许登记 —— 这是防删用户文件的唯一依据。 */
  snapshot(ids) {
    this.before = new Set((ids || []).map((x) => String(x)))
    return this.before
  }

  /** 这个 id 是转存之后新出现的吗 */
  isOurs(id) {
    const v = String(id == null ? '' : id)
    return !!v && !!this.before && !this.before.has(v)
  }

  /** 登记一份待删副本；不是我们造的就不登记。返回是否登记上了。 */
  claim(id, extra) {
    if (!this.isOurs(id)) return false
    return this._push(id, extra)
  }

  /**
   * 登记一份「服务端直接告诉了我们新文件 id」的副本（迅雷的 `trace_file_ids`）。
   *
   * 这是快照护栏唯一的例外：服务端的映射本身就是证据，不需要靠名字去猜。
   * 按名字猜出来的 id **绝不允许**走这条路 —— 那正是会误删用户文件的那条路。
   */
  claimKnown(id, extra) {
    return this._push(id, extra)
  }

  _push(id, extra) {
    const v = String(id == null ? '' : id)
    if (!v || this.items.some((x) => x.id === v)) return false
    this.items.push({ ...(extra || {}), id: v })
    return true
  }

  get size() {
    return this.items.length
  }

  /** 取出 id 列表（不动台账） */
  ids() {
    return this.items.map((x) => x.id)
  }

  /** 取走全部待删副本并清空台账（删除失败也不会再自动重试，由调用方决定） */
  take() {
    const out = this.items
    this.items = []
    return out
  }
}

module.exports = { pollUntil, retryAsync, nameParts, sameFile, Reclaimer }