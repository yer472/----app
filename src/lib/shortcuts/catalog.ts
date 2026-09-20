import type { KeyBinding } from './matcher'

/**
 * 快捷键目录。
 *
 * **组合键在整个项目里只在这里出现一次。** 绑定代码只携带条目的 id，
 * 组合键一律从这里查（见 useShortcuts.ts）。这样一来「设置页里写的」和
 * 「按下去真正生效的」在数据上就是同一份，不可能出现
 * 「说明里写着 Ctrl+/，代码里绑的却是 Ctrl+\」这种漂移。
 *
 * 目录里同时收录三类东西，靠 `by` 区分：
 *
 *   - `by: 'app'` / `'ui'`：本 App 自己实现的，会被真正绑定（有对应 Binding）
 *   - `by: 'editor'`：Milkdown Crepe 自带的，我们只描述、不实现
 *   - `by: 'board'`：画板内部实现的，同上
 *
 * 后两类只作为「一览表的数据」存在，没有对应 Binding——所以别看到目录里有
 * 就以为按下去会有反应，实现方在 `by` 字段里。
 */

/** 分组。用字符串字面量联合而不是 enum —— tsconfig 开了 erasableSyntaxOnly */
export type ShortcutGroup = 'global' | 'page' | 'editor' | 'board'

/** 这条由谁实现。也决定自检脚本怎么验它 */
export type ShortcutOwner = 'app' | 'editor' | 'board' | 'ui'

export interface ShortcutEntry {
  id: string
  group: ShortcutGroup
  /**
   * 一个或多个组合键。多个时展示成 `A / B`，任一命中即可。
   * 声明成 readonly 是因为整个表用了 as const，可变数组类型会在 satisfies 处报错。
   */
  keys: readonly KeyBinding[]
  label: string
  /** 值得在界面上讲清楚的例外。没有就不显示 */
  caveat?: string
  by: ShortcutOwner
}

const RAW = [
  // ---------- 全局 ----------
  {
    id: 'search',
    group: 'global',
    by: 'app',
    keys: [{ key: 'k', ctrl: true }],
    label: '打开搜索',
    caveat: '对话框或画板开着时不生效',
  },
  {
    id: 'shortcuts',
    group: 'global',
    by: 'app',
    keys: [{ key: '/', ctrl: true }],
    label: '跳到这份快捷键一览',
    caveat: '光标在代码块里时，会被代码编辑器的「切换注释」占用',
  },
  {
    id: 'toggle-sidebar',
    group: 'global',
    by: 'app',
    keys: [{ key: 'b', ctrl: true }],
    label: '折叠 / 展开侧栏',
    caveat: '光标在正文编辑器里时，Ctrl+B 是「加粗」',
  },
  {
    id: 'close-dialog',
    group: 'global',
    by: 'ui',
    keys: [{ key: 'Escape' }],
    label: '关闭当前对话框',
    caveat: '画板里有未保存的改动时会先问一次',
  },

  // ---------- 页面（跟着当前所在页面变） ----------
  {
    id: 'create-new',
    group: 'page',
    by: 'app',
    keys: [{ key: 'n', alt: true }],
    label: '新建科目 / 章节 / 笔记',
    caveat: '按当前所在页面决定新建什么；搜索页和设置页没有新建动作，按下去不会有反应',
  },
  {
    id: 'save-now',
    group: 'page',
    by: 'app',
    keys: [{ key: 's', ctrl: true }],
    label: '立即保存当前笔记',
    caveat: '只在笔记页生效；不等那 1 秒的自动保存防抖',
  },
  {
    id: 'finish-title',
    group: 'page',
    by: 'app',
    keys: [{ key: 'Enter' }],
    label: '结束标题输入并立刻保存',
    caveat: '光标在笔记标题框里时',
  },

  // ---------- 编辑器（Milkdown Crepe 自带） ----------
  {
    id: 'ed-bold',
    group: 'editor',
    by: 'editor',
    keys: [{ key: 'b', ctrl: true }],
    label: '加粗',
  },
  {
    id: 'ed-italic',
    group: 'editor',
    by: 'editor',
    keys: [{ key: 'i', ctrl: true }],
    label: '斜体',
  },
  {
    id: 'ed-code',
    group: 'editor',
    by: 'editor',
    keys: [{ key: 'e', ctrl: true }],
    label: '行内代码',
  },
  {
    id: 'ed-quote',
    group: 'editor',
    by: 'editor',
    keys: [{ key: 'b', ctrl: true, shift: true }],
    label: '引用块',
  },
  {
    id: 'ed-heading',
    group: 'editor',
    by: 'editor',
    keys: [{ key: '1', ctrl: true, alt: true }],
    label: '标题一 ~ 六级',
    caveat: 'Ctrl+Alt+1 到 Ctrl+Alt+6 依次是一级到六级标题',
  },
  {
    id: 'ed-paragraph',
    group: 'editor',
    by: 'editor',
    keys: [{ key: '0', ctrl: true, alt: true }],
    label: '变回正文段落',
  },
  {
    id: 'ed-ol',
    group: 'editor',
    by: 'editor',
    keys: [{ key: '7', ctrl: true, alt: true }],
    label: '有序列表',
  },
  {
    id: 'ed-ul',
    group: 'editor',
    by: 'editor',
    keys: [{ key: '8', ctrl: true, alt: true }],
    label: '无序列表',
  },
  {
    id: 'ed-codeblock',
    group: 'editor',
    by: 'editor',
    keys: [{ key: 'c', ctrl: true, alt: true }],
    label: '代码块',
  },
  {
    id: 'ed-strike',
    group: 'editor',
    by: 'editor',
    keys: [{ key: 'x', ctrl: true, alt: true }],
    label: '删除线',
  },
  {
    id: 'ed-undo',
    group: 'editor',
    by: 'editor',
    keys: [{ key: 'z', ctrl: true }],
    label: '撤销',
  },
  {
    id: 'ed-redo',
    group: 'editor',
    by: 'editor',
    keys: [
      { key: 'y', ctrl: true },
      { key: 'z', ctrl: true, shift: true },
    ],
    label: '重做',
  },
  {
    id: 'ed-indent',
    group: 'editor',
    by: 'editor',
    keys: [{ key: 'Tab' }],
    label: '列表缩进（两个空格）',
    caveat: '在表格里是跳到下一个单元格；因此 Tab 不会把光标移出编辑器',
  },
  {
    id: 'ed-table',
    group: 'editor',
    by: 'editor',
    keys: [
      { key: ']', ctrl: true },
      { key: '[', ctrl: true },
    ],
    label: '表格：下一个 / 上一个单元格',
    caveat: '只在表格里生效；Tab / Shift+Tab 也行',
  },
  {
    id: 'ed-slash',
    group: 'editor',
    by: 'editor',
    keys: [{ key: '/' }],
    label: '打开插入菜单（标题、列表、图片、表格…）',
    caveat: '在段落或标题的行首敲 / 才有反应',
  },
  {
    id: 'ed-paste-image',
    group: 'editor',
    by: 'editor',
    keys: [{ key: 'v', ctrl: true }],
    label: '粘贴截图 / 图片',
    caveat: 'Win+Shift+S 截图后直接粘贴，图片会压缩到长边 1600px 以内再存',
  },

  // ---------- 绘图（只在画板打开时） ----------
  {
    id: 'bd-tools',
    group: 'board',
    by: 'board',
    keys: [
      { key: 'v' },
      { key: 'l' },
      { key: 'r' },
      { key: 'o' },
      { key: 'p' },
      { key: 'e' },
    ],
    label: '画板工具：选择 / 直线 / 矩形 / 椭圆 / 手绘 / 橡皮',
    caveat:
      '依次对应 V、L、R、O、P、E；按住 Shift 或 Alt 不算（Shift 是「约束角度」）',
  },
  {
    id: 'bd-undo',
    group: 'board',
    by: 'board',
    keys: [{ key: 'z', ctrl: true }],
    label: '撤销',
    caveat: '深度 50 步',
  },
  {
    id: 'bd-redo',
    group: 'board',
    by: 'board',
    keys: [
      { key: 'z', ctrl: true, shift: true },
      { key: 'y', ctrl: true },
    ],
    label: '重做',
  },
  {
    id: 'bd-delete',
    group: 'board',
    by: 'board',
    keys: [{ key: 'Delete' }, { key: 'Backspace' }],
    label: '删除选中的图形',
    caveat: '要先用「选择」工具点中它',
  },
  {
    id: 'bd-close',
    group: 'board',
    by: 'board',
    keys: [{ key: 'Escape' }],
    label: '关闭画板',
    caveat: '有未保存的改动时会先问一次',
  },
] as const satisfies readonly ShortcutEntry[]

/**
 * 所有合法的条目 id。
 *
 * 由数据推导而来，所以绑定代码里写错 id 是**编译错误**，
 * 不是运行时才发现的问题。
 */
export type ShortcutId = (typeof RAW)[number]['id']

const BY_ID = new Map<string, ShortcutEntry>(
  RAW.map((entry): [string, ShortcutEntry] => [entry.id, entry]),
)

/** 按 id 取条目。多一道运行时兜底：写错的 id 立刻炸，而不是静默不生效 */
export function entryOf(id: ShortcutId): ShortcutEntry {
  const entry = BY_ID.get(id)
  if (!entry) throw new Error(`快捷键目录里没有 ${id}`)
  return entry
}

export function allEntries(): readonly ShortcutEntry[] {
  return RAW
}

/** 按分组取条目，顺序就是声明顺序 */
export function entriesOf(group: ShortcutGroup): ShortcutEntry[] {
  return RAW.filter((entry) => entry.group === group)
}

export const GROUP_ORDER: readonly {
  id: ShortcutGroup
  title: string
  note: string
}[] = [
  { id: 'global', title: '全局', note: '在任何页面都生效' },
  { id: 'page', title: '页面', note: '跟着当前所在页面变' },
  {
    id: 'editor',
    title: '编辑器',
    note: '由编辑器（Milkdown Crepe）自带，不是本 App 实现的。光标在正文里时，它们优先于上面的全局快捷键。',
  },
  { id: 'board', title: '绘图', note: '只在画板（全屏浮层）打开时生效' },
]

/** 设置页里那一节的 DOM id，也是 Ctrl+/ 的滚动目标 */
export const SHORTCUTS_SECTION_ID = 'shortcuts'

/**
 * 跳到设置页某一段时用的 location.state 形状。
 *
 * 用 state 而不是 `#hash`：hash 会让浏览器在设置页还是个空壳的时候
 * 就去执行原生锚点滚动（这页要等 backup.hydrate() 才有内容），我们会跟它抢。
 */
export interface SettingsScrollState {
  scrollTo: string
}
