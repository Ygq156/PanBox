import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, formatEta, formatSize, formatSpeed } from './api'
import type { AppInfo, UpdateInfo, UpdateState } from './api'
import type { Aria2Status, DownloadTask, ParseResult, Settings } from './types'
import { COOKIE_TARGETS, LOGIN_TARGETS, SEG_TARGETS, label } from './sites'
import { NumBox, NumberRow, Row, Section, Switch, Tip } from './ui/parts'
import { errText } from './ui/text'
import { mergeTasks } from './tasks'
import { EndpointSection } from './settings/EndpointSection'
import { ProxySection } from './settings/ProxySection'
import { BridgeSection } from './settings/BridgeSection'
import { TrashModal } from './trash/TrashModal'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/* 主进程把凭证打码后才发到界面（防止页面脚本读到原文）。这个串表示「本机已有一份，
 * 界面不回显」——保存时原样传回去，主进程认这个串就保留磁盘上那份。 */
const COOKIE_MASK = '__PANBOX_KEEP__'

/** 键顺序无关的 JSON（比「有没有改动」用；两侧对象是不同地方拼出来的，键顺序不保证一致） */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(o).sort()) sorted[k] = o[k]
      return sorted
    }
    return val
  })
}

/** 解析成功后，结果面板底下的一句话提示（原来每个网盘一段 if，现在一张表） */
const NETDISK_TIP: Record<string, { warn?: boolean; text: string }> = {
  xunlei: { text: '已在你网盘里生成转存副本，任务结束后自动删除。' },
  baidu: {
    warn: true,
    text: '百度按账号限速，本任务单线程。想更快：官方客户端开「下载提速」，或者开 SVIP。',
  },
}

/** 没登录时各网盘的一句话说明 */
const NEED_LOGIN_TIP: Record<string, string> = {
  quark: '需要登录你自己的夸克账号。',
  uc: '需要登录你自己的 UC 账号。',
  xunlei: '需要登录你自己的迅雷账号。',
  baidu: '需要登录你自己的百度账号。',
}

/* ------------------------------------------------------------------ */
/* 设置弹窗：左侧分类导航 + 右侧一屏一组                                */
/* ------------------------------------------------------------------ */

/** 分类。组数与每屏条目数是照调研（lx-music / shadcn-admin / Motrix）定的：一屏放得下一组。 */
const SET_TABS = [
  { id: 'general', name: '通用' },
  { id: 'download', name: '下载' },
  { id: 'net', name: '网络' },
  { id: 'account', name: '网盘账号' },
  { id: 'ext', name: '浏览器插件' },
  { id: 'update', name: '更新' },
  { id: 'endpoint', name: '解析接口' },
  { id: 'adv', name: '高级' },
] as const

type TabId = (typeof SET_TABS)[number]['id']

/** 回收站保留期限的可选档位（天）。0 = 永不自动删；跟主进程 settings.js 的 0~3650 取值域一致。 */
const RETENTION_CHOICES = [0, 7, 14, 30, 60, 90]

function SettingsModal({
  initial,
  updateNotice,
  onClose,
  onSaved,
}: {
  initial: Settings
  /** 启动时自动检查发现的新版本（主进程推过来的，进来就显示在「更新」里） */
  updateNotice?: { latest: string; current: string; url: string; name?: string } | null
  onClose: () => void
  onSaved: (s: Settings) => void
}) {
  const [s, setS] = useState<Settings>(initial)
  /* saved = 最后一次落盘的那份。开关/数字是即时保存的，所以两者只会在「文本框」上有差别 */
  const [saved, setSaved] = useState<Settings>(initial)
  const [tab, setTab] = useState<TabId>('general')
  const [busy, setBusy] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const [rowErr, setRowErr] = useState<Record<string, string>>({})
  const [cookieKey, setCookieKey] = useState(LOGIN_TARGETS[0])
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginMsg, setLoginMsg] = useState('')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [upd, setUpd] = useState<{ state: 'idle' | 'checking' | 'latest' | 'new' | 'error'; data?: UpdateInfo }>(
    updateNotice
      ? {
          state: 'new',
          data: {
            ok: true,
            current: updateNotice.current,
            latest: updateNotice.latest,
            hasUpdate: true,
            url: updateNotice.url,
            name: updateNotice.name,
          },
        }
      : { state: 'idle' },
  )
  const [confirmReset, setConfirmReset] = useState(false)
  /* 安装版就地更新：主进程推状态，界面只负责显示和两个按钮 */
  const [auto, setAuto] = useState<UpdateState>({ state: 'idle' })

  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => {})
    api.updateState?.().then(setAuto).catch(() => {})
    return api.onUpdateState?.((d) => setAuto(d))
  }, [])

  const patch = (p: Partial<Settings>) => setS((v) => ({ ...v, ...p }))
  /* 「有没有改动」不能直接比 JSON.stringify：两侧的键顺序不一定一样（本地这份是编辑出来的，
   * 主进程回的那份是按它自己的顺序拼的），看起来一样的内容也会被判成「有改动」——
   * 结果就是点过任意一个开关之后，底部一直提示「文本框改完请点保存」、「保存」也一直是可点的。 */
  const dirty = stableJson(s) !== stableJson(saved)
  /* 只有打包过的安装版能就地更新（便携版解包到临时目录运行，没法替换自己） */
  const canAutoUpdate = !!(info?.packaged && !info?.portable)
  /* 「检查更新」按钮的忙碌态：安装版看自更新的状态，便携版看 GitHub 接口的状态 */
  const checking = canAutoUpdate ? auto.state === 'checking' : upd.state === 'checking'
  /* 网盘账号那页用：主进程只发打码串过来，打码串 = 本机存着一份真凭证（不是游客模式）。
   * maskedCookie 看的是「当前编辑框里是不是打码串」，storedMasked 看的是「磁盘上那份还在不在」——
   * 后者才是「清空输入框也不能把凭证弄丢」的依据（改完又清空时，编辑框里已经不是打码串了）。 */
  const maskedCookie = (s.cookies[cookieKey] ?? '') === COOKIE_MASK
  const storedMasked = (saved.cookies[cookieKey] ?? '') === COOKIE_MASK
  
  const setErr = (key: string, msg: string) => setRowErr((m) => ({ ...m, [key]: msg }))

  /**
   * 开关 / 下拉这类「不用校验也不会写坏」的改动：立刻落盘。
   * 失败（主进程会校验范围）就把这一项退回改前的值，并在那一行说明原因 —— 不能悄悄吞掉。
   */
  const instant = async (p: Partial<Settings>, key: string) => {
    const before: Partial<Settings> = {}
    for (const k of Object.keys(p) as (keyof Settings)[]) before[k] = s[k] as never
    setS((v) => ({ ...v, ...p }))
    if (rowErr[key]) setErr(key, '')
    try {
      const next = await api.setSettings(p)
      setSaved(next)
      /* 同步给上层：下次打开设置时 initial 就是最新的，不然关掉再打开会看到旧值，
         更糟的是上层那份旧值会在下一次改动时被原样回写（把刚改好的数字顶回去）。 */
      onSaved(next)
    } catch (e) {
      setS((v) => ({ ...v, ...before }))
      setErr(key, errText(e))
    }
  }

  /** 开机自启动要真写系统登录项，走专门的通道（主进程写完再回来报结果） */
  const toggleAutoStart = async (on: boolean) => {
    setS((v) => ({ ...v, autoStart: on }))
    setErr('autoStart', '')
    try {
      await api.setAutoStart(on)
      const nv = { ...saved, autoStart: on }
      setSaved(nv)
      onSaved(nv)
      setInfo(await api.appInfo())
    } catch (e) {
      setS((v) => ({ ...v, autoStart: !on }))
      setErr('autoStart', errText(e))
    }
  }

  const needAck =
    (s.parseEndpoints || []).some((e) => e.enabled !== false && (e.url || '').trim() !== '') && !s.endpointAck

  const save = async () => {
    if (needAck) return
    setBusy(true)
    setSaveErr('')
    try {
      const got = await api.setSettings(s)
      onSaved(got)
      onClose()
    } catch (e: unknown) {
      /* 主进程会校验设置（范围、路径、令牌长度…），把它的原话显示出来，
       * 否则用户只会看到「点了保存没反应」。 */
      setSaveErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const doLogin = async () => {
    setLoginBusy(true)
    try {
      const r = await api.openLogin(cookieKey)
      if (r && r.ok) {
        /* 凭证由主进程直接落盘，渲染层只刷新一份脱敏副本（拿到的是打码串） */
        const fresh = await api.getSettings()
        setS(fresh)
        setSaved(fresh)
        setLoginMsg(
          r.loggedIn
            ? `${label(cookieKey)} 已登录并保存（${r.count ?? 0} 条凭证）。`
            : `已抓取 ${r.count ?? 0} 条凭证，但没检测到明确的登录状态——下载时若提示需要登录，请重新登录一次。`,
        )
      } else {
        setLoginMsg(r?.message || '未获取到登录凭证')
      }
    } catch (e) {
      setLoginMsg(errText(e))
    } finally {
      setLoginBusy(false)
    }
  }

  const checkUpd = async () => {
    /* 安装版让 electron-updater 自己去比版本；便携版读不了自己的安装信息，只能用 GitHub 接口 */
    if (canAutoUpdate) {
      setAuto({ state: 'checking' })
      const r = await api.updateAppCheck()
      if (!r.ok) setAuto({ state: 'error', message: r.message || '检查失败' })
      return
    }
    setUpd({ state: 'checking' })
    try {
      const r = await api.checkUpdate({ manual: true })
      if (!r.ok) setUpd({ state: 'error', data: r })
      else if (r.hasUpdate) setUpd({ state: 'new', data: r })
      else setUpd({ state: 'latest', data: r })
    } catch (e) {
      setUpd({ state: 'error', data: { ok: false, current: '', message: errText(e) } })
    }
  }

  const doReset = async () => {
    setConfirmReset(false)
    try {
      const got = await api.resetSettings()
      setS(got)
      setSaved(got)
      onSaved(got)
      setSaveErr('')
    } catch (e) {
      setSaveErr(errText(e))
    }
  }

  /* openPath 打不开时是「返回原因」而不是抛异常 —— 不看返回值就等于点了没反应 */
  const openExtFolder = async () => {
    const r = await api.bridgeOpenFolder()
    if (!r.ok) setSaveErr(`打不开插件文件夹：${r.message || '未知原因'}`)
    else setSaveErr('')
  }

  /* 只有安装版真能写系统登录项；便携版/开发模式这一行要说明白为啥不生效 */
  const autoStartDesc = !info
    ? undefined
    : !info.packaged
      ? '开发模式下不生效。'
      : info.portable
        ? '便携版换个位置或换台机器就失效。'
        : undefined

  return (
    <div className="mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings">
        <h2>
          设置
          <button className="x" onClick={onClose} title="关闭">
            ✕
          </button>
        </h2>
        <div className="set-shell">
          <nav className="set-nav">
            {SET_TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                {t.name}
                {t.id === 'update' && upd.state === 'new' ? <span className="navdot" /> : null}
              </button>
            ))}
          </nav>

          <div className="set-pane">
            {tab === 'general' && (
              <>
                <Section title="启动">
                  <Row title="开机自启动" desc={autoStartDesc} err={rowErr.autoStart}>
                    <Switch checked={!!s.autoStart} onChange={toggleAutoStart} />
                  </Row>
                  {!!s.autoStart && (
                    <Row
                      indent
                      title="启动时显示主窗口"
                    >
                      <Switch
                        checked={!!s.startupShowWindow}
                        onChange={(v) => instant({ startupShowWindow: v }, 'startupShowWindow')}
                      />
                    </Row>
                  )}
                </Section>
                <Section title="关闭">
                  <Row
                    title="显示托盘图标"
                    desc={
                      s.trayIcon === false
                        ? '关掉后没有托盘入口，关闭窗口会直接退出。'
                        : '托盘图标可以叫回窗口、打开下载目录、退出程序。'
                    }
                    err={rowErr.trayIcon}
                  >
                    <Switch
                      checked={s.trayIcon !== false}
                      onChange={(v) => instant({ trayIcon: v }, 'trayIcon')}
                    />
                  </Row>
                  <Row
                    title="关闭窗口后留在后台下载"
                    desc={s.trayIcon === false ? undefined : '要完全退出：托盘图标右键 →「退出」。'}
                    err={rowErr.closeToTray}
                  >
                    <Switch
                      checked={s.closeToTray !== false}
                      disabled={s.trayIcon === false}
                      onChange={(v) => instant({ closeToTray: v }, 'closeToTray')}
                    />
                  </Row>
                  <Row title="下载完成后打开下载目录">
                    <Switch
                      checked={!!s.openFolderWhenDone}
                      onChange={(v) => instant({ openFolderWhenDone: v }, 'openFolderWhenDone')}
                    />
                  </Row>
                </Section>
                <Section title="下载位置">
                  <Row stack title="下载目录">
                    <div className="row">
                      <input
                        type="text"
                        value={s.downloadDir}
                        onChange={(e) => patch({ downloadDir: e.target.value })}
                      />
                      <button
                        onClick={async () => {
                          const dir = await api.pickDir()
                          if (dir) patch({ downloadDir: dir })
                        }}
                      >
                        选择…
                      </button>
                    </div>
                  </Row>
                </Section>
                <Section title="回收站">
                  <Row stack title="回收站目录" err={rowErr.trashDir}>
                    <div className="row">
                      <input
                        type="text"
                        value={s.trashDir || ''}
                        onChange={(e) => patch({ trashDir: e.target.value })}
                      />
                      <button
                        onClick={async () => {
                          const dir = await api.pickDir('trash')
                          if (dir) patch({ trashDir: dir })
                        }}
                      >
                        选择…
                      </button>
                    </div>
                  </Row>
                  <Row
                    title="自动清理"
                    desc="超过期限的文件从回收站里彻底删除。"
                    err={rowErr.trashRetentionDays}
                  >
                    <select
                      className="select"
                      value={String(RETENTION_CHOICES.includes(Number(s.trashRetentionDays)) ? Number(s.trashRetentionDays) : 30)}
                      onChange={(e) => instant({ trashRetentionDays: Number(e.target.value) }, 'trashRetentionDays')}
                    >
                      {RETENTION_CHOICES.map((d) => (
                        <option key={d} value={d}>
                          {d === 0 ? '永不' : `${d} 天`}
                        </option>
                      ))}
                    </select>
                  </Row>
                </Section>
              </>
            )}

            {tab === 'download' && (
              <>
                <Section title="aria2（百度 / 迅雷 / 蓝奏云走这条）">
                  <NumberRow
                    title="同时下载任务数"
                    value={s.maxConcurrent}
                    min={1}
                    max={20}
                    onCommit={(n) => instant({ maxConcurrent: n }, 'maxConcurrent')}
                    err={rowErr.maxConcurrent}
                  />
                  <NumberRow
                    title="单任务分片数（split）"
                    value={s.split}
                    min={1}
                    max={64}
                    onCommit={(n) => instant({ split: n }, 'split')}
                    err={rowErr.split}
                  />
                  <NumberRow
                    title="每服务器最大连接数"
                    value={s.maxConnectionPerServer}
                    min={1}
                    max={64}
                    onCommit={(n) => instant({ maxConnectionPerServer: n }, 'maxConnectionPerServer')}
                    err={rowErr.maxConnectionPerServer}
                  />
                  <Row stack title="最小分片大小">
                    <input
                      type="text"
                      placeholder="1M"
                      value={s.minSplitSize}
                      onChange={(e) => patch({ minSplitSize: e.target.value })}
                    />
                  </Row>
                </Section>

                <Section title="分段引擎（夸克 / UC / 直链走这条）">
                  <Row
                    stack
                    title="每个网盘的连接数"
                    desc="填 0 就改用 aria2。"
                    err={rowErr.segConnections}
                  >
                    <div className="ep-netdisks">
                      {SEG_TARGETS.map((k) => (
                        <span key={k} className="seg-conn">
                          <span className="ep-hint">{label(k)}</span>
                          <NumBox
                            value={s.segConnections?.[k] ?? 0}
                            min={0}
                            max={256}
                            onCommit={(n) =>
                              instant(
                                { segConnections: { ...(s.segConnections || {}), [k]: n } },
                                'segConnections',
                              )
                            }
                          />
                        </span>
                      ))}
                    </div>
                  </Row>
                  <NumberRow
                    title="百度网盘并发（默认 1）"
                    desc="超级会员可调到 4~8；速度变成 0 就是被限了，调回 1。"
                    value={s.baiduConnections ?? 1}
                    min={1}
                    max={16}
                    onCommit={(n) => instant({ baiduConnections: n }, 'baiduConnections')}
                    err={rowErr.baiduConnections}
                  />
                </Section>
              </>
            )}

            {tab === 'net' && (
              <>
                <Section title="代理">
                  <ProxySection s={s} patch={patch} />
                </Section>
                <Section title="证书">
                  <Row
                    title="忽略证书错误"
                    desc="打开后不校验证书，只在必要时用。"
                    err={rowErr.ignoreCert}
                  >
                    <Switch checked={!!s.ignoreCert} onChange={(v) => instant({ ignoreCert: v }, 'ignoreCert')} />
                  </Row>
                </Section>
                <Section title="其它">
                  <Row stack title="自定义 User-Agent">
                    <input type="text" value={s.userAgent} onChange={(e) => patch({ userAgent: e.target.value })} />
                  </Row>
                  <NumberRow
                    title="aria2 RPC 端口"
                    value={s.aria2Port}
                    min={1024}
                    max={65535}
                    onCommit={(n) => instant({ aria2Port: n }, 'aria2Port')}
                    err={rowErr.aria2Port}
                  />
                </Section>
              </>
            )}

            {tab === 'account' && (
              <Section title="网盘账号">
                {/* 四家各自的状态摆在一行里，不用来回切下拉才知道谁登过 */}
                <div className="acct-chips">
                  {LOGIN_TARGETS.map((k) => {
                    const on = !!(s.cookies[k] || '').trim()
                    return (
                      <button
                        key={k}
                        className={`acct-chip${cookieKey === k ? ' on' : ''}`}
                        onClick={() => setCookieKey(k)}
                        title={on ? `${label(k)}：本机已保存凭证` : `${label(k)}：还没有凭证，解析会走游客身份`}
                      >
                        <i className={on ? 'dot ok' : 'dot'} />
                        {label(k)}
                        <span className="dim">{on ? '已保存' : '未登录'}</span>
                      </button>
                    )
                  })}
                </div>

                <Row stack title="账号" desc="凭证只存在这台电脑上。">
                  <div className="acct-form">
                    <div className="row">
                      <select className="select" value={cookieKey} onChange={(e) => setCookieKey(e.target.value)}>
                        {COOKIE_TARGETS.map((k) => (
                          <option key={k} value={k}>
                            {label(k)}
                          </option>
                        ))}
                      </select>
                      {LOGIN_TARGETS.includes(cookieKey) && (
                        <>
                          <button disabled={loginBusy} onClick={doLogin}>
                            {loginBusy ? '请在弹出的窗口里登录…' : `登录${label(cookieKey)}`}
                          </button>
                          <button
                            onClick={async () => {
                              await api.clearLogin(cookieKey)
                              /* 退出登录要立刻落盘：这里清了浏览器分区，配置里那份也一起清掉，
                               * 免得留下一个「分区已登出、配置里还攥着旧凭证」的中间状态。 */
                              const next = await api.setSettings({ cookies: { ...s.cookies, [cookieKey]: '' } })
                              setS((v) => ({ ...v, cookies: { ...next.cookies } }))
                              setSaved(next)
                              onSaved(next)
                              setLoginMsg(`已清除 ${label(cookieKey)} 的登录状态`)
                            }}
                          >
                            退出登录
                          </button>
                        </>
                      )}
                    </div>
                    <input
                      type="text"
                      placeholder={maskedCookie ? '已保存，粘贴新凭证可换账号' : '粘贴凭证'}
                      value={maskedCookie ? '' : s.cookies[cookieKey] ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        /* 清空输入框永远不等于「删凭证」：磁盘上本来有一份就退回那份（打码串），
                         * 只有本来就什么都没有（或点「退出登录」）才会真的变成空。
                         * 不然用户打一半反悔、或者手滑全选删掉，就得重新登录一遍。 */
                        const val = v === '' ? (storedMasked ? COOKIE_MASK : '') : v
                        patch({ cookies: { ...s.cookies, [cookieKey]: val } })
                      }}
                    />
                    {loginMsg && <div className="desc">{loginMsg}</div>}
                  </div>
                </Row>
              </Section>
            )}

            {tab === 'ext' && (
              <Section title="浏览器插件接收通道">
                <BridgeSection />
              </Section>
            )}

            {tab === 'update' && (
              <>
                <Section title="版本">
                  <Row
                    title={`PanBox ${info ? info.version : '…'}`}
                    desc={info ? (info.packaged ? (info.portable ? '便携版' : '安装版') : '开发模式（npm start）') : '读取中…'}
                  >
                    <button disabled={checking} onClick={checkUpd}>
                      {checking ? '正在检查…' : '检查更新'}
                    </button>
                  </Row>
                  <div className="updbox" aria-live="polite">
                    {canAutoUpdate ? (
                      <>
                        {auto.state === 'idle' && <div className="desc">点上面的「检查更新」查一次。</div>}
                        {auto.state === 'checking' && <div className="desc">正在检查…</div>}
                        {auto.state === 'latest' && <div className="desc">已是最新版本（{auto.version || (info ? info.version : '')}）。</div>}
                        {auto.state === 'available' && (
                          <>
                            <div className="upd-title">发现新版本 {auto.version}</div>
                            <div className="desc">装好后程序文件就地替换，设置、任务和登录状态都保留。</div>
                          </>
                        )}
                        {auto.state === 'downloading' && (
                          <>
                            <div className="desc">正在下载 {auto.percent ? auto.percent.toFixed(0) : 0}%</div>
                            <div className="bar">
                              <i style={{ transform: `scaleX(${(auto.percent || 0) / 100})` }} />
                            </div>
                          </>
                        )}
                        {auto.state === 'downloaded' && <div className="desc">下载完成，点「重启并安装」。</div>}
                        {auto.state === 'error' && <div className="desc">更新失败：{auto.message || '未知原因'}</div>}
                        <div className="row">
                          {(auto.state === 'available' || auto.state === 'downloading' || auto.state === 'error') && (
                            <button
                              className="primary"
                              disabled={auto.state === 'downloading'}
                              onClick={async () => {
                                const r = await api.updateDownload()
                                if (!r.ok) setAuto({ state: 'error', message: r.message || '下载失败' })
                              }}
                            >
                              {auto.state === 'downloading' ? '正在下载' : '下载更新'}
                            </button>
                          )}
                          {auto.state === 'downloaded' && (
                            <button className="primary" onClick={() => api.updateInstall()}>
                              重启并安装
                            </button>
                          )}
                          <button onClick={() => api.openRelease('https://github.com/Ygq156/PanBox/releases/latest')}>打开发布页</button>
                        </div>
                      </>
                    ) : (
                      <>
                        {upd.state === 'idle' && <div className="desc">点上面的「检查更新」查一次。</div>}
                        {upd.state === 'checking' && <div className="desc">正在检查…</div>}
                        {upd.state === 'latest' && (
                          <div className="desc">已是最新版本（{upd.data?.latest ?? upd.data?.current}）。</div>
                        )}
                        {upd.state === 'new' && (
                          <>
                            <div className="upd-title">发现新版本 {upd.data?.latest}</div>
                            <div className="desc">便携版请下载新包替换。</div>
                            <div className="row">
                              <button className="primary" onClick={() => api.openRelease(upd.data?.url || '')}>
                                打开发布页
                              </button>
                            </div>
                          </>
                        )}
                        {upd.state === 'error' && (
                          <>
                            <div className="upd-title err">检查失败</div>
                            <div className="desc">可能是访问不到 GitHub（{upd.data?.message || '网络不通'}）。</div>
                            <div className="row">
                              <button onClick={checkUpd}>重试</button>
                              <button onClick={() => api.openRelease('https://github.com/Ygq156/PanBox/releases/latest')}>
                                打开发布页
                              </button>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                  <Row
                    title="自动检查更新"
                    err={rowErr.autoCheckUpdate}
                  >
                    <Switch
                      checked={s.autoCheckUpdate !== false}
                      onChange={(v) => instant({ autoCheckUpdate: v }, 'autoCheckUpdate')}
                    />
                  </Row>
                </Section>
                <Section title="链接">
                  <Row title="项目主页 / 源码">
                    <div className="row">
                      <button onClick={() => api.openRelease('https://github.com/Ygq156/PanBox')}>打开 GitHub</button>
                      <button onClick={openExtFolder}>插件文件夹</button>
                    </div>
                  </Row>
                </Section>
              </>
            )}

            {tab === 'endpoint' && (
              <Section title="用户自备的解析接口">
                <EndpointSection
                  list={s.parseEndpoints || []}
                  onChange={(next) => patch({ parseEndpoints: next })}
                  ack={!!s.endpointAck}
                  onAck={(v) => patch({ endpointAck: v })}
                />
              </Section>
            )}

            {tab === 'adv' && (
              <Section title="重置">
                <div className="danger">
                  <div className="danger-title">恢复默认设置</div>
                  <div className="danger-desc">
                    把设置改回出厂值。<b>登录凭证和你自己填的解析接口会保留</b>，不必重新登录四个网盘。
                  </div>
                  {confirmReset ? (
                    <div className="row">
                      <button className="danger-btn" onClick={doReset}>
                        确认恢复
                      </button>
                      <button onClick={() => setConfirmReset(false)}>取消</button>
                    </div>
                  ) : (
                    <div className="row">
                      <button onClick={() => setConfirmReset(true)}>恢复默认设置…</button>
                    </div>
                  )}
                </div>
                <Row
                  title="浏览器插件版本"
                  desc="更新程序后，请在 chrome://extensions 里点一次「重新加载」。"
                >
                  <button onClick={openExtFolder}>打开插件文件夹</button>
                </Row>
              </Section>
            )}
          </div>
        </div>

        <div className="footer">
          {saveErr && (
            <span className="hint err" style={{ marginRight: 'auto' }}>
              {saveErr}
            </span>
          )}
          {needAck && (
            <span className="hint err" style={{ marginRight: 'auto' }}>
              请先勾选「用户承诺」
            </span>
          )}
          <span className="hint" style={{ marginRight: 'auto' }}>
            {dirty ? '开关与数字改动即时生效；文本框改完请点保存' : '开关与数字改动会立即保存'}
          </span>
          <button onClick={onClose}>关闭</button>
          <button className="primary" disabled={busy || needAck || !dirty} onClick={save}>
            {busy ? '保存中…' : '保存'}
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
  onRemoveFiles,
  needsLogin = false,
}: {
  result: ParseResult
  onDownload: (result: ParseResult, ids: string[]) => void
  onRemoveFiles?: (ids: string[]) => void
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
          <span className="badge ok" title="直链来自你配置的解析接口">
            解析接口 · {result.endpointName || '自定义'}
          </span>
        )}
        {onRemoveFiles && (
          <button
            className="ghost tiny"
            title="从列表移除这个链接的解析结果"
            onClick={() => onRemoveFiles(result.files.map((f) => f.id))}
          >
            ✕
          </button>
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
            {onRemoveFiles && (
              <button
                className="fdel"
                title="从列表移除这一项"
                onClick={() => onRemoveFiles([f.id])}
              >
                ✕
              </button>
            )}
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

/**
 * 下载队列里的一行。
 *
 * 为什么要单独拎出来 + memo：主进程在**下载中每 800ms** 推一次整表
 * （taskManager 的内容指纹一变就推），以前是每推一次就重渲染整个 App ——
 * 包括解析结果那半屏和全部队列行。现在只有「自己这一行的数据真的变了」的行才重渲染。
 *
 * ⚠️ 判定不能比对象身份：主进程每一轮都是新造的对象，身份永远不同。
 * 所以逐个字段比（就是要显示的那几个字段）。
 */
const TaskRow = memo(
  function TaskRow({
    t,
    busyJump,
    busyRefresh,
    onJump,
    onPause,
    onResume,
    onRefresh,
    onDeleteFile,
    onRemove,
  }: {
    t: DownloadTask
    busyJump: boolean
    busyRefresh: boolean
    onJump: (t: DownloadTask) => void
    onPause: (t: DownloadTask) => void
    onResume: (t: DownloadTask) => void
    onRefresh: (t: DownloadTask) => void
    onDeleteFile: (t: DownloadTask) => void
    onRemove: (t: DownloadTask, mode?: 'trash' | 'purge') => void
  }) {
    const pct = t.total > 0 ? Math.min(100, (t.completed / t.total) * 100) : t.status === 'complete' ? 100 : 0
    const barCls = t.status === 'complete' ? 'done' : t.status === 'error' ? 'err' : ''
    return (
      <div className="task">
        <div className="tcell">
          <div className="tname" title={t.name}>
            {t.name}
          </div>
          <div className="tsub">
            {label(t.netdisk)}
            {t.engine === 'seg' ? ' · 分段引擎' : t.engine === 'hls' ? ' · HLS 引擎' : ''}
            {t.route === 'proxy' ? ' · 走代理' : ''}
            {t.connections ? ` · ${t.connections} 连接` : ''}
            {t.errorMessage ? ` · ${t.errorMessage}` : ''}
          </div>
        </div>

        <div>
          <div className={`bar ${barCls}`}>
            <i style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <div className="meta">
            {formatSize(t.completed)} / {formatSize(t.total)} · {pct.toFixed(1)}%
          </div>
        </div>

        <div>
          <div className="speed">{t.status === 'active' ? formatSpeed(t.speed) : '—'}</div>
          <div className="meta">{t.status === 'active' ? `剩余 ${formatEta(t.total - t.completed, t.speed)}` : ' '}</div>
        </div>

        <div className="actions">
          <span className={`status-pill ${t.status}`}>{STATUS_TEXT[t.status]}</span>
          {(t.status === 'waiting' || t.status === 'paused') && (
            <button className="ghost tiny" title="插队" disabled={busyJump} onClick={() => onJump(t)}>
              {busyJump ? '…' : '⬆'}
            </button>
          )}
          {t.status === 'active' && (
            <button className="ghost tiny" title="暂停" onClick={() => onPause(t)}>
              ⏸
            </button>
          )}
          {(t.status === 'paused' || t.status === 'waiting') && (
            <button className="ghost tiny" title="继续" onClick={() => onResume(t)}>
              ▶
            </button>
          )}
          {(t.status === 'active' || t.status === 'paused' || t.status === 'error') && t.source && (
            <button
              className="ghost tiny"
              title="重新解析这条分享，用新的下载地址替换当前的。"
              disabled={busyRefresh}
              onClick={() => onRefresh(t)}
            >
              {busyRefresh ? '…' : '⟳'}
            </button>
          )}
          {t.status === 'complete' && (
            <button
              className="ghost tiny"
              title="删除文件（放进回收站，之后可以还原）"
              onClick={() => onDeleteFile(t)}
            >
              🗑
            </button>
          )}
          <button
            className="ghost tiny"
            title={t.status === 'complete' ? '移除（会问一句文件怎么处理）' : '移除（下到一半的会立刻回收转存副本）'}
            onClick={() => onRemove(t)}
          >
            ✕
          </button>
        </div>
      </div>
    )
  },
  (a, b) =>
    a.busyJump === b.busyJump &&
    a.busyRefresh === b.busyRefresh &&
    a.t.gid === b.t.gid &&
    a.t.name === b.t.name &&
    a.t.status === b.t.status &&
    a.t.completed === b.t.completed &&
    a.t.total === b.t.total &&
    a.t.speed === b.t.speed &&
    a.t.netdisk === b.t.netdisk &&
    a.t.engine === b.t.engine &&
    a.t.route === b.t.route &&
    a.t.connections === b.t.connections &&
    a.t.errorMessage === b.t.errorMessage &&
    a.t.source === b.t.source,
)

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  /** ✕ 点在一个「已下载完成」的任务上时，先问一句文件怎么处理 */
  const [confirmDel, setConfirmDel] = useState<{ gid: string; name: string } | null>(null)
  const [text, setText] = useState('')
  const [pwd, setPwd] = useState('')
  const [parsing, setParsing] = useState(false)
  const [results, setResults] = useState<ParseResult[]>([])
  const [hint, setHint] = useState<{ kind: '' | 'err' | 'ok'; msg: string }>({ kind: '', msg: '' })
  const [needLogin, setNeedLogin] = useState<string | null>(null)
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [refreshing, setRefreshing] = useState<string | null>(null)
  /** 正在插队的任务（点 ⬆ 到主进程回话之间的过渡态） */
  const [jumping, setJumping] = useState<string | null>(null)
  const [aria2, setAria2] = useState<Aria2Status>({ running: false })
  /** 启动时自动检查发现的新版本（只提示 + 打开下载页，不静默安装） */
  const [newVer, setNewVer] = useState<{ latest: string; current: string; url: string; name?: string } | null>(null)
  /** 程序版本（标题栏常驻）：报障时一眼能说清装的是哪一版 */
  const [ver, setVer] = useState('')

  /** 插件刚交过来、等着自动解析的地址（见下面 prefill 与那个 effect） */
  const wantParse = useRef('')
  /** 主进程没回话时的原因：不给出来的话，界面会永远停在「正在启动…」 */
  const [bootErr, setBootErr] = useState('')

  /* 启动时「拉一次快照」和「订阅推送」这两条 IPC 谁先回来没有保证，而主进程只在
   * 队列指纹变化时才推整表、空闲时不会自愈 —— 所以先订阅、后拉快照，并且一旦收到过
   * 推送，就不再让更早发出的那份快照把新一点的状态盖回去。
   * 五处更新都过 mergeTasks：下载中每 800ms 推来的整表虽然内容大半没变，也是全新对象，
   * 不合并的话队列里每一行都会跟着重渲染。 */
  const pushedRef = useRef(false)
  const applyTasks = useCallback((list: DownloadTask[]) => {
    pushedRef.current = true
    setTasks((prev) => mergeTasks(prev, list))
  }, [])

  /* 引擎状态是每 10 秒（还没连上时 2.5 秒）问一次的轮询，内容没变就别塞新对象，
   * 否则 App 整棵树跟着这个 tick 白重渲染一遍。 */
  const applyAria2 = useCallback((v: Aria2Status) => {
    setAria2((prev) => (prev && prev.running === v.running && prev.version === v.version ? prev : v))
  }, [])

  useEffect(() => {
    api.appInfo?.().then((i) => setVer(i?.version || '')).catch(() => {})
    api
      .getSettings()
      .then(setSettings)
      .catch((e) => setBootErr((e && e.message) || String(e || '未知错误')))
    api.aria2Status().then(applyAria2).catch(() => {})
    const off = api.onDownloadsUpdate(applyTasks)
    api
      .listDownloads()
      .then((list) => {
        if (!pushedRef.current) setTasks((prev) => mergeTasks(prev, list))
      })
      .catch(() => {})
    /* 主进程在后台替用户做的事（直链过期后自动换了一条之类）：用同一处提示条说一句，
     * 免得任务自己变了个样子而用户不知道发生了什么。 */
    const offNotice = api.onDownloadsNotice?.((d) => {
      if (d && d.text) setHint({ kind: 'ok', msg: d.text })
    })
    /* 浏览器插件投进来一个「网盘分享链接」时，主进程不会擅自决定下哪些文件，
     * 而是把链接送到这里填进输入框，让用户自己勾选。 */
    const offPre = api.onBridgePrefill?.((d) => {
      setText(d.url)
      /* 插件交过来的若是**下载入口**（蓝奏那条 `/fn?TOKEN`），到这一步就齐了：
       * 分享页那一步会被站点风控挡住，而这条入口页不会 —— 直接替用户点「解析」，
       * 少一步手动操作，也就少一次「点了没反应」的误会。
       * 分享链接本身仍然只预填：里面有什么文件、要不要提取码，得由用户看着决定。 */
      if (/^https?:\/\/[^/?#]+\/fn\?/i.test(d.url)) {
        wantParse.current = d.url
      }
      setHint({
        kind: 'ok',
        msg: d.message || `浏览器插件送来一个${label(d.netdisk)}分享链接，点「解析」看看里面有什么`,
      })
    })
    /* 主进程启动 4 秒后自己查一次更新，有新版本就推过来（设置里可以关掉自动检查） */
    const offUpd = api.onUpdateAvailable?.((d) => setNewVer(d))
    return () => {
      off()
      if (offNotice) offNotice()
      if (offPre) offPre()
      if (offUpd) offUpd()
    }
  }, [applyAria2, applyTasks])

  /* 引擎状态不是高频信息：连上后 10 秒问一次就够（任务进度是主进程推过来的，不用轮询）。
   * 还没连上时 2.5 秒问一次——应用启动的头一两秒 aria2 可能还没起来，
   * 问得太慢会让标题栏一直挂着「aria2 未连接」。 */
  useEffect(() => {
    const t = setInterval(() => {
      api.aria2Status().then(applyAria2).catch(() => {})
    }, aria2.running ? 10000 : 2500)
    return () => clearInterval(t)
  }, [aria2.running, applyAria2])

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

  /* 从解析结果里删条目：只动界面上这张列表，网盘上的文件一个都不碰。
   * 一个链接的文件被删光时整张卡片消失，顺手通知主进程把那个会话缓存释放掉。 */
  const removeFiles = useCallback(
    (sessionId: string, ids: string[]) => {
      const drop = new Set(ids)
      let gone = 0
      const next = results
        .map((r) => {
          if (!r.ok || r.sessionId !== sessionId) return r
          const files = r.files.filter((f) => {
            if (drop.has(f.id)) {
              gone++
              return false
            }
            return true
          })
          return { ...r, files }
        })
        .filter((r) => !r.ok || r.files.length > 0)
      if (!gone) return
      setResults(next)
      dropSessionsOf(next)
      setHint({ kind: 'ok', msg: `已从列表移除 ${gone} 项` })
    },
    [results, dropSessionsOf],
  )

  /* 从队列里移除一条任务。下到一半的直接移除（本地那点临时文件跟着清掉）；
   * 已经下完的问一句「文件怎么处理」—— 磁盘上的文件不该被一个 ✕ 悄悄留下或悄悄抹掉。 */
  const removeTask = useCallback(async (t: { gid: string; name: string; status?: string }, mode?: 'trash' | 'purge') => {
    if (t.status === 'complete' && !mode) {
      setConfirmDel({ gid: t.gid, name: t.name })
      return
    }
    /* 必须等 IPC 回来再刷新：移除要先把结果从引擎的停止列表里清掉，
     * 否则下一次轮询会把它原样读回来，看起来像「点了没反应」。 */
    try {
      const r = await api.removeTask(t.gid, mode)
      if (r && r.ok === false) setHint({ kind: 'err', msg: r.message || '移除失败' })
      else if (mode === 'trash') setHint({ kind: 'ok', msg: `已把「${r?.name || t.name}」放进回收站，之后可以还原` })
      else if (mode === 'purge') setHint({ kind: 'ok', msg: `已彻底删除「${r?.name || t.name}」` })
      setConfirmDel(null)
      const list = (await api.listDownloads()) || []
      setTasks((prev) => mergeTasks(prev, list))
    } catch (e) {
      setHint({ kind: 'err', msg: `移除失败：${errText(e)}` })
      setConfirmDel(null)
    }
  }, [])

  /* 队列行的那几个按钮：都写成**稳定引用**的回调（useCallback 无依赖 / 只依赖 setXxx），
   * 否则 TaskRow 的 memo 每次都会被新的内联箭头打破，等于没 memo。 */
  const jumpTask = useCallback(async (t: DownloadTask) => {
    setJumping(t.gid)
    setHint({ kind: '', msg: `正在把「${t.name}」排到最前…` })
    try {
      const r = await api.jumpTask(t.gid)
      setHint(
        r.ok
          ? {
              kind: 'ok',
              msg: r.paused?.length
                ? `已插队；「${r.paused.join('」「')}」暂停让位，稍后自动继续`
                : `「${t.name}」已排到最前`,
            }
          : { kind: 'err', msg: r.message || '插队失败' },
      )
      const list = (await api.listDownloads()) || []
      setTasks((prev) => mergeTasks(prev, list))
    } catch (e) {
      setHint({ kind: 'err', msg: `插队失败：${errText(e)}` })
    }
    setJumping(null)
  }, [])

  const pauseTask = useCallback(async (t: DownloadTask) => {
    /* 失败要说出来：原来主进程吞成 false、界面也不看返回值，
     * 结果就是点了没反应，用户以为程序卡了 */
    const r = await api.pauseTask(t.gid)
    if (!r.ok) setHint({ kind: 'err', msg: r.message || '暂停失败' })
  }, [])

  const resumeTask = useCallback(async (t: DownloadTask) => {
    const r = await api.resumeTask(t.gid)
    if (!r.ok) setHint({ kind: 'err', msg: r.message || '继续失败' })
  }, [])

  const refreshTask = useCallback(async (t: DownloadTask) => {
    setRefreshing(t.gid)
    setHint({ kind: '', msg: `正在为「${t.name}」重新解析直链…` })
    try {
      const r = await api.refreshTask(t.gid)
      setHint({
        kind: r.ok ? 'ok' : 'err',
        msg: r.message || (r.ok ? '已换成新的下载地址' : '换直链失败'),
      })
    } catch (e) {
      setHint({ kind: 'err', msg: errText(e) })
    }
    setRefreshing(null)
  }, [])

  const deleteTaskFile = useCallback(async (t: DownloadTask) => {
    try {
      const r = await api.deleteTaskFile(t.gid)
      setHint(
        r.ok
          ? { kind: 'ok', msg: `已删除「${r.name || t.name}」，可在回收站还原` }
          : { kind: 'err', msg: r.message || '删除失败' },
      )
      const list = (await api.listDownloads()) || []
      setTasks((prev) => mergeTasks(prev, list))
    } catch (e) {
      setHint({ kind: 'err', msg: `删除失败：${errText(e)}` })
    }
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
      setHint({ kind: 'err', msg: errText(e) })
    } finally {
      setParsing(false)
    }
  }, [text, pwd, dropSessionsOf])

  /* 插件交了「下载入口」过来时替用户点一次「解析」。放在这里而不是 prefill 回调里：
   * 那个回调跑的时候 text 还是旧值，doParse 读的是 state。 */
  useEffect(() => {
    const want = wantParse.current
    if (!want || text.trim() !== want) return
    wantParse.current = ''
    doParse()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

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
      const msg = errText(e)
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
      /* 凭证由主进程落盘；界面这边只重新读一份脱敏副本 */
      const s = await api.getSettings()
      setSettings(s)
      setNeedLogin(null)
      setHint(
        r.loggedIn === false
          ? { kind: 'err', msg: `已抓取 ${r.count ?? 0} 条凭证，但没检测到明确的登录状态——请再登录一次。` }
          : { kind: 'ok', msg: `已登录并保存${label(netdisk)}凭证（${r.count ?? 0} 条）。请重新点「下载」。` },
      )
    } catch (e: unknown) {
      setHint({ kind: 'err', msg: errText(e) })
    }
  }, [])

  const stats = useMemo(() => {
    const active = tasks.filter((t) => t.status === 'active')
    return {
      speed: active.reduce((a, t) => a + (t.speed || 0), 0),
      activeCount: active.length,
    }
  }, [tasks])

  /* 解析结果那半屏跟下载队列无关，但以前下载中每 800ms 的整表推送会把这里也重渲染一遍
   * （`results` 里可能有几百个文件行，比队列本身还贵）。memo 成元素之后，
   * 依赖没变时元素引用不变，React 会整棵跳过。 */
  const resultsNode = useMemo(
    () => (
      <div className="results">
        {results.map((r, i) =>
          r.ok ? (
            <ResultPanel
              /* key 不用下标兜底：卡片里的勾选是它自己的状态，从列表中间删掉一张之后
               * 按位置复用实例会把勾选串到别的分享上。没有会话 id 时用「站点 + 来源链接」，
               * 同一次解析里这两样足以区分。 */
              key={r.sessionId || `${r.netdisk}:${r.source || ''}`}
              result={r}
              needsLogin={!settings?.cookies?.[r.netdisk]}
              onDownload={doDownload}
              onRemoveFiles={(ids) => removeFiles(r.sessionId || '', ids)}
            />
          ) : (
            <ErrorPanel key={r.source || `e${i}`} result={r} />
          ),
        )}
      </div>
    ),
    [results, settings?.cookies, doDownload, removeFiles],
  )

  /* 队列行整块也 memo 一次：App 因为别的原因（引擎状态轮询、提示条）重渲染时，
   * 元素引用没变 → React 直接跳过整棵子树；真变了再由 TaskRow 的 memo 逐行比字段。
   * 下载中主进程每 800ms 推一次全表，这里是最值钱的一处。 */
  const taskRows = useMemo(
    () =>
      tasks.map((t) => (
        <TaskRow
          key={t.gid}
          t={t}
          busyJump={jumping === t.gid}
          busyRefresh={refreshing === t.gid}
          onJump={jumpTask}
          onPause={pauseTask}
          onResume={resumeTask}
          onRefresh={refreshTask}
          onDeleteFile={deleteTaskFile}
          onRemove={removeTask}
        />
      )),
    [tasks, jumping, refreshing, jumpTask, pauseTask, resumeTask, refreshTask, deleteTaskFile, removeTask],
  )

  /* 设置弹窗本身有几百行 JSX 和 8 个页签分支，但它只认「设置内容」和「有没有新版本」。
   * memo 成元素之后，下载中每 800ms 的整表推送就不会再拖着它一起重渲染。 */
  const settingsNode = useMemo(
    () =>
      settings ? (
        <SettingsModal
          initial={settings}
          updateNotice={newVer}
          onClose={() => setShowSettings(false)}
          onSaved={setSettings}
        />
      ) : null,
    [settings, newVer],
  )

  if (!settings) {
    return (
      <div className="app">
        {bootErr ? (
          <>
            <div className="empty">启动失败：{bootErr}</div>
            <div className="empty small">
              多半是主进程没起来或界面与主进程版本不一致。重启 PanBox 再试；装的是
              安装版的话，先确认没有同时开着便携版。
            </div>
          </>
        ) : (
          <div className="empty">正在启动…</div>
        )}
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
        {/* 版本号常驻标题栏：报障时一眼能说清装的是哪一版，不用再猜 */}
        {ver ? <div className="ver" title="程序版本">v{ver}</div> : null}
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
          {newVer ? <span className="navdot" /> : null}
        </button>
      </div>

      <div className="body">
        <div className="pane-create">
          <div className="link-row">
            <input
              type="text"
              placeholder="粘贴网盘分享链接或直链，一行一个"
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

          {results.length > 0 && resultsNode}
        </div>

        <div className="pane-list">
          <div className="list-head">
            <span>下载队列（{tasks.length}）</span>
            <span className="grow" />
            {/* 主进程用 false 表示「没成功」（引擎没连上之类）。以前这里不看返回值，
                点了没反应，用户只能猜。 */}
            <button
              className="tiny"
              onClick={async () => {
                if (!(await api.pauseAll())) setHint({ kind: 'err', msg: '全部暂停失败，稍后再试' })
              }}
            >
              全部暂停
            </button>
            <button
              className="tiny"
              onClick={async () => {
                if (!(await api.resumeAll())) setHint({ kind: 'err', msg: '全部继续失败，稍后再试' })
              }}
            >
              全部继续
            </button>
            <button
              className="tiny"
              onClick={async () => {
                /* openPath 打不开时**返回**原因（不抛异常），以前这里不看返回值，
                 * 用户点了没动静也不知道为什么 */
                const err = await api.openPath(settings.downloadDir)
                if (err) setHint({ kind: 'err', msg: `没能打开目录：${err}` })
              }}
            >
              打开目录
            </button>
            <button className="tiny" onClick={() => setShowTrash(true)}>
              回收站
            </button>
          </div>

          <div className="scroll">
            {taskRows.length === 0 ? (
              <div className="empty">
                还没有下载任务。
              </div>
            ) : (
              taskRows
            )}
          </div>
        </div>
      </div>

      {showSettings && settingsNode}

      {showTrash && (
        <TrashModal retentionDays={settings?.trashRetentionDays ?? 30} onClose={() => setShowTrash(false)} />
      )}

      {/* 移除一个「已下载完成」的任务：磁盘上那份文件要用户自己说怎么处理 */}
      {confirmDel && (
        <div className="mask" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDel(null)}>
          <div className="modal confirm">
            <h2>删除这个文件？</h2>
            <div className="confirm-body">
              <div className="confirm-name" title={confirmDel.name}>
                {confirmDel.name}
              </div>
              <div className="confirm-note">
                放进回收站可以还原；彻底删除会连磁盘上的文件一起删掉。
              </div>
            </div>
            <div className="confirm-foot">
              <button className="keep" onClick={() => removeTask(confirmDel, 'trash')}>
                放进回收站
              </button>
              <button className="wipe" onClick={() => removeTask(confirmDel, 'purge')}>
                彻底删除
              </button>
              <button className="ghost" onClick={() => setConfirmDel(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
