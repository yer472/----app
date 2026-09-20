import { useEffect } from 'react'

/**
 * 打开的浮层数量。
 *
 * 全局快捷键必须知道「现在有没有东西盖在上面」。对话框开着的时候按 Ctrl+K，
 * 原来会一路导航到搜索页，把对话框连里面填了一半的输入框一起卸载掉——
 * 用户看到的是「我刚打的字没了」。画板更严重：画到一半被导航走，未保存的图全丢。
 *
 * 为什么是计数器而不是查 DOM（比如 querySelector('[aria-modal]')）：
 *
 *   1. 画板不是 dialog、也没有 role="dialog"，按属性查会漏掉它，
 *      而它恰恰是最需要挡住的那个（里面有未保存的图）。
 *   2. 查 DOM 会把快捷键层和标记结构绑死：以后给浮层换个写法就会静默失效，
 *      而失效的表现是「快捷键又开始乱跑了」，很难联想到是标记改了。
 *
 * 代价：计数必须配平，只加不减会让所有全局快捷键永久失效。
 * 所以只通过 useOverlay 增减——+1 在挂载、-1 在清理函数里，
 * React 保证清理一定会跑；开发模式下 StrictMode 的双次挂载也是对称的。
 */
let depth = 0

export function overlayOpen(): boolean {
  return depth > 0
}

/** 给自检脚本用：确认浮层开开关关之后计数回到了 0 */
export function overlayDepth(): number {
  return depth
}

export function useOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return
    depth += 1
    return () => {
      depth -= 1
    }
  }, [open])
}
