import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, formatEta, formatSize, formatSpeed } from './api'
import type { DownloadTask, ParseResult, Settings, Aria2Status } from './types'

/* ------------------------------------------------------------------ */
/* 设置弹窗                                                             */
/* ------------------------------------------------------------------ */

const NETDISK_LABEL: Record<string, string> = {
  lanzou: '蓝奏云',
  ilanzou: '蓝奏云优享版',
  'lanzou-xy': '蓝奏云优享版',
  quark: '夸克网盘',
  uc: 'UC网盘',
  baidu: '百度网盘',
  xunlei: '迅雷云盘',
  aliyun: '阿里云盘',
  '123pan': '123云盘',
  direct: '直链',
  unknown: '未知',
}

const LOGIN_TARGETS = ['baidu', 'quark', 'uc', 'xunlei']

function SettingsModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Settings
  onClose: () => void
  onSaved: (s: Settings) => void
}) {
  const [s, setS] = useState<Settings>(initial)
  const [busy, setBusy] = useState(false)
  const [cookieKey, setCookieKey] = useState('baidu')
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginMsg, setLoginMsg] = useState('')

  const patch = (p: Partial<Settings>) => setS((v) => ({ ...v, ...p }))

  const chooseDir = async () => {
    const dir = await api.pickDir()
    if (dir) patch({ downloadDir: dir })
  }

  const save = async () => {
    setBusy(true)
    try {
      const saved = await api.setSettings(s)
      onSaved(saved)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const cookieTargets = ['baidu', 'quark', 'uc', 'xunlei', 'lanzou', 'aliyun', '123pan']

  return (
    <div className="mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>设置</h2>
        <div className="content">
          <div className="field">
            <label>下载目录</label>
            <div className="row">
              <input type="text" value={s.downloadDir} onChange={(e) => patch({ downloadDir: e.target.value })} />
              <button onClick={chooseDir}>选择…</button>
            </div>
          </div>

          <div className="grid2">
            <div className="field">
              <label>同时下载任务数</label>
              <input
                type="number"
                min={1}
                max={20}
                value={s.maxConcurrent}
                onChange={(e) => patch({ maxConcurrent: Number(e.target.value) || 1 })}
              />
            </div>
            <div className="field">
              <label>单任务分片数（split）</label>
              <input
                type="number"
                min={1}
                max={64}
                value={s.split}
                onChange={(e) => patch({ split: Number(e.target.value) || 1 })}
              />
            </div>
            <div className="field">
              <label>每服务器最大连接数</label>
              <input
                type="number"
                min={1}
                max={64}
                value={s.maxConnectionPerServer}
                onChange={(e) => patch({ maxConnectionPerServer: Number(e.target.value) || 1 })}
              />
            </div>
            <div className="field">
              <label>最小分片大小</label>
              <input type="text" value={s.minSplitSize} onChange={(e) => patch({ minSplitSize: e.target.value })} />
            </div>
          </div>

          <div className="field">
            <label>自定义 User-Agent</label>
            <input type="text" value={s.userAgent} onChange={(e) => patch({ userAgent: e.target.value })} />
          </div>

          <div className="field">
            <label>网盘账号（可选，用你自己的账号获取更高速度）</label>
            <div className="row">
              <select
                value={cookieKey}
                onChange={(e) => setCookieKey(e.target.value)}
                style={{ background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px' }}
              >
                {cookieTargets.map((k) => (
                  <option key={k} value={k}>
                    {NETDISK_LABEL[k] ?? k}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="粘贴该网盘的 Cookie / 凭证字符串（也可以点右边的登录按钮自动获取）"
                value={s.cookies[cookieKey] ?? ''}
                onChange={(e) => patch({ cookies: { ...s.cookies, [cookieKey]: e.target.value } })}
              />
            </div>
            {LOGIN_TARGETS.includes(cookieKey) && (
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  disabled={loginBusy}
                  onClick={async () => {
                    setLoginBusy(true)
                    try {
                      const r = await api.openLogin(cookieKey)
                      if (r && r.ok && r.cookie) {
                        patch({ cookies: { ...s.cookies, [cookieKey]: r.cookie } })
                        setLoginMsg(
                          r.loggedIn
                            ? `${NETDISK_LABEL[cookieKey]} 登录成功，已抓取 ${r.count ?? 0} 条 Cookie（记得点「保存」）`
                            : `已抓取 ${r.count ?? 0} 条 Cookie，但没有检测到明确的登录状态——如果下载时提示需要登录，请重新登录一次。`,
                        )
                      } else {
                        setLoginMsg(r?.message || '未获取到登录凭证')
                      }
                    } catch (e) {
                      setLoginMsg(e instanceof Error ? e.message : String(e))
                    } finally {
                      setLoginBusy(false)
                    }
                  }}
                >
                  {loginBusy ? '请在弹出的窗口里登录…' : `登录${NETDISK_LABEL[cookieKey]}`}
                </button>
                <button
                  onClick={async () => {
                    await api.clearLogin(cookieKey)
                    patch({ cookies: { ...s.cookies, [cookieKey]: '' } })
                    setLoginMsg(`已清除 ${NETDISK_LABEL[cookieKey]} 的登录状态`)
                  }}
                >
                  退出登录
                </button>
              </div>
            )}
            {loginMsg && <div className="desc">{loginMsg}</div>}
            <div className="desc">
              填写的是「你自己的账号」的凭证，程序只用它拿到你账号本身应有的速度，不做任何身份伪造。
              夸克 / UC 网盘的游客直链会被 CDN 拒绝（412 / 403），迅雷云盘的转存取链也必须登录 —— 这些都要登录后才能下载。
            </div>
          </div>

          <div className="field">
            <label>aria2 RPC 端口</label>
            <input
              type="number"
              value={s.aria2Port}
              onChange={(e) => patch({ aria2Port: Number(e.target.value) || 6800 })}
            />
            <div className="desc">端口被占用时改这里，重启应用生效。</div>
          </div>
        </div>
        <div className="footer">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 解析结果                                                            */
/* ------------------------------------------------------------------ */

function ResultPanel({
  result,
  onDownload,
  needsLogin = false,
}: {
  result: ParseResult
  onDownload: (result: ParseResult, ids: string[]) => void
  needsLogin?: boolean
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const init: Record<string, boolean> = {}
    for (const f of result.files) init[f.id] = true
    setChecked(init)
  }, [result])

  const allOn = result.files.length > 0 && result.files.every((f) => checked[f.id])
  const selected = result.files.filter((f) => checked[f.id])
  const totalSize = selected.reduce((a, f) => a + (f.size || 0), 0)

  return (
    <div className="result">
      <div className="result-head">
        <span className="badge">{NETDISK_LABEL[result.netdisk] ?? result.netdisk}</span>
        <span className="title">{result.title || result.shareId || '分享内容'}</span>
        <span className="badge gray">{result.files.length} 个文件</span>
        {result.elapsed != null && <span className="badge gray">{(result.elapsed / 1000).toFixed(1)}s</span>}
      </div>

      <div className="filelist">
        {result.files.map((f) => (
          <div className="file-item" key={f.id}>
            <input
              type="checkbox"
              checked={!!checked[f.id]}
              onChange={(e) => setChecked((c) => ({ ...c, [f.id]: e.target.checked }))}
            />
            <span className="fname" title={f.name}>
              {f.dir ? <span className="fdir">{f.dir}</span> : null}
              {f.name}
            </span>
            <span className="fsize">{formatSize(f.size)}</span>
          </div>
        ))}
      </div>

      {needsLogin && (result.netdisk === 'quark' || result.netdisk === 'uc') && (
        <div className="result-note warn">
          这个网盘需要登录后才能下载（游客直链会被 CDN 拒绝 412 / 403）。点「开始下载」后会提示你去登录。
        </div>
      )}
      {result.netdisk === 'quark' && !needsLogin && (
        <div className="result-note warn">
          实测：夸克这条下载通道是按「账号」总量限速的——连接数从 1 加到 16，吞吐几乎不变（平均 0.46 → 0.72 MB/s），
          本程序已经用满 aria2 允许的 16 连接。
          <br />
          大文件想要更快，只能用夸克官方 PC 客户端的「快传 → 发送网盘文件 → 发送 → 下载到本地」（实测 4–5 MB/s）——
          它走的是客户端自带的加速通道，不对外开放，本程序拿不到。
        </div>
      )}
      {needsLogin && result.netdisk === 'xunlei' && (
        <div className="result-note warn">
          迅雷云盘的分享可以匿名浏览（文件名和体积都能读到），但转存和取直链必须登录。点「开始下载」后会提示你去登录。
        </div>
      )}
      {result.netdisk === 'xunlei' && !needsLogin && (
        <div className="result-note">
          下载走「转存到你自己的迅雷云盘 → 取直链 → aria2 多线程」，实测 8 连接约 1.1–1.6 MB/s（比夸克/UC 快）。
          下载完成后程序会自动删掉转存进来的副本，不会在你的网盘里留垃圾。
        </div>
      )}
      {result.netdisk === 'baidu' && (
        <div className="result-note warn">
          百度网盘按「账号」维度限速：本程序已对该任务强制单线程（split=1）。调大线程只会招致几小时到几天的惩罚性降速。
          <br />
          想要更快只有两条路：① 在百度网盘官方 PC 客户端里开「设置 → 传输 → 下载提速」（用闲置上传带宽换下载，100M 宽带实测可到 8–10 MB/s，完全免费）；
          ② 开 SVIP。变速齿轮一类的时间钩子工具对网盘无效——限速在服务端，改本地时钟不会让服务器多给你一个字节。
        </div>
      )}

      <div className="result-actions">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)' }}>          <input
            type="checkbox"
            checked={allOn}
            onChange={(e) => {
              const v = e.target.checked
              const next: Record<string, boolean> = {}
              for (const f of result.files) next[f.id] = v
              setChecked(next)
            }}
          />
          全选
        </label>
        <span style={{ color: 'var(--text-dim)' }}>
          已选 {selected.length} 项 · {formatSize(totalSize)}
        </span>
        <span style={{ flex: 1 }} />
        <button className="primary" disabled={!selected.length} onClick={() => onDownload(result, selected.map((f) => f.id))}>
          开始下载
        </button>
      </div>
    </div>
  )
}

function ErrorPanel({ result }: { result: ParseResult }) {
  return (
    <div className="result error-result">
      <div className="result-head">
        <span className="badge gray">{NETDISK_LABEL[result.netdisk] ?? result.netdisk}</span>
        <span className="title err" title={result.source}>
          {result.source || '未知链接'}
        </span>
        {result.elapsed != null && <span className="badge gray">{(result.elapsed / 1000).toFixed(1)}s</span>}
      </div>
      <div className="err-body">
        {result.message || '解析失败'}
        {result.needPassword ? '（请在「提取码」框填写后重试）' : ''}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 主界面                                                              */
/* ------------------------------------------------------------------ */

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [text, setText] = useState('')
  const [pwd, setPwd] = useState('')
  const [parsing, setParsing] = useState(false)
  const [results, setResults] = useState<ParseResult[]>([])
  const [hint, setHint] = useState<{ kind: '' | 'err' | 'ok'; msg: string }>({ kind: '', msg: '' })
  const [needLogin, setNeedLogin] = useState<string | null>(null)
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [aria2, setAria2] = useState<Aria2Status>({ running: false })

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {})
    api.aria2Status().then(setAria2).catch(() => {})
    api.listDownloads().then(setTasks).catch(() => {})
    const off = api.onDownloadsUpdate(setTasks)
    return off
  }, [])

  useEffect(() => {
    const t = setInterval(() => {
      api.aria2Status().then(setAria2).catch(() => {})
    }, 5000)
    return () => clearInterval(t)
  }, [])

  const doParse = useCallback(async () => {
    const raw = text.trim()
    if (!raw) {
      setHint({ kind: 'err', msg: '请先粘贴分享链接（支持一行一个，批量解析）' })
      return
    }
    setParsing(true)
    setHint({ kind: '', msg: '正在解析，请稍候…' })
    setResults([])
    try {
      const r = await api.parseShare({ text: raw, password: pwd.trim() || undefined })
      const list = r?.results ?? []
      setResults(list)
      const okCount = list.filter((x) => x.ok).length
      const fileCount = list.reduce((a, x) => a + (x.ok ? x.files.length : 0), 0)
      if (okCount > 0) {
        setHint({
          kind: 'ok',
          msg: `解析完成：${okCount}/${list.length} 个链接成功，共 ${fileCount} 个文件`,
        })
      } else {
        setHint({ kind: 'err', msg: list[0]?.message || '解析失败' })
      }
    } catch (e: unknown) {
      setHint({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setParsing(false)
    }
  }, [text, pwd])

  const doDownload = useCallback(async (r: ParseResult, ids: string[]) => {
    if (!r.sessionId) return
    setNeedLogin(null)
    setHint({ kind: '', msg: '正在获取直链并提交下载…' })
    try {
      const res = await api.addDownloads({
        sessionId: r.sessionId,
        ids,
        netdisk: r.netdisk,
        source: r.source || r.shareId,
        title: r.title || 'PanBox',
      })
      if (res.ok) {
        setHint({
          kind: 'ok',
          msg: `已加入下载队列：${res.added.length} 个任务${res.errors.length ? `（${res.errors.length} 个失败）` : ''}`,
        })
        setResults((prev) => prev.filter((x) => x.sessionId !== r.sessionId))
      } else {
        const msg = `提交失败：${res.errors.join('; ')}`
        setHint({ kind: 'err', msg })
        if (/登录|needCookie|Cookie/i.test(msg) && LOGIN_TARGETS.includes(r.netdisk)) {
          setNeedLogin(r.netdisk)
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setHint({ kind: 'err', msg })
      if (/登录|needCookie|Cookie/i.test(msg) && LOGIN_TARGETS.includes(r.netdisk)) {
        setNeedLogin(r.netdisk)
      }
    }
  }, [])

  const doLogin = useCallback(async (netdisk: string) => {
    const label = NETDISK_LABEL[netdisk] ?? netdisk
    setHint({ kind: '', msg: `正在打开${label}登录窗口，请在弹出的窗口里扫码或输入账号登录…` })
    try {
      const r = await api.openLogin(netdisk)
      if (!r?.ok) {
        setHint({ kind: 'err', msg: r?.message || '登录窗口未完成登录' })
        return
      }
      const s = await api.getSettings()
      const cookies = { ...(s.cookies || {}) }
      if (r.cookie) cookies[netdisk] = r.cookie
      await api.setSettings({ cookies })
      setSettings((prev) => (prev ? { ...prev, cookies } : prev))
      setNeedLogin(null)
      if (r.loggedIn === false) {
        setHint({
          kind: 'err',
          msg: `已抓取 ${r.count ?? 0} 条 Cookie，但没有检测到明确的登录状态——请再登录一次。`,
        })
      } else {
        setHint({
          kind: 'ok',
          msg: `已登录并保存${label}凭证（${r.count ?? 0} 条 Cookie）。请重新点「下载」。`,
        })
      }
    } catch (e: unknown) {
      setHint({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  const stats = useMemo(() => {
    const active = tasks.filter((t) => t.status === 'active')
    const speed = active.reduce((a, t) => a + (t.speed || 0), 0)
    const done = tasks.filter((t) => t.status === 'complete').length
    const err = tasks.filter((t) => t.status === 'error').length
    return { speed, done, err, activeCount: active.length }
  }, [tasks])

  if (!settings) {
    return (
      <div className="app">
        <div className="empty">正在启动…</div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="header">
        <div className="logo">
          Pan<span>Box</span>
        </div>
        <div className="dot" style={{ background: aria2.running ? 'var(--ok)' : 'var(--err)' }} />
        <div className="status">
          {aria2.running ? `aria2 已就绪 ${aria2.version ?? ''}` : 'aria2 未连接'}
          {stats.activeCount > 0 ? ` · ${stats.activeCount} 个任务下载中 · ${formatSpeed(stats.speed)}` : ''}
        </div>
        <div className="spacer" />
        <button className="ghost" onClick={() => setShowSettings(true)}>
          ⚙ 设置
        </button>
      </div>

      <div className="body">
        <div className="pane-create">
          <div className="link-row">
            <input
              type="text"
              placeholder="粘贴网盘分享链接，支持一行一个批量解析（蓝奏云 / 夸克 / UC / 百度 …）"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !parsing && doParse()}
            />
            <input
              className="pwd"
              type="text"
              placeholder="提取码"
              maxLength={6}
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
            />
            <button className="primary" disabled={parsing} onClick={doParse}>
              {parsing ? '解析中…' : '解析'}
            </button>
          </div>
          <div className={`hint ${hint.kind}`}>{hint.msg}</div>

          {needLogin && (
            <div className="need-login">
              <span>
                {NETDISK_LABEL[needLogin] ?? needLogin} 网盘的分享链接需要登录后才能下载（游客直链会被 CDN 拒绝）。
              </span>
              <button className="primary tiny" onClick={() => doLogin(needLogin)}>
                去登录
              </button>
            </div>
          )}

          {results.length > 0 && (
            <div className="results">
              {results.map((r, i) =>
                r.ok ? (
                  <ResultPanel
                    key={r.sessionId || `r${i}`}
                    result={r}
                    needsLogin={!settings.cookies?.[r.netdisk]}
                    onDownload={doDownload}
                  />
                ) : (
                  <ErrorPanel key={r.source || `e${i}`} result={r} />
                ),
              )}
            </div>
          )}
        </div>

        <div className="pane-list">
          <div className="list-head">
            <span>下载队列（{tasks.length}）</span>
            <span className="spacer" />
            <button className="tiny" onClick={() => api.pauseAll()}>
              全部暂停
            </button>
            <button className="tiny" onClick={() => api.resumeAll()}>
              全部继续
            </button>
            <button className="tiny" onClick={() => api.openPath(settings.downloadDir)}>
              打开目录
            </button>
          </div>

          <div className="scroll">
            {tasks.length === 0 ? (
              <div className="empty">
                还没有下载任务。
                <br />
                粘贴一个分享链接，点「解析」开始。
              </div>
            ) : (
              tasks.map((t) => {
                const pct = t.total > 0 ? Math.min(100, (t.completed / t.total) * 100) : t.status === 'complete' ? 100 : 0
                const barCls = t.status === 'complete' ? 'done' : t.status === 'error' ? 'err' : ''
                return (
                  <div className="task" key={t.gid}>
                    <div style={{ minWidth: 0 }}>
                      <div className="tname" title={t.name}>
                        {t.name}
                      </div>
                      <div className="tsub">
                        {NETDISK_LABEL[t.netdisk] ?? t.netdisk}
                        {t.connections ? ` · ${t.connections} 连接` : ''}
                        {t.errorMessage ? ` · ${t.errorMessage}` : ''}
                      </div>
                    </div>

                    <div>
                      <div className={`bar ${barCls}`}>
                        <i style={{ width: `${pct}%` }} />
                      </div>
                      <div className="meta">
                        {formatSize(t.completed)} / {formatSize(t.total)} · {pct.toFixed(1)}%
                      </div>
                    </div>

                    <div>
                      <div className="speed">{t.status === 'active' ? formatSpeed(t.speed) : '—'}</div>
                      <div className="meta">
                        {t.status === 'active' ? `剩余 ${formatEta(t.total - t.completed, t.speed)}` : ' '}
                      </div>
                    </div>

                    <div className="actions">
                      <span className={`status-pill ${t.status}`}>
                        {
                          {
                            active: '下载中',
                            waiting: '排队',
                            paused: '已暂停',
                            complete: '已完成',
                            error: '出错',
                            removed: '已移除',
                          }[t.status]
                        }
                      </span>
                      {t.status === 'active' && (
                        <button className="ghost tiny" title="暂停" onClick={() => api.pauseTask(t.gid)}>
                          ⏸
                        </button>
                      )}
                      {(t.status === 'paused' || t.status === 'waiting') && (
                        <button className="ghost tiny" title="继续" onClick={() => api.resumeTask(t.gid)}>
                          ▶
                        </button>
                      )}
                      <button className="ghost tiny" title="移除" onClick={() => api.removeTask(t.gid)}>
                        ✕
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          initial={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => setSettings(s)}
        />
      )}
    </div>
  )
}
