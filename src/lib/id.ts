/** 生成一个新的实体 ID */
export function newId(): string {
  // crypto.randomUUID 在安全上下文（https / localhost）下才可用。
  // 开发时跑在 localhost 上没问题，这里仍留一个降级分支以防万一。
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
