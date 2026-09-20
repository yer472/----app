import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { refreshAssetImages, toAssetUrl } from '@/lib/asset'
import { cn } from '@/lib/cn'
import { useOverlay } from '@/lib/shortcuts/overlay'
import { AttachmentRepository } from '@/repository'
import type { Attachment, ID } from '@/types/models'
import { BoardCanvas } from './BoardCanvas'
import { removeShapes, type Scene } from './scene'
import { readSceneFromBlob, sceneToSvgBlob } from './serialize'
import { HOTKEY_TO_TOOL, TOOLS, TOOL_ICONS, type ToolKind } from './tools'
import { useSceneHistory } from './useHistory'

interface DrawBoardProps {
  noteId: ID
  /** 要编辑的已有图形。null 表示新画一张 */
  attachment: Attachment | null
  onClose: () => void
  /**
   * 把画好的图插进正文。返回 false 表示编辑器还没准备好——
   * 这种情况必须让用户看见，否则就是「点了按钮没反应」。
   */
  onInsert: (assetUrl: string, caption: string) => boolean
  /** 有没有未保存的改动。外面据此接入关页提示 */
  onDirtyChange: (dirty: boolean) => void
}

/**
 * 画板：一个盖住整页的全屏浮层。
 *
 * 做成浮层而不是独立路由，是因为插入结果要落到**光标所在的位置**，
 * 而正文的拥有者是 NoteEditor 里的 ProseMirror 实例。走路由的话
 * NotePage 会卸载、编辑器被销毁，插入只能绕道数据库，还得把
 * 保存链路和 blob URL 生命周期在画板里重写一遍。
 *
 * 浮层之下编辑器始终挂着，插入走编辑器暴露的命令，
 * 之后的自动保存、孤儿清理、自动备份全部沿用既有链路，一行新代码都不用。
 */
export function DrawBoard({
  noteId,
  attachment,
  onClose,
  onInsert,
  onDirtyChange,
}: DrawBoardProps) {
  const [tool, setTool] = useState<ToolKind>('line')
  const [snap, setSnap] = useState(true)
  const [selectedId, setSelectedId] = useState<ID | null>(null)
  const [caption, setCaption] = useState('')
  const [loading, setLoading] = useState(attachment !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)

  // 登记成浮层：全局快捷键层据此整体让位。
  // 下面那个 stopPropagation 其实已经挡住了 window 上的监听器，
  // 这里是第二道保险，也让「画板是个浮层」这件事在代码里说得明白。
  useOverlay(true)

  const containerRef = useRef<HTMLDivElement>(null)

  const {
    scene,
    setLive,
    commit: commitHistory,
    undo,
    redo,
    canUndo,
    canRedo,
    reset,
  } = useSceneHistory(() => ({
    width: 1200,
    height: 900,
    shapes: [],
  }) as Scene)

  const commit = useCallback(
    (next: Scene) => {
      commitHistory(next)
      setDirty(true)
    },
    [commitHistory],
  )

  // 打开已有的图时把场景读回来。
  // 这一层失败要显示出来——图可能是旧版本存的、也可能被外部工具改过，
  // 静默给一张白纸会让用户以为自己的图丢了
  useEffect(() => {
    if (!attachment) return
    let cancelled = false
    void readSceneFromBlob(attachment.blob).then((loaded) => {
      if (cancelled) return
      if (loaded) {
        reset(loaded)
      } else {
        setError('这张图读不出来了。它可能是更早的版本存的。')
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [attachment, reset])

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  // 焦点移进画板。不放的话键盘事件还会落在下面的编辑器上，
  // 两边会同时响应同一个快捷键
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    commit(removeShapes(scene, [selectedId]))
    setSelectedId(null)
  }, [commit, scene, selectedId])

  /**
   * 保存并收尾。
   *
   * 注意「编辑已有的图」和「新画一张」是两条不同的路：
   * 前者只覆盖附件内容，正文里的引用原封不动；后者才需要插入。
   * 编辑完再插一次的话，同一张图会在笔记里出现两遍。
   */
  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const blob = sceneToSvgBlob(scene)
      const size = { blob, width: scene.width, height: scene.height }

      if (attachment) {
        await AttachmentRepository.replace(attachment.id, size)
        // 必须刷新：asset.ts 按附件 id 缓存了 blob URL，
        // 不刷新的话正文里显示的仍然是改动之前的样子
        await refreshAssetImages(attachment.id)
      } else {
        const created = await AttachmentRepository.createDrawing({
          noteId,
          ...size,
        })
        if (!onInsert(toAssetUrl(created.id), caption)) {
          // 编辑器还没就绪。这条附件现在没有任何人引用，
          // 立刻收掉，不然它会一直躺到下一次「保存笔记」才被当成孤儿清理
          await AttachmentRepository.remove(created.id)
          setError('编辑器还没准备好，请稍等一下再点完成。')
          return
        }
      }

      setDirty(false)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const requestClose = () => {
    if (dirty) {
      setConfirmingClose(true)
      return
    }
    onClose()
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // 画板是模态的，键盘事件不该漏到外面去。
    // 最要紧的是全局快捷键层（lib/shortcuts）——它挂在 window 的冒泡阶段，
    // 这里挡住就收不到。不挡的话画到一半按一下 Ctrl+K 就被导航去搜索页，
    // 未保存的图全没了。
    //
    // 在容器的冒泡处理器里 stopPropagation 不会影响说明文字输入框：
    // 输入框是事件目标，冒泡到这里时它已经收到过事件了。
    //
    // 例外：对话框的 Esc 挂在 window 的**捕获**阶段（见 Modal.tsx），
    // 从 window 往下走，这里挡不住它——那是故意的，否则画板里嵌套的
    //「放弃这次改动？」确认框按 Esc 就关不掉了。
    event.stopPropagation()

    const target = event.target as HTMLElement
    const inField =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'

    // Esc 归对话框管（见上）。没有对话框开着时才是「关画板」。
    if (event.key === 'Escape') {
      event.preventDefault()
      if (confirmingClose) return
      requestClose()
      return
    }

    // 在说明文字输入框里，Ctrl+Z 和 Delete 应该归输入框自己管
    if (inField) return

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
        deleteSelected()
      }
      return
    }
    if (mod) return

    // 单键工具快捷键必须**没有**修饰键。
    // 原来只比 key，于是 Shift+V / Alt+R 也会换工具——而 Shift 在画板里
    // 是留给「暂时约束角度」的（页脚里写着待做），两者会撞在一起。
    // Ctrl / Meta 上面那句 `if (mod) return` 已经挡掉了。
    if (event.altKey || event.shiftKey) return

    const nextTool = HOTKEY_TO_TOOL.get(key)
    if (nextTool) {
      event.preventDefault()
      setTool(nextTool)
      // 换工具就取消选中，否则选中框会一直挂在图上，
      // 让人以为新工具会画到那个图上面去
      setSelectedId(null)
    }
  }

  // 挂到 body 上而不是就地渲染：模态是 fixed 定位，
  // 一旦哪层祖先加了 transform/filter，包含块就变了，会错位。
  // 挂到 body 上把这一类未来风险一次断掉
  return createPortal(
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex flex-col bg-neutral-100 outline-none dark:bg-neutral-950"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="mr-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {attachment ? '编辑图形' : '新建图形'}
        </span>

        {TOOLS.map((spec) => (
          <button
            key={spec.kind}
            type="button"
            onClick={() => {
              setTool(spec.kind)
              setSelectedId(null)
            }}
            title={`${spec.label}（${spec.hotkey.toUpperCase()}）`}
            aria-pressed={tool === spec.kind}
            className={cn(
              'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors',
              tool === spec.kind
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
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="说明文字（可留空）"
            className="h-8 w-44 rounded-md border border-neutral-300 bg-white px-2.5 text-sm outline-none placeholder:text-neutral-300 focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800 dark:placeholder:text-neutral-600"
          />
          <Button variant="secondary" onClick={requestClose}>
            取消
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '完成'}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            正在打开这张图…
          </div>
        ) : (
          <div className="h-full overflow-hidden rounded-lg ring-1 ring-neutral-200 dark:ring-neutral-800">
            <BoardCanvas
              scene={scene}
              tool={tool}
              snap={snap}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onLive={setLive}
              onCommit={commit}
            />
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-neutral-200 bg-white px-4 py-1.5 text-xs text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-500">
        {tool === 'select'
          ? '点选图元可拖动，Delete 删除 · Ctrl+Z 撤销'
          : '按住左键拖动绘制 · Shift 暂时无法约束角度（待做）· 换工具按快捷键'}
      </footer>

      <ConfirmDialog
        open={confirmingClose}
        title="放弃这次改动？"
        message="这张图还没有保存，关掉之后这次的改动就没了。"
        confirmText="放弃"
        onConfirm={() => {
          setConfirmingClose(false)
          onClose()
        }}
        onCancel={() => setConfirmingClose(false)}
      />
    </div>,
    document.body,
  )
}
