import { db } from '@/db'
import { newId } from '@/lib/id'
import { deriveTitle, toExcerpt } from '@/lib/markdown'
import { now } from '@/lib/time'
import type { ID, Note } from '@/types/models'

export interface CreateNoteInput {
  chapterId: ID
  title?: string
  content?: string
}

export interface NoteSearchHit {
  note: Note
  /** 命中的字段，用于搜索结果里展示"为什么它被匹配到" */
  matchedIn: 'title' | 'content'
}

export const NoteRepository = {
  /** 章节下的笔记，置顶的在前，其余按更新时间倒序 */
  async listByChapter(chapterId: ID): Promise<Note[]> {
    const rows = await db.notes.where('chapterId').equals(chapterId).toArray()
    return rows.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
  },

  /** 全局「最近编辑」，用于首页快速回到刚才在写的东西 */
  async listRecent(limit = 20): Promise<Note[]> {
    const rows = await db.notes.orderBy('updatedAt').reverse().limit(limit).toArray()
    return rows
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

  async togglePin(id: ID): Promise<void> {
    const note = await db.notes.get(id)
    if (!note) return
    await db.notes.update(id, { isPinned: !note.isPinned, updatedAt: now() })
  },

  async remove(id: ID): Promise<void> {
    await db.transaction('rw', [db.notes, db.attachments], async () => {
      await db.attachments.where('noteId').equals(id).delete()
      await db.notes.delete(id)
    })
  },

  /**
   * 全局搜索（F4.1）。
   *
   * 目前是内存里的全表扫描。笔记规模在几百篇时完全够用；
   * 等到接近产品文档里说的「1000 篇 / 1 秒」这个量级，
   * 需要改成给正文建一份归一化的小写文本字段并加索引。
   * 现在不提前优化，是因为真正的瓶颈要等有真实数据才知道在哪。
   */
  async search(keyword: string, limit = 50): Promise<NoteSearchHit[]> {
    const needle = keyword.trim().toLowerCase()
    if (!needle) return []

    const all = await db.notes.toArray()
    const hits: NoteSearchHit[] = []

    for (const note of all) {
      if (note.title.toLowerCase().includes(needle)) {
        hits.push({ note, matchedIn: 'title' })
      } else if (note.content.toLowerCase().includes(needle)) {
        hits.push({ note, matchedIn: 'content' })
      }
      if (hits.length >= limit) break
    }

    return hits.sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt))
  },

  async totalCount(): Promise<number> {
    return db.notes.count()
  },
}
