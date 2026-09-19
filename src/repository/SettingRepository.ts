import { db } from '@/db'

/** 设置项的 key 集中在这里，避免各处硬编码字符串写错 */
export const SETTING_KEYS = {
  theme: 'ui.theme',
  sidebarCollapsed: 'ui.sidebarCollapsed',
  lastOpenedNoteId: 'app.lastOpenedNoteId',
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
