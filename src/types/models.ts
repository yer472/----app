/**
 * 领域模型定义。
 *
 * 对应产品文档 XXBJ.md 的 §4「核心数据模型」。
 * 这里的类型既是 IndexedDB 的表结构，也是 UI 层使用的数据形状。
 */

export type ID = string
export type ISODateTime = string

/** 科目：最顶层容器，如「高等数学」 */
export interface Subject {
  id: ID
  name: string
  /** 十六进制色值，如 '#3b82f6'，用于列表中的视觉区分 */
  color: string
  /** 可选描述 */
  description?: string
  /** 排序位，越小越靠前 */
  order: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

/** 章节：科目下的分组，如「第三章 微分中值定理」 */
export interface Chapter {
  id: ID
  subjectId: ID
  name: string
  order: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

/**
 * 正文的存储格式。
 *
 * 决策 D5 已确定使用 Markdown：编辑时由 Milkdown 即时渲染，
 * 但落库的必须是 Markdown 原文，不能存编辑器的内部文档结构。
 * 保留这个字段是为了将来若真要引入富文本时有迁移余地。
 */
export type ContentFormat = 'markdown' | 'richtext_json'

/** 笔记：实际的内容载体 */
export interface Note {
  id: ID
  chapterId: ID
  title: string
  /** 正文。默认是 Markdown 原文 */
  content: string
  contentFormat: ContentFormat
  /**
   * 纯文本摘要（正文去掉标记后的前若干字）。
   *
   * 列表页和搜索结果只读这个字段，避免为了显示一行预览
   * 而把几千篇笔记的全文都加载进内存。
   */
  excerpt: string
  isPinned: boolean
  tags: string[]
  createdAt: ISODateTime
  updatedAt: ISODateTime
}

/** 附件：目前只有图片，正文里通过 asset://<id> 引用 */
export interface Attachment {
  id: ID
  noteId: ID
  type: 'image'
  /** 图片二进制数据。存 Blob 而不是 base64，避免体积膨胀 33% */
  blob: Blob
  mimeType: string
  width: number
  height: number
  sizeBytes: number
  createdAt: ISODateTime
}

/** 设置项：简单的 key-value 存储 */
export interface Setting {
  key: string
  value: unknown
}

/** 科目带上统计信息，用于列表页展示 */
export interface SubjectWithStats extends Subject {
  chapterCount: number
  noteCount: number
}

/** 章节带上统计信息 */
export interface ChapterWithStats extends Chapter {
  noteCount: number
}
