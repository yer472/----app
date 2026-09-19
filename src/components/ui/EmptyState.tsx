import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-300 px-6 py-16 text-center dark:border-neutral-700">
      {icon ? (
        <div className="text-3xl opacity-60" aria-hidden>
          {icon}
        </div>
      ) : null}
      <div className="text-base font-medium text-neutral-800 dark:text-neutral-200">
        {title}
      </div>
      {description ? (
        <p className="max-w-sm text-sm text-neutral-500 dark:text-neutral-400">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
