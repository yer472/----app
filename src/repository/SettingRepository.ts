import { db } from '@/db'

/** 设置项的 key 集中在这里，避免各处硬编码字符串写错 */
export const SETTING_KEYS = {
  theme: 'ui.theme',
  sidebarCollapsed: 'ui.sidebarCollapsed',
  lastOpenedNoteId: 'app.lastOpenedNoteId',
  /**
   * 备份文件夹的 FileSystemDirectoryHandle 本体。
   *
   * FileSystemDirectoryHandle 是可以结构化克隆的，所以能直接存进 IndexedDB ——
   * 这样用户挑一次文件夹就行，不用每次打开 App 重新选。
   * 不过权限是另一回事：句柄能存下来，权限仍然会随会话过期，
   * 需要用户重新点一下授权（见 lib/backup/fsAccess.ts 的 checkPermission）。
   */
  backupDirectory: 'backup.directoryHandle',
  backupDirectoryName: 'backup.directoryName',
  backupAutoEnabled: 'backup.autoEnabled',
  backupLastResult: 'backup.lastResult',
} as const

export const SettingRepository = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await db.settings.get(key)
    return row === undefined ? fallback : (row.value as T)
  },

  async set(key: string, value: unknown): Promise<void> {
    await db.settings.put({ key, value })
  },

  async remove(key: string): Promise<void> {
    await db.settings.delete(key)
  },
}
