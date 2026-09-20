import { Fragment } from 'react'
import { cn } from '@/lib/cn'
import type { CustomSymbol } from '@/types/models'
import { INK_COLOR, STROKE_WIDTH, partToReact } from './render'
import {
  SYMBOL_GROUPS,
  builtInSymbols,
  partsBounds,
  type LinkSymbolDef,
  type Part,
  type PointSymbolDef,
} from './symbols'

/**
 * 画板左侧的符号面板。
 *
 * 分两段：**标准符号**（GB/T 4460 那批，代码里写死）和**我的符号**
 * （自己画的，存在库里）。分开是刻意的——自己画的东西和标准件混在一列里，
 * 找起来会越来越费劲。
 *
 * 缩略图和放到画布上的图形走的是**同一份 `Part`**（`partToReact`），
 * 所以图标不可能和放下去的东西长得不一样。这也是这个项目第一次用
 * 真正的矢量图形当图标（此前都是 `⌕ ◐ ⚙ ◎` 那类 Unicode 字符）。
 */

/** 缩略图的边长（像素）。线宽要按它和 viewBox 的比例乘回来 */
const THUMB_PX = 34

/** 两点符号的缩略图按这个长度画。取一个中等的值，免得带传动看起来像两个巨轮 */
const PREVIEW_LENGTH = 150

interface SymbolPanelProps {
  /** 当前上膛的符号 ref。null 表示没在上膛 */
  armed: string | null
  onArm: (ref: string) => void
  customs: readonly CustomSymbol[]
  onNewCustom: () => void
  onEditCustom: (symbol: CustomSymbol) => void
  onDeleteCustom: (symbol: CustomSymbol) => void
  /** 自定义符号的定义（由 DrawBoard 从 CustomSymbol 推出来）。缩略图要用 */
  customDefs: Record<string, PointSymbolDef>
}

export function SymbolPanel({
  armed,
  onArm,
  customs,
  onNewCustom,
  onEditCustom,
  onDeleteCustom,
  customDefs,
}: SymbolPanelProps) {
  return (
    <aside
      // 自检脚本靠它找这一栏。用属性而不是 `aside`：应用自己的侧栏也是
      // aside，而画板打开时那个还在 DOM 里
      data-symbol-panel
      className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div className="px-3 py-2 text-xs font-semibold tracking-wide text-neutral-400 dark:text-neutral-500">
        符号
      </div>

      <div className="px-3 pb-1 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
        标准符号
      </div>
      {SYMBOL_GROUPS.map((group) => {
        const defs = builtInSymbols(group.id)
        if (defs.length === 0) return null
        return (
          <div key={group.id} className="px-3 pb-2">
            <div className="pb-1 text-[11px] text-neutral-400 dark:text-neutral-500">
              {group.title}
            </div>
            <div className="grid grid-cols-3 gap-1">
              {defs.map((def) => (
                <SymbolButton
                  key={def.id}
                  label={def.name}
                  parts={'parts' in def ? [...def.parts] : def.partsFor(PREVIEW_LENGTH)}
                  active={armed === def.id}
                  onClick={() => onArm(def.id)}
                />
              ))}
            </div>
          </div>
        )
      })}

      <div className="mt-1 flex items-center justify-between border-t border-neutral-200 px-3 pt-2 pb-1 dark:border-neutral-800">
        <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
          我的符号
        </span>
        <button
          type="button"
          onClick={onNewCustom}
          title="画一个新符号"
          className="rounded px-1.5 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
        >
          ＋ 新建
        </button>
      </div>

      {customs.length === 0 ? (
        <p className="px-3 pb-3 text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          还没有。点「新建」画一个——比如你们课本上那种特别的支座，
          画一次以后就能反复用。
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-1 px-3 pb-3">
          {customs.map((symbol) => {
            const def = customDefs[symbol.id]
            return (
              <SymbolButton
                key={symbol.id}
                label={symbol.name}
                parts={def ? [...def.parts] : []}
                active={armed === symbol.id}
                onClick={() => onArm(symbol.id)}
                onEdit={() => onEditCustom(symbol)}
                onDelete={() => onDeleteCustom(symbol)}
              />
            )
          })}
        </div>
      )}
    </aside>
  )
}

function SymbolButton({
  label,
  parts,
  active,
  onClick,
  onEdit,
  onDelete,
}: {
  label: string
  parts: Part[]
  active: boolean
  onClick: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  const bounds = partsBounds(parts)
  // viewBox 把 bounds.w 个单位压进 THUMB_PX 个像素，线宽要按这个比例乘回来，
  // 否则 3 单位的线在这里只剩不到 1px，什么也看不出来
  const unitsPerPx = Math.max(bounds.w, bounds.h) / THUMB_PX
  const widthScale = (1.6 * unitsPerPx) / STROKE_WIDTH

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-pressed={active}
        className={cn(
          'flex w-full flex-col items-center gap-0.5 rounded-md border p-1 transition-colors',
          active
            ? 'border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40'
            : 'border-transparent hover:border-neutral-200 hover:bg-neutral-50 dark:hover:border-neutral-700 dark:hover:bg-neutral-800',
        )}
      >
        <svg
          viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
          width={THUMB_PX}
          height={THUMB_PX}
          aria-hidden
        >
          <g
            fill="none"
            stroke={INK_COLOR}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {parts.map((part, index) => (
              <Fragment key={index}>
                {partToReact(part, { widthScale })}
              </Fragment>
            ))}
          </g>
        </svg>
        <span className="w-full truncate text-center text-[10px] leading-tight text-neutral-500 dark:text-neutral-400">
          {label}
        </span>
      </button>

      {/* 自定义符号才有改名/删除。悬停才出现，不占地方 */}
      {onEdit || onDelete ? (
        <div className="absolute top-0 right-0 hidden gap-0.5 group-hover:flex">
          {onEdit ? (
            <button
              type="button"
              onClick={onEdit}
              title="改名 / 改图形"
              className="rounded bg-white/90 px-1 text-[10px] text-neutral-500 shadow-sm hover:text-blue-600 dark:bg-neutral-800/90 dark:text-neutral-400"
            >
              ✎
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              title="删除这个符号"
              className="rounded bg-white/90 px-1 text-[10px] text-neutral-500 shadow-sm hover:text-red-600 dark:bg-neutral-800/90 dark:text-neutral-400"
            >
              ✕
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 给外部（DrawBoard）用的类型收口，避免它直接依赖 symbols.ts 的细节 */
export type { LinkSymbolDef, PointSymbolDef }
