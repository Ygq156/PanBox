'use strict'

/**
 * fMP4（CMAF）小工具：读 box、并初始化段、按时间交错分片。
 *
 * 为什么需要它
 * ------------
 * 现在越来越多的站点（X、Apple 的示例流、各家 CMAF 点播）把一条视频做成**两条轨**：
 * 视频列表里只有画面，声音放在 `#EXT-X-MEDIA:TYPE=AUDIO` 指到的另一份列表里。
 * 只会下视频列表的话，产物是「有画面没声音」—— 用户看到的就是这个。
 *
 * 把两轨并成一个能播的文件，本质上就是整理 MP4 的盒子：
 *  - 初始化段：把两份 `moov` 里的 `trak`（一条 vide、一条 soun）并成一份，
 *    `mvex` 里补上第二条 `trex`，`mvhd` 的下一条轨号往后挪；两份都用 1 号轨的时候就重编号。
 *  - 媒体分片：`moof+mdat` 原样搬，只按输出顺序重编 `mfhd` 序号、必要时改 `tfhd` 的轨号，
 *    然后**按解码时间交错**（音视频各几秒一片，不交错的话播放器要等到读完所有视频片才有声音）。
 *
 * 不做什么
 * --------
 * - 不重新编码、不动码流：只搬盒子、只改几个定长字段，改完的字节数与原来一模一样
 *   （唯一的例外是 `moov` 本身被重建），所以不会把能播的东西改坏。
 * - 不处理 `sidx`/`ssix`（分段索引）：分片位置一变索引就失效，直接丢掉 —— 它只是索引，
 *   丢了不影响解码。
 * - 不管加密：AES-128 的分片在下载阶段就解好了（见 hls.js 的 `_decrypt`）。
 */

const fsp = require('node:fs/promises')

/** box 头部：4 字节长度 + 4 字节类型。`size === 1` 时长度是 8 字节（大 box） */
const HEADER = 8

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 把一个缓冲区按顶层 box 切开，返回 `[{ type, start, end, bodyStart }]`。
 * 结构不完整就抛错：宁可明确失败，也不要把半截数据当成分片拼进去。
 */
function readBoxes(buf, from = 0, to = buf.length) {
  const out = []
  let off = from
  while (off + HEADER <= to) {
    const type = buf.toString('latin1', off + 4, off + 8)
    let size = buf.readUInt32BE(off)
    let head = HEADER
    if (size === 1) {
      if (off + 16 > to) throw new Error(`MP4 结构不完整：${type} 的大长度字段被截断`)
      size = Number(buf.readBigUInt64BE(off + 8))
      head = 16
    } else if (size === 0) {
      size = to - off
    }
    if (size < head || off + size > to) {
      throw new Error(`MP4 结构不完整：${type} 声称 ${size} 字节，但只剩 ${to - off} 字节`)
    }
    out.push({ type, start: off, end: off + size, bodyStart: off + head })
    off += size
  }
  if (off !== to) throw new Error(`MP4 结构不完整：末尾多出 ${to - off} 字节`)
  return out
}

/** 找第一个指定类型的子 box */
function findBox(buf, type, from = 0, to = buf.length) {
  return readBoxes(buf, from, to).find((b) => b.type === type) || null
}

/** 某个 box 的子 box 列表 */
function children(buf, box) {
  if (!box) return []
  return readBoxes(buf, box.bodyStart, box.end)
}

/** 读 `trak` 里的关键信息：轨类型（vide/soun）、时间基、轨号 */
function readTrack(buf, trak) {
  const mdia = findBox(buf, 'mdia', trak.bodyStart, trak.end)
  const hdlr = findBox(buf, 'hdlr', mdia ? mdia.bodyStart : 0, mdia ? mdia.end : 0)
  const mdhd = findBox(buf, 'mdhd', mdia ? mdia.bodyStart : 0, mdia ? mdia.end : 0)
  const tkhd = findBox(buf, 'tkhd', trak.bodyStart, trak.end)
  const handler = hdlr ? buf.toString('latin1', hdlr.bodyStart + 8, hdlr.bodyStart + 12) : ''
  let timescale = 0
  if (mdhd) {
    const v = buf.readUInt8(mdhd.bodyStart)
    timescale = buf.readUInt32BE(mdhd.bodyStart + (v === 1 ? 20 : 12))
  }
  let trackId = 0
  if (tkhd) {
    const v = buf.readUInt8(tkhd.bodyStart)
    trackId = buf.readUInt32BE(tkhd.bodyStart + (v === 1 ? 20 : 12))
  }
  return { handler, timescale, trackId, trak, mdia, mdhd, tkhd, hdlr }
}

/**
 * 读一个初始化段（`#EXT-X-MAP` 指到的那一段）。返回 `{ top, ftyp, moov, kids, traks, trexs }`。
 * 不是初始化段（缺 `ftyp` 或 `moov`）就抛错。
 */
function readInit(buf) {
  const top = readBoxes(buf)
  const ftyp = top.find((b) => b.type === 'ftyp') || null
  const moov = top.find((b) => b.type === 'moov') || null
  if (!ftyp) throw new Error('这不是 fMP4 初始化段：没有 ftyp')
  if (!moov) throw new Error('这不是 fMP4 初始化段：没有 moov')
  const kids = children(buf, moov)
  const traks = kids.filter((b) => b.type === 'trak').map((t) => readTrack(buf, t))
  const mvex = kids.find((b) => b.type === 'mvex') || null
  const trexs = mvex ? children(buf, mvex).filter((b) => b.type === 'trex') : []
  return { top, ftyp, moov, kids, traks, mvex, trexs, mvexKids: mvex ? children(buf, mvex) : [] }
}

/* ------------------------------------------------------------------ */
/* 写（都是定长就地覆盖，不改变长度）                                    */
/* ------------------------------------------------------------------ */

/** 造一个 box：`box('mvex', [trexBuf, …])` */
function box(type, bodies) {
  const body = Buffer.concat(bodies)
  const head = Buffer.alloc(HEADER)
  head.writeUInt32BE(HEADER + body.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

/** 把一条 trak 的轨号改成 want（`tkhd.track_ID`），返回新的 trak 字节 */
function retagTrak(buf, track, want) {
  if (!track.tkhd) return Buffer.from(buf.subarray(track.trak.start, track.trak.end))
  const v = buf.readUInt8(track.tkhd.bodyStart)
  const off = track.tkhd.bodyStart + (v === 1 ? 20 : 12)
  const body = Buffer.from(buf.subarray(track.trak.start, track.trak.end))
  /* 子 box 在 trak 里的相对位置 = 绝对位置 - trak.start */
  body.writeUInt32BE(want, off - track.trak.start)
  return body
}

/** 把 `mvex` 里某个 `trex` 的轨号改成 want */
function retagTrex(buf, trex, want) {
  const body = Buffer.from(buf.subarray(trex.start, trex.end))
  body.writeUInt32BE(want, trex.bodyStart - trex.start + 4)
  return body
}

/** 改 `mvhd` 的 next_track_ID（v0 在体 +96，v1 在体 +108） */
function retagMvhd(buf, mvhd, next) {
  const body = Buffer.from(buf.subarray(mvhd.start, mvhd.end))
  const v = buf.readUInt8(mvhd.bodyStart)
  body.writeUInt32BE(next, (mvhd.bodyStart - mvhd.start) + (v === 1 ? 108 : 96))
  return body
}

/**
 * 把只含一条轨的两份初始化段并成一份：视频那条编 1 号、音频那条编 2 号。
 * @returns `{ buf, video:{trackId,timescale}, audio:{trackId,timescale} }`
 */
function mergeInit(videoBuf, audioBuf) {
  const v = readInit(videoBuf)
  const a = readInit(audioBuf)
  const vt = v.traks.find((t) => t.handler === 'vide') || v.traks[0]
  const at = a.traks.find((t) => t.handler === 'soun') || a.traks[0]
  if (!vt) throw new Error('视频初始化段里没有轨道')
  if (!at) throw new Error('音频初始化段里没有轨道')
  if (vt.handler === 'soun' || at.handler === 'vide') throw new Error('音视频初始化段弄反了')

  const VIDEO_ID = 1
  const AUDIO_ID = 2
  const trakVideo = retagTrak(videoBuf, vt, VIDEO_ID)
  const trakAudio = retagTrak(audioBuf, at, AUDIO_ID)
  const trexVideo = v.trexs[0] ? retagTrex(videoBuf, v.trexs[0], VIDEO_ID) : null
  const trexAudio = a.trexs[0] ? retagTrex(audioBuf, a.trexs[0], AUDIO_ID) : null

  const parts = []
  for (const kid of v.kids) {
    if (kid.type === 'mvhd') {
      parts.push(retagMvhd(videoBuf, kid, AUDIO_ID + 1))
      continue
    }
    if (kid.type === 'trak') {
      parts.push(trakVideo)
      parts.push(trakAudio) /* 音频轨紧跟在视频轨后面 */
      continue
    }
    if (kid.type === 'mvex') {
      const kids = []
      for (const m of v.mvexKids) {
        kids.push(m.type === 'trex' && trexVideo ? trexVideo : Buffer.from(videoBuf.subarray(m.start, m.end)))
      }
      if (trexAudio) kids.push(trexAudio)
      parts.push(box('mvex', kids))
      continue
    }
    /* 其余原样保留：`udta` 这类盒子跟解码无关，但也没必要丢（音频那份的 udta 不再重复搬） */
    parts.push(Buffer.from(videoBuf.subarray(kid.start, kid.end)))
  }
  /* 视频那份没有 mvex（少见，但真见过没有的初始化段）：至少把音频的 trex 补进去 */
  if (!v.mvex && trexAudio) parts.push(box('mvex', [trexAudio]))

  const out = Buffer.concat([Buffer.from(videoBuf.subarray(v.ftyp.start, v.ftyp.end)), box('moov', parts)])
  return {
    buf: out,
    video: { trackId: VIDEO_ID, timescale: vt.timescale },
    audio: { trackId: AUDIO_ID, timescale: at.timescale },
  }
}

/* ------------------------------------------------------------------ */
/* 媒体分片                                                            */
/* ------------------------------------------------------------------ */

/** 读一个媒体分片的头部信息：轨号与解码时间。没有 `moof` 返回 null */
function readFragment(buf) {
  const top = readBoxes(buf)
  const moof = top.find((b) => b.type === 'moof')
  if (!moof) return null
  const traf = children(buf, moof).find((b) => b.type === 'traf')
  if (!traf) return null
  const tfhd = findBox(buf, 'tfhd', traf.bodyStart, traf.end)
  const tfdt = findBox(buf, 'tfdt', traf.bodyStart, traf.end)
  const mfhd = children(buf, moof).find((b) => b.type === 'mfhd')
  if (!tfhd) return null
  const flags = buf.readUIntBE(tfhd.bodyStart + 1, 3)
  const trackId = buf.readUInt32BE(tfhd.bodyStart + 4)
  let decodeTime = 0
  if (tfdt) {
    const v = buf.readUInt8(tfdt.bodyStart)
    decodeTime = v === 1 ? Number(buf.readBigUInt64BE(tfdt.bodyStart + 4)) : buf.readUInt32BE(tfdt.bodyStart + 4)
  }
  return { top, moof, traf, tfhd, tfdt, mfhd, flags, trackId, decodeTime }
}

/**
 * 改一个分片的轨号与序号（就地改副本，长度不变）。
 * `baseDelta`：分片在输出文件里挪了位置时，用来补 `tfhd.base_data_offset`
 * （只有带 base-data-offset-present 标志的分片才有这个字段；`default-base-is-moof` 的不用管）。
 */
function patchFragment(buf, { trackId = 0, seq = 0, baseDelta = 0 } = {}) {
  const info = readFragment(buf)
  if (!info) throw new Error('这不是 fMP4 媒体分片：没有 moof')
  const out = Buffer.from(buf)
  if (trackId) out.writeUInt32BE(trackId, info.tfhd.bodyStart + 4)
  if (seq && info.mfhd) out.writeUInt32BE(seq, info.mfhd.bodyStart + 4)
  if (baseDelta && info.flags & 0x000001) {
    const at = info.tfhd.bodyStart + 8
    const cur = Number(out.readBigUInt64BE(at))
    out.writeBigUInt64BE(BigInt(cur + baseDelta), at)
  }
  return out
}

/**
 * 按解码时间把两条轨的分片交错写成一个文件。
 * @param {string} outputPath 产物
 * @param {Buffer} initBuf 已经并好的初始化段
 * @param {{path:string, trackId:number, time:number, retag:number}[]} fragments
 *        `time` 是解码时间（秒，调用方按各自时间基算好），`retag` 是这个分片该用的轨号
 * @returns {Promise<{bytes:number, fragments:number}>}
 */
async function mergeToFile({ outputPath, initBuf, fragments }) {
  const list = fragments
    .filter((f) => f && f.path)
    .slice()
    .sort((a, b) => a.time - b.time || a.trackId - b.trackId)
  const fh = await fsp.open(outputPath, 'w')
  let bytes = 0
  let seq = 0
  try {
    await fh.write(initBuf)
    bytes += initBuf.length
    for (const f of list) {
      const raw = await fsp.readFile(f.path)
      const out = patchFragment(raw, { trackId: f.retag || 0, seq: ++seq })
      await fh.write(out)
      bytes += out.length
    }
  } finally {
    await fh.close()
  }
  return { bytes, fragments: list.length }
}

/** 分片里要丢掉的盒子：分段索引（位置一变就失效）与分段标记（单文件里不需要） */
const DROP_IN_FRAGMENT = new Set(['sidx', 'ssix', 'styp', 'free'])

/** 把分片里该丢的盒子丢掉，剩下的原样拼起来（长度会变，所以要重建） */
function stripFragment(buf) {
  const top = readBoxes(buf)
  const keep = top.filter((b) => !DROP_IN_FRAGMENT.has(b.type))
  if (keep.length === top.length) return Buffer.from(buf)
  return Buffer.concat(keep.map((b) => buf.subarray(b.start, b.end)))
}

module.exports = {
  readBoxes,
  findBox,
  children,
  readInit,
  mergeInit,
  readFragment,
  patchFragment,
  stripFragment,
  mergeToFile,
  DROP_IN_FRAGMENT,
}