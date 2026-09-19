import { db } from '@/db'
import type { BackupFile, BackupCounts, Snapshot } from '@/lib/backup/format'
import type { Attachment } from '@/types/models'

/** 导入一份备份时，数据本身的完整性问题 */
export interface IntegrityReport {
  /** 找不到所属科目的章节数 */
  orphanChapters: number
  /** 找不到所属章节的笔记数 */
  orphanNotes: number
  /** 关联的笔记不存在的图片数 */
  orphanAttachments: number
}

export const BackupRepository = {
  /**
   * 把整库读进内存。
   *
   * 这里刻意一次性读完再打包，而不是边读边写 zip：一次事务里读到的
   * 是一致性快照，不会出现「科目已经读到了、章节还没写到」这种
   * 打包到一半数据变了的中间状态。
   */
  async snapshot(): Promise<Snapshot> {
    const [subjects, chapters, notes, attachments] = await Promise.all([
      db.subjects.toArray(),
      db.chapters.toArray(),
      db.notes.toArray(),
      db.attachments.toArray(),
    ])
    return { subjects, chapters, notes, attachments }
  },

  async counts(): Promise<BackupCounts> {
    const [subjects, chapters, notes, attachments] = await Promise.all([
      db.subjects.count(),
      db.chapters.count(),
      db.notes.count(),
      db.attachments.toArray(),
    ])
    return {
      subjects,
      chapters,
      notes,
      attachments: attachments.length,
      imageBytes: attachments.reduce((sum, a) => sum + a.sizeBytes, 0),
    }
  },

  /**
   * 用一份备份完整替换现有数据。
   *
   * 注意只清空这四张数据表，**不动 settings**——主题、备份文件夹句柄
   * 这些配置不属于"数据"，清掉会让用户每次导入后都要重新授权文件夹。
   */
  async replaceAll(backup: BackupFile, attachments: Attachment[]): Promise<void> {
    await db.transaction(
      'rw',
      [db.subjects, db.chapters, db.notes, db.attachments],
      async () => {
        await Promise.all([
          db.subjects.clear(),
          db.chapters.clear(),
          db.notes.clear(),
          db.attachments.clear(),
        ])

        if (backup.subjects.length) await db.subjects.bulkAdd(backup.subjects)
        if (backup.chapters.length) await db.chapters.bulkAdd(backup.chapters)
        if (backup.notes.length) await db.notes.bulkAdd(backup.notes)
        if (attachments.length) await db.attachments.bulkAdd(attachments)
      },
    )
  },

  /** 检查一份备份的引用完整性。损坏的备份不应该被静默接受。 */
  async inspect(backup: BackupFile): Promise<IntegrityReport> {
    const subjectIds = new Set(backup.subjects.map((s) => s.id))
    const chapterIds = new Set(backup.chapters.map((c) => c.id))
    const noteIds = new Set(backup.notes.map((n) => n.id))

    return {
      orphanChapters: backup.chapters.filter((c) => !subjectIds.has(c.subjectId))
        .length,
      orphanNotes: backup.notes.filter((n) => !chapterIds.has(n.chapterId)).length,
      orphanAttachments: backup.attachments.filter((a) => !noteIds.has(a.noteId))
        .length,
    }
  },
}
