import { db } from '@/db'
import { makeSnippet, toPlainText } from '@/lib/markdown'
import type { ID, NoteWithPath } from '@/types/models'
import { pathIndex } from './internal'

export interface SearchHit extends NoteWithPath {
  /** 关键词是在标题里命中的，还是正文里 */
  matchedIn: 'title' | 'content'
  /** 命中处周围的一段纯文本 */
  snippet: string
  /** snippet 前面是否被截断（用来决定要不要显示省略号） */
  snippetPrefix: string
  snippetSuffix: string
}

export interface SearchOptions {
  /** 只在这些科目里找。空数组表示不限。 */
  subjectIds?: ID[]
  limit?: number
}

/**
 * 全局搜索（F4.1 / F4.2 / F4.3）。
 *
 * 三张表都要用，所以单独放一个 repository，而不是塞进 NoteRepository。
 *
 * 实现是内存里的全表扫描：把每篇笔记的正文转成纯文本再找子串。
 * 之所以先转纯文本而不是直接匹配 Markdown 原文——直接匹配的话，
 * 搜「asset」会命中每一张图片，搜「##」会命中每一个标题，全是噪声。
 *
 * 性能：几百篇笔记时是几毫秒级。产品文档里定的目标是「1000 篇笔记
 * 下搜索 < 1s」，当前实现到那个量级需要给正文建一份归一化的小写
 * 文本字段并加索引。现在不提前做，是因为真正的瓶颈要等有真实数据
 * 才知道在哪——而且搜索框有防抖，不会每敲一个字都跑一遍。
 */
export const SearchRepository = {
  async search(keyword: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const needle = keyword.trim().toLowerCase()
    if (!needle) return []

    const limit = options.limit ?? 50
    const filter = options.subjectIds?.length
      ? new Set(options.subjectIds)
      : null

    const [notes, { chapterById, subjectById }] = await Promise.all([
      db.notes.toArray(),
      pathIndex(),
    ])

    const hits: SearchHit[] = []

    for (const note of notes) {
      const chapter = chapterById.get(note.chapterId)
      const subject = chapter ? subjectById.get(chapter.subjectId) : undefined
      if (!subject || !chapter) continue
      if (filter && !filter.has(subject.id)) continue

      const titleIndex = note.title.toLowerCase().indexOf(needle)

      let matchedIn: 'title' | 'content' = 'title'
      let snippet: string
      let prefix = ''
      let suffix = ''

      if (titleIndex >= 0) {
        // 标题命中时，摘要还是照常给一段正文开头，方便判断是不是要找的那篇
        const plain = toPlainText(note.content)
        snippet = plain.slice(0, 90)
        suffix = plain.length > 90 ? '…' : ''
      } else {
        const plain = toPlainText(note.content)
        const index = plain.toLowerCase().indexOf(needle)
        if (index < 0) continue
        matchedIn = 'content'
        const around = makeSnippet(plain, index, needle.length)
        snippet = around.text
        prefix = around.prefix
        suffix = around.suffix
      }

      hits.push({
        note,
        subjectId: subject.id,
        subjectName: subject.name,
        subjectColor: subject.color,
        chapterId: chapter.id,
        chapterName: chapter.name,
        matchedIn,
        snippet,
        snippetPrefix: prefix,
        snippetSuffix: suffix,
      })
    }

    // 标题命中的排在前面——用户搜一个词，多半是在找标题里带这个词的那篇
    hits.sort((a, b) => {
      if (a.matchedIn !== b.matchedIn) return a.matchedIn === 'title' ? -1 : 1
      if (a.note.isPinned !== b.note.isPinned) return a.note.isPinned ? -1 : 1
      return b.note.updatedAt.localeCompare(a.note.updatedAt)
    })

    return hits.slice(0, limit)
  },

  /** 可被搜到的笔记总数，用于「没有结果」时给出更有用的提示 */
  async searchableCount(): Promise<number> {
    const [notes, chapters] = await Promise.all([
      db.notes.toArray(),
      db.chapters.toArray(),
    ])
    const chapterIds = new Set(chapters.map((c) => c.id))
    // 只统计真的能通过界面导航到的笔记——孤儿笔记搜出来也点不进去
    return notes.filter((note) => chapterIds.has(note.chapterId)).length
  },
}

/**
 * 把一段文本按关键词切成「普通 / 命中」交替的片段。
 *
 * 搜索结果的片段只有几十个字，直接丢给 dangerouslySetInnerHTML 拼 <mark>
 * 是不行的——笔记正文里可能有任何字符。所以切成片段交给 React 渲染成节点。
 */
export function splitByKeyword(
  text: string,
  keyword: string,
): { text: string; hit: boolean }[] {
  const needle = keyword.trim()
  if (!needle) return [{ text, hit: false }]

  const lowerText = text.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  const parts: { text: string; hit: boolean }[] = []

  let cursor = 0
  for (;;) {
    const index = lowerText.indexOf(lowerNeedle, cursor)
    if (index < 0) break
    if (index > cursor) {
      parts.push({ text: text.slice(cursor, index), hit: false })
    }
    parts.push({ text: text.slice(index, index + needle.length), hit: true })
    cursor = index + needle.length
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false })
  return parts
}
