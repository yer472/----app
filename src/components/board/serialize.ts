import {
  INK_COLOR,
  STROKE_WIDTH,
  partToDom,
  shapeToParts,
  SVG_NS,
} from './render'
import {
  pruneDefs,
  type Point,
  type Scene,
  type SceneDefs,
  type Shape,
  type ShapeKind,
} from './scene'
import type { PointSymbolDef } from './symbols'

/**
 * 场景 ↔ SVG 的相互转换。
 *
 * 存进数据库的是一份 SVG：可见的图元负责显示，场景 JSON 塞在标准的
 * `<metadata>` 元素里负责「下次还能接着改」。这样一个文件既是渲染结果
 * 又是源数据，正文里只需要一个普通的 Markdown 图片引用，
 * 备份、孤儿清理、图片渲染全部沿用既有管线，一行都不用改。
 *
 * 和 Milkdown「存 Markdown、编 Markdown」是同一个思路。
 *
 * 构建走 DOM API 而不是拼字符串：场景里将来会有用户输入的文字标注，
 * 拼字符串就得自己处理 XML 转义，那是「看起来能跑、遇到特殊字符才坏」
 * 的经典坑。用 createElementNS + textContent 和 XMLSerializer，
 * 转义由浏览器负责。
 */

/**
 * 图纸底色。
 *
 * 图形颜色写死在 SVG 里，不跟随应用主题：正文里的图是 `<img src="blob:...">`，
 * SVG 在 img 里是一个独立文档，**继承不到页面的 currentColor**，
 * 项目里 `text-neutral-800 dark:text-neutral-100` 成对写的那套对它完全无效。
 * 所以按制图惯例固定成白底黑线：浅色主题下完全正确，深色主题下是一张
 * 「白图纸」，视觉上可以接受。
 *
 * 墨色和线宽在 render.ts 里（两个渲染器都要用，放两处就成了一份
 * 靠「两个常量碰巧相等」维持的约定）。
 */
const SHEET_COLOR = '#ffffff'

/**
 * 每种图形**首次出现**的场景格式版本。
 *
 * 写出去的版本号是**内容的函数**：一张只有直线矩形的图仍然写 1，只有真的
 * 用了符号才写 2。为什么值得这么做——旧版本的画板读到 `version` 高于自己
 * 支持的上限时会返回 null 并显示「这张图读不出来了」。无条件升到 2 的话，
 * 用户随手画的两条直线在回滚到旧版之后就打不开了；按能力写版本号，则只有
 * 真的用了符号的图打不开——而那本来就该打不开。
 *
 * 写成 `Record<ShapeKind, number>` 而不是「有 symbol 就 2」的 if：这个映射是
 * 穷尽的，以后再加一种图形，忘了给它定版本号是**编译错误**，也不必回头重写
 * 这段逻辑。
 */
const KIND_VERSION: Record<ShapeKind, number> = {
  line: 1,
  rect: 1,
  ellipse: 1,
  pencil: 1,
  symbol: 2,
  link: 2,
}

/** 本版本能读到的最高版本号。写入时不一定用这个值，见上面 */
const SCENE_FORMAT_VERSION = Math.max(...Object.values(KIND_VERSION))

/** 一张图实际需要的版本号 */
function neededVersion(scene: Scene): number {
  return Math.max(1, ...scene.shapes.map((s) => KIND_VERSION[s.kind]))
}

interface ScenePayload {
  version: number
  scene: Scene
}

// ---------------------------------------------------------------- 导出

/**
 * 一个图形 → 一组 SVG 元素。
 *
 * 几何全部来自 render.ts 的 `shapeToParts`，也就是画布上用的那一份；
 * 这里只做「零件 → 脱离文档的节点」的翻译。**别在这里再写一遍几何**——
 * 那样就又变回两份实现了。
 *
 * 符号类图形的零件在**局部坐标**里，所以外面要套一个 `<g transform>`。
 * 那个变换由 `shapeToParts` 给出，和画布侧用的是同一个值。
 */
function createShapeElements(shape: Shape, defs: SceneDefs): SVGElement[] {
  const { transform, parts } = shapeToParts(shape, defs)
  const children = parts.map((part) => partToDom(part))
  if (!transform) return children

  const group = document.createElementNS(SVG_NS, 'g')
  group.setAttribute('transform', transform)
  for (const el of children) group.appendChild(el)
  return [group]
}

/**
 * 场景 → 独立的 SVG 元素。
 *
 * 返回的是一个真正能渲染的 SVG：有白底、有图元、有内嵌的场景数据。
 * 调 XMLSerializer 就能拿到可以存盘的文本。
 *
 * ⚠️ 根元素必须由 `createElementNS(SVG_NS, ...)` 创建，**不要**再手动
 * `setAttribute('xmlns', ...)`。手动加的那个属性和序列化器根据命名空间
 * 自动生成的声明会**撞成重复属性**，产出畸形 XML——而畸形 SVG 放进
 * `<img>` 里只会渲染成空白，不抛异常，正好是最难查的一类故障。
 */
export function sceneToSvgElement(input: Scene): SVGSVGElement {
  // 序列化前统一清一次没人用的符号定义：删除图元之后 defs 里会剩下孤儿，
  // 让它一直跟着图进备份、进每一次导出没有意义
  const scene = pruneDefs(input)
  const svg = document.createElementNS(SVG_NS, 'svg')

  // 显式给出宽高：SVG 放进 <img> 时如果尺寸只能靠内容推断，
  // 有些布局场景下会算成 0×0。viewBox 保证内容随尺寸缩放
  svg.setAttribute('width', String(scene.width))
  svg.setAttribute('height', String(scene.height))
  svg.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`)

  const meta = document.createElementNS(SVG_NS, 'metadata')
  // 版本号按内容写，不是固定值——见 KIND_VERSION 的注释
  const payload: ScenePayload = { version: neededVersion(scene), scene }
  // textContent 负责转义，不要手动拼 JSON 字符串
  meta.textContent = JSON.stringify(payload)
  svg.appendChild(meta)

  // 白底。深色主题下这张图会是一块白纸，这是刻意的——
  // 机构制图本来就是白底黑线，反色的简图反而不规范
  const background = document.createElementNS(SVG_NS, 'rect')
  background.setAttribute('x', '0')
  background.setAttribute('y', '0')
  background.setAttribute('width', String(scene.width))
  background.setAttribute('height', String(scene.height))
  background.setAttribute('fill', SHEET_COLOR)
  svg.appendChild(background)

  const group = document.createElementNS(SVG_NS, 'g')
  group.setAttribute('fill', 'none')
  group.setAttribute('stroke', INK_COLOR)
  group.setAttribute('stroke-width', String(STROKE_WIDTH))
  group.setAttribute('stroke-linecap', 'round')
  group.setAttribute('stroke-linejoin', 'round')
  // 一个图形可能展开成多个元素（将来的符号就是），所以逐个 append 而不是
  // 一个图形一个元素。**画布侧的主 <g> 也是这个结构**，两边的元素顺序
  // 一一对应，自检脚本会逐属性对拍。
  for (const shape of scene.shapes) {
    for (const el of createShapeElements(shape, scene.defs)) group.appendChild(el)
  }
  svg.appendChild(group)

  return svg
}

/** 场景 → SVG 文本 */
export function sceneToSvgText(scene: Scene): string {
  return new XMLSerializer().serializeToString(sceneToSvgElement(scene))
}

/** 场景 → 可以直接存进 attachments 的 Blob */
export function sceneToSvgBlob(scene: Scene): Blob {
  return new Blob([sceneToSvgText(scene)], { type: 'image/svg+xml' })
}

// ---------------------------------------------------------------- 导入

/**
 * 从 SVG 文本还原场景。
 *
 * 解析不出来时返回 null 而不是抛错：图可能是旧版本存的、也可能被外部
 * 工具改过，打不开时画板应该显示「这张图打不开了」并保持正文里的图不变，
 * 而不是让整个笔记页崩掉。
 */
export function parseSceneFromSvg(text: string): Scene | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  } catch {
    return null
  }

  // DOMParser 解析失败不会抛错，而是产出一个含 <parsererror> 的文档
  if (doc.querySelector('parsererror')) return null

  const meta = doc.querySelector('metadata')
  const raw = meta?.textContent
  if (!raw) return null

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof payload !== 'object' || payload === null) return null
  const candidate = payload as Partial<ScenePayload>
  if (typeof candidate.version !== 'number') return null
  if (candidate.version > SCENE_FORMAT_VERSION) return null

  const scene = candidate.scene
  if (!isScene(scene)) return null

  return scene
}

/**
 * 场景的形状校验。
 *
 * 数据来自我们自己写出去的 SVG，正常情况下一定合法；但导入的备份、
 * 手工改过的文件都会走到这里。宁可判定为「打不开」，也不要让一个
 * 缺字段的对象进到渲染层，那会变成一个很难定位的白屏。
 */
function isScene(value: unknown): value is Scene {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Partial<Scene>
  if (typeof s.width !== 'number' || typeof s.height !== 'number') return false
  if (!Array.isArray(s.shapes)) return false
  if (s.defs !== undefined && !isDefs(s.defs)) return false
  if (!s.shapes.every(isShape)) return false

  /*
   * 每个点符号的 ref 都要能解析到定义，否则这张图是坏的。
   *
   * 注意**不要**在这一步去查内置符号库（symbols.ts）：判定的依据只有
   * 「场景里有没有这份定义」。内联是刻意的——标准库以后改了图形，老图
   * 也不该跟着变形；如果这里允许回退到内置库，那条承诺就没了。
   */
  const defs = s.defs ?? {}
  return s.shapes.every((shape) =>
    shape.kind === 'symbol' ? defs[shape.ref] !== undefined : true,
  )
}

function isPoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<Point>
  return typeof p.x === 'number' && typeof p.y === 'number'
}

/**
 * 每种图形自己的字段校验。
 *
 * **不要写成 `new Set(['line', ...])`。** 那种写法是 `Set<string>`，
 * 往 `Shape` 联合里加一种图形不会有任何编译错误，而后果很隐蔽：
 * 新图形能存出去（导出侧不看这个表），但**读不回来**——画板会显示
 * 「这张图读不出来了」，用户会以为自己的图坏了。
 *
 * 写成映射类型就反过来了：加了 kind 不在这里补一行，就是编译错误。
 */
const SHAPE_VALIDATORS: {
  [K in ShapeKind]: (s: Record<string, unknown>) => boolean
} = {
  line: (s) => isPoint(s.a) && isPoint(s.b),
  rect: (s) => isPoint(s.a) && isPoint(s.b),
  ellipse: (s) => isPoint(s.a) && isPoint(s.b),
  pencil: (s) => Array.isArray(s.points) && s.points.every(isPoint),
  symbol: (s) =>
    typeof s.ref === 'string' &&
    s.ref.length > 0 &&
    isPoint(s.at) &&
    typeof s.rotation === 'number' &&
    Number.isFinite(s.rotation),
  link: (s) => typeof s.ref === 'string' && s.ref.length > 0 && isPoint(s.a) && isPoint(s.b),
}

const VALIDATOR_BY_KIND = new Map<string, (s: Record<string, unknown>) => boolean>(
  Object.entries(SHAPE_VALIDATORS),
)

function isShape(value: unknown): value is Shape {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  if (typeof s.id !== 'string') return false
  if (typeof s.kind !== 'string') return false
  const validate = VALIDATOR_BY_KIND.get(s.kind)
  return validate ? validate(s) : false
}

const PART_KINDS = new Set(['line', 'polyline', 'rect', 'ellipse', 'text'])

function isPart(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const part = value as Record<string, unknown>
  if (typeof part.kind !== 'string' || !PART_KINDS.has(part.kind)) return false
  if (part.w !== undefined && typeof part.w !== 'number') return false

  switch (part.kind) {
    case 'line':
    case 'rect':
    case 'ellipse':
      return isPoint(part.a) && isPoint(part.b)
    case 'polyline':
      return Array.isArray(part.points) && part.points.every(isPoint)
    case 'text':
      return isPoint(part.at) && typeof part.text === 'string' && typeof part.size === 'number'
    default:
      return false
  }
}

/**
 * 内联的符号定义。
 *
 * 这里**不需要**防嵌套递归：`Part` 里根本没有「符号」这种图元，所以定义
 * 不可能引用另一个定义——从类型上就不可能，手写 JSON 也过不了 `isPart`。
 * （原来设计时担心过自引用爆栈，改成「点符号的定义是纯数据」之后这个风险
 * 就不存在了。）
 */
function isPointSymbolDef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const def = value as Record<string, unknown>
  if (typeof def.id !== 'string' || typeof def.name !== 'string') return false
  if (!Array.isArray(def.parts) || def.parts.length === 0) return false
  if (!def.parts.every(isPart)) return false
  if (!Array.isArray(def.anchors)) return false
  return def.anchors.every(
    (a) =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as Record<string, unknown>).name === 'string' &&
      isPoint((a as Record<string, unknown>).at),
  )
}

function isDefs(value: unknown): value is Record<string, PointSymbolDef> {
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).every(
    ([id, def]) => isPointSymbolDef(def) && (def as { id: string }).id === id,
  )
}

/** 从附件里读回场景。附件内容不是合法 SVG 时返回 null */
export async function readSceneFromBlob(blob: Blob): Promise<Scene | null> {
  try {
    return parseSceneFromSvg(await blob.text())
  } catch {
    return null
  }
}
