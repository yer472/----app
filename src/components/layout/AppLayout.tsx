import { Suspense, useEffect } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { requestPersistentStorage } from '@/db'
import { startBackupOnLaunch, useBackupStore } from '@/store/backupStore'
import { useUiStore } from '@/store/uiStore'
import { Sidebar } from './Sidebar'

export function AppLayout() {
  const hydrated = useUiStore((s) => s.hydrated)
  const hydrate = useUiStore((s) => s.hydrate)
  const initError = useUiStore((s) => s.initError)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const hydrateBackup = useBackupStore((s) => s.hydrate)
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
    <div className="flex h-full bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
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
  )
}
