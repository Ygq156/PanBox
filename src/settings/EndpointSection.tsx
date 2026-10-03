import { EP_NETDISKS, label } from '../sites'
import { Field } from '../ui/parts'
import type { ParseEndpoint } from '../types'

/* ------------------------------------------------------------------ */
/* 网盘解析接口                                                        */
/* ------------------------------------------------------------------ */

/**
 * 用户自备的「解析站」接口。PanBox 内置解析走「用你自己的账号转存取直链」，
 * 速度上限就是你自己账号的档位；这类接口用自己的会员账号取链，所以能跑满。
 * 程序只负责转发链接、取出直链、交给下载引擎，**不内置也不推荐任何具体解析站**。
 */
export function EndpointSection({
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
        contentType: '',
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
          接口地址由你自己提供，可用占位：<b>{'{url}'} {'{pwd}'} {'{shareId}'} {'{netdisk}'}</b>。
          填了提取码时，提取码会随分享链接发给接口；你的网盘凭证<b>不会</b>发往接口。
        </>
      }
    >
      <div className="endpoint-add">
        <button onClick={add} disabled={list.length >= 8}>
          ＋ 添加接口
        </button>
        <span className="ep-hint">{list.length}/8</span>
      </div>

      {list.map((ep) => (
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
              placeholder="接口名称"
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
            placeholder="接口地址，如 https://example.com/api?url={url}"
            value={ep.url}
            onChange={(e) => upd(ep.id, { url: e.target.value })}
          />

          {ep.method === 'POST' && (
            <div className="row">
              <textarea
                rows={2}
                placeholder={'请求体模板，如 url={url}&pwd={pwd}'}
                value={ep.body || ''}
                onChange={(e) => upd(ep.id, { body: e.target.value })}
              />
              <input
                type="text"
                placeholder="请求内容类型，留空用 application/x-www-form-urlencoded"
                value={ep.contentType || ''}
                onChange={(e) => upd(ep.id, { contentType: e.target.value })}
              />
            </div>
          )}

          <div className="row">
            <input
              type="text"
              placeholder="直链字段路径，留空自动识别，如 data.url"
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
              placeholder="下载直链的请求头 JSON（可选）"
              value={typeof ep.dlHeaders === 'string' ? ep.dlHeaders : ep.dlHeaders ? JSON.stringify(ep.dlHeaders) : ''}
              onChange={(e) => upd(ep.id, { dlHeaders: e.target.value })}
            />
          </div>

          <div className="ep-netdisks">
            <span className="ep-hint">适用网盘（不勾 = 全部；直链要勾）：</span>
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