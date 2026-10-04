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
  /* 接口/资源类型不给后缀：它们不是文件，补 .json / .css 只会把
   * 「这其实不是文件」这件事藏起来。与主进程 util.js 的 WEB_TYPES 逐条一致。
   * 网页（text/html、application/xhtml+xml）不在表里 —— 见下面 contentTypeExt 里
   * 那条：网页如实补 .html，用户一眼能看出「下到的是网页本身」。 */
  var WEB_TYPES = new Set([
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

  /** `application/pdf; charset=utf-8` → `pdf`；网页 → `html`；接口/文本类型返回空 */
  function contentTypeExt(ct) {
    var s = String(ct || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    if (!s) return ''
    /* 网页地址：如实叫 .html，别留一个没后缀的文件让人猜 */
    if (s === 'text/html' || s === 'application/xhtml+xml') return 'html'
    if (WEB_TYPES.has(s)) return ''
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

  /* 图片 CDN 给的常常不是原图：同一张图另有一个「尺寸」参数或路径段。
   * 两条规则抄 yt-dlp（`yt_dlp/extractor/twitter.py:1250-1262` 用 `?name=orig`）：
   *   X：`pbs.twimg.com/media/xxx?format=jpg&name=small` → `…&name=orig`，
   *      也有把尺寸写在文件名后面的 `…xxx.jpg:large` → `…xxx.jpg:orig`；
   *   Pinterest：`i.pinimg.com/736x/ab/cd/ef/hash.jpg` → `…/originals/ab/cd/ef/hash.jpg`。
   * 拿不准就返回空串 —— 宁可下用户眼前这张，也别换出一个会 404 的地址。 */
  function origImageUrl(url) {
    var s = String(url || '')
    if (!/^https?:\/\//i.test(s)) return ''
    try {
      var u = new URL(s)
      var host = u.hostname.toLowerCase()
      if (/(^|\.)twimg\.com$/.test(host)) {
        if (u.searchParams.has('name')) {
          u.searchParams.set('name', 'orig')
          return u.toString()
        }
        if (/:(small|medium|large|\d+x\d+)$/i.test(u.pathname)) {
          u.pathname = u.pathname.replace(/:(small|medium|large|\d+x\d+)$/i, ':orig')
          return u.toString()
        }
        return ''
      }
      if (/(^|\.)pinimg\.com$/.test(host)) {
        var m = /^\/(\d+x\d*|originals)\//i.exec(u.pathname)
        if (m && m[1].toLowerCase() !== 'originals') {
          u.pathname = u.pathname.replace(/^\/[^/]+\//, '/originals/')
          return u.toString()
        }
        return ''
      }
      return ''
    } catch (e) {
      return ''
    }
  }

  /* 分片流里「开头那一段」：X 的初始化段长得像个小 mp4
   * （`https://video.twimg.com/amplify_video/<id>/vid/avc1/0/0/480x270/xxx.mp4`，
   * 实测只有 903 字节），单独下下来任何播放器都放不出来，可它又带着 `.mp4` 后缀与
   * `video/mp4` 类型，面板会把它当「视频/音频」摆出来。它跟 `.m4s` 是一类东西，
   * 该进「分片」那一组。
   * 判据是路径里的 `/0/0/`：X 用「序号/起始毫秒」编路径，初始化段这两段都是 0
   * （真分片是 `/0/3000/` 这种）。只认 twimg 的地址 —— 别家站点未必这么编。 */
  function isInitSegment(url) {
    var s = String(url || '')
    if (!/\.mp4(?:$|[?#])/i.test(s)) return false
    try {
      var u = new URL(s)
      if (!/(^|\.)video\.twimg\.com$/i.test(u.hostname)) return false
      return /\/(?:vid|aud)\/[^/]+\/0\/0\//i.test(u.pathname)
    } catch (e) {
      return false
    }
  }

  return {
    contentTypeExt: contentTypeExt,
    hasKnownExt: hasKnownExt,
    withExt: withExt,
    origImageUrl: origImageUrl,
    isInitSegment: isInitSegment,
    CT_EXT: CT_EXT,
    KNOWN_EXTS: KNOWN_EXTS,
    WEB_TYPES: WEB_TYPES,
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = PanBoxRules