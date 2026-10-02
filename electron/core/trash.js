'use strict'

/**
 * 回收站：用户删掉「已完成的下载文件」时，不直接抹掉，而是把文件改名挪进
 * `<下载目录>\PanBox回收站\`，并在 `%APPDATA%\PanBox\trash.json` 里留一条记录。
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

/** 回收站目录名（在下载目录下），普通名字，别和下载的文件重名 */
const DIR_NAME = 'PanBox回收站'
/** 早期用过的带点名字，启动时把里面的文件搬过来（老用户无感） */
const LEGACY_DIR_NAMES = ['.PanBox 回收站', '.PanBox回收站']
/** 回收站最多留 200 条；超量的最旧条目在下一次删除时真删 —— 免得当永久仓库用 */
const MAX_ITEMS = 200
/** 到期自动清理的默认天数（0 = 永不自动删）。见 settings.js 的 trashRetentionDays */
const DEFAULT_RETENTION_DAYS = 30
/** 一天的毫秒数（保留天数换算成时间戳用；list() 里换算剩余天数也用同一份，避免各写一遍魔数） */
const MS_PER_DAY = 24 * 60 * 60 * 1000

let indexPath = ''
let downloadDir = ''
let items = []
let loaded = false
let retentionDays = DEFAULT_RETENTION_DAYS

function configure(opts) {
  const o = opts || {}
  if (o.indexPath) indexPath = String(o.indexPath)
  if (o.downloadDir) downloadDir = String(o.downloadDir)
  if (o.retentionDays !== undefined) setRetention(o.retentionDays)
  loaded = false
}

/** 设置保留天数：非负整数；其它值（含 0 以外的非法输入）回落到默认值。0 = 永不自动删。 */
function setRetention(days) {
  const n = Number(days)
  retentionDays = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RETENTION_DAYS
  return retentionDays
}

function getRetention() {
  return retentionDays
}

function trashDir() {
  const base = downloadDir || process.cwd()
  return path.join(base, DIR_NAME)
}

function inside(dir, p) {
  const rel = path.relative(dir, p)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 把老目录（`.PanBox 回收站`）里的东西并到新目录，并修正索引里的路径。
 * 只做同一卷上的 rename；失败就留着下次再试，不影响启动。
 */
function migrateSync() {
  const target = trashDir()
  let changed = false

  /* 索引里指向别处（老目录 / 换过下载目录）的条目：搬进当前回收站 */
  for (const it of items) {
    if (!it.to || inside(target, it.to)) continue
    try {
      if (!fs.existsSync(it.to)) continue
      fs.mkdirSync(target, { recursive: true })
      const next = uniqueTarget(target, path.basename(it.to))
      fs.renameSync(it.to, next)
      it.to = next
      changed = true
    } catch {
      /* 跨卷等：这条留着，文件还在原处，还原照样能用 */
    }
  }

  /* 老目录里没被索引到的散落文件：一并搬过来并补一条记录 */
  for (const name of LEGACY_DIR_NAMES) {
    const old = path.join(downloadDir || process.cwd(), name)
    if (old === target || !fs.existsSync(old)) continue
    let entries = []
    try {
      entries = fs.readdirSync(old)
    } catch {
      continue
    }
    fs.mkdirSync(target, { recursive: true })
    for (const one of entries) {
      try {
        const next = uniqueTarget(target, one)
        fs.renameSync(path.join(old, one), next)
        let st = null
        try {
          st = fs.statSync(next)
        } catch {
          st = null
        }
        items.push({
          id: newId(),
          name: one,
          from: path.join(downloadDir || process.cwd(), one),
          to: next,
          size: st && !st.isDirectory() ? Number(st.size || 0) : 0,
          dir: !!(st && st.isDirectory()),
          netdisk: '',
          gid: '',
          at: Date.now(),
        })
        changed = true
      } catch {
        /* 单个文件搬不动就跳过 */
      }
    }
    try {
      fs.rmdirSync(old)
    } catch {
      /* 还有东西没搬走就留着 */
    }
  }
  return changed
}

/**
 * 到期清理：把 `at` 早于「保留天数」的条目真删（retentionDays = 0 时什么都不做）。
 *
 * - 同步执行，方便在 load() 里顺手做一次；索引只有几百条，代价可以忽略。
 * - 删不掉的条目（文件被别的程序占用、权限不足）**留在索引里**，下次再试，不报错也不丢记录。
 * - 文件本身已经不在回收目录里的条目也算清理掉，免得索引里一直挂着僵尸记录。
 * @returns {{removed:number, kept:number}} removed = 清掉的条目数，kept = 这次没删掉的条目数
 */
function purgeExpired(now) {
  if (!retentionDays) return { removed: 0, kept: 0 }
  const t = Number(now) || Date.now()
  const limitMs = retentionDays * MS_PER_DAY
  const expired = items.filter((x) => t - Number(x.at || 0) >= limitMs)
  if (!expired.length) return { removed: 0, kept: 0 }

  let removed = 0
  let kept = 0
  const gone = new Set()
  for (const it of expired) {
    try {
      fs.rmSync(it.to, { recursive: true, force: true })
      gone.add(it.id)
      removed++
    } catch {
      /* 删不掉（文件被占用 / 权限不足）：条目留着，下次再试 */
      kept++
    }
  }
  if (gone.size) {
    items = items.filter((x) => !gone.has(x.id))
    save()
  }
  return { removed, kept }
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
  const moved = migrateSync()
  /* 顺手丢掉文件已经不在了的条目（用户自己从资源管理器里清过回收站） */
  const alive = items.filter((x) => fs.existsSync(x.to))
  if (alive.length !== items.length || moved) {
    items = alive
    save()
  }
  /* 再顺手做一次到期清理（默认 30 天），清掉了就落盘 */
  purgeExpired()
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
  const now = Date.now()
  const limitMs = retentionDays * MS_PER_DAY
  return items.map((x) => ({
    id: x.id,
    name: x.name,
    from: x.from,
    size: x.size,
    dir: !!x.dir,
    netdisk: x.netdisk,
    at: x.at,
    /* 还有几天到期（界面直接显示；永不自动删时为 null） */
    leftDays: limitMs ? Math.max(0, Math.ceil((Number(x.at || 0) + limitMs - now) / MS_PER_DAY)) : null,
  }))
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

module.exports = {
  configure,
  add,
  list,
  count,
  restore,
  drop,
  empty,
  purgeExpired,
  setRetention,
  getRetention,
  DIR_NAME,
  _trashDir: trashDir,
}