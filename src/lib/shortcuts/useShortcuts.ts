import { useEffect, useRef } from 'react'
import { entryOf, type ShortcutId } from './catalog'
import { matchesBinding } from './matcher'
import { overlayOpen } from './overlay'

/**
 * 一条绑定。
 *
 * **只带 id，不带组合键**——组合键从目录里查。
 * 这样「一览表上写的」和「按下去生效的」在数据上就是同一份。
 */
export interface Binding {
  id: ShortcutId
  run: () => void
}

/**
 * 注册表是一个栈：**栈顶（最后注册的）先匹配**。
 *
 * AppLayout 在挂载时注册全局键，页面在挂载时注册页面键，页面比 AppLayout 晚，
 * 所以页面级天然优先。这个顺序是设计的一部分，不是巧合——
 * 所以别把监听器改成捕获阶段，那会让注册顺序反过来。
 */
const stack: Array<() => Binding[]> = []
let listening = false

function onKeyDown(event: KeyboardEvent): void {
  // 第一件事：别人已经处理过的键，让开。
  //
  // ProseMirror 的 handleKeyDown 命中时会调用 event.preventDefault()
  // （node_modules/prosemirror-view/dist/index.js:3218），而它的监听器挂在
  // contenteditable 上、也就是 window 的**上游**，所以这里能看见它。
  // Ctrl+B 在编辑器里是「加粗」、在别处才是「折叠侧栏」，依据只有这一行。
  // 同理，CodeMirror 的代码块、画板、输入法的组合状态都靠这一条让位。
  if (event.defaultPrevented) return

  // 浮层（对话框 / 画板）盖在上面时，全局快捷键整体让位。
  // 不然在对话框里按 Ctrl+K 会连带把输入了一半的表单卸载掉。
  if (overlayOpen()) return

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    for (const binding of stack[i]()) {
      const entry = entryOf(binding.id)
      if (!entry.keys.some((combo) => matchesBinding(event, combo))) continue

      // 先 preventDefault 再 run：Ctrl+S 的浏览器「保存网页」对话框靠这一下关掉
      event.preventDefault()
      binding.run()
      return
    }
  }
}

function register(getBindings: () => Binding[]): () => void {
  stack.push(getBindings)
  if (!listening) {
    window.addEventListener('keydown', onKeyDown)
    listening = true
  }
  return () => {
    const index = stack.indexOf(getBindings)
    if (index >= 0) stack.splice(index, 1)
    if (stack.length === 0 && listening) {
      window.removeEventListener('keydown', onKeyDown)
      listening = false
    }
  }
}

/**
 * 把数组放进 ref、监听器只装一次。
 *
 * 每次渲染都会产生一批新闭包（run 里引用着当前的状态），
 * 但没必要为了拿到新闭包去反复装卸监听器——和 NoteEditor 里 onChangeRef
 * 是同一套做法，理由也一样。
 */
function useBindings(bindings: Binding[]): void {
  const ref = useRef(bindings)
  useEffect(() => {
    ref.current = bindings
  })
  useEffect(() => register(() => ref.current), [])
}

/** 全局快捷键。只在 AppLayout 里挂一次 */
export function useGlobalShortcuts(bindings: Binding[]): void {
  useBindings(bindings)
}

/**
 * 页面级快捷键。
 *
 * 和 useGlobalShortcuts 的实现完全一样，保留两个名字是为了让调用点一眼
 * 看出这条绑定的作用域，也为了以后给页面级加规则（比如切页时清空）有地方放。
 * 注销靠组件卸载时 effect 的清理函数，所以「在章节页注册的新建，
 * 跳到设置页之后还生效」不可能发生。
 */
export function usePageShortcuts(bindings: Binding[]): void {
  useBindings(bindings)
}

/**
 * 当前真正注册着的绑定 id，按注册顺序（栈底在前）。
 *
 * 只给自检脚本用：拿它和目录里的数据比对，能同时抓住
 * 「目录里写着、代码里没绑」和「代码里绑了、目录里没写」两种漂移。
 */
export function registeredIds(): string[] {
  return stack.flatMap((getBindings) => getBindings().map((b) => b.id))
}
