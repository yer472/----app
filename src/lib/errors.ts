/**
 * 错误处理的公共部分。
 *
 * 分类**不是为了措辞好听**，是为了避免给出会丢数据的建议：
 *
 *   - 「存储被禁用」可以建议刷新页面重试；
 *   - 「配额满了」不行——刷新多少次都一样，而用户一旦按「清理浏览器数据」
 *     去腾空间，几年的笔记就一起没了。
 *
 * 所以这一层的产出是「这是什么故障」+「该告诉他做什么、绝不能让做什么」，
 * 显示成什么样交给页面。
 */

export type ErrorKind = 'quota' | 'storage' | 'chunk' | 'unknown'

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error === null || error === undefined) return ''
  return String(error)
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

export function classifyError(error: unknown): ErrorKind {
  const name = nameOf(error)
  const text = `${name} ${textOf(error)}`

  if (/quota/i.test(text)) return 'quota'

  // Dexie / IndexedDB 打不开、被禁用、版本对不上。uiStore 里那句超时文案
  // （「本地数据库没有响应」）也归到这一类——它说的是同一件事。
  if (
    /InvalidStateError|DatabaseClosedError|MissingAPIError|VersionError/.test(text) ||
    /indexeddb|dexie|本地数据库/i.test(text)
  ) {
    return 'storage'
  }

  // 懒加载的分片没拉下来。这个应用里它几乎总是「离线缓存被清掉了」，
  // 不是网络问题——所以下面的建议跟一般的网页不一样。
  if (/dynamically imported module|importing a module script failed/i.test(text)) {
    return 'chunk'
  }

  return 'unknown'
}

/** 能直接显示给用户的一句话 */
export function errorMessage(error: unknown): string {
  return textOf(error) || '没有更多信息'
}

/** 给「详细信息 / 复制」用的完整内容 */
export function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return errorMessage(error)
  return [error.name, error.message, error.stack].filter(Boolean).join('\n')
}

/**
 * 这个故障该让用户做什么。
 *
 * ⚠️ 措辞要守住的底线：**任何一条都不许建议用户去清理浏览器数据**，
 * 那会连笔记一起删掉。要腾空间就导出备份 + 删几篇带图的笔记。
 */
export function adviceFor(kind: ErrorKind): string {
  switch (kind) {
    case 'quota':
      return '浏览器给这个站点的存储空间满了。先到「设置与备份」里导出一份备份，再删掉几篇带大图的笔记腾出空间。注意不要去清理浏览器数据——那会把笔记一起删掉。'
    case 'storage':
      return '笔记数据存在浏览器的 IndexedDB 里。请确认不是无痕/隐私模式、浏览器没有禁用本站的存储权限，然后刷新页面重试。'
    case 'chunk':
      return '应用的一个代码分片没有加载下来。如果刚清理过浏览器数据、或者刚更新过版本，跑一次 npm run serve 再打开一次就能恢复，笔记数据不受影响。'
    case 'unknown':
      return '可以先刷新页面重试。如果反复出现，把下面的详细信息记下来。'
  }
}

/**
 * 给「不需要 await、但失败也不能静默」的写操作用。
 *
 * 典型场景是列表里那种点一下就走的按钮（置顶、新建）：原来写成
 * `void repo.togglePin(id)`，失败时既没有提示也不会重试，控制台里躺着一条
 * 未处理的 rejection，而用户看到的是「点了没反应」。
 */
export function runGuarded(
  task: Promise<unknown>,
  onError: (message: string) => void,
): void {
  task.catch((error: unknown) => onError(errorMessage(error)))
}
