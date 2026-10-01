'use strict'

const $ = (id) => document.getElementById(id)

function say(text, kind) {
  const el = $('msg')
  el.textContent = text || ''
  el.className = kind || ''
}

function ask(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve))
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab || null
}

async function refresh() {
  const s = await ask({ type: 'status' })
  const dot = $('dot')
  dot.className = 'dot ' + (s && s.alive ? 'on' : 'off')
  if (s && s.alive) {
    $('state').textContent = `已连接 PanBox · 127.0.0.1:${s.port}` + (s.paired ? '' : ' · 未配对')
  } else {
    $('state').textContent = '未连接：请先打开 PanBox（设置 → 浏览器插件 里能看到端口）'
  }
  $('port').value = s.port
  $('intercept').checked = !!(s && s.intercept)
  if (s && s.paired) $('token').placeholder = '已配对（令牌已保存在浏览器里）'
  return s
}

$('intercept').addEventListener('change', async (e) => {
  await ask({ type: 'set', intercept: e.target.checked })
  say(e.target.checked ? '已开启接管：浏览器的下载会自动转到 PanBox' : '已关闭接管', 'ok')
  refresh()
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

refresh()
