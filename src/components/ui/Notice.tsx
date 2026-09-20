import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type NoticeTone = 'info' | 'ok' | 'warn' | 'error'

/**
 * 一条贴在页面里的提示（不是浮层、不是 Toast）。
 *
 * 原来它是 `SettingsPage` 里的一个私有函数，别处要用只能再抄一份；
 * M4.5 给删除确认、新建笔记这些写路径补失败提示时正好需要它，
 * 就提到 `ui/` 下共用。
 *
 * 做成整块常驻而不是自动消失的浮层：这个应用里的提示都是「你需要读一下」
 * 的类型（备份失败、文件被删了、权限要重新给），自动消失的 Toast 反而会让
 * 人错过——而且做一个会自己消失的东西，就得处理「消失之后用户还想看」的问题。
 */
export function Notice({
  tone,
  children,
  className,
}: {
  tone: NoticeTone
  children: ReactNode
  className?: string
}) {
  const tones: Record<NoticeTone, string> = {
    info: 'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-800/40 dark:text-neutral-300',
    ok: 'border-green-300 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300',
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
    error:
      'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  }

  return (
    <div className={cn('rounded-md border px-3 py-2 text-sm', tones[tone], className)}>
      {children}
    </div>
  )
}
