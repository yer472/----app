/** 处理后的图片：已压缩、已确定尺寸 */
export interface ProcessedImage {
  blob: Blob
  width: number
  height: number
}

/** 长边上限。1600px 足够看清课件和板书，再大只是白占空间 */
const MAX_EDGE = 1600
const JPEG_QUALITY = 0.8

function encode(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('图片编码失败'))
      },
      type,
      quality,
    )
  })
}

/**
 * 压缩图片。
 *
 * 输出格式跟着输入走，而不是一律转 JPEG：
 * - 截图（Win+Shift+S）是 PNG，文字边缘用 PNG 存更清晰、体积也常常更小，
 *   而且能保住透明区域；
 * - 手机拍的照片是 JPEG，重新编码成 JPEG 不会有额外损失。
 *
 * 一律转 JPEG 的话，文字截图会出现振铃状的糊边，这是压缩算法本身的特性，
 * 不是质量问题调参数能解决的。
 */
export async function processImage(file: Blob): Promise<ProcessedImage> {
  const bitmap = await createImageBitmap(file)

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器不支持 canvas，无法处理图片')

    const keepPng = file.type === 'image/png'
    if (!keepPng) {
      // JPEG 没有透明通道，透明区域会变黑，先铺一层白底
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
    }

    ctx.drawImage(bitmap, 0, 0, width, height)

    const processed = keepPng
      ? await encode(canvas, 'image/png')
      : await encode(canvas, 'image/jpeg', JPEG_QUALITY)

    // 压缩后反而更大就别要了（比如本来就很小、或者已经被压过的图）
    const blob = processed.size < file.size ? processed : file

    return { blob, width, height }
  } finally {
    // createImageBitmap 占的是非托管内存，不显式释放会一直留着
    bitmap.close()
  }
}
