import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Loading } from '@/components/ui/Loading'
import { Notice } from '@/components/ui/Notice'
import { cn } from '@/lib/cn'
import { errorMessage, runGuarded } from '@/lib/errors'
import { usePageShortcuts } from '@/lib/shortcuts/useShortcuts'
import { formatRelative } from '@/lib/time'
import {
  ChapterRepository,
  NoteRepository,
  SubjectRepository,
} from '@/repository'
import type { Note } from '@/types/models'

export function ChapterPage() {
  const { subjectId = '', chapterId = '' } = useParams()
  const navigate = useNavigate()

  const subject = useLiveQuery(
    async () => (await SubjectRepository.get(subjectId)) ?? null,
    [subjectId],
  )
  const chapter = useLiveQuery(
    async () => (await ChapterRepository.get(chapterId)) ?? null,
    [chapterId],
  )
  const notes = useLiveQuery(
    () => NoteRepository.listByChapter(chapterId),
    [chapterId],
  )

  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Note | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const createNote = async () => {
    setCreating(true)
    setNotice(null)
    try {
      const note = await NoteRepository.create({ chapterId })
      // 直接进入新笔记开始写，不让学生在列表里再找一次
      void navigate(`/subjects/${subjectId}/chapters/${chapterId}/notes/${note.id}`)
    } catch (e) {
      // 原来是只有 finally 没有 catch：建不出来时按钮从「创建中…」变回来，
      // 界面上什么也没发生，用户只会以为没点到
      setNotice(`新建笔记失败：${errorMessage(e)}`)
    } finally {
      setCreating(false)
    }
  }

  // Alt+N 新建笔记。要认按钮那个防重入标记——连按两下 Alt+N
  // 会建出两篇空笔记，而且第二篇会把第一篇挤在那儿没人管。
  usePageShortcuts([
    {
      id: 'create-new',
      run: () => {
        if (creating) return
        void createNote()
      },
    },
  ])

  if (chapter === undefined || subject === undefined) {
    return <Loading className="px-8 py-16" />
  }

  // 科目没了但章节还在（理论上级联删除会一起清掉，这里兜的是数据被外部改过）。
  // 原来只判了 undefined 不判 null，于是面包屑会悄悄变成「科目」两个字，
  // 而 SubjectPage 和 NotePage 对同一种情况都是有提示的
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

  if (chapter === null) {
    return (
      <div className="mx-auto max-w-4xl px-8 py-8">
        <EmptyState
          title="章节不存在"
          description="它可能已经被删除了。"
          action={
            <Link to={`/subjects/${subjectId}`}>
              <Button variant="secondary">返回章节列表</Button>
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
        <Link
          to={`/subjects/${subjectId}`}
          className="hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          {subject.name}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-neutral-900 dark:text-neutral-100">
          {chapter.name}
        </span>
      </nav>

      <header className="mb-6 flex items-center justify-between gap-4">
        <h1 className="truncate text-xl font-semibold">{chapter.name}</h1>
        <Button
          variant="primary"
          onClick={createNote}
          disabled={creating}
          className="shrink-0"
        >
          {creating ? '创建中…' : '+ 新建笔记'}
        </Button>
      </header>

      {notice ? (
        <Notice tone="error" className="mb-4">
          {notice}
        </Notice>
      ) : null}

      {notes === undefined ? (
        <Loading className="py-16" />
      ) : notes.length === 0 ? (
        <EmptyState
          icon="📝"
          title="这个章节还没有笔记"
          description="点上面的「新建笔记」开始记录。文字直接敲，课件截图用 Ctrl+V 粘贴进来就行。"
          action={
            <Button variant="primary" onClick={createNote} disabled={creating}>
              + 新建第一篇笔记
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {notes.map((note) => (
            <li key={note.id} className="group relative">
              <Link
                to={`/subjects/${subjectId}/chapters/${chapterId}/notes/${note.id}`}
                className="block rounded-lg border border-neutral-200 px-4 py-3 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/40"
              >
                <div className="flex items-center gap-2 pr-16">
                  {note.isPinned ? <span aria-label="已置顶">📌</span> : null}
                  <span className="truncate text-sm font-medium">
                    {note.title}
                  </span>
                </div>
                {note.excerpt ? (
                  <p className="mt-1 line-clamp-2 text-sm text-neutral-500 dark:text-neutral-400">
                    {note.excerpt}
                  </p>
                ) : null}
                <div className="mt-1.5 text-xs text-neutral-400 dark:text-neutral-500">
                  更新于 {formatRelative(note.updatedAt)}
                </div>
              </Link>

              <div
                className={cn(
                  'absolute top-3 right-3 flex gap-1 opacity-0 transition-opacity',
                  'group-hover:opacity-100 focus-within:opacity-100',
                )}
              >
                <button
                  type="button"
                  aria-label={note.isPinned ? '取消置顶' : '置顶'}
                  className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                  onClick={(e) => {
                    e.preventDefault()
                    // 原来是 void + 无 catch：失败时点一下没有任何反应，
                    // 用户只会以为按钮坏了
                    runGuarded(NoteRepository.togglePin(note.id), (message) =>
                      setNotice(
                        `${note.isPinned ? '取消置顶' : '置顶'}失败：${message}`,
                      ),
                    )
                  }}
                >
                  {note.isPinned ? '取消置顶' : '置顶'}
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-red-100 hover:text-red-700 dark:text-neutral-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                  onClick={(e) => {
                    e.preventDefault()
                    setDeleting(note)
                  }}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="删除笔记"
        message={
          <>
            确定要删除
            <span className="font-medium text-neutral-900 dark:text-neutral-100">
              「{deleting?.title}」
            </span>
            吗？
            <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950/50 dark:text-red-300">
              笔记正文和里面的图片都会被删除，且无法恢复。
            </div>
          </>
        }
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          await NoteRepository.remove(deleting.id)
          setDeleting(null)
        }}
      />
    </div>
  )
}
