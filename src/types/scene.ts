import type { ID } from './models'

/**
 * 画板图元的**数据形状**。
 *
 * 放在 `types/` 而不是 `components/board/scene.ts`，因为它们是**落库的数据**：
 * 内嵌在导出 SVG 的 `<metadata>` 里，自定义符号也直接把它们存进数据库。
 * 数据访问层（`db/`、`repository/`）要用到这些类型，让它反过来去 import
 * `components/` 是层次倒挂。
 *
 * 几何运算（命中测试、吸附、变换）仍然在 `components/board/scene.ts` 里，
 * 那里 re-export 这里，所以老代码 `import { type Shape } from './scene'`
 * 一行都不用改。
 */

export interface Point {
  x: number
  y: number
}

/**
 * 直线、矩形、椭圆统一用两个锚点 a / b 表示，而不是各自一套字段——
 * 这样「创建时拖出形状」和「选中后拖一个锚点」是同一个逻辑。
 *
 * 矩形和椭圆用对角点而不是「左上角 + 宽高」：拖拽时锚点是哪个角取决于
 * 用户从哪个方向拉出来的，用对角点就不用在拖拽过程中反复归一化。
 *
 * 两种符号见 `components/board/symbols.ts`：`symbol` 是定尺寸、可旋转的点符号，
 * `link` 是长度由两端点决定的两点符号。分成两个种类而不是一个带可空 `b` 的种类，
 * 是因为两者的几何坐标系根本不同。
 */
export type Shape =
  | { id: ID; kind: 'line'; a: Point; b: Point }
  | { id: ID; kind: 'rect'; a: Point; b: Point }
  | { id: ID; kind: 'ellipse'; a: Point; b: Point }
  | { id: ID; kind: 'pencil'; points: Point[] }
  | { id: ID; kind: 'symbol'; ref: string; at: Point; rotation: number }
  | { id: ID; kind: 'link'; ref: string; a: Point; b: Point }

export type ShapeKind = Shape['kind']

/**
 * 哪些图元允许出现在**自定义符号**里。
 *
 * 一处定义、两处用：`SymbolRepository` 存之前照着它过滤，`lib/backup/format.ts`
 * 恢复备份时照着它校验。这两处**必须一致**——一边允许、一边不允许的表现是
 * 「画完保存了，导出再导入回来符号就缺了一块」。原来两个文件里各写了一份
 * 一模一样的 `Set`，那正是会漂移的写法。
 *
 * 写成一整张 `Record<ShapeKind, boolean>` 而不是 `Set<string>`：那种写法下
 * 往 `Shape` 联合里加一种图形**不会报错**，而后果是「在符号编辑器里画了它、
 * 一保存就没了」——静默的数据丢失。现在是映射类型，加一种图形就必须在这里表态。
 *
 * `symbol` / `link` 为 false：符号里放符号会形成递归。模块和流向将来也是
 * false，除了同样的理由，还因为 `defOfCustomSymbol` 会把符号的图元摊平成一份
 * **零件表**——摊平之后就没有「场景」了，流向的几何在那个形态下算不出来。
 */
export const SYMBOL_SHAPE_KINDS: Record<ShapeKind, boolean> = {
  line: true,
  rect: true,
  ellipse: true,
  pencil: true,
  symbol: false,
  link: false,
}
