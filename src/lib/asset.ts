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
 * 覆盖某个附件之后，让正文里那张图立刻显示新内容。
 *
 * 光清掉缓存是不够的，这点很容易漏：resolveAssetUrl 按附件 id 缓存 blob URL，
 * 而编辑器里的 `<img>` **已经拿着旧地址了**——清缓存不会让它回头重新解析。
 * 结果就是数据库里明明是新的，屏幕上还是旧的，而且刷新也不一定好
 * （取决于旧 blob URL 有没有被释放）。
 *
 * 所以这里除了清缓存，还要把页面上仍指向旧地址的 `<img>` 直接换掉。
 * 比想办法让 ProseMirror 重渲染那个节点可靠得多——从外部没有稳定的
 * 办法只重渲染一个 image 节点。
 */
export async function refreshAssetImages(attachmentId: string): Promise<void> {
  const staleUrl = blobUrlCache.get(attachmentId)

  // 顺序要紧：必须先清缓存再重新解析，否则拿回来的还是旧地址。
  // 但旧地址不能马上释放——它可能正被屏幕上的图用着，释放了会变成死链。
  blobUrlCache.delete(attachmentId)
  inflight.delete(attachmentId)

  const freshUrl = await resolveAssetUrl(toAssetUrl(attachmentId))
  if (!freshUrl) return

  if (staleUrl && staleUrl !== freshUrl) {
    for (const img of document.querySelectorAll('img')) {
      // img.src 返回的是解析后的绝对地址，blob: 本身就是绝对的，可以直接比
      if (img.src === staleUrl) img.src = freshUrl
    }
    URL.revokeObjectURL(staleUrl)
  }
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
