import { newId } from '@/lib/id'
import type { ID } from '@/types/models'
import type { Flow, FlowSide, Point, SceneNode, Shape } from '@/types/scene'
// 只引类型。symbols.ts 反过来要引这里的 Point，于是两边构成一个**纯类型**的
// 循环——`import type` 在编译后会被完全抹掉，运行期没有这个环。
// 别把它改成值导入，那才会真的转不起来。
import type { PointSymbolDef } from './symbols'
import { builtInPointDef, hitsParts, linkDef } from './symbols'

/**
 * 画板的场景模型。
 *
 * 这里是纯数据 + 纯函数：不碰 React、不碰 DOM。命中测试、吸附、包围盒、
 * 拖拽位移全都能脱离浏览器验证，画布组件只负责把指针事件翻译成这里的调用。
 *
 * 场景是「一页固定尺寸的图纸」而不是无限画布——因为这里是 SVG 坐标，
 * 与窗口大小无关：画布用 viewBox 缩放来适配可视区，所以窗口怎么变、
 * 缩放多少，存取下来的坐标都不变。无限画布会带来平移和「画面之外还有什么」
 * 的问题，而这个功能是给笔记配图，不需要。
 */

// 图元的**数据形状**在 types/scene.ts（数据访问层也要用它们，放在这里会让
// db/ 反过来 import components/）。这里 re-export，老代码不用改。
export type {
  Flow,
  FlowSide,
  Point,
  SceneNode,
  Shape,
  ShapeKind,
} from '@/types/scene'

export interface Scene {
  /** 图纸的逻辑尺寸，坐标系的边界 */
  width: number
  height: number
  /** 绘制顺序即数组顺序，越靠后越在上层 */
  shapes: Shape[]
  /**
   * 这张图用到的**点符号定义**，插入时把定义抄一份进来。
   *
   * 为什么内联而不是每次去符号库里查：
   *
   * 1. **删掉一个自定义符号，已经画好的图照常打得开**——图里存着它当时的副本。
   * 2. **撤销一致**：删掉图里最后一个该符号的实例、再撤销，定义跟着一起回来。
   *    定义放在库或画板级 state 里的话，「撤销时定义回不回来」就成了一个
   *    必须单独决策、而且很容易漏的问题。
   * 3. 导出的 SVG 自带几何，`DrawingPicker` 的缩略图（直接 `<img src=blob>`）
   *    一行都不用改。
   *
   * 代价（是产品语义，不是 bug，文档里要写清楚）：**改一个自定义符号，
   * 已经画好的图不会跟着变**，改动只影响之后放的。想更新老图就把里面那个
   * 符号删掉重新放一个。
   *
   * 两点符号不在这里：它们的定义是代码里的生成器（见 symbols.ts），
   * `JSON.stringify` 存不下函数。
   */
  defs?: Record<string, PointSymbolDef>
}

/**
 * 跨图形上下文：**一个图形的几何可能需要知道别的图形在哪**。
 *
 * 今天只有流向用得上——它的两端是模块的 id，画到哪里去要按 id 查那两个模块
 * 的位置。其它图形（直线、矩形、符号……）的几何只依赖自己，收下这个上下文
 * 也用不着，所以只有真的要跨图形信息的两个函数收它：`shapeToParts`
 * （算渲染几何）和 `hitsShape`（算命中）。
 *
 * ⚠️ **这两个函数的 `ctx` 是必填参数，不许改成可选。** 改成可选的话，
 * 任何一个忘了传的调用点都会**在两个渲染器上同时静默地什么都不画**——
 * 画布上少一块、导出的图里也少一块，两边都不报错。那正是当初把
 * `ShapeView` 和 `createShapeElement` 合并成 `shapeToParts` 要消灭的那类故障
 * （见 render.tsx 的文件头）。必填才会逼着每个调用点表态。
 */
export interface SceneContext {
  /** 内联在场景里的点符号定义 */
  defs: SceneDefs
  /**
   * 按 id 索引的全部图形。
   *
   * 装的是**整个场景**而不只是模块：这样将来任何一种「引用别的图形」的新
   * 图形都能直接用，不用再动这个类型；查出来的东西是不是自己要的种类，
   * 由用它的那个函数自己判（流向会检查它查到的两条都是不是 `node`）。
   */
  byId: ReadonlyMap<ID, Shape>
}

/** 收一次场景，供需要跨图形信息的地方用 */
export function contextOf(scene: Scene): SceneContext {
  return { defs: scene.defs, byId: new Map(scene.shapes.map((s) => [s.id, s])) }
}

/**
 * 「没有别的图形可查」的空上下文。
 *
 * 自定义符号的图元用它：符号的定义被摊平成一份零件表存进场景，
 * 之后就是**自成一体的局部坐标系**，跟画布上别的东西没有关系。
 */
export const EMPTY_CONTEXT: SceneContext = { defs: undefined, byId: new Map() }

/** 图纸默认尺寸。4:3，够画一个四杆机构还有余量 */
export const PAGE_WIDTH = 1200
export const PAGE_HEIGHT = 900

/** 网格间距。机构简图随手画很难看，对齐网格是最省事的改善 */
export const GRID_SIZE = 20

/** 命中判定的容差（图纸坐标单位）。太小点不中，太大会误选相邻的线 */
export const HIT_TOLERANCE = 6

/**
 * 橡皮的容差，比选中宽松一倍。
 *
 * 机构图里构件密、铰链挨着铰链，用 6 的话用户得瞄得很准才擦得掉，
 * 而擦不掉的表现是「橡皮不好使」，很难联想到是容差的问题。
 */
export const ERASE_TOLERANCE = 12

/**
 * 两点符号端部铰链圆的命中余量。
 *
 * 小圆画在线段之外（圆心正好在端点上、半径 9），不加这一档的话
 *「点在那个圆上却没选中」会很难受。
 */
const JOINT_HIT_SLACK = 6

export function createScene(): Scene {
  return { width: PAGE_WIDTH, height: PAGE_HEIGHT, shapes: [] }
}

/**
 * 穷尽性守卫：走到这里说明有个图形种类没人处理。
 *
 * **这是编译期的检查，不是运行期的兜底**——传进来的值在类型上必须是
 * `never`，所以往 `Shape` 联合里加一种图形而漏改某个 switch 时，报错的是
 * 编译器，不是半夜画图的人。
 *
 * 为什么必须显式写这一句：`tsconfig` 开了 `noImplicitReturns`，它能抓住
 * 「没有 default 分支的 switch」漏了返回值；但**有 default 分支的 switch
 * 它抓不到**——那个 default 本身就是把新种类吞掉的地方（`translateShape`
 * 原来的 default 会去读 `shape.a`，而点符号没有 `a`）。
 */
export function assertNever(value: never): never {
  throw new Error(`画板里出现了没处理过的图形种类：${JSON.stringify(value)}`)
}

// ---------------------------------------------------------------- 几何辅助

/** 点到线段的最短距离。命中测试的基础 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy

  // 退化成一点（拖拽过程中经常出现），直接算点到点
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)

  // 把 p 投影到 ab 上，t 夹到 [0,1] 之内保证落在线段而不是延长线上
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
  )
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** 把两个对角点归一化成左上角 + 宽高 */
export function normalizeRect(
  a: Point,
  b: Point,
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

/**
 * 对齐到网格。
 *
 * `gridSize` 可传：符号编辑器的画框只有几十个单位，20 的网格在那里太粗，
 * 会把任何一笔都吸成一团。
 */
export function snapToGrid(
  p: Point,
  enabled: boolean,
  gridSize: number = GRID_SIZE,
): Point {
  if (!enabled) return p
  return {
    x: Math.round(p.x / gridSize) * gridSize,
    y: Math.round(p.y / gridSize) * gridSize,
  }
}

// ---------------------------------------------------------------- 吸附

/**
 * 端点吸附的容差（图纸坐标单位）。
 *
 * 网格是 20，所以半格多一点——比「必须精确戳到端点」宽松得多，
 * 又比 `HIT_TOLERANCE = 6` 大，不至于要用户瞄得很准。
 */
export const SNAP_TOLERANCE = 12

/**
 * 一个形状上「值得对上去」的点。
 *
 * 矩形的四个角算——把一条线吸到矩形的角上是常事。手绘只有首尾算，
 * 中间的点是笔迹本身，吸上去只会让线条变形。模块和矩形同理：把一条自由
 * 直线吸到模块的角上是常事。
 */
export function snapTargetsOf(shape: Shape, defs: SceneDefs): Point[] {
  switch (shape.kind) {
    case 'line':
    case 'link':
      return [shape.a, shape.b]
    case 'rect':
    case 'ellipse':
    case 'node': {
      const r = normalizeRect(shape.a, shape.b)
      return [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h },
        { x: r.x, y: r.y + r.h },
      ]
    }
    case 'pencil': {
      const first = shape.points[0]
      const last = shape.points[shape.points.length - 1]
      if (!first || !last) return []
      return first === last ? [first] : [first, last]
    }
    // 点符号的锚点就是它的「铰链点」：把一根杆吸到一个转动副的圆心上，
    // 靠的就是把这里也算成吸附目标
    case 'symbol':
      return symbolAnchors(shape, defs)
    // 流向没有可吸的点：它的两端是**推导**出来的，不是用户摆的。
    // 把它算成吸附目标只会让自由图元的端点莫名其妙地被拽过去
    case 'flow':
      return []
    default:
      return assertNever(shape)
  }
}

/** 场景里所有可吸附的点。`excludeId` 用来把正在拖的那个形状排除掉，
 *  否则它会吸到自己身上，一动都动不了 */
export function collectSnapTargets(
  scene: Scene,
  excludeId?: ID,
): Point[] {
  return scene.shapes
    .filter((s) => s.id !== excludeId)
    .flatMap((s) => snapTargetsOf(s, scene.defs))
}

export interface SnapHit {
  at: Point
  distance: number
}

/** 在候选点里找最近的一个，超出容差返回 null */
export function snapToPoints(
  targets: readonly Point[],
  p: Point,
  tolerance: number = SNAP_TOLERANCE,
): SnapHit | null {
  let best: SnapHit | null = null
  for (const at of targets) {
    const distance = Math.hypot(at.x - p.x, at.y - p.y)
    if (distance > tolerance) continue
    if (best === null || distance < best.distance) best = { at, distance }
  }
  return best
}

// ---------------------------------------------------------------- 角度约束

/** Shift 约束的粒度 */
export const ANGLE_STEP_DEG = 15

/**
 * 把 b 约束到「从 a 出发、方向是 `stepDeg` 整数倍」的射线上，长度不变。
 *
 * 用 `Math.hypot` 保长度、只改方向：这样吸到 15° 的整数倍时线不会被缩短，
 * 用户来回拖也不会越拖越短。
 */
export function constrainToAngle(
  a: Point,
  b: Point,
  stepDeg: number = ANGLE_STEP_DEG,
): Point {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return b
  const step = (stepDeg * Math.PI) / 180
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: a.x + Math.cos(angle) * length, y: a.y + Math.sin(angle) * length }
}

/**
 * 把 b 约束成相对 a 的正方形对角点（矩形变正方形、椭圆变正圆）。
 *
 * 边长取较大的那一维，符号跟着原来的方向走——不这么取的话，从左上往右下
 * 拖时会突然缩成一个点。方向用 `>=` 判断而不是 `Math.sign`：正好相等时
 * `sign` 会给 0，那就真的缩成一个点了。
 */
export function constrainToSquare(a: Point, b: Point): Point {
  const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  return {
    x: a.x + (b.x >= a.x ? side : -side),
    y: a.y + (b.y >= a.y ? side : -side),
  }
}

export interface Measurement {
  length: number
  /** 度数，0~360 */
  angleDeg: number
}

/** 两点之间的长度和方向，用于页脚的读数 */
export function measure(a: Point, b: Point): Measurement {
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  const raw = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  return { length, angleDeg: (raw + 360) % 360 }
}

/**
 * 点符号的局部坐标 → 图纸坐标。
 *
 * 变换是 `translate(at) · rotate(rotation)`，和导出 SVG 里那个
 * `<g transform>` 完全一致——**两处必须用同一个公式**，否则「画布上看着
 * 在这里、导出之后在那里」。`rotation` 用度，和 SVG 的 `rotate()` 一样。
 */
export function toWorld(local: Point, at: Point, rotationDeg: number): Point {
  const rad = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: at.x + local.x * cos - local.y * sin,
    y: at.y + local.x * sin + local.y * cos,
  }
}

/** `toWorld` 的逆变换。命中判定要把点转回局部坐标再按零件测 */
export function toLocal(p: Point, at: Point, rotationDeg: number): Point {
  const rad = (-rotationDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p.x - at.x
  const dy = p.y - at.y
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos }
}

/** 点符号的锚点在图纸坐标里的位置 */
export function symbolAnchors(shape: Shape, defs: SceneDefs): Point[] {
  if (shape.kind !== 'symbol') return []
  const def = defs?.[shape.ref]
  // 定义查不到时只认插入点：图形还在、还能被选中和删掉，只是没有锚点
  if (!def) return [shape.at]
  return def.anchors.map((a) => toWorld(a.at, shape.at, shape.rotation))
}

export type SceneDefs = Scene['defs']

// ---------------------------------------------------------------- 模块图

/**
 * 模块的默认尺寸。**点一下**（没有拖）就用它造一个——单击就该得到一个模块，
 * 而不是「什么都没发生」。
 */
export const NODE_DEFAULT_WIDTH = 160
export const NODE_DEFAULT_HEIGHT = 56

/** 模块里标签的字号。写死不缩放：「同一个字号」是要拿去和别处比的 */
export const NODE_FONT_SIZE = 22

/** 标签两侧至少留的空白（图纸单位）。文字超了就把模块**拉宽** */
export const NODE_PADDING_X = 14

/** 新建模块时的占位文字。一落地就进文字编辑、整段选中，所以它会被直接替掉 */
export const NODE_DEFAULT_TEXT = '新模块'

/** 新建模块（或改完文字发现放不下）时的最小宽度 */
export const NODE_MIN_WIDTH = 96
/** 最小高度。太扁的模块里文字会顶到上下边框 */
export const NODE_MIN_HEIGHT = 40

/**
 * 单击造出来的模块（宽高都几乎是 0）撑成默认尺寸。
 *
 * **只处理「点了一下」**：拖出来的小模块原样返回——那是用户自己拉的尺寸，
 * 替它做主不合适。判据用 4 而不是 0，因为单击也会带上一两个单位的抖动。
 */
export function withDefaultNodeSize(node: SceneNode): SceneNode {
  const r = nodeRect(node)
  if (r.w > 4 || r.h > 4) return node
  const x = Math.min(node.a.x, node.b.x)
  const y = Math.min(node.a.y, node.b.y)
  return {
    ...node,
    a: { x, y },
    b: { x: x + NODE_DEFAULT_WIDTH, y: y + NODE_DEFAULT_HEIGHT },
  }
}

/**
 * 折线拉直的容差（图纸单位）。
 *
 * 两个模块的纵向中线差半个单位时，画一条带 0.5 单位台阶的三折线看起来就是个
 * 毛刺；按「差得看不出来就算对齐」处理，拉直时取两边的中点把零头消掉。
 */
const FLOW_ALIGN_EPSILON = 1

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

/** 模块的矩形，归一化成「左上角 + 宽高」 */
export function nodeRect(node: SceneNode): {
  x: number
  y: number
  w: number
  h: number
} {
  return normalizeRect(node.a, node.b)
}

/**
 * 模块标签的字号。
 *
 * 模块很扁时跟着缩——字号不缩的话文字会顶到上下边框外面去。上限是
 * `NODE_FONT_SIZE`，所以正常高度的模块字号一致。
 */
export function nodeFontSize(node: SceneNode): number {
  return Math.min(NODE_FONT_SIZE, nodeRect(node).h * 0.55)
}

/**
 * 基线的位置相对文字块中心的偏移比例。
 *
 * 不用 SVG 的 `dominant-baseline`：那个属性在「独立文档里的 SVG」这条渲染路径上
 * 各家实现不一，属于会静默失效的那类开关（见 render.tsx 里关于不用 `scale()`
 * 和不用 `marker` 的同类理由）。把偏移直接算进 `y` 是确定性的。
 *
 * 0.35 是「半个大写字母高度」的经验值：拉丁字母和汉字的视觉中心都落在那儿。
 */
const LABEL_BASELINE_RATIO = 0.35

/** 模块标签的绘制位置：水平居中，垂直靠基线那个偏移找齐 */
export function nodeLabelAt(node: SceneNode): Point {
  const r = nodeRect(node)
  return {
    x: r.x + r.w / 2,
    y: r.y + r.h / 2 + nodeFontSize(node) * LABEL_BASELINE_RATIO,
  }
}

/**
 * 一条流向的折线路径。**全部几何只有这一处**，两个渲染器和命中测试共用
 * ——和 `shapeToParts` 是同一个原则。
 *
 * 两端有一个查不到、或查到的不是模块时返回 null。调用方各自决定怎么表现
 * （渲染画一个可见的占位，命中当作打不着），这里只管算。
 *
 * **端口坐标是「瞄准目标中心」**，这是这张图看起来对不对的关键：底下那根通栏
 * 长条往上指的箭头，必须落在**目标方框的中心正下方**，而不是长条自己的中心。
 * 具体是——
 *
 * - 出口：**目标**的中线，夹进源模块的跨度里（长条比方框宽得多，所以夹完还是
 *   方框的中心）；
 * - 入口：**就是目标自己的中线**。
 *
 * 入口不能写成「源的中线夹进目标跨度」——那种对称写法看起来很合理，但长条→窄
 * 方框时会算出「夹到方框的边上」，于是箭头从方框的**右边缘**斜着进来，而且整条
 * 路径多出一个横折。这正是自检第一次跑就抓到的那条。
 *
 * 两个方框在同一水平线上时两边算出来的坐标相同，于是自然退化成一条直线段。
 *
 * 往哪个方向走，按「两端在四个方向上各隔了多远」取最大的那个。四个方向都被
 * 挡住（两个模块重叠）时退化成向右——总得画点什么出来。
 */
export function routeFlow(flow: Flow, ctx: SceneContext): Point[] | null {
  const from = ctx.byId.get(flow.from)
  const to = ctx.byId.get(flow.to)
  if (from?.kind !== 'node' || to?.kind !== 'node') return null

  const r1 = nodeRect(from)
  const r2 = nodeRect(to)

  // 顺序即优先级：严格大于才换，所以并列时取靠前的那个，也就是先横后竖
  const candidates: readonly { side: FlowSide; gap: number }[] = [
    { side: 'right', gap: r2.x - (r1.x + r1.w) },
    { side: 'left', gap: r1.x - (r2.x + r2.w) },
    { side: 'bottom', gap: r2.y - (r1.y + r1.h) },
    { side: 'top', gap: r1.y - (r2.y + r2.h) },
  ]
  let best = candidates[0] ?? { side: 'right' as FlowSide, gap: 0 }
  for (const candidate of candidates) {
    if (candidate.gap > best.gap) best = candidate
  }
  const side: FlowSide = best.gap > 0 ? best.side : 'right'

  const targetCx = r2.x + r2.w / 2
  const targetCy = r2.y + r2.h / 2

  const horizontal = side === 'right' || side === 'left'

  const start: Point = horizontal
    ? {
        x: side === 'right' ? r1.x + r1.w : r1.x,
        y: clamp(targetCy, r1.y, r1.y + r1.h),
      }
    : {
        x: clamp(targetCx, r1.x, r1.x + r1.w),
        y: side === 'bottom' ? r1.y + r1.h : r1.y,
      }

  // 入口就在目标的中线上：箭头的落点固定是「目标中心的正面」，
  // 源那一侧负责去够它（见上面那段注释）
  const end: Point = horizontal
    ? { x: side === 'right' ? r2.x : r2.x + r2.w, y: targetCy }
    : { x: targetCx, y: side === 'bottom' ? r2.y : r2.y + r2.h }

  const drift = horizontal ? start.y - end.y : start.x - end.x
  if (Math.abs(drift) <= FLOW_ALIGN_EPSILON) {
    // 对齐了（或者差得看不出来）：拉成一条直线，取中点消掉那点零头
    return horizontal
      ? [
          { x: start.x, y: (start.y + end.y) / 2 },
          { x: end.x, y: (start.y + end.y) / 2 },
        ]
      : [
          { x: (start.x + end.x) / 2, y: start.y },
          { x: (start.x + end.x) / 2, y: end.y },
        ]
  }

  // 没对齐：折三段——出去、横穿、进来。拐点取中点，两头对称
  const mid = horizontal ? (start.x + end.x) / 2 : (start.y + end.y) / 2
  return horizontal
    ? [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end]
    : [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end]
}

// ---------------------------------------------------------------- 对齐辅助线

/** 对齐的吸附容差（图纸单位）。比端点吸附小——对齐是「看着差不多」，不是「接上」 */
export const ALIGN_THRESHOLD = 6

/** 一条候选的对齐位置。`x` 是竖线，`y` 是横线 */
export interface AlignCandidate {
  axis: 'x' | 'y'
  at: number
}

/**
 * 别的方框上「值得对齐」的位置：左 / 中 / 右、上 / 中 / 下。
 *
 * **只收有 `a`/`b` 的方框类图形**（矩形、椭圆、模块）。理由不是省事：辅助线的
 * 意义是「把两个东西的左边缘对齐」，而自由线条和符号压根没有「左边缘」。
 *
 * ⚠️ `excludeId` 是**必须传对**的：候选要排除正在被拖的那一个。不排除的话，
 * 拖动过程中它自己的位置也在候选里（`onLive` 已经更新了场景），于是它会吸到
 * 自己身上、一动都动不了——`draw` 手势当初就踩过这个坑（见 BoardCanvas 里
 * `targets` 的注释）。
 */
export function collectAlignCandidates(
  scene: Scene,
  excludeId: ID,
): AlignCandidate[] {
  const out: AlignCandidate[] = []
  for (const shape of scene.shapes) {
    if (shape.id === excludeId) continue
    if (shape.kind !== 'rect' && shape.kind !== 'ellipse' && shape.kind !== 'node') {
      continue
    }
    const r = normalizeRect(shape.a, shape.b)
    out.push(
      { axis: 'x', at: r.x },
      { axis: 'x', at: r.x + r.w / 2 },
      { axis: 'x', at: r.x + r.w },
      { axis: 'y', at: r.y },
      { axis: 'y', at: r.y + r.h / 2 },
      { axis: 'y', at: r.y + r.h },
    )
  }
  return out
}

/**
 * 把一个方框吸到候选线上。
 *
 * 返回要补的位移，以及**吸上之后确实重合**的那些候选（用来画辅助线）。
 * 两个轴各取最近的一条，互不影响——所以「左边缘对齐另一块的左边缘」和
 * 「上边缘对齐另一块的上边缘」可以同时成立，这正是把几块排整齐时想要的。
 *
 * 吸附作用在**位置**上、结果用完即弃：调用方每次都从「按下时的基准」重算，
 * 永远不把吸附后的值存回去，所以来回拖不会有累积漂移。
 */
export function alignSnap(
  box: { x: number; y: number; w: number; h: number },
  candidates: readonly AlignCandidate[],
  threshold: number = ALIGN_THRESHOLD,
): { dx: number; dy: number; guides: readonly AlignCandidate[] } {
  const own: Record<'x' | 'y', number[]> = {
    x: [box.x, box.x + box.w / 2, box.x + box.w],
    y: [box.y, box.y + box.h / 2, box.y + box.h],
  }

  const best: Record<'x' | 'y', { delta: number; distance: number }> = {
    x: { delta: 0, distance: Number.POSITIVE_INFINITY },
    y: { delta: 0, distance: Number.POSITIVE_INFINITY },
  }

  for (const candidate of candidates) {
    for (const line of own[candidate.axis]) {
      const delta = candidate.at - line
      const distance = Math.abs(delta)
      if (distance <= threshold && distance < best[candidate.axis].distance) {
        best[candidate.axis] = { delta, distance }
      }
    }
  }

  const dx = best.x.delta
  const dy = best.y.delta
  const snapped: Record<'x' | 'y', number[]> = {
    x: [box.x + dx, box.x + dx + box.w / 2, box.x + dx + box.w],
    y: [box.y + dy, box.y + dy + box.h / 2, box.y + dy + box.h],
  }

  /*
   * 返回的辅助线要**去重**。
   *
   * 候选是按方框生成的，几个方框上下边缘对齐是常态（教材里那一排方框就是），
   * 于是同一条线会被返回好几次。画面上的后果只是「画了两遍同一条虚线」，
   * 但 React 那边是重复 key 警告——**每次拖动刷屏几十条**。自检的「页面零报错」
   * 那一条就是被这个顶红的。
   */
  const guides: AlignCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = `${candidate.axis}:${candidate.at}`
    if (seen.has(key)) continue
    if (snapped[candidate.axis].some((line) => Math.abs(line - candidate.at) < 0.01)) {
      seen.add(key)
      guides.push(candidate)
    }
  }

  return { dx, dy, guides }
}

// ---------------------------------------------------------------- 模块缩放

/**
 * 模块四角的手柄位置，顺序是 左上 → 右上 → 右下 → 左下。
 *
 * 和 `handlesOf` **分开**：那个是「可以单独拖的端点」，而 `rect`/`ellipse`
 * 在那里故意返回 `[]`（「拖角点改尺寸是另一套交互」）。模块沿用同一条规矩，
 * 于是 `handlesOf(node)` 是空的、联动语义不碰模块，而缩放走这一套。
 */
export function resizeHandlesOf(shape: Shape): Point[] {
  if (shape.kind !== 'node') return []
  const r = nodeRect(shape)
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
}

export interface ResizeHit {
  shape: SceneNode
  corner: number
}

export function hitTestResizeHandle(
  scene: Scene,
  p: Point,
  selectedId: ID | null,
): ResizeHit | null {
  if (!selectedId) return null
  const shape = scene.shapes.find((s) => s.id === selectedId)
  if (shape?.kind !== 'node') return null
  const handles = resizeHandlesOf(shape)
  for (let i = 0; i < handles.length; i += 1) {
    const at = handles[i]
    if (at && Math.hypot(at.x - p.x, at.y - p.y) <= HANDLE_HIT_RADIUS) {
      return { shape, corner: i }
    }
  }
  return null
}

/** 每个角对应的**对角**（拖它的时候不动的那个角） */
const OPPOSITE_CORNER = [2, 3, 0, 1]

/**
 * 把某个角拖到 `to`，**对角保持不动**。
 *
 * 直接写回 `a`/`b` 这两个对角点：它们本来就是「哪两个角」而不是「左上和右下」，
 * 所以把固定的那个角写进 `a`、被拖的写进 `b` 就完事了，不需要算宽高。
 * 拖过头时 `a`/`b` 的左右关系会翻转，`normalizeRect` 照常处理。
 */
export function withResizedCorner(
  node: SceneNode,
  corner: number,
  to: Point,
): SceneNode {
  const handles = resizeHandlesOf(node)
  const fixed = handles[OPPOSITE_CORNER[corner] ?? 2]
  if (!fixed) return node
  return { ...node, a: fixed, b: to }
}

// ---------------------------------------------------------------- 命中测试

/** 点是否落在椭圆内部（含容差）。用于椭圆的选中判定 */
function insideEllipse(p: Point, a: Point, b: Point, tolerance: number): boolean {
  const { x, y, w, h } = normalizeRect(a, b)
  const rx = w / 2 + tolerance
  const ry = h / 2 + tolerance
  if (rx <= 0 || ry <= 0) return false
  const nx = (p.x - (x + w / 2)) / rx
  const ny = (p.y - (y + h / 2)) / ry
  return nx * nx + ny * ny <= 1
}

/**
 * 命中判定。
 *
 * `ctx` 里两样东西各有用处：点符号要 `defs` 把查询点**逆变换回符号的局部
 * 坐标系**再按零件逐个测（这样命中逻辑不需要为每个符号写一份，加多少符号
 * 都一样）；流向要 `byId` 查它两端的模块在哪，才知道自己那条折线画到哪。
 */
function hitsShape(
  shape: Shape,
  p: Point,
  tolerance: number,
  ctx: SceneContext,
): boolean {
  switch (shape.kind) {
    case 'line':
      return distanceToSegment(p, shape.a, shape.b) <= tolerance
    case 'link': {
      // 两端的铰链小圆伸在线段之外，容差要放开一点，
      // 不然「点在那个圆上却没选中」会很难受
      return distanceToSegment(p, shape.a, shape.b) <= tolerance + JOINT_HIT_SLACK
    }
    case 'symbol': {
      const def = ctx.defs?.[shape.ref]
      // 定义丢了（老图引用了后来删掉的符号）时退化成「插入点附近能选中」，
      // 这样它至少还能被拖走或删掉，而不是变成一个选不中的幽灵
      if (!def) return Math.hypot(p.x - shape.at.x, p.y - shape.at.y) <= tolerance * 3
      return hitsParts(def.parts, toLocal(p, shape.at, shape.rotation), tolerance)
    }
    case 'rect':
    case 'node': {
      const r = normalizeRect(shape.a, shape.b)
      // 落在矩形范围内就算命中。矩形没有填充，但按内部选中更符合直觉——
      // 要求必须精确点到边框上会很难用。模块有填充，这条就更自然了
      return (
        p.x >= r.x - tolerance &&
        p.x <= r.x + r.w + tolerance &&
        p.y >= r.y - tolerance &&
        p.y <= r.y + r.h + tolerance
      )
    }
    case 'ellipse':
      return insideEllipse(p, shape.a, shape.b, tolerance)
    case 'pencil':
      return shape.points.some((point, i) => {
        const next = shape.points[i + 1]
        // 一笔只有一个点时按点算
        return next
          ? distanceToSegment(p, point, next) <= tolerance
          : Math.hypot(p.x - point.x, p.y - point.y) <= tolerance
      })
    case 'flow': {
      const points = routeFlow(shape, ctx)
      // 端点查不到（不该发生，见 `removeShapes` 的级联）时打不着：
      // 它连画都画不出来，自然也没有可以点中的地方
      if (!points) return false
      return points.some((point, i) => {
        const next = points[i + 1]
        return next
          ? distanceToSegment(p, point, next) <= tolerance
          : Math.hypot(p.x - point.x, p.y - point.y) <= tolerance
      })
    }
    default:
      return assertNever(shape)
  }
}

/**
 * 找最上层被点中的图元，没中返回 null。
 *
 * 从后往前找：数组靠后的画在上层，被点中的应该是用户看得见的那个。
 */
export function hitTest(
  scene: Scene,
  p: Point,
  tolerance: number = HIT_TOLERANCE,
): Shape | null {
  const ctx = contextOf(scene)
  for (let i = scene.shapes.length - 1; i >= 0; i -= 1) {
    const shape = scene.shapes[i]
    if (shape && hitsShape(shape, p, tolerance, ctx)) return shape
  }
  return null
}

/**
 * 被点中的**全部**图元，不只最上面那个。
 *
 * 橡皮要「扫过谁就擦掉谁」，而 `hitTest` 只返回最上面一个——在铰链那种
 * 几条线叠在一起的地方，一次只能擦掉一条，用户得来回扫好几遍。
 */
export function hitTestAll(
  scene: Scene,
  p: Point,
  tolerance: number = HIT_TOLERANCE,
): Shape[] {
  const ctx = contextOf(scene)
  return scene.shapes.filter((shape) => hitsShape(shape, p, tolerance, ctx))
}

// ---------------------------------------------------------------- 场景编辑

/**
 * 以下函数都返回新的 Scene，不原地改。
 *
 * 撤销栈里存的是整个场景的快照，如果原地改，快照会被后续编辑一起改掉——
 * 撤销回去看到的是最后一次编辑的结果，等于撤销坏了。
 */

export function addShapes(scene: Scene, shapes: Shape[]): Scene {
  return { ...scene, shapes: [...scene.shapes, ...shapes] }
}

export function replaceShape(
  scene: Scene,
  id: ID,
  next: Shape,
): Scene {
  return {
    ...scene,
    shapes: scene.shapes.map((s) => (s.id === id ? next : s)),
  }
}

export function removeShapes(scene: Scene, ids: ID[]): Scene {
  const doomed = new Set(ids)
  return {
    ...scene,
    shapes: scene.shapes.filter((s) => !doomed.has(s.id) && !isOrphanFlow(s, doomed)),
  }
}

/** 这条流向的两个端点里有被删掉的吗 */
function isOrphanFlow(shape: Shape, doomed: ReadonlySet<ID>): boolean {
  return shape.kind === 'flow' && (doomed.has(shape.from) || doomed.has(shape.to))
}

/**
 * 这批图元被删掉时**连带**会消失的图元（今天只有指向它们的流向）。
 *
 * 为什么需要它：橡皮的「标红」集合是命中测试算出来的，而命中测试不认识级联
 * ——于是「屏幕上标红的」和「真被删的」会是两个不同的集合，那几条跟着消失的
 * 流向在松手前一刻还是黑的，看起来像是被误删了。
 *
 * 级联本身由 `removeShapes` 兜底（那是唯一的删除漏斗），这个函数只负责让
 * **界面上显示出来的**和实际发生的一致。
 */
export function cascadeOf(scene: Scene, ids: Iterable<ID>): ID[] {
  const doomed = new Set(ids)
  return scene.shapes.filter((s) => isOrphanFlow(s, doomed)).map((s) => s.id)
}

export function findShape(scene: Scene, id: ID): Shape | null {
  return scene.shapes.find((s) => s.id === id) ?? null
}

/** 平移一个图元。拖动选择框和拖动单个图元共用 */
export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  const move = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy })
  switch (shape.kind) {
    case 'line':
    case 'rect':
    case 'ellipse':
    case 'link':
    case 'node':
      return { ...shape, a: move(shape.a), b: move(shape.b) }
    case 'pencil':
      return { ...shape, points: shape.points.map(move) }
    // 点符号平移的是插入点，旋转角不动
    case 'symbol':
      return { ...shape, at: move(shape.at) }
    /*
     * ⚠️ 流向必须是**显式的恒等分支**，不许让它落进 default。
     *
     * 它没有坐标可平移——一端跟着模块走是 `routeFlow` 重新算出来的。
     * M6.5 记过一个同类的坑：`translateShape` 原来的 default 会去读
     * `shape.a`，而点符号没有 `a`，于是「拖一下就 TypeError」——那是拖拽主路径，
     * 不是边缘情况。以后往这里加「没有 a」的种类，第一件要交代的就是它怎么平移。
     */
    case 'flow':
      return shape
    default:
      return assertNever(shape)
  }
}

/**
 * 把定义收进场景。插入符号时调一次。
 *
 * 只在场景里还没有这个 ref 时写：同一个符号画十个，定义只存一份。
 */
export function withDef(scene: Scene, def: PointSymbolDef): Scene {
  if (scene.defs?.[def.id]) return scene
  return { ...scene, defs: { ...scene.defs, [def.id]: def } }
}

/**
 * 丢掉没人用的定义。
 *
 * 删除图元、或者撤销把最后一个用它的人撤没了之后，`defs` 里会剩下孤儿。
 * 不清也能跑（就是多几十字节），但它会一直跟着图走、进备份、进每一次
 * 序列化——序列化前统一清一遍是最省事的收口。
 *
 * **注意别在编辑函数里随手调**：撤销要能把定义一起带回来，靠的就是
 * 「删图元时 defs 不动」。
 */
// ---------------------------------------------------------------- 端点手柄

/**
 * 一个形状上可以单独拖的点（手柄）。
 *
 * 只有直线和两点符号的两个端点、点符号的锚点能拖。**矩形和椭圆的角点不算**：
 * 拖它们等于改尺寸，那是另一套交互，混进来会让「拖端点」变得不可预期。
 */
export function handlesOf(shape: Shape, defs: SceneDefs): Point[] {
  switch (shape.kind) {
    case 'line':
    case 'link':
      return [shape.a, shape.b]
    case 'symbol':
      return symbolAnchors(shape, defs)
    /*
     * 模块故意**不在这里给手柄**：它要的是四角缩放，而缩放是另一套交互
     * （见 `resizeHandlesOf`）。混进「拖端点」里会让两者都变得不可预期。
     *
     * 连带后果要记一笔：`collectPointHandles` 因此看不到模块，于是
     * 「重合的点永远一起走」那条承诺对模块**不成立**——自由图元的端点不会
     * 跟着模块走，模块也不会被自由图元的端点带走。这是有意的收窄：那套语义
     * 是给机构简图用的，模块图里没有「铰链」这回事。
     */
    case 'rect':
    case 'ellipse':
    case 'pencil':
    case 'node':
    // 流向的两端是推导出来的，拖它等于拖模块——想改走向就拖模块本身
    case 'flow':
      return []
    default:
      return assertNever(shape)
  }
}

/**
 * 旋转手柄相对插入点的偏移（图纸单位）。
 *
 * 用局部坐标 `(0, -offset)` 而不是世界坐标：手柄要跟着符号一起转，
 * 始终待在同一侧，否则转过之后手柄会跑到符号里面去。
 */
export const ROTATE_HANDLE_OFFSET = 90

export function rotateHandleOf(shape: Shape): Point | null {
  if (shape.kind !== 'symbol') return null
  return toWorld({ x: 0, y: -ROTATE_HANDLE_OFFSET }, shape.at, shape.rotation)
}

/**
 * 手柄的命中半径。比 `HIT_TOLERANCE` 大不少：手柄本身就小，
 * 而它和图形本体叠在一起，点不中的表现是「明明看得见却拖不动」。
 */
export const HANDLE_HIT_RADIUS = 14

export interface HandleHit {
  shape: Shape
  index: number
  at: Point
}

/**
 * 找被点中的手柄。
 *
 * ⚠️ **必须先于 `hitTest` 调用**。手柄画在端点上，而端点就在图形本体上，
 * `hitTest` 一定会先命中本体，手柄就永远抢不到指针。
 */
export function hitTestHandle(
  scene: Scene,
  p: Point,
  selectedId: ID | null,
): HandleHit | null {
  if (!selectedId) return null
  const shape = scene.shapes.find((s) => s.id === selectedId)
  if (!shape) return null

  const points = handlesOf(shape, scene.defs)
  for (let i = 0; i < points.length; i += 1) {
    const at = points[i]
    if (at && Math.hypot(at.x - p.x, at.y - p.y) <= HANDLE_HIT_RADIUS) {
      return { shape, index: i, at }
    }
  }
  return null
}

/**
 * 把形状的第 `index` 个可拖点挪到 `to`。
 *
 * 点符号只有一个锚点（在圆心），拖它就是整体平移——「拖一个圆圈的圆心」
 * 在直觉上就是「把整个铰链挪过去」。
 */
/** 点符号的旋转手柄命中判定。只有选中的点符号有它 */
export function hitTestRotateHandle(
  scene: Scene,
  p: Point,
  selectedId: ID | null,
): Shape | null {
  if (!selectedId) return null
  const shape = scene.shapes.find((s) => s.id === selectedId)
  if (!shape) return null
  const handle = rotateHandleOf(shape)
  if (!handle) return null
  return Math.hypot(handle.x - p.x, handle.y - p.y) <= HANDLE_HIT_RADIUS
    ? shape
    : null
}

export function withHandleAt(
  shape: Shape,
  index: number,
  to: Point,
  defs: SceneDefs,
): Shape {
  switch (shape.kind) {
    case 'line':
    case 'link':
      return index === 0 ? { ...shape, a: to } : { ...shape, b: to }
    case 'symbol': {
      const anchors = symbolAnchors(shape, defs)
      const current = anchors[index] ?? shape.at
      return translateShape(shape, to.x - current.x, to.y - current.y)
    }
    case 'rect':
    case 'ellipse':
    case 'pencil':
    case 'node':
    case 'flow':
      return shape
    default:
      return assertNever(shape)
  }
}

// ---------------------------------------------------------------- 机构语义

/**
 * 「两个端点算不算重合」的容差（图纸坐标单位）。
 *
 * **不能用 `===`**：拖拽走的是把屏幕坐标换算回来的原始点，一次拖走再拖回
 * 不可能落在严格的同一个数值上，用相等判定会让联动时灵时不灵。
 *
 * 取值要远小于 `HIT_TOLERANCE = 6`：太大了会把两个挨得近但不同的铰链并成
 * 一个，用户会发现「拖这个怎么那个也动了」。
 */
export const COINCIDENT_TOLERANCE = 1

/** 这个形状是不是「固定」的（机架、固定支座）。固定的锚点不参与端点拖动 */
export function isGrounded(shape: Shape, defs: SceneDefs): boolean {
  switch (shape.kind) {
    case 'symbol': {
      const def = defs?.[shape.ref] ?? builtInPointDef(shape.ref)
      return def?.grounded === true
    }
    case 'link':
      return linkDef(shape.ref)?.grounded === true
    case 'line':
    case 'rect':
    case 'ellipse':
    case 'pencil':
    case 'node':
    case 'flow':
      return false
    default:
      return assertNever(shape)
  }
}

interface PointHandle {
  shapeId: ID
  index: number
  at: Point
}

/** 场景里所有**可以单独拖**的点。和手柄是同一套（见 `handlesOf`） */
function collectPointHandles(scene: Scene): PointHandle[] {
  return scene.shapes.flatMap((shape) =>
    handlesOf(shape, scene.defs).map((at, index) => ({
      shapeId: shape.id,
      index,
      at,
    })),
  )
}

const handleKey = (shapeId: ID, index: number) => `${shapeId}:${index}`

function applyPointMoves(scene: Scene, moves: Map<string, Point>): Scene {
  if (moves.size === 0) return scene
  return {
    ...scene,
    shapes: scene.shapes.map((shape) => {
      let next = shape
      // 按下标遍历**原始**形状的手柄：`withHandleAt` 不会改变手柄的个数和顺序
      handlesOf(shape, scene.defs).forEach((_, index) => {
        const dest = moves.get(handleKey(shape.id, index))
        if (dest) next = withHandleAt(next, index, dest, scene.defs)
      })
      return next
    }),
  }
}

export interface MoveResult {
  scene: Scene
  /** 非 null 表示这次拖动被**拒绝**了，因为要动的点里有一个是固定构件的 */
  blockedBy: Shape | null
}

/**
 * 拖动一个端点：连同所有与它重合的端点一起动。
 *
 * 这就是「拖动铰链联动构件」的全部实现——四杆机构能拖，靠的不是维护
 * 「谁铰接在谁身上」这种关系，而是**重合的点永远一起走**。吸附保证了
 * 「铰链」在数据上真的是同一个坐标（见 `snapToPoints`），这里保证它不会
 * 被拖散。没有约束求解，也不需要。
 *
 * **规则 3：待移动的点里只要有一个固定构件的锚点，整次拖动被拒绝。**
 * 不做约束求解不等于机架可以乱动——「固定铰链」不动才是它名字的意思。
 * 拒绝比「允许但不动」诚实：后者会静默把重合拉断，用户看到的是机构散了，
 * 却找不到是哪一步弄散的。
 */
export function movePointWithCoincident(
  scene: Scene,
  target: PointHandle,
  to: Point,
): MoveResult {
  const group = collectPointHandles(scene).filter(
    (h) =>
      Math.hypot(h.at.x - target.at.x, h.at.y - target.at.y) <=
      COINCIDENT_TOLERANCE,
  )

  const grounded = group
    .map((h) => scene.shapes.find((s) => s.id === h.shapeId))
    .find((s): s is Shape => s !== undefined && isGrounded(s, scene.defs))
  if (grounded) return { scene, blockedBy: grounded }

  const dx = to.x - target.at.x
  const dy = to.y - target.at.y
  const moves = new Map<string, Point>(
    group.map((h) => [
      handleKey(h.shapeId, h.index),
      { x: h.at.x + dx, y: h.at.y + dy },
    ]),
  )
  return { scene: applyPointMoves(scene, moves), blockedBy: null }
}

/**
 * 拖动形状本体：整体平移，并带动所有与它端点重合的端点。
 *
 * 这条路上**不做固定判定**——拖动本体的意思就是「把这一坨挪走」，
 * 连在机架上的构件也该跟着走（想整体挪个位置就是拖机架）。固定只在
 * 「单独拖某一个端点」时起作用。
 */
export function translateBodyWithCoincident(
  scene: Scene,
  shapeId: ID,
  dx: number,
  dy: number,
): Scene {
  const shape = scene.shapes.find((s) => s.id === shapeId)
  if (!shape) return scene

  const anchors = handlesOf(shape, scene.defs)
  const moves = new Map<string, Point>()

  for (const h of collectPointHandles(scene)) {
    if (h.shapeId === shapeId) continue
    const attached = anchors.some(
      (a) => Math.hypot(a.x - h.at.x, a.y - h.at.y) <= COINCIDENT_TOLERANCE,
    )
    if (attached) moves.set(handleKey(h.shapeId, h.index), { x: h.at.x + dx, y: h.at.y + dy })
  }

  const moved = applyPointMoves(scene, moves)
  return {
    ...moved,
    shapes: moved.shapes.map((s) => (s.id === shapeId ? translateShape(s, dx, dy) : s)),
  }
}

export function pruneDefs(scene: Scene): Scene {
  if (!scene.defs) return scene
  const used = new Set(
    scene.shapes.flatMap((s) => (s.kind === 'symbol' ? [s.ref] : [])),
  )
  const kept = Object.entries(scene.defs).filter(([id]) => used.has(id))
  if (kept.length === Object.keys(scene.defs).length) return scene
  return { ...scene, defs: Object.fromEntries(kept) as Record<string, PointSymbolDef> }
}

// ---------------------------------------------------------------- 构造器

export function makeLine(a: Point, b: Point): Shape {
  return { id: newId(), kind: 'line', a, b }
}

export function makeRect(a: Point, b: Point): Shape {
  return { id: newId(), kind: 'rect', a, b }
}

export function makeEllipse(a: Point, b: Point): Shape {
  return { id: newId(), kind: 'ellipse', a, b }
}

export function makePencil(points: Point[]): Shape {
  return { id: newId(), kind: 'pencil', points }
}

export function makeSymbol(ref: string, at: Point, rotation = 0): Shape {
  return { id: newId(), kind: 'symbol', ref, at, rotation }
}

export function makeLink(ref: string, a: Point, b: Point): Shape {
  return { id: newId(), kind: 'link', ref, a, b }
}

/**
 * 造一个模块。
 *
 * 落地时**立刻进文字编辑**（见 BoardCanvas），所以默认文字要是个能一眼看出
 * 「这是占位、选中它会整段替换」的东西，而不是空字符串——空模块看起来像是
 * 画错了。
 */
export function makeNode(a: Point, b: Point, text: string, fill: string): Shape {
  return { id: newId(), kind: 'node', a, b, text, fill }
}

/** 造一条流向。不校验两端——校验在创建它的那个手势里做，那里才知道有没有模块 */
export function makeFlow(from: ID, to: ID, stroke: string): Shape {
  return { id: newId(), kind: 'flow', from, to, stroke }
}

/**
 * 拖旋转手柄时，由指针位置反推该转到多少度。
 *
 * 手柄在局部坐标的 `(0, -ROTATE_HANDLE_OFFSET)`，也就是从插入点出发、
 * 方向是「转过的角度再减 90°」。所以 `atan2` 算出来的角度要加回 90°
 * 才是符号自身的旋转角。
 *
 * 按住 Shift 时吸到 15° 的整数倍，和画线时是同一套手感。
 */
export function rotationFromPointer(
  at: Point,
  pointer: Point,
  snapToStep: boolean,
): number {
  const raw =
    (Math.atan2(pointer.y - at.y, pointer.x - at.x) * 180) / Math.PI + 90
  const normalised = ((raw % 360) + 360) % 360
  if (!snapToStep) return normalised
  return (Math.round(normalised / ANGLE_STEP_DEG) * ANGLE_STEP_DEG) % 360
}
