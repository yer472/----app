/**
 * 文件名清洗。
 *
 * 备份会把科目名、章节名、笔记标题直接用作文件夹名和文件名。
 * Windows 对这些名字有硬性限制，不清洗的话 createWritable 会直接抛错。
 */

/** Windows 不允许出现在文件名里的字符（含控制字符） */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/** Windows 保留设备名，叫这些名字的文件根本建不出来 */
const RESERVED_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export function sanitizeFileName(
  name: string,
  fallback = '未命名',
  maxLength = 80,
): string {
  let out = name
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows 上文件名不能以点或空格结尾
    .replace(/[. ]+$/, '')

  if (!out) return fallback
  if (RESERVED_NAMES.test(out)) out = `_${out}`
  if (out.length > maxLength) {
    out = out.slice(0, maxLength).replace(/[. ]+$/, '').trim()
  }

  return out || fallback
}

/**
 * 同一层目录里重名时追加序号：`笔记.md`、`笔记 (2).md`、`笔记 (3).md`。
 *
 * 两篇笔记标题一样是很正常的事（比如都用日期当标题），
 * 但同一个文件夹里不能有两个同名文件。
 */
export function uniqueFileName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }

  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''

  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }

  const fallback = `${stem} (${Date.now()})${ext}`
  used.add(fallback)
  return fallback
}
