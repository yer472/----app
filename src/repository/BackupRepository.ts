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
    const [subjects, chapters, notes, attachments, symbols] = await Promise.all([
      db.subjects.toArray(),
      db.chapters.toArray(),
      db.notes.toArray(),
      db.attachments.toArray(),
      db.symbols.toArray(),
    ])
    return { subjects, chapters, notes, attachments, symbols }
  },

  async counts(): Promise<BackupCounts> {
    const [subjects, chapters, notes, attachments, symbols] = await Promise.all([
      db.subjects.count(),
      db.chapters.count(),
      db.notes.count(),
      db.attachments.toArray(),
      db.symbols.count(),
    ])
    return {
      subjects,
      chapters,
      notes,
      attachments: attachments.length,
      symbols,
      imageBytes: attachments.reduce((sum, a) => sum + a.sizeBytes, 0),
    }
  },

  /**
   * 用一份备份完整替换现有数据。
   *
   * 覆盖范围是**内容和它的派生设置之外的一切**：科目、章节、笔记、附件，
   * 以及自定义符号库。**不动 settings**——主题、备份文件夹句柄这些是配置，
   * 清掉会让用户每次导入后都要重新授权文件夹。
   *
   * 符号库归到「内容」这一边：它是用户自己画的，和笔记同性质。
   * 代价是恢复一份**旧备份**（v1 里没有 symbols）会把现有符号清空——
   * 这是覆盖式恢复的应有之义，而且 `counts.symbols` 会让设置页的确认框
   * 把它显示出来（「符号库 12 个 → 0 个」），**丢什么要让用户看见**。
   */
  async replaceAll(backup: BackupFile, attachments: Attachment[]): Promise<void> {
    await db.transaction(
      'rw',
      [db.subjects, db.chapters, db.notes, db.attachments, db.symbols],
      async () => {
        await Promise.all([
          db.subjects.clear(),
          db.chapters.clear(),
          db.notes.clear(),
          db.attachments.clear(),
          db.symbols.clear(),
        ])

        if (backup.subjects.length) await db.subjects.bulkAdd(backup.subjects)
        if (backup.chapters.length) await db.chapters.bulkAdd(backup.chapters)
        if (backup.notes.length) await db.notes.bulkAdd(backup.notes)
        if (attachments.length) await db.attachments.bulkAdd(attachments)
        if (backup.symbols?.length) await db.symbols.bulkAdd(backup.symbols)
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
