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
 *  用 querySelector('svg') 会选中一个 0×0 的图标，算出来的坐标全部落空 */
const BOARD = `document.querySelector('pattern#xxbj-grid').closest('svg')`

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

async function startDevServer() {
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
      return { shapes: scene?.shapes.length, first: scene?.shapes[0]?.a }
    })()`)
    assert(r?.shapes === 3, `图元数不对：${r?.shapes}`)
    assert(r?.first?.x === 100 && r?.first?.y === 700, `坐标不对：${JSON.stringify(r?.first)}`)
    return '3 个图元，坐标原样回来'
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
  await waitFor(() => evaluate(`Boolean(document.querySelector('pattern#xxbj-grid'))`), {
    timeout: 15_000,
    label: '画板打开',
  })
  await sleep(600)

  await check('画板把已存的 3 条线读回来了', async () => {
    const n = await evaluate(`${BOARD}.querySelectorAll('line').length`)
    assert(n === 3, `实际 ${n} 条`)
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
  async function stroke([sx1, sy1], [sx2, sy2]) {
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
    await sleep(120)
  }

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

  // ---------------------------------------------------------------- 保存
  section('2. 保存：覆盖同一个附件，并刷新正文里的图')
  const before = await evaluate(READ_DISPLAYED_IMAGE)
  assert(before?.lines === 3, `保存前正文里的图应该是 3 条线，实际 ${before?.lines}`)

  await evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '完成').click()`,
  )
  await waitFor(() => evaluate(`!document.querySelector('pattern#xxbj-grid')`), {
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
  devServer.kill()
  // Windows 上 npm 会再起一个子进程，杀掉整棵树
  if (process.platform === 'win32' && devServer.pid) {
    spawn('taskkill', ['/pid', String(devServer.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  process.exit(failures === 0 ? 0 : 1)
}
