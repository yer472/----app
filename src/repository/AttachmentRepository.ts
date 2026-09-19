import { db } from '@/db'
import { newId } from '@/lib/id'
import { now } from '@/lib/time'
import type { Attachment, ID } from '@/types/models'

export const AttachmentRepository = {
  async listByNote(noteId: ID): Promise<Attachment[]> {
    const rows = await db.attachments.where('noteId').equals(noteId).toArray()
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },

  async get(id: ID): Promise<Attachment | undefined> {
    return db.attachments.get(id)
  },

  /**
   * 存一张图片。
   *
   * blob 直接进 IndexedDB，不做 base64 转换——base64 会让体积膨胀约 33%，
   * 而且几 MB 的字符串读写明显更慢。IndexedDB 原生支持 Blob。
   */
  async createImage(input: {
    noteId: ID
    blob: Blob
    width: number
    height: number
  }): Promise<Attachment> {
    const attachment: Attachment = {
      id: newId(),
      noteId: input.noteId,
      type: 'image',
      blob: input.blob,
      mimeType: input.blob.type || 'image/jpeg',
      width: input.width,
      height: input.height,
      sizeBytes: input.blob.size,
      createdAt: now(),
    }

    await db.attachments.add(attachment)
    return attachment
  },

  async remove(id: ID): Promise<void> {
    await db.attachments.delete(id)
  },

  /**
   * 清理没有被任何笔记引用的图片。
   *
   * 用户在正文里删掉一张图时，Markdown 文本里不再有 asset://<id> 引用，
   * 但附件记录还在。这里做的就是把这些"孤儿"扫出来删掉。
   * 应当在保存笔记后延迟调用，不要每次按键都跑。
   */
  async removeOrphansOfNote(noteId: ID, content: string): Promise<number> {
    const attachments = await this.listByNote(noteId)
    const orphans = attachments.filter(
      (a) => !content.includes(`asset://${a.id}`),
    )
    if (orphans.length === 0) return 0

    await db.attachments.bulkDelete(orphans.map((a) => a.id))
    return orphans.length
  },

  async totalSize(): Promise<number> {
    const all = await db.attachments.toArray()
    return all.reduce((sum, a) => sum + a.sizeBytes, 0)
  },
}

/**
 * 正文里引用的图片写法是 `![说明](asset://<附件id>)`。
 * 渲染时要用这个前缀把自定义协议替换成真实的图片地址。
 */
export const ASSET_URL_PREFIX = 'asset://'
