import { label } from '../sites'
import type { ParseResult } from '../types'

/* ------------------------------------------------------------------ */
/* 解析失败卡片                                                        */
/* ------------------------------------------------------------------ */

/** 解析失败的那半屏：哪一家、哪条链接、为什么失败（要不要填提取码） */
export function ErrorPanel({ result }: { result: ParseResult }) {
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