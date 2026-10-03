/* 响应类型 → 后缀，以及「这个名字是不是已经有后缀了」这套规矩。
 *
 * 这套规矩浏览器也有一份（Chromium 的 net::GetSuggestedFilename）：服务器没给
 * content-disposition 文件名时，浏览器拿地址最后一段当名字、再用响应类型补后缀。
 * 所以 `https://dl.acm.org/doi/epdf/10.1145/3345768.3355908` 存下来叫
 * `3345768.3355908.pdf`，PanBox 与插件必须给出同一个名字。
 *
 * 以前这套表在三个地方各抄了一份（主进程 electron/parsers/util.js、插件的
 * background.js、插件的 content.js）。抄漏几行没人会发现 —— `application/x-zip`
 * 和 `vnd.rar` 就是这么漏掉的：同一个地址浏览器给 .pdf、插件却给 .bin。
 * 现在插件这边只留这一份：background.js 用 importScripts 载入，content.js 由
 * manifest 在它之前注入。主进程那份仍是权威，test/verify-ext-rules.js 会拿这张表
 * 跟它逐条比，谁改歪了测试就红。
 *
 * 纯函数，不碰 chrome API。`module.exports` 只是让测试能直接 require 这个文件。
 */
var PanBoxRules = (function () {
  /* 网页/接口类型不给后缀：它们不是文件，补 .html / .json 只会把
   * 「这其实不是文件」这件事藏起来。与主进程 util.js 的 WEB_TYPES 逐条一致。 */
  var WEB_TYPES = new Set([
    'text/html',
    'application/xhtml+xml',
    'text/plain',
    'text/css',
    'text/javascript',
    'application/javascript',
    'application/json',
    'text/json',
    'application/xml',
    'text/xml',
  ])

  /* application/* 的子类型 → 后缀。表里没有的补 .bin：至少比没后缀强，
   * 用户一眼也能看出这不是原生后缀。 */
  var CT_EXT = {
    pdf: 'pdf',
    'x-pdf': 'pdf',
    zip: 'zip',
    'x-zip': 'zip',
    'x-zip-compressed': 'zip',
    'x-7z-compressed': '7z',
    'x-rar-compressed': 'rar',
    'vnd.rar': 'rar',
    'x-tar': 'tar',
    gzip: 'gz',
    'x-gzip': 'gz',
    'x-bzip2': 'bz2',
    'x-xz': 'xz',
    'x-msdownload': 'exe',
    'x-msdos-program': 'exe',
    'x-msi': 'msi',
    'java-archive': 'jar',
    'vnd.android.package-archive': 'apk',
    'x-apple-diskimage': 'dmg',
    'epub+zip': 'epub',
    msword: 'doc',
    'vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'vnd.ms-excel': 'xls',
    'vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'vnd.ms-powerpoint': 'ppt',
    'vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    rtf: 'rtf',
    'x-mobipocket-ebook': 'mobi',
    'vnd.amazon.ebook': 'azw',
    ogg: 'ogg',
    'x-flac': 'flac',
    'x-iso9660-image': 'iso',
    'x-firmware': 'bin',
    'octet-stream': 'bin',
    'x-binary': 'bin',
  }

  /* 认得出的扩展名。用来判断「名字里是不是已经有后缀了」：
   * 表里认得的（.pdf、.bin…）当然是；表外的只要不像编号（`a.ndjson`）也算，
   * 免得给它叠成 `a.ndjson.pdf`。而**纯数字那段不算后缀** —— `3345768.3355908`
   * 与 `v1.0.6` 的最后一段都是编号，这正是 ACM 那条地址要补 .pdf 的原因。 */
  var KNOWN_EXTS = new Set(
    (
      'pdf zip rar 7z tar gz bz2 xz zst exe msi apk ipa dmg iso jar deb rpm appimage ' +
      'doc docx xls xlsx ppt pptx rtf odt ods epub mobi azw azw3 txt md csv json xml html htm ' +
      'png jpg jpeg gif bmp webp svg ico tif tiff heic avif ' +
      'mp3 wav flac aac ogg opus m4a wma ape ' +
      'mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts m3u8 m4s rmvb ' +
      'bin dat img cue nrg vhd vmdk pak cab txz tbz lz4 br'
    ).split(' ')
  )

  /** `application/pdf; charset=utf-8` → `pdf`；网页/文本类型返回空（它们不是文件） */
  function contentTypeExt(ct) {
    var s = String(ct || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    if (!s || WEB_TYPES.has(s)) return ''
    var m = /^([a-z0-9.-]+)\/(.+)$/.exec(s)
    if (!m) return ''
    var major = m[1]
    var sub = m[2]
    if (major === 'application') {
      var hit = CT_EXT[sub]
      if (hit) return hit
      /* `image/svg+xml`、`application/vnd.foo+json` 这种带后缀标记的，取 `+` 前那段 */
      sub = sub.replace(/\+.*$/, '')
      if (sub.indexOf('x-') === 0) sub = sub.slice(2)
      return /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'bin'
    }
    return sub.replace(/\+.*$/, '').replace(/^x-/, '')
  }

  /** 名字最后那一段像不像后缀：`a.pdf`→true、`3345768.3355908`→false */
  function hasKnownExt(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''))
    if (!m) return false
    var ext = m[1].toLowerCase()
    if (KNOWN_EXTS.has(ext)) return true
    return !/^\d+$/.test(ext)
  }

  /**
   * 名字没有后缀时，按响应类型补一个（浏览器就是这么定文件名的）。
   * 有后缀的一律不动 —— 站点给的名字优先。
   */
  function withExt(name, ct) {
    var s = String(name || '').trim()
    if (!s || hasKnownExt(s)) return s
    var ext = contentTypeExt(ct)
    return ext ? s + '.' + ext : s
  }

  return {
    contentTypeExt: contentTypeExt,
    hasKnownExt: hasKnownExt,
    withExt: withExt,
    CT_EXT: CT_EXT,
    KNOWN_EXTS: KNOWN_EXTS,
    WEB_TYPES: WEB_TYPES,
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = PanBoxRules