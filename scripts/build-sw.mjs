/**
 * 构建后生成 dist/sw.js。
 *
 * 由 vite.config.ts 的 closeBundle 钩子调用（所以直接跑 vite build 也不会漏），
 * 也可以单独跑：node scripts/build-sw.mjs
 *
 * 三件事：
 *   1. 走一遍 dist/，得到预缓存清单
 *   2. 清单内容算一个哈希当缓存名
 *   3. 把清单和哈希填进 sw.template.js，写出 dist/sw.js
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = path.join(root, 'dist')

/**
 * 不预缓存的扩展名。
 *
 * .woff / .ttf：每个 KaTeX 的 @font-face 都把 woff2 列在 src 的第一位，
 * 而 Edge 支持 woff2——后面两个格式永远不会被请求。
 * 这一条省掉 40 个文件约 798KB 的预缓存，以及一堆必然 miss 的请求。
 *
 * .map：生产构建默认不产出，但万一开了 sourcemap 也不该塞进离线缓存。
 */
const SKIP_EXT = new Set(['.woff', '.ttf', '.map'])

async function walk(dir, prefix = '') {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), relative)))
    else out.push(relative)
  }
  return out
}

export async function buildServiceWorker() {
  const all = (await walk(DIST)).sort()
  const urls = all.filter(
    (url) => url !== '/sw.js' && !SKIP_EXT.has(path.extname(url).toLowerCase()),
  )

  if (urls.length === 0) throw new Error(`dist/ 是空的，先跑一次 vite build`)

  // 缓存名取自**内容**而不是 mtime。
  // 这样「没改代码的重新构建」会得到同一个缓存名，不会白白重刷几 MB 的缓存。
  const hash = createHash('sha256')
  for (const url of urls) {
    hash.update(url)
    hash.update(await readFile(path.join(DIST, url)))
  }
  const buildHash = hash.digest('hex').slice(0, 16)

  // 核心资源：缺了就没法降级，必须整个装成功。
  // 判据是「缺了会不会导致应用坏掉」——
  //   JS/CSS 分片、index.html：缺了应用就是坏的
  //   字体（有 fallback）、图标（系统已缓存）、manifest（装完就不再读）：能降级
  const core = urls.filter((url) => url === '/index.html' || /^\/assets\/.+\.(js|css)$/.test(url))

  // 交叉检查：index.html 引用的资源必须在清单里。
  // 这道检查是为了在 Vite 改掉产物命名规则、导致上面的正则悄悄匹配不到时报警——
  // 那种情况下 core 会变成空集，保护静默失效。
  const html = await readFile(path.join(DIST, 'index.html'), 'utf8')
  for (const match of html.matchAll(/\/assets\/[^"']+\.(?:js|css)/g)) {
    if (!urls.includes(match[0])) {
      throw new Error(`index.html 引用了不存在的资源 ${match[0]}，dist/ 可能不完整`)
    }
  }
  if (core.length === 0) {
    throw new Error('核心资源清单是空的，index.html 和分片的识别规则可能失效了')
  }

  const template = await readFile(path.join(root, 'scripts/sw.template.js'), 'utf8')
  const output = template
    .replaceAll('__BUILD_HASH__', buildHash)
    .replaceAll('__PRECACHE_URLS__', JSON.stringify(urls, null, 2))
    .replaceAll('__CORE_URLS__', JSON.stringify(core, null, 2))

  // sw.template.js 是纯 JS，tsc 不会看它，oxlint 也查不出运行时错误。
  // 编译一次能抓住语法错误，而且不执行——比等用户在浏览器里发现强。
  try {
    new vm.Script(output, { filename: 'sw.js' })
  } catch (e) {
    throw new Error(`生成的 sw.js 有语法错误: ${e.message}`)
  }

  await writeFile(path.join(DIST, 'sw.js'), output)

  return {
    count: urls.length,
    coreCount: core.length,
    buildHash,
    skipped: all.length - urls.length,
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const result = await buildServiceWorker()
  console.log(
    `dist/sw.js: 预缓存 ${result.count} 项（其中核心 ${result.coreCount} 项），` +
      `跳过 ${result.skipped} 项，缓存名 xxbj-${result.buildHash}`,
  )
}
