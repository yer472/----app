/**
 * 模块图的端到端验证。
 *
 * 和别的 verify 脚本一样跑在 **vite dev** 上（测试要在页面里直接
 * `import('/src/...')` 建数据、调纯函数、查落库结果，构建产物里没有这些路径），
 * 自己起一个 dev 服务器（端口 5202），跑完关掉。
 *
 * 覆盖的都是「看起来能跑但其实是坏的」那类故障：
 *   1. 流向的折线几何（端口要夹到对方跨度内 —— 通栏长条的箭头必须落在目标
 *      方框的中心正下方，不是长条自己的中心）
 *   2. 对齐辅助线不会把「正在拖的那个」算成候选（算进去就会吸到自己身上、动不了）
 *   3. 删模块**级联**删掉指向它的流向，撤销一次两者一起回来
 *   4. 场景往返：模块和流向存进 `<metadata>` 再读回来逐字段一致，
 *      而且**只用直线矩形的老图仍然写 version 1**（回滚后还能打开）
 *   5. 导出的 SVG 真的能渲染（箭头那个实心三角的填充不能把它弄成空白）
 *   6. 跨渲染器对拍：画布和导出逐属性一致，**含填充色、字体、文字**——
 *      只比几何的对拍对这次的改动恰好是瞎的
 *   7. 文字编辑：双击进编辑、打字、Enter 落库、撤销能回去
 *
 * 用纯函数验几何而不是用真鼠标：和 `verify-symbols.mjs` 里那条已记录的理由一样
 * ——真鼠标只会引入屏幕坐标换算的噪声，反而更容易得到假结论。
 *
 * 用法：npm run verify:blockdiagram
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { launchEdge, sleep, waitFor } from './lib/cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5202
const BASE = `http://localhost:${PORT}`
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
 * ⚠️ 开头那次「端口已经有人应答」的检查不能省：`--strictPort` 会让新服务器
 * 在端口被占时退出，而下面的 `waitFor` 只等「这个端口有响应」——上一次自检
 * 没清干净的服务器会**替它应答**，于是整个脚本测的是那份旧代码，全程不报错。
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
    if (e instanceof Error && e.message.includes('已经有一个服务器')) throw e
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

/**
 * 教材上那张系统框图：三个方框横排，底下一根通栏长条，三条箭头从长条往上
 * 指进方框。**这张图就是 M8 存在的理由**——Mermaid 画不出它（它自己的记录里
 * 写着「三条分别指向三个框的箭头做不到、长条通栏做不到」）。
 *
 * 坐标是刻意排的：长条比三个方框加起来还宽，所以「夹到对方跨度内」这条规则
 * 一旦写错（比如出口取了长条自己的中心），三条箭头会全部挤在中间那个方框下面。
 */
const REFERENCE_SCENE = `{
  width: 1200, height: 900,
  shapes: [
    { id: 'BAR', kind: 'node', a: { x: 120, y: 600 }, b: { x: 1080, y: 680 },
      text: '辅助元件与工作介质', fill: '#10b981' },
    { id: 'A', kind: 'node', a: { x: 240, y: 300 }, b: { x: 400, y: 360 },
      text: '动力元件', fill: '#ef4444' },
    { id: 'B', kind: 'node', a: { x: 520, y: 300 }, b: { x: 680, y: 360 },
      text: '控制元件', fill: '#ffe600' },
    { id: 'C', kind: 'node', a: { x: 800, y: 300 }, b: { x: 960, y: 360 },
      text: '执行元件', fill: '#f59e0b' },
    { id: 'FA', kind: 'flow', from: 'BAR', to: 'A', stroke: '#1f2937' },
    { id: 'FB', kind: 'flow', from: 'BAR', to: 'B', stroke: '#1f2937' },
    { id: 'FC', kind: 'flow', from: 'BAR', to: 'C', stroke: '#1f2937' },
    { id: 'FAB', kind: 'flow', from: 'A', to: 'B', stroke: '#1f2937' },
    { id: 'FBC', kind: 'flow', from: 'B', to: 'C', stroke: '#1f2937' },
  ],
}`

try {
  await goto(BASE)

  // ---------------------------------------------------------------- 纯函数几何
  section('0. 流向的几何（纯函数）')

  await check('★ 通栏长条 → 方框：箭头落在方框中心正下方', async () => {
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const scene = ${REFERENCE_SCENE}
      const ctx = sc.contextOf(scene)
      const bar = { x: 120, y: 600, w: 960, h: 80 }
      const out = {}
      for (const [flowId, nodeId] of [['FA','A'],['FB','B'],['FC','C']]) {
        const flow = scene.shapes.find((s) => s.id === flowId)
        const node = scene.shapes.find((s) => s.id === nodeId)
        const points = sc.routeFlow(flow, ctx)
        const r = sc.nodeRect(node)
        out[flowId] = {
          count: points.length,
          startX: points[0].x, startY: points[0].y,
          endX: points[points.length - 1].x, endY: points[points.length - 1].y,
          centreX: r.x + r.w / 2,
          topY: r.y, bottomY: r.y + r.h,
        }
      }
      return { out, barTop: bar.y }
    })()`)

    for (const id of ['FA', 'FB', 'FC']) {
      const f = r.out[id]
      assert(f.count === 2, `${id} 应该是直线段（对齐），实际 ${f.count} 个点`)
      assert(
        Math.abs(f.startX - f.centreX) < 0.01,
        `${id} 的出口没落在目标方框中心正下方：x=${f.startX}，应当 ${f.centreX}。` +
          `出口取的是长条自己的中心吧？（夹到对方跨度内这条规则）`,
      )
      assert(
        Math.abs(f.endX - f.centreX) < 0.01,
        `${id} 的入口没落在方框中心：x=${f.endX}`,
      )
      // 从长条的上边缘 (600) 指到方框的**下边缘** (360)，不是上边缘
      assert(
        Math.abs(f.startY - r.barTop) < 0.01 &&
          Math.abs(f.endY - f.bottomY) < 0.01,
        `${id} 的纵向起止不对：${f.startY} → ${f.endY}（方框下边缘是 ${f.bottomY}）`,
      )
    }
    // 三条出口的 x 必须互不相同，否则就是全挤在长条中心了
    const xs = ['FA', 'FB', 'FC'].map((id) => r.out[id].startX)
    assert(new Set(xs).size === 3, `三条箭头挤在同一处：${xs.join(', ')}`)
    return `三条箭头分别落在 ${xs.join(' / ')}`
  })

  await check('★ 同一水平线上的两个方框：出直线段而不是 Z 形', async () => {
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const scene = ${REFERENCE_SCENE}
      const flow = scene.shapes.find((s) => s.id === 'FAB')
      return sc.routeFlow(flow, sc.contextOf(scene))
    })()`)
    assert(r.length === 2, `应当是 2 个点的直线段，实际 ${r.length} 个点`)
    assert(r[0].y === r[1].y, `两端 y 不同：${r[0].y} / ${r[1].y}`)
    return `${r[0].x},${r[0].y} → ${r[1].x},${r[1].y}`
  })

  await check('端点丢了的流向返回 null（不该抛错）', async () => {
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const scene = ${REFERENCE_SCENE}
      scene.shapes.push({ id: 'FX', kind: 'flow', from: 'BAR', to: 'NOPE', stroke: '#000000' })
      const flow = scene.shapes.find((s) => s.id === 'FX')
      return sc.routeFlow(flow, sc.contextOf(scene))
    })()`)
    assert(r === null, `应当返回 null，实际 ${JSON.stringify(r)}`)
  })

  await check('★ 对齐候选不含正在拖的那个（含了就会吸到自己身上、动不了）', async () => {
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const scene = ${REFERENCE_SCENE}
      const all = sc.collectAlignCandidates(scene, '')
      const withoutA = sc.collectAlignCandidates(scene, 'A')
      const rA = sc.nodeRect(scene.shapes.find((s) => s.id === 'A'))
      return {
        dropped: all.length - withoutA.length,
        stillHasA: withoutA.some((c) => Math.abs(c.at - rA.x) < 0.01 && c.axis === 'x'),
      }
    })()`)
    assert(r.dropped === 6, `排除一个方框应当少 6 条候选，实际少 ${r.dropped} 条`)
    assert(!r.stillHasA, '被排除的方框仍然在候选里')
    return '排除一个方框正好少 6 条'
  })

  await check('★ 吸附没有迟滞：同一个指针位置，从哪个方向拖过来结果都一样', async () => {
    // 模拟调用方的循环：每一帧都从「按下时的基准」重算，不在上一帧结果上累加。
    // 累加的话「拖过辅助线再拖回来」会停在别处 —— 那是这类交互最典型的坏法。
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const scene = ${REFERENCE_SCENE}
      const candidates = sc.collectAlignCandidates(scene, 'X')
      const origin = { x: 300, y: 500, w: 160, h: 56 }
      const start = { x: 100, y: 100 }
      const frame = (rawX, rawY) => {
        const box = {
          x: origin.x + (rawX - start.x), y: origin.y + (rawY - start.y),
          w: origin.w, h: origin.h,
        }
        const s = sc.alignSnap(box, candidates)
        return { x: box.x + s.dx, y: box.y + s.dy }
      }
      const walk = (xs) => xs.map((x) => frame(x, 100)).pop()
      return {
        fromRight: walk([300, 280, 260, 250]),
        fromLeft: walk([200, 230, 250]),
        single: frame(250, 100),
      }
    })()`)
    assert(
      JSON.stringify(r.fromRight) === JSON.stringify(r.fromLeft) &&
        JSON.stringify(r.fromRight) === JSON.stringify(r.single),
      `迟滞：从右 ${JSON.stringify(r.fromRight)}，从左 ${JSON.stringify(r.fromLeft)}，单次 ${JSON.stringify(r.single)}`,
    )
    return '三个方向落点相同'
  })

  await check('拖角改尺寸时对角不动', async () => {
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const node = { id: 'N', kind: 'node', a: { x: 100, y: 100 }, b: { x: 300, y: 200 },
        text: 't', fill: '#ffffff' }
      // corner 0 = 左上，对角是右下 (300,200)
      const next = sc.withResizedCorner(node, 0, { x: 50, y: 60 })
      const rect = sc.nodeRect(next)
      return rect
    })()`)
    assert(
      r.x === 50 && r.y === 60 && r.w === 250 && r.h === 140,
      `尺寸不对：${JSON.stringify(r)}`,
    )
    return '左上拖到 (50,60)，右下仍为 (300,200)'
  })

  await check('★ 删模块级联删掉它的流向，且「标红集合」也算上它们', async () => {
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const scene = ${REFERENCE_SCENE}
      const after = sc.removeShapes(scene, ['A'])
      const cascade = sc.cascadeOf(scene, ['A'])
      return {
        ids: after.shapes.map((s) => s.id).sort(),
        cascade: cascade.sort(),
      }
    })()`)
    // A 没了，FA（长条→A）和 FAB（A→B）跟着没。
    // 剩下的按字典序是 B, BAR, C, FB, FBC, FC（'FB' 是 'FBC' 的前缀）
    assert(
      r.ids.join(',') === 'B,BAR,C,FB,FBC,FC',
      `删 A 之后剩下的不对：${r.ids.join(',')}`,
    )
    assert(
      r.cascade.join(',') === 'FA,FAB',
      `标红集合不对：${r.cascade.join(',')}`,
    )
    return '去掉 1 个模块 + 2 条流向'
  })

  // ---------------------------------------------------------------- 场景往返
  section('1. 场景往返与格式版本')

  await check('★ 模块和流向存进 metadata 再读回来逐字段一致', async () => {
    const r = await evaluate(`(async () => {
      const ser = await import('/src/components/board/serialize.ts')
      const scene = ${REFERENCE_SCENE}
      const text = ser.sceneToSvgText(scene)
      const back = ser.parseSceneFromSvg(text)
      if (!back) return { error: '读不回来' }
      const nodes = back.shapes.filter((s) => s.kind === 'node')
      const flows = back.shapes.filter((s) => s.kind === 'flow')
      return {
        same: JSON.stringify(back.shapes) === JSON.stringify(scene.shapes),
        nodes: nodes.length,
        flows: flows.length,
        firstText: nodes[0].text,
        firstFill: nodes[0].fill,
      }
    })()`)
    assert(!r.error, r.error ?? '')
    assert(r.same, '往返之后图形不一致')
    assert(r.nodes === 4 && r.flows === 5, `图形数不对：${r.nodes} 模块 / ${r.flows} 流向`)
    assert(r.firstText === '辅助元件与工作介质', `文字丢了：${r.firstText}`)
    return `${r.nodes} 个模块、${r.flows} 条流向逐字段一致`
  })

  await check('★ 用了模块的图写 version 3，只用直线矩形的老图仍然写 version 1', async () => {
    const r = await evaluate(`(async () => {
      const ser = await import('/src/components/board/serialize.ts')
      const withModules = ser.sceneToSvgElement(${REFERENCE_SCENE})
      const plain = ser.sceneToSvgElement({ width: 1200, height: 900, shapes: [
        { id: 'L', kind: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 10 } },
        { id: 'R', kind: 'rect', a: { x: 20, y: 20 }, b: { x: 60, y: 60 } },
      ] })
      const version = (el) => JSON.parse(el.querySelector('metadata').textContent).version
      return { modules: version(withModules), plain: version(plain) }
    })()`)
    assert(r.modules === 3, `用了模块应当写 3，实际 ${r.modules}`)
    assert(r.plain === 1, `只用直线矩形应当仍写 1，实际 ${r.plain}`)
    return '模块图 3 / 老图 1'
  })

  await check('★ 导出的 SVG 真的能渲染（箭头那个实心三角不能把它弄成空白）', async () => {
    const r = await evaluate(`(async () => {
      const ser = await import('/src/components/board/serialize.ts')
      const text = ser.sceneToSvgText(${REFERENCE_SCENE})
      const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
      const img = new Image()
      const done = new Promise((resolve) => {
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => resolve({ w: 0, h: 0 })
      })
      img.src = url
      const size = await done
      URL.revokeObjectURL(url)
      return size
    })()`)
    assert(r.w > 0, `导出的 SVG 渲染成了 ${r.w}×${r.h}（空白）`)
    return `${r.w}×${r.h}`
  })

  // ---------------------------------------------------------------- 装数据、开画板
  section('2. 打开一张模块图')

  const ids = await evaluate(`(async () => {
    const repo = await import('/src/repository/index.ts')
    const ser = await import('/src/components/board/serialize.ts')
    const s = await repo.SubjectRepository.create({ name: '【模块图自检】' })
    const c = await repo.ChapterRepository.create({ subjectId: s.id, name: '系统框图' })
    const n = await repo.NoteRepository.create({ chapterId: c.id, title: '液压系统组成' })
    const scene = ${REFERENCE_SCENE}
    const att = await repo.AttachmentRepository.createDrawing({
      noteId: n.id, blob: ser.sceneToSvgBlob(scene), width: 1200, height: 900,
    })
    await repo.NoteRepository.saveContent(n.id,
      '如下图。\\n\\n![1.00](asset://' + att.id + ' "系统组成框图")\\n')
    return { sid: s.id, cid: c.id, nid: n.id, aid: att.id }
  })()`)
  assert(ids?.aid, '没有建出测试数据')

  await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`)
  await waitForEditor()
  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '插入图形').click()`,
  )
  await sleep(350)
  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '编辑').click()`,
  )
  await waitFor(() => evaluate(`Boolean(${BOARD})`), {
    timeout: 15_000,
    label: '画板打开',
  })
  await sleep(300)

  await check('画板打开了，模块和流向都画出来了', async () => {
    const r = await evaluate(`(() => {
      const g = ${BOARD}.querySelector('g')
      return {
        rects: g.querySelectorAll('rect').length,
        texts: g.querySelectorAll('text').length,
        polylines: g.querySelectorAll('polyline').length,
        polygons: g.querySelectorAll('polygon').length,
      }
    })()`)
    assert(r.rects === 4, `模块底框应当 4 个，实际 ${r.rects}`)
    assert(r.texts === 4, `标签应当 4 个，实际 ${r.texts}`)
    assert(r.polylines === 5, `折线应当 5 条，实际 ${r.polylines}`)
    assert(r.polygons === 5, `箭头应当 5 个，实际 ${r.polygons}`)
    return `${r.rects} 框 / ${r.texts} 文字 / ${r.polylines} 折线 / ${r.polygons} 箭头`
  })

  await check('★ 画布渲染与导出渲染逐属性一致（含填充色、字体、文字）', async () => {
    const r = await evaluate(`(async () => {
      const ser = await import('/src/components/board/serialize.ts')
      const repo = await import('/src/repository/index.ts')
      const att = await repo.AttachmentRepository.get(${JSON.stringify(ids.aid)})
      const scene = ser.parseSceneFromSvg(await att.blob.text())
      if (!scene) return { error: '存出去的 SVG 读不回来' }

      const ATTRS = [
        'x1','y1','x2','y2','x','y','width','height','cx','cy','rx','ry','points',
        'fill','stroke','stroke-width','font-size','font-family','text-anchor',
      ]
      const partsOf = (root) => [...(root.querySelector('g')?.children ?? [])].map((el) => {
        const o = { tag: el.tagName }
        for (const k of ATTRS) if (el.hasAttribute(k)) o[k] = el.getAttribute(k)
        if (el.textContent) o.text = el.textContent
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
    // 顺带确认对拍真的看见了填充色和文字——不然「一致」可能只是两边都空。
    // 13 = 4 个模块底框 + 5 个箭头三角 + 4 段文字（文字自己的 fill 是标签墨色）
    const filled = r.canvas.filter((el) => el.fill && el.fill !== 'none')
    const labelled = r.canvas.filter((el) => el.text)
    assert(filled.length === 13, `对拍里应当有 13 个带填充的元素，实际 ${filled.length}`)
    assert(labelled.length === 4, `对拍里应当有 4 段文字，实际 ${labelled.length}`)
    return `${r.canvas.length} 个元素逐项一致（含 ${filled.length} 个填充、${labelled.length} 段文字）`
  })

  await check('导出的 SVG 在正文里能渲染出来', async () => {
    const r = await evaluate(`(async () => {
      const img = document.querySelector('.note-editor img')
      if (!img) return { w: 0 }
      const text = await (await fetch(img.src)).text()
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      return {
        w: img.naturalWidth,
        polygons: doc.querySelectorAll('polygon').length,
        texts: [...doc.querySelectorAll('text')].map((t) => t.textContent),
      }
    })()`)
    assert(r.w > 0, '正文里的图渲染成了空白')
    assert(r.polygons === 5, `正文里的图少了箭头：${r.polygons} 个`)
    assert(r.texts.includes('动力元件'), `正文里的图少了标签：${r.texts.join('/')}`)
    return `${r.w}px 宽，5 个箭头，标签在`
  })

  // ---------------------------------------------------------------- 界面
  section('3. 界面：建模块、建流向、改文字')

  /**
   * 图纸坐标 → 屏幕坐标。
   *
   * ⚠️ **每次都重新量一次画布的位置，不能用打开画板时量下来的那次。**
   * 页头的工具栏是 `flex-wrap` 的，而模式切换会改变按钮的个数和宽度
   * （自由图形 6 个工具、模块图 4 个 + 一整排色块）——页头一旦换行，画布的
   * 位置就整体下移，缓存下来的变换会把每一次点击都送到别的地方去。
   * 这个坑真踩过：脚本报的是「拖了模块但箭头没动」，看上去像产品坏了。
   */
  async function toScreen(sx, sy) {
    const rect = await evaluate(
      `(() => { const r = ${BOARD}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`,
    )
    const scale = Math.min(rect.w / 1200, rect.h / 900)
    return {
      x: rect.x + (rect.w - 1200 * scale) / 2 + sx * scale,
      y: rect.y + (rect.h - 900 * scale) / 2 + sy * scale,
    }
  }

  async function clickAt(sx, sy) {
    const p = await toScreen(sx, sy)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(150)
  }

  async function doubleClickAt(sx, sy) {
    const p = await toScreen(sx, sy)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
    for (const clickCount of [1, 2]) {
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount })
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount })
    }
    await sleep(250)
  }

  async function dragFromTo([sx1, sy1], [sx2, sy2]) {
    const a = await toScreen(sx1, sy1)
    const b = await toScreen(sx2, sy2)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, button: 'none' })
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
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
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
    await sleep(200)
  }

  /**
   * 读**画布上当前**的场景。
   *
   * ⚠️ 不能用「从附件里读回来」代替：画板是点「完成」才落库的，编辑过程中
   * 数据库里一直是旧的那一份。第一版自检就是在这里读数据库，于是「新建的模块」
   * 永远查不到——**看起来像产品坏了，其实是断言看错了地方**。
   * 落库那一段留到最后统一点一次「完成」再验（见本节末尾）。
   */
  const readCanvas = () =>
    evaluate(`(() => {
      const g = ${BOARD}.querySelector('g')
      return {
        rects: g.querySelectorAll('rect').length,
        texts: [...g.querySelectorAll('text')].map((t) => t.textContent),
        polylines: g.querySelectorAll('polyline').length,
        polygons: g.querySelectorAll('polygon').length,
        firstPolyline: (g.querySelector('polyline') || {}).getAttribute
          ? g.querySelector('polyline').getAttribute('points') : null,
      }
    })()`)

  const clickButton = (text) =>
    evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})
      if (!btn) throw new Error('找不到按钮：' + ${JSON.stringify(text)})
      btn.click()
    })()`)

  const clickByTitle = (fragment) =>
    evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.title && b.title.includes(${JSON.stringify(fragment)}))
      if (!btn) throw new Error('找不到按钮：' + ${JSON.stringify(fragment)})
      btn.click()
    })()`)

  /** 从附件里把场景读回来。只有点过「完成」之后才反映编辑结果 */
  const readSavedScene = () =>
    evaluate(`(async () => {
      const ser = await import('/src/components/board/serialize.ts')
      const repo = await import('/src/repository/index.ts')
      const att = await repo.AttachmentRepository.get(${JSON.stringify(ids.aid)})
      const scene = ser.parseSceneFromSvg(await att.blob.text())
      return scene ? scene.shapes : null
    })()`)

  const pressKey = async (key, code, vk) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
    await sleep(250)
  }

  await check('★ 按工具快捷键时模式跟着切（不切的话工具栏上没有一个是按下的）', async () => {
    const before = await evaluate(
      `[...document.querySelectorAll('[data-board-modes] button')].find(b => b.getAttribute('aria-pressed') === 'true').textContent.trim()`,
    )
    assert(before === '自由图形', `画板打开时应当是自由图形模式，实际 ${before}`)

    await pressKey('f', 'KeyF', 70)
    const r = await evaluate(`(() => {
      const mode = [...document.querySelectorAll('[data-board-modes] button')]
        .find(b => b.getAttribute('aria-pressed') === 'true').textContent.trim()
      const armed = [...document.querySelectorAll('button')]
        .filter(b => b.getAttribute('aria-pressed') === 'true' && b.title).map(b => b.title)
      return { mode, armed }
    })()`)
    assert(r.mode === '模块图', `按 F 之后模式应当跟到模块图，实际 ${r.mode}`)
    assert(
      r.armed.some((t) => t.includes('流向')),
      `流向工具没有被按下：${r.armed.join(' / ') || '（一个都没有）'}`,
    )
    return `${before} → ${r.mode}，流向已上膛`
  })

  await check('切到模块图模式，工具栏换成模块 / 流向', async () => {
    await clickButton('模块图')
    await sleep(150)
    const labels = await evaluate(
      `[...document.querySelectorAll('[data-board-modes] ~ button')].map(b => b.textContent.trim()).filter(t => t)`,
    )
    // 只看工具栏里出现的那几个（相邻兄弟选择器取的是模式按钮之后的按钮）
    const text = labels.join(',')
    assert(text.includes('模块') && text.includes('流向'), `工具栏里没有模块/流向：${text}`)
    assert(!text.includes('矩形'), `模块图模式下不该出现矩形：${text}`)
    return text
  })

  await check('★ 点一下放下一个模块，并直接进入文字编辑', async () => {
    await clickByTitle('模块')
    await clickAt(150, 150)
    const hasEditor = await evaluate(`Boolean(document.querySelector('[data-board-label-editor] input'))`)
    assert(hasEditor, '放下模块之后没有出现文字输入框')
    const canvas = await readCanvas()
    assert(canvas.rects === 5, `画布上应当有 5 个方框，实际 ${canvas.rects}`)
    /*
     * 编辑期间画布上**不该**再有这个模块的标签。
     *
     * 输入框是浮在画布上的一层，画布如果照旧画着场景里那句旧文字，两份就叠在
     * 一起了——清空输入框时旧字还在，看着像没删掉。这条断言就是钉住那个现象：
     * 旧标签必须真的从画布里消失，而不是靠输入框盖住。下面「打字 + Enter」
     * 那一条再验它**回来**（提交之后画布上重新画出「油箱」）。
     */
    assert(
      !canvas.texts.includes('新模块'),
      `编辑期间画布上又画了一遍旧标签，会和输入框叠在一起：${canvas.texts.join('/')}`,
    )
    return '模块已落地，输入框已打开，旧标签已让位'
  })

  await check('★ 打字 + Enter：文字进场景，而且是**一步**历史', async () => {
    await call('Input.insertText', { text: '油箱' })
    await pressKey('Enter', 'Enter', 13)

    assert(
      await evaluate(`!document.querySelector('[data-board-label-editor] input')`),
      'Enter 之后输入框没关掉',
    )
    assert((await readCanvas()).texts.includes('油箱'), '画布上没有「油箱」')

    // 撤销一次应当把**整个**文字改动退掉，而不是退一个字
    await clickByTitle('撤销')
    assert(
      (await readCanvas()).texts.includes('新模块'),
      '撤销一次没把文字整体退回（说明每个字都提交了一次）',
    )
    await clickByTitle('重做')
    assert((await readCanvas()).texts.includes('油箱'), '重做没回到「油箱」')
    return '一步进、一步出'
  })

  await check('★ 拖模块时箭头跟着走（几何是推导的，不是存下来的）', async () => {
    await clickByTitle('选择')
    const before = (await readCanvas()).firstPolyline
    // 拖「动力元件」（240..400 × 300..360）往右挪 100
    await dragFromTo([320, 330], [420, 330])
    const after = (await readCanvas()).firstPolyline
    assert(before !== after, `拖了模块，箭头没跟着变（还是 ${before}）`)
    return `${before} → ${after}`
  })

  await check('★ 从模块拖到模块建立一条流向', async () => {
    const before = (await readCanvas()).polylines
    await clickByTitle('流向')
    // 从「油箱」（150..310 × 150..206）拖到「动力元件」（右移后中心 420,330）
    await dragFromTo([230, 178], [420, 330])
    const after = (await readCanvas()).polylines
    assert(after === before + 1, `流向应当从 ${before} 变成 ${before + 1}，实际 ${after}`)
    assert((await readCanvas()).polygons === after, '箭头的个数和折线对不上')
    return `${before} → ${after}`
  })

  await check('★ 松在空处不产生流向', async () => {
    const before = (await readCanvas()).polylines
    await dragFromTo([420, 330], [1100, 850])
    const after = (await readCanvas()).polylines
    assert(after === before, `空处松手不该产生流向：${before} → ${after}`)
    return '没有多出来'
  })

  await check('★ 双击模块进编辑，Esc 取消不改内容、也不关画板', async () => {
    await clickByTitle('选择')
    await doubleClickAt(420, 330)
    assert(
      await evaluate(`Boolean(document.querySelector('[data-board-label-editor] input'))`),
      '双击之后没有进入文字编辑',
    )
    // 双击进来的编辑同样要让画布上那份旧标签让位。和「新建模块」那条路径
    // 不是同一段代码（这条走双击 → hitTest → beginEdit），所以两边都钉一遍
    const during = await readCanvas()
    assert(
      !during.texts.includes('动力元件'),
      `编辑期间画布上还画着旧标签：${during.texts.join('/')}`,
    )
    await call('Input.insertText', { text: '改坏' })
    await pressKey('Escape', 'Escape', 27)

    assert(
      (await readCanvas()).texts.includes('动力元件'),
      `Esc 之后内容被改了：${(await readCanvas()).texts.join('/')}`,
    )
    // Esc 只该取消编辑，不该把画板也关掉（DrawBoard 的 Escape 级联排在
    //「焦点在输入框里」那个判断之前，输入框不自己吞掉的话就会连锁）
    assert(await evaluate(`Boolean(${BOARD})`), 'Esc 把画板一起关掉了')
    return '内容没变，画板还开着'
  })

  await check('★ 删模块：画布上跟着少掉指向它的流向，撤销一次一起回来', async () => {
    await clickAt(230, 178)
    const before = await readCanvas()
    await pressKey('Delete', 'Delete', 46)
    const after = await readCanvas()
    assert(after.rects === before.rects - 1, `方框应当少一个：${before.rects} → ${after.rects}`)
    assert(
      after.polylines === before.polylines - 1,
      `指向它的流向应当跟着少一条：${before.polylines} → ${after.polylines}`,
    )

    await clickByTitle('撤销')
    const undone = await readCanvas()
    assert(
      undone.rects === before.rects && undone.polylines === before.polylines,
      `撤销没把模块和流向一起带回来：${undone.rects} 框 / ${undone.polylines} 折线`,
    )
    return `${before.rects}框/${before.polylines}折线 → 删后 ${after.rects}/${after.polylines} → 撤销后 ${undone.rects}/${undone.polylines}`
  })

  await check('★ 点完成落库：文字、模块、流向都在，且没有悬空流向', async () => {
    await clickButton('完成')
    await sleep(600)
    const shapes = await readSavedScene()
    assert(shapes, '保存之后附件里读不回场景')

    const nodes = shapes.filter((s) => s.kind === 'node')
    const flows = shapes.filter((s) => s.kind === 'flow')
    assert(nodes.length === 5, `应当有 5 个模块，实际 ${nodes.length}`)
    assert(flows.length === 6, `应当有 6 条流向，实际 ${flows.length}`)
    assert(
      nodes.some((n) => n.text === '油箱'),
      `新模块的文字没落库：${nodes.map((n) => n.text).join('/')}`,
    )
    const ids2 = new Set(nodes.map((n) => n.id))
    const orphan = flows.filter((f) => !ids2.has(f.from) || !ids2.has(f.to))
    assert(orphan.length === 0, `库里存了 ${orphan.length} 条悬空流向`)
    return `${nodes.length} 模块 / ${flows.length} 流向，无悬空`
  })

  await check('★ 正文里那张图跟着更新了（覆盖同一个附件）', async () => {
    const r = await evaluate(`(async () => {
      const img = document.querySelector('.note-editor img')
      if (!img) return { labels: [] }
      const text = await (await fetch(img.src)).text()
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      return {
        w: img.naturalWidth,
        labels: [...doc.querySelectorAll('text')].map((t) => t.textContent),
        polygons: doc.querySelectorAll('polygon').length,
      }
    })()`)
    assert(r.w > 0, '正文里的图渲染成了空白')
    assert(r.labels.includes('油箱'), `正文里的图少了新模块：${r.labels.join('/')}`)
    assert(r.polygons === 6, `正文里的图少了箭头：${r.polygons} 个`)
    return `${r.w}px 宽，${r.labels.length} 个标签，6 个箭头`
  })

  // ---------------------------------------------------------------- 收尾
  section('4. 页面报错')
  if (pageErrors.length === 0) {
    console.log('  ✓ 全程没有页面报错')
  } else {
    failures += 1
    console.log(`  ✗ ${pageErrors.length} 条`)
    for (const e of pageErrors.slice(0, 6)) console.log(`      ${String(e).slice(0, 250)}`)
  }

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
  // 杀掉整棵进程树，而且**等它真的退完**再走（理由见 assertPortFree）
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
