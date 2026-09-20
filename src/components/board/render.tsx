import type { ReactElement } from 'react'
import type { CustomSymbol } from '@/types/models'
import {
  EMPTY_CONTEXT,
  assertNever,
  type Point,
  type SceneContext,
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

/** 调用方给的样式覆盖。画布的选中高亮就是靠它把描边加粗换色 */
export interface PartStyle {
  stroke?: string
  strokeWidth?: number
  strokeOpacity?: number
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
    default:
      return assertNever(shape)
  }
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
): { stroke?: string; strokeWidth?: number; strokeOpacity?: number } {
  const out: { stroke?: string; strokeWidth?: number; strokeOpacity?: number } = {}
  if (style.stroke !== undefined) out.stroke = style.stroke
  if (style.strokeOpacity !== undefined) out.strokeOpacity = style.strokeOpacity
  const width = widthOf(part, style)
  if (width !== undefined) out.strokeWidth = width
  return out
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
    case 'text':
      // 文字必须自己给 fill：祖先是 `fill="none"`（图元都是描边），
      // 不显式设的话字是透明的
      return (
        <text
          x={part.at.x}
          y={part.at.y}
          fontSize={part.size}
          fill={style.stroke ?? INK_COLOR}
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
    case 'polyline': {
      const el = doc.createElementNS(SVG_NS, 'polyline')
      el.setAttribute('points', pointsAttr(part.points))
      return attach(el)
    }
    case 'text': {
      const el = doc.createElementNS(SVG_NS, 'text')
      el.setAttribute('x', String(part.at.x))
      el.setAttribute('y', String(part.at.y))
      el.setAttribute('font-size', String(part.size))
      // 和 React 侧同理：祖先的 fill="none" 会让文字透明
      el.setAttribute('fill', INK_COLOR)
      el.setAttribute('stroke', 'none')
      el.textContent = part.text
      return el
    }
    default:
      return assertNever(part)
  }
}

