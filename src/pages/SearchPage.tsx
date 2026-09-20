import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/time'
import { entryOf } from '@/lib/shortcuts/catalog'
import { matchesBinding } from '@/lib/shortcuts/matcher'
import { SearchRepository, splitByKeyword, SubjectRepository } from '@/repository'

/** 输入停止多久之后才真正去查。搜索是同步全表扫描，不能每敲一个字跑一遍。 */
const DEBOUNCE_MS = 250

function Highlight({
  text,
  keyword,
}: {
  text: string
  keyword: string
}) {
  const parts = useMemo(() => splitByKeyword(text, keyword), [text, keyword])
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark
            key={index}
            className="rounded-sm bg-amber-200/80 text-inherit dark:bg-amber-500/30"
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const urlQuery = params.get('q') ?? ''

  const [input, setInput] = useState(urlQuery)
  const [query, setQuery] = useState(urlQuery)
  const [subjectIds, setSubjectIds] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // 搜索是同步扫描，输入框必须自己先动起来，查询晚一点跟上
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [input])

  // 把关键词写进地址栏，方便刷新和收藏；用 replace 免得每敲一个字压一条历史
  useEffect(() => {
    const current = params.get('q') ?? ''
    if (current === query) return
    const next = new URLSearchParams(params)
    if (query) next.set('q', query)
    else next.delete('q')
    setParams(next, { replace: true })
  }, [query, params, setParams])

  // 页面已经打开时再按一次 Ctrl+K，也应该回到搜索框。
  //
  // 这里和 AppLayout 的全局绑定是**两个监听器**，都在冒泡阶段、都处理 Ctrl+K：
  // 全局那个看到已经在 /search 就什么都不做，剩下重新聚焦这件事归这里。
  // 两者靠注册顺序（AppLayout 先挂）决定谁先跑，所以**不要**把这里改成
  // 捕获阶段或加 stopPropagation——那会让全局那个收不到事件。
  // 组合键从目录里查，免得两边写岔。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!entryOf('search').keys.some((combo) => matchesBinding(event, combo))) {
        return
      }
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const subjects = useLiveQuery(() => SubjectRepository.list(), [])
  const subjectKey = subjectIds.join(',')

  const hits = useLiveQuery(
    () =>
      query
        ? SearchRepository.search(query, {
            subjectIds: subjectKey ? subjectKey.split(',') : undefined,
          })
        : Promise.resolve([]),
    [query, subjectKey],
  )

  const searchableCount = useLiveQuery(
    () => SearchRepository.searchableCount(),
    [],
  )

  const toggleSubject = (id: string) => {
    setSubjectIds((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id],
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <div className="relative">
        <span
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-neutral-400"
          aria-hidden
        >
          ⌕
        </span>
        <input
          ref={inputRef}
          autoFocus
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="搜索所有笔记的标题和正文…"
          aria-label="搜索笔记"
          className={cn(
            'h-11 w-full rounded-lg border border-neutral-300 bg-white pr-3 pl-10 text-sm',
            'placeholder:text-neutral-400',
            'focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none',
            'dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100',
          )}
        />
      </div>

      {subjects && subjects.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-neutral-400">范围</span>
          {subjects.map((subject) => {
            const active = subjectIds.includes(subject.id)
            return (
              <button
                key={subject.id}
                type="button"
                onClick={() => toggleSubject(subject.id)}
                aria-pressed={active}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-500/15 dark:text-blue-300'
                    : 'border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800',
                )}
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: subject.color }}
                  aria-hidden
                />
                {subject.name}
              </button>
            )
          })}
          {subjectIds.length > 0 ? (
            <button
              type="button"
              onClick={() => setSubjectIds([])}
              className="ml-1 text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
            >
              清除
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6">
        {!query ? (
          <EmptyState
            icon="⌕"
            title="输入关键词开始搜索"
            description={
              searchableCount
                ? `会在全部 ${searchableCount} 篇笔记的标题和正文里查找。按 Ctrl+K 可以随时回到这里。`
                : '会在所有笔记的标题和正文里查找。'
            }
          />
        ) : hits === undefined ? (
          <div className="py-10 text-center text-sm text-neutral-400">
            正在搜索…
          </div>
        ) : hits.length === 0 ? (
          <EmptyState
            icon="⌕"
            title={`没有找到「${query}」`}
            description={
              subjectIds.length > 0
                ? '当前限定了科目范围，试试清除筛选后再搜。搜索的是笔记标题和正文，图片里的文字不会参与匹配。'
                : '搜索的是笔记标题和正文，图片里的文字不会参与匹配。换个词，或者只输入关键词的一部分试试。'
            }
          />
        ) : (
          <>
            <div className="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
              共 {hits.length} 条结果
              {subjectIds.length > 0 ? '（已限定科目）' : ''}
            </div>
            <ul className="space-y-1.5">
              {hits.map((hit) => (
                <li key={hit.note.id}>
                  <Link
                    to={`/subjects/${hit.subjectId}/chapters/${hit.chapterId}/notes/${hit.note.id}`}
                    className={cn(
                      'block rounded-lg border border-neutral-200 px-4 py-3 transition-colors',
                      'hover:border-neutral-300 hover:bg-neutral-50',
                      'dark:border-neutral-800 dark:hover:border-neutral-700 dark:hover:bg-neutral-800/50',
                    )}
                  >
                    <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: hit.subjectColor }}
                        aria-hidden
                      />
                      <span className="truncate">{hit.subjectName}</span>
                      <span aria-hidden>›</span>
                      <span className="truncate">{hit.chapterName}</span>
                      <span className="ml-auto shrink-0 tabular-nums">
                        {formatRelative(hit.note.updatedAt)}
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-center gap-2">
                      {hit.note.isPinned ? (
                        <span
                          className="shrink-0 text-xs text-amber-500"
                          title="已置顶"
                          aria-label="已置顶"
                        >
                          ★
                        </span>
                      ) : null}
                      <h2 className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        <Highlight text={hit.note.title} keyword={query} />
                      </h2>
                    </div>

                    <p className="mt-1 line-clamp-2 text-sm text-neutral-600 dark:text-neutral-400">
                      {hit.snippetPrefix}
                      <Highlight text={hit.snippet} keyword={query} />
                      {hit.snippetSuffix}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
