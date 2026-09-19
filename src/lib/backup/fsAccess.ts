/**
 * File System Access API 的封装。
 *
 * 这是数据安全三层防护的第 2 层（见产品文档 §7.4）：让 App 直接把数据
 * 写进用户指定的本地文件夹。指向 OneDrive / 坚果云的同步目录，
 * 就等于白捡了一个异地云备份。
 *
 * 这个能力只有 Chromium 系浏览器（Chrome / Edge）有，Firefox 和 Safari 没有。
 * 所以所有调用点都得先问一句 supportsDirectoryPicker()，并给用户一个
 * 「用导出功能兜底」的提示——不能因为浏览器不支持就没有任何备份手段。
 */

/** 用户拒绝或浏览器不支持时抛出的错误，调用方据此给不同的提示 */
export class BackupFolderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupFolderError'
  }
}

export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function'
  )
}

/** 弹出系统文件夹选择框。必须在用户点击的事件处理里调用，否则浏览器会拒绝。 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  try {
    return await window.showDirectoryPicker({
      id: 'xxbj-backup',
      mode: 'readwrite',
      startIn: 'documents',
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new BackupFolderError('已取消选择文件夹。')
    }
    throw new BackupFolderError(
      `无法打开文件夹选择框：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export type PermissionState = 'granted' | 'denied' | 'prompt'

/**
 * 查询（必要时申请）备份文件夹的读写权限。
 *
 * 权限是按会话算的：用户昨天授权过，今天重新打开 App 仍然是 prompt 状态，
 * 需要用户再点一次。所以 request=true 只能从用户点击的事件里调用。
 */
export async function checkPermission(
  handle: FileSystemDirectoryHandle,
  request = false,
): Promise<PermissionState> {
  const options = { mode: 'readwrite' as const }
  try {
    const current = await handle.queryPermission(options)
    if (current === 'granted' || !request) return current
    return await handle.requestPermission(options)
  } catch {
    return 'denied'
  }
}

/** 逐层取子目录，不存在就建 */
export async function ensureDirectory(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let current = root
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true })
  }
  return current
}

export async function writeFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  data: string | Uint8Array | Blob,
): Promise<void> {
  const fileHandle = await directory.getFileHandle(name, { create: true })
  // createWritable 写的是临时文件，close() 时才真正替换原文件。
  // 所以中途出错不会留下半截文件——这一点对备份很重要。
  const writable = await fileHandle.createWritable()
  try {
    await writable.write(data as FileSystemWriteChunkType)
  } finally {
    await writable.close()
  }
}

export async function readTextFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<string | null> {
  try {
    const fileHandle = await directory.getFileHandle(name)
    const file = await fileHandle.getFile()
    return await file.text()
  } catch {
    return null
  }
}

export async function hasFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await directory.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

/** 列出一个目录下的文件名（不含子目录） */
export async function listFileNames(
  directory: FileSystemDirectoryHandle,
): Promise<string[]> {
  const names: string[] = []
  for await (const [name, entry] of directory.entries()) {
    if (entry.kind === 'file') names.push(name)
  }
  return names
}

export async function removeFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  await directory.removeEntry(name)
}

export async function getSubdirectory(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await directory.getDirectoryHandle(name)
  } catch {
    return null
  }
}

/** 把浏览器抛出的 DOMException 翻译成用户能看懂的话 */
export function describeFileSystemError(error: unknown): string {
  if (error instanceof BackupFolderError) return error.message
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
        return '没有写入该文件夹的权限。可能是权限已过期，请重新授权；如果文件夹在 OneDrive 等同步目录里，也可能被同步程序占用。'
      case 'NotFoundError':
        return '目标文件夹不存在了。它可能被移动、重命名或删除，请重新选择。'
      case 'NoModificationAllowedError':
        return '文件被占用，无法写入。请检查文件夹里是否有同名文件正被其他程序打开。'
      case 'QuotaExceededError':
        return '磁盘空间不足。'
      default:
        return `${error.name}：${error.message}`
    }
  }
  return error instanceof Error ? error.message : String(error)
}
