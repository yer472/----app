import { newId } from '@/lib/id'
import type { ID } from '@/types/models'
import type { Point, Shape } from '@/types/scene'
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
export type { Point, Shape, ShapeKind } from '@/types/scene'

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
 * 中间的点是笔迹本身，吸上去只会让线条变形。
 */
export function snapTargetsOf(shape: Shape, defs: SceneDefs): Point[] {
  switch (shape.kind) {
    case 'line':
    case 'link':
      return [shape.a, shape.b]
    case 'rect':
    case 'ellipse': {
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
    case 'rect': {
      const r = normalizeRect(shape.a, shape.b)
      // 落在矩形范围内就算命中。矩形没有填充，但按内部选中更符合直觉——
      // 要求必须精确点到边框上会很难用
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
  return { ...scene, shapes: scene.shapes.filter((s) => !doomed.has(s.id)) }
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
      return { ...shape, a: move(shape.a), b: move(shape.b) }
    case 'pencil':
      return { ...shape, points: shape.points.map(move) }
    // 点符号平移的是插入点，旋转角不动
    case 'symbol':
      return { ...shape, at: move(shape.at) }
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
    case 'rect':
    case 'ellipse':
    case 'pencil':
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
