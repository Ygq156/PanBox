'use strict'

/**
 * PanBox 下载助手 —— 页面内悬浮面板（内容脚本）。
 *
 * 目的：像 Neat Download Manager 那样，在视频页 / 资源页的角落浮一个小按钮，
 * 上面写着「N 个文件」；点开就是这一页能下的东西（正在播的视频、页面里的文件链接、
 * 以及浏览器实际发出去过的媒体请求），点条目直接交给本机 PanBox。
 *
 * 四条实现原则：
 *   1. 只读页面，不改页面。所有 DOM 都塞进一个 Shadow DOM 里，绝不污染站点样式；
 *      任何一步出错都静默吞掉，宁可面板不出现，也不能让页面崩。
 *   2. 只有顶层框架画面板（iframe 里的视频会被子框架上报给后台脚本汇总），
 *      否则一个页面里会浮出好几个一模一样的按钮。
 *   3. blob: / data: 的媒体下不了 —— 那是页面用 MSE 自己喂给 <video> 的流，
 *      地址离开这个页面就不存在。面板会如实标出来，不假装能下。
 *   4. **入口永远在**（v1.1.1 的教训）：✕ 只是「这一会儿先收起来」，不是永久关闭；
 *      一旦发现新的可下载内容、或者页面换了（SPA 换视频 / 换页），它自己会回来。
 *      想彻底关掉去插件弹窗里取消勾选。
 *   5. **位置随用户**（v1.1.2）：收起态的按钮和展开后的标题栏都能按住拖动，位置存进
 *      chrome.storage.local.panelPos，换页 / 刷新 / 重开浏览器都还在。以前 .wrap 自己是
 *      position:fixed，改 host 的 left/top 根本挪不动它 —— 看着能拖其实钉死在左上角。
 */

;(function () {
  if (window.__panboxPanelLoaded) return
  window.__panboxPanelLoaded = true

  const TOP = (() => {
    try {
      return window.top === window
    } catch {
      return false
    }
  })()

  /* 扩展被重新加载后，旧页面里的内容脚本会失去上下文 —— 那时所有 chrome.* 调用
   * 都会抛 "Extension context invalidated"。统一在这里挡掉。
   * 还要加超时：refresh() 靠一个 busy 标志防重入，回复永远不来时 busy 会一直挂着，
   * 面板从此再也不刷新（用户只看到一份再也不动的列表）。 */
  function ask(msg) {
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        resolve(v || null)
      }
      const timer = setTimeout(() => finish(null), 8000)
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          clearTimeout(timer)
          void chrome.runtime.lastError
          finish(r)
        })
      } catch {
        clearTimeout(timer)
        finish(null)
      }
    })
  }

  function storageGet(defs) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(defs, (got) => {
          void chrome.runtime.lastError
          resolve(got || defs)
        })
      } catch {
        resolve(defs)
      }
    })
  }

  function storageRemove(key) {
    try {
      chrome.storage.local.remove(key)
    } catch {
      /* ignore */
    }
  }

  /* v1.1.0 的 ✕ 会写 panelHidden:true 造成「关了就再也不出现」。
   * 语义已经改成「临时收起」，这个键作废，见到就清掉，免得老用户升级后被它永久压住。 */
  storageRemove('panelHidden')

  const MEDIA_EXT =
    /\.(mp4|m4v|mkv|webm|flv|mov|avi|wmv|ts|m4s|m3u8|mpd|mp3|m4a|flac|wav|aac|ogg|opus|ape|wma)(?:$|[?#])/i
  const FILE_EXT =
    /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|img|exe|msi|apk|ipa|dmg|pkg|deb|rpm|pdf|epub|mobi|azw3|torrent|bin|jar|crx|whl|onnx|safetensors|gguf|part\d*)(?:$|[?#])/i
  const STREAM_EXT = /\.(m3u8|mpd)(?:$|[?#])/i

  function extOf(url) {
    try {
      const p = new URL(url).pathname
      const m = /\.([a-z0-9]{1,6})$/i.exec(p)
      return m ? m[1].toLowerCase() : ''
    } catch {
      return ''
    }
  }

  function isHttp(u) {
    return /^https?:/i.test(u || '')
  }

  function kindOf(url, ct) {
    const c = String(ct || '')
    if (STREAM_EXT.test(url)) return 'stream'
    if (/^application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)/i.test(c)) return 'stream'
    const e = extOf(url)
    if (e === 'ts' || e === 'm4s') return 'segment'
    if (/^(video|audio)\//i.test(c)) return 'media'
    if (MEDIA_EXT.test(url)) return 'media'
    return 'file'
  }

  function hostOf(url) {
    try {
      return new URL(url).host
    } catch {
      return ''
    }
  }

  /* 抖音的视频地址长这样：
   *   https://v3-web.douyinvod.com/xxxx/video/tos/cn/tos-cn-ve-15/yyyy/?a=6383&mime_type=video_mp4
   * 路径里没有扩展名，所以名字得靠 Content-Type 补出来，否则存下来的是个没后缀的文件。 */
  const KIND_EXT = { media: 'mp4', stream: 'm3u8', segment: 'ts', file: 'bin' }

  function pickExt(url, kind, ct) {
    const e = extOf(url)
    if (e) return e
    const c = String(ct || '')
    if (/^audio\//i.test(c)) {
      if (/mpeg/i.test(c)) return 'mp3'
      if (/webm|ogg/i.test(c)) return 'ogg'
      if (/wav/i.test(c)) return 'wav'
      return 'm4a'
    }
    if (/^video\//i.test(c)) {
      if (/webm/i.test(c)) return 'webm'
      if (/quicktime/i.test(c)) return 'mov'
      if (/matroska/i.test(c)) return 'mkv'
      return 'mp4'
    }
    if (/mpegurl/i.test(c)) return 'm3u8'
    if (/dash\+xml/i.test(c)) return 'mpd'
    /* PDF 这类「文档」以前落到最后的 'bin'，面板上就叫成 `3345768.bin` —— 名字对不上
     * 真实文件（ACM 的 `…/epdf/10.1145/3345768.3355908` 就是这种地址）。 */
    if (/^application\/(pdf|x-pdf)/i.test(c)) return 'pdf'
    if (/^application\/(zip|x-zip-compressed|x-7z-compressed|x-rar-compressed)/i.test(c)) {
      return /7z/.test(c) ? '7z' : /rar/.test(c) ? 'rar' : 'zip'
    }
    if (/^application\/(x-msdownload|x-msdos-program)/i.test(c)) return 'exe'
    if (/^application\/(x-tar|gzip|x-gzip)/i.test(c)) return /tar/.test(c) ? 'tar' : 'gz'
    if (/^application\/(vnd\.android\.package-archive)/i.test(c)) return 'apk'
    if (/^application\/(epub\+zip)/i.test(c)) return 'epub'
    if (/^application\/(msword)/i.test(c)) return 'doc'
    if (/^application\/(vnd\.openxmlformats-officedocument\.wordprocessingml\.document)/i.test(c)) return 'docx'
    if (/^application\/(vnd\.ms-excel)/i.test(c)) return 'xls'
    if (/^application\/(vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)/i.test(c)) return 'xlsx'
    if (/^application\/(vnd\.ms-powerpoint)/i.test(c)) return 'ppt'
    if (/^application\/(vnd\.openxmlformats-officedocument\.presentationml\.presentation)/i.test(c)) return 'pptx'
    if (/^application\/(x-iso9660-image)/i.test(c)) return 'iso'
    /* 下载入口（蓝奏那类藏在 `/fn?TOKEN` 页里的分享入口）**不是文件**：
     * 名字要等 PanBox 打开分享页才知道，这里硬猜一个后缀只会让面板显示
     * 「fn.bin」这种假名字，所以宁可留空。 */
    if (kind === 'entry') return ''
    return KIND_EXT[kind] || 'bin'
  }

  function nameOf(url, fallback, kind, ct) {
    const f = String(fallback || '')
      .trim()
      .replace(/\s+/g, ' ')
    const ext = pickExt(url, kind, ct)
    try {
      const u = new URL(url)
      for (const k of ['filename', 'file', 'name', 'download', 'title']) {
        const v = u.searchParams.get(k)
        if (v && /\.[a-z0-9]{1,6}$/i.test(v)) {
          return clean(decodeURIComponent(v), ext)
        }
      }
      if (f && /\.[a-z0-9]{1,6}$/i.test(f)) return clean(f, ext)
      let n = ''
      try {
        n = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
      } catch {
        n = u.pathname.split('/').filter(Boolean).pop() || ''
      }
      n = n.replace(/\.[a-z0-9]{1,6}$/i, '')
      if (!n || n.length > 50 || /^[0-9a-f]{16,}$/i.test(n) || /^\d+$/.test(n)) {
        n = hostOf(url).replace(/^www\./, '')
      }
      if (f) n = f.slice(0, 60) || n
      return clean(n, ext)
    } catch {
      return clean(f, ext)
    }
  }

  function clean(base, ext) {
    let n = String(base || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/^[.\s]+/, '')
      .trim()
    n = n.replace(/\.[a-z0-9]{1,6}$/i, '')
    if (!n) n = 'download'
    if (n.length > 70) n = n.slice(0, 70)
    /* ext 为空 = 「还不知道是什么文件」（见 pickExt 的 entry 分支），别拼出 `名字.` */
    return ext ? n + '.' + ext : n
  }

  function fmtSize(n) {
    n = Number(n) || 0
    if (!n) return ''
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  const KIND_LABEL = { stream: '播放列表', segment: '分片', media: '视频/音频', file: '文件', entry: '下载入口' }

  /* ------------------------------------------------------------------ */
  /* 采集（DOM 侧）                                                       */
  /* ------------------------------------------------------------------ */

  function domItems() {
    const out = []
    const seen = new Set()
    let blobCount = 0

    function push(url, label, forceKind) {
      if (!url) return
      if (/^blob:/i.test(url) || /^data:/i.test(url)) {
        blobCount += 1
        return
      }
      if (!isHttp(url) || seen.has(url)) return
      seen.add(url)
      const kind = forceKind || kindOf(url, '')
      out.push({
        url,
        name: nameOf(url, label, kind, ''),
        kind,
        host: hostOf(url),
        size: 0,
        ct: '',
      })
    }

    try {
      for (const el of document.querySelectorAll('video, audio')) {
        push(el.currentSrc, '', 'media')
        push(el.getAttribute('src'), '', 'media')
        for (const s of el.querySelectorAll('source')) push(s.getAttribute('src'), '', 'media')
      }
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href
        if (!isHttp(href)) continue
        const isDl = a.hasAttribute('download')
        if (MEDIA_EXT.test(href) || isDl) push(href, a.getAttribute('download') || a.textContent, '')
        else if (FILE_EXT.test(href)) push(href, a.getAttribute('download') || a.textContent, 'file')
        if (out.length >= 120) break
      }
    } catch {
      /* 页面结构千奇百怪，采不到就算了 */
    }
    return { items: out, blobCount }
  }

  /* ------------------------------------------------------------------ */
  /* 面板（只有顶层框架画）                                               */
  /* ------------------------------------------------------------------ */

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: relative; z-index: 2147483647;
  font: 12px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #e6e9ef; user-select: none;
}
.pill {
  display: flex; align-items: center; gap: 6px; cursor: grab;
  background: linear-gradient(180deg, #2b3550, #1b2130);
  border: 1px solid #3a4560;
  border-radius: 999px; padding: 4px 10px 4px 8px;
  box-shadow: 0 4px 14px rgba(0,0,0,.45);
}
.pill.dragging { cursor: grabbing; }
.pill:hover { border-color: #4c8dff; }
.pill .n { font-weight: 700; color: #8fb6ff; }
.pill .ico { width: 12px; height: 12px; display: block; }
.pill .x {
  margin-left: 2px; color: #8b94a7; padding: 0 3px; border-radius: 4px; cursor: pointer;
}
.pill .x:hover { color: #ff5b5b; background: rgba(255,91,91,.12); }
.card {
  position: relative;
  margin-top: 6px; width: 360px; height: 330px;
  display: flex; flex-direction: column;
  background: #171a21; border: 1px solid #3a4560; border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.55); overflow: hidden;
}
.card[hidden] { display: none; }
/* 右下角拉大小（自己画，不用浏览器那个 resize 角 —— 它的样子改不了，
   和面板配色对不上）。按住它调宽高，松手记住。 */
.grip {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize; z-index: 2; touch-action: none;
  background: linear-gradient(135deg, transparent 46%, #46506a 46%, #46506a 58%, transparent 58%,
    transparent 68%, #46506a 68%, #46506a 80%, transparent 80%);
}
.grip:hover { filter: brightness(1.35); }
.grip:focus-visible { outline: 1px solid #4c8dff; outline-offset: -2px; }
.head {
  display: flex; align-items: center; gap: 6px; padding: 7px 9px;
  background: #1d222c; border-bottom: 1px solid #262b36; cursor: move;
}
.head b { font-size: 12px; color: #8fb6ff; }
.head .grow { flex: 1; }
.head button, .foot button {
  font: 11px/1 "Segoe UI", "Microsoft YaHei", sans-serif; cursor: pointer;
  background: #232833; color: #e6e9ef; border: 1px solid #333a48;
  border-radius: 5px; padding: 4px 8px;
}
.head button.pri, .foot button.pri { background: #4c8dff; border-color: #4c8dff; color: #fff; }
.head button:hover, .foot button:hover { filter: brightness(1.15); }
.list { overflow-y: auto; overscroll-behavior: contain; }
.list::-webkit-scrollbar { width: 8px; }
.list::-webkit-scrollbar-thumb { background: #333a48; border-radius: 4px; }
.item {
  display: flex; align-items: center; gap: 7px; padding: 6px 9px;
  border-bottom: 1px solid #21262f;
}
.item:hover { background: #1c212b; }
.item .meta { flex: 1; min-width: 0; }
.item .nm {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #e6e9ef;
}
.item .sub { font-size: 10.5px; color: #7b8497; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag {
  flex: 0 0 auto; font-size: 10px; padding: 1px 5px; border-radius: 4px;
  background: #24304a; color: #8fb6ff; border: 1px solid #33405e;
}
.tag.stream { background: #3a2b16; color: #ffbe6a; border-color: #5a431f; }
.tag.segment { background: #2c2440; color: #c0a6ff; border-color: #443a63; }
.item button {
  flex: 0 0 auto; font: 11px/1 "Segoe UI", sans-serif; cursor: pointer;
  background: #232833; color: #e6e9ef; border: 1px solid #333a48; border-radius: 5px; padding: 4px 8px;
}
.item button:hover { background: #4c8dff; border-color: #4c8dff; color: #fff; }
.empty { padding: 12px 10px; color: #7b8497; text-align: center; }
.note { padding: 6px 9px; color: #ffbe6a; font-size: 10.5px; border-bottom: 1px solid #21262f; }
.foot { display: flex; align-items: center; gap: 6px; padding: 6px 9px; border-top: 1px solid #262b36; background: #1a1f28; }
.foot .msg { flex: 1; font-size: 10.5px; color: #7b8497; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`

  const ICON =
    '<svg class="ico" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 3v11m0 0 4.5-4.5M12 14l-4.5-4.5M4.5 18.5h15" stroke="#8fb6ff" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'

  function buildUi() {
    const host = document.createElement('div')
    host.id = '__panbox_panel_host'
    /* 位置只由 host 决定（.wrap 是 position:relative）——
     * 以前 .wrap 自己也是 position:fixed，于是 host.style.left/top 根本挪不动它，
     * 面板/按钮看着能拖其实钉在左上角。 */
    host.style.cssText = 'all: initial; position: fixed; left: 12px; top: 12px; z-index: 2147483647;'
    const root = host.attachShadow({ mode: 'open' })
    const st = document.createElement('style')
    st.textContent = CSS
    root.appendChild(st)

    const wrap = document.createElement('div')
    wrap.className = 'wrap'
    wrap.innerHTML =
      '<div class="pill" part="pill" title="按住可以拖到别处；点一下展开面板">' +
      ICON +
      '<span><span class="n">0</span> 个文件</span>' +
      '<span class="x" title="暂时收起（发现新内容或页面切换后会自动再出现；想永久关掉请点插件图标）">✕</span>' +
      '</div>' +
      '<div class="card" hidden>' +
      '<div class="head">' +
      '<b>PanBox</b><span class="cnt" style="color:#7b8497"></span><span class="grow"></span>' +
      '<button class="pri sendAll">全部交给 PanBox</button>' +
      '<button class="refresh" title="重新扫描">↻</button>' +
      '<button class="close" title="收起">—</button>' +
      '</div>' +
      '<div class="note" hidden></div>' +
      '<div class="list"></div>' +
      '<div class="grip" role="separator" tabindex="0" title="按住拖动可调整面板大小"></div>' +
      '<div class="foot"><span class="msg">点条目右边的「下载」即可转到 PanBox</span></div>' +
      '</div>'
    root.appendChild(wrap)
    ;(document.body || document.documentElement).appendChild(host)

    const el = (s) => root.querySelector(s)
    return {
      host,
      root,
      wrap,
      pill: el('.pill'),
      pillN: el('.pill .n'),
      card: el('.card'),
      cnt: el('.cnt'),
      list: el('.list'),
      grip: el('.grip'),
      note: el('.note'),
      msg: el('.msg'),
      sendAll: el('.sendAll'),
      refresh: el('.refresh'),
      close: el('.close'),
      head: el('.head'),
    }
  }

  function trunc(s, n) {
    s = String(s || '')
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }

  function debounce(fn, ms) {
    let t = 0
    return () => {
      clearTimeout(t)
      t = setTimeout(fn, ms)
    }
  }

  if (!TOP) {
    /* iframe 只上报，不画界面：一个页面里浮出好几个面板只会让人烦。
     * 定时上报是必须的 —— 播放器换集 / SPA 换内容不会触发 DOM 变更事件。 */
    const report = async () => {
      const { items } = domItems()
      if (items.length) await ask({ type: 'items', items })
    }
    report()
    setInterval(report, 5000)
    try {
      new MutationObserver(debounce(report, 1200)).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'href'],
      })
    } catch {
      /* ignore */
    }
    return
  }

  startPanel()

  function startPanel() {
    let ui = null
    let items = []
    let blobCount = 0
    let globalOff = false /* 插件弹窗里关掉了面板 */
    let hiddenNow = false /* 刚点了 ✕，暂时收起 */
    let hiddenUrls = new Set()
    let hiddenAt = 0
    let open = false
    let domCache = []
    let blobCache = 0
    let lastDom = 0
    let lastHref = location.href
    let busy = false

    function ensure() {
      if (ui && ui.host.isConnected) return ui
      ui = buildUi()
      bind()
      return ui
    }

    function bind() {
      ui.pill.addEventListener('click', (e) => {
        if (e.target.classList.contains('x')) return
        /* 拖动结束时浏览器还会补一个 click，别把它当成「点开面板」 */
        if (Date.now() < suppressClickUntil) return
        toggleCard()
      })
      /* ✕ = 这一会儿先收起来，不是永久关闭。
       * 以前这里往 storage 写 panelHidden:true，用户点一次面板就再也不出现（被投诉过）。 */
      ui.pill.querySelector('.x').addEventListener('click', (e) => {
        e.stopPropagation()
        hiddenNow = true
        hiddenAt = Date.now()
        hiddenUrls = new Set(items.map((x) => x.url))
        open = false
        ui.card.hidden = true
        ui.host.style.display = 'none'
      })
      ui.close.addEventListener('click', () => {
        open = false
        ui.card.hidden = true
      })
      ui.refresh.addEventListener('click', () => refresh(true, { dom: true }))
      ui.sendAll.addEventListener('click', () => sendItems(items, true))
      /* 标题栏与那个收起状态的小按钮都能拖 —— 用户点名说「按钮没办法挪动」 */
      ui.head.addEventListener('pointerdown', startDrag)
      ui.pill.addEventListener('pointerdown', startDrag)
      /* 右下角那个把手只管「拉大小」，别让它顺手把面板也拖走 */
      ui.grip.addEventListener('pointerdown', startResize)
      ui.grip.addEventListener('keydown', onGripKey)
      window.addEventListener('resize', keepInView)
      ui.list.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-url]')
        if (!btn) return
        const one = items.find((x) => x.url === btn.dataset.url)
        if (one) sendItems([one], false)
      })
    }

    /* ---- 位置：默认左上角，pill（收起态的小按钮）与面板标题栏都能拖，位置记进 storage ---- */
    let drag = null
    let suppressClickUntil = 0

    function toggleCard() {
      open = !open
      ui.card.hidden = !open
      if (open) refresh(true)
    }
    function setHostPos(x, y) {
      ui.host.style.left = Math.round(x) + 'px'
      ui.host.style.top = Math.round(y) + 'px'
      ui.host.style.right = 'auto'
      ui.host.style.bottom = 'auto'
    }
    function clampPos(x, y, w, h) {
      const maxX = Math.max(0, window.innerWidth - w)
      const maxY = Math.max(0, window.innerHeight - h)
      return [Math.min(Math.max(0, x), maxX), Math.min(Math.max(0, y), maxY)]
    }
    /* 窗口变小 / 换显示器后，别把面板留在屏幕外，也别让拉过的面板比窗口还大 */
    function keepInView() {
      if (!ui || !ui.host.isConnected) return
      if (!ui.card.hidden) {
        const w = parseFloat(ui.card.style.width)
        const h = parseFloat(ui.card.style.height)
        /* 记下来的尺寸可能是在大屏上拉的，换到小窗口就得收回来 */
        if (w || h) {
          const [cw, ch] = clampCardSize(w || ui.card.getBoundingClientRect().width, h || ui.card.getBoundingClientRect().height)
          ui.card.style.width = cw + 'px'
          ui.card.style.height = ch + 'px'
        }
      }
      const r = ui.host.getBoundingClientRect()
      const [x, y] = clampPos(r.left, r.top, Math.min(r.width, window.innerWidth), Math.min(r.height, window.innerHeight))
      setHostPos(x, y)
    }
    function startDrag(e) {
      if (e.button !== 0) return
      if (e.target.closest && e.target.closest('button')) return
      if (e.target.classList && e.target.classList.contains('x')) return /* ✕ 是「临时收起」，不是拖拽把手 */
      const box = (ui.card.hidden ? ui.pill : ui.host).getBoundingClientRect()
      drag = {
        dx: e.clientX - box.left,
        dy: e.clientY - box.top,
        sx: e.clientX,
        sy: e.clientY,
        w: box.width,
        h: box.height,
        moved: false,
        /* pill = 点一下开合面板，所以「没移动」要当成点击；标题栏只管拖 */
        toggle: e.currentTarget === ui.pill,
      }
      window.addEventListener('pointermove', onDrag, true)
      window.addEventListener('pointerup', endDrag, true)
      window.addEventListener('pointercancel', endDrag, true)
    }
    function onDrag(e) {
      if (!drag) return
      /* 3px 以内当作手抖，仍然算点击 */
      if (!drag.moved && Math.abs(e.clientX - drag.sx) < 3 && Math.abs(e.clientY - drag.sy) < 3) return
      if (!drag.moved) {
        drag.moved = true
        ui.pill.classList.add('dragging')
      }
      const [x, y] = clampPos(e.clientX - drag.dx, e.clientY - drag.dy, drag.w, drag.h)
      setHostPos(x, y)
      e.preventDefault()
    }
    function endDrag() {
      window.removeEventListener('pointermove', onDrag, true)
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', endDrag, true)
      const d = drag
      drag = null
      ui.pill.classList.remove('dragging')
      if (!d) return
      if (d.moved) {
        try {
          chrome.storage.local.set({ panelPos: { left: ui.host.style.left, top: ui.host.style.top } })
        } catch {
          /* ignore */
        }
        /* 拖完浏览器会补一个 click，别让它顺手把面板也打开/关掉 */
        suppressClickUntil = Date.now() + 500
      } else if (d.toggle) {
        suppressClickUntil = Date.now() + 500
        toggleCard() /* 点一下 = 开合面板（click 处理器会被上面的时间戳挡住） */
      }
    }

    /* ---- 大小：右下角把手拖宽高，松手记进 storage ----
     * 面板宽度以前是写死的 360px，稍长一点的文件名就被截成「…」，用户看不到自己
     * 要下的是哪个（提过这个意见）。现在按自己的需要拉，尺寸跟着用户走。 */
    const CARD_MIN = { w: 260, h: 140 }
    let resize = null

    function clampCardSize(w, h) {
      return [
        Math.min(Math.max(CARD_MIN.w, Math.round(w)), Math.max(CARD_MIN.w, window.innerWidth - 24)),
        Math.min(Math.max(CARD_MIN.h, Math.round(h)), Math.max(CARD_MIN.h, window.innerHeight - 60)),
      ]
    }
    function applyCardSize(w, h) {
      const [cw, ch] = clampCardSize(w, h)
      ui.card.style.width = cw + 'px'
      ui.card.style.height = ch + 'px'
    }
    function startResize(e) {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const r = ui.card.getBoundingClientRect()
      resize = { sx: e.clientX, sy: e.clientY, sw: r.width, sh: r.height }
      try {
        e.target.setPointerCapture(e.pointerId)
      } catch {
        /* 拿不到捕获也不要紧，下面还挂了 window 监听 */
      }
      window.addEventListener('pointermove', onResize, true)
      window.addEventListener('pointerup', endResize, true)
      window.addEventListener('pointercancel', endResize, true)
    }
    function onResize(e) {
      if (!resize) return
      e.preventDefault()
      applyCardSize(resize.sw + (e.clientX - resize.sx), resize.sh + (e.clientY - resize.sy))
    }
    function endResize() {
      window.removeEventListener('pointermove', onResize, true)
      window.removeEventListener('pointerup', endResize, true)
      window.removeEventListener('pointercancel', endResize, true)
      if (!resize) return
      resize = null
      keepInView()
      const w = ui.card.style.width
      const h = ui.card.style.height
      if (w && h) {
        try {
          chrome.storage.local.set({ panelSize: { w, h } })
        } catch {
          /* ignore */
        }
      }
      /* 拉完浏览器也会补一个 click，别让它把面板收起来 */
      suppressClickUntil = Date.now() + 300
    }
    /* 键盘也能调：把手拿到焦点后方向键微调，按住 Shift 步子大一点。
       把手是这面板上唯一能改大小的地方，只用鼠标的话够不着键盘用户。 */
    function onGripKey(e) {
      const step = e.shiftKey ? 40 : 10
      const r = ui.card.getBoundingClientRect()
      const map = {
        ArrowRight: [r.width + step, r.height],
        ArrowLeft: [r.width - step, r.height],
        ArrowDown: [r.width, r.height + step],
        ArrowUp: [r.width, r.height - step],
      }
      const d = map[e.key]
      if (!d) return
      e.preventDefault()
      applyCardSize(d[0], d[1])
      keepInView()
      const w = ui.card.style.width
      const h = ui.card.style.height
      if (w && h) {
        try {
          chrome.storage.local.set({ panelSize: { w, h } })
        } catch {
          /* ignore */
        }
      }
    }

    /* ---- 渲染 ---- */
    /* 列表只在「内容真的变了」时才重建。以前每次刷新都把整段 innerHTML 重写一遍，
     * 于是每 2 秒闪一下：正在看列表的人会被打断，滚动位置也会跳回顶部。 */
    let listSig = ''
    function render() {
      ensure()
      ui.pillN.textContent = String(items.length)
      ui.cnt.textContent = items.length ? `这一页发现 ${items.length} 个` : ''
      const sig =
        items.length +
        '|' +
        blobCount +
        '|' +
        items.map((x) => x.url + '|' + x.kind + '|' + x.name + '|' + x.size).join('~')
      if (sig === listSig) return
      listSig = sig
      if (!items.length) {
        ui.list.innerHTML = '<div class="empty">这一页暂时没发现能下的东西</div>'
        ui.note.hidden = true
      } else {
        ui.list.innerHTML = items
          .map((it) => {
            const sub = [it.host, fmtSize(it.size)].filter(Boolean).join(' · ')
            return (
              '<div class="item"><span class="tag ' +
              it.kind +
              '">' +
              (KIND_LABEL[it.kind] || '文件') +
              '</span><span class="meta"><span class="nm" title="' +
              esc(it.name) +
              '">' +
              esc(trunc(it.name, 58)) +
              '</span><span class="sub">' +
              esc(trunc(sub || it.host, 52)) +
              '</span></span><button data-url="' +
              esc(it.url) +
              '">下载</button></div>'
            )
          })
          .join('')
        if (blobCount) {
          ui.note.hidden = false
          ui.note.textContent =
            '这一页还有 ' +
            blobCount +
            ' 个 blob: 流媒体（MSE 分片）。' +
            (items.some((x) => x.kind === 'media' && x.size > 200 * 1024)
              ? '已经抓到可直接下载的整段视频，优先下它。'
              : '地址离开页面就失效，只能下上面抓到的分片。')
        } else {
          ui.note.hidden = true
        }
      }
      /* 入口默认一直在（哪怕暂时 0 个），这样用户永远找得到它 —— NDM 也是这样。
       * 只有两种情况才真的藏起来：插件弹窗里关掉了，或者用户刚点了 ✕（临时收起）。 */
      ui.host.style.display = globalOff || hiddenNow ? 'none' : ''
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      })
    }

    /* ---- 采集 + 合并后台脚本记下的媒体请求 ---- */
    async function refresh(showBusy, opts) {
      if (busy) return
      busy = true
      try {
        const now = Date.now()
        const wantDom = (opts && opts.dom) || now - lastDom > 4000
        if (wantDom) {
          const dom = domItems()
          domCache = dom.items
          blobCache = dom.blobCount
          lastDom = now
        }
        blobCount = blobCache
        const net = await ask({ type: 'mediaList' })

        const merged = domCache.slice()
        const have = new Set(merged.map((x) => x.url))
        for (const it of (net && net.items) || []) {
          if (!it || !it.url || have.has(it.url)) continue
          have.add(it.url)
          const kind = it.kind || kindOf(it.url, it.ct)
          merged.push({
            url: it.url,
            /* 服务器在 Content-Disposition 里给的文件名最准，其次才是地址里猜的 */
            name: it.name || nameOf(it.url, '', kind, it.ct),
            kind,
            host: hostOf(it.url),
            size: Number(it.size) || 0,
            ct: it.ct || '',
          })
          if (merged.length >= 200) break
        }
        /* 直接能下的整段视频排最前（并按体积降序），别让几十个 3KB 的 MSE 分片
         * 把抖音/B 站那个真正要下的文件淹掉。
         * ⚠️ 这张表必须和后台 `mediaListView` 里那张**逐项一致**：`entry`（下载入口，
         * 蓝奏那类站点的真身在 `/fn?TOKEN` 页里）后台给的是 -1、排最前，这里以前漏了
         * entry，落到 `?? 9` 就成了**排最后** —— 面板把最该点的入口压到两百条底下。 */
        const rank = { entry: -1, media: 0, stream: 1, segment: 2, file: 3 }
        merged.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || (b.size || 0) - (a.size || 0))
        items = merged

        /* ✕ 只是临时收起：一旦出现「隐藏时还没有的」新东西，面板自己回来。 */
        if (hiddenNow && Date.now() - hiddenAt > 1200) {
          const fresh = items.find((x) => !hiddenUrls.has(x.url))
          if (fresh) {
            hiddenNow = false
            ui.msg.textContent = '发现新的可下载内容，面板已自动打开'
            ensure()
          }
        }

        render()
        if (showBusy) ui.msg.textContent = `扫描完成：${items.length} 个`
      } finally {
        busy = false
      }
    }

    async function sendItems(list, all) {
      if (!list.length) return
      ensure()
      ui.msg.textContent = '正在交给 PanBox…'
      const r = await ask({
        type: 'sendUrls',
        items: list.map((x) => ({ url: x.url, name: x.name, ct: x.ct || '' })),
        referer: location.href,
        title: document.title,
      })
      const n = (r && r.count) || 0
      ui.msg.textContent = n
        ? `已交给 PanBox：${n} 个${all ? '（全部）' : ''}`
        : (r && r.message) || '投递失败：确认 PanBox 正在运行'
    }

    /* ---- SPA：抖音这种换视频不刷文档，得自己发现 ---- */
    function onNavigate() {
      hiddenNow = false
      hiddenUrls = new Set()
      open = false
      if (ui) ui.card.hidden = true
      lastDom = 0
      domCache = []
      items = []
      refresh(true, { dom: true })
    }
    const onNavigateSoon = debounce(onNavigate, 400)

    window.addEventListener('popstate', onNavigateSoon, true)
    window.addEventListener('hashchange', onNavigateSoon, true)
    /* 后台脚本用 webNavigation 抓到的导航（pushState/replaceState）会转告过来 */
    try {
      chrome.runtime.onMessage.addListener((m) => {
        if (m && m.type === 'panbox:navigated') {
          lastDom = 0
          onNavigateSoon()
        }
      })
    } catch {
      /* ignore */
    }

    /* ---- 启动 ---- */
    storageGet({ panel: true, panelPos: null, panelSize: null }).then((got) => {
      globalOff = got.panel === false
      ensure()
      if (got.panelSize) {
        const w = parseFloat(got.panelSize.w)
        const h = parseFloat(got.panelSize.h)
        if (w > 0 && h > 0) applyCardSize(w, h)
      }
      if (got.panelPos && got.panelPos.left) {
        const px = parseFloat(got.panelPos.left)
        const py = parseFloat(got.panelPos.top)
        const r = ui.pill.getBoundingClientRect()
        const [x, y] = clampPos(px || 12, py || 12, r.width || 90, r.height || 24)
        setHostPos(x, y)
      }
      refresh(false, { dom: true })
    })

    /* 播放器开始播 = 有新视频，立刻重扫 */
    document.addEventListener(
      'play',
      () => {
        refresh(false, { dom: false })
      },
      true,
    )

    /* DOM 变了（换集、翻页、加载出新的下载链接）→ 重扫 DOM */
    try {
      new MutationObserver(
        debounce(() => {
          refresh(false, { dom: true })
        }, 1200),
      ).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'href'],
      })
    } catch {
      /* ignore */
    }

    /* 常驻轮询：不管面板开着还是收起，都对一次网络媒体列表 + 看看地址有没有变。
     * v1.1.0 只在面板展开时每 5 秒刷一次，于是「网页换了内容面板却不刷新」。
     * 面板没展开时没人盯着看，就不必那么勤 —— 4 秒一次足够，也少一点页面里
     * 的定时开销（列表内容没变时 render 不会再动 DOM）。
     *
     * 用「每轮自己排下一次」的 setTimeout 而不是 setInterval：间隔要看**当前**展开状态，
     * 而 setInterval 的周期在建立时就定死了 —— 之前写成 `open ? 2000 : 4000`，
     * 展开面板永远不会变勤。顺带每轮都摸一次 DOM，用户没在看的面板少跑一半。 */
  let pollTimer = 0
  const poll = () => {
    pollTimer = setTimeout(() => {
      try {
        if (!document.hidden || open) {
          if (location.href !== lastHref) {
            lastHref = location.href
            onNavigateSoon()
          } else {
            refresh(false, { dom: false })
          }
        }
      } finally {
        /* 用 finally 排下一轮：中间万一抛了，轮询也不会就此断掉 */
        poll()
      }
    }, open ? 2000 : 4000)
  }
  poll()
  /* 标签页关掉/插件卸载时收掉定时器：不然每开过一个页面的 iframe 都留一个
   * 永不回头的定时器（MV3 的 worker 也就一直收不回去）。 */
  window.addEventListener('pagehide', () => clearTimeout(pollTimer), { once: true })
}
})()
