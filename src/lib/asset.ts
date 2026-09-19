import { AttachmentRepository } from '@/repository'

const ASSET_PREFIX = 'asset://'

/**
 * 正文里的图片用 `![说明](asset://<附件id>)` 引用。
 *
 * 用自定义协议而不是直接存 blob: URL，是因为 blob URL 只在当前页面会话里有效，
 * 存进数据库下次打开就是一串死链。存附件 id 则永远能找回来。
 */
export function toAssetUrl(attachmentId: string): string {
  return `${ASSET_PREFIX}${attachmentId}`
}

export function parseAssetId(url: string): string | null {
  return url.startsWith(ASSET_PREFIX) ? url.slice(ASSET_PREFIX.length) : null
}

// asset id -> blob URL。
// 必须缓存：编辑器每次重渲染都会重新问一次地址，
// 每次都新建 blob URL 会持续泄漏内存。
const blobUrlCache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

/**
 * 把正文里的 asset:// 地址解析成浏览器能真正加载的地址。
 *
 * 不是 asset:// 的（外链图片、data URL）原样返回，不做任何处理。
 */
export async function resolveAssetUrl(url: string): Promise<string> {
  const attachmentId = parseAssetId(url)
  if (!attachmentId) return url

  const cached = blobUrlCache.get(attachmentId)
  if (cached) return cached

  const existing = inflight.get(attachmentId)
  if (existing) return existing

  const task = (async () => {
    try {
      const attachment = await AttachmentRepository.get(attachmentId)
      // 附件被删了（比如笔记回退到了旧版本）。返回空串让 onImageLoadError 去处理，
      // 不要抛错——一张图挂掉不该影响整篇笔记的渲染。
      if (!attachment) return ''
      const blobUrl = URL.createObjectURL(attachment.blob)
      blobUrlCache.set(attachmentId, blobUrl)
      return blobUrl
    } finally {
      inflight.delete(attachmentId)
    }
  })()

  inflight.set(attachmentId, task)
  return task
}

/**
 * 释放所有 blob URL。
 *
 * 在笔记页卸载、编辑器已经销毁之后调用。
 * 不清的话，翻几十篇带图的笔记就会攒下几百个 blob 占着内存。
 */
export function revokeAllAssetUrls(): void {
  for (const url of blobUrlCache.values()) URL.revokeObjectURL(url)
  blobUrlCache.clear()
  inflight.clear()
}
