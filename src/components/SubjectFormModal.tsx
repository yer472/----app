import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { SUBJECT_COLORS } from '@/lib/colors'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { SubjectRepository } from '@/repository'
import type { Subject } from '@/types/models'

/**
 * 新建 / 编辑科目的对话框。
 *
 * 从 SubjectListPage 里抽出来，是因为侧栏的空状态也要用它——「还没有科目」
 * 那句话旁边得有个能立刻动手的入口。侧栏没法直接调首页的内部 state，
 * 抽出来之后两处共用同一个表单，行为不会长出第二种。
 *
 * 侧栏自己算 suggestedColor（它本来就查了科目列表）。
 */

interface SubjectFormModalProps {
  /** null 表示新建 */
  subject: Subject | null
  suggestedColor: string
  onClose: () => void
}

export function SubjectFormModal({
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
      setError(errorMessage(e))
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
            <span className="ml-1 font-normal text-neutral-400 dark:text-neutral-500">
              （可选）
            </span>
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
