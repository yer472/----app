import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Loading } from '@/components/ui/Loading'
import { refreshAssetImages, toAssetUrl } from '@/lib/asset'
import { cn } from '@/lib/cn'
import { useOverlay } from '@/lib/shortcuts/overlay'
import { AttachmentRepository, SymbolRepository } from '@/repository'
import type { Attachment, CustomSymbol, ID } from '@/types/models'
import { BoardCanvas } from './BoardCanvas'
import { createScene, removeShapes, type Scene } from './scene'
import { defOfCustomSymbol } from './render'
import { readSceneFromBlob, sceneToSvgBlob } from './serialize'
import { POINT_SYMBOLS, type PointSymbolDef } from './symbols'
import { SymbolEditor, type SymbolDraft } from './SymbolEditor'
import { SymbolPanel } from './SymbolPanel'
import { HOTKEY_TO_TOOL, TOOL_ICONS, TOOL_LIST, type Tool } from './tools'
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
  const [tool, setTool] = useState<Tool>({ kind: 'line' })
  const [snap, setSnap] = useState(true)
  const [selectedId, setSelectedId] = useState<ID | null>(null)
  const [caption, setCaption] = useState('')
  const [loading, setLoading] = useState(attachment !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 附件存在但**读不出来**。
   *
   * 这个标记存在的唯一理由是挡住保存。原来读失败只 `setError(...)`，
   * 而 `handleSave` 完全不看 `error`，照样把当前的（空）场景写成新附件——
   * 也就是说「打开一张读不出来的图 → 点完成」会**用一张白纸永久顶掉原图**，
   * 而且历史里没有原 SVG 可退。
   *
   * 以前要手工改坏 SVG 才能碰到，所以一直没被发现；场景格式升到 2 之后，
   * 一个还开着旧版 JS 的标签页（PWA 更新后旧标签页不会自刷新）就能走到
   * 「新图在旧版里读不出来」这条路。
   */
  const [sceneUnavailable, setSceneUnavailable] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  /** 绘制过程中的长度/角度读数，显示在页脚 */
  const [measure, setMeasure] = useState<string | null>(null)
  /** 一次性提示（比如「这个铰链固定在机架上」），显示在页脚 */
  const [notice, setNotice] = useState<string | null>(null)
  /** 符号编辑层开着。editingSymbol 为 null 表示在画新符号 */
  const [symbolEditorOpen, setSymbolEditorOpen] = useState(false)
  const [editingSymbol, setEditingSymbol] = useState<CustomSymbol | null>(null)
  const [deletingSymbol, setDeletingSymbol] = useState<CustomSymbol | null>(null)

  /**
   * 自定义符号。**undefined 表示还没读回来**，不要把它当成「一个都没有」。
   *
   * 原来这里写的是 `?? NO_CUSTOMS`，于是刚打开画板的那一瞬间，符号面板会
   * 先显示一句「还没有。点「新建」画一个」——文案是错的，用户看到的
   * 是一个「你的符号不见了」的瞬间。空数组和「还没读到」是两种状态。
   */
  const customs = useLiveQuery(() => SymbolRepository.list(), [])

  /**
   * 可放置的点符号：内置的 + 自己画的。
   *
   * 两者用同一个形状（`PointSymbolDef`），所以面板、预览、往场景里内联
   * 走的是同一条路，不需要为「自定义」再分一套分支。
   */
  const library = useMemo<Record<string, PointSymbolDef>>(() => {
    const map: Record<string, PointSymbolDef> = {}
    for (const def of POINT_SYMBOLS) map[def.id] = def
    // 还没读回来时先只上内置的。面板那一段显示的是加载态，
    // 所以这个瞬间不会有「点了我的符号却没反应」的窗口
    for (const symbol of customs ?? []) map[symbol.id] = defOfCustomSymbol(symbol)
    return map
  }, [customs])

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
  } = useSceneHistory(createScene)

  const commit = useCallback(
    (next: Scene) => {
      commitHistory(next)
      setDirty(true)
    },
    [commitHistory],
  )

  // 打开已有的图时把场景读回来。
  // 这一层失败要显示出来——图可能是旧版本存的、也可能被外部工具改过，
  // 静默给一张白纸会让用户以为自己的图丢了。
  // 更要紧的是置上 sceneUnavailable：读不出来时**连保存一起挡掉**，
  // 不然「点一下完成」就把原图换成这张白纸了。
  useEffect(() => {
    if (!attachment) return
    let cancelled = false
    void readSceneFromBlob(attachment.blob).then((loaded) => {
      if (cancelled) return
      if (loaded) {
        reset(loaded)
      } else {
        setSceneUnavailable(true)
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
    // 读不出来的图绝不能保存：当前场景是空的，写下去就是用白纸顶掉原图。
    // 按钮那边也置灰了，这里是第二道保险（比如回车触发的提交）
    if (sceneUnavailable) return

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

  /** 把焦点还给画板容器。符号编辑层关掉之后必须做，否则单键快捷键全部失效 */
  const focusBoard = () => {
    containerRef.current?.focus()
  }

  const handleSaveSymbol = (draft: SymbolDraft) => {
    const run = async () => {
      if (editingSymbol) await SymbolRepository.update(editingSymbol.id, draft)
      else await SymbolRepository.create(draft)
      setSymbolEditorOpen(false)
      setEditingSymbol(null)
      focusBoard()
    }
    void run()
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

    /*
     * 符号编辑层开着时，这一层的键盘处理整体让开。
     *
     * ⚠️ 这行必须在 `stopPropagation()` **之后**。React 的 portal 让事件沿
     * **React 树**冒泡，而符号编辑层是这个容器的 React 子节点，所以它里面的
     * 按键一定会到这里来。顺序写反的话（先 return 再 stop），在符号编辑器里
     * 按 Ctrl+K 会一路导航走——未保存的符号和未保存的图一起丢。
     */
    if (symbolEditorOpen) return

    const target = event.target as HTMLElement
    const inField =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'

    /*
     * Esc 分两步：先撤掉手上那件事（上膛的符号 / 选中的图形），都没有了才关画板。
     *
     * 一次 Esc 就直接关画板会让人措手不及——「手滑点了个符号」的时候，
     * 用户想撤的是那一下，不是整张图。代价是关画板要多按一次。
     */
    if (event.key === 'Escape') {
      event.preventDefault()
      if (confirmingClose) return
      if (tool.kind === 'symbol') {
        setTool({ kind: 'select' })
        return
      }
      if (selectedId) {
        setSelectedId(null)
        return
      }
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
      setTool({ kind: nextTool })
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

        {TOOL_LIST.map((spec) => (
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
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="说明文字（可留空）"
            className="h-8 w-44 rounded-md border border-neutral-300 bg-white px-2.5 text-sm outline-none placeholder:text-neutral-300 focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-800 dark:placeholder:text-neutral-600"
          />
          <Button variant="secondary" onClick={requestClose}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving || sceneUnavailable}
            title={
              sceneUnavailable
                ? '这张图读不出来，保存会把它覆盖掉，所以先禁用了'
                : undefined
            }
          >
            {saving ? '保存中…' : '完成'}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {!loading && !sceneUnavailable ? (
          <SymbolPanel
            armed={tool.kind === 'symbol' ? tool.ref : null}
            onArm={(ref) => {
              setTool({ kind: 'symbol', ref })
              setSelectedId(null)
            }}
            customs={customs}
            customDefs={library}
            onNewCustom={() => {
              setEditingSymbol(null)
              setSymbolEditorOpen(true)
            }}
            onEditCustom={(symbol) => {
              setEditingSymbol(symbol)
              setSymbolEditorOpen(true)
            }}
            onDeleteCustom={setDeletingSymbol}
          />
        ) : null}

        <div className="min-h-0 flex-1 p-4">
        {loading ? (
          <Loading
            className="flex h-full items-center justify-center"
            label="正在打开这张图…"
          />
        ) : sceneUnavailable ? (
          // 读不出来就不给画：画了也存不下去（完成按钮禁用），
          // 让人白画一通比直接说清楚更糟。取消出去，正文里那张图原样不动。
          <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg bg-white text-center ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
            <div className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              这张图读不出来了
            </div>
            <div className="max-w-sm text-xs text-neutral-400 dark:text-neutral-500">
              它可能是更早的版本存的，或者被外部工具改过。为了不覆盖掉它，
              这里已经禁用了保存——正文里那张图还是原样，没有动过。
            </div>
          </div>
        ) : (
          <div className="h-full overflow-hidden rounded-lg ring-1 ring-neutral-200 dark:ring-neutral-800">
            <BoardCanvas
              scene={scene}
              tool={tool}
              library={library}
              snap={snap}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onLive={setLive}
              onCommit={commit}
              onMeasure={setMeasure}
              onNotice={setNotice}
            />
          </div>
        )}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-neutral-200 bg-white px-4 py-1.5 text-xs text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-500">
        <span>
          {tool.kind === 'select'
            ? selectedId
              ? '拖动图形本身是平移 · 拖端点手柄只动那一个点 · Delete 删除'
              : '点选图元可拖动，Delete 删除 · Ctrl+Z 撤销'
            : tool.kind === 'eraser'
              ? '点一下或按住拖动，划过的图元整块擦掉 · 松手才真删，撤销一次全回来'
              : tool.kind === 'symbol'
                ? '在图上点一下放下（带杆的符号按住拖动）· 放下后拖蓝色手柄改方向 · Esc 取消'
                : '按住左键拖动绘制 · 端点会自动吸住 · 按住 Shift 约束角度 · 换工具按快捷键'}
        </span>
        {notice ? (
          <span className="ml-auto text-amber-600 dark:text-amber-400">{notice}</span>
        ) : measure ? (
          <span className="ml-auto tabular-nums text-neutral-600 dark:text-neutral-300">
            {measure}
          </span>
        ) : null}
      </footer>

      {symbolEditorOpen ? (
        <SymbolEditor
          editing={editingSymbol}
          onCancel={() => {
            setSymbolEditorOpen(false)
            setEditingSymbol(null)
            focusBoard()
          }}
          onSave={handleSaveSymbol}
        />
      ) : null}

      <ConfirmDialog
        open={deletingSymbol !== null}
        title="删除这个符号？"
        message={`「${deletingSymbol?.name ?? ''}」会从面板里消失。已经画好的图不受影响——每张图里都存着自己那一份定义。`}
        confirmText="删除"
        onConfirm={() => {
          if (deletingSymbol) void SymbolRepository.remove(deletingSymbol.id)
          setDeletingSymbol(null)
        }}
        onCancel={() => setDeletingSymbol(null)}
      />

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
