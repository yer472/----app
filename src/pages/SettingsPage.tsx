import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Kbd'
import { Modal } from '@/components/ui/Modal'
import { Notice, type NoticeTone } from '@/components/ui/Notice'
import { getStorageUsage } from '@/db'
import { revokeAllAssetUrls } from '@/lib/asset'
import {
  describeArchive,
  parseArchive,
  type ParsedArchive,
} from '@/lib/backup/archive'
import {
  archiveFileName,
  type BackupCounts,
} from '@/lib/backup/format'
import { describeBackupResult, buildExportArchive } from '@/lib/backup/service'
import { downloadBlob, pickFile } from '@/lib/download'
import { formatBytes } from '@/lib/format'
import { formatDateTime } from '@/lib/time'
import { cn } from '@/lib/cn'
import {
  entriesOf,
  GROUP_ORDER,
  SHORTCUTS_SECTION_ID,
  type SettingsScrollState,
} from '@/lib/shortcuts/catalog'
import { formatComboList } from '@/lib/shortcuts/matcher'
import { useSwStore } from '@/pwa/swStore'
import { BackupRepository, type IntegrityReport } from '@/repository'
import { useBackupStore } from '@/store/backupStore'

type Busy =
  | { kind: 'none' }
  | { kind: 'export'; done: number; total: number }
  | { kind: 'import' }

function Section({
  title,
  description,
  children,
  id,
  highlighted,
}: {
  title: string
  description?: string
  children: React.ReactNode
  /** 作为 Ctrl+/ 的滚动目标时要有个 id */
  id?: string
  highlighted?: boolean
}) {
  return (
    <section
      id={id}
      className={cn(
        'rounded-lg border p-5 transition-colors duration-500',
        // cn() 没有 tailwind-merge，所以两组 border-* 只能二选一。
        // 写成 `border-neutral-200 ${highlighted && 'border-blue-400'}`
        // 会让两个类同时存在，谁赢取决于样式表里的顺序。
        highlighted
          ? 'border-blue-400 ring-2 ring-blue-200 dark:border-blue-500 dark:ring-blue-900'
          : 'border-neutral-200 dark:border-neutral-800',
      )}
    >
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        {title}
      </h2>
      {description ? (
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {description}
        </p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}

/**
 * 快捷键一览。
 *
 * 内容全部来自 lib/shortcuts/catalog.ts——那张表同时是绑定的来源，
 * 所以这里不可能出现「写着 Ctrl+/ 其实是别的」这种漂移。
 *
 * 分成四组是因为它们的生效范围完全不同：编辑器和绘图那两组由别人实现，
 * 全局和页面那两组才是本 App 绑的。不分开的话用户会以为按 Ctrl+Alt+1
 * 在任何地方都能变成标题。
 */
function ShortcutReference() {
  return (
    <div className="space-y-5">
      {GROUP_ORDER.map((group) => (
        <div key={group.id}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="text-xs font-medium tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
              {group.title}
            </h3>
            <span className="text-xs text-neutral-400 dark:text-neutral-500">
              {group.note}
            </span>
          </div>
          <ul className="mt-2 space-y-2">
            {entriesOf(group.id).map((entry) => (
              <li
                key={entry.id}
                className="flex items-baseline justify-between gap-4"
              >
                <span className="text-sm text-neutral-700 dark:text-neutral-300">
                  {entry.label}
                  {entry.caveat ? (
                    <span className="mt-0.5 block text-xs text-neutral-400 dark:text-neutral-500">
                      {entry.caveat}
                    </span>
                  ) : null}
                </span>
                {/* 键帽里用空格分隔（Ctrl K），和侧栏那个搜索入口一致。
                    formatCombo 里保留 + 是因为那才是通用写法，
                    两者只是显示口径不同 */}
                <Kbd>{formatComboList(entry.keys).replaceAll('+', ' ')}</Kbd>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/* Notice 原先是这个文件里的私有函数，M4.5 提到 ui/ 下共用了（删除确认、
   新建笔记这些写路径的失败提示也要用它）。import 在文件顶部。 */

export function SettingsPage() {
  const [busy, setBusy] = useState<Busy>({ kind: 'none' })
  const [notice, setNotice] = useState<{
    tone: NoticeTone
    text: string
  } | null>(null)

  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(
    null,
  )
  const [currentCounts, setCurrentCounts] = useState<BackupCounts | null>(null)

  const [pending, setPending] = useState<ParsedArchive | null>(null)
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null)
  const [exportFirst, setExportFirst] = useState(true)

  const [standalone, setStandalone] = useState(false)
  const [checkMessage, setCheckMessage] = useState<string | null>(null)

  const backup = useBackupStore()
  const sw = useSwStore()

  const location = useLocation()
  const scrollTo =
    (location.state as SettingsScrollState | null)?.scrollTo ?? null
  const [highlighted, setHighlighted] = useState<string | null>(null)

  // Ctrl+/ 跳过来时，把那一节滚进视野并闪一下。
  //
  // 依赖 location.key 而不是只看 scrollTo：已经在设置页时再按一次 Ctrl+/
  // 会压一条新的历史记录，key 变了而 scrollTo 没变——只看 scrollTo 就
  // 不会再滚一次，用户会觉得"按了没反应"。
  //
  // 用 location.state 而不是 #hash：hash 会让浏览器在设置页还是个空壳的
  // 时候就去执行原生锚点滚动，我们会跟它抢。
  useEffect(() => {
    if (!scrollTo) return
    const target = document.getElementById(scrollTo)
    if (!target) return
    target.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setHighlighted(scrollTo)
    const timer = window.setTimeout(() => setHighlighted(null), 1600)
    return () => window.clearTimeout(timer)
  }, [scrollTo, location.key])

  const handleCheckUpdate = async () => {
    setCheckMessage(null)
    const result = await sw.checkForUpdate()
    setCheckMessage(
      result === 'updated'
        ? '发现新版本，看上面的提示。'
        : result === 'current'
          ? '已经是最新版本。'
          : '连不上本地服务器，没法检查。这本身是正常的——平时不需要开着服务器，' +
            '只有重新构建之后想更新时才需要先跑一次 npm run serve。',
    )
  }

  const refreshCounts = () => {
    void BackupRepository.counts().then(setCurrentCounts)
  }

  useEffect(() => {
    void backup.hydrate()
    void getStorageUsage().then(setUsage)
    void navigator.storage
      ?.persisted?.()
      .then(setPersisted)
      .catch(() => setPersisted(null))
    void BackupRepository.counts().then(setCurrentCounts)
    setStandalone(window.matchMedia('(display-mode: standalone)').matches)
    // 只在进入页面时跑一次。backup.hydrate 内部是幂等的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleExport = async () => {
    setNotice(null)
    setBusy({ kind: 'export', done: 0, total: 0 })
    try {
      const { blob, counts } = await buildExportArchive((progress) =>
        setBusy({ kind: 'export', done: progress.done, total: progress.total }),
      )
      downloadBlob(blob, archiveFileName())
      setNotice({
        tone: 'ok',
        text: `已导出 ${counts.subjects} 个科目、${counts.chapters} 个章节、${counts.notes} 篇笔记、${counts.attachments} 张图片、${counts.symbols} 个自定义符号，共 ${formatBytes(blob.size)}。浏览器应该已经开始下载了，检查一下下载文件夹。`,
      })
    } catch (error) {
      setNotice({
        tone: 'error',
        text: `导出失败：${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setBusy({ kind: 'none' })
    }
  }

  const handlePickImportFile = async () => {
    setNotice(null)
    const file = await pickFile('.zip,.json,application/zip,application/json')
    if (!file) return

    setBusy({ kind: 'import' })
    try {
      const parsed = await parseArchive(file, file.name)
      const report = await BackupRepository.inspect(parsed.backup)
      setPending(parsed)
      setIntegrity(report)
      setExportFirst(true)
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy({ kind: 'none' })
    }
  }

  const handleConfirmImport = async () => {
    if (!pending) return
    setBusy({ kind: 'import' })
    setNotice(null)

    try {
      // 先把现有数据导出一份再覆盖。恢复本身是破坏性操作，
      // 万一用户选错了文件，这一步就是后悔药。
      if (exportFirst && currentCounts && currentCounts.notes > 0) {
        const { blob } = await buildExportArchive()
        downloadBlob(blob, `XXBJ-恢复前备份-${archiveFileName().replace('XXBJ-备份-', '')}`)
      }

      await BackupRepository.replaceAll(pending.backup, pending.attachments)

      // 旧图片的 blob URL 现在指向已经删掉的数据，全部释放掉
      revokeAllAssetUrls()
      refreshCounts()

      const parts = [
        `已恢复 ${pending.backup.subjects.length} 个科目、${pending.backup.chapters.length} 个章节、${pending.backup.notes.length} 篇笔记`,
        `${pending.attachments.length} 张图片`,
        `${pending.backup.symbols?.length ?? 0} 个自定义符号`,
      ]
      if (pending.missingImages.length > 0) {
        parts.push(`有 ${pending.missingImages.length} 张图片在备份里没找到，未能恢复`)
      }
      setNotice({ tone: 'ok', text: `${parts.join('，')}。` })
      setPending(null)
    } catch (error) {
      setNotice({
        tone: 'error',
        text: `恢复失败：${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setBusy({ kind: 'none' })
    }
  }

  const backupDisabledReason = !backup.supported
    ? '当前浏览器不支持 File System Access API。请用 Edge 或 Chrome 打开，或者改用上面的手动导出。'
    : null

  const orphanTotal = integrity
    ? integrity.orphanChapters + integrity.orphanNotes + integrity.orphanAttachments
    : 0

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        设置
      </h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        笔记数据全部存在这台电脑的浏览器里，不经过任何服务器。
        也正因为如此，<strong className="font-medium">清理浏览器数据会把笔记一起清掉</strong>
        ——下面的导出和自动备份就是为此准备的。
      </p>

      {notice ? (
        <div className="mt-5">
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      ) : null}

      <div className="mt-6 space-y-5">
        {/* ---------- 存储状态 ---------- */}
        <Section title="存储状态">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                笔记
              </dt>
              <dd className="mt-0.5 tabular-nums">
                {currentCounts ? `${currentCounts.notes} 篇` : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                科目 / 章节
              </dt>
              <dd className="mt-0.5 tabular-nums">
                {currentCounts
                  ? `${currentCounts.subjects} / ${currentCounts.chapters}`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                图片
              </dt>
              <dd className="mt-0.5 tabular-nums">
                {currentCounts
                  ? `${currentCounts.attachments} 张 · ${formatBytes(currentCounts.imageBytes)}`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                浏览器占用
              </dt>
              <dd className="mt-0.5 tabular-nums">
                {usage ? formatBytes(usage.usage) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                持久化存储
              </dt>
              <dd className="mt-0.5">
                {persisted === null
                  ? '—'
                  : persisted
                    ? '已启用'
                    : '未启用'}
              </dd>
            </div>
          </dl>

          {persisted === false ? (
            <div className="mt-3">
              <Notice tone="warn">
                浏览器没有授予持久化存储权限。它可能在磁盘紧张时自动清理本站数据。
                这不影响下面的导出和备份功能，但说明「靠浏览器自己保底」是不可靠的。
              </Notice>
            </div>
          ) : null}
        </Section>

        {/* ---------- 键盘快捷键 ----------
            放在「存储状态」之后：那一节只有三行只读摘要，排在它后面能让这份
            一览表落进第一屏，同时下面几节数据安全相关的操作仍然连成一片。
            Ctrl+/ 会直接滚到这里，所以它不必挤到最前面。 */}
        <Section
          id={SHORTCUTS_SECTION_ID}
          highlighted={highlighted === SHORTCUTS_SECTION_ID}
          title="键盘快捷键"
          description="按 Ctrl+/ 可以随时跳到这里。下面标了「编辑器」的那一批是编辑器自带的，不是本应用实现的。"
        >
          <ShortcutReference />
        </Section>

        {/* ---------- 应用与离线 ---------- */}
        <Section
          title="应用与离线"
          description="装成桌面应用之后，双击任务栏图标就能打开，不需要先启动任何东西。"
        >
          {!import.meta.env.PROD ? (
            <Notice tone="info">
              开发模式下不注册 Service Worker——否则它会把 vite 的开发产物缓存起来，
              改代码看不到效果，而且很难联想到原因。这一节的信息要
              <code className="mx-1">npm run build</code> 之后用
              <code className="mx-1">npm run serve</code> 打开才准确。
            </Notice>
          ) : sw.support === 'unsupported' ? (
            <Notice tone="warn">
              当前浏览器不支持 Service Worker，断网时打不开。请改用 Edge 或 Chrome。
            </Notice>
          ) : sw.support === 'failed' ? (
            <Notice tone="error">
              Service Worker 注册失败：{sw.error}。
              在线使用不受影响，但断网时打不开这个应用。
            </Notice>
          ) : (
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                    打开方式
                  </dt>
                  <dd className="mt-0.5">
                    {standalone ? '独立窗口（已安装）' : '浏览器标签页'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-500 dark:text-neutral-400">
                    离线可用
                  </dt>
                  <dd className="mt-0.5">
                    {sw.support === 'unknown'
                      ? '正在准备…'
                      : sw.offlineReady
                        ? '已就绪'
                        : '正在准备…'}
                  </dd>
                </div>
              </dl>

              {!standalone ? (
                <Notice tone="info">
                  想装成桌面应用：点浏览器地址栏右侧的「安装」图标（一个带加号的显示器）。
                  装完会有自己的任务栏图标，用 Alt+Tab 就能切过去。
                </Notice>
              ) : null}

              {sw.updateReady ? (
                <Notice tone="warn">
                  有新版本已经下载好了，正在等你确认。
                  <div className="mt-2">
                    <Button size="sm" onClick={() => sw.applyUpdate()}>
                      立即更新并重新打开
                    </Button>
                  </div>
                </Notice>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleCheckUpdate()}
                  disabled={sw.checking}
                >
                  {sw.checking ? '正在检查…' : '检查更新'}
                </Button>
                {checkMessage ? (
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {checkMessage}
                  </span>
                ) : null}
              </div>

              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                因为离线缓存是优先于网络的，<strong className="font-medium">普通刷新不会拿到新版本</strong>
                ——有新版本时必须点上面那个「立即更新」。这是唯一的更新入口。
              </p>

              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                万一离线缓存被清掉了（比如手动清理了浏览器数据），而本地服务器又没开着，
                应用会打不开。<strong className="font-medium">恢复办法</strong>：在项目目录跑一次{' '}
                <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">npm run serve</code>
                ，打开一次之后缓存就回来了。笔记数据不受影响。
              </p>
            </div>
          )}
        </Section>

        {/* ---------- 导出 ---------- */}
        <Section
          title="导出全部数据"
          description="打包成一个 zip，里面是 data.json、每篇笔记的 .md 文件，以及全部图片原图。换电脑、重装浏览器、或者只是想把笔记存到别处，都用它。"
        >
          <Button
            variant="primary"
            onClick={() => void handleExport()}
            disabled={busy.kind !== 'none'}
          >
            {busy.kind === 'export'
              ? busy.total > 0
                ? `正在打包 ${busy.done}/${busy.total}…`
                : '正在读取数据…'
              : '导出为 zip 文件'}
          </Button>

          <div className="mt-3">
            <Notice tone="info">
              导出的 .md 文件用记事本、VS Code、Obsidian 都能直接打开。
              即使以后不用这个 App 了，笔记本身还是普通的 Markdown 文件。
            </Notice>
          </div>
        </Section>

        {/* ---------- 恢复 ---------- */}
        <Section
          title="从备份恢复"
          description="选择一份导出时生成的 zip，或者备份文件夹里的 data.json。"
        >
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            恢复是<strong className="font-medium">覆盖式</strong>的：
            现有的全部科目、章节、笔记和图片都会被删除，换成备份里的内容。
          </div>

          <div className="mt-3">
            <Button
              onClick={() => void handlePickImportFile()}
              disabled={busy.kind !== 'none'}
            >
              {busy.kind === 'import' ? '正在读取备份…' : '选择备份文件…'}
            </Button>
          </div>
        </Section>

        {/* ---------- 自动备份 ---------- */}
        <Section
          title="自动备份到本地文件夹"
          description="指定一个文件夹，App 会把数据写进去：一份「当前状态」的普通文件，外加每天一份 zip 快照（保留 7 天）。指向 OneDrive 同步目录就等于白捡了一个云备份。"
        >
          {backupDisabledReason ? (
            <Notice tone="warn">{backupDisabledReason}</Notice>
          ) : !backup.ready ? (
            <div className="text-sm text-neutral-400">正在读取设置…</div>
          ) : !backup.directoryName ? (
            <div>
              <Button
                variant="primary"
                onClick={() => void backup.chooseDirectory()}
                disabled={backup.running}
              >
                选择备份文件夹…
              </Button>
              <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                建议选一个同步盘的目录（OneDrive、坚果云等），这样即使这台电脑坏了，备份也还在。
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-neutral-500 dark:text-neutral-400">
                    文件夹
                  </span>
                  <code className="rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
                    {backup.directoryName}
                  </code>
                </div>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs',
                    backup.permission === 'granted'
                      ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
                  )}
                >
                  {backup.permission === 'granted' ? '已授权' : '需要重新授权'}
                </span>
              </div>

              {backup.permission !== 'granted' ? (
                <Notice tone="warn">
                  浏览器授权是按会话算的，重新打开 App 之后需要再点一次。
                  <div className="mt-2">
                    <Button
                      size="sm"
                      onClick={() => void backup.grantPermission()}
                      disabled={backup.running}
                    >
                      重新授权并立即备份
                    </Button>
                  </div>
                </Notice>
              ) : null}

              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={backup.autoEnabled}
                  onChange={(event) =>
                    void backup.setAutoEnabled(event.target.checked)
                  }
                  className="mt-0.5 size-4 rounded border-neutral-300 dark:border-neutral-600"
                />
                <span>
                  自动备份
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                    停止编辑 30 秒后自动备份一次。没改动过的内容不会重复写入，
                    所以不用担心它一直读写硬盘。
                  </span>
                </span>
              </label>

              {backup.progress ? (
                <div className="text-sm text-neutral-500 dark:text-neutral-400">
                  {backup.progress.message}
                  {backup.progress.total ? (
                    <span className="ml-2 tabular-nums">
                      {backup.progress.done}/{backup.progress.total}
                    </span>
                  ) : null}
                </div>
              ) : backup.lastResult ? (
                <div className="text-sm text-neutral-500 dark:text-neutral-400">
                  上次备份：{describeBackupResult(backup.lastResult)}
                </div>
              ) : (
                <div className="text-sm text-neutral-500 dark:text-neutral-400">
                  还没有备份过。
                </div>
              )}

              {backup.error ? <Notice tone="error">{backup.error}</Notice> : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void backup.backupNow(true)}
                  disabled={backup.running || backup.permission !== 'granted'}
                >
                  {backup.running ? '正在备份…' : '立即备份'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (
                      window.confirm(
                        `不再自动备份到「${backup.directoryName}」？\n\n文件夹里的备份文件不会被删除，只是 App 不再往里写了。`,
                      )
                    ) {
                      void backup.forgetDirectory()
                    }
                  }}
                  disabled={backup.running}
                >
                  取消使用此文件夹
                </Button>
              </div>
            </div>
          )}
        </Section>

        <Section title="手动备份的注意事项">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-neutral-600 dark:text-neutral-400">
            <li>
              数据只在这台电脑的浏览器里。换浏览器、换电脑、清理浏览器数据，
              笔记都会看不到——这是纯本地方案的代价，所以备份不能省。
            </li>
            <li>
              备份文件夹里，<code className="text-xs">笔记/</code> 和{' '}
              <code className="text-xs">images/</code> 是<strong className="font-medium">只增不删</strong>
              的。在 App 里删掉一篇笔记，文件夹里的 .md 不会被清理，残留文件不影响恢复。
            </li>
            <li>
              自动备份只在 App 开着的时候跑。写完笔记关掉浏览器之前，
              可以到这一页点一下「立即备份」，或者打开「自动备份」让它自己处理。
            </li>
          </ul>
        </Section>
      </div>

      {/* ---------- 恢复确认 ---------- */}
      <Modal
        open={pending !== null}
        title="确认从备份恢复"
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleConfirmImport()}
              disabled={busy.kind !== 'none'}
            >
              {busy.kind === 'import' ? '正在恢复…' : '确认恢复'}
            </Button>
          </>
        }
      >
        {pending ? (
          <div className="space-y-3 text-sm text-neutral-600 dark:text-neutral-400">
            <div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                这份备份包含
              </div>
              <div className="mt-0.5 text-neutral-900 dark:text-neutral-100">
                {describeArchive(pending.backup)}
              </div>
            </div>

            {pending.hasNoImages ? (
              <Notice tone="warn">
                这份备份里没有图片数据（读的是 data.json，而不是 zip 包），
                恢复之后笔记里的图片会显示不出来。想连图片一起恢复，请选
                <code className="mx-1">快照/</code>
                目录里的 zip。
              </Notice>
            ) : pending.missingImages.length > 0 ? (
              <Notice tone="warn">
                有 {pending.missingImages.length} 张图片在备份包里找不到，
                这些图恢复后显示不出来。其余内容不受影响。
              </Notice>
            ) : null}

            {orphanTotal > 0 && integrity ? (
              <Notice tone="warn">
                这份备份的引用关系不完整：{integrity.orphanChapters} 个章节找不到所属科目、
                {integrity.orphanNotes} 篇笔记找不到所属章节、
                {integrity.orphanAttachments} 张图片找不到所属笔记。
                数据仍会照原样恢复，但这些内容可能在界面上看不到。
              </Notice>
            ) : null}

            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              现在的 {currentCounts?.subjects ?? 0} 个科目、
              {currentCounts?.chapters ?? 0} 个章节、
              {currentCounts?.notes ?? 0} 篇笔记、
              {currentCounts?.attachments ?? 0} 张图片、
              {currentCounts?.symbols ?? 0} 个自定义符号会被
              <strong className="font-medium">永久删除</strong>，无法撤销。
            </div>

            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={exportFirst}
                onChange={(event) => setExportFirst(event.target.checked)}
                className="mt-0.5 size-4 rounded border-neutral-300 dark:border-neutral-600"
              />
              <span>
                恢复前先下载一份现有数据
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                  推荐勾选。选错了备份文件的话，这就是唯一的退路。
                </span>
              </span>
            </label>
          </div>
        ) : null}
      </Modal>

      {backup.lastResult ? (
        <p className="mt-8 text-xs text-neutral-400">
          最近一次备份：{formatDateTime(backup.lastResult.at)}
        </p>
      ) : null}
    </div>
  )
}
