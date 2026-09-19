import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <EmptyState
        title="页面不存在"
        description="地址可能输错了，或者这个页面已经不存在。"
        action={
          <Link to="/">
            <Button variant="primary">回到科目列表</Button>
          </Link>
        }
      />
    </div>
  )
}
