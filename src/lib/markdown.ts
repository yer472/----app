/**
 * 把 Markdown 正文转成纯文本摘要。
 *
 * 用途：笔记列表和搜索结果的预览行。做的是「粗略去标记」，
 * 不追求完美的 Markdown 解析——摘要只是给人扫一眼的。
 */
export function toExcerpt(markdown: string, maxLength = 100): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ') // 代码块整体丢掉
    .replace(/`([^`]*)`/g, '$1') // 行内代码保留内容
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片丢掉
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只保留文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题的 #
    .replace(/^\s{0,3}>\s?/gm, '') // 引用
    .replace(/^\s{0,3}[-*+]\s+/gm, '') // 无序列表
    .replace(/^\s{0,3}\d+\.\s+/gm, '') // 有序列表
    .replace(/[*_~]/g, '') // 加粗/斜体/删除线的标记
    .replace(/\s+/g, ' ')
    .trim()

  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain
}

/** 从正文里提取一个默认标题：优先第一个标题行，其次第一行非空文字 */
export function deriveTitle(markdown: string, fallback: string): string {
  const lines = markdown.split('\n')
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/)
    if (heading?.[1]) return heading[1].slice(0, 80)
  }
  for (const line of lines) {
    const text = line.replace(/[*_~`>#-]/g, '').trim()
    if (text) return text.slice(0, 80)
  }
  return fallback
}
