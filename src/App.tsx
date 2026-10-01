import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, formatEta, formatSize, formatSpeed } from './api'
import type { BridgeStatus, ProxyStatus } from './api'
import type { Aria2Status, DownloadTask, ParseEndpoint, ParseResult, Settings } from './types'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const NETDISK_LABEL: Record<string, string> = {
  lanzou: '蓝奏云',
  ilanzou: '蓝奏云优享版',
  'lanzou-xy': '蓝奏云优享版',
  quark: '夸克网盘',
  uc: 'UC网盘',
  baidu: '百度网盘',
  xunlei: '迅雷云盘',
  '123pan': '123云盘',
  direct: '直链',
  unknown: '未知',
}

const label = (k: string) => NETDISK_LABEL[k] ?? k

/** 能一键开登录窗抓凭证的网盘，同时也是「网盘账号」下拉的顺序 */
const LOGIN_TARGETS = ['baidu', 'quark', 'uc', 'xunlei']
/** 只能手贴凭证的网盘 */
const COOKIE_TARGETS = [...LOGIN_TARGETS, 'lanzou', '123pan']

/** 走自研分段引擎的网盘。百度不在此列 —— 它是账号级总量限速，加连接只会招 403。 */
const SEG_TARGETS = ['quark', 'uc', 'direct']

/** 「解析接口」可以勾选的网盘（顶层域名会被自动识别成这些代号） */
const EP_NETDISKS = ['lanzou', 'ilanzou', 'quark', 'uc', 'baidu', 'xunlei', '123pan', 'direct']

/** 解析成功后，结果面板底下的一句话提示（原来每个网盘一段 if，现在一张表） */
const NETDISK_TIP: Record<string, { warn?: boolean; text: string }> = {
  quark: {
    warn: true,
    text: '夸克这条下载通道按「账号」总量限速，多开连接基本没用。大文件想更快只能用夸克官方客户端的「快传 → 发送网盘文件 → 下载到本地」。',
  },
  uc: { text: 'UC 按每条连接发额度，已交给自带的分段引擎多连接下载。' },
  xunlei: { text: '走「转存到你的迅雷云盘 → 取直链」，下载完成后会自动删掉转存副本。' },
  baidu: {
    warn: true,
    text: '百度按「账号」维度限速，本任务强制单线程。想更快：在官方客户端开「设置 → 传输 → 下载提速」（免费），或者开 SVIP。',
  },
}

/** 没登录时各网盘的一句话说明 */
const NEED_LOGIN_TIP: Record<string, string> = {
  quark: '夸克网盘的游客直链会被 CDN 拒绝（412），需要登录你自己的账号。',
  uc: 'UC 网盘的游客直链会被 CDN 拒绝（403），需要登录你自己的账号。',
  xunlei: '迅雷分享可以匿名浏览文件列表，但转存和取直链必须登录。',
  baidu: '百度网盘需要登录你自己的账号，才能转存并取直链。',
}

/* ------------------------------------------------------------------ */
/* 小积木                                                              */
/* ------------------------------------------------------------------ */

/** 结果面板里的一条提示 */
function Tip({ warn, children }: { warn?: boolean; children: ReactNode }) {
  return <div className={`result-note${warn ? ' warn' : ''}`}>{children}</div>
}

/** 设置页里的分组：原来所有字段平铺成一长条，找不到东西 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sec">
      <h3>{title}</h3>
      <div className="sec-body">{children}</div>
    </section>
  )
}

function Field({
  label: text,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="field">
      <label>{text}</label>
      {children}
      {hint ? <div className="desc">{hint}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 网盘解析接口                                                        */
/* ------------------------------------------------------------------ */

/**
 * 用户自备的「解析站」接口。PanBox 内置解析走「用你自己的账号转存取直链」，
 * 速度上限就是你自己账号的档位；这类接口用自己的会员账号取链，所以能跑满。
 * 程序只负责转发链接、取出直链、交给下载引擎，**不内置也不推荐任何具体解析站**。
 */
function EndpointSection({
  list,
  onChange,
  ack,
  onAck,
}: {
  list: ParseEndpoint[]
  onChange: (next: ParseEndpoint[]) => void
  ack: boolean
  onAck: (v: boolean) => void
}) {
  const upd = (id: string, p: Partial<ParseEndpoint>) =>
    onChange(list.map((x) => (x.id === id ? { ...x, ...p } : x)))

  const add = () =>
    onChange([
      ...list,
      {
        id: `ep-${Date.now().toString(36)}`,
        name: '',
        url: '',
        method: 'GET',
        body: '',
        field: '',
        headers: '',
        dlHeaders: '',
        netdisks: [],
        enabled: true,
      },
    ])

  return (
    <Field
      label="解析接口（可选，优先于内置解析）"
      hint={
        <>
          接口地址完全由你提供。填了提取码时，<b>提取码会随分享链接一起发给接口</b>（否则它取不到链）；
          你的网盘凭证只在你自己机器上用，<b>不会</b>发往接口。
        </>
      }
    >
      <div className="endpoint-add">
        <button onClick={add} disabled={list.length >= 8}>
          ＋ 添加接口
        </button>
        <span className="ep-hint">{list.length}/8</span>
      </div>

      {list.map((ep, i) => (
        <div className="endpoint" key={ep.id}>
          <div className="endpoint-head">
            <label className="ep-toggle">
              <input
                type="checkbox"
                checked={ep.enabled !== false}
                onChange={(e) => upd(ep.id, { enabled: e.target.checked })}
              />
              启用
            </label>
            <input
              type="text"
              placeholder={`接口名称（如：我的解析站 ${i + 1}）`}
              value={ep.name}
              onChange={(e) => upd(ep.id, { name: e.target.value })}
            />
            <select
              className="select"
              value={ep.method || 'GET'}
              onChange={(e) => upd(ep.id, { method: e.target.value as 'GET' | 'POST' })}
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
            <button title="删除这个接口" onClick={() => onChange(list.filter((x) => x.id !== ep.id))}>
              删除
            </button>
          </div>

          <input
            type="text"
            placeholder="接口地址，可用 {url} {pwd} {shareId} {netdisk} 占位，如 https://example.com/api?url={url}"
            value={ep.url}
            onChange={(e) => upd(ep.id, { url: e.target.value })}
          />

          {ep.method === 'POST' && (
            <textarea
              rows={2}
              placeholder={'请求体模板，如 url={url}&pwd={pwd}（默认 form-urlencoded）'}
              value={ep.body || ''}
              onChange={(e) => upd(ep.id, { body: e.target.value })}
            />
          )}

          <div className="row">
            <input
              type="text"
              placeholder="直链字段路径（留空自动识别 url / dlink / download_url …），如 data.url"
              value={ep.field || ''}
              onChange={(e) => upd(ep.id, { field: e.target.value })}
            />
          </div>

          <div className="row">
            <textarea
              rows={2}
              placeholder={'请求头 JSON（可选），如 {"Referer":"https://example.com/"}'}
              value={typeof ep.headers === 'string' ? ep.headers : ep.headers ? JSON.stringify(ep.headers) : ''}
              onChange={(e) => upd(ep.id, { headers: e.target.value })}
            />
            <textarea
              rows={2}
              placeholder="下载直链要带的请求头 JSON（可选），留空只用 User-Agent"
              value={typeof ep.dlHeaders === 'string' ? ep.dlHeaders : ep.dlHeaders ? JSON.stringify(ep.dlHeaders) : ''}
              onChange={(e) => upd(ep.id, { dlHeaders: e.target.value })}
            />
          </div>

          <div className="ep-netdisks">
            <span className="ep-hint">适用网盘（不勾 = 全部；直链必须显式勾选）：</span>
            {EP_NETDISKS.map((k) => {
              const cur = ep.netdisks || []
              const on = cur.includes(k)
              return (
                <label key={k} className={`chip ${on ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => upd(ep.id, { netdisks: on ? cur.filter((x) => x !== k) : [...cur, k] })}
                  />
                  {label(k)}
                </label>
              )
            })}
          </div>
        </div>
      ))}

      {/* 有启用中的接口时必须勾选，否则不允许保存 */}
      <label className={`ep-ack${ack ? '' : ' need'}`}>
        <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} />
        <span>
          我确认：只用它下载<b>我自己有权下载</b>的内容，<b>不</b>用于规避网盘会员 / 限速机制，
          也<b>不</b>用于获取或传播他人受版权保护的资源。PanBox 只做 HTTP 转发，接口地址由我自己提供并自行确认合法性。
        </span>
      </label>
    </Field>
  )
}

/* ------------------------------------------------------------------ */
/* 网络出口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 实测（同一条 GitHub 66 MB 直链）：直连 CDN 单连接只有 0.03–0.04 MB/s，
 * 而且 github.com 那一跳会间歇性超时；走系统代理 8–11 MB/s。
 * 但代理不是人人都有（NDM 就和 Clash 冲突），所以默认 auto + 自动改走另一条路。
 */
function ProxySection({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => void }) {
  const [st, setSt] = useState<ProxyStatus | null>(null)
  const mode = s.proxyMode || 'auto'

  useEffect(() => {
    api
      .proxyStatus()
      .then(setSt)
      .catch(() => {})
  }, [mode, s.proxy])

  const badge = !st ? '读取中…' : st.system ? `系统代理：${st.system}` : '系统里没有开代理'

  return (
    <Field
      label="网络代理（下 GitHub / 境外资源时差别很大）"
      hint={
        <>
          实测同一条 66 MB 的 GitHub 直链：<b>直连 CDN 单连接只有 0.03–0.04 MB/s</b>，
          走系统代理能到 <b>8–11 MB/s</b>。哪个更快跟连接数是 16 还是 32 关系不大。
          <br />
          当前实际使用：{st?.effective ? <code>{st.effective}</code> : '直连（不走代理）'}。
          改完会自动重启下载引擎，本机地址永远绕过代理。一条路不通时程序会自动换另一条。
        </>
      }
    >
      <div className="stack">
        <div className="stack-row">
          <select className="select" value={mode} onChange={(e) => patch({ proxyMode: e.target.value as Settings['proxyMode'] })}>
            <option value="auto">跟随 Windows 系统代理（推荐）</option>
            <option value="custom">手动指定</option>
            <option value="off">不使用代理</option>
          </select>
          {mode === 'auto' && <span className={`badge ${st?.system ? 'ok' : 'gray'}`}>{badge}</span>}
        </div>
        {mode === 'custom' && (
          <input
            type="text"
            placeholder="http://127.0.0.1:7890"
            value={s.proxy || ''}
            onChange={(e) => patch({ proxy: e.target.value })}
          />
        )}
      </div>
    </Field>
  )
}

/* ------------------------------------------------------------------ */
/* 浏览器插件                                                          */
/* ------------------------------------------------------------------ */

/** 插件把网页里的下载任务投给本机 PanBox。这段只负责三件事：通没通、目录在哪、配对令牌。 */
function BridgeSection() {
  const [st, setSt] = useState<BridgeStatus | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      setSt(await api.bridgeStatus())
    } catch {
      /* 主进程没起这条通道时忽略 */
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      setMsg(await fn())
      await refresh()
    } catch (e) {
      setMsg(`出错了：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const state = !st ? 'gray' : !st.enabled ? 'gray' : st.running ? 'ok' : 'err'
  const stateText = !st
    ? '读取中…'
    : !st.enabled
      ? '已关闭'
      : st.running
        ? `运行中 · ${st.host}:${st.port}`
        : `没有起来${st.error ? `：${st.error}` : ''}`

  return (
    <Field
      label="浏览器插件（在网页里直接下资源）"
      hint={
        <>
          装上后，网页里右键链接就能「用 PanBox 下载」，任务会带上当前页面的 Referer / Cookie / User-Agent
          —— 很多站点的直链少了这几个头就是 403。安装：打开 <code>chrome://extensions</code>（Edge 是{' '}
          <code>edge://extensions</code>）→ 开发者模式 → 加载已解压的扩展程序 → 选「打开插件文件夹」里的目录。
          装好或更新后要在扩展页点一次「重新加载」。
        </>
      }
    >
      <div className="stack">
        <div className="stack-row">
          <span className={`badge ${state === 'ok' ? 'ok' : state === 'err' ? 'err' : 'gray'}`}>{stateText}</span>
          <span className="ep-hint">{st ? (st.added > 0 ? `已接收 ${st.added} 个任务` : '还没有收到过任务') : ''}</span>
        </div>

        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.bridgeOpenFolder()
                return r.ok ? `已打开插件文件夹：${r.dir}` : `打不开：${r.message || '未知原因'}`
              })
            }
          >
            打开插件文件夹
          </button>
          <button disabled={busy} onClick={() => run(async () => ((await api.bridgeStart()) ? '已重新开始监听' : '没起来'))}>
            重新检测
          </button>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => ((await api.bridgeNewToken()) ? '已换新令牌，请到插件「高级」里重新填一次' : '没换成'))
            }
          >
            重新配对
          </button>
        </div>

        {st && (
          <div className="stack-row">
            <span className="ep-hint">配对令牌</span>
            <input type="text" readOnly value={st.token} onFocus={(e) => e.currentTarget.select()} />
          </div>
        )}

        {!st?.extExists && <div className="hint err">插件文件夹里没找到 manifest.json，可能是安装不完整。</div>}
        {msg && <div className="hint ok">{msg}</div>}
      </div>
    </Field>
  )
}

/* ------------------------------------------------------------------ */
/* 设置弹窗                                                            */
/* ------------------------------------------------------------------ */

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
  const [saveErr, setSaveErr] = useState('')
  const [cookieKey, setCookieKey] = useState(LOGIN_TARGETS[0])
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginMsg, setLoginMsg] = useState('')

  const patch = (p: Partial<Settings>) => setS((v) => ({ ...v, ...p }))

  // 有「启用中且填了地址」的解析接口时，必须先勾选用户承诺才能保存
  const needAck =
    (s.parseEndpoints || []).some((e) => e.enabled !== false && (e.url || '').trim() !== '') && !s.endpointAck

  const save = async () => {
    if (needAck) return
    setBusy(true)
    setSaveErr('')
    try {
      onSaved(await api.setSettings(s))
      onClose()
    } catch (e: unknown) {
      /* 主进程会校验设置（范围、路径、令牌长度…），把它的原话显示出来，
       * 否则用户只会看到「点了保存没反应」。 */
      setSaveErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doLogin = async () => {
    setLoginBusy(true)
    try {
      const r = await api.openLogin(cookieKey)
      if (r && r.ok && r.cookie) {
        patch({ cookies: { ...s.cookies, [cookieKey]: r.cookie } })
        setLoginMsg(
          r.loggedIn
            ? `${label(cookieKey)} 登录成功，已抓取 ${r.count ?? 0} 条凭证（记得点「保存」）`
            : `已抓取 ${r.count ?? 0} 条凭证，但没检测到明确的登录状态——下载时若提示需要登录，请重新登录一次。`,
        )
      } else {
        setLoginMsg(r?.message || '未获取到登录凭证')
      }
    } catch (e) {
      setLoginMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoginBusy(false)
    }
  }

  return (
    <div className="mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>设置</h2>
        <div className="content">
          <Section title="基础">
            <Field label="下载目录">
              <div className="row">
                <input type="text" value={s.downloadDir} onChange={(e) => patch({ downloadDir: e.target.value })} />
                <button
                  onClick={async () => {
                    const dir = await api.pickDir()
                    if (dir) patch({ downloadDir: dir })
                  }}
                >
                  选择…
                </button>
              </div>
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={!!s.openFolderWhenDone}
                onChange={(e) => patch({ openFolderWhenDone: e.target.checked })}
              />
              下载完成后自动打开下载目录
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.closeToTray !== false}
                onChange={(e) => patch({ closeToTray: e.target.checked })}
              />
              点 × 关闭窗口后留在后台继续下载（托盘图标可再打开）
            </label>
          </Section>

          <Section title="下载引擎">
            <div className="grid2">
              <Field label="同时下载任务数">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={s.maxConcurrent}
                  onChange={(e) => patch({ maxConcurrent: Number(e.target.value) || 1 })}
                />
              </Field>
              <Field label="单任务分片数（split）">
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={s.split}
                  onChange={(e) => patch({ split: Number(e.target.value) || 1 })}
                />
              </Field>
              <Field label="每服务器最大连接数">
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={s.maxConnectionPerServer}
                  onChange={(e) => patch({ maxConnectionPerServer: Number(e.target.value) || 1 })}
                />
              </Field>
              <Field label="最小分片大小">
                <input type="text" value={s.minSplitSize} onChange={(e) => patch({ minSplitSize: e.target.value })} />
              </Field>
            </div>

            <Field
              label="分段引擎连接数（绕开 aria2 的 16 连接上限）"
              hint={
                <>
                  夸克 / UC 的 CDN 是<b>按每条 TCP 连接</b>发额度的（夸克 ≈50KB/s、UC ≈64KB/s 一条），
                  而 aria2 的连接数上限只有 16 —— 所以这两家和普通直链交给自带的分段引擎，连接数在这里调。
                  填 0 = 退回 aria2。<b>直链默认 128</b>：境外线路经常「先冲一阵再长时间不动」，连接少了就一直在等。
                </>
              }
            >
              <div className="ep-netdisks">
                {SEG_TARGETS.map((k) => (
                  <span key={k} className="seg-conn">
                    <span className="ep-hint">{label(k)}</span>
                    <input
                      type="number"
                      min={0}
                      max={256}
                      value={s.segConnections?.[k] ?? 0}
                      onChange={(e) =>
                        patch({ segConnections: { ...(s.segConnections || {}), [k]: Number(e.target.value) || 0 } })
                      }
                    />
                  </span>
                ))}
              </div>
            </Field>

            <Field
              label="百度网盘并发（默认 1）"
              hint={
                <>
                  百度是<b>账号级总量限速</b>，普通账号调大并发只会招来几小时到几天的惩罚性降速。
                  如果你是超级会员，可以调到 4~8 试试；<b>调高后速度反而变 0 就说明被限了，调回 1</b>。
                </>
              }
            >
              <input
                type="number"
                min={1}
                max={32}
                value={s.baiduConnections ?? 1}
                onChange={(e) => patch({ baiduConnections: Math.max(1, Number(e.target.value) || 1) })}
              />
            </Field>
          </Section>

          <Section title="网络">
            <ProxySection s={s} patch={patch} />
            <Field label="自定义 User-Agent" hint="留默认即可。只有个别站点要求特定 UA 时才改。">
              <input type="text" value={s.userAgent} onChange={(e) => patch({ userAgent: e.target.value })} />
            </Field>
            <Field label="aria2 RPC 端口" hint="端口被占用时改这里，重启应用生效。">
              <input
                type="number"
                value={s.aria2Port}
                onChange={(e) => patch({ aria2Port: Number(e.target.value) || 6800 })}
              />
            </Field>
          </Section>

          <Section title="网盘账号">
            <Field
              label="用你自己的账号（可选，但夸克 / UC / 迅雷 / 百度必须登录）"
              hint={
                <>
                  凭证只在你自己机器上用，程序只拿「你账号本来应有的速度」，不做任何身份伪造。
                  夸克与 UC 的游客直链会被 CDN 拒绝（412 / 403），迅雷和百度的转存取链也必须登录。
                </>
              }
            >
              <div className="row">
                <select className="select" value={cookieKey} onChange={(e) => setCookieKey(e.target.value)}>
                  {COOKIE_TARGETS.map((k) => (
                    <option key={k} value={k}>
                      {label(k)}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="粘贴该网盘的凭证字符串，或点下面「登录」自动获取"
                  value={s.cookies[cookieKey] ?? ''}
                  onChange={(e) => patch({ cookies: { ...s.cookies, [cookieKey]: e.target.value } })}
                />
              </div>
              {LOGIN_TARGETS.includes(cookieKey) && (
                <div className="row" style={{ marginTop: 8 }}>
                  <button disabled={loginBusy} onClick={doLogin}>
                    {loginBusy ? '请在弹出的窗口里登录…' : `登录${label(cookieKey)}`}
                  </button>
                  <button
                    onClick={async () => {
                      await api.clearLogin(cookieKey)
                      patch({ cookies: { ...s.cookies, [cookieKey]: '' } })
                      setLoginMsg(`已清除 ${label(cookieKey)} 的登录状态`)
                    }}
                  >
                    退出登录
                  </button>
                </div>
              )}
              {loginMsg && <div className="desc">{loginMsg}</div>}
            </Field>
          </Section>

          <Section title="浏览器插件">
            <BridgeSection />
          </Section>

          <Section title="高级：解析接口">
            <EndpointSection
              list={s.parseEndpoints || []}
              onChange={(next) => patch({ parseEndpoints: next })}
              ack={!!s.endpointAck}
              onAck={(v) => patch({ endpointAck: v })}
            />
          </Section>
        </div>

        <div className="footer">
          {saveErr && (
            <span className="hint err" style={{ marginRight: 'auto' }}>
              {saveErr}
            </span>
          )}
          {needAck && (
            <span className="hint err" style={{ marginRight: 'auto' }}>
              请先勾选上面的「用户承诺」
            </span>
          )}
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy || needAck} onClick={save}>
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
  const tip = needsLogin ? NEED_LOGIN_TIP[result.netdisk] : NETDISK_TIP[result.netdisk]?.text

  return (
    <div className="result">
      <div className="result-head">
        <span className="badge">{label(result.netdisk)}</span>
        <span className="title">{result.title || result.shareId || '分享内容'}</span>
        <span className="badge gray">{result.files.length} 个文件</span>
        {result.elapsed != null && <span className="badge gray">{(result.elapsed / 1000).toFixed(1)}s</span>}
        {result.viaEndpoint && (
          <span className="badge ok" title="直链来自你配置的解析接口，不受你自己账号的限速档位约束">
            解析接口 · {result.endpointName || '自定义'}
          </span>
        )}
      </div>

      {result.endpointError && (
        <Tip warn>
          解析接口调用失败，已退回内置解析：{result.endpointError}
        </Tip>
      )}

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

      {tip && <Tip warn={!!(needsLogin || NETDISK_TIP[result.netdisk]?.warn)}>{tip}</Tip>}

      <div className="result-actions">
        <label className="check">
          <input
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
        <span className="dim">
          已选 {selected.length} 项 · {formatSize(totalSize)}
        </span>
        <span className="grow" />
        <button
          className="primary"
          disabled={!selected.length}
          onClick={() => onDownload(result, selected.map((f) => f.id))}
        >
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
        <span className="badge gray">{label(result.netdisk)}</span>
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

const STATUS_TEXT: Record<string, string> = {
  active: '下载中',
  waiting: '排队',
  paused: '已暂停',
  complete: '已完成',
  error: '出错',
  removed: '已移除',
}

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
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [aria2, setAria2] = useState<Aria2Status>({ running: false })

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {})
    api.aria2Status().then(setAria2).catch(() => {})
    api.listDownloads().then(setTasks).catch(() => {})
    const off = api.onDownloadsUpdate(setTasks)
    /* 浏览器插件投进来一个「网盘分享链接」时，主进程不会擅自决定下哪些文件，
     * 而是把链接送到这里填进输入框，让用户自己勾选。 */
    const offPre = api.onBridgePrefill?.((d) => {
      setText(d.url)
      setHint({ kind: 'ok', msg: `浏览器插件送来一个${label(d.netdisk)}分享链接，点「解析」看看里面有什么` })
    })
    return () => {
      off()
      if (offPre) offPre()
    }
  }, [])

  /* 引擎状态不是高频信息：连上后 10 秒问一次就够（任务进度是主进程推过来的，不用轮询）。
   * 还没连上时 2.5 秒问一次——应用启动的头一两秒 aria2 可能还没起来，
   * 问得太慢会让标题栏一直挂着「aria2 未连接」。 */
  useEffect(() => {
    const t = setInterval(() => {
      api.aria2Status().then(setAria2).catch(() => {})
    }, aria2.running ? 10000 : 2500)
    return () => clearInterval(t)
  }, [aria2.running])

  /* 界面上「当前这批解析结果」对应的会话 id。丢掉结果时顺手通知主进程释放缓存，
   * 不然那些会话要在主进程里挂满 30 分钟 TTL（每个都攥着一份文件树）。 */
  const sessionsRef = useRef<string[]>([])
  const dropSessionsOf = useCallback((list: ParseResult[]) => {
    const keep = list.map((x) => x.sessionId).filter(Boolean) as string[]
    for (const id of sessionsRef.current) {
      if (!keep.includes(id)) api.dropParseSession(id).catch(() => {})
    }
    sessionsRef.current = keep
  }, [])

  const doParse = useCallback(async () => {
    const raw = text.trim()
    if (!raw) {
      setHint({ kind: 'err', msg: '请先粘贴分享链接（支持一行一个，批量解析）' })
      return
    }
    setParsing(true)
    setHint({ kind: '', msg: '正在解析，请稍候…' })
    dropSessionsOf([])
    setResults([])
    try {
      const r = await api.parseShare({ text: raw, password: pwd.trim() || undefined })
      const list = r?.results ?? []
      setResults(list)
      dropSessionsOf(list)
      const okCount = list.filter((x) => x.ok).length
      const fileCount = list.reduce((a, x) => a + (x.ok ? x.files.length : 0), 0)
      if (okCount > 0) {
        setHint({ kind: 'ok', msg: `解析完成：${okCount}/${list.length} 个链接成功，共 ${fileCount} 个文件` })
      } else {
        setHint({ kind: 'err', msg: list[0]?.message || '解析失败' })
      }
    } catch (e: unknown) {
      setHint({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setParsing(false)
    }
  }, [text, pwd, dropSessionsOf])

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
        api.dropParseSession(r.sessionId).catch(() => {})
        sessionsRef.current = sessionsRef.current.filter((id) => id !== r.sessionId)
      } else {
        const msg = `提交失败：${res.errors.join('; ')}`
        setHint({ kind: 'err', msg })
        if (/登录|needCookie|Cookie/i.test(msg) && LOGIN_TARGETS.includes(r.netdisk)) setNeedLogin(r.netdisk)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setHint({ kind: 'err', msg })
      if (/登录|needCookie|Cookie/i.test(msg) && LOGIN_TARGETS.includes(r.netdisk)) setNeedLogin(r.netdisk)
    }
  }, [])

  const doLogin = useCallback(async (netdisk: string) => {
    setHint({ kind: '', msg: `正在打开${label(netdisk)}登录窗口，请在弹出的窗口里扫码或输入账号登录…` })
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
      setHint(
        r.loggedIn === false
          ? { kind: 'err', msg: `已抓取 ${r.count ?? 0} 条凭证，但没检测到明确的登录状态——请再登录一次。` }
          : { kind: 'ok', msg: `已登录并保存${label(netdisk)}凭证（${r.count ?? 0} 条）。请重新点「下载」。` },
      )
    } catch (e: unknown) {
      setHint({ kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  const stats = useMemo(() => {
    const active = tasks.filter((t) => t.status === 'active')
    return {
      speed: active.reduce((a, t) => a + (t.speed || 0), 0),
      activeCount: active.length,
    }
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
        <div className={`dot${aria2.running ? ' on' : ''}`} />
        <div className="status">
          {aria2.running ? `aria2 已就绪 ${aria2.version ?? ''}` : 'aria2 未连接'}
          {stats.activeCount > 0 ? ` · ${stats.activeCount} 个任务下载中 · ${formatSpeed(stats.speed)}` : ''}
        </div>
        {!aria2.running && (
          <button
            className="ghost tiny"
            title="重新拉起 aria2 下载引擎"
            onClick={async () => setAria2(await api.restartAria2())}
          >
            重连引擎
          </button>
        )}
        <div className="grow" />
        <button className="ghost" onClick={() => setShowSettings(true)}>
          ⚙ 设置
        </button>
      </div>

      <div className="body">
        <div className="pane-create">
          <div className="link-row">
            <input
              type="text"
              placeholder="粘贴网盘分享链接或 http(s) 直链（一行一个，可批量）—— 蓝奏云 / 夸克 / UC / 百度 / 迅雷 / 123 …"
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
              <span>{NEED_LOGIN_TIP[needLogin] || `${label(needLogin)}网盘的分享链接需要登录后才能下载。`}</span>
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
            <span className="grow" />
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
                    <div className="tcell">
                      <div className="tname" title={t.name}>
                        {t.name}
                      </div>
                      <div className="tsub">
                        {label(t.netdisk)}
                        {t.engine === 'seg' ? ' · 分段引擎' : ''}
                        {t.route === 'proxy' ? ' · 走代理' : ''}
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
                      <span className={`status-pill ${t.status}`}>{STATUS_TEXT[t.status]}</span>
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
                      {(t.status === 'active' || t.status === 'paused' || t.status === 'error') && t.source && (
                        <button
                          className="ghost tiny"
                          title="换直链：重新解析这条分享，用新的下载地址替换当前的。直链过期或这次分到的节点太慢时用得上。"
                          disabled={refreshing === t.gid}
                          onClick={async () => {
                            setRefreshing(t.gid)
                            setHint({ kind: '', msg: `正在为「${t.name}」重新解析直链…` })
                            try {
                              const r = await api.refreshTask(t.gid)
                              setHint({
                                kind: r.ok ? 'ok' : 'err',
                                msg: r.message || (r.ok ? '已换成新的下载地址' : '换直链失败'),
                              })
                            } catch (e) {
                              setHint({ kind: 'err', msg: String((e as Error)?.message || e) })
                            }
                            setRefreshing(null)
                          }}
                        >
                          {refreshing === t.gid ? '…' : '⟳'}
                        </button>
                      )}
                      <button
                        className="ghost tiny"
                        title="移除（下到一半的会立刻回收转存副本）"
                        onClick={async () => {
                          /* 必须等 IPC 回来再刷新：移除要先把结果从引擎的停止列表里清掉，
                           * 否则下一次轮询会把它原样读回来，看起来像「点了没反应」。 */
                          try {
                            await api.removeTask(t.gid)
                            setTasks((await api.listDownloads()) || [])
                          } catch (e) {
                            setHint({ kind: 'err', msg: `移除失败：${String((e as Error)?.message || e)}` })
                          }
                        }}
                      >
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
        <SettingsModal initial={settings} onClose={() => setShowSettings(false)} onSaved={setSettings} />
      )}
    </div>
  )
}
