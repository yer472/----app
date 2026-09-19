/**
 * 只做一件事：把 PNG 的 IHDR 读出来。
 *
 * 存在的理由是「图标尺寸不对」这类问题必须在生成时和验证时就被抓住——
 * Chromium 判定可安装性时要求 192 和 512 的真实位图，
 * 一个尺寸悄悄错了的 PNG 会让应用装不上，而报错信息完全不会提到图标。
 * 为此引入一个图像库不值得，IHDR 就在文件头，字节偏移是固定的。
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 颜色类型。6 = RGBA（带 alpha），2 = RGB，3 = 调色板。 */
export const COLOR_TYPE = { GRAYSCALE: 0, RGB: 2, PALETTE: 3, GRAYSCALE_ALPHA: 4, RGBA: 6 }

export function inspectPng(buffer) {
  if (buffer.length < 33) throw new Error('PNG 太短，连文件头都不完整')
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('文件头不是 PNG 签名')

  // 第一个 chunk 必定是 IHDR：长度(4) + 类型(4) + 数据(13) + CRC(4)
  const chunkType = buffer.subarray(12, 16).toString('ascii')
  if (chunkType !== 'IHDR') throw new Error(`第一个 chunk 是 ${chunkType}，应为 IHDR`)

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    bytes: buffer.length,
  }
}

/**
 * 断言一个图标文件符合预期。
 * @param {Buffer} buffer
 * @param {{size: number, transparent: boolean, label: string}} expect
 */
export function assertIcon(buffer, { size, transparent, label }) {
  const info = inspectPng(buffer)

  if (info.width !== size || info.height !== size) {
    throw new Error(`${label}: 尺寸是 ${info.width}x${info.height}，应为 ${size}x${size}`)
  }
  if (info.bitDepth !== 8) {
    throw new Error(`${label}: 位深是 ${info.bitDepth}，应为 8`)
  }
  if (transparent && info.colorType !== COLOR_TYPE.RGBA) {
    // 调色板 PNG 也能带透明度，但我们的生成路径产出的一定是 RGBA。
    // 这里退化说明 canvas 的 alpha 在某一步丢了，
    // 后果是图标在深色任务栏上被合成到黑色背景里。
    throw new Error(
      `${label}: 颜色类型是 ${info.colorType}，期望 RGBA(6)——透明度丢了，` +
        `深色任务栏上会变成黑底`,
    )
  }
  return info
}

/** 把 data:image/png;base64,... 解码成 Buffer，顺便校验前缀 */
export function decodeDataUrl(dataUrl, label = 'data URL') {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl ?? '')
  if (!match) throw new Error(`${label}: 不是 PNG 的 data URL`)
  return Buffer.from(match[1], 'base64')
}
