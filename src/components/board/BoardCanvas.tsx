import {
  Fragment,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { ID } from '@/types/models'
import {
  ERASE_TOLERANCE,
  GRID_SIZE,
  addShapes,
  assertNever,
  collectSnapTargets,
  constrainToAngle,
  constrainToSquare,
  hitTest,
  hitTestAll,
  makeEllipse,
  makeLine,
  makePencil,
  makeRect,
  measure,
  normalizeRect,
  removeShapes,
  snapToGrid,
  snapToPoints,
  hitTestHandle,
  hitTestRotateHandle,
  movePointWithCoincident,
  translateBodyWithCoincident,
  makeLink,
  makeSymbol,
  rotateHandleOf,
  rotationFromPointer,
  withDef,
  handlesOf,
  type Point,
  type Scene,
  type SceneDefs,
  type Shape,
} from './scene'
import {
  INK_COLOR,
  STROKE_WIDTH,
  partToReact,
  shapeToParts,
  type PartStyle,
} from './render'
import { linkDef } from './symbols'
import { type Tool, type ToolKind } from './tools'

/**
 * 画布本体：一层 SVG + 指针事件翻译。
 *
 * 所有几何计算都在 scene.ts / render.ts 里，这里只负责「把事件变成对场景的调用」，
 * 以及把 `Part` 翻译成 React 元素。
 *
 * 坐标用 `getScreenCTM().inverse()` 换算，而不是自己算缩放比例：
 * 画布靠 viewBox 缩放来适配窗口，浏览器知道那个变换矩阵是什么，
 * 自己复刻一遍只会在窗口尺寸变化时对不上。
 */

/** 选中态是界面的一部分，不写进导出的 SVG，所以可以用界面配色 */
const SELECT_COLOR = '#2563eb'
/** 吸附提示圈。用绿色和选中态的蓝色区分开——这两个可能同时出现 */
const SNAP_COLOR = '#16a34a'
/** 橡皮划过的图元上的红 */
const ERASE_COLOR = '#dc2626'
/** 端点 / 旋转手柄 */
const HANDLE_COLOR = '#2563eb'
const HANDLE_RADIUS = 5
const GRID_COLOR = '#e5e7eb'
/** 图纸底色。和 serialize.ts 里导出的那张纸保持一致——所见即所得 */
const SHEET_COLOR = '#ffffff'

/**
 * 一次手势。
 *
 * 拖拽和画图分开记：拖拽要在「按下时的形状」基础上算位移，
 * 而不是在上一帧的结果上累加——累加会因为浮点误差和吸附回弹而漂移。
 */
type Gesture =
  | { kind: 'none' }
  | {
      kind: 'draw'
      draft: Shape
      /** 起点。Shift 的角度约束是相对它算的 */
      start: Point
      /**
       * 这次手势开始时的吸附候选点，**按下时算一次**。
       *
       * 不在每次 pointermove 里重算：一是没必要（画这一个图形的过程中别的
       * 形状不会动），二是重算会把「正在被拖的那个形状」也算进去，导致它
       * 吸到自己身上、一动都动不了。
       */
      targets: readonly Point[]
    }
  | { kind: 'move'; id: ID; start: Point; origin: Shape; base: Scene }
  | {
      /** 拖一个端点手柄（或点符号的锚点） */
      kind: 'handle'
      id: ID
      index: number
      /** 按下时那个手柄在哪。联动是相对它算的，不跟着手势漂 */
      anchor: Point
      base: Scene
    }
  | {
      /** 拖点符号的旋转手柄 */
      kind: 'rotate'
      id: ID
      base: Scene
    }
  | {
      kind: 'erase'
      /**
       * 按下时的场景。
       *
       * 橡皮**不调用 `onLive`**，所以画面上的图形一直没变过，历史栈也没动。
       * 存一份基准是为了让「松手时提交哪一份」是显式的：
       * 现有拖拽那条路靠的是「React 在离散事件前会 flush 待处理更新」，
       * 而 pointermove 是**连续事件**，React 18+ 给它的调度优先级更低，
       * 依赖那个时机迟早会出问题。
       */
      base: Scene
      /** 这次要擦掉的图元。松手时一次提交，撤销一次就全回来 */
      doomed: ReadonlySet<ID>
    }

interface BoardCanvasProps {
  scene: Scene
  tool: Tool
  /**
   * 符号面板里可放置的点符号（内置 + 自定义），按 ref 查。
   *
   * 只在**放置的那一刻**用得上：放下去之后定义会被抄一份进 `scene.defs`，
   * 之后这张图跟符号库就没关系了（删掉库里的符号也不影响已经画好的图）。
   */
  library?: SceneDefs
  snap: boolean
  selectedId: ID | null
  onSelect: (id: ID | null) => void
  /** 拖拽过程中更新画面，不进撤销栈 */
  onLive: (scene: Scene) => void
  /** 一步操作结束，进撤销栈 */
  onCommit: (scene: Scene) => void
  /** 绘制过程中的长度/角度读数。没在拖时传 null，页脚据此显示 */
  onMeasure: (text: string | null) => void
  /** 一次性的提示（比如「这个铰链固定在机架上」）。没有时传 null */
  onNotice: (text: string | null) => void
  /**
   * 额外要画在**界面层**的内容（不进导出的图）。
   *
   * 符号编辑器用它画那个标出插入点的十字准星。做成插槽而不是给一个
   * 「显示准星」的布尔开关：准星的位置、样式是编辑器的事，画布不该知道。
   */
  overlay?: ReactNode
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
    case 'line':
    case 'link':
      return Math.hypot(shape.b.x - shape.a.x, shape.b.y - shape.a.y) < 2
    case 'rect':
    case 'ellipse': {
      const r = normalizeRect(shape.a, shape.b)
      return r.w < 2 && r.h < 2
    }
    case 'pencil':
      return shape.points.length < 2
    // 点符号点一下就成形，没有「拖得太短」这回事
    case 'symbol':
      return false
    default:
      return assertNever(shape)
  }
}

/** 把草稿的终点挪到 `point`。只有「两点定形」的图形有终点 */
function withEndPoint(draft: Shape, point: Point): Shape {
  switch (draft.kind) {
    case 'line':
    case 'rect':
    case 'ellipse':
    case 'link':
      return { ...draft, b: point }
    case 'pencil':
      // 手绘在调用点就分流了，走到这里说明两边不同步
      return { ...draft, points: [...draft.points, point] }
    // 点符号没有终点可拖：它在按下那一刻就定形了
    case 'symbol':
      return draft
    default:
      return assertNever(draft)
  }
}

/** 绘制过程中的读数，显示在画板页脚。手绘没有可读的量，返回 null */
function measureText(shape: Shape): string | null {
  switch (shape.kind) {
    case 'line':
    case 'link': {
      const m = measure(shape.a, shape.b)
      return `长 ${Math.round(m.length)}　角 ${Math.round(m.angleDeg)}°`
    }
    case 'rect':
    case 'ellipse': {
      const r = normalizeRect(shape.a, shape.b)
      return `${Math.round(r.w)} × ${Math.round(r.h)}`
    }
    case 'pencil':
    case 'symbol':
      return null
    default:
      return assertNever(shape)
  }
}

/** 工具 → 刚按下时要造的那个草稿图形 */
function draftFor(tool: ToolKind, point: Point): Shape {
  switch (tool) {
    case 'line':
      return makeLine(point, point)
    case 'rect':
      return makeRect(point, point)
    case 'ellipse':
      return makeEllipse(point, point)
    case 'pencil':
      return makePencil([point])
    // 「选择」和「橡皮」在调用点就分流掉了，走到这里说明两边不同步
    case 'select':
    case 'eraser':
      throw new Error(`「${tool}」不产生草稿图形，它应该在上面的分支里被拦掉`)
    default:
      return assertNever(tool)
  }
}

export function BoardCanvas({
  scene,
  tool,
  library,
  snap,
  selectedId,
  onSelect,
  onLive,
  onCommit,
  onMeasure,
  onNotice,
  overlay,
}: BoardCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [gesture, setGesture] = useState<Gesture>({ kind: 'none' })
  /** 当前吸到了哪个端点。非空时画一个提示圈 */
  const [snapMark, setSnapMark] = useState<Point | null>(null)

  /**
   * 网格图案的 id 必须是**每个实例独有**的。
   *
   * 原来写死成 `xxbj-grid`：同一个页面里出现第二个画布（符号编辑器）时，
   * 两个 `<pattern>` 重名，第二个 SVG 里的 `url(#xxbj-grid)` 会解析到
   * **文档里第一个** pattern——编辑器显示的会是画板的 20 单位网格。
   * 这种错不会报任何警告，只是网格间距默默不对。
   *
   * `useId` 会带冒号（`:r0:`），直接用进 `url(#...)` 不保险，所以滤一遍。
   */
  const gridId = `xxbj-grid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  /**
   * 屏幕上的原始点 → 真正的落点。
   *
   * 优先级：**端点吸附 > 角度约束 > 网格吸附**。
   *
   * - 端点吸附排第一，是因为「把杆接在铰链上」比「这一笔正好 15°」要紧；
   *   两者冲突时按物理意义应该服从前者（接不上就是画错了，差几度没人看得出来）。
   * - 按住 Shift 时**关掉网格吸附**：用户要的是精确角度，网格会把那个角度
   *   毁掉（除了 0/90/180/270 这几个，网格落点一般不在 15° 的整数倍上）。
   */
  const resolveDrawPoint = (
    raw: Point,
    start: Point | null,
    shift: boolean,
    targets: readonly Point[],
  ): { point: Point; snapped: boolean } => {
    const hit = snapToPoints(targets, raw)
    if (hit) return { point: hit.at, snapped: true }

    if (shift && start) {
      const constrained =
        tool.kind === 'rect' || tool.kind === 'ellipse'
          ? constrainToSquare(start, raw)
          : constrainToAngle(start, raw)
      return { point: constrained, snapped: false }
    }

    return { point: snapToGrid(raw, snap, GRID_SIZE), snapped: false }
  }

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || event.button !== 0) return

    // 拖拽要能在画布外面继续跟手，所以捕获指针
    svg.setPointerCapture(event.pointerId)
    const raw = toScenePoint(svg, event)

    if (tool.kind === 'select') {
      /*
       * ⚠️ 手柄必须先于 `hitTest` 判定。
       *
       * 手柄画在端点上，而端点就在图形本体上——先测本体的话手柄永远抢不到
       * 指针，「明明看得见却拖不动」。旋转手柄虽然离本体远，也一起放在前面，
       * 免得和一个刚好长得远的图形撞上。
       */
      const rotateHit = hitTestRotateHandle(scene, raw, selectedId)
      if (rotateHit) {
        setGesture({ kind: 'rotate', id: rotateHit.id, base: scene })
        return
      }
      const handleHit = hitTestHandle(scene, raw, selectedId)
      if (handleHit) {
        setGesture({
          kind: 'handle',
          id: handleHit.shape.id,
          index: handleHit.index,
          anchor: handleHit.at,
          base: scene,
        })
        return
      }

      // 拖动已有形状时**不吃吸附**：吸上去会让「挪一点点」变得不可能
      const hit = hitTest(scene, raw)
      onSelect(hit?.id ?? null)
      if (hit) {
        setGesture({ kind: 'move', id: hit.id, start: raw, origin: hit, base: scene })
      }
      return
    }

    if (tool.kind === 'eraser') {
      // 按下就采一次样：不这样的话「点一下不拖」擦不掉任何东西，
      // 而点一下恰恰是最常用的擦法
      const doomed = new Set(hitTestAll(scene, raw, ERASE_TOLERANCE).map((s) => s.id))
      setGesture({ kind: 'erase', base: scene, doomed })
      return
    }

    const targets = collectSnapTargets(scene)

    if (tool.kind === 'symbol') {
      const def = library?.[tool.ref]
      if (def) {
        // 点符号：点一下就成形，没有「拖」这一步，所以不进手势
        const at = resolveDrawPoint(raw, null, false, targets).point
        const shape = makeSymbol(def.id, at)
        // 定义跟着一起抄进场景：以后把库里这个符号删了，这张图照样打得开
        onCommit(addShapes(withDef(scene, def), [shape]))
        onSelect(shape.id)
        return
      }
      const link = linkDef(tool.ref)
      if (link) {
        // 两点符号：按下定 A、拖动定 B、松手放下
        const { point, snapped } = resolveDrawPoint(raw, null, event.shiftKey, targets)
        setSnapMark(snapped ? point : null)
        setGesture({
          kind: 'draw',
          draft: makeLink(link.id, point, point),
          start: point,
          targets,
        })
      }
      return
    }

    const { point, snapped } = resolveDrawPoint(raw, null, event.shiftKey, targets)
    setSnapMark(snapped ? point : null)
    setGesture({ kind: 'draw', draft: draftFor(tool.kind, point), start: point, targets })
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || gesture.kind === 'none') return

    const raw = toScenePoint(svg, event)

    if (gesture.kind === 'erase') {
      // 拿 `base` 而不是 `scene` 做命中：橡皮不改 scene，画面上的图形还是
      // 按下时的样子，被擦掉的只是「记在册子上、等松手一起删」
      const hits = hitTestAll(gesture.base, raw, ERASE_TOLERANCE)
      if (hits.length === 0) return
      const doomed = new Set(gesture.doomed)
      let added = false
      for (const shape of hits) {
        if (!doomed.has(shape.id)) {
          doomed.add(shape.id)
          added = true
        }
      }
      // 没有新增就不要 setState：pointermove 一秒几十次，白重渲染没必要
      if (added) setGesture({ ...gesture, doomed })
      return
    }

    if (gesture.kind === 'rotate') {
      const shape = gesture.base.shapes.find((s) => s.id === gesture.id)
      if (!shape || shape.kind !== 'symbol') return
      const rotation = rotationFromPointer(shape.at, raw, event.shiftKey)
      onLive({
        ...gesture.base,
        shapes: gesture.base.shapes.map((s) =>
          s.id === shape.id ? { ...shape, rotation } : s,
        ),
      })
      return
    }

    if (gesture.kind === 'handle') {
      const shape = gesture.base.shapes.find((s) => s.id === gesture.id)
      if (!shape) return
      const to = snapToGrid(raw, snap, GRID_SIZE)
      const anchor = gesture.anchor
      const result = movePointWithCoincident(gesture.base, {
        shapeId: gesture.id,
        index: gesture.index,
        at: anchor,
      }, to)

      if (result.blockedBy) {
        // 拒绝动，并且**说清楚原因**。默默不动的话用户只会觉得拖坏了
        onNotice('这个铰链固定在机架上，动不了。想挪整台机构就拖机架本身。')
        return
      }
      onNotice(null)
      onLive(result.scene)
      return
    }

    if (gesture.kind === 'move') {
      // 整体平移**并带动**与它端点重合的其它端点：拖机架的时候整个机构
      // 要跟着走，不然四杆机构一挪就散
      onLive(
        translateBodyWithCoincident(
          gesture.base,
          gesture.id,
          raw.x - gesture.start.x,
          raw.y - gesture.start.y,
        ),
      )
      return
    }

    const draft = gesture.draft

    // 手绘的中间点不吸附、也不约束角度：每一笔都吸过去会把笔迹拉变形
    if (draft.kind === 'pencil') {
      setGesture({ ...gesture, draft: { ...draft, points: [...draft.points, raw] } })
      return
    }

    const { point, snapped } = resolveDrawPoint(
      raw,
      gesture.start,
      event.shiftKey,
      gesture.targets,
    )
    setSnapMark(snapped ? point : null)

    const next = withEndPoint(draft, point)
    setGesture({ ...gesture, draft: next })
    onMeasure(measureText(next))
  }

  const finishGesture = (event: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || gesture.kind === 'none') return
    if (svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId)
    }

    if (gesture.kind === 'erase') {
      // 一次拖动**只记一步历史**。按「每擦掉一个提交一次」写的话，
      // 撤销一次只回来一个图元，等于撤销坏了
      if (gesture.doomed.size > 0) {
        onCommit(removeShapes(gesture.base, [...gesture.doomed]))
        // 擦掉的正好是选中的那个，选中框要跟着消失——不然它会挂在
        // 一个已经不存在的图形上，看起来像是选中了「空气」
        if (selectedId && gesture.doomed.has(selectedId)) onSelect(null)
      }
      // 一个都没擦到时**不提交**：否则撤销栈里多一步「什么都没变」的空操作，
      // 用户按撤销会觉得没反应
    } else if (gesture.kind === 'handle' || gesture.kind === 'rotate') {
      // 同拖拽：画面已经由 onLive 更新过，这里只把结果记进历史
      onCommit(scene)
    } else if (gesture.kind === 'move') {
      // 拖拽期间画面已经由 onLive 更新过了，这里只需要把结果记进历史
      onCommit(scene)
    } else if (!isDegenerate(gesture.draft)) {
      onCommit(addShapes(scene, [gesture.draft]))
    }

    setGesture({ kind: 'none' })
    setSnapMark(null)
    onMeasure(null)
    onNotice(null)
  }

  const draft = gesture.kind === 'draw' ? gesture.draft : null
  const selectedShape = selectedId
    ? (scene.shapes.find((s) => s.id === selectedId) ?? null)
    : null

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      preserveAspectRatio="xMidYMid meet"
      className={`h-full w-full touch-none select-none ${
        tool.kind === 'eraser' ? 'cursor-crosshair' : ''
      }`}
      // 自检脚本靠这个属性找画布。页面里有几十个 SVG（Crepe 自带一堆图标），
      // 用 querySelector('svg') 会选中一个 0×0 的图标
      data-board="main"
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
          id={gridId}
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
        fill={SHEET_COLOR}
      />
      <rect
        x={0}
        y={0}
        width={scene.width}
        height={scene.height}
        fill={`url(#${gridId})`}
      />

      <g
        fill="none"
        stroke={INK_COLOR}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {scene.shapes.map((shape) => (
          <ShapeView key={shape.id} shape={shape} defs={scene.defs} />
        ))}
        {draft ? <ShapeView shape={draft} defs={scene.defs} /> : null}
      </g>

      {/*
        下面这一整块都是**界面**，不是图。它们必须放在上面那个 `<g>` 外面：
        那个 `<g>` 的内容会原样进导出的 SVG，而选中高亮、吸附提示、将来的
        手柄都不该出现在正文里那张图上。
      */}
      {snapMark ? (
        <circle
          cx={snapMark.x}
          cy={snapMark.y}
          r={7}
          fill="none"
          stroke={SNAP_COLOR}
          strokeWidth={2}
        />
      ) : null}

      {/*
        橡皮划过的图形：在原来的黑线**上面**再叠一道半透明红。
        没有把它们从主 `<g>` 里摘出来重画，是因为摘出来要动渲染结构，
        而叠加已经足够说清「这几条要没了」——松手才真的删。
      */}
      {gesture.kind === 'erase'
        ? scene.shapes
            .filter((s) => gesture.doomed.has(s.id))
            .map((s) => (
              <ShapeView
                key={s.id}
                shape={s}
                defs={scene.defs}
                style={{
                  stroke: ERASE_COLOR,
                  strokeWidth: STROKE_WIDTH + 6,
                  strokeOpacity: 0.5,
                }}
              />
            ))
        : null}

      {selectedId
        ? scene.shapes
            .filter((s) => s.id === selectedId)
            .map((s) => (
              <ShapeView
                key="selection"
                shape={s}
                defs={scene.defs}
                style={{
                  stroke: SELECT_COLOR,
                  strokeWidth: STROKE_WIDTH + 4,
                  strokeOpacity: 0.35,
                }}
              />
            ))
        : null}

      {/* 手柄也是界面的一部分，同样不能进导出的图 */}
      {selectedShape ? <HandlesView shape={selectedShape} defs={scene.defs} /> : null}

      {overlay}
    </svg>
  )
}

/**
 * 选中图形上的手柄。
 *
 * 端点手柄画成实心白底蓝边的小圆——和吸附提示圈（空心绿圈）区分开，
 * 两者可能同时出现在屏幕上。
 */
function HandlesView({ shape, defs }: { shape: Shape; defs: SceneDefs }) {
  const rotate = rotateHandleOf(shape)

  return (
    <>
      {rotate ? (
        <>
          {/* 从插入点到旋转手柄拉一条细线，让「拖它 = 转这个符号」一眼可见 */}
          <line
            x1={shape.kind === 'symbol' ? shape.at.x : rotate.x}
            y1={shape.kind === 'symbol' ? shape.at.y : rotate.y}
            x2={rotate.x}
            y2={rotate.y}
            stroke={HANDLE_COLOR}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          <circle
            cx={rotate.x}
            cy={rotate.y}
            r={HANDLE_RADIUS}
            fill="#ffffff"
            stroke={HANDLE_COLOR}
            strokeWidth={2}
          />
        </>
      ) : null}

      {handlesOf(shape, defs).map((at, index) => (
        <circle
          key={index}
          cx={at.x}
          cy={at.y}
          r={HANDLE_RADIUS}
          fill="#ffffff"
          stroke={HANDLE_COLOR}
          strokeWidth={2}
        />
      ))}
    </>
  )
}

/**
 * 一个图元的呈现。
 *
 * 几何来自 render.ts 的 `shapeToParts`，和导出侧是**同一份**——
 * 这一层只负责把 `Part` 翻成 React 元素，不再自己算几何。
 * 原来这里和 serialize.ts 的 createShapeElement 是一对要同步改的双胞胎，
 * 漏改时两边都不会报错。
 */
function ShapeView({
  shape,
  defs,
  style,
}: {
  shape: Shape
  defs: SceneDefs
  style?: PartStyle
}) {
  const { transform, parts } = shapeToParts(shape, defs)
  const children = parts.map((part, index) => (
    <Fragment key={index}>{partToReact(part, style)}</Fragment>
  ))

  // 符号类的零件在局部坐标里，要套一层变换。那个变换和导出侧用的是
  // 同一个值（都来自 shapeToParts），所以两边不可能对不上
  return transform ? <g transform={transform}>{children}</g> : <>{children}</>
}
