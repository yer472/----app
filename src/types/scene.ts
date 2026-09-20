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
