'use strict'

const $ = (id) => document.getElementById(id)

function say(text, kind) {
  const el = $('msg')
  el.textContent = text || ''
  el.className = kind || ''
}

/**
 * 给后台发消息并等回复。
 *
 * 两种情况下 `chrome.runtime.sendMessage` 会**同步抛**（不是回调 undefined）：
 * 后台没有监听者、或者扩展刚被重载 —— 不接住的话 `refresh()` 直接抛，
 * 弹窗永远停在「正在检测 PanBox…」，用户看着像插件坏了。
 * 回调那条路也可能永远不来，所以再挂一个兜底定时器。
 *
 * 超时按消息分档：`status/pair/set` 是本机一问一答（5 秒足够）；投递类要
 * 逐条 POST，几十个文件能跑十几秒，给 60 秒 —— 分档是为了「不假死」，
 * 不是为了催它，短超时用在投递上会让用户看到假的「投递失败」。
 */
const SLOW_MSGS = { sendPage: 1, sendUrls: 1, sendUrl: 1, pageContext: 1 }

function ask(msg, timeoutMs) {
  const limit = timeoutMs || (msg && SLOW_MSGS[msg.type] ? 60000 : 5000)
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), limit)
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        clearTimeout(timer)
        /* 读一下 lastError：不读的话「扩展上下文失效」这类错误只在控制台里响 */
        void chrome.runtime.lastError
        finish(r)
      })
    } catch (e) {
      clearTimeout(timer)
      void e
      finish(null)
    }
  })
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab || null
}

async function refresh() {
  /* 通道可能在「没回话」的情况下关闭（service worker 出错、扩展刚被重载），
   * 这时回调参数是 undefined —— 不给默认值，下面读 s.port 会抛，整个弹窗白屏。 */
  const s = (await ask({ type: 'status' })) || {}
  const dot = $('dot')
  dot.className = 'dot ' + (s.alive ? 'on' : 'off')
  if (s.alive) {
    $('state').textContent = `已连接 PanBox · 127.0.0.1:${s.port}` + (s.paired ? '' : ' · 未配对')
  } else {
    $('state').textContent = '未连接：请先打开 PanBox（设置 → 浏览器插件 里能看到端口）'
  }
  if (s.port) $('port').value = s.port
  $('intercept').checked = !!(s && s.intercept)
  $('panel').checked = !!(s && s.panel)
  $('sendPage').textContent = s && s.panel ? '把本页媒体 / 文件链接交给 PanBox' : '把本页文件链接交给 PanBox'
  if (s && s.paired) $('token').placeholder = '已配对（令牌已保存在浏览器里）'
  return s
}

$('intercept').addEventListener('change', async (e) => {
  await ask({ type: 'set', intercept: e.target.checked })
  say(e.target.checked ? '已开启接管：浏览器的下载会自动转到 PanBox' : '已关闭接管', 'ok')
  refresh()
})

$('panel').addEventListener('change', async (e) => {
  await ask({ type: 'set', panel: e.target.checked })
  if (e.target.checked) {
    /* 面板之前被 ✕ 关掉过的话，这里顺手把它放回来 */
    await chrome.storage.local.set({ panelHidden: false })
    say('已开启悬浮面板：回到网页就能看到「N 个文件」', 'ok')
  } else {
    say('已关闭悬浮面板', 'ok')
  }
  refresh()
})

$('resetPos').addEventListener('click', async () => {
  await chrome.storage.local.set({ panelPos: null })
  say('已重置：刷新页面后悬浮按钮回到左上角', 'ok')
})

$('port').addEventListener('change', async (e) => {
  await ask({ type: 'set', port: e.target.value })
  say('端口已改成 ' + e.target.value, 'ok')
  refresh()
})

$('token').addEventListener('change', async (e) => {
  await ask({ type: 'set', token: e.target.value.trim() })
  say('令牌已保存', 'ok')
  refresh()
})

$('pair').addEventListener('click', async () => {
  const r = await ask({ type: 'pair' })
  if (r && r.ok) say('配对成功', 'ok')
  else say('配对失败：确认 PanBox 正在运行', 'err')
  refresh()
})

$('sendPage').addEventListener('click', async () => {
  const tab = await activeTab()
  if (!tab) return say('没有活动标签页', 'err')
  say('正在投递…')
  const r = await ask({ type: 'sendPage', tabId: tab.id, referer: tab.url, title: tab.title })
  if (r && r.ok) say(`已投递 ${r.count} 个任务`, 'ok')
  else say((r && r.message) || '投递失败', 'err')
})

/* 分享页被反爬挡住时：把「浏览器此刻在这一页用的身份」交给 PanBox，
 * 它拿这份现场去取页就能过。地址以浏览器里真实的那个为准。 */
$('sendCtx').addEventListener('click', async () => {
  const tab = await activeTab()
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return say('这一页不是网页', 'err')
  say('正在交给 PanBox…')
  const r = await ask({ type: 'pageContext', url: tab.url, tabId: tab.id, title: tab.title })
  if (r && r.ok) say(`已交给 PanBox：${r.message || '可以直接解析这一页了'}`, 'ok')
  else say((r && r.message) || '投递失败', 'err')
  refresh()
})

refresh()
