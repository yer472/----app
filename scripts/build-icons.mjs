/**
 * 从 public/icon.svg 生成 manifest 需要的四个 PNG。
 *
 *   npm run icons
 *
 * 为什么需要浏览器：Node 里没有能把 SVG 栅格化的东西，而引入 sharp /
 * resvg 只为了四个图标不值得。本机必定有 Edge（这个应用就是给 Edge 用的），
 * 所以借它跑一次 canvas。
 *
 * 为什么不用 Page.captureScreenshot：截图要先把 viewport 和 clip 算对，
 * 尺寸差一个像素就得到一个 191x191 的图标，而 alpha 还依赖
 * setDefaultBackgroundColorOverride 被正确执行。直接画到 OffscreenCanvas 上，
 * 输出尺寸就是画布尺寸，alpha 是天然保证的。
 *
 * 生成物是确定性的，所以这个脚本不进 npm run build —— 只在 icon.svg 改动后手动跑。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchEdge } from './lib/cdp.mjs'
import { assertIcon, decodeDataUrl } from './lib/png.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SVG_PATH = path.join(root, 'public/icon.svg')
const OUT_DIR = path.join(root, 'public/icons')

const svgSource = await readFile(SVG_PATH, 'utf8')

// 图形的填充色从 icon.svg 里读，不在这里再写一遍字面量。
const fillMatch = /<g[^>]*\bfill="([^"]+)"/.exec(svgSource)
if (!fillMatch) {
  throw new Error('在 public/icon.svg 里找不到 <g fill="...">，没法确定品牌色')
}
const BRAND = fillMatch[1]

// 连 fill-rule 一起读出来，不能只取 d。
//
// Path2D 由 d 字符串构造时只带几何，**不带 fill-rule**——
// 而 ctx.fill(path) 用的是 canvas 上下文的 fill-rule，默认 nonzero。
// 结果是 evenodd 挖出来的洞（折角、横线）在 SVG 里是洞，在 canvas 里全被填实，
// favicon 和 PNG 长得不一样。必须把 fill-rule 显式传回 fill()。
const paths = [...svgSource.matchAll(/<path\b([^>]*)>/g)]
  .map((m) => {
    const attrs = m[1]
    const d = /\bd="([^"]+)"/.exec(attrs)?.[1]
    if (!d) return null
    const rule = /\bfill-rule="([^"]+)"/.exec(attrs)?.[1] ?? 'nonzero'
    if (rule !== 'nonzero' && rule !== 'evenodd') {
      throw new Error(`icon.svg 里的 fill-rule="${rule}" 不支持，只认 nonzero / evenodd`)
    }
    return { d, rule }
  })
  .filter(Boolean)

if (paths.length === 0) throw new Error('在 public/icon.svg 里没找到 <path d="...">')

console.log(
  `从 icon.svg 读到 ${paths.length} 条路径，品牌色 ${BRAND}，` +
    `fill-rule: ${paths.map((p) => p.rule).join(', ')}`,
)

// 四个变体。scale 是「图形占画布的比例」，按紧致包围盒算，不是按 512 的 viewBox。
//
// 两组必须同时改底色和图形色：maskable 会被系统裁成圆形或方圆形，
// 所以底色要满幅；而紫底上的紫图形等于没有图形，必须换成白色。
const VARIANTS = [
  { file: 'icon-192.png', size: 192, bg: null, scale: 0.8, color: BRAND, transparent: true },
  { file: 'icon-512.png', size: 512, bg: null, scale: 0.8, color: BRAND, transparent: true },
  {
    file: 'icon-maskable-192.png',
    size: 192,
    bg: BRAND,
    scale: 0.58,
    color: '#ffffff',
    transparent: false,
  },
  {
    file: 'icon-maskable-512.png',
    size: 512,
    bg: BRAND,
    scale: 0.58,
    color: '#ffffff',
    transparent: false,
  },
]

const { evaluate, close } = await launchEdge({ headless: true })

try {
  await evaluate(`document.body.innerHTML = ${JSON.stringify(svgSource)}; true`)

  const results = await evaluate(`
    (async () => {
      const PATHS = ${JSON.stringify(paths)}
      const VARIANTS = ${JSON.stringify(VARIANTS)}

      const group = document.querySelector('svg > g')
      if (!group) throw new Error('页面里的 SVG 结构不对，找不到 <g>')

      // 取紧致包围盒。图形的实际范围比 512 的 viewBox 小不少，
      // 按 viewBox 缩放会让图标在视觉上偏小一大圈。
      const box = group.getBBox()

      const toDataUrl = (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = () => reject(new Error('读取 PNG blob 失败'))
          reader.readAsDataURL(blob)
        })

      const out = {}
      for (const v of VARIANTS) {
        const canvas = new OffscreenCanvas(v.size, v.size)
        const ctx = canvas.getContext('2d')

        if (v.bg) {
          ctx.fillStyle = v.bg
          ctx.fillRect(0, 0, v.size, v.size)
        }

        // 等比缩放，取两个方向里更严格的那个，保证图形完整落在画布里
        const fit = Math.min(
          (v.size * v.scale) / box.width,
          (v.size * v.scale) / box.height,
        )
        ctx.setTransform(
          fit, 0, 0, fit,
          (v.size - box.width * fit) / 2 - box.x * fit,
          (v.size - box.height * fit) / 2 - box.y * fit,
        )
        ctx.fillStyle = v.color
        for (const p of PATHS) ctx.fill(new Path2D(p.d), p.rule)

        out[v.file] = await toDataUrl(await canvas.convertToBlob({ type: 'image/png' }))
      }
      return out
    })()
  `)

  await mkdir(OUT_DIR, { recursive: true })

  for (const variant of VARIANTS) {
    const buffer = decodeDataUrl(results[variant.file], variant.file)
    // 写完立刻自检。尺寸或透明度不对的话，装不上应用时的报错信息
    // 完全不会提到图标，所以必须在这里拦下来。
    const info = assertIcon(buffer, {
      size: variant.size,
      transparent: variant.transparent,
      label: variant.file,
    })
    await writeFile(path.join(OUT_DIR, variant.file), buffer)
    console.log(
      `  ${variant.file.padEnd(24)} ${info.width}x${info.height} ` +
        `colorType=${info.colorType} ${(info.bytes / 1024).toFixed(1)} KB`,
    )
  }

  console.log(`\n四个 PNG 已写入 public/icons/`)
} finally {
  await close()
}
