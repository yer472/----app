import { db } from '@/db'
import type { Chapter, ID, Subject } from '@/types/models'

/**
 * 级联删除的公共实现，仅供各 Repository 内部使用。
 *
 * 放在一个事务里做，保证要么全删干净、要么一个都不动——
 * 中途失败留下「孤儿章节」会让列表页显示出一堆空目录。
 */

/** 删掉若干章节，连同其下的笔记与图片附件 */
export async function deleteChaptersCascade(chapterIds: ID[]): Promise<void> {
  if (chapterIds.length === 0) return

  const noteIds = (await db.notes
    .where('chapterId')
    .anyOf(chapterIds)
    .primaryKeys()) as ID[]

  if (noteIds.length > 0) {
    await db.attachments.where('noteId').anyOf(noteIds).delete()
    await db.notes.where('chapterId').anyOf(chapterIds).delete()
  }
  await db.chapters.bulkDelete(chapterIds)
}

/** 计算某个集合里下一个可用的 order 值 */
export function nextOrder(orders: number[]): number {
  return orders.length === 0 ? 0 : Math.max(...orders) + 1
}

/**
 * 科目和章节的 id → 记录索引。
 *
 * 笔记只存 `chapterId`，凡是要显示「科目 › 章节」的地方都得回查这两张表
 * （搜索、首页的最近编辑）。表和笔记比起来很小，一次读全、在内存里映射
 * 比逐条回查划算，也不会出现两边显示的路径不一致。
 */
export async function pathIndex(): Promise<{
  chapterById: Map<ID, Chapter>
  subjectById: Map<ID, Subject>
}> {
  const [chapters, subjects] = await Promise.all([
    db.chapters.toArray(),
    db.subjects.toArray(),
  ])
  return {
    chapterById: new Map(chapters.map((c) => [c.id, c])),
    subjectById: new Map(subjects.map((s) => [s.id, s])),
  }
}
