/**
 * M4.5 的端到端验证：深色打磨、最近编辑、错误与空状态、拖拽排序。
 *
 * 跑在 **vite dev** 上（端口 5201，和另外三个 5198/5199/5200 错开，可以同时跑），
 * 因为要用 `import('/src/...')` 直接打桩和读目录。
 *
 * ## 这一套里最要紧的两条纪律
 *
 * 1. **打桩之后先证明桩装上了。** 所有「故意让它失败」的用例，桩里都带一个
 *    计数器，断言前先看计数 > 0。否则「页面没报错」可能只是桩压根没生效——
 *    那就是一条永远绿的假断言，比没有断言更糟。
 * 2. **断言对比度之前先断言「现在真的是深色」。** 深色下不达标而浅色下达标的
 *    东西很少，反过来却很多；不先钉住主题，一条对比度断言在浅色下也能过。
 *
 * ## 深色是怎么造出来的
 *
 * 主题有三态（跟随系统/浅色/深色），数据源是 IndexedDB 里的设置，
 * `localStorage['xxbj.theme']` 只是个「别闪白」的提示位。所以两处都要设，
 * 再用 `Emulation.setEmulatedMedia` 摆布 `prefers-color-scheme`——
 * 「提示位过期时以数据库为准」这条契约就是这么验的。
 *
 * 用法：npm run verify:m45
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { launchEdge, sleep, waitFor } from './lib/cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5201
const BASE = `http://localhost:${PORT}`

let failures = 0

async function check(label, fn) {
  try {
    const detail = await fn()
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
  } catch (e) {
    failures += 1
    console.log(`  ✗ ${label}\n      ${e.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function section(title) {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------- dev 服务器

/**
 * ⚠️ 「端口已经有人应答」的检查不能省。
 *
 * `--strictPort` 会让新服务器在端口被占时退出，而下面的 waitFor 只等
 * 「这个端口有响应」——上一轮自检残留的服务器会替它应答，于是整个脚本
 * 测的是旧代码，且全程不报错。这个坑在 verify-shortcuts 里真踩过。
 */
async function assertPortFree() {
  let occupied = false
  try {
    occupied = (await fetch(BASE)).ok
  } catch {
    occupied = false
  }
  if (occupied) {
    throw new Error(
      `端口 ${PORT} 上已经有一个服务器在跑（多半是上次自检没清理干净）。\n` +
        `      它会替本次启动的服务器应答，导致测的是旧代码。先杀掉它：\n` +
        `      netstat -ano | findstr :${PORT}   然后 taskkill /PID <pid> /T /F`,
    )
  }
}

async function startDevServer() {
  await assertPortFree()
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(
    npm,
    ['run', 'dev', '--', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', shell: true },
  )
  await waitFor(
    async () => {
      try {
        return (await fetch(BASE)).ok
      } catch {
        return false
      }
    },
    { timeout: 40_000, label: 'dev 服务器起来' },
  )
  return child
}

const devServer = await startDevServer()
const edge = await launchEdge({ headless: true })
const { call, evaluate, on } = edge

/**
 * 页面报错收集。
 *
 * ⚠️ 第 3 节是**故意把东西弄坏**的（打桩让查询抛错、让删除失败），
 * React 和 react-router 会把接住的错误照常打进控制台。不过滤的话
 * 「全程没有页面报错」这一节要么假红，要么被迫删掉——那才是真损失。
 * 所以只放过这几种「我们亲手造成的」。
 */
const EXPECTED_NOISE = [
  /React Router caught the following error/i,
  /The above error occurred in/i,
  /__M45_STUB__/,
]
const pageErrors = []
const collect = (text) => {
  if (EXPECTED_NOISE.some((re) => re.test(text))) return
  pageErrors.push(text)
}
on('Runtime.exceptionThrown', (p) =>
  collect(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text),
)
on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') collect(p.args.map((a) => a.value ?? a.description).join(' '))
})

// ---------------------------------------------------------------- 页面助手

const PATH = `location.pathname + location.search`
const DIALOG_COUNT = `document.querySelectorAll('[role="dialog"]').length`
const DIALOG_TITLE = `document.querySelector('[role="dialog"] h2')?.textContent ?? null`
const SIDEBAR = `Boolean(document.querySelector('aside'))`
const IS_DARK = `document.documentElement.classList.contains('dark')`
const BODY_TEXT = `document.body.innerText`
/** 顺序断言用 id，不用标题——标题可能重复，id 不会 */
const CARD_IDS = `[...document.querySelectorAll('[data-reorder-id]')].map((li) => li.dataset.reorderId)`
const RECENT_IDS = `[...document.querySelectorAll('[data-recent-note]')].map((a) => a.dataset.recentNote)`

/** 把扫描结果里最差的几条排版成一段可读的诊断文本 */
function describeWorst(scan) {
  return scan.worst
    .map((w) => `${w.where} ${w.ratio.toFixed(2)}:1 「${w.text}」 ${w.html}`)
    .join('\n        ')
}

async function waitForAppReady() {
  await waitFor(
    () =>
      evaluate(
        `Boolean(document.querySelector('aside') || document.querySelector('button[aria-label="展开侧栏"]'))`,
      ),
    { timeout: 15_000, label: '应用启动完成' },
  )
}

async function goto(url, { reload = false } = {}) {
  const loaded = edge.waitForLoad(20_000)
  if (reload) await call('Page.reload', { ignoreCache: false })
  else await call('Page.navigate', { url })
  await loaded
  await waitForAppReady()
  await sleep(250)
}

function clickText(text) {
  return evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)})
    if (!btn) throw new Error('找不到按钮：' + ${JSON.stringify(text)})
    btn.click()
  })()`)
}

/**
 * 按「文字包含」找按钮。
 *
 * 有些按钮里混了图标（主题按钮是 `◐主题：浅色`），精确匹配会找不到——
 * 而报出来的错是「找不到按钮」，看起来像功能坏了。
 */
function clickContaining(text) {
  return evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.includes(${JSON.stringify(text)}))
    if (!btn) throw new Error('找不到按钮（包含）：' + ${JSON.stringify(text)})
    btn.click()
  })()`)
}

/** 点一个站内链接：走 SPA 路由，**不会重载文档**（打桩就是靠这一点活下来的） */
async function clickLink(href) {
  await evaluate(`(() => {
    const a = document.querySelector('a[href=' + ${JSON.stringify(JSON.stringify(href))} + ']')
    if (!a) throw new Error('找不到链接：' + ${JSON.stringify(href)})
    a.click()
  })()`)
  await sleep(500)
}

/**
 * 点对话框里的按钮。
 *
 * ⚠️ 不能直接用 clickText：卡片上那个「删除」和对话框里那个「删除」是
 * 两个按钮，`querySelectorAll('button')` 里卡片那个排在前面，于是
 * 「确认删除」实际点的是「再打开一次确认框」——表现是对话框一直在那儿，
 * 看起来像确认按钮坏了。
 */
function clickInDialog(text) {
  return evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) throw new Error('没有打开的对话框')
    const btn = [...dialog.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)})
    if (!btn) throw new Error('对话框里找不到按钮：' + ${JSON.stringify(text)})
    btn.click()
  })()`)
}

/**
 * 按住某个点拖到另一个点。
 *
 * 用的是 `Input.dispatchMouseEvent`——**真实输入通道**，浏览器据此合成出
 * pointerdown/pointermove/pointerup，`setPointerCapture` 也照常工作。
 * 不要在 evaluate 里 dispatchEvent(new PointerEvent(...))：那种合成事件
 * 不是 isTrusted，捕获和命中测试的表现都和真人不一样。
 */
async function drag(from, to, steps = 10) {
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: from.x,
    y: from.y,
    button: 'none',
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  for (let i = 1; i <= steps; i += 1) {
    await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
      button: 'left',
      buttons: 1,
    })
    await sleep(16)
  }
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    clickCount: 1,
  })
  await sleep(200)
}

const BIT = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
const VK = { ArrowUp: 38, ArrowDown: 40, Escape: 27 }

async function press(key, { alt = false } = {}) {
  const modifiers = alt ? BIT.alt : 0
  const base = {
    key,
    code: key,
    windowsVirtualKeyCode: VK[key] ?? 0,
    nativeVirtualKeyCode: VK[key] ?? 0,
    modifiers,
  }
  await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(150)
}

// ---------------------------------------------------------------- 主题

/**
 * 把主题设成想要的状态，然后重新加载。
 *
 * 提示位和数据库**分别**设：`hint` 是 localStorage 那个「别闪白」用的，
 * `stored` 是数据源。两者不一致的用例（提示位过期）正是要验的契约。
 */
async function setTheme({ hint, stored, system }) {
  /*
   * ⚠️ 顺序要紧：**先改模拟的系统偏好，最后才写提示位。**
   *
   * 反过来的话会踩到一个坑（第一版就是这么写的，症状是「提示位过期」那条
   * 时而红时而绿）：旧页面还活着，而它的主题是「跟随系统」——改模拟偏好会
   * 触发 uiStore 里那个 prefers-color-scheme 监听器，它照设计把提示位
   * **重写**成 'system'。于是我刚写进去的 'dark' 被覆盖掉，
   * 重新加载时内联脚本读到的是 'system'，首屏自然不深。
   *
   * 也就是：这不是产品的问题，是测试在不真实的时刻改了系统的偏好。
   * 让「我写的」成为最后一句就行。
   */
  await call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: system }],
  })
  // 留给旧页面那个监听器一点时间跑完
  await sleep(200)
  await evaluate(`(async () => {
    localStorage.setItem('xxbj.theme', ${JSON.stringify(hint)})
    const repo = await import('/src/repository/index.ts')
    await repo.SettingRepository.set(repo.SETTING_KEYS.theme, ${JSON.stringify(stored)})
  })()`)
}

/**
 * 首屏探针：记录 `<html>` 是什么时候获得 `dark` 类的。
 *
 * 判据用 `document.readyState`：**只有 `'loading'` 才说明是 `index.html`
 * 里那段内联脚本干的**——React 挂载的时候早就过了这个阶段。这条比断言
 * 任何一个色值都有用：它能抓住「内联脚本被删了」「键名写错了」
 * 「applyTheme 忘了写提示位」这一整类问题。
 */
const DARK_TIMING_PROBE = `(() => {
  window.__darkAt = null
  // 记录「文档刚创建时」的提示位——这就是 index.html 里那段内联脚本
  // 稍后会读到的东西。它和内联脚本之间没有别的东西会写 localStorage
  try {
    window.__hintAtLoad = localStorage.getItem('xxbj.theme')
  } catch (e) {
    window.__hintAtLoad = 'THREW:' + e.message
  }
  const record = (how) => {
    if (window.__darkAt !== null) return
    if (document.documentElement?.classList.contains('dark')) {
      window.__darkAt = { how, readyState: document.readyState }
    }
  }
  record('initial')

  /*
   * ⚠️ 不用 MutationObserver：它的回调是**微任务**，回调里读到的
   * document.readyState 是「回调被投递时」的值，不是「类被加上时」的值。
   * 这个差别让断言变得看运气——同一份代码，前一轮红、后一轮绿（真发生过）。
   * 一个时而通过时而失败的断言比一个红的还糟：会让人以为是环境问题。
   *
   * 改成包住 DOMTokenList 的 add / toggle，在调用**当场**记录 readyState。
   * 代价是动了原型——但这是自检脚本注入的探针，进程和页面都由脚本掌管。
   */
  for (const method of ['add', 'toggle']) {
    const original = DOMTokenList.prototype[method]
    DOMTokenList.prototype[method] = function (...args) {
      const result = original.apply(this, args)
      try {
        if (this === document.documentElement?.classList) record(method)
      } catch {
        /* 忽略 */
      }
      return result
    }
  }
})()`

async function installProbe() {
  await call('Page.enable')
  await call('Page.addScriptToEvaluateOnNewDocument', { source: DARK_TIMING_PROBE })
}

const darkTiming = () => evaluate(`window.__darkAt ?? null`)

// ---------------------------------------------------------------- 对比度

/**
 * 对比度扫描。
 *
 * 这是**唯一能抓住「深灰墨色画在深灰底上」的断言**：写死色值的写法抓不住它
 * （换个主题色就假失败），而这条只问一句「看得见吗」。
 *
 * 几个必须排除的假阳性：
 *   - `aria-hidden` 的装饰字符（那些本来就只是形状）
 *   - `:disabled` 的元素（WCAG 1.4.3 明确豁免）
 *   - 透明度小于 1 的元素（本项目里那些 `opacity-0` 的悬停按钮，
 *     它们根本没显示；不排除的话会被当成「看不见的文字」）
 *   - 背景要沿祖先链找第一个不透明的颜色，半透明的要先合成
 */
const SCAN_CONTRAST = `(() => {
  /*
   * 颜色归一化。
   *
   * ⚠️ 不能只写个正则去解析 rgb()：Tailwind 4 生成的是 oklch()，
   * 而 getComputedStyle 原样返回那个颜色空间。第一版只认 rgb()，于是
   * **绝大多数元素的颜色解析失败、被 continue 掉**——扫描看着「通过」，
   * 实际上几乎什么都没扫，是一条静默的假绿。
   *
   * 这里借 canvas 归一：clearRect 之后填一次，读回来的像素是未预乘的
   * RGBA，正好是需要的颜色 + alpha。
   */
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const cache = new Map()
  const parse = (raw) => {
    const key = String(raw)
    if (cache.has(key)) return cache.get(key)
    let value = null
    try {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = key
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      value = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }
    } catch {
      value = null
    }
    cache.set(key, value)
    return value
  }
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  })
  const rel = (c) => {
    const f = (v) => {
      const x = v / 255
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const ratio = (a, b) => {
    const l1 = rel(a)
    const l2 = rel(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  /** 元素背后的实际颜色：沿祖先链收集背景，从最底下往上合成 */
  const backgroundOf = (el) => {
    const layers = []
    let node = el
    while (node) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c && c.a > 0) {
        layers.push(c)
        if (c.a === 1) break
      }
      node = node.parentElement
    }
    let result = { r: 255, g: 255, b: 255, a: 1 }
    for (let i = layers.length - 1; i >= 0; i -= 1) result = over(layers[i], result)
    return result
  }
  const hidden = (el) => {
    const style = getComputedStyle(el)
    if (Number(style.opacity) < 1) return true
    if (style.visibility === 'hidden' || style.display === 'none') return true
    return el.closest('[aria-hidden="true"]') !== null
  }
  const where = (el) => {
    const cls = [...el.classList].slice(0, 3).join('.')
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '')
  }
  // 失败时要能一眼认出是哪个元素，光有标签名和类名不够。
  // 刻意不做空白折叠：这段代码是塞在模板字符串里的，正则里的空白转义
  // （反斜杠加 s）会被模板字符串当成无效转义吃掉，注入进去就成了
  // 「把每个字母 s 换成空格」。为一行诊断信息去和两层转义较劲不值得，
  // 直接截断就够了。
  const snippet = (el) => String(el.outerHTML ?? '').slice(0, 80)

  const bad = []
  // 1) 文字叶子节点
  for (const el of document.querySelectorAll('*')) {
    if (el.childElementCount > 0) continue
    const text = (el.textContent ?? '').trim()
    if (!text) continue
    if (hidden(el)) continue
    if (el.closest('[disabled]')) continue
    const fg = parse(getComputedStyle(el).color)
    if (!fg) continue
    const bg = backgroundOf(el)
    bad.push({ where: where(el), ratio: ratio(fg.a < 1 ? over(fg, bg) : fg, bg), text: text.slice(0, 20), html: snippet(el) })
  }
  /*
   * 2) SVG 里的描边和填充。
   *
   * 只扫**真的会被画出来**的元素：defs / clipPath / mask / pattern 里的
   * 东西是定义，不是图元——它们的 fill 是默认黑，拿它去算对比度会得到
   * 一大堆假失败（第一版就是这么错的：报了 119 处，最差的几条全是
   * defs 和 clipPath 里的元素）。同理跳掉没有布局盒子的元素。
   *
   * currentColor 在某些实现上会原样返回，所以解析不出来时退回元素的
   * color——那正是 currentColor 的来源。
   */
  const PAINTED = new Set(['path','rect','circle','ellipse','line','polyline','polygon','text','tspan'])
  for (const el of document.querySelectorAll('svg *')) {
    if (!PAINTED.has(el.tagName.toLowerCase())) continue
    if (el.closest('defs, clipPath, mask, pattern, marker, symbol')) continue
    if (hidden(el)) continue
    const box = el.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    const style = getComputedStyle(el)
    for (const prop of ['stroke', 'fill']) {
      const raw = style[prop]
      if (!raw || raw === 'none' || raw === 'transparent') continue
      const paint = parse(raw) ?? parse(style.color)
      if (!paint) continue
      const bg = backgroundOf(el)
      bad.push({ where: where(el) + '[' + prop + ']', ratio: ratio(paint, bg), text: '', html: snippet(el) })
    }
  }
  bad.sort((a, b) => a.ratio - b.ratio)
  return { worst: bad.slice(0, 8), total: bad.length }
})()`

/** 符号面板里某个缩略图的描边和面板底色 */
const SYMBOL_THUMB_CONTRAST = `(() => {
  const panel = document.querySelector('[data-symbol-panel]')
  if (!panel) return null
  const svg = panel.querySelector('svg')
  if (!svg) return null
  // 描边是 currentColor，直接读 svg 的 color 最稳（不赌引擎怎么解析 computed stroke）
  const fg = getComputedStyle(svg).color
  let node = svg
  let bg = null
  while (node) {
    const c = getComputedStyle(node).backgroundColor
    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bg = c; break }
    node = node.parentElement
  }
  // 同样用 canvas 归一：Tailwind 4 给的是 oklch()，在 Node 那边正则解析不了
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const rgb = (css) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return { r: d[0], g: d[1], b: d[2] }
  }
  const lum = (c) => {
    const f = (v) => {
      const x = v / 255
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const l1 = lum(rgb(fg))
  const l2 = lum(rgb(bg ?? '#ffffff'))
  return { fg, bg, ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
})()`

// ---------------------------------------------------------------- 断言准备

await installProbe()
await goto(BASE)

const ids = { subjects: [], sid: '', cid: '', notes: [] }

try {
  // ================================================================ 0
  section('0. 空库：空状态，以及「最近编辑」不该出现')

  await check('全新的库在首页显示的是引导式空状态', async () => {
    const text = await evaluate(BODY_TEXT)
    assert(text.includes('还没有科目'), `首页没有空状态文案，实际是：${text.slice(0, 80)}`)
    const recent = await evaluate(`document.querySelector('[data-recent-notes]') !== null`)
    assert(!recent, '一篇笔记都没有的时候，首页不该渲染「最近编辑」那一段')
    return '「还没有科目」+ 没有最近编辑'
  })

  await check('侧栏空状态里有新建入口，点它直接弹出新建对话框', async () => {
    assert(await evaluate(SIDEBAR), '没有侧栏')
    await clickText('＋ 新建科目')
    await sleep(300)
    assert((await evaluate(DIALOG_COUNT)) === 1, '对话框没打开')
    const title = await evaluate(DIALOG_TITLE)
    assert(title === '新建科目', `对话框标题是「${title}」`)
    // 地址栏不该多出一条历史：用的是 replace
    await press('Escape')
    await sleep(200)
    return '对话框标题正确'
  })

  await check('★ 那个标记会被清掉：刷新一次不会再自动弹出来', async () => {
    // 上一 check 已经按 Esc 关掉了。再点一次、然后刷新（不重新点按钮），
    // 这时候不该再有对话框——location.state 清不干净的话，
    // 它不在 URL 里，肉眼完全看不出来
    await clickText('＋ 新建科目')
    await sleep(300)
    assert((await evaluate(DIALOG_COUNT)) === 1, '第一次没弹出来，后面无从谈起')
    await press('Escape')
    await goto(BASE, { reload: true })
    assert((await evaluate(DIALOG_COUNT)) === 0, '刷新之后对话框又自己弹出来了')
    return '刷新后不再弹'
  })

  // ================================================================ 1
  section('1. 准备数据')

  const seeded = await evaluate(`(async () => {
    const repo = await import('/src/repository/index.ts')
    const db = (await import('/src/db/index.ts')).db
    const names = [
      '【打磨自检】甲', '【打磨自检】乙', '【打磨自检】丙', '【打磨自检】丁',
    ]
    const subjects = []
    for (const name of names) subjects.push(await repo.SubjectRepository.create({ name }))
    const chapter = await repo.ChapterRepository.create({
      subjectId: subjects[0].id, name: '自检章节',
    })
    const other = await repo.ChapterRepository.create({
      subjectId: subjects[1].id, name: '另一章',
    })

    // 8 篇笔记，更新时间人为拉开。最后一篇故意「创建得最新、更新得最旧」，
    // 用来分辨排序到底看的是哪个字段
    const notes = []
    for (let i = 0; i < 8; i += 1) {
      const n = await repo.NoteRepository.create({
        chapterId: i === 7 ? other.id : chapter.id,
        title: '自检笔记 ' + (i + 1),
      })
      notes.push(n)
    }
    const base = Date.parse('2026-09-01T00:00:00.000Z')
    for (let i = 0; i < 8; i += 1) {
      const stamp = new Date(base + i * 86400000).toISOString()
      await db.notes.update(notes[i].id, { updatedAt: stamp, createdAt: stamp })
    }
    // 第 8 篇故意做成「创建时间最新、更新时间最旧」（比第 1 篇还早），
    // 这样它能分辨出排序到底看的是哪个字段
    await db.notes.update(notes[7].id, {
      createdAt: new Date(base + 99 * 86400000).toISOString(),
      updatedAt: new Date(base - 86400000).toISOString(),
    })
    return {
      subjectIds: subjects.map((s) => s.id),
      names,
      cid: chapter.id,
      otherCid: other.id,
      notes: notes.map((n) => n.id),
      nid: notes[3].id,
    }
  })()`)

  ids.subjects = seeded.subjectIds
  ids.sid = seeded.subjectIds[0]
  ids.cid = seeded.cid
  ids.notes = seeded.notes
  ids.nid = seeded.nid

  await check('测试数据建好了', async () => {
    const count = await evaluate(CARD_IDS)
    assert(count.length === 4, `首页应该有 4 个科目，实际 ${count.length}`)
    return `4 个科目、2 个章节、8 篇笔记`
  })

  // ================================================================ 2
  section('2. 最近编辑（首页顶部）')

  await check('★ 取 6 条、按更新时间倒序，而且排的是 updatedAt 不是 createdAt', async () => {
    await goto(BASE)
    const shown = await evaluate(RECENT_IDS)
    assert(shown.length === 6, `应该只显示 6 条（RECENT_LIMIT），实际 ${shown.length}`)

    // 期望：按 updatedAt 倒序的前 6 篇 = notes[7](最旧) 除外，是 notes[6]..notes[1]
    const expected = seeded.notes.slice(1, 7).reverse()
    assert(
      JSON.stringify(shown) === JSON.stringify(expected),
      `顺序不对。\n      实际：${shown.join(', ')}\n      期望：${expected.join(', ')}`,
    )
    assert(
      !shown.includes(seeded.notes[7]),
      '第 8 篇 createdAt 最新但 updatedAt 最旧，不该出现在最近编辑里——排序用的是 createdAt？',
    )
    return `6 条，最前是第 7 篇，第 8 篇（创建最新/更新最旧）没进来`
  })

  await check('★ 置顶一篇旧笔记，它的位置不变（置顶不是编辑）', async () => {
    const target = seeded.notes[1] // 更新得最早的、还在可见范围内的那篇
    const before = await evaluate(RECENT_IDS)

    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      await repo.NoteRepository.togglePin(${JSON.stringify(target)})
    })()`)
    await sleep(400)

    const after = await evaluate(RECENT_IDS)
    assert(
      JSON.stringify(after) === JSON.stringify(before),
      `置顶之后顺序变了！\n      置顶前：${before.join(', ')}\n      置顶后：${after.join(', ')}\n` +
        `      （说明 togglePin 又去写 updatedAt 了——置顶是元数据，不是编辑）`,
    )
    // 顺带把状态改回去，别让后面的用例带着置顶
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      await repo.NoteRepository.togglePin(${JSON.stringify(target)})
    })()`)
    return '顺序未变'
  })

  await check('每一行都指向正确的那篇笔记', async () => {
    const href = await evaluate(`document.querySelector('[data-recent-note]')?.getAttribute('href')`)
    const expected = `/subjects/${seeded.subjectIds[0]}/chapters/${seeded.cid}/notes/${seeded.notes[6]}`
    assert(href === expected, `第一行的链接是 ${href}，期望 ${expected}`)
    return href
  })

  // ================================================================ 3
  section('3. 拖拽排序')

  await check('★ 前提：拖拽手柄真的收得到指针事件', async () => {
    // 先钉住这一层，测试失败时才分得清是「事件没送到」还是「送到了但逻辑没跑」。
    // 没有这条的话，拖拽失败只会表现成「顺序没变」，而那句话什么也没说明
    await goto(BASE)
    /*
     * down 要落在**手柄**上（那才是起手），move/up 只要落在 window 上就行——
     * 拖动中指针早就离开手柄了，而实现也是把这两个挂在 window 上的
     * （指针捕获会被 DOM 重排弄丢，理由见 useReorder.ts）。
     * 断言写法要跟着实现走，别去要求一个已经不成立的行为。
     */
    await evaluate(`(() => {
      window.__ptr = { downOnHandle: 0, move: 0, up: 0 }
      const h = document.querySelector('[data-reorder-handle]')
      if (!h) throw new Error('页面上没有拖拽手柄')
      h.addEventListener('pointerdown', () => { window.__ptr.downOnHandle += 1 }, true)
      window.addEventListener('pointermove', () => { window.__ptr.move += 1 }, true)
      window.addEventListener('pointerup', () => { window.__ptr.up += 1 }, true)
    })()`)
    const handles = await evaluate(
      `[...document.querySelectorAll('[data-reorder-handle]')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })`,
    )
    await drag(handles[0], { x: handles[0].x + 60, y: handles[0].y + 60 }, 4)
    const seen = await evaluate(`window.__ptr`)
    assert(seen.downOnHandle > 0, '手柄没收到 pointerdown——起手就没落在手柄上')
    assert(seen.move > 0, 'window 没收到 pointermove')
    assert(seen.up > 0, 'window 没收到 pointerup')
    return `down 在手柄上 ${seen.downOnHandle} 次，move ${seen.move} 次，up ${seen.up} 次`
  })

  await check('★ 拖一项：数据库里的顺序真的变了（逐项 id 对拍）', async () => {
    await goto(BASE)
    const before = await evaluate(CARD_IDS)
    assert(before.length === 4, `首页应该有 4 个科目，实际 ${before.length}`)

    // 把手柄从第 1 项拖到第 3 项的位置
    const handles = await evaluate(
      `[...document.querySelectorAll('[data-reorder-handle]')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })`,
    )
    const cards = await evaluate(
      `[...document.querySelectorAll('[data-reorder-id]')].map((li) => { const r = li.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })`,
    )
    await drag(handles[0], cards[2])
    await sleep(500)

    // 第 1 项挪到第 3 个槽位，剩下的原样跟着走（别写死条数）
    const expected = [before[1], before[2], before[0], ...before.slice(3)]
    const stored = await evaluate(
      `(async () => (await (await import('/src/repository/index.ts')).SubjectRepository.list()).map((s) => s.id))()`,
    )
    assert(
      JSON.stringify(stored) === JSON.stringify(expected),
      `数据库里的顺序不对。\n      实际：${stored.join(', ')}\n      期望：${expected.join(', ')}`,
    )

    const rendered = await evaluate(CARD_IDS)
    assert(
      JSON.stringify(rendered) === JSON.stringify(expected),
      `界面上看到的顺序和数据库不一致：${rendered.join(', ')}`,
    )
    return `${before.map((_, i) => i + 1).join('')} → ${expected.map((id) => before.indexOf(id) + 1).join('')}`
  })

  await check('★ 只有真的挪了位的那几行会被盖时间戳，没动的行一个字节都不许动', async () => {
    await goto(BASE)
    const rowsOf = `(async () => (await (await import('/src/repository/index.ts')).SubjectRepository.list()).map((s) => ({ id: s.id, updatedAt: s.updatedAt })))()`
    const before = await evaluate(rowsOf)

    const handles = await evaluate(
      `[...document.querySelectorAll('[data-reorder-handle]')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })`,
    )
    const cards = await evaluate(
      `[...document.querySelectorAll('[data-reorder-id]')].map((li) => { const r = li.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })`,
    )
    // 把第 1 项拖到第 3 个槽位：被拖的那项和中间那两项换了位置，
    // 最后一项的下标没变——它就**不该**被写时间戳
    await drag(handles[0], cards[2])
    await sleep(500)

    const after = await evaluate(rowsOf)
    const orderBefore = before.map((r) => r.id)
    const orderAfter = after.map((r) => r.id)
    assert(
      JSON.stringify(orderBefore) !== JSON.stringify(orderAfter),
      '这一拖根本没改变顺序，下面的断言就没有意义',
    )

    const moved = new Set(orderAfter.filter((id, index) => orderBefore[index] !== id))
    assert(moved.size > 0 && moved.size < after.length, `换了位置的行数是 ${moved.size}，这条用例需要「有一行没动」`)

    const untouched = after.filter((r) => !moved.has(r.id))
    for (const row of untouched) {
      const previous = before.find((r) => r.id === row.id)
      assert(
        row.updatedAt === previous.updatedAt,
        `「${orderAfter.indexOf(row.id) + 1}」号的下标没变，时间戳却从 ${previous.updatedAt} 变成了 ${row.updatedAt}——` +
          `reorder 又在无条件写所有行了，用户会看到整页「更新于 刚刚」`,
      )
    }
    return `${after.length} 行里动了 ${moved.size} 行，没动的 ${untouched.length} 行时间戳原样`
  })

  await check('★ 拖到列表外面松手 = 取消，顺序一个都不动', async () => {
    const before = await evaluate(CARD_IDS)
    const handles = await evaluate(
      `[...document.querySelectorAll('[data-reorder-handle]')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })`,
    )
    // 往左上角拖出去很远再松手
    await drag(handles[0], { x: 8, y: 8 })
    await sleep(400)
    const after = await evaluate(CARD_IDS)
    assert(
      JSON.stringify(after) === JSON.stringify(before),
      `拖出界之后顺序变了：${before.join(', ')} → ${after.join(', ')}`,
    )
    return '顺序未变'
  })

  await check('★ 拖完那一下不会导航（手柄必须挂在 <a> 外面）', async () => {
    assert(
      (await evaluate(PATH)) === '/',
      `拖完之后跳到了 ${await evaluate(PATH)}——手柄十有八九被放进锚点里了`,
    )
    assert((await evaluate(DIALOG_COUNT)) === 0, '拖完之后弹出了对话框')
    return '仍在首页'
  })

  await check('★ 键盘 Alt+↓：真的下移一位，而且焦点还在原来那一项上', async () => {
    const before = await evaluate(CARD_IDS)
    // 焦点给第 1 项的手柄（Tab 到它，或者直接点一下都行）
    await evaluate(`document.querySelector('[data-reorder-handle]').focus()`)
    const focused = await evaluate(
      `document.activeElement?.dataset?.reorderHandle ?? null`,
    )
    assert(focused === before[0], '焦点没落在手柄上，后面的按键无从谈起')

    await press('ArrowDown', { alt: true })
    await sleep(400)

    const after = await evaluate(CARD_IDS)
    const expected = [before[1], before[0], ...before.slice(2)]
    assert(
      JSON.stringify(after) === JSON.stringify(expected),
      `下移结果不对：${before.join(', ')} → ${after.join(', ')}`,
    )
    const stillFocused = await evaluate(
      `document.activeElement?.dataset?.reorderHandle ?? null`,
    )
    assert(
      stillFocused === before[0],
      `移动完焦点跑到「${stillFocused}」上去了——连按第二次就不会有反应`,
    )
    return `${before.indexOf(before[0]) + 1} → 2，焦点保持`
  })

  await check('章节列表也能拖（同一套 hook，别只在首页接上了）', async () => {
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      await repo.ChapterRepository.create({ subjectId: ${JSON.stringify(ids.sid)}, name: '第二个自检章节' })
    })()`)
    await goto(`${BASE}/subjects/${ids.sid}`)
    const before = await evaluate(CARD_IDS)
    assert(before.length === 2, `章节页应该有 2 个章节，实际 ${before.length}`)

    const handles = await evaluate(
      `[...document.querySelectorAll('[data-reorder-handle]')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })`,
    )
    const cards = await evaluate(
      `[...document.querySelectorAll('[data-reorder-id]')].map((li) => { const r = li.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })`,
    )
    await drag(handles[0], cards[1])
    await sleep(500)

    const expected = [before[1], before[0]]
    const stored = await evaluate(
      `(async () => (await (await import('/src/repository/index.ts')).ChapterRepository.listBySubject(${JSON.stringify(ids.sid)})).map((c) => c.id))()`,
    )
    assert(
      JSON.stringify(stored) === JSON.stringify(expected),
      `章节顺序不对：${stored.join(', ')}，期望 ${expected.join(', ')}`,
    )
    return '章节拖拽生效'
  })

  await check('Alt+↑ / Alt+↓ 两条都写进了快捷键目录', async () => {
    const found = await evaluate(`(async () => {
      const cat = await import('/src/lib/shortcuts/catalog.ts')
      const hooks = await import('/src/lib/shortcuts/useShortcuts.ts')
      const ids = cat.allEntries().filter((e) => e.group === 'page' && e.by === 'app').map((e) => e.id)
      return { ids, registered: hooks.registeredIds() }
    })()`)
    // ⚠️ 这条必须自己写：verify-shortcuts 里那条「目录与注册对得上」只覆盖
    // group === 'global'，页面组不在它的射程内（bd-tools 当年就是因为这个
    // 才单独补了一条）
    for (const id of ['move-item-up', 'move-item-down']) {
      assert(found.ids.includes(id), `目录里没有 ${id}`)
    }
    assert(
      found.registered.includes('move-item-up') &&
        found.registered.includes('move-item-down'),
      `目录里写了但没绑定。已注册：${found.registered.join(', ')}`,
    )
    return '两条都在目录里，也真的绑上了'
  })

  // ================================================================ 4
  section('4. 错误处理')

  await check('★ 查询抛错时：是我们的中文错误页，而且侧栏还在', async () => {
    /*
     * ⚠️ 顺序要紧：**先导航，再打桩**。
     *
     * 打桩是改当前文档里那个模块对象，而 `goto` 是整页导航——文档一换，
     * 模块重新实例化，桩就没了。第一版把顺序写反了，于是桩一次都没被调用，
     * 而页面看起来「没报错」，差一点就成了一条永远绿的假断言。
     * 所以后面的步骤走 SPA 内的链接点击（不重载文档）。
     */
    await goto(BASE)
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      window.__origChapters = repo.ChapterRepository.listBySubjectWithStats
      window.__stubHits = 0
      repo.ChapterRepository.listBySubjectWithStats = () => {
        window.__stubHits += 1
        return Promise.reject(new Error('__M45_STUB__ 故意失败'))
      }
    })()`)

    // 走站内路由进科目页，查询在渲染期抛错
    await clickLink(`/subjects/${ids.sid}`)
    await sleep(600)

    const hits = await evaluate(`window.__stubHits ?? 0`)
    assert(hits > 0, '桩一次都没被调用——说明它没装上，这条断言下面全是空话')

    const text = await evaluate(BODY_TEXT)
    assert(
      !text.includes('Unexpected Application Error'),
      '掉进了 react-router 的默认英文错误页，说明错误边界没生效',
    )
    assert(text.includes('这个页面出错了'), `没看到自己的错误页。页面文字：${text.slice(0, 120)}`)
    assert(await evaluate(SIDEBAR), '侧栏不见了——内容区出错不该把外壳也带走')
    return `桩命中 ${hits} 次，中文错误页 + 侧栏都在`
  })

  await check('★ 「重试」能真的恢复（不是个摆设按钮）', async () => {
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      repo.ChapterRepository.listBySubjectWithStats = window.__origChapters
    })()`)
    await clickText('重试')
    await sleep(600)
    const ids2 = await evaluate(CARD_IDS)
    assert(ids2.length === 2, `重试之后章节列表没回来，卡片数 ${ids2.length}`)
    assert(!(await evaluate(BODY_TEXT)).includes('这个页面出错了'), '错误页还在')
    return `${ids2.length} 个章节回来了`
  })

  await check('★ 删除失败时对话框不关，并且说得出原因', async () => {
    // 先导航再打桩，理由同上一节
    await goto(BASE)
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      window.__origRemove = repo.SubjectRepository.remove
      window.__removeHits = 0
      repo.SubjectRepository.remove = () => {
        window.__removeHits += 1
        return Promise.reject(new Error('__M45_STUB__ 删除失败'))
      }
    })()`)

    await evaluate(`(() => {
      const card = document.querySelector('[data-reorder-id]')
      const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除')
      btn.click()
    })()`)
    await sleep(400)
    assert((await evaluate(DIALOG_COUNT)) === 1, '删除确认框没打开')

    await clickInDialog('删除')
    await sleep(500)
    const hits = await evaluate(`window.__removeHits ?? 0`)
    assert(hits > 0, '桩没被调用')
    assert((await evaluate(DIALOG_COUNT)) === 1, '对话框关掉了——失败时不该关，用户会以为删成功了')
    const text = await evaluate(BODY_TEXT)
    assert(text.includes('删除失败'), `对话框里没显示失败原因。页面文字：${text.slice(0, 160)}`)
    await press('Escape')
    await sleep(200)

    // 恢复，并确认成功路径没被上面的修复搞坏
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      repo.SubjectRepository.remove = window.__origRemove
    })()`)
    return `桩命中 ${hits} 次，对话框留在原地并给出原因`
  })

  await check('★ 新建笔记失败时给得出反馈（原来只有 finally，静默）', async () => {
    await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}`)
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      window.__origCreate = repo.NoteRepository.create
      window.__createHits = 0
      repo.NoteRepository.create = () => {
        window.__createHits += 1
        return Promise.reject(new Error('__M45_STUB__ 建不出来'))
      }
    })()`)

    await clickText('+ 新建笔记')
    await sleep(500)

    const hits = await evaluate(`window.__createHits ?? 0`)
    assert(hits > 0, '桩没被调用')
    const text = await evaluate(BODY_TEXT)
    assert(
      text.includes('新建笔记失败'),
      `页面上没有失败提示——用户只会以为没点到，再点一次。文字：${text.slice(0, 160)}`,
    )

    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      repo.NoteRepository.create = window.__origCreate
    })()`)
    return `桩命中 ${hits} 次，页面上有提示`
  })

  // ================================================================ 5
  section('5. 空状态：加载中不能显示成「还没有」')

  await check('★ 自定义符号还没读回来时显示的是读取中，不是「还没有」', async () => {
    // 先导航再打桩（整页导航会把桩冲掉）
    await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`)

    // 用「永不 resolve 的 Promise」把加载态冻住：比 sleep 之后看一眼可靠得多，
    // 因为它把时序竞争变成了零竞争
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      window.__origSymbolList = repo.SymbolRepository.list
      repo.SymbolRepository.list = () => new Promise(() => {})
    })()`)
    await waitFor(
      () =>
        evaluate(
          `!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '插入图形') || {}).disabled`,
        ),
      { timeout: 25_000, label: '编辑器就绪' },
    )
    await clickText('插入图形')
    await sleep(300)
    await clickText('新建图形')
    await sleep(800)

    const panel = await evaluate(
      `document.querySelector('[data-symbol-panel]')?.innerText ?? null`,
    )
    assert(panel !== null, '画板没打开（找不到符号面板）')
    assert(
      !panel.includes('还没有。点'),
      `「我的符号」那一段在还没读回来的时候就显示了空状态文案——` +
        `用户会看到一个「你的符号不见了」的瞬间`,
    )
    assert(panel.includes('加载中'), `面板里没有加载态。实际文字：${panel.slice(0, 120)}`)

    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      repo.SymbolRepository.list = window.__origSymbolList
    })()`)
    return '显示的是加载态'
  })

  // ================================================================ 6
  section('6. 深色模式')

  await check('★ 内联脚本的时机：dark 类必须在文档还在 loading 时就加上', async () => {
    // 「跟系统」+ 系统是深色 → 首屏就该是深色，而且必须是内联脚本干的
    await setTheme({ hint: 'system', stored: 'system', system: 'dark' })
    await goto(BASE, { reload: true })
    const timing = await darkTiming()
    assert(timing !== null, '<html> 从来没有拿到 dark 类')
    assert(
      timing.readyState === 'loading',
      `dark 类是到 ${timing.readyState} 才加上的——那只可能是 React 干的，` +
        `首屏会先白一下。「跟随系统」必须在 index.html 的内联脚本里就定下来`,
    )
    assert(await evaluate(IS_DARK), '首屏是深色，但 hydrate 之后又变回浅色了')
    return 'dark @ loading'
  })

  await check('★ 提示位过期时以数据库为准（提示位只是提示）', async () => {
    // localStorage 说深色，数据库说浅色 → 首屏该是深色（照提示位来，别闪白），
    // 读完设置之后必须纠正成浅色
    await setTheme({ hint: 'dark', stored: 'light', system: 'light' })
    // 记录「重新加载之前」的提示位：它要和下面的 darkAt 一起看才知道
    // 是内联脚本没生效，还是提示位压根没写进去
    const hintBefore = await evaluate(`localStorage.getItem('xxbj.theme')`)
    const originBefore = await evaluate(`performance.timeOrigin`)
    await sleep(200)
    await goto(BASE, { reload: true })
    const timing = await darkTiming()
    const diag = JSON.stringify({
      hintBefore,
      // timeOrigin 没变就说明这一次 reload 压根没发生——后面的结论全都不成立
      reloaded: (await evaluate(`performance.timeOrigin`)) !== originBefore,
      probeRan: await evaluate(`typeof window.__darkAt !== 'undefined'`),
      hintAtLoad: await evaluate(`window.__hintAtLoad ?? null`),
      darkAt: timing,
      hint: await evaluate(`localStorage.getItem('xxbj.theme')`),
      dark: await evaluate(IS_DARK),
    })
    assert(
      timing?.readyState === 'loading',
      `过期提示位没有在首屏生效——白闪会在设置读回来之前发生。实测：${diag}` +
        `（how 应该是 add，也就是 index.html 里那段内联脚本；是 toggle 的话说明 React 抢先了）`,
    )
    assert(
      !(await evaluate(IS_DARK)),
      '数据库里存的是浅色，页面上却还是深色——applyTheme 没在 hydrate 之后纠正',
    )
    return '首屏深 → hydrate 后浅'
  })

  await check('★ 切到深色：html 的类、提示位、两条 theme-color 一起改', async () => {
    await setTheme({ hint: 'light', stored: 'light', system: 'light' })
    await goto(BASE, { reload: true })
    assert(!(await evaluate(IS_DARK)), '起点不是浅色，后面的对比没有意义')

    // 点侧栏底部那个主题按钮：浅色 → 深色（顺序是 light → dark → system）。
    // 按钮里混了个 ◐ 图标，所以要按「包含」找
    await clickContaining('主题：浅色')
    await sleep(400)

    assert(await evaluate(IS_DARK), '点了主题按钮，<html> 上还是没有 dark 类')
    const state = await evaluate(`(() => {
      const metas = [...document.querySelectorAll('meta[name="theme-color"]')]
      return {
        hint: localStorage.getItem('xxbj.theme'),
        media: metas.map((m) => m.getAttribute('media')),
      }
    })()`)
    assert(state.hint === 'dark', `提示位没跟上，还是 ${state.hint}`)
    assert(
      JSON.stringify(state.media) === JSON.stringify(['not all', 'all']),
      `两条 theme-color 的 media 没对调：${JSON.stringify(state.media)}`,
    )
    return '类、提示位、meta 三处都改了'
  })

  await check('★ 对比度扫描（深色下）：笔记页，连编辑器工具栏一起', async () => {
    // 笔记页是元素最杂的一屏（编辑器工具栏、CodeMirror、侧栏、正文），
    // 深色下真正会「看不见」的东西都藏在这里
    await evaluate(`(async () => {
      localStorage.setItem('xxbj.theme', 'dark')
      const repo = await import('/src/repository/index.ts')
      await repo.SettingRepository.set(repo.SETTING_KEYS.theme, 'dark')
    })()`)
    await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`)
    await waitFor(
      () => evaluate(`document.querySelector('.note-editor .milkdown') !== null`),
      { timeout: 25_000, label: '编辑器就绪' },
    )
    await sleep(400)

    const scan = await evaluate(SCAN_CONTRAST)
    assert(
      scan.worst.length === 0 || scan.worst[0].ratio >= 3,
      `深色下有 ${scan.total} 处前景低于 3:1，最差的几个：\n        ${describeWorst(scan)}`,
    )
    return `扫了 ${scan.total} 处前景，最差 ${scan.worst[0]?.ratio.toFixed(2) ?? '-'}:1`
  })

  await check('★ 对比度扫描（深色下）：首页', async () => {
    await goto(BASE)
    assert(await evaluate(IS_DARK), '现在不是深色')
    const scan = await evaluate(SCAN_CONTRAST)
    assert(
      scan.worst.length === 0 || scan.worst[0].ratio >= 3,
      `首页深色下有 ${scan.total} 处前景低于 3:1，最差的几个：\n        ${describeWorst(scan)}`,
    )
    return `扫了 ${scan.total} 处前景，最差 ${scan.worst[0]?.ratio.toFixed(2) ?? '-'}:1`
  })

  await check('★ 符号面板的缩略图在深色下看得见（这条抓的就是那次真 bug）', async () => {
    assert(await evaluate(IS_DARK), '现在不是深色')
    await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`)
    await waitFor(
      () =>
        evaluate(
          `!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '插入图形') || {}).disabled`,
        ),
      { timeout: 25_000, label: '编辑器就绪' },
    )
    await clickText('插入图形')
    await sleep(300)
    await clickText('新建图形')
    await sleep(900)

    const sample = await evaluate(SYMBOL_THUMB_CONTRAST)
    assert(sample !== null, '没找到符号面板里的缩略图')
    const ratio = sample.ratio
    assert(
      ratio >= 3,
      `缩略图的墨色（${sample.fg}）压在面板底色（${sample.bg}）上只有 ${ratio.toFixed(2)}:1` +
        `——深灰画在深灰上，等于看不见。描边要用 currentColor，不能用写死的 INK_COLOR`,
    )
    return `${sample.fg} on ${sample.bg} = ${ratio.toFixed(2)}:1`
  })

  await check('★ 正文里的图：深色下压暗加边，浅色下原样', async () => {
    // 造一张真的图进正文
    const made = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const canvas = document.createElement('canvas')
      canvas.width = 40
      canvas.height = 30
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 40, 30)
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
      const att = await repo.AttachmentRepository.createImage({
        noteId: ${JSON.stringify(ids.nid)}, blob, width: 40, height: 30,
      })
      await repo.NoteRepository.saveContent(
        ${JSON.stringify(ids.nid)},
        '自查图片\\n\\n![1.00](asset://' + att.id + ' "自检用图")\\n',
      )
      return att.id
    })()`)
    assert(made, '图没造出来')

    await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`)
    await waitFor(
      () => evaluate(`document.querySelectorAll('.note-editor .milkdown img').length > 0`),
      { timeout: 25_000, label: '正文里的图渲染出来' },
    )
    await sleep(300)

    const styleOf = `(() => {
      const img = document.querySelector('.note-editor .milkdown img')
      const s = getComputedStyle(img)
      return { filter: s.filter, border: s.borderTopWidth, src: img.getAttribute('src')?.slice(0, 5) }
    })()`

    const dark = await evaluate(styleOf)
    assert(
      dark.filter !== 'none' && dark.filter.includes('brightness'),
      `深色下没有压暗：filter = ${dark.filter}`,
    )
    assert(dark.border !== '0px', `深色下没有边框：border-top-width = ${dark.border}`)

    // 浅色下必须原样——这条防的是「规则写成了无条件的」，
    // 那会悄悄改掉所有老笔记的样子，而且没人知道是这次改的
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      await repo.SettingRepository.set(repo.SETTING_KEYS.theme, 'light')
      localStorage.setItem('xxbj.theme', 'light')
    })()`)
    await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`)
    await waitFor(
      () => evaluate(`document.querySelectorAll('.note-editor .milkdown img').length > 0`),
      { timeout: 25_000, label: '图再次渲染' },
    )
    const light = await evaluate(styleOf)
    assert(
      light.filter === 'none' && light.border === '0px',
      `浅色下图片也被改了：filter=${light.filter} border=${light.border}`,
    )
    return `深色 ${dark.filter} / ${dark.border}；浅色 ${light.filter} / ${light.border}`
  })

  await check('★ Crepe 编辑器的深色变量没被懒加载的样式表吃掉', async () => {
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      await repo.SettingRepository.set(repo.SETTING_KEYS.theme, 'dark')
      localStorage.setItem('xxbj.theme', 'dark')
    })()`)
    await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`)
    await waitFor(
      () => evaluate(`document.querySelector('.note-editor .milkdown') !== null`),
      { timeout: 25_000, label: '编辑器就绪' },
    )
    const bg = await evaluate(`(() => {
      const el = document.querySelector('.note-editor .milkdown')
      return getComputedStyle(el).getPropertyValue('--crepe-color-background').trim()
    })()`)
    assert(bg !== '', '--crepe-color-background 是空的，深色覆盖没生效')
    // 按亮度判，不按字符串比——色值以后可能调
    const m = bg.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
    if (m) {
      const avg = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3
      assert(
        avg < 80,
        `--crepe-color-background 是 ${bg}，看着不像深色。` +
          `多半是 index.css 里那条覆盖丢了 .note-editor 前缀，被晚加载的 chunk 静默盖掉了`,
      )
    }
    return `--crepe-color-background = ${bg}`
  })

  // ================================================================ 7
  section('7. 页面报错')
  await check('全程没有未预期的页面报错', async () => {
    assert(
      pageErrors.length === 0,
      `${pageErrors.length} 条：\n      ${pageErrors.slice(0, 4).map((e) => String(e).slice(0, 200)).join('\n      ')}`,
    )
    return '0 条（故意弄坏的那几处已按类别过滤）'
  })
} catch (e) {
  failures += 1
  console.log(`\n脚本中断：${e.message}`)
  for (const p of pageErrors.slice(0, 6)) {
    console.log(`  页面报错：${String(p).slice(0, 250)}`)
  }
} finally {
  // 自检数据用完就删，别在 dev 的库里越攒越多
  await evaluate(`(async () => {
    const repo = await import('/src/repository/index.ts')
    for (const id of ${JSON.stringify(ids.subjects)}) {
      await repo.SubjectRepository.remove(id).catch(() => {})
    }
  })()`).catch(() => {})

  console.log('\n' + '─'.repeat(60))
  console.log(failures === 0 ? '全部通过。' : `${failures} 项失败。`)
  await edge.close()
  // 杀掉整棵进程树，并且**等它真的退完**再走：早点退出会让 dev 服务器
  // 留在端口上，下一次自检就会测那份旧代码（见 assertPortFree）
  if (process.platform === 'win32' && devServer.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(devServer.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
      killer.on('exit', resolve)
      killer.on('error', resolve)
    })
  } else {
    devServer.kill()
  }
  await sleep(300)
  process.exit(failures === 0 ? 0 : 1)
}
