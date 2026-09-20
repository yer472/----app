/**
 * 备份包的格式定义，以及「领域数据 ⇄ 文件」的纯转换逻辑。
 *
 * 设计要点（对应产品文档 F5.1 / F5.2 / F5.5）：
 *
 * 1. **一个格式，三处复用。** 手动导出的 zip、自动备份的每日快照 zip、
 *    自动备份的文件夹镜像，内容完全一样。格式只有一份实现，
 *    不会出现「导出的能恢复、备份的不能」这种问题。
 *
 * 2. **文本和图片分开存。** 图片是 `images/<附件id>.<ext>` 这样的真实文件，
 *    而不是塞进 JSON 里的 base64。base64 会让体积涨 33%，而且
 *    用户从文件夹里根本没法直接看这些图。
 *
 * 3. **笔记同时以 .md 文件形式存在。** `笔记/科目/章节/标题.md`，
 *    用记事本、VS Code、Obsidian 都能直接打开。这就是 F5.5 说的
 *    「脱离本 App 仍可阅读」——即使这个 App 以后不能用了，
 *    笔记本身还是普通的 Markdown 文件。
 *
 * 恢复时以 `data.json` 为准；`笔记/` 目录是给人看的副本，
 * 不参与导入（因为它丢了置顶、排序、创建时间这些信息）。
 */
import { sanitizeFileName, uniqueFileName } from '@/lib/filename'
import { hashString } from '@/lib/hash'
import { formatDateTime } from '@/lib/time'
import { SYMBOL_SHAPE_KINDS, type ShapeKind } from '@/types/scene'
import type {
  Attachment,
  AttachmentType,
  Chapter,
  CustomSymbol,
  ID,
  ISODateTime,
  Note,
  Subject,
} from '@/types/models'

export const BACKUP_FORMAT = 'xxbj-backup'
/**
 * 备份格式版本。
 *
 * 1 → 2 是加了**自定义符号库**。这个号只被当作**上界**用（见 parseBackupFile：
 * 文件版本比 App 支持的还新就直接报错）。所以不升的话，旧版 App 导入新备份时
 * 会**静默丢掉整个符号库**——用户自己画的东西无声消失。报错比静默丢数据好。
 *
 * 反向不受影响：新版读旧备份照常（`symbols` 缺席时按空数组读）。
 */
export const BACKUP_VERSION = 2
export const MANIFEST_FORMAT = 'xxbj-manifest'

/** 压缩包 / 备份文件夹里的固定文件名 */
export const DATA_FILE = 'data.json'
export const MANIFEST_FILE = 'backup-manifest.json'
export const README_FILE = '备份说明.txt'
export const IMAGES_DIR = 'images'
export const NOTES_DIR = '笔记'
export const SNAPSHOT_DIR = '快照'
/** 找不到所属章节的笔记放这里 */
export const ORPHAN_DIR = '_未归档'

/** 每日快照保留几份 */
export const SNAPSHOT_KEEP = 7

/** 归档时用到的原始数据 */
export interface Snapshot {
  subjects: Subject[]
  chapters: Chapter[]
  notes: Note[]
  attachments: Attachment[]
  /** 自定义符号库。它是**用户创作的内容**，所以和笔记一样进备份 */
  symbols: CustomSymbol[]
}

/** 附件在备份里的元信息。图片本体是单独的文件，不在这里。 */
export interface BackupAttachmentMeta {
  id: ID
  noteId: ID
  /**
   * 附件种类。导出时写的是真实值，导入时必须原样读回来。
   *
   * 这里曾经写死成 `type: 'image'`，导入侧也跟着写死——于是任何一种
   * 新附件类型都会在「备份 → 恢复」一趟之后静默降级回图片：
   * 导出正常、导入正常、数据库里看也正常，只是类型信息没了。
   */
  type: AttachmentType
  mimeType: string
  width: number
  height: number
  sizeBytes: number
  createdAt: ISODateTime
  /** 图片在备份包里的路径，如 `images/ab12cd34.png` */
  path: string
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  app: string
  exportedAt: ISODateTime
  counts: BackupCounts
  subjects: Subject[]
  chapters: Chapter[]
  notes: Note[]
  attachments: BackupAttachmentMeta[]
  /** 自定义符号库。v2 新增；v1 的备份里没有这个字段 */
  symbols: CustomSymbol[]
}

export interface BackupCounts {
  subjects: number
  chapters: number
  notes: number
  attachments: number
  /** 自定义符号个数。恢复是覆盖式的，所以这个数要摆在确认框里给用户看 */
  symbols: number
  /** 图片总字节数 */
  imageBytes: number
}

/** 文件夹镜像里那份清单，用来跳过没变过的文件 */
export interface BackupManifest {
  format: typeof MANIFEST_FORMAT
  version: number
  lastBackupAt: ISODateTime
  counts: BackupCounts
  /** 整库内容指纹，一致就说明这次不用重写 */
  contentHash: string
  /** 笔记 id → 正文指纹，用来跳过没改过的 .md */
  noteHashes: Record<ID, string>
  /** 已经写进 images/ 的附件 id */
  attachmentIds: ID[]
  /** 最近一次每日快照的日期和内容指纹，避免同一天重复打包 */
  lastSnapshotDate: string | null
  lastSnapshotHash: string | null
}

/** 一篇笔记导出的 Markdown 文档 */
export interface NoteDocument {
  noteId: ID
  /** 相对备份根目录的路径，如 `笔记/高等数学/第三章/罗尔定理.md` */
  path: string
  text: string
  /** 正文指纹，用于判断是否需要重写 */
  hash: string
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

export function imageExtension(mimeType: string): string {
  return IMAGE_EXTENSIONS[mimeType.toLowerCase()] ?? 'png'
}

export function imagePathFor(attachment: { id: ID; mimeType: string }): string {
  return `${IMAGES_DIR}/${attachment.id}.${imageExtension(attachment.mimeType)}`
}

/** `2026-09-19-1432`，用于导出文件名，避免同一天导出多次互相覆盖 */
export function fileStamp(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`
  )
}

/** `2026-09-19`，用于每日快照的文件名 */
export function dayStamp(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export function archiveFileName(at: Date = new Date()): string {
  return `XXBJ-备份-${fileStamp(at)}.zip`
}

export function snapshotFileName(day: string): string {
  return `XXBJ-${day}.zip`
}

/** 从 `XXBJ-2026-09-19.zip` 里认出快照文件。轮转删除时只认这个模式，避免误删用户自己放的文件。 */
export function isSnapshotFileName(name: string): boolean {
  return /^XXBJ-\d{4}-\d{2}-\d{2}\.zip$/.test(name)
}

export function countSnapshot(snapshot: Snapshot): BackupCounts {
  return {
    subjects: snapshot.subjects.length,
    chapters: snapshot.chapters.length,
    notes: snapshot.notes.length,
    attachments: snapshot.attachments.length,
    symbols: snapshot.symbols.length,
    imageBytes: snapshot.attachments.reduce((sum, a) => sum + a.sizeBytes, 0),
  }
}

/**
 * 把读到的清单补全成完整形状。
 *
 * 清单是备份程序自己写的，理论上不会缺字段；但它存在用户的文件夹里，
 * 用户可能手动改过、或者哪天版本升级加了新字段。少一个字段就让整个
 * 备份流程崩掉不值得，缺什么补什么，最坏的结果只是多写一遍文件。
 */
export function ensureManifestShape(raw: BackupManifest): BackupManifest {
  return {
    format: MANIFEST_FORMAT,
    version: raw.version ?? BACKUP_VERSION,
    lastBackupAt: raw.lastBackupAt ?? '',
    // 逐字段兜底，**不是整块 `raw.counts ?? {...}`**：清单存在用户的文件夹里、
    // 可能被手改过，一个只写了一半的 counts 会原样通过，然后
    // `counts.symbols === undefined` 就流进了设置页和恢复确认框
    counts: {
      subjects: raw.counts?.subjects ?? 0,
      chapters: raw.counts?.chapters ?? 0,
      notes: raw.counts?.notes ?? 0,
      attachments: raw.counts?.attachments ?? 0,
      symbols: raw.counts?.symbols ?? 0,
      imageBytes: raw.counts?.imageBytes ?? 0,
    },
    contentHash: raw.contentHash ?? '',
    noteHashes: raw.noteHashes ?? {},
    attachmentIds: raw.attachmentIds ?? [],
    lastSnapshotDate: raw.lastSnapshotDate ?? null,
    lastSnapshotHash: raw.lastSnapshotHash ?? null,
  }
}

/** 整库内容指纹。任何一条记录变了它就会变。 */
export function contentHashOf(snapshot: Snapshot): string {
  const parts: string[] = []

  for (const subject of [...snapshot.subjects].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(`S|${subject.id}|${subject.name}|${subject.color}|${subject.order}|${subject.updatedAt}`)
  }
  for (const chapter of [...snapshot.chapters].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(`C|${chapter.id}|${chapter.subjectId}|${chapter.name}|${chapter.order}|${chapter.updatedAt}`)
  }
  for (const note of [...snapshot.notes].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(`N|${note.id}|${note.chapterId}|${note.title}|${note.isPinned}|${note.updatedAt}`)
    // 正文单独哈希，避免把几 MB 的文本拼进这个大字符串里
    parts.push(`B|${hashString(note.content)}`)
  }
  for (const attachment of [...snapshot.attachments].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(`A|${attachment.id}|${attachment.noteId}|${attachment.sizeBytes}`)
  }
  /*
   * ⚠️ 符号库**必须**进指纹。
   *
   * 不进的话：用户新建/改了一个自定义符号 → 内容指纹没变 → 镜像备份判定
   * `unchanged` 直接跳过整轮写入，当天的每日快照也不写（用的是同一个指纹）。
   * 结果就是「符号一直不进备份，直到别的数据恰好也变了」——纯粹的静默丢数据，
   * 而且是这条功能里最可能发生的一种（符号改完就关电脑）。
   *
   * 这条断言真发挥作用过一次：改这段的脚本没匹配上、静默什么都没做，
   * 自检脚本当场就把「改了符号指纹不变」报了出来。
   */
  for (const symbol of [...snapshot.symbols].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(
      `Y|${symbol.id}|${symbol.name}|${symbol.origin.x}|${symbol.origin.y}|${symbol.updatedAt}`,
    )
    // 图形单独哈希：一个符号的图元可能有几十条
    parts.push(`D|${hashString(JSON.stringify(symbol.shapes))}`)
  }

  return hashString(parts.join('\n'))
}

export function buildBackupFile(
  snapshot: Snapshot,
  exportedAt: ISODateTime,
): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: '学习笔记 (XXBJ)',
    exportedAt,
    counts: countSnapshot(snapshot),
    subjects: snapshot.subjects,
    chapters: snapshot.chapters,
    notes: snapshot.notes,
    attachments: snapshot.attachments.map((attachment) => ({
      id: attachment.id,
      noteId: attachment.noteId,
      type: attachment.type,
      mimeType: attachment.mimeType,
      width: attachment.width,
      height: attachment.height,
      sizeBytes: attachment.sizeBytes,
      createdAt: attachment.createdAt,
      path: imagePathFor(attachment),
    })),
    symbols: snapshot.symbols,
  }
}

function yamlValue(value: string): string {
  return /[:#"'\n{}[\],&*?|<>=!%@`]/.test(value) || /^\s|\s$/.test(value)
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : value
}

/**
 * 把一篇笔记渲染成带 front matter 的 Markdown 文件。
 *
 * 用 front matter 而不是普通注释，是因为 Obsidian / Typora 这些工具
 * 都认识它，标题科目这些元信息不会破坏正文的渲染。
 */
function renderNoteDocument(
  note: Note,
  subjectName: string | null,
  chapterName: string | null,
  imageBase: string,
  imagePaths: Map<ID, string>,
): string {
  const header = [
    '---',
    `标题: ${yamlValue(note.title)}`,
    `科目: ${yamlValue(subjectName ?? '未归档')}`,
    `章节: ${yamlValue(chapterName ?? '未归档')}`,
    `创建: ${formatDateTime(note.createdAt)}`,
    `更新: ${formatDateTime(note.updatedAt)}`,
    ...(note.isPinned ? ['置顶: 是'] : []),
    '---',
    '',
  ].join('\n')

  // 正文里的 asset://<id> 换成相对路径，让这个 .md 脱离 App 也能正常显示图片。
  // 注意 path 本身带 `images/` 前缀，要把整段拼上：
  // 正文在 笔记/科目/章节/ 下，图片在根目录的 images/ 下，少一层就断链。
  const body = note.content.replace(
    /asset:\/\/([0-9a-zA-Z-]+)/g,
    (whole, id: string) => {
      const path = imagePaths.get(id)
      return path ? `${imageBase}${path}` : whole
    },
  )

  return `${header}${body}\n`
}

export interface NoteDocuments {
  documents: NoteDocument[]
  /** 笔记 id → 它在备份里的路径 */
  pathByNoteId: Map<ID, string>
  /**
   * asset:// 引用应该改写成什么相对路径。
   *
   * 图片统一放在根目录的 images/ 下，而正文在 `笔记/科目/章节/` 里，
   * 所以要按层数回退。让 .md 里的图片能正常显示，这个相对路径是必须算的。
   */
  imageBaseByNoteId: Map<ID, string>
}

export function buildNoteDocuments(snapshot: Snapshot): NoteDocuments {
  const subjectById = new Map(snapshot.subjects.map((s) => [s.id, s]))
  const chapterById = new Map(snapshot.chapters.map((c) => [c.id, c]))
  const imagePaths = new Map(snapshot.attachments.map((a) => [a.id, imagePathFor(a)]))

  const documents: NoteDocument[] = []
  const pathByNoteId = new Map<ID, string>()
  const imageBaseByNoteId = new Map<ID, string>()
  const usedFullPaths = new Set<string>()
  const usedPerDirectory = new Map<string, Set<string>>()

  for (const note of snapshot.notes) {
    const chapter = chapterById.get(note.chapterId)
    const subject = chapter ? subjectById.get(chapter.subjectId) : undefined

    const segments = chapter && subject
      ? [NOTES_DIR, sanitizeFileName(subject.name, '未命名科目', 60), sanitizeFileName(chapter.name, '未命名章节', 60)]
      : [NOTES_DIR, ORPHAN_DIR]

    const directory = segments.join('/')
    let used = usedPerDirectory.get(directory)
    if (!used) {
      used = new Set<string>()
      usedPerDirectory.set(directory, used)
    }

    const fileName = uniqueFileName(
      `${sanitizeFileName(note.title, '未命名笔记')}.md`,
      used,
    )
    const path = `${directory}/${fileName}`

    // 兜底：极端情况下（同名同目录被 uniqueFileName 处理过）理论上不会重复，
    // 但这里再防一层，避免同一个路径写两次
    if (usedFullPaths.has(path)) continue
    usedFullPaths.add(path)

    const imageBase = '../'.repeat(segments.length)
    documents.push({
      noteId: note.id,
      path,
      text: renderNoteDocument(
        note,
        subject?.name ?? null,
        chapter?.name ?? null,
        imageBase,
        imagePaths,
      ),
      hash: hashString(note.content),
    })
    pathByNoteId.set(note.id, path)
    imageBaseByNoteId.set(note.id, imageBase)
  }

  documents.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'))
  return { documents, pathByNoteId, imageBaseByNoteId }
}

/** 备份根目录下的说明文件，写给「几年后的自己」看 */
export function buildReadme(counts: BackupCounts, at: ISODateTime): string {
  return [
    '学习笔记（XXBJ）备份',
    '====================',
    '',
    `备份时间：${formatDateTime(at)}`,
    `内容：${counts.subjects} 个科目 / ${counts.chapters} 个章节 / ${counts.notes} 篇笔记 / ${counts.attachments} 张图片 / ${counts.symbols} 个自定义符号`,
    '',
    '这个文件夹里有什么',
    '------------------',
    `  ${DATA_FILE}`,
    '      全部数据（科目、章节、笔记、图片索引）。恢复时以它为准。',
    '',
    `  ${NOTES_DIR}/`,
    '      每篇笔记导出的 Markdown 文件，按 科目/章节 分目录。',
    '      用记事本、VS Code、Obsidian、Typora 都能直接打开，不依赖本 App。',
    '      注意：这个目录仅供阅读和取用，恢复数据不会用它——',
    '      它里面没有置顶、排序、创建时间这些信息，也反映不了多篇同名笔记的区分。',
    '',
    `  ${IMAGES_DIR}/`,
    '      笔记里插入的图片原文件，文件名就是笔记正文里引用的附件 id。',
    '',
    `  ${SNAPSHOT_DIR}/`,
    '      每天一份的完整压缩包，保留最近 7 天。',
    '      用来找回「昨天误删的那篇」这类被覆盖掉的修改。',
    '',
    `  ${MANIFEST_FILE}`,
    '      备份程序自己用的记录，用来判断哪些文件没变、可以跳过。可以删，删了下次全量重写一遍。',
    '',
    '怎么恢复',
    '--------',
    '打开 学习笔记 App → 设置 → 从备份恢复 → 选择一份数据。',
    '可以选这个文件夹里的 data.json，也可以选 快照/ 里的任意一个 zip。',
    '',
    '注意',
    '----',
    `· ${NOTES_DIR}/ 和 ${IMAGES_DIR}/ 是「只增不删」的：在 App 里删掉一篇笔记或一张图片，`,
    '  这两个目录里的对应文件不会被清理。这样做是为了避免误删你的文件——',
    '  恢复以 data.json 为准，残留的文件不影响恢复结果，只是会占一点空间。',
    '',
  ].join('\n')
}

/** 校验导入的文件确实是本 App 导出的备份 */
export function parseBackupFile(raw: string, source: string): BackupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${source} 不是合法的 JSON，可能文件已损坏。`)
  }

  const file = parsed as Partial<BackupFile>
  if (file?.format !== BACKUP_FORMAT) {
    throw new Error(
      `${source} 不是「学习笔记」导出的备份文件（缺少 format 标记）。`,
    )
  }
  if (typeof file.version !== 'number' || file.version > BACKUP_VERSION) {
    throw new Error(
      `${source} 的版本是 ${String(file.version)}，比当前 App 支持的版本（${BACKUP_VERSION}）新。请先更新 App。`,
    )
  }
  if (
    !Array.isArray(file.subjects) ||
    !Array.isArray(file.chapters) ||
    !Array.isArray(file.notes)
  ) {
    throw new Error(`${source} 内容不完整，缺少科目/章节/笔记数据。`)
  }

  return {
    format: BACKUP_FORMAT,
    version: file.version,
    app: file.app ?? '学习笔记 (XXBJ)',
    exportedAt: file.exportedAt ?? new Date().toISOString(),
    counts:
      file.counts ??
      countSnapshot({
        subjects: file.subjects,
        chapters: file.chapters,
        notes: file.notes,
        attachments: [],
        symbols: [],
      }),
    subjects: file.subjects,
    chapters: file.chapters,
    notes: file.notes,
    attachments: Array.isArray(file.attachments) ? file.attachments : [],
    // v1 的备份没有这个字段，按空数组读——不是「把用户的符号清掉」，
    // 而是「那份备份里本来就没有」。恢复会清空现有符号库，这件事在
    // 恢复确认框里会显示出来（counts 里有符号数），用户看得见
    symbols: Array.isArray(file.symbols)
      ? file.symbols.filter(isCustomSymbol)
      : [],
  }
}

/**
 * 自定义符号的形状校验。
 *
 * 比 subjects/notes 严一档：符号是要被**渲染**的，一份半坏的备份
 * （`shapes` 不是数组、或者塞了个缺字段的对象）会让整个符号面板崩掉。
 * 仓库里对笔记只做浅校验是因为它们最终都当字符串用，符号不是。
 */
function isCustomSymbol(value: unknown): value is CustomSymbol {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    Array.isArray(s.shapes) &&
    s.shapes.every(isSceneShape) &&
    isScenePoint(s.origin) &&
    typeof s.width === 'number' &&
    typeof s.height === 'number'
  )
}

/**
 * 自定义符号里**只允许**普通图元：放符号进去会形成递归。
 *
 * 名单在 `types/scene.ts` 里，和 `SymbolRepository` 存之前过滤用的是同一份
 * ——这两处必须一致，否则「画完保存了、导出再导入回来符号就缺了一块」。
 *
 * 这里是备**份文件**的校验，数据可能来自别的版本，所以查不到就判不合法：
 * 宁可判定这个符号读不回来，也不要让一个来路不明的图元进到渲染层。
 */
function isSceneShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const shape = value as Record<string, unknown>
  if (typeof shape.id !== 'string') return false
  if (typeof shape.kind !== 'string') return false
  const allowed: boolean | undefined = SYMBOL_SHAPE_KINDS[shape.kind as ShapeKind]
  if (!allowed) return false
  if (shape.kind === 'pencil') return Array.isArray(shape.points)
  return isScenePoint(shape.a) && isScenePoint(shape.b)
}

function isScenePoint(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return typeof p.x === 'number' && typeof p.y === 'number'
}

/** data.json 里存的其实是 BackupFile，这里给它收个尾 */
export function serializeBackupFile(file: BackupFile): string {
  return JSON.stringify(file, null, 2)
}
