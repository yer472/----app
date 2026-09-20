import { db } from '@/db'
import { newId } from '@/lib/id'
import { now } from '@/lib/time'
import type { ID, Subject, SubjectWithStats } from '@/types/models'
import { deleteChaptersCascade, nextOrder } from './internal'

export interface CreateSubjectInput {
  name: string
  color?: string
  description?: string
}

export const DEFAULT_SUBJECT_COLOR = '#3b82f6'

/**
 * 科目数据访问。
 *
 * 页面组件只调这里的方法，不直接使用 Dexie —— 这样将来若要把存储
 * 换成别的东西（比如加云同步），只需要新增一个实现，页面代码不动。
 */
export const SubjectRepository = {
  async list(): Promise<Subject[]> {
    const rows = await db.subjects.toArray()
    return rows.sort(
      (a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh'),
    )
  },

  /** 列表页用：带上章节数和笔记数，省得逐个科目再查一次 */
  async listWithStats(): Promise<SubjectWithStats[]> {
    const subjects = await this.list()
    if (subjects.length === 0) return []

    const chapters = await db.chapters.toArray()
    const notes = await db.notes.toArray()

    const chapterCountBySubject = new Map<ID, number>()
    const subjectIdByChapter = new Map<ID, ID>()
    for (const chapter of chapters) {
      chapterCountBySubject.set(
        chapter.subjectId,
        (chapterCountBySubject.get(chapter.subjectId) ?? 0) + 1,
      )
      subjectIdByChapter.set(chapter.id, chapter.subjectId)
    }

    const noteCountBySubject = new Map<ID, number>()
    for (const note of notes) {
      const subjectId = subjectIdByChapter.get(note.chapterId)
      if (!subjectId) continue
      noteCountBySubject.set(
        subjectId,
        (noteCountBySubject.get(subjectId) ?? 0) + 1,
      )
    }

    return subjects.map((subject) => ({
      ...subject,
      chapterCount: chapterCountBySubject.get(subject.id) ?? 0,
      noteCount: noteCountBySubject.get(subject.id) ?? 0,
    }))
  },

  async get(id: ID): Promise<Subject | undefined> {
    return db.subjects.get(id)
  },

  async create(input: CreateSubjectInput): Promise<Subject> {
    const name = input.name.trim()
    if (!name) throw new Error('科目名不能为空')

    const timestamp = now()
    const subject: Subject = {
      id: newId(),
      name,
      color: input.color ?? DEFAULT_SUBJECT_COLOR,
      description: input.description?.trim() || undefined,
      order: nextOrder((await db.subjects.toArray()).map((s) => s.order)),
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    await db.subjects.add(subject)
    return subject
  },

  async update(
    id: ID,
    patch: Partial<Pick<Subject, 'name' | 'color' | 'description'>>,
  ): Promise<void> {
    const changes: Partial<Subject> = { updatedAt: now() }
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new Error('科目名不能为空')
      changes.name = name
    }
    if (patch.color !== undefined) changes.color = patch.color
    if (patch.description !== undefined) {
      changes.description = patch.description.trim() || undefined
    }

    await db.subjects.update(id, changes)
  },

  /** 删除科目，连带其下所有章节、笔记和图片 */
  async remove(id: ID): Promise<void> {
    await db.transaction(
      'rw',
      [db.subjects, db.chapters, db.notes, db.attachments],
      async () => {
        const chapterIds = (await db.chapters
          .where('subjectId')
          .equals(id)
          .primaryKeys()) as ID[]
        await deleteChaptersCascade(chapterIds)
        await db.subjects.delete(id)
      },
    )
  },

  /**
   * 按传入的 ID 顺序重排（拖拽排序用）。
   *
   * **只写真的挪了位的那几行。** 原来是无条件给所有 id 盖同一个时间戳，
   * 后果是拖一项就让整页卡片的「更新于」全变成「刚刚」——用户的第一反应
   * 是数据坏了。order 本身在备份指纹里（`backup/format.ts` 的 `S|` 行），
   * 所以只改变化的那几行不会让备份漏掉这次改动。
   */
  async reorder(orderedIds: ID[]): Promise<void> {
    const timestamp = now()
    await db.transaction('rw', db.subjects, async () => {
      const rows = await db.subjects.bulkGet(orderedIds)
      const orderById = new Map(rows.map((row) => [row?.id, row?.order]))

      await Promise.all(
        orderedIds
          .map((id, index) => ({ id, index }))
          .filter(({ id, index }) => orderById.get(id) !== index)
          .map(({ id, index }) =>
            db.subjects.update(id, { order: index, updatedAt: timestamp }),
          ),
      )
    })
  },

  /** 删除前确认弹窗用：告诉用户会连带删掉多少东西 */
  async countDescendants(
    id: ID,
  ): Promise<{ chapters: number; notes: number }> {
    const chapterIds = (await db.chapters
      .where('subjectId')
      .equals(id)
      .primaryKeys()) as ID[]
    if (chapterIds.length === 0) return { chapters: 0, notes: 0 }

    const notes = await db.notes.where('chapterId').anyOf(chapterIds).count()
    return { chapters: chapterIds.length, notes }
  },
}
