import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { errorMessage } from './errors'

/**
 * 列表的拖拽排序 + 键盘排序。
 *
 * ## 为什么是指针事件，不是 HTML5 原生拖放
 *
 * 决定性的理由不是手感，是**哪条路能自检**：CDP 驱动原生拖放要用
 * `Input.dispatchDragEvent`（还得先 `Input.setInterceptDrags`），它模拟的是
 * 「拖放协议」而不是真实的指针手势，页面里 `dragstart` 拿到的 dataTransfer
 * 和真人操作并不一样——用这种方式写出来的排序断言，正是这个项目里反复
 * 出现的那种「跑了没报错」的假绿。而指针事件走 `Input.dispatchMouseEvent`，
 * 和画板里画一笔（`verify-board.mjs` 的 `stroke()`）是完全同一条路径，
 * 已经被证明在这个仓库里跑得通、断言得住。
 *
 * ## 位置判定：实时换位，不算「插入点」
 *
 * 拖动中每次指针移动，都取「指针到各项中心距离」最小的那一项当作目标槽位，
 * 把被拖的项直接插进去、立刻重渲染。**不画插入指示线**，因为位置本身就是反馈，
 * 而且这样对两列网格（首页的科目是 `grid sm:grid-cols-2`）天然成立——
 * 「插到这一格的左边还是右边」在两列网格里没有公认答案，换位则不需要回答它；
 * 断点上下布局变了也不用改任何逻辑。
 *
 * 抖动问题不存在：因为我们**真的改变了顺序**，被拖的项下一帧就占住了新槽位，
 * 几何是自洽的，最小值是个稳定点。
 *
 * ## 和 DOM 的约定
 *
 * 测量靠 DOM，所以有两条约定的属性：
 *   - 每一项的最外层元素挂 `data-reorder-id={id}`
 *   - 拖拽手柄由 `handleProps(id)` 提供（它自己会带上 `data-reorder-handle`）
 *
 * ⚠️ 测量是**按整个文档**查 `[data-reorder-id]` 的，所以同一页上只能有一个
 * 可排序列表。以后真要在同一页放两个，得给容器加个 id 前缀再限定查询范围。
 *
 * ## 待落库期间不回到旧顺序
 *
 * `commit()` 写库之后 liveQuery 会重跑，列表数据换成新数组。如果在提交前就把
 * 乐观顺序清掉，用户会看到列表**先跳回旧顺序、再跳到新顺序**——功能是对的，
 * 看起来是坏的。所以乐观顺序一直生效到数据库回来的顺序和它一致为止。
 */
export interface ReorderApi {
  /** 当前应该显示的顺序。可能是调用方传进来的那份（只读） */
  order: readonly string[]
  /** 正在被拖动的那一项；没有就是 null */
  draggingId: string | null
  /**
   * 拖拽手柄要展开的 props。
   *
   * 只有 `onPointerDown`——移动和松手是挂在 window 上的原生监听器，
   * 原因见 `handleProps` 里的注释（指针捕获会被 DOM 重排弄丢）。
   */
  handleProps: (id: string) => {
    'data-reorder-handle': string
    className: string
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  }
  /** 键盘上移 / 下移。焦点会回到同一个手柄上，所以可以连按 */
  move: (id: string, delta: -1 | 1) => void
  canMove: (id: string, delta: -1 | 1) => boolean
  /** 提交失败的原因，页面拿去显示 */
  error: string | null
  clearError: () => void
}

/**
 * 把「上移 / 下移」的快捷键落到**焦点所在的那一项**上。
 *
 * 为什么不把方向也交给快捷键层：`Binding.run` 的类型是 `() => void`，
 * **不带事件**（`lib/shortcuts/useShortcuts.ts`），处理器看不出这次是按了
 * 上还是下。所以方向在注册绑定时就写死，哪一项则从焦点读——手柄是个
 * 真正的 `<button>`，Tab 得到、点击也拿得到焦点。
 */
export function moveFocusedItem(reorder: ReorderApi, delta: -1 | 1): void {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return
  const id = active.closest<HTMLElement>('[data-reorder-id]')?.dataset.reorderId
  if (id) reorder.move(id, delta)
}

/** 松手位置离列表太远（超过这么多像素）就当作取消，顺序还原 */
const DROP_MARGIN = 24

const HANDLE_CLASS = 'cursor-grab touch-none select-none active:cursor-grabbing'

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function useReorder(
  ids: readonly string[],
  commit: (orderedIds: string[]) => Promise<void>,
): ReorderApi {
  const [pending, setPending] = useState<string[] | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const draggingRef = useRef<string | null>(null)
  /** 按下时（还没真正移动）的顺序，用于「拖到列表外」时还原 */
  const orderAtStartRef = useRef<string[]>([])

  // 数据库回来的顺序和乐观顺序对上了，才把乐观顺序让出去。
  // 用「渲染期调整」而不是 useEffect：这是个纯派生（props 追上了内部状态），
  // 在 effect 里 setState 会白跑一轮渲染
  if (pending && sameOrder(ids, pending)) setPending(null)

  const order = pending ?? ids

  const apply = useCallback((next: string[] | null) => {
    setPending(next)
    // 顺序变了就顺手把被拖的那一项滚进视野。用浏览器自己的 scrollIntoView
    // 而不是自己算滚动位置：滚动容器是 AppLayout 里那个 <main>，不是 window，
    // 自己算要引入第二份滚动状态
    const id = draggingRef.current
    if (!id) return
    document
      .querySelector(`[data-reorder-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [])

  /** 指针当前离哪一项最近。拖出列表外时返回 null */
  const slotAt = useCallback((x: number, y: number): number | null => {
    const items = [...document.querySelectorAll('[data-reorder-id]')]
    if (items.length === 0) return null

    let nearest = -1
    let nearestDistance = Number.POSITIVE_INFINITY
    let outsideAll = true

    items.forEach((element, index) => {
      const rect = element.getBoundingClientRect()
      const inside =
        x >= rect.left - DROP_MARGIN &&
        x <= rect.right + DROP_MARGIN &&
        y >= rect.top - DROP_MARGIN &&
        y <= rect.bottom + DROP_MARGIN
      if (inside) outsideAll = false

      const dx = x - (rect.left + rect.width / 2)
      const dy = y - (rect.top + rect.height / 2)
      const distance = dx * dx + dy * dy
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = index
      }
    })

    return outsideAll ? null : nearest
  }, [])

  /*
   * 拖动中的移动和松手挂在 window 上。
   *
   * **不能用 `setPointerCapture`**：换位是实时的，每移动一次 React 就重排
   * 一次 DOM，而被拖的那一项是真的被挪走了——元素一被移动，浏览器就释放
   * 指针捕获，之后 pointermove 和 pointerup 全都收不到。表现是「拖到一半
   * 就断了、松手也不提交，界面上停在一个没落库的顺序上」。
   * 这个 bug 是自检脚本抓出来的：先断言了手柄收得到指针事件，才分得清
   * 是「事件没送到」而不是「送到了但逻辑没跑」。
   *
   * 挂在 effect 里（而不是按下时才装）是为了拿到每帧最新的 `pending`：
   * 一次 pointermove 之后 pending 就变了，而 effect 会在下一次事件之前
   * 重新注册，所以监听器读到的永远是当前顺序。用 ref 转手也能做到，
   * 但那要在渲染期写 ref，lint 会（有道理地）拦。
   *
   * StrictMode 下这个 effect 会装—卸—再装，但 cleanup 把三个监听器都摘了，
   * 所以最终只有一个生效的。
   */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const dragged = draggingRef.current
      if (!dragged) return

      const slot = slotAt(event.clientX, event.clientY)
      if (slot === null) return

      const from = order.indexOf(dragged)
      if (from < 0) return
      // 语义是「被拖的项**占住**指针下的那个槽位」，所以目标下标就是 slot，
      // 不需要为「摘掉自己」做任何加减。第一版写成 `slot > from ? slot - 1 : slot`，
      // 那是「插到这一项前面」的语义——结果是把一项往列表末尾拖时，
      // 指针压到最后一项上算出 target === from，往后就再也走不动了，
      // 表现是「只能挪一格」。
      if (slot === from) return

      const next = [...order]
      next.splice(from, 1)
      next.splice(slot, 0, dragged)
      apply(next)
    }

    const onUp = (event: PointerEvent) => {
      const dragged = draggingRef.current
      if (!dragged) return
      draggingRef.current = null
      setDraggingId(null)

      // 在列表外松手 = 取消。不还原的话，「拖出去扔掉」会变成「挪到最近的一项」
      if (slotAt(event.clientX, event.clientY) === null) {
        apply(null)
        return
      }
      if (sameOrder(order, orderAtStartRef.current)) {
        apply(null)
        return
      }
      commit([...order]).catch((e: unknown) => {
        setError(errorMessage(e))
        apply(null)
      })
    }

    const onCancel = () => {
      if (!draggingRef.current) return
      draggingRef.current = null
      setDraggingId(null)
      apply(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [apply, commit, order, slotAt])

  const handleProps = useCallback(
    (id: string) => ({
      'data-reorder-handle': id,
      className: HANDLE_CLASS,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return
        // 不 preventDefault：那会连按钮的焦点一起吃掉，键盘上移/下移就没法用了。
        // 挡住文本选择靠 select-none / touch-none 两个类。
        // 显式给焦点，这样「拖过之后接着按 Alt+↓」是通的
        event.currentTarget.focus()
        draggingRef.current = id
        orderAtStartRef.current = [...order]
        setDraggingId(id)
        apply([...order])
      },
    }),
    [apply, order],
  )

  const canMove = useCallback(
    (id: string, delta: -1 | 1) => {
      const index = order.indexOf(id)
      if (index < 0) return false
      const target = index + delta
      return target >= 0 && target < order.length
    },
    [order],
  )

  const move = useCallback(
    (id: string, delta: -1 | 1) => {
      const index = order.indexOf(id)
      const target = index + delta
      if (index < 0 || target < 0 || target >= order.length) return

      const next = [...order]
      next.splice(index, 1)
      next.splice(target, 0, id)
      apply(next)

      // 焦点还给同一个手柄。React 按 key 复用节点、重排后 DOM 节点是同一个，
      // 所以多数情况下焦点本来就在；但「按一下只走一步」是这个功能最容易坏的
      // 形态（第二次按下去，快捷键层从 activeElement 上找不到那一项），
      // 所以显式要一次，不依赖复用行为
      document
        .querySelector<HTMLElement>(`[data-reorder-handle="${CSS.escape(id)}"]`)
        ?.focus()

      commit(next).catch((e: unknown) => {
        setError(errorMessage(e))
        apply(null)
      })
    },
    [apply, commit, order],
  )

  const clearError = useCallback(() => setError(null), [])

  return { order, draggingId, handleProps, move, canMove, error, clearError }
}
