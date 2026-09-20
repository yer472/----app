import { Crepe, CrepeFeature } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { Fragment, Slice } from '@milkdown/kit/prose/model'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { resolveAssetUrl, toAssetUrl } from '@/lib/asset'
import { processImage } from '@/lib/image'
import { AttachmentRepository } from '@/repository'

/** 编辑器暴露给外部的命令。目前只有插图片一件事 */
export interface NoteEditorHandle {
  /**
   * 往光标处插入一张图片。
   *
   * 返回 false 表示编辑器还没准备好。调用方必须把这个失败显示出来——
   * 静默失败在这里特别容易发生（header 比编辑器先渲染），
   * 而用户看到的是「点了按钮没反应」。
   */
  insertImage: (assetUrl: string, caption: string) => boolean
}

interface NoteEditorProps {
  noteId: string
  /**
   * 初始正文。只在挂载时读取一次，之后的改动一律忽略——
   * 否则自动保存写回数据库、数据库又触发重渲染，编辑器会被反复重建。
   */
  initialMarkdown: string
  onChange: (markdown: string) => void
  ref?: Ref<NoteEditorHandle>
}

/**
 * 基于 Milkdown Crepe 的 Markdown 编辑器。
 *
 * 选用 Crepe（Milkdown 的完整版）而不是核心包，是因为它自带
 * 斜杠菜单、块操作手柄、占位提示和图片块，这些正是记笔记要用的，
 * 自己用核心包拼出来要写不少代码。底层仍然是同一个 ProseMirror。
 */
export function NoteEditor({
  noteId,
  initialMarkdown,
  onChange,
  ref,
}: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // 把 onChange 放进 ref，这样父组件每次重渲染换了新函数也不会重建编辑器
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  // 同理，初始正文只在挂载时取一次
  const initialMarkdownRef = useRef(initialMarkdown)

  // create() 是异步的，在那之前不能碰 editor。为 null 就说明还没就绪
  const crepeRef = useRef<Crepe | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      insertImage: (assetUrl, caption) => {
        const crepe = crepeRef.current
        if (!crepe) return false

        let inserted = false
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const schema = view.state.schema
          const imageType = schema.nodes['image-block']
          if (!imageType) return

          // 直接构造节点，**不要**拼一段 `![说明](url)` 再让解析器处理。
          //
          // image-block 的 Markdown 映射里，alt 槽位存的是**缩放比例**，
          // 说明文字走 title 槽位：
          //     parseMarkdown: ratio = Number(node.alt || 1), caption = node.title
          //     toMarkdown:    alt = ratio.toFixed(2),      title = caption
          // 所以手写 `![四杆机构](asset://x)` 会被解析成
          // Number('四杆机构') = NaN → 退回 1，说明文字被静默丢掉。
          // 正确写法是 `![1.00](asset://x "四杆机构")`，而构造节点天然就是对的。
          const node = imageType.create({ src: assetUrl, caption, ratio: 1 })

          const { from, to } = view.state.selection
          // 图后面补一个空段落：image-block 是个 atom 块节点，
          // 不留落点的话光标无处可去，用户会以为编辑器卡住了
          const paragraph = schema.nodes.paragraph?.createAndFill()
          const nodes = paragraph ? [node, paragraph] : [node]

          // replaceRange 收的是 Slice 而不是 Fragment。
          // maxOpen 让插入的块内容两端都能自然接合，不会把周围段落切碎
          view.dispatch(
            view.state.tr
              .replaceRange(from, to, Slice.maxOpen(Fragment.fromArray(nodes)))
              .scrollIntoView(),
          )
          inserted = true
        })

        return inserted
      },
    }),
    [],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 每个编辑器实例挂在自己的子元素上。
    // React 的开发模式会挂载两次，如果都直接往同一个根节点上建，
    // 先销毁的那个会把后建的那个的 DOM 一起清掉。
    const holder = document.createElement('div')
    container.appendChild(holder)

    const crepe = new Crepe({
      root: holder,
      defaultValue: initialMarkdownRef.current,
      featureConfigs: {
        [CrepeFeature.ImageBlock]: {
          // 粘贴/拖入图片时：压缩 -> 存进 IndexedDB -> 返回 asset:// 地址写进正文
          onUpload: async (file) => {
            const { blob, width, height } = await processImage(file)
            const attachment = await AttachmentRepository.createImage({
              noteId,
              blob,
              width,
              height,
            })
            return toAssetUrl(attachment.id)
          },
          // 渲染时把 asset:// 换成真正能加载的 blob 地址
          proxyDomURL: (url) => resolveAssetUrl(url),
          onImageLoadError: () => {
            // 单张图加载失败不该打断整篇笔记的编辑，静默即可
          },
        },
        [CrepeFeature.Placeholder]: {
          text: '开始记笔记…（输入 / 可以插入标题、列表、图片）',
        },
      },
    })

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        onChangeRef.current(markdown)
      })
    })

    let cancelled = false
    const ready = crepe.create()

    // 开发模式下这个 effect 会跑两遍：第一遍的实例要等 create() 完成后再销毁，
    // 否则会和第二遍的实例抢同一个 DOM。
    ready.then(() => {
      if (cancelled) {
        void crepe.destroy()
        return
      }
      crepeRef.current = crepe
    })

    return () => {
      cancelled = true
      crepeRef.current = null
      void ready
        .then(() => crepe.destroy())
        .finally(() => holder.remove())
    }
  }, [noteId])

  return <div ref={containerRef} className="note-editor" />
}
