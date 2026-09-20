import {
  Fragment,
  useEffect,
  useId,
  useMemo,
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
  contextOf,
  alignSnap,
  cascadeOf,
  collectAlignCandidates,
  hitTest,
  hitTestAll,
  hitTestResizeHandle,
  makeEllipse,
  makeFlow,
  makeLine,
  makeNode,
  makePencil,
  makeRect,
  measure,
  nodeFontSize,
  nodeRect,
  normalizeRect,
  replaceShape,
  resizeHandlesOf,
  translateShape,
  withDefaultNodeSize,
  withResizedCorner,
  NODE_DEFAULT_TEXT,
  NODE_PADDING_X,
  type AlignCandidate,
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
  type SceneContext,
  type SceneDefs,
  type SceneNode,
  type Shape,
} from './scene'
import {
  FIGURE_FONT_FAMILY,
  INK_COLOR,
  NODE_FILL_COLORS,
  STROKE_WIDTH,
  fitNodeToText,
  partToReact,
  pickLabelInk,
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
/** 模块的缩放手柄画成方块，半边长比端点手柄略大一点，好点中 */
const RESIZE_HANDLE_HALF = 6
/** 对齐辅助线。用洋红而不是蓝/绿：那两个已经被选中态和吸附提示占了 */
const GUIDE_COLOR = '#db2777'

/**
 * 「点一下」和「拖一下」的分界（图纸单位）。
 *
 * 不设阈值的话，手抖一两个像素就被当成拖动，于是「单击已选中的模块进编辑」
 * 会先把模块挪走一点；也不能太大，否则想把模块挪一点点时会先走过一段死区。
 */
const MOVE_THRESHOLD = 3
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
  | {
      kind: 'move'
      id: ID
      start: Point
      /** 按下时的那个形状。位移永远相对它算，不在上一帧结果上累加 */
      origin: Shape
      /**
       * 按下的那一刻，这个形状**已经**是选中的吗。
       *
       * 用来实现「单击已选中的模块进入文字编辑」：只有它已经是选中的，
       * 一次没移动的点击才算「想改文字」，否则那只是「选中它」。
       */
      wasSelected: boolean
      /**
       * 对齐辅助线的候选，**按下时算一次**。
       *
       * 和 `draw` 的 `targets` 同一个理由：每帧重算会把正在拖的这个也算进去，
       * 于是它吸到自己身上、一动都动不了。
       */
      candidates: readonly AlignCandidate[]
      base: Scene
    }
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
      /** 拖模块的四角手柄改尺寸 */
      kind: 'resize'
      id: ID
      corner: number
      base: Scene
    }
  | {
      /**
       * 从模块拖向模块，建一条流向。
       *
       * 它**不走 `draw` 那条路**：流向的合法性取决于「两端是两个不同的、
       * 存在的模块」，而那是按下和松手两个时刻才知道的信息，塞进一个草稿
       * 图形里表达不出来。
       */
      kind: 'flow'
      from: ID
      /** 当前指针位置，用来画那条跟随的虚线 */
      to: Point
      /** 指针底下现在是不是一个**合法的**目标模块。松手时用它 */
      target: ID | null
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

/**
 * 屏幕坐标 → 图纸坐标。
 *
 * 只要求 `clientX/clientY`，不收整个事件：指针事件和鼠标事件都要走它
 * （双击进文字编辑走的是 `onDoubleClick`，那是鼠标事件）。
 */
function toScenePoint(
  svg: SVGSVGElement,
  event: { clientX: number; clientY: number },
): Point {
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
    /*
     * 模块也**永远不丢弃**：单击不拖就该造出一个模块。丢弃的表现是
     * 「点了一下什么都没发生」，而这里正是用户最期待有反应的地方。
     * 零尺寸由 `withDefaultNodeSize` 在提交前撑开，不走这条判断。
     */
    case 'node':
      return false
    // 流向不走「先造草稿再拖」这条路（它要带两端的 id），走不到这里。
    // 真到了这里就按「丢掉」处理——不认识的草稿不该被放进场景
    case 'flow':
      return true
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
    case 'node':
      return { ...draft, b: point }
    case 'pencil':
      // 手绘在调用点就分流了，走到这里说明两边不同步
      return { ...draft, points: [...draft.points, point] }
    // 点符号没有终点可拖：它在按下那一刻就定形了
    case 'symbol':
      return draft
    // 同理，流向不是拖出来的
    case 'flow':
      return draft
    default:
      return assertNever(draft)
  }
}

/** 绘制过程中的读数，显示在画板页脚。没有可读的量就返回 null */
function measureText(shape: Shape): string | null {
  switch (shape.kind) {
    case 'line':
    case 'link': {
      const m = measure(shape.a, shape.b)
      return `长 ${Math.round(m.length)}　角 ${Math.round(m.angleDeg)}°`
    }
    case 'rect':
    case 'ellipse':
    case 'node': {
      const r = normalizeRect(shape.a, shape.b)
      return `${Math.round(r.w)} × ${Math.round(r.h)}`
    }
    case 'pencil':
    case 'symbol':
      // 流向的长度由两端的模块决定，读出来对用户没有意义
    case 'flow':
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
    // 模块从零尺寸开始拖；单击不拖的由 `withDefaultNodeSize` 在提交前撑开
    case 'node':
      return makeNode(point, point, NODE_DEFAULT_TEXT, NODE_FILL_COLORS[0])
    /*
     * 「选择」「橡皮」「流向」在调用点就分流掉了，走到这里说明两边不同步。
     *
     * 流向尤其要在这儿挡住：它**不能**先造一个没有两端的草稿再指望拖动补上——
     * 流向的合法性取决于「两端是两个不同的、存在的模块」，那是手势在按下和
     * 松手两个时刻才知道的信息，塞进一个草稿图形里表达不出来。
     */
    case 'select':
    case 'eraser':
    case 'flow':
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
  /** 正在生效的对齐辅助线。非空时画几条虚线 */
  const [guides, setGuides] = useState<readonly AlignCandidate[]>([])
  /**
   * 正在编辑文字的模块。
   *
   * `value` 是**编辑中的草稿**，不写回场景：敲一个字就改一次场景的话，
   * 撤销栈里会堆满「新、新模、新模块」这种中间状态，撤销一次只退一个字。
   */
  const [editing, setEditing] = useState<{ id: ID; value: string } | null>(null)

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

  /** 进入某个模块的文字编辑。先选中它，否则输入框挂在一个没被选中的框上 */
  const beginEdit = (node: SceneNode) => {
    onSelect(node.id)
    setEditing({ id: node.id, value: node.text })
  }

  /**
   * 提交文字编辑。
   *
   * 文字变长时**只把模块拉宽、不缩**（`fitNodeToText` 的规矩），这样手动拉宽的
   * 通栏长条不会被一次改字打回原形。
   */
  const commitLabel = () => {
    if (!editing) return
    const node = scene.shapes.find((s) => s.id === editing.id)
    if (node?.kind === 'node' && node.text !== editing.value) {
      onCommit(
        replaceShape(scene, node.id, fitNodeToText({ ...node, text: editing.value })),
      )
    }
    setEditing(null)
  }

  /** 双击模块 = 改它的文字。这是「点了没反应」最容易被抱怨的地方，所以双击也接上 */
  const handleDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || tool.kind !== 'select') return
    const hit = hitTest(scene, toScenePoint(svg, event))
    if (hit?.kind === 'node') beginEdit(hit)
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
      // 缩放手柄也排在端点手柄之前：它在模块四角，和端点一样属于「离本体更远
      // 的那一类」——先判本体的话它永远抢不到指针
      const resizeHit = hitTestResizeHandle(scene, raw, selectedId)
      if (resizeHit) {
        setGesture({
          kind: 'resize',
          id: resizeHit.shape.id,
          corner: resizeHit.corner,
          base: scene,
        })
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

      // 拖动已有形状时**不吃网格吸附**：吸上去会让「挪一点点」变得不可能
      const hit = hitTest(scene, raw)
      // 在 `onSelect` **之前**记下来：它是「这次点击之前就选中了吗」，
      // 而不是「这次点击选中了吗」——后者恒为真，单击进编辑就退化成
      // 「点一下任何模块都会进编辑」
      const wasSelected = hit !== null && hit.id === selectedId
      onSelect(hit?.id ?? null)
      if (hit) {
        setGesture({
          kind: 'move',
          id: hit.id,
          start: raw,
          origin: hit,
          wasSelected,
          candidates: collectAlignCandidates(scene, hit.id),
          base: scene,
        })
      }
      return
    }

    /*
     * 流向：从一个模块拖到另一个模块。
     *
     * 它和别的工具不同——按下时就要求底下**必须**是一个模块，因为
     * 「从哪出发」是这条流向身份的一半，事后补不出来。
     */
    if (tool.kind === 'flow') {
      const hit = hitTest(scene, raw)
      if (hit?.kind === 'node') {
        setGesture({ kind: 'flow', from: hit.id, to: raw, target: null })
      } else {
        onNotice('要从一个模块上开始拖，拖到另一个模块上松手。')
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

    if (gesture.kind === 'resize') {
      const shape = gesture.base.shapes.find((s) => s.id === gesture.id)
      if (shape?.kind !== 'node') return
      const to = snapToGrid(raw, snap, GRID_SIZE)
      const resized = withResizedCorner(shape, gesture.corner, to)
      onLive(replaceShape(gesture.base, shape.id, resized))
      onMeasure(measureText(resized))
      return
    }

    if (gesture.kind === 'flow') {
      const hit = hitTest(scene, raw)
      const target =
        hit?.kind === 'node' && hit.id !== gesture.from ? hit.id : null
      setGesture({ ...gesture, to: raw, target })
      return
    }

    if (gesture.kind === 'move') {
      const dx = raw.x - gesture.start.x
      const dy = raw.y - gesture.start.y
      const origin = gesture.origin

      /*
       * 方框类（模块、矩形、椭圆）拖动时吃**对齐辅助线**；其余图形走原来的
       * 「连带重合端点一起动」。
       *
       * 辅助线对三种方框都生效、不只给模块，是因为场景本来就能混放：只给模块
       * 吸会像一个 bug，而三者本来就有同样的左/中/右。自由线条和符号没有
       * 「左边缘」这回事，所以不参与。
       *
       * 注意这里**不走 `translateBodyWithCoincident`**：那个函数对模块是空转
       * （`handlesOf(node)` 是空的），但每帧都要遍历全场景的手柄。这是一个
       * 显式的选择，不是"顺手留着"。连带后果记在 `handlesOf` 的注释里：
       * 自由图元的端点不会跟着模块走。
       */
      if (
        origin.kind === 'node' ||
        origin.kind === 'rect' ||
        origin.kind === 'ellipse'
      ) {
        const box = normalizeRect(
          { x: origin.a.x + dx, y: origin.a.y + dy },
          { x: origin.b.x + dx, y: origin.b.y + dy },
        )
        const snapResult = alignSnap(box, gesture.candidates)
        setGuides(snapResult.guides)
        onLive(
          replaceShape(
            gesture.base,
            gesture.id,
            translateShape(origin, dx + snapResult.dx, dy + snapResult.dy),
          ),
        )
        return
      }

      // 整体平移**并带动**与它端点重合的其它端点：拖机架的时候整个机构
      // 要跟着走，不然四杆机构一挪就散
      onLive(translateBodyWithCoincident(gesture.base, gesture.id, dx, dy))
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
        // 标红的那批可能只是「要删的模块」，指向它的流向没被标红（它们没被
        // 点中）。`cascadeOf` 把它们补进来，这样**界面显示的**和**实际删掉的**
        // 是同一个集合——提交本身也会级联，这里补的是「看得见」这件事
        const doomed = new Set(gesture.doomed)
        for (const id of cascadeOf(gesture.base, doomed)) doomed.add(id)
        onCommit(removeShapes(gesture.base, [...doomed]))
        // 擦掉的正好是选中的那个，选中框要跟着消失——不然它会挂在
        // 一个已经不存在的图形上，看起来像是选中了「空气」
        if (selectedId && doomed.has(selectedId)) onSelect(null)
      }
      // 一个都没擦到时**不提交**：否则撤销栈里多一步「什么都没变」的空操作，
      // 用户按撤销会觉得没反应
    } else if (
      gesture.kind === 'handle' ||
      gesture.kind === 'rotate' ||
      gesture.kind === 'resize'
    ) {
      // 同拖拽：画面已经由 onLive 更新过，这里只把结果记进历史
      onCommit(scene)
    } else if (gesture.kind === 'move') {
      const raw = toScenePoint(svg, event)
      const moved =
        Math.hypot(raw.x - gesture.start.x, raw.y - gesture.start.y) >
        MOVE_THRESHOLD

      if (moved) {
        // 拖拽期间画面已经由 onLive 更新过了，这里只需要把结果记进历史
        onCommit(scene)
      } else if (gesture.wasSelected && gesture.origin.kind === 'node') {
        // 「单击一个**已经选中**的模块」= 想改文字，和双击等价。
        // 判定必须在「有没有真的移动过」上：不区分的话，拖模块会顺手进编辑
        beginEdit(gesture.origin)
      }

      /*
       * 点一下（没有真的移动）**不提交**。
       *
       * 原来这里是无条件 `onCommit(scene)`，于是每次点图元都会往撤销栈里推
       * 一条「什么都没变」的记录，而且 `useHistory.commit` 会**清空重做栈**
       * ——表现是「按撤销没反应、重做也没了」。双击进编辑会让这条路径变成
       * 家常便饭，所以顺手修掉。
       */
    } else if (gesture.kind === 'flow') {
      // 松在模块上才算建立；松在空处什么都不做、也不要提示——
      // 用户看得见那条虚线没有落到任何模块上
      if (gesture.target) {
        onCommit(
          addShapes(scene, [makeFlow(gesture.from, gesture.target, INK_COLOR)]),
        )
      }
    } else if (gesture.draft.kind === 'node') {
      // 模块：单击（没有拖）造出来的是个零尺寸的框，先撑成默认大小；
      // 落地之后**直接进文字编辑**——占位文字就是「新模块」，
      // 刚放下的模块本来就该马上能改名字
      const sized = withDefaultNodeSize(gesture.draft)
      onCommit(addShapes(scene, [sized]))
      beginEdit(sized)
    } else if (!isDegenerate(gesture.draft)) {
      onCommit(addShapes(scene, [gesture.draft]))
    }

    setGesture({ kind: 'none' })
    setSnapMark(null)
    setGuides([])
    onMeasure(null)
    onNotice(null)
  }

  const draft = gesture.kind === 'draw' ? gesture.draft : null
  const selectedShape = selectedId
    ? (scene.shapes.find((s) => s.id === selectedId) ?? null)
    : null

  /**
   * 渲染用的跨图形上下文。
   *
   * `useMemo` 只能挡住「场景没变、只是选中态变了」这类重渲染；拖拽期间
   * 每一帧 `scene` 都是新的，索引会跟着重建。那没关系——一次索引是 O(图元数)，
   * 而这一帧本来就要把每个图元渲染一遍，量级相同。
   */
  const ctx = useMemo(() => contextOf(scene), [scene])

  /**
   * 橡皮标红的集合 = 点中的 + 会被**级联**删掉的流向。
   *
   * 只标点中的那些的话，「屏幕上标红的」和「松手真删的」会是两个集合——
   * 那几条跟着消失的流向在松手前一刻还是黑的，看起来像被误删了。
   * 提交时也会补这一批（见 `finishGesture`），两处算的是同一个东西。
   */
  const eraseDoomed = useMemo(() => {
    if (gesture.kind !== 'erase') return null
    const all = new Set(gesture.doomed)
    for (const id of cascadeOf(scene, gesture.doomed)) all.add(id)
    return all
  }, [gesture, scene])

  /** 建流向手势的预览线。起点是源模块的中心，不精确到边——反正只是提示 */
  const flowPreview = useMemo(() => {
    if (gesture.kind !== 'flow') return null
    const from = scene.shapes.find((s) => s.id === gesture.from)
    if (from?.kind !== 'node') return null
    const r = nodeRect(from)
    return {
      from: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
      to: gesture.to,
      valid: gesture.target !== null,
    }
  }, [gesture, scene])

  const flowTarget = gesture.kind === 'flow' ? gesture.target : null

  /**
   * 正在编辑的那个模块。
   *
   * **要再查一次场景**，不能直接用 `editing.id` 对应的旧对象：编辑期间那个
   * 模块可能已经被删掉（比如撤销把它撤没了），拿着旧对象会把文字写到一个
   * 已经不存在的图形上。
   */
  const editingNode = useMemo(() => {
    if (!editing) return null
    const node = scene.shapes.find((s) => s.id === editing.id)
    return node?.kind === 'node' ? node : null
  }, [editing, scene])

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
      // 双击模块改文字。鼠标事件不是指针事件，所以另挂一个
      onDoubleClick={handleDoubleClick}
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
          <ShapeView key={shape.id} shape={shape} ctx={ctx} />
        ))}
        {draft ? <ShapeView shape={draft} ctx={ctx} /> : null}
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
      {/*
        对齐辅助线：拖动方框类图形时，拖到和别的方框左/中/右（或上/中/下）
        对齐的位置就出现几条虚线。**只是提示，不是吸附的「魔法」**——位移确实
        被吸过去了，但辅助线是让用户看得见「吸到谁身上了」。
      */}
      {guides.map((guide) =>
        guide.axis === 'x' ? (
          <line
            key={`guide-x-${guide.at}`}
            x1={guide.at}
            y1={0}
            x2={guide.at}
            y2={scene.height}
            stroke={GUIDE_COLOR}
            strokeWidth={1}
            strokeDasharray="6 4"
          />
        ) : (
          <line
            key={`guide-y-${guide.at}`}
            x1={0}
            y1={guide.at}
            x2={scene.width}
            y2={guide.at}
            stroke={GUIDE_COLOR}
            strokeWidth={1}
            strokeDasharray="6 4"
          />
        ),
      )}

      {eraseDoomed
        ? scene.shapes
            .filter((s) => eraseDoomed.has(s.id))
            .map((s) => (
              <ShapeView
                key={s.id}
                shape={s}
                ctx={ctx}
                style={{
                  stroke: ERASE_COLOR,
                  strokeWidth: STROKE_WIDTH + 6,
                  strokeOpacity: 0.5,
                  // 不压掉填充，模块的底色会把标签盖住（见 PartStyle.fill）
                  fill: 'none',
                  labelFill: 'transparent',
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
                ctx={ctx}
                style={{
                  stroke: SELECT_COLOR,
                  strokeWidth: STROKE_WIDTH + 4,
                  strokeOpacity: 0.35,
                  // 同上：不压掉填充的话，选中一个模块会让它的文字消失
                  fill: 'none',
                  labelFill: 'transparent',
                }}
              />
            ))
        : null}

      {/*
        建流向时的预览：从源模块中心拉一条虚线到指针。落在合法目标上时变绿
        （和吸附提示同色），这样「松手会不会成」在松手之前就看得见。
      */}
      {flowPreview ? (
        <line
          x1={flowPreview.from.x}
          y1={flowPreview.from.y}
          x2={flowPreview.to.x}
          y2={flowPreview.to.y}
          stroke={flowPreview.valid ? SNAP_COLOR : GUIDE_COLOR}
          strokeWidth={2}
          strokeDasharray="6 4"
        />
      ) : null}

      {flowTarget
        ? scene.shapes
            .filter((s) => s.id === flowTarget)
            .map((s) => (
              <ShapeView
                key="flow-target"
                shape={s}
                ctx={ctx}
                style={{
                  stroke: SNAP_COLOR,
                  strokeWidth: STROKE_WIDTH + 4,
                  strokeOpacity: 0.6,
                  fill: 'none',
                  labelFill: 'transparent',
                }}
              />
            ))
        : null}

      {/* 手柄也是界面的一部分，同样不能进导出的图 */}
      {selectedShape ? <HandlesView shape={selectedShape} defs={scene.defs} /> : null}

      {editingNode && editing ? (
        <LabelEditor
          node={editingNode}
          value={editing.value}
          onChange={(value) => setEditing({ id: editingNode.id, value })}
          onCommit={commitLabel}
          onCancel={() => setEditing(null)}
        />
      ) : null}

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

      {/*
        模块的四角缩放手柄画成**方块**，端点手柄是圆——两者可能同时出现在
        屏幕上，形状不同才不会点错。命中半径两处共用 `HANDLE_HIT_RADIUS`。
      */}
      {resizeHandlesOf(shape).map((at, index) => (
        <rect
          key={`resize-${index}`}
          x={at.x - RESIZE_HANDLE_HALF}
          y={at.y - RESIZE_HANDLE_HALF}
          width={RESIZE_HANDLE_HALF * 2}
          height={RESIZE_HANDLE_HALF * 2}
          fill="#ffffff"
          stroke={HANDLE_COLOR}
          strokeWidth={2}
        />
      ))}
    </>
  )
}

/**
 * 模块文字的就地编辑。
 *
 * 用 `<foreignObject>` 把一个真正的 HTML `<input>` 放进 SVG，坐标直接用**图纸
 * 坐标**——`viewBox` 已经把缩放管掉了，不需要自己换算屏幕坐标（这个文件的开头
 * 明确禁止手工复刻那个变换矩阵）。做成 `DrawBoard` 里的绝对定位浮层反而要自己
 * 算 CTM，还得配一个 ResizeObserver 跟着窗口尺寸走。
 *
 * 它放在**界面层**（主 `<g>` 之外），所以不会进导出的 SVG。导出的图里文字是
 * `<text>`（走 `shapeToParts`），字号和字体都取自同一组常量，所以屏幕上看到的
 * 就是导出的样子。
 */
function LabelEditor({
  node,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  node: SceneNode
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  /** Escape 之后接踵而至的 blur 不该当作「确认」 */
  const cancelledRef = useRef(false)

  useEffect(() => {
    // 全选：占位文字是「新模块」，用户一进来就该能直接打字把它替掉
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const box = nodeRect(node)
  const size = nodeFontSize(node)

  return (
    <foreignObject
      x={box.x}
      y={box.y}
      width={box.w}
      height={box.h}
      data-board-label-editor
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // 点输入框是在放光标，不该被画布当成一次拖动
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onBlur={() => {
          if (!cancelledRef.current) onCommit()
        }}
        onKeyDown={(event) => {
          /*
           * 先挡住，别让画板的键盘处理看见这些键。
           *
           * DrawBoard 的 Escape 级联排在「焦点是否在输入框里」那个判断**之前**
           * （它要先处理「上膛的符号 / 选中的图形」），不挡的话按一下 Esc 会
           * 先取消选中、再关掉整个画板——正在改的文字一起没了。
           */
          event.stopPropagation()

          if (event.key === 'Escape') {
            event.preventDefault()
            cancelledRef.current = true
            onCancel()
            return
          }

          /*
           * 中文输入法确认候选词的那个 Enter **不是**「改完了」：此时
           * `isComposing` 为真（`key` 甚至会是 `'Process'`）。不判它的话，
           * 敲拼音按回车选词会把半截拼音直接提交掉。
           *
           * ⚠️ 这一条 CDP 测不出来（见 XXBJ.md 的测试纪律），只能人工确认：
           * 切到中文输入法 → 敲 nihao 让候选窗弹出来 → 按 Enter 应当是**选词**
           * 而不是提交；关掉候选窗再按 Enter 才提交。
           */
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onCommit()
          }
        }}
        className="w-full text-center outline-none"
        style={{
          height: '100%',
          boxSizing: 'border-box',
          padding: `0 ${NODE_PADDING_X}px`,
          fontFamily: FIGURE_FONT_FAMILY,
          fontSize: `${size}px`,
          color: pickLabelInk(node.fill),
          background: 'transparent',
          border: 'none',
          // 画布上有 `select-none`，会一路继承进 foreignObject；不覆盖的话
          // 输入框里的文字没法用鼠标拖选（键盘选还是可以的）
          userSelect: 'text',
        }}
      />
    </foreignObject>
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
  ctx,
  style,
}: {
  shape: Shape
  ctx: SceneContext
  style?: PartStyle
}) {
  const { transform, parts } = shapeToParts(shape, ctx)
  const children = parts.map((part, index) => (
    <Fragment key={index}>{partToReact(part, style)}</Fragment>
  ))

  // 符号类的零件在局部坐标里，要套一层变换。那个变换和导出侧用的是
  // 同一个值（都来自 shapeToParts），所以两边不可能对不上
  return transform ? <g transform={transform}>{children}</g> : <>{children}</>
}
