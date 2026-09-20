import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ID } from '@/types/models'
import {
  GRID_SIZE,
  addShapes,
  hitTest,
  makeEllipse,
  makeLine,
  makePencil,
  makeRect,
  normalizeRect,
  snapToGrid,
  translateShape,
  type Point,
  type Scene,
  type Shape,
} from './scene'
import type { ToolKind } from './tools'

/**
 * 画布本体：一层 SVG + 指针事件翻译。
 *
 * 所有几何计算都在 scene.ts 里，这里只负责「把事件变成对场景的调用」。
 *
 * 坐标用 `getScreenCTM().inverse()` 换算，而不是自己算缩放比例：
 * 画布靠 viewBox 缩放来适配窗口，浏览器知道那个变换矩阵是什么，
 * 自己复刻一遍只会在窗口尺寸变化时对不上。
 */

/** 选中态是界面的一部分，不写进导出的 SVG，所以可以用界面配色 */
const SELECT_COLOR = '#2563eb'
const GRID_COLOR = '#e5e7eb'
const STROKE_COLOR = '#1f2937'
const STROKE_WIDTH = 3

/**
 * 一次手势。
 *
 * 拖拽和画图分开记：拖拽要在「按下时的形状」基础上算位移，
 * 而不是在上一帧的结果上累加——累加会因为浮点误差和吸附回弹而漂移。
 */
type Gesture =
  | { kind: 'none' }
  | { kind: 'draw'; draft: Shape }
  | { kind: 'move'; id: ID; start: Point; origin: Shape }

interface BoardCanvasProps {
  scene: Scene
  tool: ToolKind
  snap: boolean
  selectedId: ID | null
  onSelect: (id: ID | null) => void
  /** 拖拽过程中更新画面，不进撤销栈 */
  onLive: (scene: Scene) => void
  /** 一步操作结束，进撤销栈 */
  onCommit: (scene: Scene) => void
}

/** 屏幕坐标 → 图纸坐标 */
function toScenePoint(svg: SVGSVGElement, event: ReactPointerEvent): Point {
  const ctm = svg.getScreenCTM()
  if (!ctm) return { x: 0, y: 0 }
  const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(
    ctm.inverse(),
  )
  return { x: p.x, y: p.y }
}

/**
 * 退化的图元：零长度的线、零面积的矩形。
 *
 * 单击（没有拖动）就会产生这种形状。不丢掉的话，每误点一次画布
 * 就多一个看不见但能被选中的图元，用户会莫名其妙选到「空气」。
 */
function isDegenerate(shape: Shape): boolean {
  switch (shape.kind) {
    case 'line': {
      return Math.hypot(shape.b.x - shape.a.x, shape.b.y - shape.a.y) < 2
    }
    case 'rect':
    case 'ellipse': {
      const r = normalizeRect(shape.a, shape.b)
      return r.w < 2 && r.h < 2
    }
    case 'pencil':
      return shape.points.length < 2
  }
}

export function BoardCanvas({
  scene,
  tool,
  snap,
  selectedId,
  onSelect,
  onLive,
  onCommit,
}: BoardCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [gesture, setGesture] = useState<Gesture>({ kind: 'none' })

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || event.button !== 0) return

    // 拖拽要能在画布外面继续跟手，所以捕获指针
    svg.setPointerCapture(event.pointerId)
    const raw = toScenePoint(svg, event)
    const point = snapToGrid(raw, snap)

    if (tool === 'select') {
      const hit = hitTest(scene, raw)
      onSelect(hit?.id ?? null)
      if (hit) {
        setGesture({ kind: 'move', id: hit.id, start: raw, origin: hit })
      }
      return
    }

    const draft =
      tool === 'line'
        ? makeLine(point, point)
        : tool === 'rect'
          ? makeRect(point, point)
          : tool === 'ellipse'
            ? makeEllipse(point, point)
            : makePencil([point])
    setGesture({ kind: 'draw', draft })
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || gesture.kind === 'none') return

    const raw = toScenePoint(svg, event)
    const point = snapToGrid(raw, snap)

    if (gesture.kind === 'move') {
      const origin = gesture.origin
      onLive({
        ...scene,
        shapes: scene.shapes.map((s) =>
          s.id === gesture.id
            ? translateShape(origin, raw.x - gesture.start.x, raw.y - gesture.start.y)
            : s,
        ),
      })
      return
    }

    const draft = gesture.draft
    const next: Shape =
      draft.kind === 'pencil'
        ? { ...draft, points: [...draft.points, raw] }
        : { ...draft, b: point }
    setGesture({ kind: 'draw', draft: next })
  }

  const finishGesture = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || gesture.kind === 'none') return
    if (svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId)
    }

    if (gesture.kind === 'move') {
      // 拖拽期间画面已经由 onLive 更新过了，这里只需要把结果记进历史
      onCommit(scene)
    } else if (!isDegenerate(gesture.draft)) {
      onCommit(addShapes(scene, [gesture.draft]))
    }

    setGesture({ kind: 'none' })
  }

  const draft = gesture.kind === 'draw' ? gesture.draft : null

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full touch-none select-none"
      // 画图时按住拖动不应该选中文字或触发原生拖拽
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishGesture}
      onPointerCancel={finishGesture}
      // 画板自己处理右键，不要弹出浏览器菜单
      onContextMenu={(e) => e.preventDefault()}
    >
      <defs>
        <pattern
          id="xxbj-grid"
          width={GRID_SIZE}
          height={GRID_SIZE}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`}
            fill="none"
            stroke={GRID_COLOR}
            strokeWidth={1}
          />
        </pattern>
      </defs>

      {/* 白底，和导出的图保持一致——所见即所得 */}
      <rect
        x={0}
        y={0}
        width={scene.width}
        height={scene.height}
        fill="#ffffff"
      />
      <rect
        x={0}
        y={0}
        width={scene.width}
        height={scene.height}
        fill="url(#xxbj-grid)"
      />

      <g
        fill="none"
        stroke={STROKE_COLOR}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {scene.shapes.map((shape) => (
          <ShapeView key={shape.id} shape={shape} />
        ))}
        {draft ? <ShapeView shape={draft} /> : null}
      </g>

      {selectedId
        ? scene.shapes
            .filter((s) => s.id === selectedId)
            .map((s) => (
              <ShapeView key="selection" shape={s} stroke={SELECT_COLOR} />
            ))
        : null}
    </svg>
  )
}

/**
 * 一个图元的呈现。
 *
 * 这里和 serialize.ts 里的 createShapeElement 是一对——两处都要改。
 * 没有合并成一份，是因为这里的输出是 React 元素（要参与 diff、要挂事件），
 * 那边输出的是脱离文档的 DOM 节点（要交给 XMLSerializer）。
 * 几何换算统一走 scene.ts 的 normalizeRect，不会算出不一样的形状。
 */
function ShapeView({ shape, stroke }: { shape: Shape; stroke?: string }) {
  // 选中态叠一层高亮，比把原线条换成蓝色更清楚：
  // 用户能同时看到「原来的样子」和「选中的是哪条」
  const common = {
    stroke: stroke ?? undefined,
    strokeWidth: stroke ? STROKE_WIDTH + 4 : undefined,
    strokeOpacity: stroke ? 0.35 : undefined,
    fill: 'none',
  }

  switch (shape.kind) {
    case 'line':
      return (
        <line
          x1={shape.a.x}
          y1={shape.a.y}
          x2={shape.b.x}
          y2={shape.b.y}
          {...common}
        />
      )
    case 'rect': {
      const { x, y, w, h } = normalizeRect(shape.a, shape.b)
      return <rect x={x} y={y} width={w} height={h} {...common} />
    }
    case 'ellipse': {
      const { x, y, w, h } = normalizeRect(shape.a, shape.b)
      return (
        <ellipse
          cx={x + w / 2}
          cy={y + h / 2}
          rx={w / 2}
          ry={h / 2}
          {...common}
        />
      )
    }
    case 'pencil':
      return (
        <polyline
          points={shape.points.map((p) => `${p.x},${p.y}`).join(' ')}
          {...common}
        />
      )
  }
}
