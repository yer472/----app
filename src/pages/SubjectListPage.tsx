import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SubjectFormModal } from '@/components/SubjectFormModal'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Loading } from '@/components/ui/Loading'
import { Notice } from '@/components/ui/Notice'
import { pickNextColor } from '@/lib/colors'
import { cn } from '@/lib/cn'
import { usePageShortcuts } from '@/lib/shortcuts/useShortcuts'
import { formatRelative } from '@/lib/time'
import { moveFocusedItem, useReorder } from '@/lib/useReorder'
import { NoteRepository, SubjectRepository } from '@/repository'
import type { Subject, SubjectWithStats } from '@/types/models'

type Dialog =
  | { kind: 'form'; subject: Subject | null }
  | { kind: 'delete'; subject: SubjectWithStats }
  | null

/** 删除前那次统计的三态。null 表示还没开始 */
type CountState =
  | { state: 'pending' }
  | { state: 'ready'; chapters: number; notes: number }
  | { state: 'failed' }

export function SubjectListPage() {
  const subjects = useLiveQuery(() => SubjectRepository.listWithStats(), [])
  const recent = useLiveQuery(() => NoteRepository.listRecent(), [])
  const [dialog, setDialog] = useState<Dialog>(null)
  const [deleteCount, setDeleteCount] = useState<CountState>({ state: 'pending' })

  const ids = useMemo(() => (subjects ?? []).map((s) => s.id), [subjects])
  const reorder = useReorder(ids, SubjectRepository.reorder)

  // 顺序由 hook 给（拖动/键盘期间是乐观顺序），再映射回记录
  const orderedSubjects = useMemo(() => {
    const byId = new Map((subjects ?? []).map((s) => [s.id, s]))
    return reorder.order
      .map((id) => byId.get(id))
      .filter((s): s is SubjectWithStats => s !== undefined)
  }, [reorder.order, subjects])

  const openCreate = useCallback(() => setDialog({ kind: 'form', subject: null }), [])

  const openDelete = async (subject: SubjectWithStats) => {
    setDialog({ kind: 'delete', subject })
    setDeleteCount({ state: 'pending' })
    try {
      const info = await SubjectRepository.countDescendants(subject.id)
      setDeleteCount({ state: 'ready', ...info })
    } catch {
      // 统计失败不该挡住删除——它只是给用户一个数量预估。
      // 原来这里是裸 await：抛出的话红框会永远停在「正在统计…」，
      // 用户面前是一个看起来还在算、其实已经死掉的对话框
      setDeleteCount({ state: 'failed' })
    }
  }

  const usedColors = (subjects ?? []).map((s) => s.color)

  // Alt+N 新建科目；Alt+↑/↓ 给焦点所在的那一项排序。
  // 组合键在 lib/shortcuts/catalog.ts 里，这里只引用 id。
  usePageShortcuts([
    { id: 'create-new', run: openCreate },
    { id: 'move-item-up', run: () => moveFocusedItem(reorder, -1) },
    { id: 'move-item-down', run: () => moveFocusedItem(reorder, 1) },
  ])

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">我的科目</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            每个科目下可以建多个章节，章节里放笔记
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          + 新建科目
        </Button>
      </header>

      {/*
        最近编辑（F4.6）。位置在科目网格之上，但 h1 仍在最前面——
        这一段是「接着上次写」，不是这个页面的主体。
        没有笔记时整段不渲染：下面那个「还没有科目」的空态已经说明了一切，
        再叠一个空态只是噪声，而「加载中」占的高度还会让首屏跳一下。
      */}
      {recent && recent.length > 0 ? (
        <section className="mb-8" data-recent-notes>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
            最近编辑
          </h2>
          <ul className="space-y-0.5">
            {recent.map((item) => (
              <li key={item.note.id}>
                <Link
                  to={`/subjects/${item.subjectId}/chapters/${item.chapterId}/notes/${item.note.id}`}
                  data-recent-note={item.note.id}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: item.subjectColor }}
                    aria-hidden
                  />
                  {item.note.isPinned ? (
                    <span
                      className="shrink-0 text-xs text-amber-600 dark:text-amber-400"
                      title="已置顶"
                      aria-label="已置顶"
                    >
                      ★
                    </span>
                  ) : null}
                  <span className="truncate text-neutral-800 dark:text-neutral-200">
                    {item.note.title}
                  </span>
                  <span className="ml-auto hidden shrink-0 text-xs text-neutral-400 sm:inline dark:text-neutral-500">
                    {item.subjectName} › {item.chapterName}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
                    {formatRelative(item.note.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {reorder.error ? (
        <Notice tone="error" className="mb-4">
          排序没有保存成功：{reorder.error}
        </Notice>
      ) : null}

      {subjects === undefined ? (
        <Loading className="py-16" />
      ) : subjects.length === 0 ? (
        <EmptyState
          icon="📚"
          title="还没有科目"
          description="先建一个科目，比如「高等数学」，然后在里面建章节、写笔记。"
          action={
            <Button variant="primary" onClick={openCreate}>
              + 新建第一个科目
            </Button>
          }
        />
      ) : (
        // 拖动中禁掉文本选择：不关的话按住手柄划过卡片上的文字会把它们选中
        <ul className={cn('grid gap-3 sm:grid-cols-2', reorder.draggingId && 'select-none')}>
          {orderedSubjects.map((subject) => {
            const handle = reorder.handleProps(subject.id)
            return (
              <li
                key={subject.id}
                data-reorder-id={subject.id}
                className={cn(
                  'group relative',
                  reorder.draggingId === subject.id && 'opacity-50',
                )}
              >
                <Link
                  to={`/subjects/${subject.id}`}
                  className="block rounded-lg border border-neutral-200 p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/40"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="mt-1 size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: subject.color }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{subject.name}</div>
                      {subject.description ? (
                        <div className="mt-0.5 truncate text-sm text-neutral-500 dark:text-neutral-400">
                          {subject.description}
                        </div>
                      ) : null}
                      <div className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
                        {subject.chapterCount} 个章节 · {subject.noteCount} 篇笔记 ·
                        更新于 {formatRelative(subject.updatedAt)}
                      </div>
                    </div>
                  </div>

                  {/* 卡片上的操作按钮：阻止冒泡，避免点编辑时跳进科目详情 */}
                  <div className="mt-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                      onClick={(e) => {
                        e.preventDefault()
                        setDialog({ kind: 'form', subject })
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-red-100 hover:text-red-700 dark:text-neutral-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                      onClick={(e) => {
                        e.preventDefault()
                        void openDelete(subject)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </Link>

                {/*
                  拖拽手柄刻意放在 <Link> **外面**，当它的兄弟节点。
                  放进锚点里的话，拖完松手那一下浏览器会补发一个 click，
                  那个 click 会落到锚点上、直接导航进科目页——`preventDefault`
                  挡得住「点了一下」，挡不住「pointerup 之后补发的那一下」。
                  做成兄弟节点，这个问题从结构上就不存在。
                */}
                <button
                  type="button"
                  {...handle}
                  className={cn(
                    handle.className,
                    'absolute top-2 right-2 rounded px-1 text-xs opacity-0 transition-opacity',
                    'text-neutral-400 hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100',
                    'dark:text-neutral-500 dark:hover:text-neutral-200',
                  )}
                  title="拖动排序（也可以按 Alt+↑ / Alt+↓）"
                  aria-label={`拖动排序：${subject.name}`}
                >
                  ⠿
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* 只在打开时挂载，内部 state 就能直接从 props 初始化，
          不需要用 effect 去同步 props -> state */}
      {dialog?.kind === 'form' ? (
        <SubjectFormModal
          key={dialog.subject?.id ?? 'new'}
          subject={dialog.subject}
          suggestedColor={pickNextColor(usedColors)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title="删除科目"
        message={
          dialog?.kind === 'delete' ? (
            <>
              确定要删除
              <span className="font-medium text-neutral-900 dark:text-neutral-100">
                「{dialog.subject.name}」
              </span>
              吗？
              <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950/50 dark:text-red-300">
                {deleteCount.state === 'pending'
                  ? '正在统计将删除的内容…'
                  : deleteCount.state === 'failed'
                    ? '统计失败（不影响删除）。删除会连同它下面所有章节和笔记一起，且无法恢复。'
                    : `将同时删除 ${deleteCount.chapters} 个章节和 ${deleteCount.notes} 篇笔记（含其中的图片），且无法恢复。`}
              </div>
            </>
          ) : null
        }
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete') return
          await SubjectRepository.remove(dialog.subject.id)
          setDialog(null)
        }}
      />
    </div>
  )
}
