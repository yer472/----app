import { useCallback, useRef, useState } from 'react'
import type { Scene } from './scene'

/**
 * 场景的撤销 / 重做。
 *
 * 撤销栈里存的是整个场景的快照。scene.ts 里的编辑函数全部返回新对象、
 * 不原地改，所以快照不会被后续编辑污染，这里不需要深拷贝。
 */

/** 撤销栈深度。图纸数据很小，50 步足够用，也不会吃内存 */
const MAX_HISTORY = 50

export interface SceneHistory {
  scene: Scene
  /**
   * 更新画面但**不**记历史。拖拽过程中调这个。
   *
   * 拖拽必须和提交分开：一次拖拽会产生几百个 pointermove，
   * 如果每一帧都进撤销栈，撤销一次只退一个像素，等于撤销坏了。
   */
  setLive: (next: Scene) => void
  /** 记一步历史。松手、画完一个图元、删除时调 */
  commit: (next: Scene) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  /** 载入另一个场景（打开已有的图），清空历史 */
  reset: (scene: Scene) => void
}

export function useSceneHistory(
  initial: Scene | (() => Scene),
): SceneHistory {
  const [scene, setScene] = useState(initial)

  // 历史用 ref 而不是 state：撤销和重做要读栈顶、又要同时改 scene 和另一个栈，
  // 写成 setState 的嵌套更新会在开发模式的双调用下重复执行
  // （React 会调两次 updater 函数），重做栈就会被塞进重复项。
  // ref 是同步的、不受双调用影响，再用两个布尔 state 驱动按钮的禁用态。
  const pastRef = useRef<Scene[]>([])
  const futureRef = useRef<Scene[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  // 最后一次「提交」过的场景。
  // 拖拽期间 setLive 会改 scene 但不改这个，于是松手时 commit 推进历史的
  // 是拖拽开始前的状态，而不是拖拽过程中的某一帧。
  // 用 scene 而不是 initial 赋值：initial 可能是个函数，useState 已经解过一次了
  const committedRef = useRef(scene)

  const syncFlags = useCallback(() => {
    setCanUndo(pastRef.current.length > 0)
    setCanRedo(futureRef.current.length > 0)
  }, [])

  const setLive = useCallback((next: Scene) => {
    setScene(next)
  }, [])

  const commit = useCallback(
    (next: Scene) => {
      pastRef.current = [...pastRef.current, committedRef.current].slice(
        -MAX_HISTORY,
      )
      // 提交新的一步意味着「重做」那条分支作废
      futureRef.current = []
      committedRef.current = next
      setScene(next)
      syncFlags()
    },
    [syncFlags],
  )

  const undo = useCallback(() => {
    const before = pastRef.current.pop()
    if (!before) return
    futureRef.current = [committedRef.current, ...futureRef.current]
    committedRef.current = before
    setScene(before)
    syncFlags()
  }, [syncFlags])

  const redo = useCallback(() => {
    const next = futureRef.current.shift()
    if (!next) return
    pastRef.current = [...pastRef.current, committedRef.current]
    committedRef.current = next
    setScene(next)
    syncFlags()
  }, [syncFlags])

  const reset = useCallback(
    (next: Scene) => {
      pastRef.current = []
      futureRef.current = []
      committedRef.current = next
      setScene(next)
      syncFlags()
    },
    [syncFlags],
  )

  return {
    scene,
    setLive,
    commit,
    undo,
    redo,
    canUndo,
    canRedo,
    reset,
  }
}
