/**
 * 数据访问层的统一出口。
 *
 * 页面组件从这里 import，不直接使用 Dexie —— 产品文档 §7.3 第 4 条
 * 要求所有数据库操作收敛在这个目录下。将来若要加云同步，
 * 只需在这里替换实现，页面代码一行不动。
 */
export { SubjectRepository, DEFAULT_SUBJECT_COLOR } from './SubjectRepository'
export type { CreateSubjectInput } from './SubjectRepository'
export { ChapterRepository } from './ChapterRepository'
export { NoteRepository } from './NoteRepository'
export type { CreateNoteInput, NoteSearchHit } from './NoteRepository'
export { AttachmentRepository, ASSET_URL_PREFIX } from './AttachmentRepository'
export { SettingRepository, SETTING_KEYS } from './SettingRepository'
