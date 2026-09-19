/**
 * 自动备份的状态。
 *
 * 文件夹句柄（FileSystemDirectoryHandle）刻意**不放进 zustand 的 state**，
 * 而是留在模块级变量里：它是个浏览器对象、不参与渲染，放 state 里
 * 只会在每次 setState 时被浅比较一遍，没有任何好处。
 */
import { create } from 'zustand'
import {
  checkPermission,
  describeFileSystemError,
  pickDirectory,
  supportsDirectoryPicker,
  type PermissionState,
} from '@/lib/backup/fsAccess'
import {
  runBackup,
  type BackupProgress,
  type BackupResult,
} from '@/lib/backup/service'
import { SETTING_KEYS, SettingRepository } from '@/repository'

/** 保存下来的备份文件夹句柄 */
let directoryHandle: FileSystemDirectoryHandle | null = null

/** 自动备份的防抖定时器：改完笔记后等一会儿再备份，避免边写边备份 */
let autoTimer: ReturnType<typeof setTimeout> | null = null

/** 停止编辑后多久触发自动备份 */
const AUTO_BACKUP_DELAY_MS = 30_000

/** 启动后多久做一次检查（让界面先渲染出来，别跟启动抢资源） */
const STARTUP_BACKUP_DELAY_MS = 5_000

interface BackupState {
  /** 设置是否已读回来 */
  ready: boolean
  /** 浏览器是否支持 File System Access API */
  supported: boolean
  directoryName: string | null
  permission: PermissionState | 'unknown'
  autoEnabled: boolean
  lastResult: BackupResult | null
  running: boolean
  progress: BackupProgress | null
  error: string | null

  hydrate: () => Promise<void>
  chooseDirectory: () => Promise<void>
  grantPermission: () => Promise<void>
  forgetDirectory: () => Promise<void>
  setAutoEnabled: (enabled: boolean) => Promise<void>
  backupNow: (force?: boolean) => Promise<void>
  scheduleAutoBackup: () => void
}

export const useBackupStore = create<BackupState>((set, get) => ({
  ready: false,
  supported: supportsDirectoryPicker(),
  directoryName: null,
  permission: 'unknown',
  autoEnabled: false,
  lastResult: null,
  running: false,
  progress: null,
  error: null,

  hydrate: async () => {
    const supported = supportsDirectoryPicker()
    try {
      const [handle, name, autoEnabled, lastResult] = await Promise.all([
        SettingRepository.get<FileSystemDirectoryHandle | null>(
          SETTING_KEYS.backupDirectory,
          null,
        ),
        SettingRepository.get<string | null>(
          SETTING_KEYS.backupDirectoryName,
          null,
        ),
        SettingRepository.get<boolean>(SETTING_KEYS.backupAutoEnabled, false),
        SettingRepository.get<BackupResult | null>(
          SETTING_KEYS.backupLastResult,
          null,
        ),
      ])

      directoryHandle = handle

      // 只查询权限，不申请——申请必须由用户点击触发，否则浏览器直接拒绝。
      // 这里查出来是 prompt，界面上就显示「重新授权」按钮。
      const permission =
        handle && supported ? await checkPermission(handle, false) : 'unknown'

      set({
        ready: true,
        supported,
        directoryName: handle ? (name ?? handle.name) : null,
        permission,
        autoEnabled,
        lastResult,
      })
    } catch (e) {
      set({
        ready: true,
        supported,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  },

  chooseDirectory: async () => {
    set({ error: null })
    try {
      const handle = await pickDirectory()
      const permission = await checkPermission(handle, true)

      if (permission !== 'granted') {
        set({
          error:
            '没有拿到这个文件夹的读写权限，无法用它做备份。请重新选择并允许访问。',
        })
        return
      }

      directoryHandle = handle
      await Promise.all([
        // FileSystemDirectoryHandle 可以结构化克隆，能直接存进 IndexedDB。
        // 存下来之后，下次打开 App 就不用重新挑文件夹了。
        SettingRepository.set(SETTING_KEYS.backupDirectory, handle),
        SettingRepository.set(SETTING_KEYS.backupDirectoryName, handle.name),
      ])

      set({ directoryName: handle.name, permission: 'granted', error: null })

      // 刚选好就立刻备一次，让用户马上看到东西真的写进去了
      await get().backupNow(true)
    } catch (e) {
      set({ error: describeFileSystemError(e) })
    }
  },

  grantPermission: async () => {
    if (!directoryHandle) return
    set({ error: null })
    try {
      const permission = await checkPermission(directoryHandle, true)
      set({ permission })
      if (permission === 'granted') await get().backupNow(true)
      else set({ error: '授权被拒绝，暂时无法自动备份。' })
    } catch (e) {
      set({ error: describeFileSystemError(e) })
    }
  },

  forgetDirectory: async () => {
    directoryHandle = null
    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
    await Promise.all([
      SettingRepository.remove(SETTING_KEYS.backupDirectory),
      SettingRepository.remove(SETTING_KEYS.backupDirectoryName),
      SettingRepository.set(SETTING_KEYS.backupAutoEnabled, false),
    ])
    set({
      directoryName: null,
      permission: 'unknown',
      autoEnabled: false,
      progress: null,
      error: null,
    })
  },

  setAutoEnabled: async (enabled) => {
    await SettingRepository.set(SETTING_KEYS.backupAutoEnabled, enabled)
    set({ autoEnabled: enabled })
    if (enabled) get().scheduleAutoBackup()
  },

  backupNow: async (force = false) => {
    const state = get()
    if (!directoryHandle || state.running) return
    if (state.permission !== 'granted') {
      set({ error: '还没有这个文件夹的读写权限，请先点「重新授权」。' })
      return
    }

    set({ running: true, error: null, progress: null })
    try {
      const result = await runBackup(directoryHandle, {
        force,
        onProgress: (progress) => set({ progress }),
      })
      await SettingRepository.set(SETTING_KEYS.backupLastResult, result)
      set({ lastResult: result, progress: null, error: null })
    } catch (e) {
      // 权限可能在运行中途失效（比如文件夹被移走了），重新查一次状态，
      // 让界面上的按钮跟着变
      const permission = await checkPermission(directoryHandle, false)
      set({
        error: describeFileSystemError(e),
        permission,
        progress: null,
      })
    } finally {
      set({ running: false })
    }
  },

  scheduleAutoBackup: () => {
    const { autoEnabled, permission, running } = get()
    if (!autoEnabled || !directoryHandle || running) return
    // 权限过期的状态下排队也没意义，等用户重新授权后自然会触发一次
    if (permission !== 'granted') return

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      autoTimer = null
      void get().backupNow(false)
    }, AUTO_BACKUP_DELAY_MS)
  },
}))

/**
 * 供写入方调用（笔记页每次自动保存成功后）。
 *
 * 做成独立函数而不是让页面去 useBackupStore 里取，是为了让页面
 * 不用订阅备份状态——笔记页只关心"存好了，通知一声"，
 * 每次备份进度变化都重渲染笔记页是没必要的。
 */
export function scheduleAutoBackup(): void {
  useBackupStore.getState().scheduleAutoBackup()
}

/** 启动时检查一次：距上次备份超过一天就补一次 */
export function startBackupOnLaunch(): void {
  setTimeout(() => {
    const { autoEnabled, permission, lastResult } = useBackupStore.getState()
    if (!autoEnabled || !directoryHandle || permission !== 'granted') return

    const last = lastResult?.at ? new Date(lastResult.at).getTime() : 0
    const dayMs = 24 * 60 * 60 * 1000
    if (Date.now() - last > dayMs) void useBackupStore.getState().backupNow(false)
  }, STARTUP_BACKUP_DELAY_MS)
}
