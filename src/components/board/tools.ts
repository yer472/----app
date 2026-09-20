import type { ShapeKind } from './scene'

/**
 * 画板的工具。
 *
 * 「选择」不是画图工具，但它和画图工具互斥地占用同一份指针事件，
 * 所以放在同一个联合类型里切换，比用两个独立状态少一半的互斥判断。
 */
export type ToolKind = 'select' | ShapeKind

export interface ToolSpec {
  kind: ToolKind
  label: string
  /** 单键快捷键。沿用绘图软件的惯例，让肌肉记忆能迁移过来 */
  hotkey: string
}

/**
 * 工具栏的顺序也是给用户看的顺序：先选择，再按「从简单到复杂」排图元。
 *
 * 图标用 Unicode 字符而不是 SVG，和项目里 `⌕ ◐ ⚙ ◎` 那套保持一致。
 * 阶段 2 的机构符号面板需要真正的矢量图形，那会是这个项目第一次引入
 * 内联 SVG 图标，届时再单独记一笔。
 */
export const TOOLS: ToolSpec[] = [
  { kind: 'select', label: '选择', hotkey: 'v' },
  { kind: 'line', label: '直线', hotkey: 'l' },
  { kind: 'rect', label: '矩形', hotkey: 'r' },
  { kind: 'ellipse', label: '椭圆', hotkey: 'o' },
  { kind: 'pencil', label: '手绘', hotkey: 'p' },
]

export const TOOL_ICONS: Record<ToolKind, string> = {
  select: '↖',
  line: '╱',
  rect: '▭',
  ellipse: '◯',
  pencil: '✎',
}

/** 快捷键 → 工具。用小写字母，匹配时把事件里的 key 也转成小写 */
export const HOTKEY_TO_TOOL = new Map<string, ToolKind>(
  TOOLS.map((t) => [t.hotkey, t.kind]),
)
