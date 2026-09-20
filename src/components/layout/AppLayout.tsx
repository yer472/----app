import { Suspense, useEffect } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { requestPersistentStorage } from '@/db'
import { startBackupOnLaunch, useBackupStore } from '@/store/backupStore'
import { useSwStore } from '@/pwa/swStore'
import { useUiStore } from '@/store/uiStore'
import { Sidebar } from './Sidebar'

/**
 * 更新提示条。
 *
 * 全应用可见，而不是只放在设置页里。理由是「点更新」是这个应用**唯一**的
 * 更新路径——导航请求是缓存优先的，普通刷新永远拿不到新版本。
 * 提示一旦藏在设置页深处，用户就永远不知道服务器上已经有了新版本，
 * 看到的永远是旧界面（这个坑已经真实发生过一次）。
 *
 * 做成布局里的一整行而不是 fixed 浮层：侧栏底部是主题和设置按钮，
 * 浮层会把它压住，而浮层躲开侧栏又要处理侧栏折叠——不值得。
 */
function UpdateBanner() {
  const applyUpdate = useSwStore((s) => s.applyUpdate)

  return (
    <div className="flex shrink-0 items-center justify-center gap-3 border-t border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
      <span>新版本已经下载好了。更新会重新打开应用。</span>
      <Button size="sm" variant="primary" onClick={applyUpdate}>
        立即更新
      </Button>
    </div>
  )
}

export function AppLayout() {
  const hydrated = useUiStore((s) => s.hydrated)
  const hydrate = useUiStore((s) => s.hydrate)
  const initError = useUiStore((s) => s.initError)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const hydrateBackup = useBackupStore((s) => s.hydrate)
  const updateReady = useSwStore((s) => s.updateReady)
  const navigate = useNavigate()

  useEffect(() => {
    void hydrate().then(() => {
      // 备份设置依赖数据库，要等 uiStore 的 hydrate 把连接确认可用之后再读
      void hydrateBackup().then(() => startBackupOnLaunch())
    })
    // 数据安全三层防护的第 1 层：请求持久化存储权限。
    // 放在这里做是因为它需要在用户已经跟页面交互过的上下文里调用，
    // 浏览器更容易批准（而且某些浏览器要求有交互记录）。
    void requestPersistentStorage()
  }, [hydrate, hydrateBackup])

  // Ctrl+K 打开搜索。桌面产品的核心体验优势就是全键盘操作，
  // 这个快捷键也是最容易形成肌肉记忆的一个。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        void navigate('/search')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate])

  // 数据库打不开就直接把原因摆出来，不要给一个能操作但存不了东西的空壳界面
  if (initError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-red-300 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950/40">
          <h1 className="text-base font-semibold text-red-900 dark:text-red-200">
            无法访问本地数据库
          </h1>
          <p className="mt-2 text-sm text-red-800 dark:text-red-300">
            {initError}
          </p>
          <p className="mt-3 text-sm text-red-800 dark:text-red-300">
            笔记数据存在浏览器的 IndexedDB 里。请确认：不是无痕/隐私模式、
            浏览器没有禁用本站的存储权限，然后刷新页面重试。
          </p>
        </div>
      </div>
    )
  }

  // 等设置读完再渲染，避免深色模式闪一下白
  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-400">
        正在启动…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {/* 侧栏和内容并排。外面再包一层列，是为了让更新提示条能占满底部一行，
          而不必用 fixed 浮层去压住侧栏底部 */}
      <div className="flex min-h-0 flex-1">
        {sidebarCollapsed ? null : <Sidebar />}
        <main className="flex-1 overflow-y-auto">
          {/* 笔记页是懒加载的，编辑器那部分代码要等真正打开笔记时才拉下来 */}
          <Suspense
            fallback={
              <div className="px-8 py-16 text-center text-sm text-neutral-400">
                正在加载编辑器…
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>

      {updateReady ? <UpdateBanner /> : null}
    </div>
  )
}
