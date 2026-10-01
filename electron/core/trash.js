'use strict'

/**
 * 回收站：用户删掉「已完成的下载文件」时，不直接抹掉，而是把文件改名挪进
 * `<下载目录>\.PanBox 回收站\`，并在 `%APPDATA%\PanBox\trash.json` 里留一条记录。
 * 同一卷内 rename 是瞬时的，不搬字节；还原就是把文件挪回原位。
 *
 * 设计取舍：
 *  - 目录放在下载目录里（同一卷），rename 才快；用户换了下载目录也不影响旧记录，
 *    因为索引里存的是绝对路径。
 *  - 索引文件独立于 settings.json，写坏也不影响下载配置。
 *  - 不依赖 electron：路径由 configure() 传进来，方便用 Node 直接测。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

/** 回收站目录名（在下载目录下），带前导点，避免和正常下载混在一起 */
const DIR_NAME = '.PanBox 回收站'
/** 回收站最多留 200 条；超量的最旧条目在下一次删除时真删 —— 免得当永久仓库用 */
const MAX_ITEMS = 200

let indexPath = ''
let downloadDir = ''
let items = []
let loaded = false

function configure(opts) {
  const o = opts || {}
  if (o.indexPath) indexPath = String(o.indexPath)
  if (o.downloadDir) downloadDir = String(o.downloadDir)
  loaded = false
}

function trashDir() {
  const base = downloadDir || process.cwd()
  return path.join(base, DIR_NAME)
}

function load() {
  if (loaded) return items
  loaded = true
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    items = Array.isArray(raw) ? raw.filter((x) => x && x.id && x.to) : []
  } catch {
    items = []
  }
  /* 顺手丢掉文件已经不在了的条目（用户自己从资源管理器里清过回收站） */
  const alive = items.filter((x) => fs.existsSync(x.to))
  if (alive.length !== items.length) {
    items = alive
    save()
  }
  return items
}

function save() {
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })
    fs.writeFileSync(indexPath, JSON.stringify(items.slice(0, MAX_ITEMS), null, 2))
  } catch {
    /* 索引写不进去不该让删除动作失败 */
  }
}

/** 同一个名字重复删时，给回收站里的副本编号，别把上一份覆盖掉 */
function uniqueTarget(dir, name) {
  const ext = path.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let target = path.join(dir, name)
  let n = 2
  while (fs.existsSync(target)) {
    target = path.join(dir, `${stem} (${n})${ext}`)
    n++
    if (n > 999) break
  }
  return target
}

const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/**
 * 把一个已存在的文件挪进回收站。
 * @returns {Promise<object|null>} 写入的条目；文件不存在返回 null
 */
async function add(from, extra) {
  load()
  const src = path.resolve(String(from || ''))
  if (!src) return null
  let st = null
  try {
    st = await fsp.stat(src)
  } catch {
    return null
  }
  const dir = trashDir()
  await fsp.mkdir(dir, { recursive: true })
  const to = uniqueTarget(dir, path.basename(src))
  try {
    await fsp.rename(src, to)
  } catch (e) {
    /* 跨卷（用户换过下载目录）时 rename 会失败，退回「复制 + 删源」 */
    if (e && (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EACCES')) {
      try {
        if (st.isDirectory()) await fsp.cp(src, to, { recursive: true })
        else await fsp.copyFile(src, to)
        if (st.isDirectory()) await fsp.rm(src, { recursive: true, force: true })
        else await fsp.unlink(src)
      } catch (e2) {
        throw new Error('移入回收站失败：' + ((e2 && e2.message) || String(e2)))
      }
    } else {
      throw new Error('移入回收站失败：' + ((e && e.message) || String(e)))
    }
  }

  const item = {
    id: newId(),
    name: path.basename(src),
    from: src,
    to,
    size: st.isDirectory() ? 0 : Number(st.size || 0),
    dir: st.isDirectory(),
    netdisk: (extra && extra.netdisk) || '',
    gid: (extra && extra.gid) || '',
    at: Date.now(),
  }
  items.unshift(item)
  if (items.length > MAX_ITEMS) {
    /* 超量的最旧条目直接真删，别让回收站无限长大 */
    for (const old of items.slice(MAX_ITEMS)) await removeFile(old).catch(() => {})
    items = items.slice(0, MAX_ITEMS)
  }
  save()
  return item
}

async function removeFile(item) {
  if (!item || !item.to) return
  await fsp.rm(item.to, { recursive: true, force: true }).catch(() => {})
}

function list() {
  load()
  return items.map((x) => ({ id: x.id, name: x.name, from: x.from, size: x.size, dir: !!x.dir, netdisk: x.netdisk, at: x.at }))
}

function count() {
  load()
  return items.length
}

/** 还原：挪回原位；原位已经有同名文件时自动编号 */
async function restore(id) {
  load()
  const i = items.findIndex((x) => x.id === String(id))
  if (i < 0) return { ok: false, message: '回收站里没有这一项' }
  const it = items[i]
  if (!fs.existsSync(it.to)) {
    items.splice(i, 1)
    save()
    return { ok: false, message: '文件已经不在回收站里了' }
  }
  const dir = path.dirname(it.from)
  await fsp.mkdir(dir, { recursive: true }).catch(() => {})
  const target = uniqueTarget(dir, path.basename(it.from))
  try {
    await fsp.rename(it.to, target)
  } catch (e) {
    try {
      const st = await fsp.stat(it.to)
      if (st.isDirectory()) {
        await fsp.cp(it.to, target, { recursive: true })
        await fsp.rm(it.to, { recursive: true, force: true })
      } else {
        await fsp.copyFile(it.to, target)
        await fsp.unlink(it.to)
      }
    } catch (e2) {
      return { ok: false, message: '还原失败：' + ((e2 && e2.message) || String(e2)) }
    }
  }
  items.splice(i, 1)
  save()
  return { ok: true, path: target, name: path.basename(target) }
}

/** 彻底删除一条 */
async function drop(id) {
  load()
  const i = items.findIndex((x) => x.id === String(id))
  if (i < 0) return false
  const it = items[i]
  await removeFile(it)
  items.splice(i, 1)
  save()
  return true
}

/** 清空回收站 */
async function empty() {
  load()
  const n = items.length
  for (const it of items) await removeFile(it)
  items = []
  save()
  return n
}

module.exports = { configure, add, list, count, restore, drop, empty, DIR_NAME, _trashDir: trashDir }