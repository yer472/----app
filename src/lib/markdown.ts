/**
 * 把 Markdown 正文转成纯文本。
 *
 * 做的是「粗略去标记」，不追求完美的 Markdown 解析——摘要和搜索片段
 * 都只是给人扫一眼的，为此引一个 Markdown 解析器不划算。
 *
 * 搜索功能也依赖它：直接拿原始正文匹配的话，搜「asset」会命中每一张图，
 * 搜「##」会命中每一个标题，结果里全是噪声。
 */
export function toPlainText(markdown: string): string {
  return markdown
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
}

/** 纯文本摘要，用于笔记列表和搜索结果的预览行 */
export function toExcerpt(markdown: string, maxLength = 100): string {
  const plain = toPlainText(markdown)
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain
}

/**
 * 从纯文本里截出关键词周围的一段。
 *
 * 搜索结果只显示命中处附近的内容，而不是从头开始的摘要——
 * 否则一篇长笔记里命中的位置在中间时，用户根本看不到关键词。
 */
export function makeSnippet(
  plain: string,
  matchIndex: number,
  matchLength: number,
  before = 24,
  after = 70,
): { text: string; prefix: string; suffix: string } {
  const start = Math.max(0, matchIndex - before)
  const end = Math.min(plain.length, matchIndex + matchLength + after)

  const text = plain.slice(start, end)
  return {
    text,
    prefix: start > 0 ? '…' : '',
    suffix: end < plain.length ? '…' : '',
  }
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
