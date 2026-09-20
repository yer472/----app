/**
 * 领域模型定义。
 *
 * 对应产品文档 XXBJ.md 的 §4「核心数据模型」。
 * 这里的类型既是 IndexedDB 的表结构，也是 UI 层使用的数据形状。
 */

import type { Point, Shape } from './scene'

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

/**
 * 附件的种类。
 *
 * `drawing` 是画板存出来的 SVG：可见的图元负责显示，场景数据内嵌在
 * `<metadata>` 里负责「下次还能接着改」。它和普通图片走完全同一条管线——
 * 正文里的引用、孤儿清理、三种备份都不区分种类。
 */
export type AttachmentType = 'image' | 'drawing'

/** 附件：正文里通过 asset://<id> 引用 */
export interface Attachment {
  id: ID
  noteId: ID
  /** 不是 Dexie 索引，所以放宽取值不需要升级数据库版本 */
  type: AttachmentType
  /** 二进制数据。存 Blob 而不是 base64，避免体积膨胀 33% */
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

/**
 * 自定义符号：自己画的机构符号。
 *
 * 这是**用户创作的内容**，所以它是一张正经的表、也进备份——不能图省事塞进
 * `settings` 里（那张表不进备份，恢复一次就没了）。
 *
 * 只允许「点符号」这一种形态：定尺寸、可旋转、点一下放置。两点符号
 * （构件、带传动那类长度可拉的）的几何是代码里的生成器，不是数据，
 * 所以不在自定义范围内——要不同尺寸就存两个自定义符号。
 *
 * `shapes` 存的是**符号编辑画布里的普通图元**（只允许 line / rect / ellipse /
 * pencil），不是渲染用的零件表：编辑已有符号时要把定义还原成可编辑的图元，
 * 而 `shapes` 本身就是存储形态，还原是恒等的。渲染用的 `parts` 由
 * `defOfCustomSymbol` 推出来，不各存一份，就不会出现「库里的和图上画的不一样」。
 */
export interface CustomSymbol {
  id: ID
  name: string
  /** 局部坐标。插入点也是局部坐标里的一个点，一般就是 (0,0) */
  shapes: Shape[]
  origin: Point
  /** 编辑画布的尺寸，用于还原出一样大的画框 */
  width: number
  height: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
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
