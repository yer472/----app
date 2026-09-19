/**
 * 用 Chrome DevTools Protocol 驱动 Edge 的最小客户端。
 *
 * 只依赖 Node 内置能力（fetch + 全局 WebSocket，Node 22+ 都有），
 * 不引入 puppeteer 那一套。build-icons.mjs 和 verify-pwa.mjs 共用这里。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Edge 的常见安装位置。找不到就抛，让脚本明确失败而不是静默跳过。 */
export function findEdge() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    process.env['PROGRAMFILES(X86)'] &&
      path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
  ].filter(Boolean)

  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('找不到 msedge.exe。这些脚本需要本机装有 Edge。')
  return found
}

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 起一个独立的 Edge 实例并连上它的页面 target。
 *
 * @param {{headless?: boolean, port?: number, profile?: string}} options
 *   profile 传已有的目录可以复用浏览器状态（verify-pwa 的第 9 步要靠它做
 *   「关掉浏览器重开」的测试）。不传就建一个临时目录，结束时删掉。
 * @returns {Promise<{send, evaluate, close, port, profile, reusedProfile, events}>}
 */
export async function launchEdge({ headless = true, port, profile: existingProfile } = {}) {
  const edge = findEdge()
  const debugPort = port ?? (await getFreePort())
  const reusedProfile = Boolean(existingProfile)
  const profile = existingProfile ?? (await mkdtemp(path.join(tmpdir(), 'xxbj-cdp-')))

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    // 窗口尺寸给足，否则 headless 默认 800x600 会把页面挤变形
    '--window-size=1280,860',
  ]
  if (headless) args.unshift('--headless=new', '--disable-gpu')

  const child = spawn(edge, args, { stdio: 'ignore' })

  // 等 devtools 端点起来
  let target = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const list = await res.json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target) break
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  if (!target) {
    child.kill()
    throw new Error(`Edge 起来了但没找到页面 target（devtools 端口 ${debugPort}）`)
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('连接 devtools WebSocket 失败')), {
      once: true,
    })
  })

  let nextId = 1
  const pending = new Map()
  const events = []
  const listeners = new Map()

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined) {
      const settle = pending.get(msg.id)
      if (!settle) return
      pending.delete(msg.id)
      // 注意：这里 resolve 的是完整的 CDP 消息，不是 msg.result。
      // 调用方要自己取 .result —— 曾经在这里踩过坑。
      settle(msg)
      return
    }
    events.push(msg)
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params)
  })

  /** 发一条 CDP 命令，返回完整消息（含 .result / .error） */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
      // unref：否则一个挂起的命令会让 Node 进程多活 30 秒
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP 超时: ${method}`))
      }, 30_000).unref?.()
    })

  /** 发一条命令并直接拿 result；CDP 报错时抛出，避免把错误当数据用 */
  const call = async (method, params = {}) => {
    const msg = await send(method, params)
    if (msg.error) throw new Error(`CDP ${method} 失败: ${msg.error.message}`)
    return msg.result
  }

  /** 在页面里求值并取回值。抛出的异常会作为错误返回，不会静默变 undefined */
  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        '页面里抛了异常'
      throw new Error(text)
    }
    return result.result.value
  }

  const on = (method, fn) => {
    const list = listeners.get(method) ?? []
    list.push(fn)
    listeners.set(method, list)
  }

  /**
   * 等页面的下一次 load 事件，或超时。
   *
   * 必须在 Page.navigate 之前调用——事件是瞬时的，页面加载完再挂监听就永远等不到。
   */
  const waitForLoad = async (timeout = 15_000) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeout)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      on('Page.loadEventFired', done)
    })
  }

  /**
   * 把页面停在 about:blank 上。
   *
   * Edge 起来之后会自己去加载它的启动页，把我们连上时的那个文档顶掉——
   * 表现是 Runtime.evaluate 报 "Execution context was destroyed"。
   * 所以先占住一个空文档，之后所有求值才有稳定的上下文。
   */
  const settle = async () => {
    await call('Page.enable')
    await call('Runtime.enable')
    const loaded = waitForLoad(5_000)
    await call('Page.navigate', { url: 'about:blank' })
    await loaded
    // 求值要有 document 才能跑
    await waitFor(() => evaluate('Boolean(document.body)').catch(() => false), {
      timeout: 10_000,
      label: '页面上下文就绪',
    })
  }

  /**
   * 关掉浏览器并释放 profile。
   *
   * 先走 Browser.close（优雅退出）而不是直接杀进程：Edge 需要在退出时
   * 把 profile 落盘，而 Service Worker 的注册记录就在里面。
   * verify-pwa 的「关掉浏览器重开、服务器全程没启动」那一步全靠它——
   * 硬杀进程可能丢掉注册记录，那条测试就会因为错误的原因失败。
   */
  const close = async () => {
    const exited = new Promise((resolve) => child.once('exit', resolve))

    try {
      // 不等它 resolve：浏览器关掉的同时 WebSocket 就断了，
      // 这个 promise 永远不会兑现
      await Promise.race([call('Browser.close').catch(() => {}), sleep(2000)])
    } catch {
      /* 连接已经断了 */
    }
    await Promise.race([exited, sleep(3000)])

    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await Promise.race([exited, sleep(3000)])
    }

    try {
      ws.close()
    } catch {
      /* 已经断了 */
    }

    // 等进程真的退出、文件锁释放，再删 profile，否则 Windows 上会 EBUSY
    await sleep(400)
    if (!reusedProfile) {
      await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
  }

  // 默认就先把页面停稳。忘了调用 settle 的话，第一个 evaluate 会随机地
  // 撞上 Edge 加载启动页，报一个和真正问题毫无关系的错。
  await settle()

  return { send, call, evaluate, on, events, close, settle, waitForLoad, port: debugPort, profile }
}

/** 轮询直到 condition() 返回真值，或超时 */
export async function waitFor(condition, { timeout = 20_000, interval = 200, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await condition()
    if (last) return last
    await sleep(interval)
  }
  throw new Error(`等待超时：${label}`)
}

export { sleep }
