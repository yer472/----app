/**
 * scripts/build-sw.mjs 的类型声明。
 *
 * 那个文件是 .mjs，不在任何一个 tsconfig 的 include 里，所以
 * vite.config.ts 静态 import 它时 tsc 找不到类型，会报 TS7016。
 * 与其在那里写 as any 把问题盖掉，不如把接口写清楚——
 * vite.config.ts 会用到返回的每一个字段。
 */
export interface BuildServiceWorkerResult {
  /** 预缓存条目数 */
  count: number
  /** 其中「缺了应用就坏」的核心资源数 */
  coreCount: number
  /** 缓存名用的构建哈希（16 位十六进制） */
  buildHash: string
  /** 因为扩展名被跳过的文件数（.woff/.ttf/.map） */
  skipped: number
}

export function buildServiceWorker(): Promise<BuildServiceWorkerResult>
