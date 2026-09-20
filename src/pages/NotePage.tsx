import { useLiveQuery } from 'dexie-react-hooks'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { DrawingPicker } from '@/components/board/DrawingPicker'
import {
  NoteEditor,
  type NoteEditorHandle,
} from '@/components/editor/NoteEditor'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { revokeAllAssetUrls } from '@/lib/asset'
import { cn } from '@/lib/cn'
import { usePageShortcuts } from '@/lib/shortcuts/useShortcuts'
import { scheduleAutoBackup } from '@/store/backupStore'
import type { Attachment } from '@/types/models'
import {
  AttachmentRepository,
  ChapterRepository,
  NoteRepository,
  SubjectRepository,
} from '@/repository'

/** 停止输入多久之后落盘 */
const SAVE_DELAY_MS = 1000

/**
 * 画板按需加载。
 *
 * 翻笔记、看笔记的时候多数人不会画图，没理由让每次打开笔记
 * 都多下一份画板的代码。理由和 router.tsx 里 Milkdown 的懒加载一样。
 */
const DrawBoard = lazy(() =>
  import('@/components/board/DrawBoard').then((m) => ({
    default: m.DrawBoard,
  })),
)

type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved'

/** flush 的结果。调用方要能区分「存了」「没改动」和「失败了」 */
type FlushResult = 'saved' | 'unchanged' | 'failed'

/**
 * 笔记页按 noteId 拆成两层。
 *
 * 从 A 笔记切到 B 笔记时，React 认的是同一个路由元素，组件**不会卸载**：
 * 所有「只初始化一次」的东西——编辑器实例、已保存正文的基准值、未落盘的
 * pending——都会原样跟到 B 上去。最直接的后果是打开 B 看到的还是 A 的正文，
 * 接着自动保存把它写进 B，也就是**跨笔记写错数据**。
 *
 * 这个问题一直存在，但应用内原本没有「笔记 → 笔记」的链接，所以碰不到；
 * Alt+N（新建同章节笔记）一上线就是这条路径。
 *
 * 用 key 让 React 按笔记身份重建，比一条条加 reset 可靠：以后任何新加的状态
 * 都自动是干净的，不需要记得来这里补一行。顺带一个好处——切换时旧的那层会走
 * 卸载清理，也就是那次兜底 flush，而它的 flush 闭包里 capture 的还是旧的
 * noteId，所以未保存的内容会正确地落到 A 而不是 B 上。
 */
export function NotePage() {
  const { noteId = '' } = useParams()
  return <NotePageBody key={noteId} />
}

function NotePageBody() {
  const { subjectId = '', chapterId = '', noteId = '' } = useParams()
  const navigate = useNavigate()

  const note = useLiveQuery(
    async () => (await NoteRepository.get(noteId)) ?? null,
    [noteId],
  )
  const subject = useLiveQuery(
    async () => (await SubjectRepository.get(subjectId)) ?? null,
    [subjectId],
  )
  const chapter = useLiveQuery(
    async () => (await ChapterRepository.get(chapterId)) ?? null,
    [chapterId],
  )

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [initialContent, setInitialContent] = useState<string | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')

  // 画板的状态。attachment 为 null 表示在画新的一张
  const [boardOpen, setBoardOpen] = useState(false)
  const [editingDrawing, setEditingDrawing] = useState<Attachment | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // 画板里有没保存的改动。要和正文的脏标记一起进关页提示，
  // 否则画了十分钟一关标签页就全没了
  const [boardDirty, setBoardDirty] = useState(false)
  // Alt+N 的防重入标记，和章节页按钮上那个是同一个作用
  const [creating, setCreating] = useState(false)

  const editorRef = useRef<NoteEditorHandle>(null)

  // 本篇笔记里的图形。编辑之后会自动刷新——
  // 走的是 Dexie 的 liveQuery，和笔记正文同一套响应式
  const drawings = useLiveQuery(
    async () => {
      const all = await AttachmentRepository.listByNote(noteId)
      return all.filter((a) => a.type === 'drawing')
    },
    [noteId],
  )

  // 待落盘的正文 / 标题。为 null 表示没有未保存的改动
  const pendingContentRef = useRef<string | null>(null)
  const pendingTitleRef = useRef<string | null>(null)
  // 已经写进数据库的值，用来判断"有没有真的变过"
  const savedContentRef = useRef('')
  const savedTitleRef = useRef('')
  const timerRef = useRef<number | null>(null)
  const initializedRef = useRef(false)

  // 从数据库读到笔记后初始化一次。
  // 之后 useLiveQuery 还会因为保存而重复触发，必须挡住——
  // 否则每存一次就把编辑器内容重置一次，输入会被打断。
  useEffect(() => {
    if (!note || initializedRef.current) return
    initializedRef.current = true
    savedContentRef.current = note.content
    savedTitleRef.current = note.title
    setInitialContent(note.content)
    setContent(note.content)
    setTitle(note.title)
  }, [note])

  const flush = useCallback(async (): Promise<FlushResult> => {
    const pendingContent = pendingContentRef.current
    const pendingTitle = pendingTitleRef.current
    const contentChanged =
      pendingContent !== null && pendingContent !== savedContentRef.current
    const titleChanged =
      pendingTitle !== null && pendingTitle.trim() !== savedTitleRef.current

    if (!contentChanged && !titleChanged) return 'unchanged'

    setStatus('saving')
    try {
      if (contentChanged && pendingContent !== null) {
        await NoteRepository.saveContent(noteId, pendingContent)
        savedContentRef.current = pendingContent
        // 只有在这期间用户没有再输入时，才清掉 pending；
        // 否则会把新敲的内容误标成"已保存"
        if (pendingContentRef.current === pendingContent) {
          pendingContentRef.current = null
        }
      }

      if (titleChanged && pendingTitle !== null) {
        const trimmed = pendingTitle.trim()
        if (trimmed) {
          await NoteRepository.rename(noteId, trimmed)
          savedTitleRef.current = trimmed
          if (pendingTitleRef.current === pendingTitle) {
            pendingTitleRef.current = null
          }
        }
      }

      setStatus('saved')

      // 正文里可能删掉了图片，顺手清理不再被引用的附件，
      // 免得数据库里越攒越多没人用的图
      if (contentChanged && pendingContent !== null) {
        await AttachmentRepository.removeOrphansOfNote(noteId, pendingContent)
      }

      // 真正落盘成功之后才排一次自动备份。
      // 放在这里而不是监听数据库变化，是因为自动保存本身就很频繁，
      // 由写入方主动通知可以顺带做防抖（见 backupStore 里的 30 秒延迟）。
      scheduleAutoBackup()
      return 'saved'
    } catch {
      // 落盘失败时保留 pending，下次输入还会再试一次
      setStatus('unsaved')
      return 'failed'
    }
  }, [noteId])

  const scheduleSave = useCallback(() => {
    setStatus('unsaved')
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void flush()
    }, SAVE_DELAY_MS)
  }, [flush])

  const handleEditorChange = useCallback(
    (markdown: string) => {
      pendingContentRef.current = markdown
      setContent(markdown)
      scheduleSave()
    },
    [scheduleSave],
  )

  const handleTitleChange = useCallback(
    (value: string) => {
      setTitle(value)
      pendingTitleRef.current = value
      scheduleSave()
    },
    [scheduleSave],
  )

  // 离开页面前把没存的内容落盘。
  // 少了这一步，用户敲完最后一句立刻点侧边栏跳走，那句话就丢了。
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      void flush()
      revokeAllAssetUrls()
    }
  }, [flush])

  // 关标签页/刷新时的兜底提示
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const contentDirty =
        pendingContentRef.current !== null &&
        pendingContentRef.current !== savedContentRef.current
      const titleDirty =
        pendingTitleRef.current !== null &&
        pendingTitleRef.current.trim() !== savedTitleRef.current
      if (contentDirty || titleDirty || boardDirty) event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [boardDirty])

  /**
   * 在同一章节里再建一篇笔记，并直接跳过去。
   *
   * 不用先 flush：跳转会换掉本层的 key，旧那层走卸载清理时那次兜底 flush
   * 用的还是旧的 noteId，内容会正确地落到本篇。见文件顶部那段注释。
   */
  const createSiblingNote = useCallback(async () => {
    if (creating) return
    setCreating(true)
    try {
      const note = await NoteRepository.create({ chapterId })
      void navigate(
        `/subjects/${subjectId}/chapters/${chapterId}/notes/${note.id}`,
      )
    } finally {
      setCreating(false)
    }
  }, [creating, chapterId, subjectId, navigate])

  // 页面级快捷键。Alt+N 按当前页面上下文新建，Ctrl+S 立刻落盘。
  // 组合键在 lib/shortcuts/catalog.ts 里，这里只引用 id。
  usePageShortcuts([
    {
      id: 'create-new',
      run: () => {
        void createSiblingNote()
      },
    },
    {
      id: 'save-now',
      run: () => {
        // 先掐掉防抖定时器再手动存，否则存完一秒后那次又跑一遍
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current)
          timerRef.current = null
        }
        void flush().then((result) => {
          // 没有改动时 flush 什么都不做，界面上毫无反应——用户会以为快捷键坏了，
          // 所以补一个「已保存」。失败时 flush 自己已经把状态置成「未保存」，别覆盖它。
          if (result === 'unchanged') setStatus('saved')
        })
      },
    },
  ])

  if (note === undefined) {
    return (
      <div className="px-8 py-16 text-center text-sm text-neutral-400">
        加载中…
      </div>
    )
  }

  if (note === null) {
    return (
      <div className="mx-auto max-w-4xl px-8 py-8">
        <EmptyState
          title="笔记不存在"
          description="它可能已经被删除了。"
          action={
            <Link to={`/subjects/${subjectId}/chapters/${chapterId}`}>
              <Button variant="secondary">返回笔记列表</Button>
            </Link>
          }
        />
      </div>
    )
  }

  const charCount = content.replace(/\s/g, '').length

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-neutral-200 px-8 pt-4 pb-3 dark:border-neutral-800">
        <nav className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <Link to="/" className="hover:text-neutral-900 dark:hover:text-neutral-100">
            我的科目
          </Link>
          <span aria-hidden>/</span>
          <Link
            to={`/subjects/${subjectId}`}
            className="hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            {subject?.name ?? '科目'}
          </Link>
          <span aria-hidden>/</span>
          <Link
            to={`/subjects/${subjectId}/chapters/${chapterId}`}
            className="hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            {chapter?.name ?? '章节'}
          </Link>
        </nav>

        <div className="mt-2 flex items-center gap-4">
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            // 失焦时立刻落盘，不用再等防抖那一秒
            onBlur={() => {
              if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current)
                timerRef.current = null
              }
              void flush()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            placeholder="笔记标题"
            className="min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none placeholder:text-neutral-300 dark:placeholder:text-neutral-600"
          />

          <div className="flex shrink-0 items-center gap-3 text-xs">
            {/* 编辑器没就绪之前不能画：画完要插进正文，而插入要靠编辑器。
                禁掉比让用户画完发现插不进去要好 */}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPickerOpen(true)}
              disabled={initialContent === null}
            >
              插入图形
            </Button>
            <span className="text-neutral-400 dark:text-neutral-500">
              {charCount} 字
            </span>
            <SaveIndicator status={status} />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {initialContent === null ? (
          <div className="px-8 py-16 text-center text-sm text-neutral-400">
            正在打开编辑器…
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-8 py-6">
            <NoteEditor
              ref={editorRef}
              noteId={noteId}
              initialMarkdown={initialContent}
              onChange={handleEditorChange}
            />
          </div>
        )}
      </div>

      <DrawingPicker
        open={pickerOpen}
        drawings={drawings}
        onClose={() => setPickerOpen(false)}
        onCreate={() => {
          setPickerOpen(false)
          setEditingDrawing(null)
          setBoardOpen(true)
        }}
        onEdit={(attachment) => {
          setPickerOpen(false)
          setEditingDrawing(attachment)
          setBoardOpen(true)
        }}
      />

      {boardOpen ? (
        <Suspense fallback={null}>
          <DrawBoard
            noteId={noteId}
            attachment={editingDrawing}
            onClose={() => setBoardOpen(false)}
            onInsert={(assetUrl, caption) =>
              editorRef.current?.insertImage(assetUrl, caption) ?? false
            }
            onDirtyChange={setBoardDirty}
          />
        </Suspense>
      ) : null}
    </div>
  )
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const text = {
    idle: '',
    unsaved: '未保存',
    saving: '保存中…',
    saved: '已保存',
  }[status]

  if (!text) return null

  return (
    <span
      className={cn(
        'flex items-center gap-1.5 text-neutral-400 dark:text-neutral-500',
        status === 'saved' && 'text-green-600 dark:text-green-400',
        status === 'unsaved' && 'text-amber-600 dark:text-amber-400',
      )}
    >
      <span aria-hidden>{status === 'saved' ? '✓' : '●'}</span>
      {text}
    </span>
  )
}
