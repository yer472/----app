/**
 * 自动备份的执行逻辑：把整库数据写进用户指定的文件夹。
 *
 * 写两种东西（见决策：镜像 + 每日快照）：
 *
 *   镜像 —— data.json / 笔记**.md / images/ 这些普通文件，每次都更新成
 *           「当前状态」。恢复时读它，平时也能直接翻看。
 *   快照 —— 每天一份完整 zip，保留最近 7 天。镜像是「当前状态」，
 *           一旦误删就会在下次备份时被同步掉；快照用来回到过去某一天。
 *
 * 增量靠的是 backup-manifest.json：整库内容指纹没变就整轮跳过，
 * 单篇正文没变就跳过那一个 .md 文件。没有这个的话，每敲几个字
 * 就要把几百 MB 的图片重写一遍。
 */
import { BackupRepository } from '@/repository/BackupRepository'
import { formatDateTime, now } from '@/lib/time'
import type { ISODateTime } from '@/types/models'
import type { ZipProgress } from '@/lib/zip'
import { buildArchive } from './archive'
import {
  BACKUP_VERSION,
  buildBackupFile,
  buildNoteDocuments,
  buildReadme,
  contentHashOf,
  DATA_FILE,
  dayStamp,
  ensureManifestShape,
  IMAGES_DIR,
  imagePathFor,
  isSnapshotFileName,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  NOTES_DIR,
  README_FILE,
  serializeBackupFile,
  SNAPSHOT_DIR,
  SNAPSHOT_KEEP,
  snapshotFileName,
  type BackupCounts,
  type BackupManifest,
} from './format'
import {
  ensureDirectory,
  getSubdirectory,
  listFileNames,
  readTextFile,
  removeFile,
  writeFile,
} from './fsAccess'

export interface BackupProgress {
  phase: 'read' | 'mirror' | 'notes' | 'images' | 'archive' | 'manifest'
  message: string
  done?: number
  total?: number
}

export interface BackupResult {
  at: ISODateTime
  /** 内容跟上一次完全一致，镜像整轮跳过了 */
  skipped: boolean
  counts: BackupCounts
  notesWritten: number
  notesUnchanged: number
  imagesWritten: number
  imagesUnchanged: number
  snapshotFile: string | null
  snapshotsRemoved: string[]
}

async function readManifest(
  root: FileSystemDirectoryHandle,
): Promise<BackupManifest | null> {
  const raw = await readTextFile(root, MANIFEST_FILE)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as BackupManifest
    if (parsed?.format !== MANIFEST_FORMAT) return null
    return ensureManifestShape(parsed)
  } catch {
    // 清单坏了不是什么大事，当作没有清单、全量重写一遍就行
    return null
  }
}

async function writeManifest(
  root: FileSystemDirectoryHandle,
  manifest: BackupManifest,
): Promise<void> {
  await writeFile(root, MANIFEST_FILE, JSON.stringify(manifest, null, 2))
}

/** 走一遍 笔记/ 目录，收集现有的 .md 相对路径，用来判断哪些文件已经写过了 */
async function collectNotePaths(
  root: FileSystemDirectoryHandle,
): Promise<Set<string>> {
  const paths = new Set<string>()

  const walk = async (
    directory: FileSystemDirectoryHandle,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    // 层级是 笔记/科目/章节/文件，五个够用了，也防止意外递归过深
    if (depth > 5) return
    for await (const [name, entry] of directory.entries()) {
      const path = `${prefix}/${name}`
      if (entry.kind === 'file') paths.add(path)
      else await walk(entry as FileSystemDirectoryHandle, path, depth + 1)
    }
  }

  const notesDir = await root
    .getDirectoryHandle(NOTES_DIR)
    .catch(() => null)
  if (notesDir) await walk(notesDir, NOTES_DIR, 1)

  return paths
}

/** 保留最近 N 天的快照，更早的删掉。只认严格命名的快照文件，不碰用户自己放的东西。 */
async function rotateSnapshots(
  snapshotDir: FileSystemDirectoryHandle,
  keep: number,
): Promise<string[]> {
  const names = (await listFileNames(snapshotDir)).filter(isSnapshotFileName)
  // 文件名里的日期是 YYYY-MM-DD，按字符串倒序排就是按时间倒序
  names.sort((a, b) => b.localeCompare(a))

  const removed: string[] = []
  for (const name of names.slice(keep)) {
    await removeFile(snapshotDir, name)
    removed.push(name)
  }
  return removed
}

export interface RunBackupOptions {
  /** 跳过「内容没变就整轮不写」的优化，强制完整写一遍 */
  force?: boolean
  onProgress?: (progress: BackupProgress) => void
}

export async function runBackup(
  root: FileSystemDirectoryHandle,
  options: RunBackupOptions = {},
): Promise<BackupResult> {
  const { force = false, onProgress } = options
  const at = now()

  onProgress?.({ phase: 'read', message: '正在读取数据…' })
  const snapshot = await BackupRepository.snapshot()
  const contentHash = contentHashOf(snapshot)
  const previous = await readManifest(root)

  const counts: BackupCounts = {
    subjects: snapshot.subjects.length,
    chapters: snapshot.chapters.length,
    notes: snapshot.notes.length,
    attachments: snapshot.attachments.length,
    symbols: snapshot.symbols.length,
    imageBytes: snapshot.attachments.reduce((sum, a) => sum + a.sizeBytes, 0),
  }

  const unchanged =
    !force && previous !== null && previous.contentHash === contentHash

  let notesWritten = 0
  let notesUnchanged = 0
  let imagesWritten = 0
  let imagesUnchanged = 0

  const { documents } = buildNoteDocuments(snapshot)
  const noteHashes: Record<string, string> = {}
  for (const document of documents) noteHashes[document.noteId] = document.hash

  if (unchanged) {
    onProgress?.({ phase: 'mirror', message: '数据没有变化，跳过镜像更新。' })
  } else {
    // ---- 1. data.json 和说明文件 ----
    onProgress?.({ phase: 'mirror', message: '正在写入 data.json…' })
    await writeFile(root, DATA_FILE, serializeBackupFile(buildBackupFile(snapshot, at)))
    await writeFile(root, README_FILE, buildReadme(counts, at))

    // ---- 2. 每篇笔记一个 .md ----
    const existingNotes = await collectNotePaths(root)
    const directoryCache = new Map<string, FileSystemDirectoryHandle>()

    const resolveDirectory = async (
      segments: string[],
    ): Promise<FileSystemDirectoryHandle> => {
      const key = segments.join('/')
      const cached = directoryCache.get(key)
      if (cached) return cached
      const handle = await ensureDirectory(root, segments)
      directoryCache.set(key, handle)
      return handle
    }

    for (let i = 0; i < documents.length; i++) {
      const document = documents[i]
      const segments = document.path.split('/')
      const fileName = segments.pop() as string

      if (
        previous?.noteHashes[document.noteId] === document.hash &&
        existingNotes.has(document.path)
      ) {
        notesUnchanged += 1
      } else {
        const directory = await resolveDirectory(segments)
        await writeFile(directory, fileName, document.text)
        notesWritten += 1
      }

      if (i % 20 === 0) {
        onProgress?.({
          phase: 'notes',
          message: '正在写入笔记文件…',
          done: i,
          total: documents.length,
        })
      }
    }

    // ---- 3. 图片 ----
    onProgress?.({ phase: 'images', message: '正在写入图片…' })
    const imagesDir = await ensureDirectory(root, [IMAGES_DIR])
    const existingImages = new Set(await listFileNames(imagesDir))

    for (let i = 0; i < snapshot.attachments.length; i++) {
      const attachment = snapshot.attachments[i]
      const fileName = imagePathFor(attachment).split('/').pop() as string

      // 附件 id 是 uuid，文件名天然唯一，所以"文件在不在"就等于"写没写过"，
      // 不需要再比内容
      if (existingImages.has(fileName)) {
        imagesUnchanged += 1
      } else {
        await writeFile(imagesDir, fileName, attachment.blob)
        imagesWritten += 1
      }

      onProgress?.({
        phase: 'images',
        message: '正在写入图片…',
        done: i + 1,
        total: snapshot.attachments.length,
      })
    }
  }

  // ---- 4. 每日快照 ----
  const today = dayStamp()
  const snapshotUpToDate =
    previous?.lastSnapshotDate === today &&
    previous?.lastSnapshotHash === contentHash

  let snapshotDir = await getSubdirectory(root, SNAPSHOT_DIR)
  let snapshotFile: string | null = null

  if (!snapshotUpToDate) {
    onProgress?.({ phase: 'archive', message: '正在打包今日快照…' })
    const archive = await buildArchive(snapshot, at, (progress: ZipProgress) => {
      onProgress?.({
        phase: 'archive',
        message: '正在打包今日快照…',
        done: progress.done,
        total: progress.total,
      })
    })

    if (!snapshotDir) snapshotDir = await ensureDirectory(root, [SNAPSHOT_DIR])
    snapshotFile = snapshotFileName(today)
    await writeFile(snapshotDir, snapshotFile, archive.blob)
  }

  // 轮转独立于「这次有没有写新快照」。
  // 只跟着新快照走的话，用户的数据一旦不再变化，早先留下的快照就会永远堆在
  // 那里——「最多保留 7 份」这个承诺就不成立了。
  const snapshotsRemoved = snapshotDir
    ? await rotateSnapshots(snapshotDir, SNAPSHOT_KEEP)
    : []

  // ---- 5. 清单：最后写，一次写清 ----
  onProgress?.({ phase: 'manifest', message: '正在更新备份记录…' })
  await writeManifest(root, {
    format: MANIFEST_FORMAT,
    version: BACKUP_VERSION,
    lastBackupAt: at,
    counts,
    contentHash,
    noteHashes,
    attachmentIds: snapshot.attachments.map((a) => a.id),
    lastSnapshotDate: snapshotFile ? today : (previous?.lastSnapshotDate ?? null),
    lastSnapshotHash: snapshotFile
      ? contentHash
      : (previous?.lastSnapshotHash ?? null),
  })

  return {
    at,
    skipped: unchanged,
    counts,
    notesWritten,
    notesUnchanged,
    imagesWritten,
    imagesUnchanged,
    snapshotFile,
    snapshotsRemoved,
  }
}

/** 手动导出：把整库打成一个 zip，交给浏览器下载 */
export async function buildExportArchive(
  onProgress?: (progress: ZipProgress) => void,
): Promise<{ blob: Blob; counts: BackupCounts }> {
  const snapshot = await BackupRepository.snapshot()
  const archive = await buildArchive(snapshot, now(), onProgress)
  return { blob: archive.blob, counts: archive.counts }
}

/** 供界面展示的一句话结果 */
export function describeBackupResult(result: BackupResult): string {
  if (result.skipped) {
    return `数据没有变化，已跳过（${formatDateTime(result.at)}）`
  }
  const parts = [
    `写入 ${result.notesWritten} 篇笔记`,
    result.notesUnchanged > 0 ? `${result.notesUnchanged} 篇未改动` : null,
    result.imagesWritten > 0 ? `${result.imagesWritten} 张新图片` : null,
    result.snapshotFile ? `快照 ${result.snapshotFile}` : null,
    result.snapshotsRemoved.length > 0
      ? `清理 ${result.snapshotsRemoved.length} 份过期快照`
      : null,
  ].filter(Boolean)
  return `${formatDateTime(result.at)} · ${parts.join('，')}`
}
