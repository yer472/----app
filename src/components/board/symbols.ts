import type { Point } from './scene'

/**
 * 机构运动简图的符号库。
 *
 * 纯数据 + 纯函数：不认识 React，也不碰 DOM。符号的几何在这里只写一次，
 * 面板缩略图、画布、导出的 SVG 三处都从这里取。
 *
 * ## 形状按「要加多少文字」分成两类
 *
 * - **点符号**（`PointSymbolDef`）——定尺寸，放在一个点、可以整体旋转。
 *   定义是**纯数据**，所以能直接 `JSON.stringify` 内联进导出 SVG 的
 *   `<metadata>`，跟着图走。
 * - **两点符号**（`LinkSymbolDef`）——长度由两端点之间的距离决定。
 *   定义是**代码里的生成器**，不进场景。
 *
 * 为什么两点符号不能也写成数据：它的图元长度依赖 `|AB|`，而「哪些量跟着长度
 * 变、哪些不变」不是一致的——带传动的两个带轮半径是**固定**的、只有间距变，
 * 构件的杆要跟着变长而两端的铰链圆半径**不变**。要写成数据就得给每个坐标
 * 标一个「这一维乘长度」，那个混合坐标系是出 bug 的地方；写成生成器反而清楚，
 * 而且顺带避开了 SVG 的 `scale()`（它会把 `stroke-width` 一起放大，
 * 要抵消就得用 `vector-effect="non-scaling-stroke"`，那是又一个会静默失效的开关）。
 *
 * ## 关于标准
 *
 * 图形是按 **GB/T 4460—2013《机械制图 机构运动简图用图形符号》**（代替 1984 版）
 * 的**图形特征**手绘的，**不是标准原图的复制件**；齿轮副的节圆一律等径
 * （应用里没有齿数/传动比参数），也没有实现线型规范（点划线、粗细线比例）。
 * 用途是课堂笔记里的示意图，不作为制图依据。
 *
 * 三条照标准来的细节：
 * 1. 构件（轴、杆）的图线要画**两倍粗实线**，所以杆用 `w: ROD_W`，而两端的
 *    铰链小圆仍然用默认线宽——小圆是「转动副」的符号，不是杆的一部分。
 * 2. 转动副就是一个小圆圈，**圆心代表相对回转轴线**。所以点符号的 `origin`
 *    锚点就在圆心：它同时是插入点和联动的铰链点。
 * 3. 机架/固定构件的画法是「在代表它的构件上加短斜线」；移动副的导路方向
 *    必须与实际移动方向一致——这就是这些符号必须有 `rotation` 的原因。
 */

/**
 * 一个零件。
 *
 * `w` 是线宽覆盖，缺省用 `STROKE_WIDTH`（3）。标准要求「表示轴、杆符号的
 * 图线应用两倍粗实线」，所以粗线是**零件级**的属性而不是图形级的。
 *
 * 只用描边、不用填充：选中高亮层是无条件 `fill: none` 的叠加，实心零件在
 * 高亮层里会只剩轮廓，看起来和「被选中」对不上；描边也和现有那套「白纸黑线」
 * 的制图惯例一致。
 */
export type Part =
  | { kind: 'line'; a: Point; b: Point; w?: number }
  | { kind: 'polyline'; points: Point[]; w?: number }
  | { kind: 'rect'; a: Point; b: Point; w?: number }
  | { kind: 'ellipse'; a: Point; b: Point; w?: number }
  | { kind: 'text'; at: Point; text: string; size: number }

/**
 * 零件的种类。
 *
 * 单独立一个类型是为了让「按种类穷尽」的写法能成立——`serialize.ts` 的
 * `PART_VALIDATORS` 就是一整张 `Record<PartKind, …>`，漏一种零件是编译错误。
 */
export type PartKind = Part['kind']

/** 面板里的分组。和快捷键目录一样，另给一张表管顺序和标题 */
export type SymbolGroup = 'joint' | 'member' | 'drive' | 'driven' | 'source'

export const SYMBOL_GROUPS: readonly { id: SymbolGroup; title: string }[] = [
  { id: 'joint', title: '运动副' },
  { id: 'member', title: '构件' },
  { id: 'drive', title: '传动' },
  { id: 'driven', title: '从动件' },
  { id: 'source', title: '原动件' },
]

/**
 * 点符号的定义。**纯数据**，可以直接 JSON 序列化——这是能内联进场景的前提。
 */
export interface PointSymbolDef {
  id: string
  name: string
  /**
   * 面板里的分区。**只有内置符号给**：自定义符号不走标准符号那几个分区，
   * 统一列在「我的符号」那一段里。
   */
  group?: SymbolGroup
  parts: readonly Part[]
  /** 局部坐标下的锚点。约定必须有一个叫 `origin` 且在 `(0,0)` */
  anchors: readonly { name: string; at: Point }[]
  /** 机架/固定支座类：它的锚点不参与端点拖动（见 scene.ts 的联动规则） */
  grounded?: boolean
}

/** 两点符号的定义。**只在代码里**，不进场景（原因见文件头） */
export interface LinkSymbolDef {
  id: string
  name: string
  group: SymbolGroup
  /** 局部坐标系：+x 轴沿 A→B，长度就是 length */
  partsFor: (length: number) => Part[]
  /** 没有 anchors 字段：两个端点本身就是锚点 */
  grounded?: boolean
}

// ---------------------------------------------------------------- 制图常量

/**
 * 杆（构件）的线宽。标准要求轴、杆的图线是两倍粗实线。
 *
 * 这个 6 是照 render.ts 里的 `STROKE_WIDTH = 3` 写死的——写成 import 会让
 * 「两倍」这个关系隐式化，而它恰恰是标准里的一句话。真要改线宽，两处一起改。
 */
const ROD_W = 6

/** 转动副小圆的半径。圆心是回转轴线，所以它也是锚点 */
const JOINT_R = 9

/** 机架短斜线的长度和间距 */
const HATCH_DEPTH = 13
const HATCH_SPACING = 16

// ---------------------------------------------------------------- 几何辅助

const p = (x: number, y: number): Point => ({ x, y })

/** 以 (cx,cy) 为心、r 为半径的圆。用对角点表示，和 Shape 的 ellipse 一致 */
function circle(cx: number, cy: number, r: number, w?: number): Part {
  return { kind: 'ellipse', a: p(cx - r, cy - r), b: p(cx + r, cy + r), w }
}

/** 圆心的小十字。齿轮、带轮这些「转动中心」的画法 */
function centreMark(cx: number, cy: number, size = 12, w?: number): Part[] {
  return [
    { kind: 'line', a: p(cx - size, cy), b: p(cx + size, cy), w },
    { kind: 'line', a: p(cx, cy - size), b: p(cx, cy + size), w },
  ]
}

/**
 * 机架短斜线：沿 a→b 挂一排垂直的短线，挂在 +x 转 90° 那一侧。
 *
 * 展开成 `line` 列表，定义里就不需要再有「斜线」这种图元——图元种类越少，
 * 两个渲染器要处理的分支越少。
 *
 * 两端各缩进一点：从角上起笔的短斜线看起来像画歪了。
 */
function groundHatch(
  a: Point,
  b: Point,
  depth = HATCH_DEPTH,
  spacing = HATCH_SPACING,
): Part[] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return []

  const ux = dx / length
  const uy = dy / length
  // 把 +x 方向转 90°，得到「挂斜线」的那一侧
  const nx = -uy
  const ny = ux

  const inset = Math.min(depth, spacing / 2, length / 4)
  const usable = length - inset * 2
  const count = Math.max(1, Math.round(usable / spacing))

  const parts: Part[] = []
  for (let i = 0; i <= count; i += 1) {
    const t = inset + (usable * i) / count
    const x = a.x + ux * t
    const y = a.y + uy * t
    parts.push({
      kind: 'line',
      a: p(x, y),
      b: p(x + nx * depth, y + ny * depth),
    })
  }
  return parts
}

// ---------------------------------------------------------------- 点符号

/**
 * 内置的点符号。
 *
 * 局部坐标的原点 = 插入点 = 联动时的铰链点。所以「转动副」的小圆画在原点，
 * 「固定铰链」的小圆也画在原点、机架画在它下面。
 */
export const POINT_SYMBOLS: readonly PointSymbolDef[] = [
  {
    id: 'std:joint',
    name: '转动副',
    group: 'joint',
    parts: [circle(0, 0, JOINT_R)],
    anchors: [{ name: 'origin', at: p(0, 0) }],
  },
  {
    id: 'std:grounded-joint',
    name: '固定铰链',
    group: 'joint',
    // 转动副小圆 + 三角形支座 + 底下的机架斜线
    parts: [
      circle(0, 0, JOINT_R),
      {
        kind: 'polyline',
        points: [p(0, JOINT_R), p(-26, 40), p(26, 40), p(0, JOINT_R)],
      },
      ...groundHatch(p(-26, 40), p(26, 40)),
    ],
    anchors: [{ name: 'origin', at: p(0, 0) }],
    grounded: true,
  },
  {
    id: 'std:slider',
    name: '移动副',
    group: 'joint',
    // 导轨（粗线，它是机架）+ 滑块 + 导轨底下的斜线
    parts: [
      { kind: 'rect', a: p(-60, -14), b: p(60, 14), w: ROD_W },
      { kind: 'rect', a: p(-20, -24), b: p(20, 24) },
      ...groundHatch(p(-60, 14), p(60, 14)),
    ],
    anchors: [{ name: 'origin', at: p(0, 0) }],
    grounded: true,
  },
  {
    id: 'std:cam',
    name: '凸轮',
    group: 'driven',
    // 基圆 + 尖顶从动件（三角形刀口 + 导杆）
    parts: [
      circle(0, 0, 30),
      ...centreMark(0, 0, 10),
      {
        kind: 'polyline',
        points: [p(0, -30), p(-10, -44), p(10, -44), p(0, -30)],
      },
      { kind: 'line', a: p(0, -44), b: p(0, -80) },
    ],
    anchors: [{ name: 'origin', at: p(0, 0) }],
  },
  {
    id: 'std:motor',
    name: '电动机',
    group: 'source',
    parts: [
      circle(0, 0, 26),
      // y 是基线位置；x 左移半个字宽让它看起来居中。SVG 的 text 默认
      // text-anchor 是 start，这里没有地方放那个属性，就用坐标凑
      { kind: 'text', at: p(-10, 11), text: 'M', size: 34 },
    ],
    anchors: [{ name: 'origin', at: p(0, 0) }],
  },
]

// ---------------------------------------------------------------- 两点符号

/**
 * 内置的两点符号。局部坐标系里 A 在 (0,0)、B 在 (length, 0)。
 */
export const LINK_SYMBOLS: readonly LinkSymbolDef[] = [
  {
    id: 'std:member',
    name: '构件',
    group: 'member',
    partsFor: (length) => [
      { kind: 'line', a: p(0, 0), b: p(length, 0), w: ROD_W },
      // 两端的铰链圆半径是**固定**的：它是「副」的符号，不该随杆长变粗变细
      circle(0, 0, JOINT_R),
      circle(length, 0, JOINT_R),
    ],
  },
  {
    id: 'std:frame',
    name: '机架',
    group: 'member',
    partsFor: (length) => [
      { kind: 'line', a: p(0, 0), b: p(length, 0), w: ROD_W },
      circle(0, 0, JOINT_R),
      circle(length, 0, JOINT_R),
      ...groundHatch(p(0, 0), p(length, 0)),
    ],
    grounded: true,
  },
  {
    id: 'std:gear-pair',
    name: '齿轮副',
    group: 'drive',
    /**
     * 两个节圆相切。
     *
     * ⚠️ 一律画成**等径**（r = length/2）——应用里没有齿数/传动比参数，
     * 画成别的比例就是编出来的。真实的一对齿轮传动比很少是 1，所以这张图
     * 只能表达「这里有一对啮合的齿轮」，不能表达传动比。
     */
    partsFor: (length) => {
      const r = Math.max(10, length / 2)
      return [
        circle(0, 0, r),
        circle(length, 0, r),
        ...centreMark(0, 0),
        ...centreMark(length, 0),
      ]
    },
  },
  {
    id: 'std:belt',
    name: '带传动',
    group: 'drive',
    /**
     * 两个带轮 + 上下两条带。
     *
     * 带轮半径是**固定**的（26），只有间距跟着 length 走——这正是「生成器」
     * 比「等比缩放的局部坐标系」强的地方：用 scale 会画成两个随跨度缩放的
     * 轮子，跨度一大就成了两个巨轮，一眼就不对。
     */
    partsFor: (length) => {
      const r = 26
      return [
        circle(0, 0, r),
        circle(length, 0, r),
        { kind: 'line', a: p(0, -r), b: p(length, -r) },
        { kind: 'line', a: p(0, r), b: p(length, r) },
        ...centreMark(0, 0),
        ...centreMark(length, 0),
      ]
    },
  },
  {
    id: 'std:driver',
    name: '原动件',
    group: 'source',
    // 构件 + 末端的箭头（表示「这一头是输入，动从这里来」）
    partsFor: (length) => {
      const head = Math.min(18, Math.max(8, length / 4))
      return [
        { kind: 'line', a: p(0, 0), b: p(length, 0), w: ROD_W },
        circle(0, 0, JOINT_R),
        {
          kind: 'polyline',
          points: [
            p(length - head, -head * 0.5),
            p(length, 0),
            p(length - head, head * 0.5),
          ],
        },
      ]
    },
  },
]

// ---------------------------------------------------------------- 查表

const POINT_BY_ID = new Map<string, PointSymbolDef>(
  POINT_SYMBOLS.map((def): [string, PointSymbolDef] => [def.id, def]),
)

const LINK_BY_ID = new Map<string, LinkSymbolDef>(
  LINK_SYMBOLS.map((def): [string, LinkSymbolDef] => [def.id, def]),
)

/** 按 id 取点符号。内置的没有就是没有，返回 undefined（自定义的从场景里取） */
export function builtInPointDef(id: string): PointSymbolDef | undefined {
  return POINT_BY_ID.get(id)
}

export function linkDef(id: string): LinkSymbolDef | undefined {
  return LINK_BY_ID.get(id)
}

/** 面板要展示的全部内置符号，按分组顺序 */
export function builtInSymbols(group: SymbolGroup): (PointSymbolDef | LinkSymbolDef)[] {
  return [
    ...POINT_SYMBOLS.filter((d) => d.group === group),
    ...LINK_SYMBOLS.filter((d) => d.group === group),
  ]
}

/** 这个 id 是不是两点符号。放置时的交互（点一下 vs 拖一段）按它分流 */
export function isLinkSymbol(id: string): boolean {
  return LINK_BY_ID.has(id)
}

// ---------------------------------------------------------------- 零件的几何

const DEFAULT_W = 3

function partWidth(part: Part): number {
  return (part.kind === 'text' ? undefined : part.w) ?? DEFAULT_W
}

/**
 * 局部坐标下的命中判定。
 *
 * 调用方负责把世界坐标的点**逆变换**回局部坐标（见 scene.ts 的 `toLocal`），
 * 所以这里只需要按零件本身的形状判断，一个符号一种特殊情况都不用写。
 */
export function hitsPart(part: Part, p: Point, tolerance: number): boolean {
  // 线宽也算进去：细线在屏幕上只有几个像素，不加线宽的话「看着点中了其实没中」
  const slack = tolerance + partWidth(part) / 2

  switch (part.kind) {
    case 'line':
      return distancePointToSegment(p, part.a, part.b) <= slack
    case 'polyline':
      return part.points.some((point, i) => {
        const next = part.points[i + 1]
        return next
          ? distancePointToSegment(p, point, next) <= slack
          : Math.hypot(p.x - point.x, p.y - point.y) <= slack
      })
    case 'rect': {
      const r = boxOf(part.a, part.b)
      return (
        p.x >= r.minX - slack &&
        p.x <= r.maxX + slack &&
        p.y >= r.minY - slack &&
        p.y <= r.maxY + slack
      )
    }
    case 'ellipse': {
      const r = boxOf(part.a, part.b)
      const rx = (r.maxX - r.minX) / 2 + slack
      const ry = (r.maxY - r.minY) / 2 + slack
      if (rx <= 0 || ry <= 0) return false
      const nx = (p.x - (r.minX + r.maxX) / 2) / rx
      const ny = (p.y - (r.minY + r.maxY) / 2) / ry
      return nx * nx + ny * ny <= 1
    }
    case 'text': {
      // 文字的准确外框要问浏览器（量字体），这里用「字号」估一个够用的矩形。
      // 命中判定不需要精确到像素，偏差几个单位没人感觉得到
      const width = part.text.length * part.size * 0.62
      return (
        p.x >= part.at.x - slack &&
        p.x <= part.at.x + width + slack &&
        p.y >= part.at.y - part.size - slack &&
        p.y <= part.at.y + slack
      )
    }
  }
}

export function hitsParts(
  parts: readonly Part[],
  p: Point,
  tolerance: number,
): boolean {
  return parts.some((part) => hitsPart(part, p, tolerance))
}

// 这两个是 scene.ts 里同名函数的副本，**故意不 import**：scene.ts 已经
// 依赖 symbols.ts 了，反过来再引一个值就构成真正的运行期循环。
// 它们是十行以内的纯函数，重复的代价小于环的代价。
function distancePointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
  )
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function boxOf(a: Point, b: Point) {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  }
}

/**
 * 零件列表的包围盒。面板缩略图的 `viewBox` 用它。
 *
 * 结果里带一点余量：贴边的图形在缩略图里会被裁掉半个线宽。
 */
export function partsBounds(
  parts: readonly Part[],
  padding = 6,
): { x: number; y: number; w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const part of parts) {
    const box = partBounds(part)
    if (!box) continue
    minX = Math.min(minX, box.minX)
    minY = Math.min(minY, box.minY)
    maxX = Math.max(maxX, box.maxX)
    maxY = Math.max(maxY, box.maxY)
  }

  if (!Number.isFinite(minX)) return { x: -padding, y: -padding, w: padding * 2, h: padding * 2 }
  return {
    x: minX - padding,
    y: minY - padding,
    w: maxX - minX + padding * 2,
    h: maxY - minY + padding * 2,
  }
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 一个零件占的地方。什么都没有（空的折线）时返回 null。
 *
 * **每个分支都必须 return，且这里不写 `default`。** `tsconfig` 开了
 * `noImplicitReturns`：往 `Part` 联合里加一种零件而漏了这个 switch，
 * 编译器会直接报「不是所有代码路径都有返回值」。
 *
 * 原来这段是内联在 `partsBounds` 的循环里、以一个 `default: break` 收尾的，
 * 而 `break` 之后函数照常在循环外 return——漏一种零件的表现是
 * 「面板缩略图把它裁掉了」，不报任何错。`hitsPart` 同理（它原来也有一个
 * `default: return false`，后果是那个零件在图上点不中）。
 *
 * 这两个地方**故意不用 `assertNever`**：它在 scene.ts 里，而这个文件引
 * scene.ts 的值会构成真正的运行期循环（见下面 `distancePointToSegment`
 * 的注释）。靠 `noImplicitReturns` 就够，不需要再引一个值进来。
 */
function partBounds(part: Part): Box | null {
  switch (part.kind) {
    case 'line':
    case 'rect':
    case 'ellipse': {
      const r = boxOf(part.a, part.b)
      return { minX: r.minX, minY: r.minY, maxX: r.maxX, maxY: r.maxY }
    }
    case 'polyline': {
      if (part.points.length === 0) return null
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const point of part.points) {
        minX = Math.min(minX, point.x)
        minY = Math.min(minY, point.y)
        maxX = Math.max(maxX, point.x)
        maxY = Math.max(maxY, point.y)
      }
      return { minX, minY, maxX, maxY }
    }
    case 'text': {
      // 文字外框和 `hitsPart` 用同一套估算，两处必须一致：不一样的话会
      // 出现「缩略图裁掉了，但图上点得中」这种自相矛盾的表现
      return {
        minX: part.at.x,
        minY: part.at.y - part.size,
        maxX: part.at.x + part.text.length * part.size * 0.62,
        maxY: part.at.y,
      }
    }
  }
}
