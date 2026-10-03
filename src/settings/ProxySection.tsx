import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ProxyStatus } from '../api'
import type { Settings } from '../types'
import { Field } from '../ui/parts'

/* ------------------------------------------------------------------ */
/* 网络出口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 实测（同一条 GitHub 66 MB 直链）：直连 CDN 单连接只有 0.03–0.04 MB/s，
 * 而且 github.com 那一跳会间歇性超时；走系统代理 8–11 MB/s。
 * 但代理不是人人都有（NDM 就和 Clash 冲突），所以默认 auto + 自动改走另一条路。
 */
export function ProxySection({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => void }) {
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
      label="网络代理（下 GitHub / 境外资源时用）"
      hint={
        <>
          当前实际使用：{st?.effective ? <code>{st.effective}</code> : '直连（不走代理）'}。改完自动重启下载引擎。
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