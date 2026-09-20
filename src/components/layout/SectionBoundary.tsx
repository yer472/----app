import { Component, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'

/**
 * 只包住内容区（`<Outlet />`）的错误边界。
 *
 * 为什么它不是「多加一层保险」，而是和 router 的 `errorElement` 各管一段：
 *
 * 错误边界**只接子树抛的错**。`Sidebar` 自己有一个 `useLiveQuery`
 * （`SubjectRepository.list()`），它是 `<Outlet />` 的**兄弟**，它抛错会绕开
 * 这一层直接冒到 router，正好落在根路由的 `errorElement` 上。反过来，
 * 某个页面自己的查询坏掉时，被这一层接住——**侧栏和导航都还在**，
 * 用户可以直接去别的页面，而不是被一个整页错误挡住。
 *
 * 所以分工是：内容区崩了外壳还在（这里），外壳崩了整页兜底（`errorElement`）。
 *
 * 另一个不用自己写的收益：笔记页是懒加载的，分片拉不下来（离线缓存被清）
 * 原来会是一整片白，现在会落到这里变成一个能读懂的中文提示。
 *
 * **重试是真的原地重试**：React 接住错误时会把失败的子树卸载掉，
 * 所以把 error 清回 null 就是「重新挂载 + 重新订阅 liveQuery」。
 * router 的 `errorElement` 做不到这一点（它只在 location 变化时清错误），
 * 所以那边的按钮写的是「重新加载」而不是「重试」——两者不要混。
 */
interface SectionBoundaryProps {
  children: ReactNode
}

interface SectionBoundaryState {
  error: unknown
}

export class SectionBoundary extends Component<
  SectionBoundaryProps,
  SectionBoundaryState
> {
  state: SectionBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): SectionBoundaryState {
    return { error }
  }

  // 不在这里 console.error：React 自己会把接住的错误连同组件栈打出来，
  // 再打一遍只是噪声（而自检脚本里那些「故意制造错误」的用例还要多过滤一条）。

  render() {
    if (this.state.error === null) return this.props.children

    return (
      <div className="mx-auto max-w-2xl px-8 py-12">
        <ErrorState title="这个页面出错了" error={this.state.error}>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => this.setState({ error: null })}
            >
              重试
            </Button>
            <Link to="/">
              <Button variant="secondary">回到科目列表</Button>
            </Link>
          </div>
        </ErrorState>
      </div>
    )
  }
}
