import Dexie, { type Table } from 'dexie'
import type {
  Attachment,
  Chapter,
  Note,
  Setting,
  Subject,
} from '@/types/models'

/**
 * IndexedDB 数据库实例。
 *
 * schema 字符串的规则（Dexie 语法）：
 *   '主键, 索引1, 索引2, *多值索引'
 * 只有声明为索引的字段才能用 where() 查询，其余字段仍会完整保存，
 * 只是不能直接查——所以这里只给确实要筛选/排序的字段建索引。
 */
export class XxbjDatabase extends Dexie {
  subjects!: Table<Subject, string>
  chapters!: Table<Chapter, string>
  notes!: Table<Note, string>
  attachments!: Table<Attachment, string>
  settings!: Table<Setting, string>

  constructor() {
    super('xxbj')

    this.version(1).stores({
      subjects: 'id, order, name, updatedAt',
      chapters: 'id, subjectId, order, updatedAt',
      // *tags 是多值索引，让一个数组字段里的每个标签都能被单独查到
      notes: 'id, chapterId, isPinned, updatedAt, createdAt, *tags',
      attachments: 'id, noteId, createdAt',
      settings: 'key',
    })
  }
}

export const db = new XxbjDatabase()

/**
 * 请求浏览器的持久化存储权限。
 *
 * 这是产品文档 §7.4 数据安全三层防护的第 1 层：
 * 告诉浏览器「这是重要数据，自动清理时请跳过」。
 * 浏览器可能直接拒绝（比如用户没怎么用过这个站点），
 * 所以返回值只用于提示，不能当作保障——真正的保障是自动备份和手动导出。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** 已用存储空间，用于设置页展示 */
export async function getStorageUsage(): Promise<{
  usage: number
  quota: number
} | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota }
  } catch {
    return null
  }
}
