import { create } from 'zustand'
import { withTimeout } from '@/lib/async'
import { SettingRepository, SETTING_KEYS } from '@/repository'

export type Theme = 'light' | 'dark' | 'system'

const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

/**
 * 主题在 localStorage 里的提示位。
 *
 * 必须和 index.html 里那段内联脚本用的 key 一致——内联脚本没法 import，
 * 只能各写一份字面量。改了这里要同步改那边。
 */
const THEME_STORAGE_KEY = 'xxbj.theme'

/** 把主题落到 <html> 的 class 上，Tailwind 的 dark: 变体靠这个生效 */
function applyTheme(theme: Theme): void {
  const shouldBeDark =
    theme === 'dark' || (theme === 'system' && darkMediaQuery.matches)
  document.documentElement.classList.toggle('dark', shouldBeDark)

  // 写一份提示位，让下次启动不用等 IndexedDB 往返就知道该用深色还是浅色。
  // 它不是数据源，写失败（隐私模式）无所谓。
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* 忽略 */
  }

  // 标题栏颜色。manifest 里的 theme_color 是静态的只能表达一种主题，
  // 所以由这里按「用户实际选了什么」改写 media 属性。
  //
  // 下标依赖 index.html 里那两条 meta 的顺序（0 浅 1 深），不要调整那边。
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
  metas[0]?.setAttribute('media', shouldBeDark ? 'not all' : 'all')
  metas[1]?.setAttribute('media', shouldBeDark ? 'all' : 'not all')
}

interface UiState {
  theme: Theme
  sidebarCollapsed: boolean
  /** 设置是否已从数据库读回来。为 false 时先别渲染，避免主题闪一下 */
  hydrated: boolean
  /** 数据库打不开时的错误信息。非 null 时整个应用不可用，直接展示原因 */
  initError: string | null
  setTheme: (theme: Theme) => void
  toggleSidebar: () => void
  hydrate: () => Promise<void>
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: 'system',
  sidebarCollapsed: false,
  hydrated: false,
  initError: null,

  setTheme: (theme) => {
    applyTheme(theme)
    set({ theme })
    void SettingRepository.set(SETTING_KEYS.theme, theme)
  },

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    set({ sidebarCollapsed: next })
    void SettingRepository.set(SETTING_KEYS.sidebarCollapsed, next)
  },

  hydrate: async () => {
    try {
      const [theme, sidebarCollapsed] = await withTimeout(
        Promise.all([
          SettingRepository.get<Theme>(SETTING_KEYS.theme, 'system'),
          SettingRepository.get<boolean>(SETTING_KEYS.sidebarCollapsed, false),
        ]),
        8000,
        '本地数据库没有响应。可能是浏览器的存储被禁用，或者当前处于隐私/无痕模式。',
      )
      applyTheme(theme)
      set({ theme, sidebarCollapsed, hydrated: true })
    } catch (e) {
      // 数据库打不开时（隐私模式、存储被禁用、库损坏），
      // 必须把原因显示出来。否则应用会永远停在"正在启动…"，
      // 用户既不知道出了什么事，也不知道该怎么办。
      set({
        hydrated: true,
        initError: e instanceof Error ? e.message : String(e),
      })
    }
  },
}))

// 跟随系统时，系统切换深色要立刻生效
darkMediaQuery.addEventListener('change', () => {
  if (useUiStore.getState().theme === 'system') applyTheme('system')
})
