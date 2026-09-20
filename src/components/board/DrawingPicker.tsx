import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Loading } from '@/components/ui/Loading'
import { Modal } from '@/components/ui/Modal'
import { resolveAssetUrl, toAssetUrl } from '@/lib/asset'
import { formatDateTime } from '@/lib/time'
import type { Attachment } from '@/types/models'

interface DrawingPickerProps {
  open: boolean
  /** 本篇笔记里的图形。undefined 表示还在加载 */
  drawings: Attachment[] | undefined
  onClose: () => void
  onCreate: () => void
  onEdit: (attachment: Attachment) => void
}

/**
 * 图形列表。
 *
 * 为什么要有这个面板：正文里的图是一行 `![1.00](asset://id)`，也就是
 * 一张普通的 Markdown 图片，Crepe 的图片块没有暴露点击回调。
 * 为「点图就能编辑」去写一个自定义的 ProseMirror 节点视图，
 * 是这块功能里最不划算的投入——所以改成在这里列出来点开。
 */
export function DrawingPicker({
  open,
  drawings,
  onClose,
  onCreate,
  onEdit,
}: DrawingPickerProps) {
  return (
    <Modal open={open} title="本篇笔记的图形" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Button variant="primary" onClick={onCreate}>
          新建图形
        </Button>

        {drawings === undefined ? (
          <Loading className="py-6" />
        ) : drawings.length === 0 ? (
          <EmptyState
            title="还没有图形"
            description="点下面的按钮画一张。画好的图会插到正文的光标位置。"
            // 空状态里的按钮要和上面那个「新建图形」做同一件事：空的时候
            // 用户的视线正落在这里，让他在原地就能动手
            action={
              <Button variant="primary" onClick={onCreate}>
                新建图形
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {drawings.map((attachment, index) => (
              <li
                key={attachment.id}
                className="flex items-center gap-3 rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
              >
                <DrawingThumb attachment={attachment} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-800 dark:text-neutral-200">
                    图形 {index + 1}
                  </div>
                  <div className="text-xs text-neutral-400 dark:text-neutral-500">
                    {formatDateTime(attachment.createdAt)}
                  </div>
                </div>
                <Button size="sm" onClick={() => onEdit(attachment)}>
                  编辑
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

/** 缩略图。走的是和正文图片同一个 asset:// 解析，不额外造一套 */
function DrawingThumb({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState('')

  useEffect(() => {
    let cancelled = false
    void resolveAssetUrl(toAssetUrl(attachment.id)).then((resolved) => {
      if (!cancelled) setUrl(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [attachment.id])

  if (!url) {
    return (
      <div className="h-14 w-20 shrink-0 rounded bg-neutral-100 dark:bg-neutral-800" />
    )
  }

  return (
    <img
      src={url}
      alt=""
      // paper-figure：深色下压暗 + 补一道边框，和正文里那张图是同一个效果
      // （定义在 index.css）。图纸本身是白底的，不压的话深色下是一小块白斑。
      className="paper-figure h-14 w-20 shrink-0 rounded object-contain ring-1 ring-neutral-200 dark:ring-0"
    />
  )
}
