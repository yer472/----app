import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { db, getStorageUsage } from '@/db'
import { formatBytes } from '@/lib/format'
import {
  AttachmentRepository,
  ChapterRepository,
  NoteRepository,
  SubjectRepository,
} from '@/repository'

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

interface EnvInfo {
  persisted: boolean | null
  usage: string
  quota: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * 数据库自检页（M0 阶段的验证工具）。
 *
 * 目的是证明「数据能写进去、能读回来、能删干净」这条链路是通的，
 * 而不是等到 M2 做编辑器时才发现存储层有问题。
 * 全部用的是真实数据 + 真实事务，跑完会把自己建的测试数据清干净。
 *
 * 后续功能稳定后这个页面可以删掉，或收进设置里的「高级」区域。
 */
export function DevDbCheckPage() {
  const [results, setResults] = useState<CheckResult[] | null>(null)
  const [env, setEnv] = useState<EnvInfo | null>(null)
  const [running, setRunning] = useState(false)

  const run = async () => {
    setRunning(true)
    setResults(null)

    const collected: CheckResult[] = []
    const check = async (name: string, fn: () => Promise<string>) => {
      try {
        collected.push({ name, ok: true, detail: await fn() })
      } catch (e) {
        collected.push({
          name,
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        })
      }
    }

    // 临时数据，最后会连同级联测试一起删掉
    let subjectId = ''
    let chapterId = ''
    let noteId = ''

    try {
      await check('1. 科目：写入后能读回', async () => {
        const created = await SubjectRepository.create({
          name: '__自检科目__',
          color: '#3b82f6',
          description: '这个科目由数据库自检创建，可以安全删除',
        })
        subjectId = created.id
        const readBack = await SubjectRepository.get(created.id)
        assert(readBack, '读回结果为空')
        assert(readBack.name === '__自检科目__', '读回的科目名不一致')
        return `已写入并读回，id=${created.id.slice(0, 8)}…`
      })

      await check('2. 科目：修改能落库', async () => {
        assert(subjectId, '前置步骤失败，跳过')
        await SubjectRepository.update(subjectId, { name: '__自检科目（已改名）__' })
        const readBack = await SubjectRepository.get(subjectId)
        assert(
          readBack?.name === '__自检科目（已改名）__',
          `改名没生效，当前值：${readBack?.name}`,
        )
        return '名称已更新并从数据库读回确认'
      })

      await check('3. 章节：写入 + 按科目查询', async () => {
        assert(subjectId, '前置步骤失败，跳过')
        const created = await ChapterRepository.create({
          subjectId,
          name: '__自检章节__',
        })
        chapterId = created.id
        const siblings = await ChapterRepository.listBySubject(subjectId)
        assert(
          siblings.some((c) => c.id === created.id),
          '按 subjectId 查询没有找到刚建的章节（索引可能有问题）',
        )
        return `已写入，按 subjectId 索引查询命中 ${siblings.length} 个章节`
      })

      await check('4. 笔记：写入 + 自动生成摘要', async () => {
        assert(chapterId, '前置步骤失败，跳过')
        const created = await NoteRepository.create({
          chapterId,
          content:
            '## 罗尔定理\n\n其中 **罗尔定理** 是最基础的一个，条件是闭区间连续。',
        })
        noteId = created.id
        assert(created.title === '罗尔定理', `标题提取不对：${created.title}`)
        assert(
          created.excerpt.includes('罗尔定理') &&
            !created.excerpt.includes('##') &&
            !created.excerpt.includes('**'),
          `摘要没有正确去掉 Markdown 标记：${created.excerpt}`,
        )
        return `标题自动取为「${created.title}」，摘要：${created.excerpt.slice(0, 24)}…`
      })

      await check('5. 笔记：保存正文后摘要同步更新', async () => {
        assert(noteId, '前置步骤失败，跳过')
        await NoteRepository.saveContent(
          noteId,
          '## 拉格朗日中值定理\n\n罗尔定理的推广形式。',
        )
        const readBack = await NoteRepository.get(noteId)
        assert(readBack, '笔记读不到了')
        assert(readBack.content.includes('拉格朗日'), '正文没有保存成功')
        assert(
          readBack.excerpt.includes('拉格朗日'),
          `摘要没有跟着正文更新：${readBack.excerpt}`,
        )
        return '正文与摘要均已更新'
      })

      await check('6. 搜索：能命中正文关键词', async () => {
        assert(noteId, '前置步骤失败，跳过')
        const hits = await NoteRepository.search('拉格朗日')
        assert(
          hits.some((h) => h.note.id === noteId),
          '搜索没有命中刚写入的笔记',
        )
        return `关键词「拉格朗日」命中 ${hits.length} 条`
      })

      await check('7. 附件：图片二进制能原样读回', async () => {
        assert(noteId, '前置步骤失败，跳过')
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
        const created = await AttachmentRepository.createImage({
          noteId,
          blob: new Blob([bytes], { type: 'image/png' }),
          width: 1,
          height: 1,
        })
        const readBack = await AttachmentRepository.get(created.id)
        assert(readBack, '读回的附件为空')
        assert(
          readBack.blob.size === bytes.length,
          `字节数不符：期望 ${bytes.length}，实际 ${readBack.blob.size}`,
        )
        const readBytes = new Uint8Array(await readBack.blob.arrayBuffer())
        assert(
          readBytes.every((b, i) => b === bytes[i]),
          '字节内容与写入时不一致',
        )
        return `Blob 往返 ${readBack.blob.size} 字节，内容逐字节一致`
      })

      await check('8. 级联删除：删科目后四张表都不留残渣', async () => {
        assert(subjectId && chapterId && noteId, '前置步骤失败，跳过')

        await SubjectRepository.remove(subjectId)

        assert(!(await db.subjects.get(subjectId)), '科目没有被删除')
        assert(!(await db.chapters.get(chapterId)), '章节没有被级联删除')
        assert(!(await db.notes.get(noteId)), '笔记没有被级联删除')
        const leftover = await db.attachments.where('noteId').equals(noteId).count()
        assert(leftover === 0, `还有 ${leftover} 条附件没删掉`)

        // 已经删干净了，防止 finally 里再删一次
        subjectId = ''
        return '科目 / 章节 / 笔记 / 附件 全部清除，无孤儿数据'
      })
    } finally {
      // 如果前面某一步抛异常导致没走到第 8 步，这里兜底清理，
      // 避免自检页面用一次就在数据库里留一堆垃圾
      if (subjectId) {
        await SubjectRepository.remove(subjectId).catch(() => {})
      }
    }

    const [{ usage, quota }, persisted] = await Promise.all([
      getStorageUsage().then((r) => r ?? { usage: 0, quota: 0 }),
      navigator.storage?.persisted?.().catch(() => null) ?? Promise.resolve(null),
    ])

    setEnv({
      persisted,
      usage: usage ? formatBytes(usage) : '未知',
      quota: quota ? formatBytes(quota) : '未知',
    })
    setResults(collected)
    setRunning(false)
  }

  const passed = results?.filter((r) => r.ok).length ?? 0
  const total = results?.length ?? 0

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">数据库自检</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          验证 IndexedDB 的读写与级联删除是否正常。会创建临时数据并在结束时清理干净。
        </p>
      </header>

      <Button variant="primary" onClick={run} disabled={running}>
        {running ? '检查中…' : '开始自检'}
      </Button>

      {env ? (
        <div className="mt-6 rounded-lg border border-neutral-200 px-4 py-3 text-sm dark:border-neutral-800">
          <div className="mb-2 font-medium">存储环境</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-neutral-600 dark:text-neutral-400">
            <dt>持久化权限</dt>
            <dd>
              {env.persisted === null
                ? '无法查询'
                : env.persisted
                  ? '已获得 —— 浏览器自动清理时会跳过本站数据'
                  : '未获得 —— 请务必开启自动备份'}
            </dd>
            <dt>已用 / 配额</dt>
            <dd>
              {env.usage} / {env.quota}
            </dd>
          </dl>
        </div>
      ) : null}

      {results ? (
        <div className="mt-6">
          <div
            className={
              passed === total
                ? 'mb-3 text-sm font-medium text-green-700 dark:text-green-400'
                : 'mb-3 text-sm font-medium text-red-700 dark:text-red-400'
            }
          >
            {passed === total
              ? `全部通过（${passed}/${total}）`
              : `有失败项（${passed}/${total} 通过）`}
          </div>

          <ul className="space-y-2">
            {results.map((r) => (
              <li
                key={r.name}
                className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={
                      r.ok
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }
                    aria-hidden
                  >
                    {r.ok ? '✓' : '✕'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{r.name}</div>
                    <div
                      className={
                        r.ok
                          ? 'mt-0.5 text-xs break-words text-neutral-500 dark:text-neutral-400'
                          : 'mt-0.5 text-xs break-words text-red-700 dark:text-red-300'
                      }
                    >
                      {r.detail}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
