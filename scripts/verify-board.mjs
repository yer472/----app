/**
 * 画板的端到端验证。
 *
 * 跑在 **vite dev** 上，而不是构建产物上——因为测试要在页面里直接
 * import `/src/...` 的模块来建数据和检查落库结果，构建产物里没有这些路径。
 * 脚本会自己起一个 dev 服务器（端口 5199），跑完关掉。
 *
 * 覆盖的都是「看起来能跑但其实是坏的」那类故障：
 *
 *   1. 场景往返是否逐字节一致（`<metadata>` 里的 JSON 有没有被转义弄坏）
 *   2. 导出的 SVG 是否**真的能渲染**——畸形 SVG 只会渲染成空白，不抛异常，
 *      唯一能戳破它的是 naturalWidth === 0
 *   3. 正文里那行 Markdown 是否是 `![1.00](asset://… "说明")`。
 *      image-block 把 alt 当缩放比例、title 才是说明文字，
 *      写成 `![说明](url)` 会**静默丢字**
 *   4. 重新编辑同一张图之后，正文里那张 `<img>` 显示的是不是新内容
 *      （asset.ts 按 id 缓存 blob URL，不清的话永远是旧图）
 *   5. 备份 → 恢复一趟之后附件类型是否还在
 *      （archive.ts 曾经写死 type: 'image'）
 *   6. 孤儿清理会不会误删还被引用着的图
 *
 * 用法：npm run verify:board
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { launchEdge, sleep, waitFor } from './lib/cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5199
const BASE = `http://localhost:${PORT}`
/** 画布独有的定位标记。页面里有几十个 SVG（Crepe 自带一堆图标），
 *  用 querySelector('svg') 会选中一个 0×0 的图标，算出来的坐标全部落空。
 *
 *  这里原来靠 `pattern#xxbj-grid` 定位。那个 id 现在是每个画布实例独有的
 *  （页面里可以同时有两个画布：画板和符号编辑器，重名的 pattern 会让第二个
 *  画布解析到第一个的网格），所以换成组件上稳定存在的 data-board 属性。 */
const BOARD = `document.querySelector('[data-board="main"]')`

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
 * 起一个**属于本次运行**的 dev 服务器。
 *
 * ⚠️ 开头那次「端口已经有人应答」的检查不能省。
 *
 * `--strictPort` 确实会让新服务器在端口被占时退出，但下面的 `waitFor` 只等
 * 「这个端口有响应」——上一次自检没清干净的服务器会**替它应答**，于是整个
 * 脚本测试的是那个旧进程里的旧代码，而且全程不报错。这个坑真踩过：5198 上
 * 残留着一个上个会话早期起的服务器，于是「目录里的全局绑定与代码里注册的
 * 对不上」一直失败，而代码本身是好的。**假测试比没有测试更糟**，因为它
 * 会让人去改没坏的东西。
 */
async function assertPortFree() {
  try {
    const res = await fetch(BASE)
    if (res.ok) {
      throw new Error(
        `端口 ${PORT} 上已经有一个服务器在跑（多半是上次自检没清理干净）。\n` +
          `      它会替本次启动的服务器应答，导致测的是旧代码。先杀掉它：\n` +
          `      netstat -ano | findstr :${PORT}   然后 taskkill /PID <pid> /T /F`,
      )
    }
  } catch (e) {
    // 连不上才是我们想要的。上面那句 throw 不能被这个 catch 吞掉
    if (e instanceof Error && e.message.includes('已经有一个服务器')) throw e
  }
}

async function startDevServer() {
  await assertPortFree()
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(npm, ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    shell: true,
  })
  await waitFor(
    async () => {
      try {
        const res = await fetch(BASE)
        return res.ok
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
  pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text),
)
on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') pageErrors.push(p.args.map((a) => a.value ?? a.description).join(' '))
})

async function goto(url) {
  const loaded = edge.waitForLoad(20_000)
  await call('Page.navigate', { url })
  await loaded
  await sleep(500)
}

async function waitForEditor() {
  await waitFor(
    () =>
      evaluate(
        `!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '插入图形') || {}).disabled`,
      ),
    { timeout: 25_000, label: '编辑器就绪' },
  )
}

/** 把画布里那张图当前**真正显示**的内容抠出来 */
const READ_DISPLAYED_IMAGE = `(async () => {
  const img = document.querySelector('.note-editor img')
  if (!img) return { src: null, lines: -1 }
  const src = img.src
  try {
    const text = await (await fetch(src)).text()
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    return { src, lines: doc.querySelectorAll('line').length, parserError: Boolean(doc.querySelector('parsererror')) }
  } catch (e) {
    return { src, lines: -1, error: String(e) }
  }
})()`

try {
  await goto(BASE)

  // ---------------------------------------------------------------- 准备
  section('0. 准备一篇带图形的笔记')
  const ids = await evaluate(`(async () => {
    const repo = await import('/src/repository/index.ts')
    const ser = await import('/src/components/board/serialize.ts')
    const s = await repo.SubjectRepository.create({ name: '【画板自检】' })
    const c = await repo.ChapterRepository.create({ subjectId: s.id, name: '连杆机构' })
    const n = await repo.NoteRepository.create({ chapterId: c.id, title: '曲柄摇杆' })
    const scene = {
      width: 1200, height: 900,
      shapes: [
        { id: 'L1', kind: 'line', a: { x: 100, y: 700 }, b: { x: 400, y: 700 } },
        { id: 'L2', kind: 'line', a: { x: 400, y: 700 }, b: { x: 500, y: 400 } },
        { id: 'L3', kind: 'line', a: { x: 500, y: 400 }, b: { x: 100, y: 700 } },
        // 另外三种各来一个，让「画布 ↔ 导出」那条对拍覆盖到全部图形种类。
        // 它们不是 <line>，所以后面数 line 的断言不受影响。
        { id: 'R1', kind: 'rect', a: { x: 800, y: 600 }, b: { x: 1000, y: 750 } },
        { id: 'E1', kind: 'ellipse', a: { x: 850, y: 150 }, b: { x: 1010, y: 310 } },
        { id: 'P1', kind: 'pencil', points: [
          { x: 200, y: 120 }, { x: 260, y: 160 }, { x: 320, y: 100 }, { x: 380, y: 150 } ] },
      ],
    }
    const att = await repo.AttachmentRepository.createDrawing({
      noteId: n.id, blob: ser.sceneToSvgBlob(scene), width: 1200, height: 900,
    })
    await repo.NoteRepository.saveContent(n.id, '如下图。\\n\\n![1.00](asset://' + att.id + ' "曲柄摇杆机构")\\n')
    return { sid: s.id, cid: c.id, nid: n.id, aid: att.id }
  })()`)
  assert(ids?.aid, '没有建出测试数据')

  await check('场景往返一致（图元数量与坐标）', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const ser = await import('/src/components/board/serialize.ts')
      const att = await repo.AttachmentRepository.get(${JSON.stringify(ids.aid)})
      const scene = ser.parseSceneFromSvg(await att.blob.text())
      return {
        shapes: scene?.shapes.length,
        kinds: scene?.shapes.map((s) => s.kind),
        first: scene?.shapes[0]?.a,
        pencilPoints: scene?.shapes.find((s) => s.kind === 'pencil')?.points.length,
      }
    })()`)
    // 种子是 3 条线 + 矩形 + 椭圆 + 手绘，四种图形都要能原样回来
    assert(r?.shapes === 6, `图元数不对：${r?.shapes}`)
    assert(
      JSON.stringify(r?.kinds) ===
        JSON.stringify(['line', 'line', 'line', 'rect', 'ellipse', 'pencil']),
      `种类不对：${JSON.stringify(r?.kinds)}`,
    )
    assert(r?.first?.x === 100 && r?.first?.y === 700, `坐标不对：${JSON.stringify(r?.first)}`)
    assert(r?.pencilPoints === 4, `手绘的折点数不对：${r?.pencilPoints}`)
    return '6 个图元（四种图形齐全），坐标原样回来'
  })

  await check('SVG 良构、带 xmlns、且真的能渲染', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const att = await repo.AttachmentRepository.get(${JSON.stringify(ids.aid)})
      const text = await att.blob.text()
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      const url = URL.createObjectURL(att.blob)
      const size = await new Promise((res) => {
        const img = new Image()
        img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => res({ w: 0, h: 0 })
        img.src = url
      })
      return {
        parserError: Boolean(doc.querySelector('parsererror')),
        xmlnsCount: (text.match(/xmlns=/g) || []).length,
        hasMeta: Boolean(doc.querySelector('metadata')),
        size,
        mimeType: att.mimeType,
      }
    })()`)
    assert(!r.parserError, '有 parsererror')
    assert(r.xmlnsCount === 1, `xmlns 出现了 ${r.xmlnsCount} 次（0 次不渲染，2 次是畸形）`)
    assert(r.hasMeta, '没有 metadata，场景数据丢了')
    assert(r.mimeType === 'image/svg+xml', `mimeType 不对：${r.mimeType}`)
    // 这条才是决定性的：畸形 SVG 渲染成空白但**不抛异常**
    assert(r.size.w > 0, `渲染出来是空白（naturalWidth=${r.size.w}）`)
    return `naturalWidth=${r.size.w}，xmlns 恰好一次`
  })

  // ---------------------------------------------------------------- 打开画板
  section('1. 画板：画、撤销、重做')
  await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`)
  await waitForEditor()
  await sleep(700)

  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '插入图形').click()`,
  )
  await sleep(350)

  await check('图形面板列出了已有的图', async () => {
    assert(await evaluate(`document.body.innerText.includes('图形 1')`), '面板里没有列出图形')
  })

  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '编辑').click()`,
  )
  await waitFor(() => evaluate(`Boolean(${BOARD})`), {
    timeout: 15_000,
    label: '画板打开',
  })
  await sleep(600)

  await check('画板把已存的 3 条线读回来了', async () => {
    const n = await evaluate(`${BOARD}.querySelectorAll('line').length`)
    assert(n === 3, `实际 ${n} 条`)
  })

  /*
   * ★ 这一条是「几何只算一次」那个重构的验收点。
   *
   * 画布和导出原来是两套各算一遍几何的实现（ShapeView / createShapeElement），
   * 漏改一处是**静默**的：画布上少个图形只是看不见，导出里少个图形则是
   * 「正文里的图缺一块、metadata 里的数据却完好」。靠注释提醒「两处都要改」
   * 是拦不住的，所以改成对拍：同一份场景，两边渲染出来的元素必须逐属性相同。
   *
   * 只比几何，不比样式——描边色和线宽在两边是两套写法（React prop / setAttribute），
   * 本来就该各管各的。
   */
  await check('★ 画布渲染与导出渲染逐属性一致', async () => {
    const r = await evaluate(`(async () => {
      const ser = await import('/src/components/board/serialize.ts')
      const repo = await import('/src/repository/index.ts')
      const att = await repo.AttachmentRepository.get(${JSON.stringify(ids.aid)})
      const scene = ser.parseSceneFromSvg(await att.blob.text())
      if (!scene) return { error: '存出去的 SVG 读不回来' }

      const GEOM = ['x1','y1','x2','y2','x','y','width','height','cx','cy','rx','ry','points']
      const partsOf = (root) => [...(root.querySelector('g')?.children ?? [])].map((el) => {
        const o = { tag: el.tagName }
        for (const k of GEOM) if (el.hasAttribute(k)) o[k] = el.getAttribute(k)
        return o
      })
      return {
        canvas: partsOf(${BOARD}),
        exported: partsOf(ser.sceneToSvgElement(scene)),
      }
    })()`)
    assert(!r?.error, r?.error ?? '')
    assert(
      JSON.stringify(r.canvas) === JSON.stringify(r.exported),
      '画布和导出的元素对不上：\n' +
        `      画布 ${JSON.stringify(r.canvas)}\n` +
        `      导出 ${JSON.stringify(r.exported)}`,
    )
    return `${r.canvas.length} 个元素逐项一致`
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

  /** 用 CDP 发真实鼠标事件，走和用户一样的 pointerdown/move/up 路径 */
  /**
   * 按住修饰键拖一段。
   *
   * `modifiers` 是 CDP 的位掩码（alt 1 / ctrl 2 / meta 4 / shift 8）。
   * 画板的 Shift 角度约束读的是指针事件上的 `event.shiftKey`，所以只要把这个
   * 掩码带上就等价于真人按住 Shift——**不需要**真的发 keyDown，那是键盘通道的事。
   */
  async function stroke([sx1, sy1], [sx2, sy2], modifiers = 0) {
    const a = toScreen(sx1, sy1)
    const b = toScreen(sx2, sy2)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, button: 'none', modifiers })
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1, modifiers })
    for (let i = 1; i <= 8; i += 1) {
      await call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: a.x + ((b.x - a.x) * i) / 8,
        y: a.y + ((b.y - a.y) * i) / 8,
        button: 'left',
        buttons: 1,
        modifiers,
      })
      await sleep(20)
    }
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, modifiers })
    await sleep(120)
  }

  /** 在图纸坐标的某一点上点一下（不拖动） */
  async function clickAt(sx, sy) {
    const p = toScreen(sx, sy)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(150)
  }

  /** 画布上第 index 条线的坐标（从 0 数，按渲染顺序） */
  const readLine = (index) =>
    evaluate(`(() => {
      const lines = [...${BOARD}.querySelector('g').querySelectorAll('line')]
      const el = lines[${index}]
      return el ? { n: lines.length, x1: +el.getAttribute('x1'), y1: +el.getAttribute('y1'),
                    x2: +el.getAttribute('x2'), y2: +el.getAttribute('y2') } : { n: lines.length }
    })()`)

  const clickByTitle = (fragment) =>
    evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.title && b.title.includes(${JSON.stringify(fragment)}))
      if (!btn) throw new Error('找不到按钮：' + ${JSON.stringify(fragment)})
      btn.click()
    })()`)

  await stroke([100, 700], [700, 200])

  await check('画了一条线（真实鼠标事件）', async () => {
    const n = await evaluate(`${BOARD}.querySelectorAll('line').length`)
    assert(n === 4, `实际 ${n} 条`)
  })

  await clickByTitle('撤销')
  await check('撤销退回 3 条', async () => {
    await sleep(200)
    const n = await evaluate(`${BOARD}.querySelectorAll('line').length`)
    assert(n === 3, `实际 ${n} 条`)
  })

  await clickByTitle('重做')
  await check('重做回到 4 条', async () => {
    await sleep(200)
    const n = await evaluate(`${BOARD}.querySelectorAll('line').length`)
    assert(n === 4, `实际 ${n} 条`)
  })

  // ---------------------------------------------------------------- 吸附与约束
  section('1.5 端点吸附与角度约束')

  /*
   * 起点放在离已有铰链 (500,400) 约 6 个单位的地方（吸附容差是 12）。
   *
   * 不贴着容差边缘放：CDP 的鼠标坐标会按像素取整，scene 坐标跟着抖一点点，
   * 贴着边缘就会变成一条时灵时不灵的断言。
   *
   * 断言的是**严格相等**而不是「接近」。这一条比看上去重要：吸附落点精确重合
   * 是「拖动铰链联动构件」的地基——如果每次吸附都差几个单位，重合判定就会
   * 一路漂，最后表现为「拖着拖着杆就散了」，而且很难归因。
   */
  await stroke([505, 398], [900, 640])
  await check('★ 端点吸附：落点精确等于已有端点', async () => {
    const r = await readLine(4)
    assert(r.n === 5, `应该是 5 条线，实际 ${r.n}`)
    assert(
      r.x1 === 500 && r.y1 === 400,
      `起点没吸到 (500,400) 上，实际 (${r.x1},${r.y1})`,
    )
    return `5 条线，起点严格落在 (500,400)`
  })

  // 同一个拖动方向，按住 Shift 与不按，角度应当不同：
  // 不按是网格落点算出来的 331.9°，按住被吸到 15° 的整数倍 330°
  const angleOf = (l) => {
    const deg = (Math.atan2(l.y2 - l.y1, l.x2 - l.x1) * 180) / Math.PI
    return (deg + 360) % 360
  }

  await stroke([400, 800], [700, 640])
  const loose = angleOf(await readLine(5))

  /*
   * 把对照那一笔**先撤掉**，再从同一个起点画第二次。
   *
   * 不撤的话第二次会被端点吸附接走（起点正好压在上一条线的端点上），
   * 根本轮不到角度约束——这不是 bug，是设计好的优先级：**端点吸附 > 角度约束**，
   * 「把杆接在铰链上」比「这一笔正好 15°」要紧。第一次跑这个测试时就是被
   * 这一点绊倒的：两条线完全重合，角度一模一样，看起来像是 Shift 没生效。
   */
  await clickByTitle('撤销')
  await sleep(200)
  await stroke([400, 800], [700, 640], 8)

  await check('★ 按住 Shift 把方向约束到 15° 的整数倍', async () => {
    const r = await readLine(5)
    assert(r.n === 6, `应该是 6 条线，实际 ${r.n}`)

    // 对照组证明「角度是整数」不是碰巧——这个方向上随手画出来是 331.9°
    assert(
      Math.abs(loose - Math.round(loose / 15) * 15) > 0.5,
      `对照组本身就落在 15° 的整数倍上（${loose.toFixed(2)}°），这条断言证明不了任何事`,
    )

    const constrained = angleOf(r)
    assert(
      Math.abs(constrained - 330) < 0.1,
      `角度应该是 330°（-30° 的等价写法），实际 ${constrained.toFixed(3)}°`,
    )
    return `未约束 ${loose.toFixed(1)}° → 约束后 ${constrained.toFixed(2)}°`
  })

  // 把试画的两笔撤回去，让后面的保存断言面对的还是 4 条线的场景
  for (let i = 0; i < 2; i += 1) await clickByTitle('撤销')
  await check('试画的几笔都撤得回去', async () => {
    await sleep(200)
    const n = await evaluate(`${BOARD}.querySelectorAll('line').length`)
    assert(n === 4, `撤销 2 次后应该回到 4 条，实际 ${n} 条`)
    return '回到 4 条'
  })

  // ---------------------------------------------------------------- 橡皮
  section('1.6 橡皮')

  // 在图纸下方空着的区域画两条互不相干的线当靶子。
  // 坐标都取 20 的整数倍，免得网格吸附把它们挪到别处去
  await stroke([160, 860], [360, 860])
  await stroke([520, 860], [720, 860])
  const lineCount = () =>
    evaluate(`${BOARD}.querySelector('g').querySelectorAll('line').length`)
  await check('橡皮的靶子画好了', async () => {
    const n = await lineCount()
    assert(n === 6, `应该是 6 条线，实际 ${n}`)
  })

  await clickByTitle('橡皮')
  await check('工具栏切到了橡皮', async () => {
    const pressed = await evaluate(
      `(() => {
        const b = [...document.querySelectorAll('button')].find(b => b.title && b.title.includes('橡皮'))
        return b ? b.getAttribute('aria-pressed') : null
      })()`,
    )
    assert(pressed === 'true', `橡皮按钮的 aria-pressed 是 ${pressed}`)
  })

  await clickAt(260, 860)
  await check('★ 点一下擦掉一个图元（点是最常用的擦法）', async () => {
    await sleep(200)
    const n = await lineCount()
    assert(n === 5, `应该是 5 条，实际 ${n}`)
    return '6 → 5'
  })

  await clickAt(950, 860)
  await check('★ 没擦到东西时不留一步空历史', async () => {
    await sleep(200)
    assert((await lineCount()) === 5, '空白处点一下居然改变了图形数')

    // 这一条才是关键：撤销一次要回到**刚才那次真擦除之前**（6 条）。
    // 如果空白处那一下也提交了一步，撤销栈顶就是那一步空操作，
    // 撤销后仍然是 5 条——用户会觉得「撤销怎么没反应」。
    await clickByTitle('撤销')
    await sleep(250)
    const n = await lineCount()
    assert(n === 6, `撤销一次应该回到 6 条（证明空操作没进历史），实际 ${n} 条`)
    return '撤销一次回到 6 条，说明空操作没占历史'
  })

  // 留着刚才那 6 条会打乱后面的保存断言，撤回去。
  // 两次就够：上面那次撤销已经退掉了「擦掉 X」，再退掉 Y 和 X 这两笔就回到 4 条
  for (let i = 0; i < 2; i += 1) await clickByTitle('撤销')
  await check('橡皮的靶子清理干净', async () => {
    await sleep(250)
    const n = await lineCount()
    assert(n === 4, `应该回到 4 条，实际 ${n} 条`)
    return '回到 4 条'
  })

  // ---------------------------------------------------------------- 保存
  section('2. 保存：覆盖同一个附件，并刷新正文里的图')
  const before = await evaluate(READ_DISPLAYED_IMAGE)
  assert(before?.lines === 3, `保存前正文里的图应该是 3 条线，实际 ${before?.lines}`)

  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '完成').click()`,
  )
  await waitFor(() => evaluate(`!${BOARD}`), {
    timeout: 10_000,
    label: '画板关闭',
  })
  await sleep(700)

  await check('★ 正文里的图真的更新成了新内容', async () => {
    const after = await evaluate(READ_DISPLAYED_IMAGE)
    assert(after?.lines === 4, `实际还是 ${after?.lines} 条线——blob URL 缓存没失效`)
    assert(after?.src !== before?.src, 'blob 地址没换，说明清缓存那一步没生效')
    return `3 → 4 条线，blob 地址已更换`
  })

  await check('编辑没有产生第二张图，引用也保持稳定', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const note = await repo.NoteRepository.get(${JSON.stringify(ids.nid)})
      const atts = await repo.AttachmentRepository.listByNote(${JSON.stringify(ids.nid)})
      return {
        drawings: atts.filter(a => a.type === 'drawing').length,
        sameId: atts.some(a => a.id === ${JSON.stringify(ids.aid)}),
        referenced: note.content.includes('asset://' + ${JSON.stringify(ids.aid)}),
        markdown: note.content.trim(),
      }
    })()`)
    assert(r.drawings === 1, `变成了 ${r.drawings} 张图，说明是新建而不是覆盖`)
    assert(r.sameId, '附件 id 变了，正文引用会断')
    assert(r.referenced, '正文里的引用丢了')
    return '1 张图，id 未变'
  })

  await check('正文里那行 Markdown 的格式正确（alt 是比例、title 是说明）', async () => {
    const r = await evaluate(
      `(async () => (await (await import('/src/repository/index.ts')).NoteRepository.get(${JSON.stringify(ids.nid)})).content)()`,
    )
    assert(
      /!\[1\.00\]\(asset:\/\/[0-9a-f-]+ "曲柄摇杆机构"\)/.test(r),
      `格式不对，实际：${JSON.stringify(r.trim().slice(0, 120))}`,
    )
  })

  // ---------------------------------------------------------------- 备份
  section('3. 备份往返')
  await check('★ 恢复后附件类型仍是 drawing，SVG 字节一致', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const archive = await import('/src/lib/backup/archive.ts')
      const built = await archive.buildArchive(await repo.BackupRepository.snapshot())
      const parsed = await archive.parseArchive(built.blob)
      const att = parsed.attachments.find(a => a.id === ${JSON.stringify(ids.aid)})
      const original = await repo.AttachmentRepository.get(${JSON.stringify(ids.aid)})
      return {
        type: att?.type,
        mimeType: att?.mimeType,
        identical: att ? (await att.blob.text()) === (await original.blob.text()) : false,
        missing: parsed.missingImages.length,
        doc: built.noteDocuments[0]?.text ?? '',
      }
    })()`)
    // 这条抓的是 archive.ts 曾经写死 type: 'image' 的问题：
    // 不修的话这里会得到 'image'，而导出、导入、数据库里看全都正常
    assert(r.type === 'drawing', `恢复后变成了 ${r.type}——附件类型在备份往返中被降级了`)
    assert(r.mimeType === 'image/svg+xml', `mimeType 变成了 ${r.mimeType}`)
    assert(r.identical, 'SVG 字节不一致')
    assert(r.missing === 0, `备份包里缺 ${r.missing} 个图片文件`)
    return 'drawing · image/svg+xml · 字节一致'
  })

  await check('★ 导出的 .md 指向包内真实文件，不是死链', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const archive = await import('/src/lib/backup/archive.ts')
      const built = await archive.buildArchive(await repo.BackupRepository.snapshot())
      const parsed = await archive.parseArchive(built.blob)
      // 必须按 noteId 精确找到本次这篇——备份是整个库的，
      // 而 dev 那个 origin 的库里还留着之前几轮自检建的数据
      const doc = (built.noteDocuments.find(d => d.noteId === ${JSON.stringify(ids.nid)}) ?? {}).text ?? ''
      // 把相对路径解析回绝对路径，确认那个文件真在包里——这条是从
      // 「导出的 md 里图片是死链」那个历史 bug 学来的
      const m = doc.match(/!\\[1\\.00\\]\\((\\S+?) "/)
      const relative = m ? m[1] : null
      const normalized = relative ? relative.replace(/^(\\.\\.\\/)+/, '') : null
      return {
        relative,
        hasRawAsset: doc.includes('asset://'),
        missing: parsed.missingImages,
        inAttachments: normalized ? parsed.attachments.some(a => ('images/' + a.id + '.svg') === normalized) : false,
      }
    })()`)
    assert(r.relative, '正文里没找到图片引用')
    assert(!r.hasRawAsset, '还残留 asset:// ——脱离 App 打开就是死链')
    assert(
      r.inAttachments && !r.missing.includes(r.relative?.replace(/^(\.\.\/)+/, '')),
      `引用的 ${r.relative} 不在备份包里（缺图列表：${JSON.stringify(r.missing)}）`,
    )
    return r.relative
  })

  // ---------------------------------------------------------------- 孤儿清理
  section('4. 孤儿清理')
  await check('★ 正文还引用着的时候不删，引用没了才删', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const note = await repo.NoteRepository.get(${JSON.stringify(ids.nid)})
      const kept = await repo.AttachmentRepository.removeOrphansOfNote(${JSON.stringify(ids.nid)}, note.content)
      const stillThere = Boolean(await repo.AttachmentRepository.get(${JSON.stringify(ids.aid)}))
      const removed = await repo.AttachmentRepository.removeOrphansOfNote(${JSON.stringify(ids.nid)}, '正文里把图删了')
      const gone = !(await repo.AttachmentRepository.get(${JSON.stringify(ids.aid)}))
      return { kept, stillThere, removed, gone }
    })()`)
    assert(r.kept === 0 && r.stillThere, '正文还引用着，图却被删了')
    assert(r.gone, '引用没了，图却没被清掉')
    return '引用时保留 0 误删，失引用后清掉 1 个'
  })

  // ---------------------------------------------------------------- 收尾
  section('5. 页面报错')
  if (pageErrors.length === 0) {
    console.log('  ✓ 全程没有页面报错')
  } else {
    failures += 1
    console.log(`  ✗ ${pageErrors.length} 条`)
    for (const e of pageErrors.slice(0, 6)) console.log(`      ${String(e).slice(0, 250)}`)
  }

  // 自检数据用完就删，免得在 dev 的库里越攒越多
  await evaluate(
    `(async () => { (await import('/src/repository/index.ts')).SubjectRepository.remove(${JSON.stringify(ids.sid)}) })()`,
  ).catch(() => {})
} catch (e) {
  failures += 1
  console.log(`\n脚本中断：${e.message}`)
  for (const p of pageErrors.slice(0, 6)) console.log(`  页面报错：${String(p).slice(0, 250)}`)
} finally {
  console.log('\n' + '─'.repeat(60))
  console.log(failures === 0 ? '全部通过。' : `${failures} 项失败。`)
  await edge.close()
  // 杀掉整棵进程树，而且**等它真的退完**再走。
  // 原来是 spawn 完立刻 process.exit()，taskkill 有可能还没跑完父进程就没了，
  // 于是 dev 服务器留在端口上——下一次自检就会悄悄测那份旧代码
  //（见 assertPortFree 的注释，这个坑真踩过：5198 上残留的服务器让一条
  // 一直失败的断言看起来像是代码坏了）。
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
