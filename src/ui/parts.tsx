import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

/* ------------------------------------------------------------------ */
/* 小积木                                                              */
/* ------------------------------------------------------------------ */

/** 结果面板里的一条提示 */
export function Tip({ warn, children }: { warn?: boolean; children: ReactNode }) {
  return <div className={`result-note${warn ? ' warn' : ''}`}>{children}</div>
}

/** 设置页里的分组：原来所有字段平铺成一长条，找不到东西 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sec">
      <h3>{title}</h3>
      <div className="sec-body">{children}</div>
    </section>
  )
}

export function Field({
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

/** 开关本体。文案一律是「状态陈述」（登录时启动），不要写成「开启 XX」。 */
export function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch${checked ? ' on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  )
}

/** 设置页的一行：左边标题 + 说明，右边控件。说明必须写清「这个开关到底干了什么」。 */
export function Row({
  title,
  desc,
  children,
  err,
  indent,
  stack,
}: {
  title: ReactNode
  desc?: ReactNode
  children?: ReactNode
  err?: string
  indent?: boolean
  stack?: boolean
}) {
  return (
    <div className={`srow${indent ? ' indent' : ''}${stack ? ' stackrow' : ''}`}>
      <div className="srow-text">
        <div className="srow-title">{title}</div>
        {desc ? <div className="srow-desc">{desc}</div> : null}
        {err ? <div className="srow-desc err">{err}</div> : null}
      </div>
      {children ? <div className="srow-ctl">{children}</div> : null}
    </div>
  )
}

/**
 * 数字输入。刻意**不在 onChange 里写盘**：边打字边保存会把「192」拆成 1、12、192 存三次，
 * 中途那两次是给正在跑的任务换连接数。失焦或回车才提交。
 */
export function NumBox({
  value,
  min,
  max,
  onCommit,
}: {
  value: number
  min: number
  max: number
  onCommit: (n: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const n = Number(draft.trim())
    if (!draft.trim() || !Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const next = Math.max(min, Math.min(max, Math.round(n)))
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

export function NumberRow({
  title,
  desc,
  value,
  min,
  max,
  onCommit,
  err,
}: {
  title: ReactNode
  desc?: ReactNode
  value: number
  min: number
  max: number
  onCommit: (n: number) => void
  err?: string
}) {
  return (
    <Row title={title} desc={desc} err={err}>
      <NumBox value={value} min={min} max={max} onCommit={onCommit} />
    </Row>
  )
}