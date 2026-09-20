import { newId } from '@/lib/id'
import type { ID } from '@/types/models'

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

export interface Point {
  x: number
  y: number
}

/**
 * 自由图元。
 *
 * 直线、矩形、椭圆统一用两个锚点 a / b 表示，而不是各自一套字段——
 * 这样「创建时拖出形状」和「选中后拖一个锚点」是同一个逻辑，
 * 命中测试和包围盒也只需要写一次。
 *
 * 矩形和椭圆用对角点而不是「左上角 + 宽高」：拖拽时锚点是哪个角取决于
 * 用户从哪个方向拉出来的，用对角点就不用在拖拽过程中反复归一化。
 */
export type Shape =
  | { id: ID; kind: 'line'; a: Point; b: Point }
  | { id: ID; kind: 'rect'; a: Point; b: Point }
  | { id: ID; kind: 'ellipse'; a: Point; b: Point }
  | { id: ID; kind: 'pencil'; points: Point[] }

export type ShapeKind = Shape['kind']

export interface Scene {
  /** 图纸的逻辑尺寸，坐标系的边界 */
  width: number
  height: number
  /** 绘制顺序即数组顺序，越靠后越在上层 */
  shapes: Shape[]
}

/** 图纸默认尺寸。4:3，够画一个四杆机构还有余量 */
export const PAGE_WIDTH = 1200
export const PAGE_HEIGHT = 900

/** 网格间距。机构简图随手画很难看，对齐网格是最省事的改善 */
export const GRID_SIZE = 20

/** 命中判定的容差（图纸坐标单位）。太小点不中，太大会误选相邻的线 */
export const HIT_TOLERANCE = 6

export function createScene(): Scene {
  return { width: PAGE_WIDTH, height: PAGE_HEIGHT, shapes: [] }
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

export function snapToGrid(p: Point, enabled: boolean): Point {
  if (!enabled) return p
  return {
    x: Math.round(p.x / GRID_SIZE) * GRID_SIZE,
    y: Math.round(p.y / GRID_SIZE) * GRID_SIZE,
  }
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function shapeBounds(shape: Shape): Bounds {
  switch (shape.kind) {
    case 'pencil': {
      if (shape.points.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      }
      const xs = shape.points.map((p) => p.x)
      const ys = shape.points.map((p) => p.y)
      return {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      }
    }
    default: {
      const r = normalizeRect(shape.a, shape.b)
      return { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h }
    }
  }
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

function hitsShape(shape: Shape, p: Point, tolerance: number): boolean {
  switch (shape.kind) {
    case 'line':
      return distanceToSegment(p, shape.a, shape.b) <= tolerance
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
  for (let i = scene.shapes.length - 1; i >= 0; i -= 1) {
    const shape = scene.shapes[i]
    if (shape && hitsShape(shape, p, tolerance)) return shape
  }
  return null
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
    case 'pencil':
      return { ...shape, points: shape.points.map(move) }
    default:
      return { ...shape, a: move(shape.a), b: move(shape.b) }
  }
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
