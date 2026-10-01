'use strict'

/**
 * PanBox 下载助手 —— 页面内悬浮面板（内容脚本）。
 *
 * 目的：像 Neat Download Manager 那样，在视频页 / 资源页的角落浮一个小按钮，
 * 上面写着「N 个文件」；点开就是这一页能下的东西（正在播的视频、页面里的文件链接、
 * 以及浏览器实际发出去过的媒体请求），点条目直接交给本机 PanBox。
 *
 * 三条实现原则：
 *   1. 只读页面，不改页面。所有 DOM 都塞进一个 Shadow DOM 里，绝不污染站点样式；
 *      任何一步出错都静默吞掉，宁可面板不出现，也不能让页面崩。
 *   2. 只有顶层框架画面板（iframe 里的视频会被子框架上报给后台脚本汇总），
 *      否则一个页面里会浮出好几个一模一样的按钮。
 *   3. blob: / data: 的媒体下不了 —— 那是页面用 MSE 自己喂给 <video> 的流，
 *      地址离开这个页面就不存在。面板会如实标出来，不假装能下。
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
   * 都会抛 "Extension context invalidated"。统一在这里挡掉。 */
  function ask(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError
          resolve(r || null)
        })
      } catch {
        resolve(null)
      }
    })
  }

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

  function kindOf(url) {
    const e = extOf(url)
    if (STREAM_EXT.test(url)) return 'stream'
    if (e === 'ts' || e === 'm4s') return 'segment'
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

  function nameOf(url, fallback) {
    const f = (fallback || '').trim()
    if (f && f.length <= 120) return f
    try {
      const u = new URL(url)
      let n = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
      if (!n || !/\.[a-z0-9]{1,6}$/i.test(n)) {
        for (const k of ['filename', 'file', 'name', 'download']) {
          const v = u.searchParams.get(k)
          if (v && /\.[a-z0-9]{1,6}$/i.test(v)) {
            n = v
            break
          }
        }
      }
      return n || hostOf(url) || 'download.bin'
    } catch {
      return 'download.bin'
    }
  }

  const KIND_LABEL = { stream: '播放列表', segment: '分片', media: '视频/音频', file: '文件' }

  /* ------------------------------------------------------------------ */
  /* 采集                                                                */
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
      out.push({
        url,
        name: nameOf(url, label),
        kind: forceKind || kindOf(url),
        host: hostOf(url),
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
  position: fixed; left: 12px; top: 12px; z-index: 2147483647;
  font: 12px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #e6e9ef; user-select: none;
}
.pill {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  background: linear-gradient(180deg, #2b3550, #1b2130);
  border: 1px solid #3a4560;
  border-radius: 999px; padding: 4px 10px 4px 8px;
  box-shadow: 0 4px 14px rgba(0,0,0,.45);
}
.pill:hover { border-color: #4c8dff; }
.pill .n { font-weight: 700; color: #8fb6ff; }
.pill .ico { width: 12px; height: 12px; display: block; }
.pill .x {
  margin-left: 2px; color: #8b94a7; padding: 0 3px; border-radius: 4px; cursor: pointer;
}
.pill .x:hover { color: #ff5b5b; background: rgba(255,91,91,.12); }
.card {
  margin-top: 6px; width: 340px; max-height: 60vh; display: flex; flex-direction: column;
  background: #171a21; border: 1px solid #3a4560; border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.55); overflow: hidden;
}
.card[hidden] { display: none; }
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
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;'
    const root = host.attachShadow({ mode: 'open' })
    const st = document.createElement('style')
    st.textContent = CSS
    root.appendChild(st)

    const wrap = document.createElement('div')
    wrap.className = 'wrap'
    wrap.innerHTML =
      '<div class="pill" part="pill">' +
      ICON +
      '<span><span class="n">0</span> 个文件</span>' +
      '<span class="x" title="在这个站点上隐藏（可在插件弹窗里恢复）">✕</span>' +
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

  if (!TOP) {
    /* iframe 只上报，不画界面：一个页面里浮出好几个面板只会让人烦。 */
    const report = async () => {
      const { items } = domItems()
      if (items.length) await ask({ type: 'items', items })
    }
    report()
    new MutationObserver(debounce(report, 1500)).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'href'],
    })
  } else {
    startPanel()
  }

  function debounce(fn, ms) {
    let t = 0
    return () => {
      clearTimeout(t)
      t = setTimeout(fn, ms)
    }
  }

  function startPanel() {
    let ui = null
    let items = []
    let blobCount = 0
    let hidden = false
    let open = false
    let lastSent = 0

    function ensure() {
      if (ui && ui.host.isConnected) return ui
      ui = buildUi()
      bind()
      return ui
    }

    function bind() {
      ui.pill.addEventListener('click', (e) => {
        if (e.target.classList.contains('x')) return
        if (!open && !items.length) return
        open = !open
        ui.card.hidden = !open
        if (open) refresh(true)
      })
      ui.pill.querySelector('.x').addEventListener('click', (e) => {
        e.stopPropagation()
        hidden = true
        ui.host.style.display = 'none'
        try {
          chrome.storage.local.set({ panelHidden: true })
        } catch {
          /* ignore */
        }
      })
      ui.close.addEventListener('click', () => {
        open = false
        ui.card.hidden = true
      })
      ui.refresh.addEventListener('click', () => refresh(true))
      ui.sendAll.addEventListener('click', () => sendItems(items, true))
      ui.head.addEventListener('pointerdown', startDrag)
      ui.list.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-url]')
        if (!btn) return
        const one = items.find((x) => x.url === btn.dataset.url)
        if (one) sendItems([one], false)
      })
    }

    /* ---- 位置：默认左上角，可拖动，记进 storage ---- */
    let drag = null
    function startDrag(e) {
      if (e.target.closest('button')) return
      const r = ui.wrap ? ui.wrap.getBoundingClientRect() : e.currentTarget.getBoundingClientRect()
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false }
      ui.host.style.left = r.left + 'px'
      ui.host.style.top = r.top + 'px'
      ui.host.style.right = 'auto'
      window.addEventListener('pointermove', onDrag, true)
      window.addEventListener('pointerup', endDrag, true)
      e.preventDefault()
    }
    function onDrag(e) {
      if (!drag) return
      drag.moved = true
      const w = ui.host.getBoundingClientRect()
      const x = Math.max(0, Math.min(window.innerWidth - Math.min(w.width, 60), e.clientX - drag.dx))
      const y = Math.max(0, Math.min(window.innerHeight - 24, e.clientY - drag.dy))
      ui.host.style.left = x + 'px'
      ui.host.style.top = y + 'px'
    }
    function endDrag() {
      window.removeEventListener('pointermove', onDrag, true)
      window.removeEventListener('pointerup', endDrag, true)
      if (drag && drag.moved) {
        try {
          chrome.storage.local.set({ panelPos: { left: ui.host.style.left, top: ui.host.style.top } })
        } catch {
          /* ignore */
        }
      }
      drag = null
    }

    /* ---- 渲染 ---- */
    function render() {
      ensure()
      ui.pillN.textContent = String(items.length)
      ui.cnt.textContent = items.length ? `这一页发现 ${items.length} 个` : ''
      if (!items.length) {
        ui.list.innerHTML = '<div class="empty">这一页暂时没发现能下的东西</div>'
        ui.note.hidden = true
      } else {
        ui.list.innerHTML = items
          .map(
            (it) =>
              '<div class="item"><span class="tag ' +
              it.kind +
              '">' +
              (KIND_LABEL[it.kind] || '文件') +
              '</span><span class="meta"><span class="nm" title="' +
              esc(it.name) +
              '">' +
              esc(trunc(it.name, 60)) +
              '</span><span class="sub">' +
              esc(trunc(it.host, 46)) +
              '</span></span><button data-url="' +
              esc(it.url) +
              '">下载</button></div>',
          )
          .join('')
        if (blobCount) {
          ui.note.hidden = false
          ui.note.textContent =
            '这一页还有 ' +
            blobCount +
            ' 个 blob: 流媒体（MSE 分片），地址离开页面就失效，只能下上面抓到的分片文件。'
        } else {
          ui.note.hidden = true
        }
      }
      ui.host.style.display = hidden || !items.length ? 'none' : ''
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      })
    }

    /* ---- 采集 + 合并后台脚本记下的媒体请求 ---- */
    async function refresh(showBusy) {
      const dom = domItems()
      blobCount = dom.blobCount
      const net = await ask({ type: 'mediaList' })
      const merged = dom.items.slice()
      const have = new Set(merged.map((x) => x.url))
      for (const it of (net && net.items) || []) {
        if (!it || !it.url || have.has(it.url)) continue
        have.add(it.url)
        merged.push({
          url: it.url,
          name: nameOf(it.url, ''),
          kind: it.kind || kindOf(it.url),
          host: hostOf(it.url),
        })
        if (merged.length >= 150) break
      }
      items = merged
      render()
      if (showBusy) ui.msg.textContent = `扫描完成：${items.length} 个`
    }

    async function sendItems(list, all) {
      if (!list.length) return
      ui.msg.textContent = '正在交给 PanBox…'
      const r = await ask({
        type: 'sendUrls',
        items: list.map((x) => ({ url: x.url, name: x.name })),
        referer: location.href,
        title: document.title,
      })
      const n = (r && r.count) || 0
      ui.msg.textContent = n
        ? `已交给 PanBox：${n} 个${all ? '（全部）' : ''}`
        : (r && r.message) || '投递失败：确认 PanBox 正在运行'
      lastSent = Date.now()
    }

    /* ---- 触发时机 ---- */
    chrome.storage.local.get({ panelHidden: false, panelPos: null, panel: true }, (got) => {
      hidden = !!got.panelHidden
      if (got.panel === false) hidden = true
      ensure()
      if (got.panelPos && got.panelPos.left) {
        ui.host.style.left = got.panelPos.left
        ui.host.style.top = got.panelPos.top
      }
      refresh(false)
    })

    document.addEventListener(
      'play',
      () => {
        refresh(false)
      },
      true,
    )

    new MutationObserver(
      debounce(() => {
        refresh(false)
      }, 1500),
    ).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] })

    /* 面板可见时每 5 秒刷一次网络媒体列表（播放器换码率会换地址） */
    setInterval(() => {
      if (open) refresh(false)
    }, 5000)
  }
})()
