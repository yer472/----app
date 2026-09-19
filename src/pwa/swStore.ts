import { create } from 'zustand'

/**
 * Service Worker 的状态，给设置页用。
 *
 * 这里只存「展示需要知道的东西」，真正的注册逻辑在 ./register.ts。
 *
 * 有一个状态必须让用户看得见，就是 updateReady：
 * 因为导航请求是缓存优先的，**普通刷新永远拿不到新版本**——
 * 点了「更新」是唯一的更新路径。所以这个提示不能当成可有可无的锦上添花。
 */

/** 模块级持有，不进 store：registration 是个活对象，塞进 state 会引来无谓的重渲染 */
let registration: ServiceWorkerRegistration | null = null

export type SwSupport = 'unknown' | 'unsupported' | 'registered' | 'failed'

/** 检查更新的三种结果，设置页要按结果说不同的话 */
export type CheckResult = 'updated' | 'current' | 'unreachable'

interface SwState {
  support: SwSupport
  /** 已经有一份完整的离线缓存了（装完就能断网打开） */
  offlineReady: boolean
  /** 装好了新版本，正在等待用户同意后接管 */
  updateReady: boolean
  /** 正在检查更新，用来禁用按钮 */
  checking: boolean
  /**
   * 用户点过「更新」。
   *
   * register.ts 的 controllerchange 监听靠它决定要不要重载页面。
   * 不能只看 controllerchange 就重载——那个事件在某些时序下会意外触发，
   * 而重载一次的代价是页面状态全丢。只在用户明确要求时才重载。
   */
  updateRequested: boolean
  /** 注册失败的原因。非 null 时离线能力不可用，但在线使用不受影响 */
  error: string | null

  attach: (reg: ServiceWorkerRegistration) => void
  setUnsupported: () => void
  setFailed: (message: string) => void
  applyUpdate: () => void
  checkForUpdate: () => Promise<CheckResult>
}

export const useSwStore = create<SwState>((set) => ({
  support: 'unknown',
  offlineReady: false,
  updateReady: false,
  checking: false,
  updateRequested: false,
  error: null,

  attach: (reg) => {
    registration = reg

    const sync = () => {
      set({
        support: 'registered',
        error: null,
        // 有 active worker 就意味着缓存是完整的：
        // worker 只有在 install（含预缓存）成功之后才会变成 active
        offlineReady: Boolean(reg.active),
        updateReady: Boolean(reg.waiting),
      })
    }
    sync()

    // 新版本开始安装
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        // 变成了 installed 而页面已经被旧 SW 控制着，说明这是「新版本在等待」，
        // 而不是首次安装。首次安装时 controller 是 null。
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          set({ updateReady: true })
        }
        if (installing.state === 'activated') sync()
      })
    })
  },

  setUnsupported: () => set({ support: 'unsupported' }),

  setFailed: (message) => set({ support: 'failed', error: message }),

  applyUpdate: () => {
    const waiting = registration?.waiting
    if (!waiting) return
    set({ updateRequested: true })
    // 通知 SW 跳过等待。它会进入 activate，清掉旧缓存，
    // 触发 controllerchange，register.ts 那边的监听负责重载页面。
    waiting.postMessage({ type: 'XXBJ_SKIP_WAITING' })
  },

  checkForUpdate: async () => {
    if (!registration) return 'unreachable'
    set({ checking: true })
    try {
      await registration.update()
      const updated = Boolean(registration.waiting)
      if (updated) set({ updateReady: true })
      return updated ? 'updated' : 'current'
    } catch {
      // 服务器没开的时候更新检查必然失败。这不是错误，
      // 而是这个应用「平时不用开服务器」的正常状态——要说清楚，
      // 否则用户会以为按钮坏了。
      return 'unreachable'
    } finally {
      set({ checking: false })
    }
  },
}))
