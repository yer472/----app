/** 触发浏览器下载一个 Blob。导出功能用它把打包好的 zip 交给用户。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  // Firefox 要求锚点在文档里才会响应 click()
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  // 立刻 revoke 的话，浏览器可能还没真正开始读这个 URL，下载会失败。
  // 推迟到下一分钟再释放，足够下载启动，也不会一直占着内存。
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 让用户在文件选择框里挑一个文件，返回它的内容 */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'

    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null)
      input.remove()
    })
    // 用户点了取消：change 不会触发，只能靠窗口重新聚焦来兜底，
    // 否则这个 Promise 永远不 settle
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!input.files?.length) resolve(null)
          input.remove()
        }, 400)
      },
      { once: true },
    )

    document.body.appendChild(input)
    input.click()
  })
}
