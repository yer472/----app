import { useEffect, type ReactNode } from 'react'
import { useOverlay } from '@/lib/shortcuts/overlay'

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

export function Modal({ open, title, onClose, children, footer }: ModalProps) {
  // 对话框开着的时候，让全局快捷键整体让位。
  // 少了这一步，在对话框里按 Ctrl+K 会一路导航去搜索页，
  // 把对话框连里面填了一半的输入框一起卸载掉。
  useOverlay(open)

  // Esc 关闭 —— 桌面端的基本预期。
  //
  // 挂在 window 的**捕获**阶段，不是冒泡阶段。
  // 画板在自己的容器上无条件 stopPropagation（为了挡住全局快捷键），
  // 而对话框是画板的子节点，事件冒泡到 body 就被拦住了——
  // 挂冒泡阶段的监听器在画板里永远收不到 Esc。捕获阶段从 window 往下走，
  // 一定先于画板那个冒泡处理器。
  //
  // 处理完就 stopPropagation：既让画板自己的 Esc 逻辑（「有改动先确认」）
  // 不重复响应，也让画板里嵌套的任何对话框都能关掉——
  // 原来画板是靠一处 `if (confirmingClose)` 特判才能关，新加的对话框都是死的。
  //
  // 已知局限：stopPropagation 不会阻止同一节点上的其它监听器，
  // 所以两个对话框同时开着会一起关。目前应用里没有叠加对话框的场景。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        // 只有点遮罩本身才关闭，点内容区不关
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-neutral-900">
        <div className="border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {title}
          </h2>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
