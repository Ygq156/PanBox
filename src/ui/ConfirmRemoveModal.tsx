/* ------------------------------------------------------------------ */
/* 移除确认                                                            */
/* ------------------------------------------------------------------ */

/**
 * 移除一个「已下载完成」的任务：磁盘上那份文件要用户自己说怎么处理。
 *
 * 纯展示：文件叫什么都不由这里决定，两个按钮点了以后怎么处理也由 App 执行
 * （要落盘、要调主进程），这里只负责把用户的选择交回去。
 */
export interface ConfirmRemoveModalProps {
  /** 要移除的文件名（标题上显示哪一条、鼠标悬停能看全） */
  name: string
  /** 放进回收站（能还原） */
  onTrash: () => void
  /** 彻底删除（连磁盘上的文件一起删） */
  onPurge: () => void
  /** 什么都不做 */
  onCancel: () => void
}

export function ConfirmRemoveModal({ name, onTrash, onPurge, onCancel }: ConfirmRemoveModalProps) {
  return (
    <div className="mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal confirm">
        <h2>删除这个文件？</h2>
        <div className="confirm-body">
          <div className="confirm-name" title={name}>
            {name}
          </div>
          <div className="confirm-note">
            放进回收站可以还原；彻底删除会连磁盘上的文件一起删掉。
          </div>
        </div>
        <div className="confirm-foot">
          <button className="keep" onClick={onTrash}>
            放进回收站
          </button>
          <button className="wipe" onClick={onPurge}>
            彻底删除
          </button>
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}