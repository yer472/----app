import type { ReactNode } from 'react'
import { adviceFor, classifyError, errorMessage, type ErrorKind } from '@/lib/errors'
import { cn } from '@/lib/cn'

/**
 * 「这里坏了」的整块提示。
 *
 * 和 `EmptyState`（虚线边、说「这里还空着」）刻意长得不一样：虚线读作
 * 待填充，实线红读作出错了。两者混用会让人分不清「没有数据」和「读不出来」——
 * 而这两种情况的处理方式完全不同。
 *
 * 故障分类和「该建议什么、绝不能让用户做什么」都在 `lib/errors.ts` 里，
 * 这里只负责显示。调用方可以覆盖掉默认建议（比如启动时那句已经有更具体的
 * 排查步骤）。
 */
interface ErrorStateProps {
  title: string
  /** 原始错误。分类和建议由它推出来 */
  error?: unknown
  /** 覆盖默认建议 */
  advice?: string
  /** 覆盖分类（不传就从 error 推） */
  kind?: ErrorKind
  /** 原始信息，默认折叠在一个 details 里 */
  className?: string
  children?: ReactNode
}

export function ErrorState({
  title,
  error,
  advice,
  kind,
  className,
  children,
}: ErrorStateProps) {
  const resolvedKind = kind ?? (error !== undefined ? classifyError(error) : 'unknown')

  return (
    <div
      className={cn(
        'rounded-lg border border-red-300 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950/40',
        className,
      )}
    >
      <h1 className="text-base font-semibold text-red-900 dark:text-red-200">
        {title}
      </h1>

      {error !== undefined ? (
        <p className="mt-2 text-sm break-words text-red-800 dark:text-red-300">
          {errorMessage(error)}
        </p>
      ) : null}

      <p className="mt-3 text-sm text-red-800 dark:text-red-300">
        {advice ?? adviceFor(resolvedKind)}
      </p>

      {children ? <div className="mt-4">{children}</div> : null}

      {/* 原始信息收在折叠里：出错时它是最有用的东西，但平时不该占着屏幕 */}
      {error instanceof Error && error.stack ? (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-red-700 select-none dark:text-red-400">
            详细信息
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-white/60 p-2 text-[11px] whitespace-pre-wrap text-red-900 dark:bg-black/30 dark:text-red-200">
            {error.stack}
          </pre>
        </details>
      ) : null}
    </div>
  )
}
