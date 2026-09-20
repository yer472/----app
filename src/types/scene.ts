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
  /*
   * 上面两种是 M6.5 的机构符号，下面两种是模块图的模块与流向。
   *
   * `flow` 是本项目**第一个跨图形引用**：它只存两个模块的 id，**一个坐标都不存**。
   * 几何由两端模块的位置推导（见 scene.ts 的 `routeFlow`），于是「模块一移动、
   * 箭头跟着走」是数据层面的必然，而不是靠「端点正好重合」这种巧合——后者是
   * M6.5 机构语义的做法，在那里够用（构件本来就是手摆的）；而流向要表达的是
   * 「从 A 到 B」，不是「从这一点到那一点」。
   *
   * `node` 沿用 `rect` 那套对角点 `a`/`b`，于是「拖角点改尺寸」和「拖出一个
   * 新模块」用的是同一套索引逻辑，不需要再引入一套 x/y/w/h。
   *
   * `fill` / `stroke` 存的是**字面十六进制色值**，不是 CSS 变量、也不是 Tailwind
   * 类名：导出的 SVG 在 `<img>` 里是独立文档，继承不到页面的任何东西
   * （见 render.tsx 的 INK_COLOR 注释），存变量名等于存了一个解析不出来的字符串。
   */
  | { id: ID; kind: 'node'; a: Point; b: Point; text: string; fill: string }
  | { id: ID; kind: 'flow'; from: ID; to: ID; stroke: string }

/**
 * 图元的种类。
 *
 * 单独立一个类型是为了让「按种类穷尽」的写法能成立——好几处 `Record<ShapeKind, …>`
 * 都是靠它把「加了图形种类却忘了改某张表」变成编译错误。
 */
export type ShapeKind = Shape['kind']

/** 模块。单独取个名字，是因为凡是要读它的 `a`/`b`/`text` 的地方都得先窄一次 */
export type SceneNode = Extract<Shape, { kind: 'node' }>

/** 流向。它自己没有几何——几何在 `routeFlow` 里由两端模块推导 */
export type Flow = Extract<Shape, { kind: 'flow' }>

/** 流向从模块的哪条边出去 / 进哪条边 */
export type FlowSide = 'left' | 'right' | 'top' | 'bottom'

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
 * `symbol` / `link` 为 false：符号里放符号会形成递归。`node` / `flow` 同理，
 * 而且还有一层更硬的理由——`defOfCustomSymbol` 会把符号的图元摊平成一份
 * **零件表**，摊平之后就没有「场景」了，流向的几何（要按 id 查两端模块）
 * 在那个形态下根本算不出来。
 */
export const SYMBOL_SHAPE_KINDS: Record<ShapeKind, boolean> = {
  line: true,
  rect: true,
  ellipse: true,
  pencil: true,
  symbol: false,
  link: false,
  node: false,
  flow: false,
}
