/**
 * 组合键的匹配与显示。
 *
 * 这一层是纯的：不认识 React，也不认识应用里的任何东西。
 */

export interface KeyBinding {
  /**
   * 规范化键名。单字符键一律小写（`'b'`、`'1'`、`'/'`），
   * 其余保持 `event.key` 的原样（`'Escape'`、`'Tab'`、`'Delete'`）。
   */
  key: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

/**
 * 精确匹配：声明 `Ctrl+B` 就只认 `Ctrl+B`。
 *
 * 比原来 AppLayout 里那句 `(ctrlKey || metaKey) && key === 'k'` 严格。
 * 那种宽松写法让 `Ctrl+Shift+K`、`Ctrl+Alt+K` 也能打开搜索——真正的代价不是
 * 多打开一次搜索，而是以后每加一个绑定都要回头检查它有没有被别的绑定顺手吃掉。
 * 精确匹配把这件事变成一次性的。
 *
 * 全项目只面向 Windows / Edge（决策 D2），所以不再保留 Mac 的 Meta 分支：
 * 那句 `|| metaKey` 在 Windows 上没有任何作用，留着只会让上面那类问题更难看出来。
 */
export function matchesBinding(
  event: KeyboardEvent,
  binding: KeyBinding,
): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  return (
    key === binding.key &&
    event.ctrlKey === Boolean(binding.ctrl) &&
    event.altKey === Boolean(binding.alt) &&
    event.shiftKey === Boolean(binding.shift) &&
    event.metaKey === Boolean(binding.meta)
  )
}

/** 键名到界面写法的例外。没列到的按原样显示 */
const KEY_LABELS: Record<string, string> = {
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

/**
 * 组合键 → 界面写法，如 `Ctrl+Alt+1`。
 *
 * 修饰键顺序固定成 Ctrl / Alt / Shift，和 Milkdown 自己的
 * `formatKeymapShortcut` 一致，这样两边看起来是同一套写法。
 */
export function formatCombo(binding: KeyBinding): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push('Ctrl')
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')
  if (binding.meta) parts.push('Meta')

  const { key } = binding
  parts.push(KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key))
  return parts.join('+')
}

/** 一条条目的多个组合键 → 一行显示文本 */
export function formatComboList(bindings: readonly KeyBinding[]): string {
  return bindings.map(formatCombo).join(' / ')
}
