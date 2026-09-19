/**
 * 科目配色。
 *
 * 选的是饱和度接近、在明暗两种主题下都能看清的一组颜色，
 * 避免出现某个科目在深色模式下几乎看不见的情况。
 */
export const SUBJECT_COLORS = [
  '#3b82f6', // 蓝
  '#8b5cf6', // 紫
  '#ec4899', // 粉
  '#ef4444', // 红
  '#f59e0b', // 橙
  '#10b981', // 绿
  '#06b6d4', // 青
  '#64748b', // 灰
] as const

/** 按已有科目数自动挑一个颜色，让新建的科目尽量不撞色 */
export function pickNextColor(usedColors: string[]): string {
  const unused = SUBJECT_COLORS.find((c) => !usedColors.includes(c))
  return unused ?? SUBJECT_COLORS[usedColors.length % SUBJECT_COLORS.length]
}
