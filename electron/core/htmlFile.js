'use strict'
/**
 * 「这个产物其实是个网页」的判定。
 *
 * 有些地址的**名字**像视频/列表，**内容**却是网页：影视站的播放器把真列表包在
 * `https://播放器站/?url=https://cdn/…/index.m3u8` 里，服务器回的是 `text/html`，
 * 于是落盘叫 `dxfbk.m3u8` —— 只按后缀判定（`/\.html?$/`）看不出来，
 * 用户拿到一个「改成什么后缀都放不出来」的文件，只会觉得下载坏了。
 *
 * 只读开头 512 字节，只看文档开头；读不到就返回 false（不拿猜的话去打扰用户）。
 * 单独成模块是为了能直接用 node 测（见 `test/verify-html-file.js`）。
 */

const fs = require('node:fs')

/** 文件开头的这几十个字节看着像 HTML 文档吗（纯函数，好测） */
function isHtmlHead(buf) {
  if (!buf || !buf.length) return false
  let b = Buffer.from(buf).subarray(0, 512)
  /* UTF-8 的 BOM 是三个字节，得在转成字符串**之前**剥掉（转成 latin1 之后
   * 它变成 `ï»¿` 三个字符，`replace(/^\uFEFF/)` 就认不出来了）。 */
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3)
  const head = b.toString('latin1').trimStart().toLowerCase()
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    /* XHTML：`<?xml version="1.0"…?>` 之后才是 `<html …` */
    (head.startsWith('<?xml') && head.includes('<html'))
  )
}

/** 读文件开头看一眼。读不到（文件不在、权限、空文件）→ false */
async function looksLikeHtml(filePath) {
  let fh = null
  try {
    fh = await fs.promises.open(filePath, 'r')
    const buf = Buffer.alloc(512)
    const { bytesRead } = await fh.read(buf, 0, 512, 0)
    if (!bytesRead) return false
    return isHtmlHead(buf.subarray(0, bytesRead))
  } catch {
    return false
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

module.exports = { isHtmlHead, looksLikeHtml }