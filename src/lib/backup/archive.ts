/**
 * 备份包（zip）的组装与解析。
 *
 * 组装和解析都放在这里，是因为它们必须严格对称——
 * 导出时多写一个字段、导入时少读一个字段，用户丢的就是几年的笔记。
 * 放在同一个文件里，改动时不容易漏掉另一半。
 */
import { now } from '@/lib/time'
import { bytesEntry, createZip, readZip, readZipText, textEntry, type ZipEntry, type ZipProgress } from '@/lib/zip'
import type { Attachment, ISODateTime } from '@/types/models'
import {
  buildBackupFile,
  buildNoteDocuments,
  buildReadme,
  countSnapshot,
  DATA_FILE,
  imagePathFor,
  parseBackupFile,
  README_FILE,
  serializeBackupFile,
  type BackupCounts,
  type BackupFile,
  type NoteDocument,
  type Snapshot,
} from './format'

export interface BuiltArchive {
  blob: Blob
  backup: BackupFile
  counts: BackupCounts
  noteDocuments: NoteDocument[]
}

/** 把整库数据打成一个 zip。手动导出和每日快照都用它，保证两边格式一致。 */
export async function buildArchive(
  snapshot: Snapshot,
  at: ISODateTime = now(),
  onProgress?: (progress: ZipProgress) => void,
): Promise<BuiltArchive> {
  const backup = buildBackupFile(snapshot, at)
  const { documents } = buildNoteDocuments(snapshot)

  const entries: ZipEntry[] = [
    textEntry(DATA_FILE, serializeBackupFile(backup)),
    textEntry(README_FILE, buildReadme(backup.counts, at)),
  ]

  for (const document of documents) {
    entries.push(textEntry(document.path, document.text))
  }

  for (const attachment of snapshot.attachments) {
    entries.push(
      bytesEntry(
        imagePathFor(attachment),
        new Uint8Array(await attachment.blob.arrayBuffer()),
        0,
      ),
    )
  }

  const blob = await createZip(entries, onProgress)
  return { blob, backup, counts: backup.counts, noteDocuments: documents }
}

export interface ParsedArchive {
  backup: BackupFile
  /** 还原出来的图片。没找到图片本体的附件不在里面。 */
  attachments: Attachment[]
  /** 数据里记了、但包里没有的图片路径 */
  missingImages: string[]
  /** 这份备份里压根没有图片数据（比如直接选的 data.json） */
  hasNoImages: boolean
}

function looksLikeZip(bytes: Uint8Array): boolean {
  // zip 的本地文件头魔数 PK\x03\x04；结尾也可能是 PK\x05\x06（空包）
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

/**
 * 读一份备份。
 *
 * 支持两种输入：
 *   - 完整的 zip 包（导出文件 / 快照）→ 连图片一起恢复
 *   - 单独的 data.json（镜像目录里那一份）→ 只有文字，图片恢复不了
 *
 * 后一种是特意支持的：用户打开备份文件夹，最顺手点到的就是 data.json。
 * 与其报错让他去找 zip，不如把能恢复的先恢复掉，然后明确告诉他缺了什么。
 */
export async function parseArchive(
  file: Blob,
  source = '所选文件',
): Promise<ParsedArchive> {
  const bytes = new Uint8Array(await file.arrayBuffer())

  if (!looksLikeZip(bytes)) {
    const text = new TextDecoder().decode(bytes)
    const backup = parseBackupFile(text, source)
    return {
      backup,
      attachments: [],
      missingImages: backup.attachments.map((a) => a.path),
      hasNoImages: backup.attachments.length === 0,
    }
  }

  let entries: Map<string, Uint8Array>
  try {
    entries = await readZip(file)
  } catch (error) {
    throw new Error(
      `${source} 打不开：${
        error instanceof Error ? error.message : String(error)
      }。如果这个 zip 是从网盘下载的，确认一下是不是没下载完整。`,
    )
  }

  const raw = readZipText(entries, DATA_FILE)
  if (raw === null) {
    throw new Error(
      `${source} 里没有 ${DATA_FILE}，不像是「学习笔记」的备份包。`,
    )
  }

  const backup = parseBackupFile(raw, source)
  const attachments: Attachment[] = []
  const missingImages: string[] = []

  for (const meta of backup.attachments) {
    const data = entries.get(meta.path)
    if (!data) {
      missingImages.push(meta.path)
      continue
    }
    // 用真实的字节数，而不是 meta 里记的——两者不一致时以数据为准
    const blob = new Blob([data as BlobPart], { type: meta.mimeType })
    attachments.push({
      id: meta.id,
      noteId: meta.noteId,
      // 原样读回备份里记的类型。老备份一定带 'image'，
      // 真的缺字段时才退回图片
      type: meta.type ?? 'image',
      blob,
      mimeType: meta.mimeType,
      width: meta.width,
      height: meta.height,
      sizeBytes: blob.size,
      createdAt: meta.createdAt,
    })
  }

  return {
    backup,
    attachments,
    missingImages,
    hasNoImages: backup.attachments.length === 0,
  }
}

/** 这一份备份里都有什么，用于导入前的确认提示 */
export function describeArchive(backup: BackupFile): string {
  const counts = backup.counts ?? countSnapshot({
    subjects: backup.subjects,
    chapters: backup.chapters,
    notes: backup.notes,
    attachments: [],
  })
  const when = backup.exportedAt
    ? new Date(backup.exportedAt).toLocaleString('zh-CN')
    : '未知时间'
  return `${counts.subjects} 个科目、${counts.chapters} 个章节、${counts.notes} 篇笔记、${counts.attachments} 张图片（导出于 ${when}）`
}

export type { BackupFile, BackupCounts, NoteDocument, Snapshot }
