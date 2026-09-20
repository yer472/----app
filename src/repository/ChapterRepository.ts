import { db } from '@/db'
import { newId } from '@/lib/id'
import { now } from '@/lib/time'
import type { Chapter, ChapterWithStats, ID } from '@/types/models'
import { deleteChaptersCascade, nextOrder } from './internal'

export const ChapterRepository = {
  /** 某个科目下的章节，按 order 排 */
  async listBySubject(subjectId: ID): Promise<Chapter[]> {
    const rows = await db.chapters.where('subjectId').equals(subjectId).toArray()
    return rows.sort(
      (a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh'),
    )
  },

  /** 章节页用：带上笔记数 */
  async listBySubjectWithStats(subjectId: ID): Promise<ChapterWithStats[]> {
    const chapters = await this.listBySubject(subjectId)
    if (chapters.length === 0) return []

    const notes = await db.notes
      .where('chapterId')
      .anyOf(chapters.map((c) => c.id))
      .toArray()

    const countByChapter = new Map<ID, number>()
    for (const note of notes) {
      countByChapter.set(
        note.chapterId,
        (countByChapter.get(note.chapterId) ?? 0) + 1,
      )
    }

    return chapters.map((chapter) => ({
      ...chapter,
      noteCount: countByChapter.get(chapter.id) ?? 0,
    }))
  },

  async get(id: ID): Promise<Chapter | undefined> {
    return db.chapters.get(id)
  },

  async create(input: { subjectId: ID; name: string }): Promise<Chapter> {
    const name = input.name.trim()
    if (!name) throw new Error('章节名不能为空')

    const siblings = await this.listBySubject(input.subjectId)
    const timestamp = now()

    const chapter: Chapter = {
      id: newId(),
      subjectId: input.subjectId,
      name,
      order: nextOrder(siblings.map((c) => c.order)),
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    await db.chapters.add(chapter)
    return chapter
  },

  async rename(id: ID, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('章节名不能为空')
    await db.chapters.update(id, { name: trimmed, updatedAt: now() })
  },

  /** 删除章节，连带其下所有笔记和图片 */
  async remove(id: ID): Promise<void> {
    await db.transaction(
      'rw',
      [db.chapters, db.notes, db.attachments],
      async () => {
        await deleteChaptersCascade([id])
      },
    )
  },

  /** 按传入的 ID 顺序重排（拖拽排序用）。只写真的挪了位的那几行，理由同 SubjectRepository */
  async reorder(orderedIds: ID[]): Promise<void> {
    const timestamp = now()
    await db.transaction('rw', db.chapters, async () => {
      const rows = await db.chapters.bulkGet(orderedIds)
      const orderById = new Map(rows.map((row) => [row?.id, row?.order]))

      await Promise.all(
        orderedIds
          .map((id, index) => ({ id, index }))
          .filter(({ id, index }) => orderById.get(id) !== index)
          .map(({ id, index }) =>
            db.chapters.update(id, { order: index, updatedAt: timestamp }),
          ),
      )
    })
  },

  async countNotes(id: ID): Promise<number> {
    return db.notes.where('chapterId').equals(id).count()
  },
}
