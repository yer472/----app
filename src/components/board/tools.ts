/**
 * 画板的工具。
 *
 * 「选择」和「橡皮」不是画图工具，但它们和画图工具互斥地占用同一份指针事件，
 * 所以放在同一个联合类型里切换，比用几组独立状态少一半的互斥判断。
 *
 * ⚠️ 这个联合**不要**再写成 `'select' | ShapeKind`。加了机构符号之后，
 * 图形种类和工具就不再一一对应了（「放置符号」是一种工具，但对应点符号和
 * 两点符号两种图形），派生关系一旦不成立，留着它只会让人以为「加一种图形
 * 就自动多一个工具」。现在多一种图形而忘了加工具是**编译错误**——
 * `BoardCanvas` 里的 `draftFor` 用 `assertNever` 收尾。
 */
export type ToolKind = 'select' | 'line' | 'rect' | 'ellipse' | 'pencil' | 'eraser'

/**
 * 当前上膛的工具。
 *
 * 「放置符号」不是一种工具而是一族——每种符号一个。所以它带一个 `ref`，
 * 而 `ToolKind` 装不下它。写成判别联合而不是「`tool` + 一个 `armedRef`
 * 两个变量」：后者会漏出「已上膛但 tool 还是 line」这类不一致，
 * 而联合类型让 `ref` 在 `kind === 'symbol'` 时**一定存在**。
 */
export type Tool = { kind: ToolKind } | { kind: 'symbol'; ref: string }

/** 工具在工具栏里的高亮判断：上膛的符号也算「不在任何普通工具上」 */
export function isToolActive(tool: Tool, kind: ToolKind): boolean {
  return tool.kind === kind
}

export interface ToolSpec {
  kind: ToolKind
  label: string
  /** 单键快捷键。沿用绘图软件的惯例，让肌肉记忆能迁移过来 */
  hotkey: string
}

/**
 * 工具表。**写成 `Record<ToolKind, ToolSpec>` 而不是数组**（原来就是数组）。
 *
 * 数组的话，「往 `ToolKind` 里加了一种工具、却忘了在工具栏上给它一个按钮」
 * 是**静默**的：类型系统知道它、`draftFor` 必须处理它、`TOOL_ICONS` 逼你起个
 * 名字——但它不在那张列表里，于是用户永远看不到它，而没有任何一处报错。
 * 换成 Record 之后，漏一个键就是编译错误。
 *
 * 声明顺序也是工具栏里给用户看的顺序：先选择，再按「从简单到复杂」排图元，
 * 橡皮放最后（它是「删」不是「画」，混在图元中间会让人误选）。
 *
 * 图标用 Unicode 字符而不是 SVG，和项目里 `⌕ ◐ ⚙ ◎` 那套保持一致。
 * 机构符号面板里的缩略图是真正的矢量图形——那会是这个项目第一次引入
 * 内联 SVG「图标」，届时要单独记一笔。
 */
export const TOOLS: Record<ToolKind, ToolSpec> = {
  select: { kind: 'select', label: '选择', hotkey: 'v' },
  line: { kind: 'line', label: '直线', hotkey: 'l' },
  rect: { kind: 'rect', label: '矩形', hotkey: 'r' },
  ellipse: { kind: 'ellipse', label: '椭圆', hotkey: 'o' },
  pencil: { kind: 'pencil', label: '手绘', hotkey: 'p' },
  eraser: { kind: 'eraser', label: '橡皮', hotkey: 'e' },
}

/**
 * 按声明顺序排好的工具。
 *
 * 顺序的出处只有 `TOOLS` 的声明顺序一处：对象的字符串键按插入顺序遍历，
 * 这是规范保证的，所以这里不需要再抄一份顺序数组（抄一份就是两处会漂移的约定）。
 */
export const TOOL_LIST: readonly ToolSpec[] = Object.values(TOOLS)

export const TOOL_ICONS: Record<ToolKind, string> = {
  select: '↖',
  line: '╱',
  rect: '▭',
  ellipse: '◯',
  pencil: '✎',
  eraser: '⌫',
}

/**
 * 快捷键 → 工具。用小写字母，匹配时把事件里的 key 也转成小写。
 *
 * 调用方还要保证**没有**按住 Shift / Alt / Ctrl：Shift 是「约束角度」，
 * 不排除的话 `Shift+V` 会在用户想画一条竖直线的时候把工具换成选择。
 */
export const HOTKEY_TO_TOOL = new Map<string, ToolKind>(
  TOOL_LIST.map((t) => [t.hotkey, t.kind]),
)
