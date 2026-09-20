/**
 * 键盘快捷键的端到端验证。
 *
 * 跑在 **vite dev** 上，而不是构建产物上——因为测试要直接 import `/src/...`
 * 的模块（读目录、读注册表、建测试数据）。脚本自己起一个 dev 服务器
 * （端口 5198，和 verify-board 的 5199 错开，两个可以同时跑），跑完关掉。
 *
 * ## 按键的可信度分三级，这一节决定了每条断言该怎么写
 *
 * | 等级 | 手段 | 能证明 | 不能证明 |
 * | --- | --- | --- | --- |
 * | 可信 | 行为断言：路由、DOM 出现/消失、Dexie 里的行 | 功能真的发生了 | — |
 * | 半可信 | defaultPrevented 探针 | App「认领」了这个键（对 Ctrl+S 就是压掉浏览器默认行为的那一半证据） | 浏览器真的没执行它自己的动作 |
 * | 不可测 | — | — | 浏览器保留键；输入法的选字状态 |
 *
 * CDP 注入的事件是可信事件，但它走渲染进程的输入通道，**绕过了浏览器进程的
 * 快捷键处理**。所以像 Ctrl+N / Ctrl+T / Ctrl+W 这类被浏览器保留的组合，
 * 页面在测试里能收到、真人按下去却根本到不了页面——用行为断言去测它们
 * 只会得到一条永远通过的假测试。这类组合只能在**数据上**禁掉（见第 0 节）。
 *
 * 同理，中文输入法选字时 Chromium 把 key 报成 'Process'、keyCode 229，
 * Alt+N 在那个瞬间不会命中——那一段 CDP 完全测不到，只能人工试，
 * 步骤写在 README 的「注意事项」里。
 *
 * 覆盖的都是「看起来能跑但其实是坏的」那类故障：
 *
 *   1. 对话框/画板开着时全局快捷键还在生效——按一下 Ctrl+K 把用户填了一半的表单卸载掉
 *   2. Ctrl+B 在编辑器里本该是「加粗」，却被侧栏折叠抢走（靠 defaultPrevented 让位）
 *   3. 笔记 → 笔记切换时组件不卸载，把上一篇的正文带进下一篇
 *   4. 画板里 Shift+R 也切工具（Shift 是留给「约束角度」的）
 *   5. 画板里嵌套的确认框按 Esc 关不掉（画板无条件 stopPropagation 挡住了冒泡）
 *   6. 浮层计数只加不减，导致所有全局快捷键永久失效
 *   7. 目录里写着某条快捷键，代码里却没有绑定（或反过来）
 *
 * 用法：npm run verify:shortcuts
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { launchEdge, sleep, waitFor } from './lib/cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5198
const BASE = `http://localhost:${PORT}`
const MARKER = 'MARKER-A-正文标记'

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
 * ⚠️ 这次「端口已经有人应答」的检查不能省。
 *
 * `--strictPort` 会让新服务器在端口被占时退出，但下面的 `waitFor` 只等
 * 「这个端口有响应」——上一次自检没清干净的服务器会替它应答，于是整个脚本
 * 测的是那个旧进程里的旧代码，而且全程不报错。这个坑真踩过：5198 上残留着
 * 一个上个会话起的服务器，「目录里的全局绑定与代码里注册的对不上」就一直
 * 失败，而代码本身是好的。**假测试比没有测试更糟**，它会让人去改没坏的东西。
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

const pageErrors = []
on('Runtime.exceptionThrown', (p) =>
  pageErrors.push(
    p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text,
  ),
)
on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') {
    pageErrors.push(p.args.map((a) => a.value ?? a.description).join(' '))
  }
})

// ---------------------------------------------------------------- 按键

/** CDP 的修饰键位图 */
const BIT = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

const CODE_OVERRIDES = {
  '/': 'Slash',
  '-': 'Minus',
  ']': 'BracketRight',
  '[': 'BracketLeft',
  Escape: 'Escape',
  Tab: 'Tab',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Enter: 'Enter',
}
const VK_OVERRIDES = {
  Escape: 27,
  Tab: 9,
  Delete: 46,
  Backspace: 8,
  Enter: 13,
  '/': 191,
  '-': 189,
  ']': 221,
  '[': 219,
}

/** code / keyCode 只在认得出来的时候才带上，认不出来就交给 Chromium 自己推 */
function codeOf(key) {
  if (CODE_OVERRIDES[key]) return CODE_OVERRIDES[key]
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return null
}

function vkOf(key) {
  if (VK_OVERRIDES[key]) return VK_OVERRIDES[key]
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0)
  return 0
}

function keyBase(key, modifiers, text) {
  const base = {
    key,
    windowsVirtualKeyCode: vkOf(key),
    nativeVirtualKeyCode: vkOf(key),
    modifiers,
  }
  const code = codeOf(key)
  if (code) base.code = code
  if (text !== undefined) {
    base.text = text
    base.unmodifiedText = text
  }
  return base
}

async function press(key, { ctrl = false, alt = false, shift = false } = {}) {
  const modifiers =
    (ctrl ? BIT.ctrl : 0) | (alt ? BIT.alt : 0) | (shift ? BIT.shift : 0)
  const base = keyBase(key, modifiers)
  await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(60)
}

/**
 * 逐字打进去。
 *
 * 用带 text 的 keyDown 而不是 Input.insertText：后者对普通 <input> 有效，
 * 但对 ProseMirror 这种 contenteditable 不一定会走到它的输入管线里——
 * 表现是「库里什么都没变」，看起来像快捷键坏了，其实是压根没输入进去。
 * 逐字发 keyDown 走的是和真人打字同一条路。
 */
async function typeText(text) {
  for (const ch of text) {
    const base = keyBase(ch, 0, ch)
    await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  await sleep(150)
}

/**
 * 装一个按键探针。
 *
 * 必须 **在 App 自己的监听器之后** 注册，而且必须在 window 的冒泡阶段：
 * 同一节点同一阶段是按注册顺序执行的，后注册的后执行，于是它读到的
 * defaultPrevented 已经反映了 App（或 ProseMirror）做过的事。
 * 装成捕获阶段就完全反了，什么都读不到。
 *
 * 附带一个用处：画板里 stopPropagation 生效时探针**一条都收不到**，
 * 所以「画板挡住了全局快捷键」可以直接断言成 probe.length === 0。
 */
const INSTALL_PROBE = `(() => {
  window.__probe = []
  window.addEventListener('keydown', (e) => {
    window.__probe.push({
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      prevented: e.defaultPrevented,
    })
    if (window.__probe.length > 50) window.__probe.shift()
  })
  return true
})()`

const clearProbe = () => evaluate(`(window.__probe = [], true)`)
const lastProbe = () => evaluate(`window.__probe.at(-1) ?? null`)
const overlayDepth = () =>
  evaluate(
    `(async () => (await import('/src/lib/shortcuts/overlay.ts')).overlayDepth())()`,
  )

// ---------------------------------------------------------------- 页面助手

const PATH = `location.pathname + location.search`
const DIALOG_COUNT = `document.querySelectorAll('[role="dialog"]').length`
const DIALOG_TITLE = `document.querySelector('[role="dialog"] h2')?.textContent ?? null`
const ASIDE = `Boolean(document.querySelector('aside'))`

/** 画板当前选中的工具，如 '直线（L）' */
const ACTIVE_TOOL = `(() => {
  const tools = [...document.querySelectorAll('button[title]')]
    .filter((b) => /（[VLRPO]）$/.test(b.title))
  return tools.find((b) => b.getAttribute('aria-pressed') === 'true')?.title ?? null
})()`

// 用 ?. 是因为画板关掉之后这个选择器会返回 null，
// 而「画板还在不在」正是靠它来判断的
const BOARD = `(document.querySelector('[data-board="main"]') ?? null)`

const EDITOR_TEXT = `document.querySelector('.note-editor')?.innerText ?? ''`

/**
 * 等应用 hydrate 完。
 *
 * AppLayout 在设置读回来之前只渲染「正在启动…」，那时候既没有 <aside>
 * 也没有折叠态的那条窄栏。不等的话，「侧栏是不是折叠的」这种断言会在
 * 一个还没渲染出侧栏的页面上求值，得到的是一个假结论。
 */
async function waitForAppReady() {
  await waitFor(
    () =>
      evaluate(
        `Boolean(document.querySelector('aside') || document.querySelector('button[aria-label="展开侧栏"]'))`,
      ),
    { timeout: 15_000, label: '应用启动完成' },
  )
}

async function goto(url) {
  const loaded = edge.waitForLoad(20_000)
  await call('Page.navigate', { url })
  await loaded
  await waitForAppReady()
  await sleep(300)
  // 页面换了，探针要重新装（监听器挂在旧的 window 上，已经随文档销毁）
  await evaluate(INSTALL_PROBE)
}

const clickText = (text) =>
  evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)})
    if (!btn) throw new Error('找不到按钮：' + ${JSON.stringify(text)})
    btn.click()
  })()`)

async function waitForEditor() {
  await waitFor(
    () =>
      evaluate(
        `!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '插入图形') || {}).disabled`,
      ),
    { timeout: 25_000, label: '编辑器就绪' },
  )
}

async function focusEditor() {
  const ok = await evaluate(`(() => {
    const el = document.querySelector('.note-editor [contenteditable="true"]')
    if (!el) return false
    el.focus()
    return document.activeElement === el
  })()`)
  assert(ok, '没找到正文编辑区')
}

try {
  await goto(BASE)

  // ---------------------------------------------------------------- 准备
  section('0. 准备数据 + 目录自检')
  const ids = await evaluate(`(async () => {
    const repo = await import('/src/repository/index.ts')
    const s = await repo.SubjectRepository.create({ name: '【快捷键自检】' })
    const c = await repo.ChapterRepository.create({ subjectId: s.id, name: '自检章节' })
    const n = await repo.NoteRepository.create({ chapterId: c.id, title: '自检笔记 A' })
    await repo.NoteRepository.saveContent(n.id, ${JSON.stringify(MARKER)})
    return { sid: s.id, cid: c.id, nid: n.id }
  })()`)
  assert(ids?.nid, '没有建出测试数据')

  await check('先证明 CDP 送出去的按键是预期的那一个', async () => {
    // 特意挑一个**没有绑定**的组合：这一条只是在校验 CDP 的参数有没有送对，
    // 要是用了 Ctrl+B 就会顺手把侧栏折了，后面所有关于侧栏的断言都会读到一个
    // 自己造出来的副作用（这个坑真踩过一次）。
    await clearProbe()
    await press('k', { ctrl: true, shift: true })
    const p = await lastProbe()
    assert(p, '探针一条都没收到——监听器没装上，或事件根本没到页面')
    assert(p.key === 'k', `key 是 ${JSON.stringify(p.key)}`)
    assert(
      p.ctrl === true && p.shift === true && p.alt === false,
      JSON.stringify(p),
    )
    return JSON.stringify(p)
  })

  await check('目录数据自洽', async () => {
    const r = await evaluate(`(async () => {
      const cat = await import('/src/lib/shortcuts/catalog.ts')
      const all = cat.allEntries()
      const ids = all.map((e) => e.id)
      const groups = {}
      for (const e of all) groups[e.group] = (groups[e.group] ?? 0) + 1
      return {
        total: all.length,
        dupes: ids.filter((id, i) => ids.indexOf(id) !== i),
        empty: ids.filter((id) => !id),
        groups,
        appComboKeys: all
          .filter((e) => e.by === 'app')
          .flatMap((e) => e.keys.map((k) =>
            [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.key.length === 1 ? k.key.toUpperCase() : k.key]
              .filter(Boolean).join('+'))),
        appGlobalIds: all.filter((e) => e.group === 'global' && e.by === 'app').map((e) => e.id),
        editorCount: all.filter((e) => e.by === 'editor').length,
      }
    })()`)
    assert(r.dupes.length === 0, `id 重复：${r.dupes.join(', ')}`)
    assert(r.empty.length === 0, '有空 id')
    assert(r.total >= 25, `条目只有 ${r.total} 条，像是被删过`)
    for (const g of ['global', 'page', 'editor', 'board']) {
      assert(r.groups[g] > 0, `分组 ${g} 是空的`)
    }
    assert(r.editorCount >= 10, `编辑器那一组只有 ${r.editorCount} 条`)
    return `${r.total} 条（${Object.entries(r.groups).map(([k, v]) => `${k} ${v}`).join('，')}）`
  })

  /*
   * 画板那一组（`by: 'board'`）在别处是被排除在机械比对之外的——它不由
   * 快捷键层实现，所以「目录写了但没绑定」不成立。代价是它的**文案会漂**：
   * 条目里那句「依次对应 V、L、R、O、P」是手写的散文，加了橡皮之后没人改
   * 就永远停在那儿。所以这里单独拿它和真正的映射表对一次。
   */
  await check('★ 画板工具那条写的字母和实际的工具映射一致', async () => {
    const r = await evaluate(`(async () => {
      const cat = await import('/src/lib/shortcuts/catalog.ts')
      const tools = await import('/src/components/board/tools.ts')
      return {
        inCatalog: cat.entryOf('bd-tools').keys.map((k) => k.key).sort(),
        inCode: [...tools.HOTKEY_TO_TOOL.keys()].sort(),
      }
    })()`)
    assert(
      JSON.stringify(r.inCatalog) === JSON.stringify(r.inCode),
      `目录里写的是 ${r.inCatalog.join('/')}，代码里是 ${r.inCode.join('/')}`,
    )
    return r.inCode.map((k) => k.toUpperCase()).join(' ')
  })

  await check('★ 目录里的全局绑定与代码里注册的完全对得上', async () => {
    const r = await evaluate(`(async () => {
      const cat = await import('/src/lib/shortcuts/catalog.ts')
      const hooks = await import('/src/lib/shortcuts/useShortcuts.ts')
      const registered = new Set(hooks.registeredIds())
      return {
        registered: [...registered].sort(),
        appGlobalIds: cat.allEntries().filter((e) => e.group === 'global' && e.by === 'app').map((e) => e.id).sort(),
        unknown: [...registered].filter((id) => cat.allEntries().every((e) => e.id !== id)),
      }
    })()`)
    // 两个方向都要查：目录里写了没绑（用户按下去没反应），
    // 或者绑了目录里没写（一览表漏了一条）
    const missing = r.appGlobalIds.filter((id) => !r.registered.includes(id))
    assert(
      missing.length === 0,
      `目录里写了但没绑定：${missing.join(', ')}\n` +
        `      目录认为该绑的：${JSON.stringify(r.appGlobalIds)}\n` +
        `      代码实际注册的：${JSON.stringify(r.registered)}`,
    )
    assert(r.unknown.length === 0, `绑定了但目录里没有：${r.unknown.join(', ')}`)
    return `已注册 ${r.registered.join(', ')}`
  })

  await check('★ 没有一条绑定占用浏览器的保留键', async () => {
    // 这些组合页面根本收不到（由浏览器进程处理），绑了等于没绑，
    // 而且是那种「测试里能过、真人按下去没反应」的假成功。
    const RESERVED = new Set([
      'Ctrl+N', 'Ctrl+T', 'Ctrl+W', 'Ctrl+L',
      'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W',
    ])
    const hits = await evaluate(`(async () => {
      const cat = await import('/src/lib/shortcuts/catalog.ts')
      return cat.allEntries().filter((e) => e.by === 'app').flatMap((e) =>
        e.keys.map((k) => ({
          id: e.id,
          combo: [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.key.length === 1 ? k.key.toUpperCase() : k.key]
            .filter(Boolean).join('+'),
        })))
    })()`)
    const bad = hits.filter((h) => RESERVED.has(h.combo))
    assert(
      bad.length === 0,
      `用了浏览器保留键：${bad.map((b) => `${b.id} ${b.combo}`).join('，')}`,
    )
    return `${hits.length} 条候选，0 条撞上保留键`
  })

  await check('App 自己的绑定之间没有撞键', async () => {
    const combos = await evaluate(`(async () => {
      const cat = await import('/src/lib/shortcuts/catalog.ts')
      return cat.allEntries()
        .filter((e) => e.by === 'app')
        .map((e) => ({
          scope: e.group === 'global' ? 'global' : 'page:' + e.id,
          keys: e.keys.map((k) => [k.ctrl && 'ctrl', k.alt && 'alt', k.shift && 'shift', k.key].filter(Boolean).join('+')),
        }))
    })()`)
    // 同作用域内不能撞。跨作用域（全局 Ctrl+B 与编辑器 Ctrl+B）是**故意**的，
    // 靠 defaultPrevented 让位，所以不在这里查。
    const seen = new Map()
    for (const entry of combos) {
      for (const key of entry.keys) {
        const where = seen.get(key)
        assert(
          !where || where.split(':')[0] !== entry.scope.split(':')[0],
          `${key} 在 ${where} 和 ${entry.scope} 里重复`,
        )
        seen.set(key, entry.scope)
      }
    }
    return `${combos.length} 条`
  })

  // ---------------------------------------------------------------- 全局
  section('1. 全局快捷键')
  await check('Ctrl+K 打开搜索并聚焦搜索框', async () => {
    await press('k', { ctrl: true })
    const r = await evaluate(
      `({ path: ${PATH}, focused: document.activeElement?.tagName })`,
    )
    assert(r.path === '/search', `路径是 ${r.path}`)
    assert(r.focused === 'INPUT', `焦点在 ${r.focused}`)
    return r.path
  })

  await check('★ 已经在搜索页时再按 Ctrl+K，不压重复历史记录', async () => {
    const before = await evaluate('history.length')
    await press('k', { ctrl: true })
    const after = await evaluate('history.length')
    const focused = await evaluate(
      `document.activeElement === document.querySelector('input[type="search"]')`,
    )
    // 全局那个绑定看到已经在 /search 就什么都不做，重新聚焦归搜索页自己
    assert(after === before, `历史长度从 ${before} 变成了 ${after}`)
    assert(focused, '按了之后焦点不在搜索框里')
    return `history.length 保持 ${after}`
  })

  await check('★ Ctrl+Shift+K 不触发（修饰键精确匹配）', async () => {
    const before = await evaluate('history.length')
    await press('k', { ctrl: true, shift: true })
    const r = await evaluate(`({ path: ${PATH}, history: history.length })`)
    assert(r.path === '/search', `路径变成 ${r.path}`)
    // 旧写法 `(ctrlKey || metaKey) && key === 'k'` 会让这个组合也打开搜索，
    // 顺手压一条历史记录——这条断言守的就是精确匹配
    assert(r.history === before, `历史长度从 ${before} 变成了 ${r.history}`)
    return `没反应，history 保持 ${before}`
  })

  await check('★ Ctrl+/ 跳到设置页的快捷键一览并高亮它', async () => {
    await goto(BASE)
    await press('/', { ctrl: true })
    await sleep(400)
    const r = await evaluate(`(() => {
      const section = document.getElementById('shortcuts')
      if (!section) return { path: ${PATH}, found: false }
      const box = section.getBoundingClientRect()
      return {
        path: ${PATH},
        found: true,
        heading: section.querySelector('h2')?.textContent ?? null,
        kbdCount: section.querySelectorAll('kbd').length,
        highlighted: section.className.includes('ring-2'),
        // 滚进视野了没有：区块顶部落在视口里，且底部没跑到视口上方
        inView: box.top < window.innerHeight && box.bottom > 0,
      }
    })()`)
    assert(r.path === '/settings', `路径是 ${r.path}`)
    assert(r.found, '设置页里没有 #shortcuts 这一节')
    assert(r.heading === '键盘快捷键', `标题是 ${JSON.stringify(r.heading)}`)
    assert(r.inView, '跳过来了但没有滚进视野')
    assert(r.highlighted, '没有高亮，用户不知道该看哪儿')
    return `${r.heading}，${r.kbdCount} 个键帽`
  })

  await check('★ 一览表把目录里的条目一条不落地列了出来', async () => {
    // 这条守的是用户真正要的东西：他问「有哪些快捷键」，答案必须完整。
    // 目录加了条目却忘了渲染（或者渲染时按错了分组）都会在这里露出来。
    const r = await evaluate(`(async () => {
      const cat = await import('/src/lib/shortcuts/catalog.ts')
      const section = document.getElementById('shortcuts')
      const labelText = section.innerText
      return {
        total: cat.allEntries().length,
        missing: cat.allEntries()
          .filter((e) => !labelText.includes(e.label))
          .map((e) => e.id),
        kbdCount: section.querySelectorAll('kbd').length,
      }
    })()`)
    assert(
      r.missing.length === 0,
      `这些条目没出现在一览表里：${r.missing.join(', ')}`,
    )
    assert(
      r.kbdCount === r.total,
      `键帽 ${r.kbdCount} 个，目录里有 ${r.total} 条`,
    )
    return `${r.total} 条全部渲染`
  })

  await check('Ctrl+B 折叠侧栏，再按一次展开', async () => {
    await goto(BASE)
    assert(await evaluate(ASIDE), '起始状态侧栏就是折叠的')
    await press('b', { ctrl: true })
    await sleep(200)
    assert((await evaluate(ASIDE)) === false, '按了 Ctrl+B 侧栏还在')
    await press('b', { ctrl: true })
    await sleep(200)
    assert(await evaluate(ASIDE), '再按一次侧栏没回来')
    return '折叠 / 展开都对'
  })

  await check('折叠状态刷新后仍然折叠（走 Dexie 持久化）', async () => {
    await press('b', { ctrl: true })
    await sleep(300)
    const loaded = edge.waitForLoad(20_000)
    await call('Page.reload', {})
    await loaded
    await waitForAppReady()
    await sleep(400)
    await evaluate(INSTALL_PROBE)
    assert((await evaluate(ASIDE)) === false, '刷新之后侧栏自己展开了')
    // 收尾：展开回来，别把开发环境的界面留在折叠状态
    await press('b', { ctrl: true })
    await sleep(300)
    assert(await evaluate(ASIDE), '没能展开回来')
    return '折叠状态跨刷新保留'
  })

  // ---------------------------------------------------------------- 页面级
  section('2. Alt+N 按页面上下文新建')
  await check('科目列表页 → 新建科目对话框', async () => {
    await goto(BASE)
    await press('n', { alt: true })
    const title = await evaluate(DIALOG_TITLE)
    assert(title === '新建科目', `弹出的是 ${JSON.stringify(title)}`)
    // 连按不能叠出第二个对话框
    await press('n', { alt: true })
    const count = await evaluate(DIALOG_COUNT)
    assert(count === 1, `叠出了 ${count} 个对话框`)
    await press('Escape')
    assert((await evaluate(DIALOG_COUNT)) === 0, 'Esc 没关掉')
    return title
  })

  await check('科目页 → 新建章节对话框', async () => {
    await goto(`${BASE}/subjects/${ids.sid}`)
    await press('n', { alt: true })
    const title = await evaluate(DIALOG_TITLE)
    assert(title === '新建章节', `弹出的是 ${JSON.stringify(title)}`)
    await press('Escape')
    return title
  })

  await check('章节页 → 真的建出一篇笔记并跳过去', async () => {
    await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}`)
    const before = await evaluate(
      `(async () => (await (await import('/src/repository/index.ts')).NoteRepository.listByChapter(${JSON.stringify(ids.cid)})).length)()`,
    )
    await press('n', { alt: true })
    await sleep(700)
    const r = await evaluate(`(async () => ({
      path: ${PATH},
      count: (await (await import('/src/repository/index.ts')).NoteRepository.listByChapter(${JSON.stringify(ids.cid)})).length,
    }))()`)
    assert(r.path.includes('/notes/'), `没有跳进新笔记，路径是 ${r.path}`)
    assert(r.count === before + 1, `笔记数从 ${before} 变成了 ${r.count}`)
    return `笔记数 ${before} → ${r.count}`
  })

  await check('★ 笔记页 Alt+N：新建的同章节笔记不能带上上一篇的正文', async () => {
    await goto(
      `${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`,
    )
    await waitForEditor()
    const beforeText = await evaluate(EDITOR_TEXT)
    assert(
      beforeText.includes(MARKER),
      '打开 A 的时候正文里就没有标记，测试前提不成立',
    )

    await press('n', { alt: true })
    await sleep(900)
    const after = await evaluate(`(async () => ({
      path: ${PATH},
      text: ${EDITOR_TEXT},
      aContent: (await (await import('/src/repository/index.ts')).NoteRepository.get(${JSON.stringify(ids.nid)})).content,
    }))()`)

    assert(
      after.path.includes('/notes/') && !after.path.endsWith(ids.nid),
      `没有换到新笔记，路径是 ${after.path}`,
    )
    // 这条是那个「路由切换不卸载组件」bug 的回归测试：
    // 少了按 noteId 拆键重建，新笔记的编辑器里会残留上一篇的正文，
    // 接着自动保存把它写进新笔记——跨笔记写错数据
    assert(
      !after.text.includes(MARKER),
      '新笔记的编辑器里带着上一篇的正文（路由切换没重建组件）',
    )
    assert(
      after.aContent.includes(MARKER),
      '切换走了之后 A 的正文在库里丢了（兜底 flush 没生效）',
    )
    return '新笔记是干净的，A 的内容也保住了'
  })

  await check('搜索页 / 设置页按 Alt+N 什么都不发生', async () => {
    await goto(`${BASE}/search`)
    await press('n', { alt: true })
    assert(
      (await evaluate(PATH)) === '/search' &&
        (await evaluate(DIALOG_COUNT)) === 0,
      '搜索页上 Alt+N 有反应',
    )
    await goto(`${BASE}/settings`)
    await press('n', { alt: true })
    assert(
      (await evaluate(PATH)) === '/settings' &&
        (await evaluate(DIALOG_COUNT)) === 0,
      '设置页上 Alt+N 有反应',
    )
    return '两页都无反应'
  })

  await check('★ 页面级绑定随组件卸载注销', async () => {
    await goto(`${BASE}/subjects/${ids.sid}`)
    await press('n', { alt: true })
    assert((await evaluate(DIALOG_TITLE)) === '新建章节', '科目页上没生效')
    await press('Escape')

    // 按 href 点，不按文字：侧栏那个 NavLink 里还有一个 ⚙ 图标，
    // textContent 是「⚙设置与备份」，按文字精确匹配永远找不到
    await evaluate(`(() => {
      const link = document.querySelector('a[href="/settings"]')
      if (!link) throw new Error('侧栏里没有设置链接')
      link.click()
    })()`)
    await sleep(600)
    await press('n', { alt: true })
    const r = await evaluate(`({ path: ${PATH}, dialogs: ${DIALOG_COUNT} })`)
    assert(
      r.path === '/settings' && r.dialogs === 0,
      `离开科目页之后 Alt+N 还在生效（路径 ${r.path}，对话框 ${r.dialogs}）`,
    )
    return '卸载后不再响应'
  })

  // ---------------------------------------------------------------- 浮层让位
  section('3. 浮层让位（快捷键不能穿透对话框）')
  await check('★ 对话框开着时 Ctrl+K / Ctrl+B 都不生效，且输入的内容不丢', async () => {
    await goto(BASE)
    await press('n', { alt: true })
    assert((await evaluate(DIALOG_TITLE)) === '新建科目', '对话框没打开')

    // 往对话框的输入框里打字
    await evaluate(`(() => {
      const input = document.querySelector('[role="dialog"] input')
      input.focus()
      return true
    })()`)
    await call('Input.insertText', { text: 'XXBJ-浮层' })
    await sleep(150)

    await press('k', { ctrl: true })
    const afterK = await evaluate(`({ path: ${PATH}, dialogs: ${DIALOG_COUNT} })`)
    assert(afterK.path === '/', `Ctrl+K 把页面导航走了：${afterK.path}`)
    assert(afterK.dialogs === 1, 'Ctrl+K 把对话框卸载了')

    await press('b', { ctrl: true })
    assert(await evaluate(ASIDE), 'Ctrl+B 在对话框开着时把侧栏折叠了')

    const value = await evaluate(
      `document.querySelector('[role="dialog"] input')?.value ?? ''`,
    )
    // 断言用户真正会损失的东西：打了字被卸载掉才是真 bug
    assert(value === 'XXBJ-浮层', `输入框里变成了 ${JSON.stringify(value)}`)

    await press('Escape')
    assert((await evaluate(DIALOG_COUNT)) === 0, 'Esc 关不掉对话框')
    return '导航、侧栏、输入内容都没被动过'
  })

  await check('★ 浮层计数配平（只加不减会让所有全局快捷键永久失效）', async () => {
    for (let i = 0; i < 3; i += 1) {
      await press('n', { alt: true })
      await press('Escape')
    }
    const depth = await overlayDepth()
    assert(depth === 0, `开开关关三次之后计数是 ${depth}`)
    return `depth = ${depth}`
  })

  // ---------------------------------------------------------------- 编辑器
  section('4. 编辑器：让位规则与 Ctrl+S')
  await check('★ Ctrl+B 在编辑器里是加粗，不是折叠侧栏', async () => {
    await goto(
      `${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`,
    )
    await waitForEditor()
    await focusEditor()
    await press('a', { ctrl: true })
    await clearProbe()
    await press('b', { ctrl: true })
    await sleep(300)

    const r = await evaluate(`({
      strong: document.querySelectorAll('.note-editor strong').length,
      aside: ${ASIDE},
      probe: window.__probe.at(-1) ?? null,
    })`)
    assert(r.strong > 0, '没有加粗——ProseMirror 没吃到这个键')
    // 整个设计的支点：ProseMirror 消费了它并 preventDefault，
    // 全局层因此让开，侧栏不该被折叠
    assert(r.aside, '侧栏被折叠了——全局层没让位')
    assert(
      r.probe?.prevented === true,
      `探针看到的 defaultPrevented 是 ${r.probe?.prevented}`,
    )
    return `加粗 ${r.strong} 处，侧栏未动，prevented=true`
  })

  await check('编辑器自带的标题快捷键真的存在（一览表不是编的）', async () => {
    await focusEditor()
    await press('1', { ctrl: true, alt: true })
    await sleep(300)
    const n = await evaluate(`document.querySelectorAll('.note-editor h1').length`)
    assert(n > 0, 'Ctrl+Alt+1 没变成一级标题')
    return `${n} 个 h1`
  })

  await check('★ Ctrl+S 立刻落盘（不等那 1 秒防抖），且压掉了浏览器默认行为', async () => {
    await focusEditor()

    // 给 saveContent 打桩：直接观测"写"发生的时刻和写进去的内容。
    // 不去轮询数据库，是因为那样分不清这一次写到底是 Ctrl+S 干的
    // 还是 1 秒后的防抖干的——两者的时间差只有几百毫秒，读数全是噪声。
    await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      window.__saves = []
      const orig = repo.NoteRepository.saveContent
      repo.NoteRepository.saveContent = (id, content) => {
        window.__saves.push({ t: Date.now(), content })
        return orig(id, content)
      }
      return true
    })()`)

    const marker = `SAVE-${Date.now()}`
    await typeText(marker)

    // 等 300ms 再按。插件监听器的 markdownUpdated 自带 200ms 防抖
    // （@milkdown/plugin-listener），不等的话 Ctrl+S 存下的是
    // 少了最后几个字的内容——那样测出来的是这个 200ms，不是 Ctrl+S。
    await sleep(300)

    await clearProbe()
    const pressedAt = Date.now()
    await press('s', { ctrl: true })

    const probe = await lastProbe()
    assert(
      probe?.key === 's' && probe.prevented === true,
      `探针看到的是 ${JSON.stringify(probe)}——没压掉浏览器默认行为`,
    )

    const first = await evaluate(
      `window.__saves.find((s) => s.content.includes(${JSON.stringify(marker)})) ?? null`,
    )
    assert(
      first,
      `Ctrl+S 之后没有任何一次写入带上这段文字（记录到 ${await evaluate('window.__saves.length')} 次写入）`,
    )
    // 1 秒防抖是从 markdownUpdated 触发时开始算的，也就是按键后 200ms 起算。
    // 写入发生在按下后 700ms 以内，就只可能是 Ctrl+S 干的。
    const latency = first.t - pressedAt
    assert(
      latency < 700,
      `写入发生在按下后 ${latency}ms，太晚了，说明是防抖自己到期而不是 Ctrl+S`,
    )

    const status = await evaluate(`document.body.innerText.includes('已保存')`)
    assert(status, '界面上没有出现「已保存」')
    return `按下后 ${latency}ms 写入，内容是完整的标记`
  })

  await check('没有改动时按 Ctrl+S 也给反馈', async () => {
    await focusEditor()
    await press('s', { ctrl: true })
    await sleep(300)
    const status = await evaluate(`document.body.innerText.includes('已保存')`)
    assert(status, '没改动时按 Ctrl+S 界面上毫无反应')
    return '有「已保存」'
  })

  // ---------------------------------------------------------------- 画板
  section('5. 画板')
  await check('打开画板，默认工具是直线', async () => {
    await clickText('插入图形')
    await sleep(400)
    await clickText('新建图形')
    await sleep(700)
    const tool = await evaluate(ACTIVE_TOOL)
    assert(tool?.startsWith('直线'), `当前工具是 ${JSON.stringify(tool)}`)
    return tool
  })

  await check('★ Shift+字母不换工具（Shift 留给「约束角度」）', async () => {
    await press('r', { shift: true })
    const afterShift = await evaluate(ACTIVE_TOOL)
    assert(
      afterShift?.startsWith('直线'),
      `Shift+R 把工具换成了 ${JSON.stringify(afterShift)}`,
    )
    await press('r')
    const afterPlain = await evaluate(ACTIVE_TOOL)
    assert(
      afterPlain?.startsWith('矩形'),
      `R 没换成矩形，当前是 ${JSON.stringify(afterPlain)}`,
    )
    await press('v', { shift: true })
    assert(
      (await evaluate(ACTIVE_TOOL))?.startsWith('矩形'),
      'Shift+V 也换了工具',
    )
    await press('v')
    assert((await evaluate(ACTIVE_TOOL))?.startsWith('选择'), 'V 没换成选择')
    return 'Shift 被正确排除'
  })

  const rect = await evaluate(
    `(() => { const r = ${BOARD}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`,
  )
  const toScreen = (sx, sy) => {
    const scale = Math.min(rect.w / 1200, rect.h / 900)
    return {
      x: rect.x + (rect.w - 1200 * scale) / 2 + sx * scale,
      y: rect.y + (rect.h - 900 * scale) / 2 + sy * scale,
    }
  }

  await check('画一笔让画板变脏', async () => {
    await press('l')
    const a = toScreen(200, 700)
    const b = toScreen(700, 300)
    await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: a.x, y: a.y, button: 'none',
    })
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1,
    })
    for (let i = 1; i <= 8; i += 1) {
      await call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: a.x + ((b.x - a.x) * i) / 8,
        y: a.y + ((b.y - a.y) * i) / 8,
        button: 'left',
        buttons: 1,
      })
      await sleep(20)
    }
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1,
    })
    await sleep(200)
    const n = await evaluate(`${BOARD}.querySelectorAll('line').length`)
    assert(n === 1, `画布上有 ${n} 条线`)
    return '1 条线'
  })

  await check('★ 画板里嵌套的确认框能按 Esc 关掉，且不连带关掉画板', async () => {
    await press('Escape')
    const title = await evaluate(DIALOG_TITLE)
    assert(title === '放弃这次改动？', `弹出的是 ${JSON.stringify(title)}`)

    await press('Escape')
    await sleep(300)
    const r = await evaluate(`({
      dialogs: ${DIALOG_COUNT},
      board: Boolean(${BOARD}),
    })`)
    // 画板在自己的容器上无条件 stopPropagation，对话框的 Esc 是挂在
    // window 捕获阶段才收得到的——改成冒泡阶段这里就永远关不掉
    assert(r.dialogs === 0, '确认框按 Esc 关不掉')
    assert(r.board, 'Esc 把画板也一起关掉了')
    return '确认框关了，画板还在'
  })

  await check('★ 画板挡住了整个全局快捷键层', async () => {
    const pathBefore = await evaluate(PATH)
    await clearProbe()
    await press('k', { ctrl: true })
    await press('n', { alt: true })
    await press('s', { ctrl: true })
    await press('b', { ctrl: true })
    await sleep(250)

    const r = await evaluate(`({
      path: ${PATH},
      board: Boolean(${BOARD}),
      dialogs: ${DIALOG_COUNT},
      aside: ${ASIDE},
      probes: window.__probe.length,
    })`)
    assert(r.path === pathBefore, `Ctrl+K 把画板导航走了：${r.path}`)
    assert(r.board, '画板被关掉了')
    assert(r.dialogs === 0, 'Alt+N 在画板里弹出了对话框')
    assert(r.aside, 'Ctrl+B 在画板里折叠了侧栏')
    // stopPropagation 生效时探针一条都收不到——这条同时也证明了
    // 「画板挡住全局快捷键」是拦在 window 之前的，不是靠各个绑定自己判断
    assert(r.probes === 0, `探针收到了 ${r.probes} 条事件，说明没挡住`)
    return '1 条事件都没漏出去'
  })

  await check('放弃改动后画板正常关闭', async () => {
    await press('Escape')
    await sleep(200)
    await clickText('放弃')
    await sleep(500)
    const r = await evaluate(`({ board: Boolean(${BOARD}), dialogs: ${DIALOG_COUNT} })`)
    assert(!r.board, '画板没关掉')
    assert(r.dialogs === 0, '确认框还留着')
    return '已关闭'
  })

  // ---------------------------------------------------------------- 收尾
  section('6. 页面报错')
  if (pageErrors.length === 0) {
    console.log('  ✓ 全程没有页面报错')
  } else {
    failures += 1
    console.log(`  ✗ ${pageErrors.length} 条`)
    for (const e of pageErrors.slice(0, 6)) {
      console.log(`      ${String(e).slice(0, 250)}`)
    }
  }

  // 自检数据用完就删，免得在 dev 的库里越攒越多；
  // 顺带把侧栏恢复成展开——测试中途折叠过，别把开发环境留在折叠状态
  await evaluate(`(async () => {
    const repo = await import('/src/repository/index.ts')
    await repo.SubjectRepository.remove(${JSON.stringify(ids.sid)})
    await repo.SettingRepository.set(repo.SETTING_KEYS.sidebarCollapsed, false)
  })()`).catch(() => {})
} catch (e) {
  failures += 1
  console.log(`\n脚本中断：${e.message}`)
  for (const p of pageErrors.slice(0, 6)) {
    console.log(`  页面报错：${String(p).slice(0, 250)}`)
  }
} finally {
  console.log('\n' + '─'.repeat(60))
  console.log(failures === 0 ? '全部通过。' : `${failures} 项失败。`)
  await edge.close()
  // 杀掉整棵进程树，而且**等它真的退完**再走。
  // 原来是 spawn 完立刻 process.exit()，taskkill 有可能还没跑完父进程就没了，
  // 于是 dev 服务器留在端口上——下一次自检就会悄悄测那份旧代码
  //（见 assertPortFree 的注释，这个坑真踩过）。
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
