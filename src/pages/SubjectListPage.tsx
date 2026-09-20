import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import { pickNextColor, SUBJECT_COLORS } from '@/lib/colors'
import { cn } from '@/lib/cn'
import { usePageShortcuts } from '@/lib/shortcuts/useShortcuts'
import { formatRelative } from '@/lib/time'
import { SubjectRepository } from '@/repository'
import type { Subject, SubjectWithStats } from '@/types/models'

type Dialog =
  | { kind: 'form'; subject: Subject | null }
  | { kind: 'delete'; subject: SubjectWithStats }
  | null

export function SubjectListPage() {
  const subjects = useLiveQuery(() => SubjectRepository.listWithStats(), [])
  const [dialog, setDialog] = useState<Dialog>(null)
  const [deleteInfo, setDeleteInfo] = useState<{
    chapters: number
    notes: number
  } | null>(null)

  const openDelete = async (subject: SubjectWithStats) => {
    setDialog({ kind: 'delete', subject })
    setDeleteInfo(null)
    const info = await SubjectRepository.countDescendants(subject.id)
    setDeleteInfo(info)
  }

  const usedColors = (subjects ?? []).map((s) => s.color)

  // Alt+N 新建科目。和点按钮走同一条路，所以行为不会有第二种。
  // 组合键在 lib/shortcuts/catalog.ts 里，这里只引用 id。
  usePageShortcuts([
    { id: 'create-new', run: () => setDialog({ kind: 'form', subject: null }) },
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
        <Button
          variant="primary"
          onClick={() => setDialog({ kind: 'form', subject: null })}
        >
          + 新建科目
        </Button>
      </header>

      {subjects === undefined ? (
        <div className="py-16 text-center text-sm text-neutral-400">
          加载中…
        </div>
      ) : subjects.length === 0 ? (
        <EmptyState
          icon="📚"
          title="还没有科目"
          description="先建一个科目，比如「高等数学」，然后在里面建章节、写笔记。"
          action={
            <Button
              variant="primary"
              onClick={() => setDialog({ kind: 'form', subject: null })}
            >
              + 新建第一个科目
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {subjects.map((subject) => (
            <li key={subject.id}>
              <Link
                to={`/subjects/${subject.id}`}
                className="group block rounded-lg border border-neutral-200 p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/40"
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
            </li>
          ))}
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
                {deleteInfo === null
                  ? '正在统计将删除的内容…'
                  : `将同时删除 ${deleteInfo.chapters} 个章节和 ${deleteInfo.notes} 篇笔记（含其中的图片），且无法恢复。`}
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

interface SubjectFormModalProps {
  /** null 表示新建 */
  subject: Subject | null
  suggestedColor: string
  onClose: () => void
}

function SubjectFormModal({
  subject,
  suggestedColor,
  onClose,
}: SubjectFormModalProps) {
  const [name, setName] = useState(subject?.name ?? '')
  const [color, setColor] = useState(subject?.color ?? suggestedColor)
  const [description, setDescription] = useState(subject?.description ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) {
      setError('科目名不能为空')
      return
    }
    setSaving(true)
    try {
      if (subject) {
        await SubjectRepository.update(subject.id, { name, color, description })
      } else {
        await SubjectRepository.create({ name, color, description })
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={subject ? '编辑科目' : '新建科目'}
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
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div>
          <label className="mb-1.5 block text-sm font-medium">科目名</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (error) setError('')
            }}
            placeholder="例如：高等数学"
            className={cn(
              'w-full rounded-md border bg-white px-3 py-2 text-sm outline-none dark:bg-neutral-800',
              'focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20',
              error
                ? 'border-red-400'
                : 'border-neutral-300 dark:border-neutral-700',
            )}
          />
          {error ? (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">颜色</label>
          <div className="flex gap-2">
            {SUBJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`选择颜色 ${c}`}
                onClick={() => setColor(c)}
                className={cn(
                  'size-7 rounded-full transition-transform',
                  c === color
                    ? 'ring-2 ring-neutral-900 ring-offset-2 dark:ring-neutral-100 dark:ring-offset-neutral-900'
                    : 'hover:scale-110',
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">
            描述
            <span className="ml-1 font-normal text-neutral-400">（可选）</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="例如：教材 同济第七版"
            className="w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-800"
          />
        </div>
      </form>
    </Modal>
  )
}
