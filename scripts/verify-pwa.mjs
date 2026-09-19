/**
 * 端到端验证「装成桌面应用、平时不用开服务器」这件事真的成立。
 *
 *   npm run build && npm run verify:pwa
 *
 * 最后一步（关掉浏览器、服务器全程没启动、重新打开应用）是决定性的：
 * 它不过，就说明「平时不用开服务器」这个方案根本站不住。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServiceWorker } from './build-sw.mjs'
import { launchEdge, waitFor } from './lib/cdp.mjs'
import { inspectPng, COLOR_TYPE } from './lib/png.mjs'
import { createStaticServer, DEFAULT_PORT } from './serve.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = path.join(root, 'dist')
const ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`
const APP = `${ORIGIN}/`

// ---------------------------------------------------------------- 小测试框架

const results = []
let failures = 0

async function check(label, fn) {
  try {
    const detail = await fn()
    results.push({ label, ok: true })
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    results.push({ label, ok: false, error: error.message })
    console.log(`  ✗ ${label}`)
    console.log(`      ${error.message}`)
  }
}

/** 不通过只提醒，不算失败。用于那些 headless 下本来就会有噪声的检查 */
async function checkSoft(label, fn) {
  try {
    const detail = await fn()
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
  } catch (error) {
    console.log(`  ! ${label}（不作为失败）`)
    console.log(`      ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function section(title) {
  console.log(`\n${title}`)
}

// ------------------------------------------------------- 0. 静态检查（不开浏览器）

section('0. 静态检查')

const swSource = await readFile(path.join(DIST, 'sw.js'), 'utf8').catch(() => null)
assert(swSource, 'dist/sw.js 不存在——先跑 npm run build')

function extractArray(source, name) {
  const match = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n\\])`).exec(source)
  assert(match, `sw.js 里找不到 ${name}，生成逻辑可能变了`)
  return JSON.parse(match[1])
}

const precacheUrls = extractArray(swSource, 'PRECACHE_URLS')
const coreUrls = extractArray(swSource, 'CORE_URLS')

await check('预缓存清单的规模合理', () => {
  assert(
    precacheUrls.length > 100 && precacheUrls.length < 220,
    `预缓存条目数是 ${precacheUrls.length}，预期在 100-220 之间`,
  )
  return `${precacheUrls.length} 项，核心 ${coreUrls.length} 项`
})

await check('清单里该有的都有', () => {
  const required = [
    '/index.html',
    '/manifest.webmanifest',
    '/icon.svg',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/icon-maskable-192.png',
    '/icons/icon-maskable-512.png',
  ]
  const missing = required.filter((url) => !precacheUrls.includes(url))
  assert(missing.length === 0, `缺少 ${missing.join(', ')}`)

  assert(
    precacheUrls.some((u) => /^\/assets\/NotePage-.+\.js$/.test(u)),
    '没有预缓存 Milkdown 那个分片——离线时点开笔记会失败',
  )
  assert(
    precacheUrls.some((u) => /^\/assets\/KaTeX_.+\.woff2$/.test(u)),
    '没有预缓存 KaTeX 的 woff2 字体',
  )
  return 'index.html / manifest / 四个图标 / Milkdown 分片 / woff2 字体'
})

await check('字体过滤生效：零个 .woff 和 .ttf', () => {
  // 这是 scripts/build-sw.mjs 里 SKIP_EXT 的回归测试。
  // 每个 @font-face 都把 woff2 列在第一位，后面两个格式永远不会被请求，
  // 预缓存它们等于白占 798KB 和 40 个必然 miss 的请求。
  const dead = precacheUrls.filter((u) => /\.(woff|ttf)$/.test(u))
  assert(dead.length === 0, `仍然有 ${dead.length} 个：${dead.slice(0, 3).join(', ')}…`)
  return '省掉 40 个文件'
})

await check('sw.js 自己不在清单里', () => {
  assert(!precacheUrls.includes('/sw.js'), 'sw.js 被预缓存了，会导致无法更新')
})

await check('清单是排序过的（保证哈希确定性）', () => {
  const sorted = [...precacheUrls].sort()
  assert(
    sorted.every((url, i) => url === precacheUrls[i]),
    '清单没有排序，构建哈希会不稳定',
  )
})

// 注意读的是 BUILD_HASH 而不是 CACHE_NAME：模板里 CACHE_NAME 是一个
// 由 BUILD_HASH 拼出来的模板字符串（`xxbj-${BUILD_HASH}`），
// 生成的文件里并没有 `xxbj-<哈希>` 这样的字面量可以直接匹配。
const swBuildHash = /const BUILD_HASH = '([0-9a-f]+)'/.exec(swSource)?.[1]
const cacheName = swBuildHash ? `xxbj-${swBuildHash}` : null

await check('缓存名由内容哈希生成', () => {
  assert(swBuildHash, 'sw.js 里找不到 BUILD_HASH，生成逻辑可能变了')
  assert(
    /^[0-9a-f]{16}$/.test(swBuildHash),
    `哈希是 "${swBuildHash}"，预期 16 位十六进制`,
  )
  return cacheName
})

await check('构建是确定性的（无改动重建不换缓存名）', async () => {
  const before = await readFile(path.join(DIST, 'sw.js'), 'utf8')
  const result = await buildServiceWorker()
  const after = await readFile(path.join(DIST, 'sw.js'), 'utf8')
  assert(before === after, '连着构建两次得到的 sw.js 不一样——缓存名会无谓地翻新')
  assert(result.buildHash === swBuildHash, '重新生成的哈希和上一次不同')
  return '两次构建逐字节相同'
})

const manifest = JSON.parse(await readFile(path.join(DIST, 'manifest.webmanifest'), 'utf8'))

await check('manifest 的必填字段齐全', () => {
  assert(manifest.name || manifest.short_name, 'name / short_name 都没有')
  assert(manifest.start_url, '缺 start_url')
  assert(
    ['standalone', 'minimal-ui', 'fullscreen'].includes(manifest.display),
    `display 是 "${manifest.display}"，Chromium 只认 standalone/minimal-ui/fullscreen`,
  )
  assert(manifest.prefer_related_applications === false, 'prefer_related_applications 必须是 false')
  assert(manifest.id, '缺 id（应用身份会跟着 start_url 走，以后改 start_url 会变成另一个应用）')
  return `${manifest.name} · ${manifest.display}`
})

await check('图标同时有 192 和 512 的真实位图', () => {
  // SVG-only 会让 Chromium 把图标解析成 0x0，判定不可安装，
  // 而报错信息完全不会提到图标。
  const sizes = manifest.icons.filter((i) => i.purpose === 'any').map((i) => i.sizes)
  assert(sizes.includes('192x192'), 'any 图标里没有 192x192')
  assert(sizes.includes('512x512'), 'any 图标里没有 512x512')
  assert(
    manifest.icons.every((i) => !i.purpose.includes(' ')),
    'purpose 里同时写了 any 和 maskable——这个写法已废弃，渲染会错',
  )
  return `${manifest.icons.length} 条`
})

await check('四个 PNG 的尺寸和透明度都对', async () => {
  const expected = [
    { file: 'icon-192.png', size: 192, alpha: true },
    { file: 'icon-512.png', size: 512, alpha: true },
    { file: 'icon-maskable-192.png', size: 192, alpha: false },
    { file: 'icon-maskable-512.png', size: 512, alpha: false },
  ]
  for (const item of expected) {
    const buffer = await readFile(path.join(DIST, 'icons', item.file))
    const info = inspectPng(buffer)
    assert(
      info.width === item.size && info.height === item.size,
      `${item.file} 是 ${info.width}x${info.height}，应为 ${item.size}x${item.size}`,
    )
    if (item.alpha) {
      assert(
        info.colorType === COLOR_TYPE.RGBA,
        `${item.file} 的颜色类型是 ${info.colorType}，透明图标的 alpha 通道丢了`,
      )
    }
  }
  return '尺寸与 alpha 通道都正确'
})

await check('index.html 有 manifest、图标，以及按顺序排列的两条 theme-color', async () => {
  const html = await readFile(path.join(DIST, 'index.html'), 'utf8')
  assert(html.includes('rel="manifest"'), '没有引用 manifest')
  assert(html.includes('rel="icon"'), '没有 favicon')

  const metas = [...html.matchAll(/<meta\s+name="theme-color"\s+content="([^"]+)"/g)].map(
    (m) => m[1],
  )
  assert(metas.length === 2, `有 ${metas.length} 条 theme-color，应为 2 条`)
  // 顺序是契约：内联脚本和 uiStore.applyTheme 都按下标定位
  assert(metas[0] === '#ffffff', `第 0 条是 ${metas[0]}，应为浅色 #ffffff`)
  assert(metas[1] === '#171717', `第 1 条是 ${metas[1]}，应为深色 #171717`)
  return `浅色 ${metas[0]} / 深色 ${metas[1]}`
})

// ------------------------------------------------- 起服务器和浏览器

const serverLogs = []
const server = createStaticServer({
  verbose: false,
  onLog: (line) => serverLogs.push(line),
})
const running = await server.listen()

// 用自己建的目录，两次启动浏览器复用它（第 9 步要靠这个）
const profile = await mkdtemp(path.join(tmpdir(), 'xxbj-verify-'))

let edge = await launchEdge({ headless: true, profile })

async function goto(url, { timeout = 45_000 } = {}) {
  const loaded = edge.waitForLoad(30_000)
  await edge.call('Page.navigate', { url })
  await loaded
  await waitFor(() => edge.evaluate(`document.readyState === 'complete'`), {
    timeout,
    label: `${url} 加载完成`,
  })
}

async function waitForApp({ timeout = 60_000 } = {}) {
  await waitFor(
    () => edge.evaluate(`document.body.innerText.includes('学习笔记')`).catch(() => false),
    { timeout, label: '应用外壳渲染出来' },
  )
}

try {
  section('1. 加载应用')
  await goto(APP)
  await waitForApp()
  console.log(`  ✓ ${APP} 打开并渲染`)

  section('2. Service Worker 激活')

  await check('已激活，且 scope 正确', async () => {
    const info = await waitFor(
      async () => {
        const value = await edge.evaluate(`
          (async () => {
            const reg = await navigator.serviceWorker.ready
            return {
              secure: window.isSecureContext,
              state: reg.active?.state ?? null,
              scriptURL: reg.active?.scriptURL ?? null,
              scope: reg.scope,
              controller: navigator.serviceWorker.controller ? 'set' : null,
            }
          })()
        `)
        return value?.state === 'activated' ? value : null
      },
      { timeout: 60_000, label: 'Service Worker 激活（预缓存 148 项）' },
    )

    assert(info.secure, 'isSecureContext 是 false，SW 根本不该注册成功')
    assert(info.scriptURL?.endsWith('/sw.js'), `scriptURL 是 ${info.scriptURL}`)
    assert(info.scope === `${ORIGIN}/`, `scope 是 ${info.scope}，应为 ${ORIGIN}/`)
    // 首次加载时页面不该被接管——这是「不调 clients.claim()」的回归测试。
    // 调了 claim 的话，重建时新 SW 会立刻接管旧页面并删掉旧缓存，
    // 而旧页面还在按旧哈希请求文件。
    assert(
      info.controller === null,
      '首次加载就被接管了，说明调了 clients.claim()——重建时会弄坏正在编辑的页面',
    )
    return 'activated · scope=/ · 未被接管（符合设计）'
  })

  section('3. 清单（由浏览器解析，不是我们读文件）')

  await check('manifest 解析无错，且 Chromium 选中了真实位图图标', async () => {
    const manifestResult = await edge.call('Page.getAppManifest')
    const errors = manifestResult.errors ?? []
    assert(errors.length === 0, `解析报错：${errors.map((e) => e.message).join('; ')}`)
    assert(manifestResult.data, 'manifest 是空的')

    // 这一条是「Chromium 真的拿到了一张位图」的直接证据——
    // 如果图标是 SVG-only，会被解析成 0x0，这里就返回空。
    //
    // 返回的尺寸不能断言等于 192 或 512：Chromium 会按自己的 UI 需要
    // 重新缩放（实测给的是 144x144）。所以这里只断言「非空、正方形、
    // 够大」——真正要防的是「一张都没有」。
    const icons = await edge.call('Page.getManifestIcons')
    const primary = icons.primaryIcon
    assert(primary, 'Page.getManifestIcons 没返回图标——Chromium 可能把图标当成了 0x0')

    const buffer = Buffer.from(primary, 'base64')
    const info = inspectPng(buffer)
    assert(info.width === info.height, `图标不是正方形：${info.width}x${info.height}`)
    assert(info.width >= 144, `图标只有 ${info.width}px，太小了`)
    return `解析无误，Chromium 给出 ${info.width}x${info.height} 的位图`
  })

  await checkSoft('installability 无报错', async () => {
    const result = await edge.call('Page.getInstallabilityErrors')
    const errors = result.installabilityErrors ?? []
    assert(errors.length === 0, JSON.stringify(errors))
    return '（headless 下这一项本来就会有噪声，仅供参考）'
  })

  section('4. 预缓存完整性')

  await check('缓存里的内容与清单逐条对得上', async () => {
    // 这是唯一能拦住「几十个文件静默缓存失败、等离线了才发现」的检查
    const actual = await edge.evaluate(`
      (async () => {
        const names = await caches.keys()
        if (names.length !== 1) return { error: '缓存数量不是 1', names }
        const cache = await caches.open(names[0])
        return {
          cacheName: names[0],
          stored: (await cache.keys()).map((r) => new URL(r.url).pathname).sort(),
        }
      })()
    `)
    assert(!actual.error, `${actual.error}：${JSON.stringify(actual.names)}`)
    assert(
      actual.cacheName === cacheName,
      `缓存名是 ${actual.cacheName}，sw.js 里算出来的是 ${cacheName}`,
    )

    const missing = precacheUrls.filter((url) => !actual.stored.includes(url))
    assert(missing.length === 0, `有 ${missing.length} 项没缓存成功：${missing.slice(0, 5).join(', ')}`)

    const extra = actual.stored.filter((url) => !precacheUrls.includes(url))
    assert(extra.length === 0, `多出 ${extra.length} 项：${extra.slice(0, 5).join(', ')}`)
    return `${actual.stored.length} 项全部命中`
  })

  section('5. 请求分发规则')

  await check('blob: URL 不被拦截（笔记里的图片就是 blob:）', async () => {
    // blob: 的 origin 就是页面的 origin，所以「先判 origin 再判协议」
    // 会把图片请求也拦下来，而 CacheStorage 只接受 http(s)，
    // 缓存操作会直接抛——笔记里的图全挂。
    const result = await edge.evaluate(`
      (async () => {
        const url = URL.createObjectURL(new Blob(['ok'], { type: 'text/plain' }))
        try {
          const text = await (await fetch(url)).text()
          return { text, caches: (await caches.keys()).length }
        } finally {
          URL.revokeObjectURL(url)
        }
      })()
    `)
    assert(result.text === 'ok', `取回的内容是 "${result.text}"，说明被 SW 拦坏了`)
    assert(result.caches === 1, `缓存数量变成了 ${result.caches}，blob: 被塞进了缓存`)
    return '内容正常，且没有污染缓存'
  })

  await check('非 GET 请求放行到网络', async () => {
    // 服务器的非 GET 一律回 405。如果 SW 错误地把缓存的 index.html 回给它，
    // 这里会拿到 200——那就是一个纯粹的 bug。
    const status = await edge.evaluate(`
      fetch('/', { method: 'POST' }).then((r) => r.status).catch((e) => String(e))
    `)
    assert(status === 405, `POST / 拿到了 ${status}，预期 405（被 SW 拦截了？）`)
    return 'POST 拿到 405，未被缓存劫持'
  })

  section('6. 导航回退')

  await check('客户端路由由 SW 应答，服务器完全没参与', async () => {
    const before = serverLogs.length
    await goto(`${ORIGIN}/settings`)
    await waitFor(() => edge.evaluate(`document.body.innerText.includes('设置')`), {
      label: '设置页渲染',
    })

    const newLines = serverLogs.slice(before)
    const settingsHit = newLines.filter((line) => line.includes('/settings'))
    assert(
      settingsHit.length === 0,
      `服务器收到了 ${settingsHit.length} 次 /settings 请求：${settingsHit.join(' | ')}`,
    )
    return `服务器零请求，SW 用缓存的外壳应答了 ${newLines.length} 个资源请求`
  })

  await check('服务器没有收到任何 woff/ttf 请求', () => {
    // 注意这条可能因为「这一轮压根没渲染数学公式」而空过。
    // 真正的保证在上面第 0 节：预缓存清单里零个 woff/ttf。
    // 这里只是用实际请求再确认一次——一旦哪天有页面真的去要了，
    // 它就会立刻变红。
    const fonts = serverLogs.filter((line) => /KaTeX_/.test(line))
    const dead = fonts.filter((line) => /\.(woff|ttf)\b/.test(line))
    assert(dead.length === 0, `居然请求了 ${dead.length} 个 woff/ttf：${dead.slice(0, 2).join(' | ')}`)
    return fonts.length > 0
      ? `${fonts.length} 次字体请求，全是 woff2`
      : '本轮没有渲染公式，没有字体请求（清单层面的保证见第 0 节）'
  })

  section('7. 离线（先合成，再真的把服务器杀掉）')

  await check('断网后仍然能打开', async () => {
    await edge.call('Network.enable')
    await edge.call('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    })
    // 关键一步：不清 HTTP 磁盘缓存的话，Chromium 自己就能合法地满足请求，
    // 这个测试就什么都没证明。注意它清的是 HTTP 缓存，不动 CacheStorage。
    await edge.call('Network.clearBrowserCache')

    const loaded = edge.waitForLoad(30_000)
    await edge.call('Page.reload', { ignoreCache: true })
    await loaded
    await waitForApp({ timeout: 30_000 })

    await edge.call('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    return 'HTTP 缓存清空后依然渲染'
  })

  await check('真的杀掉服务器进程，端口拒绝连接', async () => {
    await running.close()
    // 这个重试循环不能省：不确认端口真的死了，后面的测试全是空的
    await waitFor(
      async () => {
        try {
          await fetch(APP, { signal: AbortSignal.timeout(500) })
          return false
        } catch {
          return true // ECONNREFUSED
        }
      },
      { timeout: 15_000, interval: 200, label: '服务器端口停止响应' },
    )
    return `${ORIGIN} 已拒绝连接`
  })

  await check('服务器全死的情况下打开深层路由', async () => {
    await goto(`${ORIGIN}/search`)
    await waitFor(() => edge.evaluate(`Boolean(document.querySelector('input[type="search"]'))`), {
      label: '搜索页渲染',
    })

    // 再来一个多段路径，证明回退不是只对单段路径有效
    await goto(`${ORIGIN}/subjects/nope/chapters/nope`)
    await waitFor(() => edge.evaluate(`document.querySelector('#root').children.length > 0`), {
      label: '多段路由渲染出外壳',
    })
    return '/search 和 /subjects/.../chapters/... 都从缓存打开了'
  })

  section('8. 关掉浏览器重开，服务器全程没启动（决定性的一条）')

  await check('重启浏览器后应用仍然打得开', async () => {
    // 先礼后兵地关掉 Edge，让 profile 落盘——
    // Service Worker 的注册记录就在 profile 里，硬杀进程可能丢掉它
    await edge.close()

    // 换一个调试端口重开，profile 还是同一个
    edge = await launchEdge({ headless: true, profile })

    await goto(APP)
    await waitForApp({ timeout: 30_000 })

    const state = await edge.evaluate(`
      (async () => {
        const reg = await navigator.serviceWorker.getRegistration()
        const names = await caches.keys()
        return {
          hasRegistration: Boolean(reg?.active),
          scope: reg?.scope ?? null,
          caches: names,
          controlled: Boolean(navigator.serviceWorker.controller),
        }
      })()
    `)
    assert(state.hasRegistration, 'SW 的注册记录没撑过浏览器重启')
    assert(state.caches.includes(cacheName), `缓存没了，现存 ${JSON.stringify(state.caches)}`)
    assert(state.controlled, '这次页面没有被 SW 接管，说明注册虽然还在但没生效')
    return `注册与缓存都还在（${state.caches.join(', ')}），本次已被接管`
  })
} finally {
  await edge?.close().catch(() => {})
  await running.close().catch(() => {})
  await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

// ---------------------------------------------------------------- 汇总

const passed = results.filter((r) => r.ok).length
console.log(`\n${'─'.repeat(60)}`)
if (failures === 0) {
  console.log(`全部通过：${passed}/${results.length}`)
  console.log('「装成应用、平时不用开服务器」这个方案成立。')
} else {
  console.log(`失败 ${failures} 项，通过 ${passed}/${results.length}`)
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  ✗ ${r.label}\n      ${r.error}`)
  }
  process.exitCode = 1
}
