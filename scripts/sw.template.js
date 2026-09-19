/**
 * 学习笔记的 Service Worker。
 *
 * 这个文件不是最终产物——scripts/build-sw.mjs 会把下面三个占位符替换掉，
 * 写出 dist/sw.js。改这里，不要改 dist/sw.js（每次构建都会被覆盖）。
 *
 * 设计上唯一不显然但最要紧的一条：**install 里不调 skipWaiting()，
 * activate 里不调 clients.claim()**。原因写在 activate 的注释里。
 */

const BUILD_HASH = '__BUILD_HASH__'
const CACHE_NAME = `xxbj-${BUILD_HASH}`
const PRECACHE_URLS = __PRECACHE_URLS__
const CORE_URLS = __CORE_URLS__

/** 应用外壳。所有导航都回它，路径解析交给 React Router */
const SHELL = '/index.html'

/** 页面用来通知「用户同意更新了」的消息类型 */
const SKIP_WAITING = 'XXBJ_SKIP_WAITING'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)

      // 逐个 fetch，不用 cache.addAll。
      // addAll 是一次原子的多请求，任何一个 404 都会整体 reject——
      // 连「大部分资源已经缓存好了」这个中间状态都拿不到。
      // 这里要的是「尽量多缓存，但核心必须齐」。
      const results = await Promise.allSettled(
        PRECACHE_URLS.map(async (url) => {
          // cache: 'reload' 绕过 HTTP 缓存，确保拿到的是本次构建的字节。
          // 否则在刚构建完、服务器还在发旧文件的窗口期里，
          // 会把上一版的内容存进这一版的缓存。
          const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' })
          if (!response.ok) throw new Error(`${url} -> ${response.status}`)
          await cache.put(url, response)
          return url
        }),
      )

      const failed = results
        .map((result, index) => (result.status === 'rejected' ? PRECACHE_URLS[index] : null))
        .filter(Boolean)

      // 核心资源缺一个就整个装不上。
      // 宁可不装 SW（在线用完全正常，只是暂时没有离线能力），
      // 也不要一个「能启动、点进笔记就崩」的壳子——
      // 后者用户根本不知道发生了什么。
      const failedCore = failed.filter((url) => CORE_URLS.includes(url))
      if (failedCore.length > 0) {
        await caches.delete(CACHE_NAME)
        throw new Error(`核心资源预缓存失败: ${failedCore.join(', ')}`)
      }
      if (failed.length > 0) {
        // 字体、图标这类缺了能降级，只记一笔
        console.warn('[sw] 非核心资源未缓存:', failed)
      }
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 只在 activate 里删旧缓存，而且要连带下面两条一起理解：
      //
      // 场景：用户开着应用，我们重新构建。Vite 的 emptyOutDir 会删掉旧的
      // 哈希分片，写进新的一批。此时运行中的页面内存里还是旧模块图，
      // 它懒加载 NotePage 时请求的是**新**哈希的文件。
      //
      // 如果新 SW 立刻接管并清掉旧缓存：那个新文件在旧缓存里没有，
      // 旧文件又已经被删——路由会静默挂掉，直到用户碰巧刷新一次。
      //
      // 所以这里不 claim、install 里也不 skipWaiting：新 SW 停在 waiting，
      // 两个缓存并存，旧页面继续由旧 SW 用旧缓存服务，所有旧哈希都还解析得到。
      // 用户点了「更新」才 skipWaiting → activate 清旧缓存 →
      // controllerchange → 页面重载。缓存被销毁的时候页面本来就在重载了。
      const names = await caches.keys()
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      )
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === SKIP_WAITING) self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request

  // 非 GET 没有缓存语义，一律放行到网络
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }

  // 这一条必须在 origin 判断**之前**。
  //
  // blob: URL 的 origin 就是创建它的文档的 origin：
  //   new URL('blob:http://127.0.0.1:24816/xxx').origin === 'http://127.0.0.1:24816'
  // 所以只判断 origin 会把笔记里的图片请求（src/lib/asset.ts 造的 blob URL）
  // 也拦下来，而 CacheStorage 只接受 http(s)，缓存操作会直接抛。
  // data: / chrome-extension: 同理。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  if (url.origin !== self.location.origin) return

  event.respondWith(request.mode === 'navigate' ? handleNavigation(request) : handleAsset(request))
})

async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME)

  // 客户端路由（/subjects/x/chapters/y）在缓存里没有对应文件，统一回应用外壳。
  //
  // 这里用字符串 SHELL 去 match，而不是用 request：
  // 导航请求的 mode 是 'navigate'，和我们存进去的那条记录对不上。
  const cached = await cache.match(SHELL, { ignoreVary: true })
  if (cached) return cached

  try {
    return await fetch(request)
  } catch {
    return new Response('离线，且本地缓存里没有应用外壳。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

async function handleAsset(request) {
  const cache = await caches.open(CACHE_NAME)

  // ignoreVary：将来若给静态服务器加上压缩，响应里会出现 Vary: Accept-Encoding，
  // 严格匹配会因为请求头不一致而 miss。
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) return cached

  try {
    const response = await fetch(request)

    // 顺手把内容寻址的资源补进缓存，这样万一某个分片漏了预缓存也能自愈。
    // index.html 单独走导航策略，存进来只会造成两份互相矛盾的副本。
    if (
      response.ok &&
      response.type === 'basic' &&
      new URL(request.url).pathname.startsWith('/assets/')
    ) {
      await cache.put(request, response.clone())
    }
    return response
  } catch {
    // 千万不要在这里回 index.html 兜底：模块脚本收到 HTML 会报
    // "Unexpected token '<'"，把「文件缺失」伪装成一个语法错误，
    // 排查成本天差地别。老老实实报失败。
    return new Response('离线，且本地缓存里没有该资源。', {
      status: 504,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}
