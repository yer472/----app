import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { Notice } from '@/components/ui/Notice'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { usePageShortcuts } from '@/lib/shortcuts/useShortcuts'
import { formatRelative } from '@/lib/time'
import { moveFocusedItem, useReorder } from '@/lib/useReorder'
import { ChapterRepository, SubjectRepository } from '@/repository'
import type { Chapter } from '@/types/models'

/** 删除前那次统计的三态，理由同 SubjectListPage */
type CountState =
  | { state: 'pending' }
  | { state: 'ready'; count: number }
  | { state: 'failed' }

type Dialog =
  | { kind: 'form'; chapter: Chapter | null }
  | { kind: 'delete'; chapter: Chapter; count: CountState }
  | null

export function SubjectPage() {
  const { subjectId = '' } = useParams()
  // useLiveQuery 在查询完成前返回 undefined；查询结果本身用 null 表示"没找到"。
  // 两种状态要分清楚，否则"加载中"和"已删除"会显示成同一个界面。
  const subject = useLiveQuery(
    async () => (await SubjectRepository.get(subjectId)) ?? null,
    [subjectId],
  )
  const chapters = useLiveQuery(
    () => ChapterRepository.listBySubjectWithStats(subjectId),
    [subjectId],
  )
  const [dialog, setDialog] = useState<Dialog>(null)

  const ids = useMemo(() => (chapters ?? []).map((c) => c.id), [chapters])
  const reorder = useReorder(ids, ChapterRepository.reorder)

  const orderedChapters = useMemo(() => {
    const byId = new Map((chapters ?? []).map((c) => [c.id, c]))
    return reorder.order
      .map((id) => byId.get(id))
      .filter((c) => c !== undefined)
  }, [reorder.order, chapters])

  const openCreate = () => setDialog({ kind: 'form', chapter: null })

  const openDelete = async (chapter: Chapter) => {
    setDialog({ kind: 'delete', chapter, count: { state: 'pending' } })
    let count: CountState
    try {
      count = { state: 'ready', count: await ChapterRepository.countNotes(chapter.id) }
    } catch {
      // 统计失败不该挡住删除，但也不能让红框永远停在「正在统计…」
      count = { state: 'failed' }
    }
    setDialog((current) =>
      current?.kind === 'delete' && current.chapter.id === chapter.id
        ? { ...current, count }
        : current,
    )
  }

  // Alt+N 新建章节；Alt+↑/↓ 给焦点所在的那一项排序。
  // 组合键在 lib/shortcuts/catalog.ts 里，这里只引用 id。
  usePageShortcuts([
    { id: 'create-new', run: openCreate },
    { id: 'move-item-up', run: () => moveFocusedItem(reorder, -1) },
    { id: 'move-item-down', run: () => moveFocusedItem(reorder, 1) },
  ])

  // subject === undefined 表示还在读；null 表示确实没有这条记录
  if (subject === undefined) {
    return <Loading className="px-8 py-16" />
  }

  if (subject === null) {
    return (
      <div className="mx-auto max-w-4xl px-8 py-8">
        <EmptyState
          title="科目不存在"
          description="它可能已经被删除了。"
          action={
            <Link to="/">
              <Button variant="secondary">返回科目列表</Button>
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-neutral-500 dark:text-neutral-400">
        <Link to="/" className="hover:text-neutral-900 dark:hover:text-neutral-100">
          我的科目
        </Link>
        <span aria-hidden>/</span>
        <span className="text-neutral-900 dark:text-neutral-100">
          {subject.name}
        </span>
      </nav>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className="mt-2 size-3 shrink-0 rounded-full"
            style={{ backgroundColor: subject.color }}
            aria-hidden
          />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">{subject.name}</h1>
            {subject.description ? (
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                {subject.description}
              </p>
            ) : null}
          </div>
        </div>
        <Button
          variant="primary"
          onClick={() => setDialog({ kind: 'form', chapter: null })}
        >
          + 新建章节
        </Button>
      </header>

      {reorder.error ? (
        <Notice tone="error" className="mb-4">
          排序没有保存成功：{reorder.error}
        </Notice>
      ) : null}

      {chapters === undefined ? (
        <Loading className="py-16" />
      ) : chapters.length === 0 ? (
        <EmptyState
          icon="📑"
          title="还没有章节"
          description="按课堂进度建章节，比如「第三章 微分中值定理」，笔记就记在章节里。"
          action={
            <Button
              variant="primary"
              onClick={() => setDialog({ kind: 'form', chapter: null })}
            >
              + 新建第一个章节
            </Button>
          }
        />
      ) : (
        // 拖动中禁掉文本选择，理由同首页
        <ul
          className={cn(
            'divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800',
            reorder.draggingId && 'select-none',
          )}
        >
          {orderedChapters.map((chapter) => {
            const handle = reorder.handleProps(chapter.id)
            return (
              <li
                key={chapter.id}
                data-reorder-id={chapter.id}
                className={cn(
                  'group relative',
                  reorder.draggingId === chapter.id && 'opacity-50',
                )}
              >
                <Link
                  to={`/subjects/${subjectId}/chapters/${chapter.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {chapter.name}
                    </div>
                    <div className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
                      {chapter.noteCount} 篇笔记 · 更新于{' '}
                      {formatRelative(chapter.updatedAt)}
                    </div>
                  </div>

                  <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                      onClick={(e) => {
                        e.preventDefault()
                        setDialog({ kind: 'form', chapter })
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-red-100 hover:text-red-700 dark:text-neutral-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                      onClick={(e) => {
                        e.preventDefault()
                        void openDelete(chapter)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </Link>

                {/* 手柄放在 <Link> 外面：拖完那一下的 click 会落到锚点上，
                    preventDefault 挡不住它。理由详见 useReorder.ts */}
                <button
                  type="button"
                  {...handle}
                  className={cn(
                    handle.className,
                    'absolute top-1/2 left-1 -translate-y-1/2 rounded px-0.5 text-xs opacity-0 transition-opacity',
                    'text-neutral-400 hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100',
                    'dark:text-neutral-500 dark:hover:text-neutral-200',
                  )}
                  title="拖动排序（也可以按 Alt+↑ / Alt+↓）"
                  aria-label={`拖动排序：${chapter.name}`}
                >
                  ⠿
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {dialog?.kind === 'form' ? (
        <ChapterFormModal
          key={dialog.chapter?.id ?? 'new'}
          subjectId={subjectId}
          chapter={dialog.chapter}
          onClose={() => setDialog(null)}
        />
      ) : null}

      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title="删除章节"
        message={
          dialog?.kind === 'delete' ? (
            <>
              确定要删除
              <span className="font-medium text-neutral-900 dark:text-neutral-100">
                「{dialog.chapter.name}」
              </span>
              吗？
              <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950/50 dark:text-red-300">
                {dialog.count.state === 'pending'
                  ? '正在统计将删除的内容…'
                  : dialog.count.state === 'failed'
                    ? '统计失败（不影响删除）。会连同其中所有笔记和图片一起删除，且无法恢复。'
                    : `将同时删除其中的 ${dialog.count.count} 篇笔记（含图片），且无法恢复。`}
              </div>
            </>
          ) : null
        }
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete') return
          await ChapterRepository.remove(dialog.chapter.id)
          setDialog(null)
        }}
      />
    </div>
  )
}

interface ChapterFormModalProps {
  subjectId: string
  /** null 表示新建 */
  chapter: Chapter | null
  onClose: () => void
}

function ChapterFormModal({
  subjectId,
  chapter,
  onClose,
}: ChapterFormModalProps) {
  const [name, setName] = useState(chapter?.name ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) {
      setError('章节名不能为空')
      return
    }
    setSaving(true)
    try {
      if (chapter) {
        await ChapterRepository.rename(chapter.id, name)
      } else {
        await ChapterRepository.create({ subjectId, name })
      }
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={chapter ? '重命名章节' : '新建章节'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="mb-1.5 block text-sm font-medium">章节名</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError('')
          }}
          placeholder="例如：第三章 微分中值定理"
          className={cn(
            'w-full rounded-md border bg-white px-3 py-2 text-sm outline-none dark:bg-neutral-800',
            'focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20',
            error
              ? 'border-red-400'
              : 'border-neutral-300 dark:border-neutral-700',
          )}
        />
        {error ? (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
        ) : null}
      </form>
    </Modal>
  )
}
