/**
 * 学习笔记的本地静态服务器。
 *
 *   npm run serve
 *
 * 只用 Node 内置模块，不引入 express/sirv 之类。
 *
 * 这个脚本存在的意义不是「能发文件」——`vite preview` 也能。区别在两件事：
 *   1. 端口固定，且**绝不自动切换**（原因见下面的 PORT 注释）
 *   2. SPA 回退只对不带扩展名的路径生效。`vite preview` 对任何 404 都回
 *      index.html，于是一个缺失的分片会返回 HTML，浏览器报
 *      "Unexpected token '<'"——把「文件没了」伪装成语法错误。
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)))

// 只绑回环：不暴露到局域网，也不会弹 Windows 防火墙授权框。
const HOST = '127.0.0.1'

/**
 * 这个端口就是应用的 origin，而 origin 决定了四件事：
 * IndexedDB 里的笔记、CacheStorage 里的离线缓存、Service Worker 的注册、
 * 以及任务栏上那个图标的身份。
 *
 * 所以端口变了不会「迁移」任何东西——你会得到一个空的应用、
 * 任务栏上多出来的第二个图标，而笔记还留在旧端口下。
 *
 * 结论：端口被占用时直接报错退出，绝不换一个能用的。
 * 静默换端口是这个脚本能造成的最有破坏性的行为。
 *
 * 选值：>1024 免管理员，<49152 避开 Windows 的动态端口分配区间。
 */
export const DEFAULT_PORT = 24816

const MIME = {
  '.html': 'text/html; charset=utf-8',
  // .js 必须是 JS 的 MIME。给成 application/octet-stream 的话
  // <script type="module"> 会被直接拒绝执行，而且报错信息很难读懂。
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

function cacheControl(relative) {
  // sw.js 和 index.html 永远不能被缓存住：一个是更新机制的入口，
  // 一个是唯一会在两次构建之间改变内容的非哈希文件名。
  if (relative === 'sw.js' || relative === 'index.html') return 'no-cache'
  if (relative === 'manifest.webmanifest') return 'no-cache'
  // 内容寻址：文件名里已经带哈希，永不过期是安全的
  if (relative.startsWith('assets/')) return 'public, max-age=31536000, immutable'
  // 没有哈希的图标 / favicon
  return 'public, max-age=3600'
}

/** 把 URL 路径解析成 dist 下的真实文件；不合法或不存在返回 null */
async function resolveFile(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null // 畸形的 % 序列
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null

  const target = path.resolve(path.join(ROOT, decoded))
  // 目录穿越防护。比较解析后的绝对路径，而不是做字符串前缀匹配——
  // 前缀匹配会把 dist-evil/ 当成 dist/ 的子路径放过去。
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null

  try {
    const info = await stat(target)
    if (info.isDirectory()) return resolveFile(path.posix.join(pathname, 'index.html'))
    if (!info.isFile()) return null
    return { target, info, relative: path.relative(ROOT, target).split(path.sep).join('/') }
  } catch {
    return null
  }
}

/**
 * @param {{port?: number, verbose?: boolean, onLog?: (line: string) => void}} options
 */
export function createStaticServer({ port = DEFAULT_PORT, verbose = false, onLog } = {}) {
  const log = (line) => {
    if (verbose) console.log(line)
    onLog?.(line)
  }

  const server = createServer(async (req, res) => {
    const started = Date.now()
    const respond = (status, headers = {}, body) => {
      res.writeHead(status, headers)
      res.end(body)
      // 这行日志是离线验证的判据之一：服务器没收到请求 = SW 全权处理了
      log(`${req.method} ${req.url} -> ${status} (${Date.now() - started}ms)`)
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // 405 而不是 200：SW 的 fetch 处理器必须放行非 GET，
      // 这个状态码就是那条断言的观测点。
      return respond(
        405,
        { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
        'Method Not Allowed',
      )
    }

    let pathname
    try {
      pathname = new URL(req.url, `http://${HOST}:${port}`).pathname
    } catch {
      return respond(400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request')
    }

    let hit = await resolveFile(pathname)

    if (!hit) {
      // SPA 回退只对「看起来是客户端路由」的路径生效。
      // 带扩展名的一律 404，绝不回 index.html——理由见文件头注释。
      const hasExtension = path.extname(pathname) !== ''
      const wantsHtml = (req.headers.accept ?? '').includes('text/html')
      if (hasExtension || !wantsHtml) {
        return respond(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found')
      }
      hit = await resolveFile('/index.html')
      if (!hit) {
        return respond(
          500,
          { 'Content-Type': 'text/plain; charset=utf-8' },
          'dist/index.html 不存在，先跑一次 npm run build',
        )
      }
    }

    const { target, info, relative } = hit
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
    const headers = {
      'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      'Cache-Control': cacheControl(relative),
      ETag: etag,
      // 让 MIME 写错这件事立刻暴露，而不是被浏览器的内容嗅探掩盖过去
      'X-Content-Type-Options': 'nosniff',
    }
    if (relative === 'sw.js') headers['Service-Worker-Allowed'] = '/'

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] })
      res.end()
      log(`${req.method} ${req.url} -> 304 (${Date.now() - started}ms)`)
      return
    }

    res.writeHead(200, headers)
    log(`${req.method} ${req.url} -> 200 (${Date.now() - started}ms)`)
    if (req.method === 'HEAD') return res.end()
    createReadStream(target).pipe(res)
  })

  /** @returns {Promise<{port: number, close: () => Promise<void>}>} */
  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, HOST, () => {
        resolve({
          port,
          close: () => new Promise((done) => server.close(() => done())),
        })
      })
    })

  return { server, listen, port }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT)
  const verbose = Boolean(process.env.VERBOSE)

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error(`端口 ${process.env.PORT} 不合法，应当是 1024-65535 之间的整数。`)
    process.exit(1)
  }

  createStaticServer({ port, verbose })
    .listen()
    .then(() => {
      console.log(`学习笔记: http://${HOST}:${port}/`)
    })
    .catch((error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(
          `端口 ${port} 被占用了。\n\n` +
            `这个端口就是应用的 origin，不能自动换一个——\n` +
            `换了端口等于换了一个新的空数据库，任务栏上还会多出一个第二个图标。\n\n` +
            `先看看是谁占着：\n` +
            `  netstat -ano | findstr :${port}\n` +
            `如果是 Windows 的保留区间（Hyper-V / WSL / Docker 常见）：\n` +
            `  netsh int ipv4 show excludedportrange protocol=tcp\n`,
        )
      } else {
        console.error(error)
      }
      process.exit(1)
    })
}
