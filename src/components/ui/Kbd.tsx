import type { ReactNode } from 'react'

/**
 * 一个键帽。
 *
 * 抽出来是因为设置页的快捷键一览里要用三十来次，而侧栏那个搜索入口
 * 原本就有一份同样的写法。类名保持原样别改——侧栏那个的宽度是照着
 * 「Ctrl K」六个字符挑的，改字号会把它撑变形。
 */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="shrink-0 rounded border border-neutral-200 px-1 text-[10px] whitespace-nowrap text-neutral-400 dark:border-neutral-600 dark:text-neutral-500">
      {children}
    </kbd>
  )
}
