import { useSwStore } from './swStore'

/**
 * 注册 Service Worker。
 *
 * 从 src/main.tsx 调用一次，不放 AppLayout 的 effect 里：
 * AppLayout 那个 effect 和数据层纠缠在一起，前面还有三个 early return，
 * 而 SW 注册应该无论数据库能不能打开都要发生
 * （隐私模式下数据库打不开，但没理由因此丢掉离线能力）。
 */

/** 必须和 scripts/serve.mjs 里的文件位置一致：在 dist 根目录，scope 才是 / */
const SW_URL = '/sw.js'

export function registerServiceWorker(): void {
  // 开发服务器上绝对不能注册 SW：它会缓存 vite dev 的模块图和 HMR 产物，
  // 之后改代码看不到效果，而且很难联想到原因是 Service Worker。
  // dev 环境下 import.meta.env.PROD 是 false。
  if (!import.meta.env.PROD) return

  if (!('serviceWorker' in navigator)) {
    useSwStore.getState().setUnsupported()
    return
  }

  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 只有用户点过「更新」才重载。
    // 只认 controllerchange 是不够的——它在别的时序下也可能触发，
    // 而一次多余的重载会让用户丢掉正在编辑的内容。
    if (!useSwStore.getState().updateRequested) return
    if (reloading) return
    reloading = true
    location.reload()
  })

  // 等 load 之后再注册。预缓存有一百多个请求，虽然都跑在 SW 线程里，
  // 但推迟到首屏画完之后没有任何代价（本机回环），却能避开和渲染抢资源。
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(SW_URL, {
        scope: '/',
        // Chromium 的默认值。sw.js 本身每次都从网络取（绕过 HTTP 缓存），
        // 所以重新构建之后下次导航就能发现新版本；
        // 服务器没开时更新检查静默失败，已有注册继续工作。
        updateViaCache: 'imports',
      })
      .then((registration) => {
        useSwStore.getState().attach(registration)
      })
      .catch((error: unknown) => {
        // 隐私模式、企业策略、非安全上下文都会走到这里。
        // 注册失败不影响在线使用，但要在设置页如实说明「离线不可用」。
        useSwStore
          .getState()
          .setFailed(error instanceof Error ? error.message : String(error))
      })
  })
}
