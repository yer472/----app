/**
 * File System Access API 的补充类型声明。
 *
 * TypeScript 自带的 lib.dom 里已经有 FileSystemHandle / FileSystemDirectoryHandle
 * 这些接口了，但缺了本项目要用到的几样：
 *   - window.showDirectoryPicker()：让用户挑一个文件夹，并拿到一个可以长期保存的句柄
 *   - FileSystemHandle.queryPermission() / requestPermission()：查询和重新申请权限
 *
 * 所以这里补上。没有装 @types/wicg-file-system-access，因为只缺这么几个成员，
 * 引一个外部包不划算。
 *
 * 注意：这是个没有 import/export 的 .d.ts，属于全局声明，
 * 下面的 interface 会和 lib.dom 里的同名接口自动合并。
 */

type FileSystemPermissionMode = 'read' | 'readwrite'
type FileSystemPermissionState = 'granted' | 'denied' | 'prompt'

interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode
}

interface FileSystemHandle {
  queryPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<FileSystemPermissionState>
  requestPermission(
    descriptor?: FileSystemHandlePermissionDescriptor,
  ): Promise<FileSystemPermissionState>
}

interface DirectoryPickerOptions {
  /** 记住上次选的目录，同一个 id 下次打开会停在那里 */
  id?: string
  mode?: FileSystemPermissionMode
  startIn?:
    | FileSystemHandle
    | 'desktop'
    | 'documents'
    | 'downloads'
    | 'music'
    | 'pictures'
    | 'videos'
}

interface Window {
  showDirectoryPicker(
    options?: DirectoryPickerOptions,
  ): Promise<FileSystemDirectoryHandle>
}
