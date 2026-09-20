import type { ReactElement } from 'react'
import type { CustomSymbol } from '@/types/models'
import {
  EMPTY_CONTEXT,
  NODE_PADDING_X,
  assertNever,
  nodeFontSize,
  nodeLabelAt,
  routeFlow,
  type Point,
  type SceneContext,
  type SceneNode,
  type Shape,
} from './scene'
import {
  builtInPointDef,
  linkDef,
  type Part,
  type PointSymbolDef,
} from './symbols'

/**
 * 图元的「零件」表示，以及两套渲染器。
 *
 * 为什么要有这一层：原来画布侧的 `ShapeView`（输出 React 元素）和导出侧的
 * `createShapeElement`（输出脱离文档的 DOM 节点）是一对手工维护的双胞胎，
 * 各自把同一种图形算一遍几何。加一种图形就要改两处，而**漏改是静默的**——
 * React 那边渲染 `undefined` 只是屏幕上少个东西，导出那边被 `if (el)` 跳过
 * 则是「正文里的图少一块、metadata 里的数据却完好」。
 *
 * 现在几何只在 `shapeToParts` 里算一次，两个适配器只负责把 `Part` 翻译成
 * 各自的形式。**注意这并没有消灭重复**：属性名的大小写（React 用 camelCase
 * prop、DOM 用 `setAttribute('stroke-width')`）是两边各自的事，两个适配器
 * 都还得写。消灭的是「几何算两遍」这个真正会出错的重复。
 */

export const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 墨色和线宽。
 *
 * 定义放在这里而不是 serialize.ts，是因为**两个渲染器都要用**：
 * 放两处就成了一份靠「两个常量碰巧相等」维持的约定，改一处不会有任何提示。
 *
 * 颜色写死不跟随主题：正文里的图是 `<img src="blob:...">`，SVG 在 img 里是
 * 独立文档，**继承不到页面的 currentColor**，`text-neutral-800 dark:...`
 * 那套对它完全无效。所以按制图惯例固定成白底黑线。
 */
export const INK_COLOR = '#1f2937'

/** 缺省线宽。机构简图里构件（杆）要用两倍粗实线，那种零件自己带 `w` */
export const STROKE_WIDTH = 3

/**
 * 图里文字的字体。
 *
 * **必须显式写死，而且两个渲染器都要写。** 原来两边都没写：画布上的 `<text>`
 * 继承页面的字体，而导出的 SVG 在 `<img>` 里是**独立文档**、回落到 SVG 的默认
 * 字体——同一个标签在屏幕上和在正文那张图里字体不同。在「文字要在框里居中」
 * 这件事上，字体不同就意味着字宽不同，于是「会不会溢出方框」「居中得对不对」
 * 两处给出的答案不一样。
 *
 * 用系统字体而不是 webfont：导出的图要能脱离本应用打开（扔进 Typora、Obsidian
 * 仍然可读，见 §5.4），那个环境不会去下载我们的字体。
 */
export const FIGURE_FONT_FAMILY =
  "'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif"

/**
 * 量一段文字有多宽（图纸单位，和 SVG 的 `font-size` 同一套坐标）。
 *
 * 用 canvas 真量，不按字数估：中文是全角、拉丁字母窄得多，「字数 × 字号 × 0.62」
 * 那种估法在纯中文标签上偏小、在中英混排上偏大，而它要拿去决定**模块该多宽**
 * ——估错的后果是文字溢出方框、或者框空出一大截。
 *
 * canvas 只建一次。拿不到 2d 上下文时退回同一个估算系数，至少不抛错。
 */
let measureCanvas: HTMLCanvasElement | null = null

export function measureTextWidth(text: string, fontSize: number): number {
  measureCanvas ??= document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  if (!ctx) return text.length * fontSize * 0.62
  ctx.font = `${fontSize}px ${FIGURE_FONT_FAMILY}`
  return ctx.measureText(text).width
}

/**
 * 模块的填充色。
 *
 * 和 `lib/colors.ts` 的 `SUBJECT_COLORS` 分开：那一组是给**小色块**用的
 * （科目卡片上的圆点、列表里的小标记），而这里是**大面积填充、上面还要压文字**，
 * 要求不一样——最要紧的一条是每种颜色都得让标签看得清（见 `pickLabelInk`）。
 * 白的排第一，因为它是默认值：教材里本来就是白底黑框居多。
 */
export const NODE_FILL_COLORS = [
  '#ffffff',
  '#ef4444',
  '#f59e0b',
  '#ffe600',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#64748b',
] as const

/**
 * 流向的线条色。和模块那个色板是**同一批颜色**，只把白换成了墨色——
 * 白线画在白图纸上等于没有，而流向本来就该默认是墨色（和机构简图的墨线一致）。
 */
export const FLOW_STROKE_COLORS: readonly string[] = [
  INK_COLOR,
  ...NODE_FILL_COLORS.slice(1),
]

/**
 * 底色上该用黑字还是白字。
 *
 * 判据是 WCAG 的相对亮度：超过约 0.179 时黑字对比度更高。写死「一律黑字」
 * 在 `#64748b` 这种灰上只有 4.4:1，再深一点就掉到 3:1 以下——而 §8 定的门槛
 * 就是 3:1，色板以后还会长，所以这里是**算**出来的，不是枚举出来的。
 *
 * 注意 `verify:m45` 里那份对比度扫描用的是同一个公式，但那份代码跑在页面里、
 * 碰 canvas 和 document，是**只给测试用**的；这一份是产品代码，两处不共用。
 */
export function pickLabelInk(fill: string): string {
  return relativeLuminance(fill) > 0.179 ? INK_COLOR : '#ffffff'
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex)
  const channel = (value: number) => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** 解析 `#rgb` / `#rrggbb`。认不出来时当作黑——那样标签至少是黑字配白底 */
function parseHex(hex: string): [number, number, number] {
  const raw = hex.replace('#', '')
  const pairs =
    raw.length === 3
      ? [raw[0]! + raw[0]!, raw[1]! + raw[1]!, raw[2]! + raw[2]!]
      : [raw.slice(0, 2), raw.slice(2, 4), raw.slice(4, 6)]
  const channels = pairs.map((pair) => Number.parseInt(pair, 16))
  if (channels.length !== 3 || channels.some((v) => !Number.isFinite(v))) {
    return [0, 0, 0]
  }
  return [channels[0]!, channels[1]!, channels[2]!]
}

/** 调用方给的样式覆盖。画布的选中高亮就是靠它把描边加粗换色 */
export interface PartStyle {
  stroke?: string
  strokeWidth?: number
  strokeOpacity?: number
  /**
   * 填充色覆盖。
   *
   * **选中高亮层和橡皮的标红层都必须传 `'none'`**：那两层是把图形重画一遍
   * 盖在上面，模块的底色是不透明的，不压掉就会把框里的文字整个遮住。
   */
  fill?: string
  /**
   * 文字颜色覆盖。高亮层传 `'transparent'`——它已经在图形上叠了一道半透明的
   * 蓝，再拿蓝色重画一遍文字只会让标签糊成一团。
   */
  labelFill?: string
  /**
   * 线宽乘数。**只有面板缩略图用**。
   *
   * SVG 的 `viewBox` 会把线宽一起缩放：一个 200 单位宽的定义塞进 32px 的
   * 方框，3 单位的线宽就只剩 0.5px，肉眼看不见。缩略图按缩放比把线宽乘回来，
   * 于是「粗杆细圆」的粗细对比在图标上仍然成立。
   */
  widthScale?: number
}

/** 一个图形的呈现：一组零件，外加一个把零件放进图纸坐标的变换 */
export interface ShapeRender {
  /**
   * SVG `transform` 属性。普通图形是空串。
   *
   * 只做平移和旋转，**不做缩放**：缩放会把 `stroke-width` 一起放大，
   * 要抵消就得用 `vector-effect="non-scaling-stroke"`，那是又一个
   * 在某些渲染路径下会静默失效的开关。两点符号的图元按实际长度生成，
   * 所以用不上缩放。
   */
  transform: string
  parts: Part[]
}

function pointsAttr(points: readonly Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ')
}

/** 数字写进属性时收一下小数位。两边渲染器都走它，所以不会出现「一边 3.0000001」 */
function num(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

/**
 * 图形 → 零件列表。**全项目只有这一处把图形翻译成几何。**
 *
 * 点符号的定义从 `ctx.defs` 里取（内联在场景里），两点符号的定义从 symbols.ts
 * 取（代码里的生成器）。两者的定义都查不到时不是「什么都不画」而是画一个
 * 占位：图形本身还在场景里、还能被选中和删掉，静默不画会让人以为它没了。
 *
 * `ctx` 为什么是必填的（而不是 `defs` 那样可选）：见 `SceneContext` 的注释。
 */
export function shapeToParts(shape: Shape, ctx: SceneContext): ShapeRender {
  switch (shape.kind) {
    case 'line':
      return { transform: '', parts: [{ kind: 'line', a: shape.a, b: shape.b }] }
    case 'rect':
      return { transform: '', parts: [{ kind: 'rect', a: shape.a, b: shape.b }] }
    case 'ellipse':
      return { transform: '', parts: [{ kind: 'ellipse', a: shape.a, b: shape.b }] }
    case 'pencil':
      // 少于两点的笔画画不出来（没有长度，`fill: none` 下一个点也看不见）。
      // 原来画布侧会渲染一个空 `<polyline>`、导出侧直接跳过，两侧不一致；
      // 统一成「都不画」
      return {
        transform: '',
        parts:
          shape.points.length < 2
            ? []
            : [{ kind: 'polyline', points: shape.points }],
      }
    case 'symbol': {
      const def = ctx.defs?.[shape.ref] ?? builtInPointDef(shape.ref)
      const transform = `translate(${num(shape.at.x)},${num(shape.at.y)}) rotate(${num(shape.rotation)})`
      if (!def) return { transform, parts: placeholderAtOrigin() }
      return { transform, parts: [...def.parts] }
    }
    case 'link': {
      const def = linkDef(shape.ref)
      const dx = shape.b.x - shape.a.x
      const dy = shape.b.y - shape.a.y
      const length = Math.hypot(dx, dy)
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI
      const transform = `translate(${num(shape.a.x)},${num(shape.a.y)}) rotate(${num(angle)})`
      if (!def) {
        // 定义没了也要让人看见两个端点在哪，所以退化成一条普通直线
        return { transform, parts: [{ kind: 'line', a: { x: 0, y: 0 }, b: { x: length, y: 0 } }] }
      }
      return { transform, parts: def.partsFor(length) }
    }
    case 'node': {
      const parts: Part[] = [
        { kind: 'rect', a: shape.a, b: shape.b, fill: shape.fill },
      ]
      // 空标签不画：一个空 `<text>` 在导出里没有任何意义，而且量宽会量出 0
      if (shape.text !== '') {
        parts.push({
          kind: 'text',
          at: nodeLabelAt(shape),
          text: shape.text,
          size: nodeFontSize(shape),
          anchor: 'middle',
          // 深色底上要换白字，否则标签和底色糊在一起
          fill: pickLabelInk(shape.fill),
        })
      }
      return { transform: '', parts }
    }
    case 'flow': {
      const points = routeFlow(shape, ctx)
      /*
       * 端点查不到的流向画不出来。**这不是「静默不画」**，而是一条不该出现的
       * 状态：级联删除（scene.ts 的 `removeShapes`）保证模块没了流向也没了，
       * 加载时还会再修一次（serialize.ts 的 `repairScene`）。真走到这里说明
       * 上面两道有一道破了，那种情况下画一个「不知道去哪」的假箭头反而更误导。
       */
      if (!points) return { transform: '', parts: [] }
      return { transform: '', parts: flowParts(points, shape.stroke) }
    }
    default:
      return assertNever(shape)
  }
}

/** 箭头三角形的长度和半宽（图纸单位）。比 mermaid 那种小箭头大一圈，投影上看板书也看得清 */
const ARROW_LENGTH = 16
const ARROW_HALF_WIDTH = 7

/**
 * 一条流向的零件：折线 + 末端的实心三角。
 *
 * 箭头是**算出来的 `polygon` 零件**，不是 SVG 的 `<marker>`。marker 的代价比
 * 看起来大：它要求 id 在整个文档里唯一（画布上会同时存在两个 SVG，
 * `BoardCanvas` 的网格图案就被这个坑咬过一次），而导出的 SVG 目前**根本没有
 * `<defs>`**，还要为每一种线条颜色各配一个 marker。零件这条路走的是既有的
 *「零件 → React / 零件 → DOM」，两个渲染器都不用改结构。
 */
function flowParts(points: readonly Point[], stroke: string): Part[] {
  const tip = points[points.length - 1]
  const before = points[points.length - 2]

  // 只有一个点：两个模块完全重叠，路径退化成一个点。画个小圆点，
  // 至少让人看见「这里有一条流向」，而不是一条看不见又选不中的幽灵
  if (!tip) return []
  if (!before) {
    const r = ARROW_HALF_WIDTH
    return [
      {
        kind: 'ellipse',
        a: { x: tip.x - r, y: tip.y - r },
        b: { x: tip.x + r, y: tip.y + r },
        fill: stroke,
      },
    ]
  }

  const angle = Math.atan2(tip.y - before.y, tip.x - before.x)
  const backX = tip.x - Math.cos(angle) * ARROW_LENGTH
  const backY = tip.y - Math.sin(angle) * ARROW_LENGTH
  // 垂直于行进方向
  const nx = -Math.sin(angle)
  const ny = Math.cos(angle)

  return [
    { kind: 'polyline', points: [...points] },
    {
      kind: 'polygon',
      points: [
        tip,
        { x: backX + nx * ARROW_HALF_WIDTH, y: backY + ny * ARROW_HALF_WIDTH },
        { x: backX - nx * ARROW_HALF_WIDTH, y: backY - ny * ARROW_HALF_WIDTH },
      ],
      fill: stroke,
    },
  ]
}

/**
 * 把模块拉到至少放得下它的标签。**只增不减**（见 scene.ts 里同名的说明）。
 *
 * 放在这个文件而不是 scene.ts：量文字宽度要问浏览器（`measureTextWidth`），
 * 而 scene.ts 是纯的、不碰 DOM。
 */
export function fitNodeToText(node: SceneNode): SceneNode {
  if (node.text === '') return node
  const needed =
    measureTextWidth(node.text, nodeFontSize(node)) + NODE_PADDING_X * 2
  const left = Math.min(node.a.x, node.b.x)
  const right = Math.max(node.a.x, node.b.x)
  if (right - left >= needed) return node

  // 从**右边**往外长（左边缘不动）：已经排好的一排模块不会被推乱。
  // a/b 是对角点，谁在左由当初拖拽的方向决定，所以按当前布局写回，
  // 不能假定 a 一定是左上角
  const newRight = left + needed
  return node.a.x <= node.b.x
    ? { ...node, b: { x: newRight, y: node.b.y } }
    : { ...node, a: { x: newRight, y: node.a.y } }
}

/** 定义查不到时的占位：一个方框，明确表示「这里有个东西但画不出来」 */
function placeholderAtOrigin(): Part[] {
  return [{ kind: 'rect', a: { x: -14, y: -14 }, b: { x: 14, y: 14 } }]
}

/**
 * 自定义符号 → 可放置的点符号定义。
 *
 * 这一个函数同时供给三处：面板缩略图、放置时的预览、插入时**内联进
 * `Scene.defs` 的那份副本**。三处共用同一个来源，就不会出现
 *「库里的和图上画的不一样」。
 *
 * 自定义符号**没有分组**：它们不走标准符号那几个分区，而是统一列在
 *「我的符号」那一段里，所以不用给 `group`。
 */
export function defOfCustomSymbol(symbol: CustomSymbol): PointSymbolDef {
  return {
    id: symbol.id,
    name: symbol.name,
    parts: symbol.shapes.flatMap((s) => shapeToParts(s, EMPTY_CONTEXT).parts),
    anchors: [{ name: 'origin', at: symbol.origin }],
  }
}

/**
 * 零件自己的线宽优先，其次才是外部覆盖。
 *
 * 返回 `undefined` 表示「别写这个属性」——让它从祖先 `<g>` 继承，
 * 这样导出的 SVG 里不会每个元素都挂一个 `stroke-width`。
 * 只有缩略图会给 `widthScale`，那时才算出一个确定的数。
 */
function widthOf(part: Part, style: PartStyle): number | undefined {
  const base = (part.kind === 'text' ? undefined : part.w) ?? style.strokeWidth
  if (style.widthScale === undefined) return base
  return (base ?? STROKE_WIDTH) * style.widthScale
}

// ---------------------------------------------------------------- React 侧

/**
 * 挑出真正要写到元素上的属性。
 *
 * **不能直接把 `style` 展开进 JSX**：`widthScale` 是我们自己的概念，
 * React 会把它当成一个未知的 DOM 属性传下去（控制台一串警告，
 * 而且它确实会出现在 DOM 里）。
 */
function attrsFor(
  part: Part,
  style: PartStyle,
): {
  stroke?: string
  strokeWidth?: number
  strokeOpacity?: number
  fill?: string
} {
  const out: {
    stroke?: string
    strokeWidth?: number
    strokeOpacity?: number
    fill?: string
  } = {}
  if (style.stroke !== undefined) out.stroke = style.stroke
  if (style.strokeOpacity !== undefined) out.strokeOpacity = style.strokeOpacity
  const width = widthOf(part, style)
  if (width !== undefined) out.strokeWidth = width
  // 填充：外部覆盖（选中/橡皮那两层传 `'none'`）优先，其次是零件自带的。
  // 用 `'fill' in part` 而不是 `part.kind !== 'text'`：`line` / `polyline`
  // 根本没有 `fill` 这个字段，只排除 text 的话它们会被算进来而取不到值。
  // 文字零件的 fill 是**文字颜色**，另有 `labelColor` 负责，这里跳过
  if ('fill' in part && part.kind !== 'text') {
    const fill = style.fill ?? part.fill
    if (fill !== undefined) out.fill = fill
  }
  return out
}

/**
 * 文字零件的颜色。
 *
 * 四级优先，每一级都有实际用处，**不要合并**：
 * 1. `style.labelFill`——选中高亮层传 `'transparent'`，别在黑色标签上再叠一层蓝；
 * 2. `part.fill`——模块标签在深色底上要换成白字（`pickLabelInk` 算出来的）；
 * 3. `style.stroke`——符号面板的缩略图传 `stroke: 'currentColor'`，让图标跟着主题走；
 * 4. 墨色——机构符号（比如电动机里的 `M`）的默认。
 */
function labelColor(part: Part & { kind: 'text' }, style: PartStyle): string {
  return style.labelFill ?? part.fill ?? style.stroke ?? INK_COLOR
}

/** 零件 → React 元素。调用方负责 `key`，也负责在 `<g>` 上给默认样式 */
export function partToReact(part: Part, style: PartStyle = {}): ReactElement {
  const shared = attrsFor(part, style)

  switch (part.kind) {
    case 'line':
      return (
        <line
          x1={part.a.x}
          y1={part.a.y}
          x2={part.b.x}
          y2={part.b.y}
          {...shared}
        />
      )
    case 'rect':
      return (
        <rect
          x={Math.min(part.a.x, part.b.x)}
          y={Math.min(part.a.y, part.b.y)}
          width={Math.abs(part.b.x - part.a.x)}
          height={Math.abs(part.b.y - part.a.y)}
          {...shared}
        />
      )
    case 'ellipse':
      return (
        <ellipse
          cx={(part.a.x + part.b.x) / 2}
          cy={(part.a.y + part.b.y) / 2}
          rx={Math.abs(part.b.x - part.a.x) / 2}
          ry={Math.abs(part.b.y - part.a.y) / 2}
          {...shared}
        />
      )
    case 'polyline':
      return <polyline points={pointsAttr(part.points)} {...shared} />
    case 'polygon':
      return <polygon points={pointsAttr(part.points)} {...shared} />
    case 'text':
      // 文字必须自己给 fill：祖先是 `fill="none"`（图元都是描边），
      // 不显式设的话字是透明的
      return (
        <text
          x={part.at.x}
          y={part.at.y}
          fontSize={part.size}
          fontFamily={FIGURE_FONT_FAMILY}
          textAnchor={part.anchor === 'middle' ? 'middle' : undefined}
          fill={labelColor(part, style)}
          stroke="none"
        >
          {part.text}
        </text>
      )
    default:
      return assertNever(part)
  }
}

// ---------------------------------------------------------------- DOM 侧

/**
 * 零件 → 脱离文档的 DOM 节点。
 *
 * 这里只能走 `setAttribute`：节点还没进文档，而且导出是一次性的，
 * 不需要 React 的 diff。属性名要用带连字符的 SVG 写法（`stroke-width`），
 * 和上面那组 camelCase prop 是一对，改一处要同时改另一处。
 */
export function partToDom(part: Part, doc: Document = document): SVGElement {
  const width = widthOf(part, {})

  const attach = (el: SVGElement): SVGElement => {
    if (width !== undefined) el.setAttribute('stroke-width', String(width))
    // 零件自带填充时显式写出来。不写的话会从祖先 `<g fill="none">` 继承——
    // 那是「只用描边」那套惯例的落点，模块的底色必须自己顶出来。
    // `'fill' in part` 的理由同 React 侧：line / polyline 没有这个字段
    if ('fill' in part && part.fill !== undefined) {
      el.setAttribute('fill', part.fill)
    }
    return el
  }

  const box = (a: Point, b: Point) => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  })

  switch (part.kind) {
    case 'line': {
      const el = doc.createElementNS(SVG_NS, 'line')
      el.setAttribute('x1', String(part.a.x))
      el.setAttribute('y1', String(part.a.y))
      el.setAttribute('x2', String(part.b.x))
      el.setAttribute('y2', String(part.b.y))
      return attach(el)
    }
    case 'rect': {
      const r = box(part.a, part.b)
      const el = doc.createElementNS(SVG_NS, 'rect')
      el.setAttribute('x', String(r.x))
      el.setAttribute('y', String(r.y))
      el.setAttribute('width', String(r.w))
      el.setAttribute('height', String(r.h))
      return attach(el)
    }
    case 'ellipse': {
      const r = box(part.a, part.b)
      const el = doc.createElementNS(SVG_NS, 'ellipse')
      el.setAttribute('cx', String(r.x + r.w / 2))
      el.setAttribute('cy', String(r.y + r.h / 2))
      el.setAttribute('rx', String(r.w / 2))
      el.setAttribute('ry', String(r.h / 2))
      return attach(el)
    }
    case 'polyline':
    case 'polygon': {
      const el = doc.createElementNS(
        SVG_NS,
        part.kind === 'polygon' ? 'polygon' : 'polyline',
      )
      el.setAttribute('points', pointsAttr(part.points))
      return attach(el)
    }
    case 'text': {
      const el = doc.createElementNS(SVG_NS, 'text')
      el.setAttribute('x', String(part.at.x))
      el.setAttribute('y', String(part.at.y))
      el.setAttribute('font-size', String(part.size))
      /*
       * 字体必须写出来，理由见 `FIGURE_FONT_FAMILY`：不写的话，这张图在
       * `<img>` 里（独立文档）会用 SVG 的默认字体渲染，和画布上看到的不是
       * 同一个字体——而字宽决定了居中对不对、会不会溢出方框。
       *
       * 这一条**容易在改上面 React 侧时漏掉**：两边是各写一遍属性名的一对
       *（camelCase / 带连字符），改一处必须同时改另一处。
       */
      el.setAttribute('font-family', FIGURE_FONT_FAMILY)
      if (part.anchor === 'middle') el.setAttribute('text-anchor', 'middle')
      // 和 React 侧同理：祖先的 fill="none" 会让文字透明
      el.setAttribute('fill', part.fill ?? INK_COLOR)
      el.setAttribute('stroke', 'none')
      el.textContent = part.text
      return el
    }
    default:
      return assertNever(part)
  }
}

