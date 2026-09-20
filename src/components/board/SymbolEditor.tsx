import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useOverlay } from '@/lib/shortcuts/overlay'
import type { CustomSymbol, ID } from '@/types/models'
import type { Point } from '@/types/scene'
import { BoardCanvas } from './BoardCanvas'
import { GRID_SIZE, createScene, removeShapes, type Scene } from './scene'
import { TOOL_ICONS, TOOL_LIST, type Tool, type ToolKind } from './tools'
import { useSceneHistory } from './useHistory'
import { cn } from '@/lib/cn'

/**
 * 符号编辑模式：画一个新符号，或者改一个已有的。
 *
 * 做成**画板容器里的一个覆盖层**，不是新的 portal、也不用 `Modal`：
 *
 * - 不用 `Modal`：它的 Escape 挂在 window 的**捕获**阶段并 `stopPropagation()`，
 *   这一层容器自己的 `onKeyDown` 就**收不到 Escape** 了，而这里恰恰需要
 *   「有未保存的改动先问一次」。嵌套的确认框也会和它一起响应（那个已知局限）。
 * - 不用新 portal：`position: fixed` 的祖先本来就是绝对定位后代的包含块，
 *   用 `absolute inset-0` 就能稳定盖住，也不必去操心「两个 portal 谁先进 body」。
 *
 * **没有符号面板**——不能把符号放进符号里，递归的坑从构造上就不存在。
 * 热键表也用过滤过的那份（`HOTKEY_TO_TOOL` 是模块级单例，含的是画板的全部工具）。
 */

/** 编辑画布的边长（图纸单位）。够画一个支座，也让 20 的网格不至于太粗 */
const CANVAS = 320

/** 插入点固定在画布正中：画个十字准星说明，省掉一整套「标锚点」的交互 */
const ORIGIN: Point = { x: CANVAS / 2, y: CANVAS / 2 }

/**
 * 这一层只给这几个工具。少一个符号工具，就少一种递归的可能。
 *
 * 这是一份**白名单**，所以往 `ToolKind` 里加工具时它不动是**故意的**：
 * 新工具默认进不了符号编辑器。模块和流向更是永远不该进来——符号的定义会被
 * 摊平成一份零件表（`defOfCustomSymbol`），摊平之后就没有「场景」了，
 * 流向的几何在上面的做法下从构造上就算不出来。
 */
const EDITOR_TOOLS: readonly ToolKind[] = [
  'select',
  'line',
  'rect',
  'ellipse',
  'pencil',
  'eraser',
]

const EDITOR_HOTKEYS = new Map<string, ToolKind>(
  TOOL_LIST.filter((t) => EDITOR_TOOLS.includes(t.kind)).map((t) => [t.hotkey, t.kind]),
)

export interface SymbolDraft {
  name: string
  shapes: Scene['shapes']
  origin: Point
  width: number
  height: number
}

interface SymbolEditorProps {
  /** 要改的符号。null 表示新画一个 */
  editing: CustomSymbol | null
  onCancel: () => void
  onSave: (draft: SymbolDraft) => void
}

export function SymbolEditor({ editing, onCancel, onSave }: SymbolEditorProps) {
  // 这一层也算浮层。外层画板已经登记过一次（计数会变成 2），配平由各自的
  // effect 清理函数保证；多登记一次无害，而且让这一层单独看也是自洽的
  useOverlay(true)

  const containerRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<Tool>({ kind: 'line' })
  const [snap, setSnap] = useState(true)
  const [selectedId, setSelectedId] = useState<ID | null>(null)
  const [name, setName] = useState(editing?.name ?? '')
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const initial = (): Scene =>
    editing
      ? {
          width: editing.width,
          height: editing.height,
          shapes: editing.shapes,
        }
      : { ...createScene(), width: CANVAS, height: CANVAS }

  const { scene, setLive, commit, undo, redo, canUndo, canRedo } =
    useSceneHistory(initial)

  /**
   * 焦点进到这一层。
   *
   * 不抢的话键盘事件的目标还在外层的画板容器上，React 的合成事件不会派发到
   * 这里——表现是「在这一层里按什么键都没反应」。
   */
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const isEmpty = scene.shapes.length === 0

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // 先挡住全局快捷键层（它挂在 window 的冒泡阶段）。
    // ⚠️ 顺序要紧：`stopPropagation` 必须在**任何提前返回之前**，
    // 否则这一层里按 Ctrl+K 会直接导航走，未保存的符号和未保存的图一起丢
    event.stopPropagation()

    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      // 名称输入框里只放行 Escape（下面的分支会处理），其余归输入框
      if (event.key !== 'Escape') return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      // 确认框由它自己（window 捕获阶段）处理，这里让开
      if (confirmingDiscard) return
      setConfirmingDiscard(true)
      return
    }

    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()

    if (mod && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (mod && key === 'y') {
      event.preventDefault()
      redo()
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedId) {
        event.preventDefault()
        commit(removeShapes(scene, [selectedId]))
        setSelectedId(null)
      }
      return
    }
    if (mod) return
    if (event.altKey || event.shiftKey) return

    const next = EDITOR_HOTKEYS.get(key)
    if (next) {
      event.preventDefault()
      setTool({ kind: next })
      setSelectedId(null)
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="absolute inset-0 z-20 flex flex-col bg-neutral-100 outline-none dark:bg-neutral-950"
      data-board-host="symbol-editor"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="mr-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {editing ? '修改符号' : '新建符号'}
        </span>

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="符号名字"
          autoFocus
          className="h-8 w-40 rounded-md border border-neutral-300 bg-white px-2.5 text-sm outline-none placeholder:text-neutral-300 focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800 dark:placeholder:text-neutral-600"
        />

        <span className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-700" />

        {TOOL_LIST.filter((spec) => EDITOR_TOOLS.includes(spec.kind)).map((spec) => (
          <button
            key={spec.kind}
            type="button"
            onClick={() => {
              setTool({ kind: spec.kind })
              setSelectedId(null)
            }}
            title={`${spec.label}（${spec.hotkey.toUpperCase()}）`}
            aria-pressed={tool.kind === spec.kind}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors',
              tool.kind === spec.kind
                ? 'bg-blue-600 text-white'
                : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800',
            )}
          >
            <span aria-hidden>{TOOL_ICONS[spec.kind]}</span>
            {spec.label}
          </button>
        ))}

        <span className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-700" />

        <button
          type="button"
          onClick={() => setSnap(!snap)}
          aria-pressed={snap}
          title="对齐到网格"
          className={cn(
            'flex h-8 items-center rounded-md px-2.5 text-sm transition-colors',
            snap
              ? 'bg-blue-600 text-white'
              : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800',
          )}
        >
          <span aria-hidden>▦</span>
          <span className="ml-1.5">网格</span>
        </button>

        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          title="撤销（Ctrl+Z）"
          className="flex h-8 items-center rounded-md px-2.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <span aria-hidden>↶</span>
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          title="重做（Ctrl+Shift+Z）"
          className="flex h-8 items-center rounded-md px-2.5 text-sm text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <span aria-hidden>↷</span>
        </button>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" onClick={() => setConfirmingDiscard(true)}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={isEmpty}
            title={isEmpty ? '先画点什么' : undefined}
            onClick={() => onSave({ name, shapes: scene.shapes, origin: ORIGIN, width: scene.width, height: scene.height })}
          >
            保存
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 p-4">
        {/* 不要给这里加 bg-white：里面那块白图纸已经由 BoardCanvas 自己画了，
            容器再铺一层白的话，深色下窗口比例对不上时露出来的信箱边也是白的，
            整块看上去就是一个大白框。跟着 DrawBoard 里同类容器的做法，
            让父级的 bg-neutral-100 / dark:bg-neutral-950 透出来 */}
        <div className="mx-auto h-full max-w-md overflow-hidden rounded-lg ring-1 ring-neutral-200 dark:ring-neutral-800">
          <BoardCanvas
            scene={scene}
            tool={tool}
            snap={snap}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onLive={setLive}
            onCommit={commit}
            onMeasure={() => {}}
            onNotice={() => {}}
            // 十字准星标出插入点，网格照常
            overlay={
              <g>
                <line
                  x1={ORIGIN.x - 14}
                  y1={ORIGIN.y}
                  x2={ORIGIN.x + 14}
                  y2={ORIGIN.y}
                  stroke="#2563eb"
                  strokeWidth={1}
                />
                <line
                  x1={ORIGIN.x}
                  y1={ORIGIN.y - 14}
                  x2={ORIGIN.x}
                  y2={ORIGIN.y + 14}
                  stroke="#2563eb"
                  strokeWidth={1}
                />
              </g>
            }
          />
        </div>
      </div>

      <footer className="shrink-0 border-t border-neutral-200 bg-white px-4 py-1.5 text-xs text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-500">
        蓝色十字是插入点：以后把这个符号放到图上时，这个点就落在你点下去的位置，
        也是它和别的构件连在一起的地方。网格间距 {GRID_SIZE}。
      </footer>

      {confirmingDiscard ? (
        <DiscardDialog
          onKeep={() => setConfirmingDiscard(false)}
          onDiscard={onCancel}
        />
      ) : null}
    </div>
  )
}

/**
 * 放弃确认。
 *
 * 用普通的绝对定位层而不是 `Modal`：`Modal` 的 Escape 在 window 捕获阶段，
 * 会把这一层容器的 `onKeyDown` 一起挡掉；两个窗口级监听器还会一起响应，
 * 按一次 Esc 同时关掉确认框和整个编辑器。
 */
function DiscardDialog({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void
  onDiscard: () => void
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/20">
      <div className="w-80 rounded-lg bg-white p-5 shadow-lg dark:bg-neutral-900">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          放弃这个符号？
        </h3>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          画的内容还没保存，关掉之后就没了。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onKeep}>
            继续编辑
          </Button>
          <Button variant="danger" size="sm" onClick={onDiscard}>
            放弃
          </Button>
        </div>
      </div>
    </div>
  )
}
