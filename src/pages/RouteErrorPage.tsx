import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'

/**
 * 根路由的错误页。
 *
 * 没有这一页的时候，任何一个渲染期抛出的错误（`useLiveQuery` 的查询失败会在
 * 渲染期 rethrow，见 `node_modules/dexie-react-hooks/src/useObservable.ts`）
 * 都会落到 react-router 自带的错误界面：**英文标题 + 完整堆栈**，
 * 而这是全中文的笔记本应用。
 *
 * 它管的是**外壳**（AppLayout / Sidebar）的失败，所以做成整页、没有侧栏。
 * 内容区的失败由 `SectionBoundary` 接住，侧栏会留着——两者的分工写在那个文件里。
 *
 * 「重试」在这里写的是**重新加载**：router 的错误边界只在 location 变化时
 * 清错误，从 errorElement 里没法原地重试。真正的原地重试在 SectionBoundary 里。
 */
export function RouteErrorPage() {
  const error = useRouteError()
  const navigate = useNavigate()

  const isResponse = isRouteErrorResponse(error)

  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <ErrorState
        className="w-full max-w-2xl"
        title={
          isResponse
            ? `这个地址打不开（${error.status} ${error.statusText}）`
            : '应用出错了'
        }
        // 路由级的响应错误没有 Error 对象，只有状态码，别硬塞进 error 里
        error={isResponse ? undefined : error}
        advice={
          isResponse
            ? '地址可能输错了，或者这个页面已经不存在。回到科目列表重新找一下。'
            : undefined
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新加载
          </Button>
          <Button variant="secondary" onClick={() => void navigate('/')}>
            回到科目列表
          </Button>
        </div>
      </ErrorState>
    </div>
  )
}
