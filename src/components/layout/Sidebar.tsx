import { useLiveQuery } from 'dexie-react-hooks'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { SubjectRepository } from '@/repository'
import { useUiStore } from '@/store/uiStore'

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
    isActive
      ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50'
      : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-100',
  )

export function Sidebar() {
  const subjects = useLiveQuery(() => SubjectRepository.list(), [])
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)

  const cycleTheme = () => {
    const order = ['light', 'dark', 'system'] as const
    const next = order[(order.indexOf(theme) + 1) % order.length]
    setTheme(next)
  }

  const themeLabel = { light: '浅色', dark: '深色', system: '跟随系统' }[theme]

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/50">
      <div className="px-4 pt-5 pb-3">
        <NavLink to="/" className="block">
          <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            学习笔记
          </h1>
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        <div className="px-2.5 py-1.5 text-xs font-medium tracking-wide text-neutral-400 uppercase dark:text-neutral-500">
          科目
        </div>

        {subjects === undefined ? (
          <div className="px-2.5 py-2 text-sm text-neutral-400">加载中…</div>
        ) : subjects.length === 0 ? (
          <div className="px-2.5 py-2 text-sm text-neutral-400 dark:text-neutral-500">
            还没有科目
          </div>
        ) : (
          <ul className="space-y-0.5">
            {subjects.map((subject) => (
              <li key={subject.id}>
                <NavLink to={`/subjects/${subject.id}`} className={navLinkClass}>
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: subject.color }}
                    aria-hidden
                  />
                  <span className="truncate">{subject.name}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
        <button
          type="button"
          onClick={cycleTheme}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-100"
        >
          <span aria-hidden>◐</span>
          <span>主题：{themeLabel}</span>
        </button>
        <NavLink to="/dev/db-check" className={navLinkClass}>
          <span aria-hidden>◎</span>
          <span>数据库自检</span>
        </NavLink>
      </div>
    </aside>
  )
}
