import type { ISODateTime } from '@/types/models'

export function now(): ISODateTime {
  return new Date().toISOString()
}

/** 2026-09-19 19:49 */
export function formatDateTime(iso: ISODateTime): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 2026-09-19 */
export function formatDate(iso: ISODateTime): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 「刚刚」「3 小时前」「昨天」这类相对时间，列表里比绝对时间好读 */
export function formatRelative(iso: ISODateTime): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''

  const diffMs = Date.now() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)

  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`

  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小时前`

  const diffDay = Math.floor(diffHour / 24)
  if (diffDay === 1) return '昨天'
  if (diffDay < 30) return `${diffDay} 天前`

  return formatDate(iso)
}
