import { db } from '@/db'
import { newId } from '@/lib/id'
import { deriveTitle, toExcerpt } from '@/lib/markdown'
import { now } from '@/lib/time'
import type { ID, Note, NoteWithPath } from '@/types/models'
import { pathIndex } from './internal'

export interface CreateNoteInput {
  chapterId: ID
  title?: string
  content?: string
}

/**
 * 首页「最近编辑」显示几条。
 *
 * 定义在这里而不是调用点：首页要 6 条、仓库默认 20 条的话，
 * 这种「两处各写一个数」的漂移迟早会变成「改了一处以为改完了」。
 */
export const RECENT_LIMIT = 6

export const NoteRepository = {
  /** 章节下的笔记，置顶的在前，其余按更新时间倒序 */
  async listByChapter(chapterId: ID): Promise<Note[]> {
    const rows = await db.notes.where('chapterId').equals(chapterId).toArray()
    return rows.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
  },

  /**
   * 全局「最近编辑」，用于首页快速回到刚才在写的东西（F4.6）。
   *
   * 按 `updatedAt` 倒序——走的是 v1 就建好的索引，不是全表读进内存再排。
   *
   * 返回的是**带上科目/章节路径**的形状：首页要显示「科目 › 章节」，
   * 只有笔记本身画不出这一行。join 放在这里而不是页面里，是因为
   * 「页面组件不直接用 Dexie」是这个项目的分层约定。
   *
   * 置顶的**不排除**：这一段回答的是「我刚才在写什么」，而最常用的笔记
   * 恰恰最可能被置顶。排除掉会让它在最需要的时候少一条。
   */
  async listRecent(limit = RECENT_LIMIT): Promise<NoteWithPath[]> {
    const [rows, { chapterById, subjectById }] = await Promise.all([
      db.notes.orderBy('updatedAt').reverse().limit(limit).toArray(),
      pathIndex(),
    ])

    const result: NoteWithPath[] = []
    for (const note of rows) {
      const chapter = chapterById.get(note.chapterId)
      const subject = chapter ? subjectById.get(chapter.subjectId) : undefined
      // 笔记的父级不见了（理论上不该发生，级联删除会一起清掉）时跳过它，
      // 而不是渲染一条点进去什么也没有的行
      if (!chapter || !subject) continue

      result.push({
        note,
        chapterId: chapter.id,
        chapterName: chapter.name,
        subjectId: subject.id,
        subjectName: subject.name,
        subjectColor: subject.color,
      })
    }
    return result
  },

  async get(id: ID): Promise<Note | undefined> {
    return db.notes.get(id)
  },

  async countByChapter(chapterId: ID): Promise<number> {
    return db.notes.where('chapterId').equals(chapterId).count()
  },

  async create(input: CreateNoteInput): Promise<Note> {
    const content = input.content ?? ''
    const timestamp = now()
    const fallbackTitle = `未命名笔记 ${timestamp.slice(0, 10)}`

    const note: Note = {
      id: newId(),
      chapterId: input.chapterId,
      title: input.title?.trim() || deriveTitle(content, fallbackTitle),
      content,
      contentFormat: 'markdown',
      excerpt: toExcerpt(content),
      isPinned: false,
      tags: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    await db.notes.add(note)
    return note
  },

  /**
   * 保存正文。自动保存调用的是这个方法。
   *
   * 每次都会重算 excerpt —— 摘要必须跟着正文走，否则列表页预览
   * 会一直停在旧内容上。这个计算很便宜（纯字符串处理）。
   */
  async saveContent(id: ID, content: string): Promise<void> {
    await db.notes.update(id, {
      content,
      excerpt: toExcerpt(content),
      updatedAt: now(),
    })
  },

  async rename(id: ID, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) throw new Error('标题不能为空')
    await db.notes.update(id, { title: trimmed, updatedAt: now() })
  },

  /**
   * 置顶 / 取消置顶。
   *
   * **不写 `updatedAt`**：置顶是元数据，不是编辑。写了的话，翻出一篇三个月前
   * 的笔记点一下置顶，它就会跳到首页「最近编辑」的第一条——而那一栏要回答的
   * 是「我刚才在写什么」，不是「我最近碰过什么」。
   * 章节列表里的「更新于」也会跟着变成「刚刚」，同样不是用户干的编辑。
   *
   * 排序不受影响：`listByChapter` 显式按 isPinned 分组再按 updatedAt 排，
   * 不靠这个时间戳；置顶状态一变，liveQuery 自己会重排。
   *
   * 备份也不受影响：内容指纹里 `isPinned` 是单独一项
   * （`backup/format.ts` 的 `N|` 行），正文另有 `B|` 行单独哈希。
   *
   * ⚠️ 反过来别顺手去删别处对 updatedAt 的写入。它是「这篇笔记变过」
   * 的信号，删了会让列表的「更新于」永远停在创建时间。
   */
  async togglePin(id: ID): Promise<void> {
    const note = await db.notes.get(id)
    if (!note) return
    await db.notes.update(id, { isPinned: !note.isPinned })
  },

  async remove(id: ID): Promise<void> {
    await db.transaction('rw', [db.notes, db.attachments], async () => {
      await db.attachments.where('noteId').equals(id).delete()
      await db.notes.delete(id)
    })
  },

  async totalCount(): Promise<number> {
    return db.notes.count()
  },
}
