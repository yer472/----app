/**
 * 机构符号 / 端点吸附 / 机构语义 的自检。
 *
 * 跑的是 vite dev（不是构建产物）：脚本要在页面里直接
 * `import('/src/components/board/symbols.ts')` 核对符号目录、
 * `import('/src/repository/index.ts')` 核对落库结果，构建产物里没有这些路径。
 *
 * 端口用 5200（5198 是快捷键、5199 是画板，错开就能同时跑）。
 *
 * ## 这个脚本重点验什么
 *
 * 1. **目录自检**：符号定义本身是否自洽（id 唯一、锚点在原点、两点符号在
 *    长短两种长度下都画得出东西）。这类数据错误不会报错，只会让某个符号
 *    在面板里是空的。
 * 2. **机构语义**：拖动一个铰链，连在它上面的构件跟着动、机架钉死不动。
 *    这一条用**纯函数**验，不走鼠标——它是几何逻辑，用真鼠标去拖只会
 *    引入屏幕坐标换算的噪声，反而更容易得到假结论。
 * 3. **放置**：点符号点一下、两点符号拖一段，落库的 SVG 里 metadata 正确、
 *    版本号是 2、能读回来、能渲染。
 * 4. **内联定义**：图里存着定义副本，所以**把符号从库里删掉之后老图照样能打开**。
 *    这是当初决定内联的全部理由，必须验。
 * 5. **备份往返**：自定义符号跟着备份走。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { launchEdge, sleep, waitFor } from './lib/cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5200
const BASE = `http://localhost:${PORT}`

/** 画布定位。页面里有几十个 SVG（Crepe 自带一堆图标），不能靠 querySelector('svg') */
const BOARD = `document.querySelector('[data-board="main"]')`
const PANEL = `document.querySelector('[data-symbol-panel]')`

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
 * ⚠️ 开头那次「端口已经有人应答」的检查不能省。
 *
 * `--strictPort` 会让新服务器在端口被占时退出，但下面的 `waitFor` 只等
 * 「这个端口有响应」——上一次自检没清干净的服务器会替它应答，于是整个脚本
 * 测的是那个旧进程里的旧代码，而且全程不报错。**假测试比没有测试更糟**。
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
        `      先杀掉它：netstat -ano | findstr :${PORT}   然后 taskkill /PID <pid> /T /F`,
    )
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

try {
  await goto(BASE)

  // ---------------------------------------------------------------- 目录自检
  section('0. 符号目录自检')

  await check('★ 10 个内置符号，id 唯一，五个分组都有内容', async () => {
    const r = await evaluate(`(async () => {
      const sym = await import('/src/components/board/symbols.ts')
      const all = [...sym.POINT_SYMBOLS, ...sym.LINK_SYMBOLS]
      const ids = all.map((d) => d.id)
      const groups = Object.fromEntries(
        sym.SYMBOL_GROUPS.map((g) => [g.id, sym.builtInSymbols(g.id).length]),
      )
      return { count: all.length, unique: new Set(ids).size, groups }
    })()`)
    assert(r.count === 10, `应该有 10 个符号，实际 ${r.count}`)
    assert(r.unique === r.count, `id 有重复：${r.count} 个里只有 ${r.unique} 个不同`)
    const empty = Object.entries(r.groups).filter(([, n]) => n === 0)
    assert(empty.length === 0, `这些分组是空的：${empty.map(([g]) => g).join('、')}`)
    return `10 个（${Object.entries(r.groups).map(([g, n]) => `${g} ${n}`).join('，')}）`
  })

  await check('★ 每个点符号的锚点都在原点、图元非空', async () => {
    const r = await evaluate(`(async () => {
      const sym = await import('/src/components/board/symbols.ts')
      return sym.POINT_SYMBOLS.map((d) => {
        const origin = d.anchors.find((a) => a.name === 'origin')
        return { id: d.id, parts: d.parts.length, x: origin?.at.x, y: origin?.at.y }
      })
    })()`)
    for (const def of r) {
      assert(def.parts > 0, `${def.id} 一个图元都没有，面板里会是空白`)
      assert(
        def.x === 0 && def.y === 0,
        `${def.id} 的 origin 锚点不在 (0,0)，在 (${def.x},${def.y})——插入点会偏`,
      )
    }
    return `${r.length} 个都合规`
  })

  /*
   * 两点符号的图元是**长度的函数**，最容易出的错是把某个长度写死：
   * 短的时候没问题，拉长了就露馅（或者反过来）。所以长短两种都试。
   */
  await check('★ 两点符号在很短和很长时都画得出东西', async () => {
    const r = await evaluate(`(async () => {
      const sym = await import('/src/components/board/symbols.ts')
      return sym.LINK_SYMBOLS.map((d) => ({
        id: d.id,
        short: d.partsFor(40).length,
        long: d.partsFor(400).length,
      }))
    })()`)
    for (const def of r) {
      assert(def.short > 0, `${def.id} 在长度 40 时没有图元`)
      assert(def.long > 0, `${def.id} 在长度 400 时没有图元`)
    }
    return `${r.length} 个都正常（40 与 400）`
  })

  await check('「固定」的正好是那三个机架类符号', async () => {
    const r = await evaluate(`(async () => {
      const sym = await import('/src/components/board/symbols.ts')
      return [...sym.POINT_SYMBOLS, ...sym.LINK_SYMBOLS]
        .filter((d) => d.grounded).map((d) => d.id).sort()
    })()`)
    assert(
      JSON.stringify(r) ===
        JSON.stringify(['std:frame', 'std:grounded-joint', 'std:slider']),
      `实际是 ${r.join('、')}——多一个会让不该钉死的东西拖不动`,
    )
    return r.join('、')
  })

  // ---------------------------------------------------------------- 机构语义
  section('1. 机构语义：拖动铰链联动构件（纯函数）')

  /*
   * 造一个四杆机构：机架 AD 固定在 (200,600)-(800,600)，
   * 曲柄 AB 拖到 (500,300)，连杆 BC 接到 (700,400)，摇杆 CD 回到 D。
   *
   * 端点用**完全相同的坐标**——吸附的作用就是保证这一点，所以这组数据
   * 是「用户正确画出来的四杆机构」的真实样子。
   */
  const FOUR_BAR = `{
    width: 1200, height: 900,
    shapes: [
      { id: 'AD', kind: 'link', ref: 'std:frame', a: { x: 200, y: 600 }, b: { x: 800, y: 600 } },
      { id: 'AB', kind: 'link', ref: 'std:member', a: { x: 200, y: 600 }, b: { x: 500, y: 300 } },
      { id: 'BC', kind: 'link', ref: 'std:member', a: { x: 500, y: 300 }, b: { x: 700, y: 400 } },
      { id: 'CD', kind: 'link', ref: 'std:member', a: { x: 700, y: 400 }, b: { x: 800, y: 600 } },
    ],
  }`

  await check('★ 拖动 B 铰链：曲柄和连杆跟着动，两个机架铰链纹丝不动', async () => {
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const before = ${FOUR_BAR}
      const moved = sc.movePointWithCoincident(before, {
        shapeId: 'AB', index: 1, at: { x: 500, y: 300 },
      }, { x: 560, y: 240 })
      const at = (scene, id, index) => {
        const s = scene.shapes.find((x) => x.id === id)
        return index === 0 ? s.a : s.b
      }
      return {
        blocked: moved.blockedBy !== null,
        ABb: at(moved.scene, 'AB', 1),
        BCa: at(moved.scene, 'BC', 0),
        A: at(moved.scene, 'AD', 0),
        D: at(moved.scene, 'AD', 1),
        CDb: at(moved.scene, 'CD', 1),
      }
    })()`)
    assert(!r.blocked, '这次拖动不该被拒绝（B 是活动铰链）')
    assert(
      r.ABb.x === 560 && r.ABb.y === 240,
      `曲柄的 B 端没跟着走，在 (${r.ABb.x},${r.ABb.y})`,
    )
    assert(
      r.BCa.x === 560 && r.BCa.y === 240,
      `连杆的起点没跟着走，在 (${r.BCa.x},${r.BCa.y})——铰链被拉断了`,
    )
    assert(r.A.x === 200 && r.A.y === 600, `机架的 A 端动了，到了 (${r.A.x},${r.A.y})`)
    assert(r.D.x === 800 && r.D.y === 600, `机架的 D 端动了，到了 (${r.D.x},${r.D.y})`)
    assert(r.CDb.x === 800 && r.CDb.y === 600, '摇杆连在机架上的那一端动了')
    return 'B 端两处同步 300,300→560,240，A/D 未动'
  })

  await check('★ 拖机架本体：整套机构一起平移', async () => {
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const moved = sc.translateBodyWithCoincident(${FOUR_BAR}, 'AD', 100, 50)
      const at = (id, index) => {
        const s = moved.shapes.find((x) => x.id === id)
        return index === 0 ? s.a : s.b
      }
      return { A: at('AD', 0), D: at('AD', 1), ABa: at('AB', 0), CDb: at('CD', 1) }
    })()`)
    assert(r.A.x === 300 && r.A.y === 650, `机架 A 端没跟着平移：(${r.A.x},${r.A.y})`)
    assert(r.ABa.x === 300 && r.ABa.y === 650, '曲柄连在机架上的那一端没跟着走——机构散了')
    assert(r.CDb.x === 900 && r.CDb.y === 650, '摇杆连在机架上的那一端没跟着走')
    return 'A、D 以及两端连着的构件一起平移了 (100,50)'
  })

  /*
   * 规则 3：待移动的点里只要有一个固定构件的锚点，整次拖动被拒绝。
   *
   * 拒绝而不是「允许但不动」是刻意的：后者会静默把重合拉断，用户看到的是
   * 机构散了却找不到是哪一步弄散的。
   */
  await check('★ 直接拖固定铰链的锚点：被拒绝，场景一点没变', async () => {
    const r = await evaluate(`(async () => {
      const sc = await import('/src/components/board/scene.ts')
      const before = ${FOUR_BAR}
      const moved = sc.movePointWithCoincident(before, {
        shapeId: 'AD', index: 0, at: { x: 200, y: 600 },
      }, { x: 100, y: 700 })
      return {
        blocked: moved.blockedBy !== null,
        same: JSON.stringify(moved.scene) === JSON.stringify(before),
      }
    })()`)
    assert(r.blocked, '拖机架锚点没有被拒绝——「固定铰链」就名不副实了')
    assert(r.same, '被拒绝时场景却变了，说明只拒绝了一半')
    return '拒绝，且场景字节级不变'
  })

  // ---------------------------------------------------------------- 放置
  section('2. 放置：点一下 / 拖一段')

  const ids = await evaluate(`(async () => {
    const repo = await import('/src/repository/index.ts')
    const s = await repo.SubjectRepository.create({ name: '【符号自检】' })
    const c = await repo.ChapterRepository.create({ subjectId: s.id, name: '机构' })
    const n = await repo.NoteRepository.create({ chapterId: c.id, title: '四杆机构' })
    return { sid: s.id, cid: c.id, nid: n.id }
  })()`)
  assert(ids?.nid, '没有建出测试数据')

  await goto(`${BASE}/subjects/${ids.sid}/chapters/${ids.cid}/notes/${ids.nid}`)
  await waitFor(
    () =>
      evaluate(
        `!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === '插入图形') || {}).disabled`,
      ),
    { timeout: 25_000, label: '编辑器就绪' },
  )
  await sleep(700)

  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '插入图形').click()`,
  )
  await sleep(350)
  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '新建图形').click()`,
  )
  await waitFor(() => evaluate(`Boolean(${BOARD})`), { timeout: 15_000, label: '画板打开' })
  await sleep(600)

  await check('符号面板出现了，内置符号都在', async () => {
    const r = await evaluate(`(() => {
      const panel = ${PANEL}
      if (!panel) return { found: false }
      return {
        found: true,
        buttons: panel.querySelectorAll('button[title]').length,
        hasCustomSection: panel.innerText.includes('我的符号'),
      }
    })()`)
    assert(r.found, '没找到符号面板')
    assert(r.buttons >= 10, `面板里只有 ${r.buttons} 个符号按钮`)
    assert(r.hasCustomSection, '没有「我的符号」那一段')
    return `${r.buttons} 个按钮，两段都在`
  })

  const boardRect = await evaluate(
    `(() => { const r = ${BOARD}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`,
  )
  const toScreen = (sx, sy) => {
    const scale = Math.min(boardRect.w / 1200, boardRect.h / 900)
    return {
      x: boardRect.x + (boardRect.w - 1200 * scale) / 2 + sx * scale,
      y: boardRect.y + (boardRect.h - 900 * scale) / 2 + sy * scale,
    }
  }

  const clickAt = async (sx, sy) => {
    const p = toScreen(sx, sy)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(150)
  }

  const stroke = async ([sx1, sy1], [sx2, sy2]) => {
    const a = toScreen(sx1, sy1)
    const b = toScreen(sx2, sy2)
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
    await sleep(150)
  }

  const clickPanelSymbol = (name) =>
    evaluate(`(() => {
      const btn = [...${PANEL}.querySelectorAll('button[title]')].find((b) => b.title === ${JSON.stringify(name)})
      if (!btn) throw new Error('面板里没有：' + ${JSON.stringify(name)})
      btn.click()
    })()`)

  await clickPanelSymbol('转动副')
  await clickAt(300, 400)
  await clickPanelSymbol('固定铰链')
  await clickAt(700, 400)
  await clickPanelSymbol('构件')
  await stroke([300, 400], [500, 260])

  await check('画布上出现了两个点符号和一根构件', async () => {
    const r = await evaluate(`(() => {
      const g = ${BOARD}.querySelector('g')
      return {
        ellipses: g.querySelectorAll('ellipse').length,
        rects: g.querySelectorAll('rect').length,
        lines: g.querySelectorAll('line').length,
        polylines: g.querySelectorAll('polyline').length,
        groups: g.querySelectorAll('g').length,
      }
    })()`)
    // 转动副 1 个圆；固定铰链 1 圆 + 1 折线（三角形）+ 3 条机架斜线；
    // 构件 1 条粗线 + 2 个端部铰链圆。
    // 斜线是 3 条不是 5 条：groundHatch 两头各缩进一段再按 16 的间距铺，
    // 长度 52 的底座得 3 条。（一开始我把这里写成 5，被这条断言当场纠正。）
    assert(r.ellipses === 4, `圆应该是 4 个，实际 ${r.ellipses}`)
    assert(r.lines === 4, `直线应该是 4 条（构件 1 + 斜线 3），实际 ${r.lines}`)
    assert(r.polylines === 1, `折线应该是 1 个（固定铰链的三角形），实际 ${r.polylines}`)
    // 三个符号类的图形各自套了一层 `<g transform>`，普通图形没有：
    // 点符号要平移 + 旋转，两点符号要平移 + 转到 A→B 的方向上
    assert(r.groups === 3, `带变换的分组应该是 3 个（2 个点符号 + 1 根构件），实际 ${r.groups}`)
    return `${r.ellipses} 圆 / ${r.lines} 线 / ${r.polylines} 折线 / ${r.groups} 变换组`
  })

  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '完成').click()`,
  )
  await waitFor(() => evaluate(`!${BOARD}`), { timeout: 10_000, label: '画板关闭' })
  await sleep(700)

  const readScene = async () => {
    return evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const ser = await import('/src/components/board/serialize.ts')
      const atts = await repo.AttachmentRepository.listByNote(${JSON.stringify(ids.nid)})
      const att = atts.filter((a) => a.type === 'drawing').pop()
      if (!att) return { error: '没有图形附件' }
      const text = await att.blob.text()
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
      const scene = ser.parseSceneFromSvg(text)
      if (!scene) return { error: '存出去的 SVG 读不回来' }
      const payload = JSON.parse(doc.querySelector('metadata').textContent)
      // 顺带确认它真的能渲染：畸形 SVG 只会渲染成空白，不抛异常
      const url = URL.createObjectURL(att.blob)
      const size = await new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => resolve({ w: 0, h: 0 })
        img.src = url
      })
      URL.revokeObjectURL(url)
      return { version: payload.version, scene, size, aid: att.id }
    })()`)
  }

  await check('★ 落库的场景保留了两个符号和一根构件', async () => {
    const r = await readScene()
    assert(!r.error, r.error)
    assert(r.scene.shapes.length === 3, `应该是 3 个图元，实际 ${r.scene.shapes.length}`)
    const kinds = r.scene.shapes.map((s) => s.kind)
    assert(
      JSON.stringify(kinds) === JSON.stringify(['symbol', 'symbol', 'link']),
      `种类不对：${kinds.join('、')}`,
    )
    return kinds.join('、')
  })

  await check('★ 版本号按内容写：用了符号就是 2', async () => {
    const r = await readScene()
    assert(r.version === 2, `应该是 2，实际 ${r.version}`)
    assert(r.size.w > 0, `渲染出来是空白（naturalWidth=${r.size.w}）`)
    return `version=${r.version}，naturalWidth=${r.size.w}`
  })

  await check('★ 符号定义内联在场景里，跟着图走', async () => {
    const r = await readScene()
    const defs = r.scene.defs ?? {}
    const refs = r.scene.shapes.filter((s) => s.kind === 'symbol').map((s) => s.ref)
    for (const ref of refs) {
      assert(defs[ref], `场景里没有 ${ref} 的定义，这张图换台机器就画不出来了`)
      assert(defs[ref].parts.length > 0, `${ref} 的定义里没有图元`)
    }
    return `${refs.join('、')} 的定义都在`
  })

  await check('两点符号的长度等于拖动距离', async () => {
    const r = await readScene()
    const link = r.scene.shapes.find((s) => s.kind === 'link')
    const length = Math.hypot(link.b.x - link.a.x, link.b.y - link.a.y)
    // 从 (300,400) 拖到 (500,260)：吸附到网格后是 (300,400)→(500,260)
    assert(
      Math.abs(length - Math.hypot(200, -140)) < 1,
      `长度是 ${length.toFixed(1)}，和拖动距离对不上`,
    )
    return `长度 ${length.toFixed(1)}`
  })

  // ---------------------------------------------------------------- 自定义符号
  section('3. 自定义符号：新建、内联、删库不影响老图')

  await check('★ 新建一个自定义符号并落库', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const created = await repo.SymbolRepository.create({
        name: '我的支座',
        shapes: [
          { id: 'c1', kind: 'line', a: { x: 140, y: 200 }, b: { x: 180, y: 200 } },
          { id: 'c2', kind: 'rect', a: { x: 140, y: 160 }, b: { x: 180, y: 200 } },
        ],
        origin: { x: 160, y: 200 },
        width: 320,
        height: 320,
      })
      const all = await repo.SymbolRepository.list()
      return { id: created.id, name: created.name, count: all.length }
    })()`)
    assert(r.count >= 1, '符号没有落库')
    assert(r.name === '我的支座', `名字不对：${r.name}`)
    return `1 个（${r.name}）`
  })

  await check('自定义符号的定义由 shapes 推出来，图元数对得上', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const render = await import('/src/components/board/render.tsx')
      const all = await repo.SymbolRepository.list()
      const def = render.defOfCustomSymbol(all[0])
      return { parts: def.parts.length, anchors: def.anchors.length, x: def.anchors[0].at.x }
    })()`)
    assert(r.parts === 2, `两个图元应该推出两段零件，实际 ${r.parts}`)
    assert(r.anchors === 1, `应该只有一个插入点锚点，实际 ${r.anchors}`)
    assert(r.x === 160, `锚点位置不对：${r.x}`)
    return '2 个零件、1 个锚点'
  })

  /*
   * ★ 这一条是「内联」这个决定的兑现。
   *
   * 把符号从库里**删掉**，上面那张已经画好的图必须还能打开、还能画出来——
   * 因为图里存着它当时的定义副本。不做内联的话这里会变成「打开就报错」。
   */
  await check('★ 把符号从库里删掉，已经画好的图照样打得开', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const render = await import('/src/components/board/render.tsx')

      // 先造一张用了自定义符号的图
      const all = await repo.SymbolRepository.list()
      const def = render.defOfCustomSymbol(all[0])
      const scene = {
        width: 1200, height: 900,
        defs: { [def.id]: def },
        shapes: [{ id: 's1', kind: 'symbol', ref: def.id, at: { x: 300, y: 300 }, rotation: 0 }],
      }
      const ser = await import('/src/components/board/serialize.ts')
      const att = await repo.AttachmentRepository.createDrawing({
        noteId: ${JSON.stringify(ids.nid)},
        blob: ser.sceneToSvgBlob(scene), width: 1200, height: 900,
      })

      // 现在把符号从库里删掉
      await repo.SymbolRepository.remove(def.id)
      const left = await repo.SymbolRepository.list()

      // 图还读得回来吗
      const stored = await repo.AttachmentRepository.get(att.id)
      const loaded = ser.parseSceneFromSvg(await stored.blob.text())
      const svg = loaded ? ser.sceneToSvgElement(loaded) : null
      return {
        left: left.length,
        parsed: loaded !== null,
        lines: svg ? svg.querySelectorAll('line').length : -1,
        rects: svg ? svg.querySelectorAll('rect').length : -1,
      }
    })()`)
    assert(r.left === 0, `库里的符号没删干净，还剩 ${r.left} 个`)
    assert(r.parsed, '删掉库里的符号之后，已经画好的图打不开了——内联没生效')
    // 那个自定义符号由一条线和一组成，所以画出来应当是 1 线 + 1 矩形
    // （白底那张纸也是 rect，所以总数是 2）
    assert(r.lines === 1, `图里应该还能画出那条线，实际 ${r.lines} 条`)
    assert(r.rects === 2, `图里应该还能画出那个矩形（含白底共 2 个），实际 ${r.rects}`)
    return '库里 0 个，图仍能解析并画出 1 线 + 1 矩形'
  })

  // ---------------------------------------------------------------- 备份
  section('4. 备份往返')

  await check('★ 自定义符号进备份，也回得来', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const fmt = await import('/src/lib/backup/format.ts')

      await repo.SymbolRepository.create({
        name: '备份用的符号',
        shapes: [{ id: 'k1', kind: 'line', a: { x: 0, y: 0 }, b: { x: 40, y: 0 } }],
        origin: { x: 0, y: 0 },
        width: 320, height: 320,
      })

      const snapshot = await repo.BackupRepository.snapshot()
      const file = fmt.buildBackupFile(snapshot, new Date().toISOString())
      const text = JSON.stringify(file)

      // 走一遍真正的解析路径（它会逐字段补全、过滤坏数据）
      const parsed = fmt.parseBackupFile(text, '自检')
      await repo.BackupRepository.replaceAll(parsed, [])
      const after = await repo.SymbolRepository.list()
      return {
        inFile: file.symbols.length,
        version: file.version,
        after: after.length,
        name: after[0]?.name,
        counts: parsed.counts.symbols,
      }
    })()`)
    assert(r.version === 2, `备份版本应该是 2，实际 ${r.version}`)
    assert(r.inFile >= 1, '备份文件里没有符号')
    assert(r.after === r.inFile, `导出 ${r.inFile} 个、恢复后 ${r.after} 个，对不上`)
    assert(r.counts === r.inFile, `counts.symbols 是 ${r.counts}，应该是 ${r.inFile}`)
    return `备份 v${r.version}，往返 ${r.after} 个（${r.name}）`
  })

  await check('★ 只改符号、不动笔记，内容指纹也要变', async () => {
    const r = await evaluate(`(async () => {
      const repo = await import('/src/repository/index.ts')
      const fmt = await import('/src/lib/backup/format.ts')
      const before = fmt.contentHashOf(await repo.BackupRepository.snapshot())
      const all = await repo.SymbolRepository.list()
      await repo.SymbolRepository.update(all[0].id, { name: '改了个名字' })
      const after = fmt.contentHashOf(await repo.BackupRepository.snapshot())
      return { same: before === after }
    })()`)
    // 指纹不变的话，镜像备份会判定「没变化」直接跳过整轮写入，
    // 当天的每日快照也不写——符号会一直不进备份，而且毫无提示
    assert(!r.same, '指纹没变：改了符号但备份会认为「什么都没变」从而跳过')
    return '指纹已变化'
  })

  // ---------------------------------------------------------------- 收尾
  section('5. 页面报错与清理')

  await check('全程没有页面报错', async () => {
    assert(pageErrors.length === 0, pageErrors.slice(0, 3).join('\n      '))
    return `${pageErrors.length} 条`
  })

  await evaluate(
    `(async () => {
      const repo = await import('/src/repository/index.ts')
      await repo.SubjectRepository.remove(${JSON.stringify(ids.sid)})
    })()`,
  ).catch(() => {})
} catch (error) {
  failures += 1
  console.log(`\n脚本中断：${error?.message ?? error}`)
} finally {
  console.log('\n' + '─'.repeat(60))
  console.log(failures === 0 ? '全部通过。' : `${failures} 项失败。`)
  await edge.close()
  // 杀掉整棵进程树，而且**等它真的退完**再走。spawn 完立刻 exit 的话，
  // taskkill 有可能还没跑完父进程就没了，dev 服务器会留在端口上——
  // 下一次自检就会悄悄测那份旧代码（见 assertPortFree 的注释）
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
