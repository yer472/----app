import { cn } from '@/lib/cn'

/**
 * 「正在加载」那一行灰字。
 *
 * 之前这句话在每个页面手写了十几遍，一半写了 dark 变体、一半没写。
 * 收成一个组件之后不会再漂。
 *
 * ⚠️ 关于那半个变体的取舍，量过再说，别凭直觉：
 * `text-neutral-400`（#a3a3a3）压在深色底（#171717）上是 **7.1:1**，
 * 本身就够清楚；补上 `dark:text-neutral-500`（#737373）反而降到 **3.8:1**。
 * 之所以还是补：全项目所有次要文字都是这一对
 * （`SubjectListPage`、`ChapterPage`、`Sidebar`、`SymbolPanel` 都是），
 * 单独一处更亮会显得像漏改。**这不是「修不可见」，是统一。**
 * 真正低的是浅色下的 2.5:1，那是全项目的既有取值，不在这里动。
 *
 * ⚠️ 这个组件**只管颜色，不管布局**：间距、是否居中、撑不撑满高度，
 * 全都由调用方通过 `className` 传。原因是 `lib/cn.ts` 只是简单拼接、
 * 不做冲突消解，所以组件里带一个 `py-16` 默认值、调用方再传 `py-6`
 * 的话，谁赢取决于 Tailwind 生成样式表的顺序，而不是传参顺序——
 * 那种「有时候生效」的行为比没有默认值更难查。
 */
interface LoadingProps {
  label?: string
  className?: string
}

export function Loading({ label = '加载中…', className }: LoadingProps) {
  return (
    <div
      className={cn(
        'text-center text-sm text-neutral-400 dark:text-neutral-500',
        className,
      )}
    >
      {label}
    </div>
  )
}
