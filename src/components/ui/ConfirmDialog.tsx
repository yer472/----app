import { useState, type ReactNode } from 'react'
import { Button } from './Button'
import { Modal } from './Modal'
import { Notice } from './Notice'

interface ConfirmDialogProps {
  open: boolean
  title: string
  /** 危险操作的说明，例如「将同时删除 3 个章节和 12 篇笔记」 */
  message: ReactNode
  confirmText?: string
  /**
   * 确认动作。可以是异步的。
   *
   * 抛错时这个组件会**让对话框留在原地**并把原因显示出来——删除/导入这类
   * 操作失败率虽然低，但失败的信息不能丢：调用方原本写的是裸 `await`，
   * 一旦抛错，`setDialog(null)` 执行不到，用户看到的就是「点了删除按钮，
   * 什么也没发生」，而错误只躺在控制台里。
   */
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '删除',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 上一次失败的报错不该跟到下一次打开。
  //
  // 写法是「渲染期调整 state」而不是 useEffect：effect 里 setState 会多跑
  // 一轮渲染，而且这个组件是常驻挂载的（父组件一直渲染它，只是 open 变化），
  // 用 key 强制重建又会把调用点都改一遍。React 官方对这种「props 变了要重置
  // 内部 state」的场景给的就是这个写法。
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setError(null)
  }

  const handleConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      // 成功与否、关不关，由调用方决定（它自己 setDialog(null)）。
      // 这里不主动关：调用方可能只改了数据、想留着对话框。
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      // 处理中不许关：关掉之后这次操作失败的话，用户就再也看不到原因了
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            variant="danger"
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmText}
          </Button>
        </>
      }
    >
      <div className="text-sm text-neutral-600 dark:text-neutral-400">
        {message}
      </div>
      {error ? (
        <Notice tone="error" className="mt-3">
          {error}
        </Notice>
      ) : null}
    </Modal>
  )
}
