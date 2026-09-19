/**
 * 给 Promise 加一个超时。
 *
 * 用在这里是因为 IndexedDB 的请求在某些环境下会永远不回调
 * （存储服务异常、无头浏览器等）。没有超时的话，
 * 表现为「应用卡在启动页且毫无提示」——这是最难排查的一类故障。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}
