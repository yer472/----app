import {
  normalizeRect,
  type Point,
  type Scene,
  type Shape,
} from './scene'

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

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 图形颜色写死在 SVG 里，不跟随应用主题。
 *
 * 正文里的图是 `<img src="blob:...">`，SVG 在 img 里是一个独立文档，
 * **继承不到页面的 currentColor**，项目里 `text-neutral-800 dark:text-neutral-100`
 * 成对写的那套对它完全无效。所以这里按制图惯例固定成白底黑线：
 * 浅色主题下完全正确，深色主题下是一张「白图纸」，视觉上可以接受。
 */
const SHEET_COLOR = '#ffffff'
const STROKE_COLOR = '#1f2937'

/** 线宽。机构简图的构件要用粗实线，这个值在 1200×900 的图纸上大致相当于 2d */
export const STROKE_WIDTH = 3

/** 当前格式版本。将来场景结构变了，靠它决定要不要做迁移 */
const SCENE_FORMAT_VERSION = 1

interface ScenePayload {
  version: number
  scene: Scene
}

// ---------------------------------------------------------------- 导出

function applyPoints(el: SVGElement, points: Point[]): void {
  el.setAttribute(
    'points',
    points.map((p) => `${p.x},${p.y}`).join(' '),
  )
}

function createShapeElement(shape: Shape): SVGElement | null {
  switch (shape.kind) {
    case 'line': {
      const el = document.createElementNS(SVG_NS, 'line')
      el.setAttribute('x1', String(shape.a.x))
      el.setAttribute('y1', String(shape.a.y))
      el.setAttribute('x2', String(shape.b.x))
      el.setAttribute('y2', String(shape.b.y))
      return el
    }
    case 'rect': {
      const { x, y, w, h } = normalizeRect(shape.a, shape.b)
      const el = document.createElementNS(SVG_NS, 'rect')
      el.setAttribute('x', String(x))
      el.setAttribute('y', String(y))
      el.setAttribute('width', String(w))
      el.setAttribute('height', String(h))
      return el
    }
    case 'ellipse': {
      const { x, y, w, h } = normalizeRect(shape.a, shape.b)
      const el = document.createElementNS(SVG_NS, 'ellipse')
      el.setAttribute('cx', String(x + w / 2))
      el.setAttribute('cy', String(y + h / 2))
      el.setAttribute('rx', String(w / 2))
      el.setAttribute('ry', String(h / 2))
      return el
    }
    case 'pencil': {
      // 少于两点的笔画画不出来，直接跳过，免得产出一个空的 polyline
      if (shape.points.length < 2) return null
      const el = document.createElementNS(SVG_NS, 'polyline')
      applyPoints(el, shape.points)
      return el
    }
  }
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
export function sceneToSvgElement(scene: Scene): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')

  // 显式给出宽高：SVG 放进 <img> 时如果尺寸只能靠内容推断，
  // 有些布局场景下会算成 0×0。viewBox 保证内容随尺寸缩放
  svg.setAttribute('width', String(scene.width))
  svg.setAttribute('height', String(scene.height))
  svg.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`)

  const meta = document.createElementNS(SVG_NS, 'metadata')
  const payload: ScenePayload = { version: SCENE_FORMAT_VERSION, scene }
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
  group.setAttribute('stroke', STROKE_COLOR)
  group.setAttribute('stroke-width', String(STROKE_WIDTH))
  group.setAttribute('stroke-linecap', 'round')
  group.setAttribute('stroke-linejoin', 'round')
  for (const shape of scene.shapes) {
    const el = createShapeElement(shape)
    if (el) group.appendChild(el)
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
  return s.shapes.every(isShape)
}

const SHAPE_KINDS = new Set(['line', 'rect', 'ellipse', 'pencil'])

function isPoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<Point>
  return typeof p.x === 'number' && typeof p.y === 'number'
}

function isShape(value: unknown): value is Shape {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  if (typeof s.id !== 'string') return false
  if (typeof s.kind !== 'string' || !SHAPE_KINDS.has(s.kind)) return false

  if (s.kind === 'pencil') {
    return Array.isArray(s.points) && s.points.every(isPoint)
  }
  return isPoint(s.a) && isPoint(s.b)
}

/** 从附件里读回场景。附件内容不是合法 SVG 时返回 null */
export async function readSceneFromBlob(blob: Blob): Promise<Scene | null> {
  try {
    return parseSceneFromSvg(await blob.text())
  } catch {
    return null
  }
}
