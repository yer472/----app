import { db } from '@/db'
import { newId } from '@/lib/id'
import { now } from '@/lib/time'
import type { Attachment, AttachmentType, ID } from '@/types/models'

/** 和 createImage / createDrawing 共用的写入逻辑 */
async function insert(input: {
  noteId: ID
  type: AttachmentType
  blob: Blob
  width: number
  height: number
}): Promise<Attachment> {
  const attachment: Attachment = {
    id: newId(),
    noteId: input.noteId,
    type: input.type,
    blob: input.blob,
    // blob.type 一般都有（Blob 构造时给了）；万一为空，兜底值要跟着类型走，
    // 否则画板导出的图会被当成 jpeg，备份时的扩展名就错了
    mimeType:
      input.blob.type ||
      (input.type === 'drawing' ? 'image/svg+xml' : 'image/jpeg'),
    width: input.width,
    height: input.height,
    sizeBytes: input.blob.size,
    createdAt: now(),
  }

  await db.attachments.add(attachment)
  return attachment
}

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
    return insert({ ...input, type: 'image' })
  },

  /**
   * 存一张画板导出的图。
   *
   * 和 createImage 共用一张表、同一套 asset:// 引用；区别只有 type，
   * 「图形」面板靠它把画板产出的图和粘贴的截图分开列出来。
   */
  async createDrawing(input: {
    noteId: ID
    blob: Blob
    width: number
    height: number
  }): Promise<Attachment> {
    return insert({ ...input, type: 'drawing' })
  },

  /**
   * 覆盖一个已有附件的内容。
   *
   * 覆盖而不是新建，是为了让正文里的 `asset://<id>` 保持不变——
   * 新建一条再改正文，意味着要去动编辑器文档，还得处理「旧的那条
   * 什么时候变成孤儿」。
   *
   * ⚠️ 调用方必须在之后调用 `refreshAssetImages`。asset.ts 按附件 id
   * 缓存了 blob URL，不刷新的话正文里显示的仍然是旧内容。
   */
  async replace(
    id: ID,
    input: { blob: Blob; width: number; height: number },
  ): Promise<void> {
    const existing = await db.attachments.get(id)
    if (!existing) return

    await db.attachments.update(id, {
      blob: input.blob,
      // 保留原来的 mimeType 作为兜底：blob.type 为空时不能瞎猜，
      // 猜错会让备份时的文件扩展名不对
      mimeType: input.blob.type || existing.mimeType,
      width: input.width,
      height: input.height,
      sizeBytes: input.blob.size,
    })
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
