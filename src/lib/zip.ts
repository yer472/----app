/**
 * zip 打包 / 解包。用的是 fflate（约 8KB），比 jszip 轻得多。
 *
 * 这里只包了项目真正要用的两个动作，没有把 fflate 的 API 全透出去——
 * 万一将来换库，改这一个文件就够了。
 */
import {
  AsyncZipDeflate,
  Zip,
  strFromU8,
  strToU8,
  unzip,
  type ZipOptions,
} from 'fflate'

export interface ZipEntry {
  /** 压缩包内的路径，用 / 分隔，如 `笔记/高等数学/第三章/罗尔定理.md` */
  path: string
  data: Uint8Array
  /**
   * 压缩级别，0 表示只存储不压缩。
   *
   * 图片（PNG/JPEG）本身已经是压缩过的，再 deflate 一遍基本压不动，
   * 却要花掉可观的 CPU 时间，所以图片一律用 0。
   */
  level: ZipOptions['level']
}

export function textEntry(path: string, text: string): ZipEntry {
  return { path, data: strToU8(text), level: 6 }
}

export function bytesEntry(
  path: string,
  data: Uint8Array,
  level: ZipOptions['level'] = 0,
): ZipEntry {
  return { path, data, level }
}

export interface ZipProgress {
  done: number
  total: number
  /** 当前正在打包的文件路径 */
  current: string
}

/**
 * 打包成 zip。
 *
 * 走的是 fflate 的流式接口而不是 zipSync：备份里可能塞着几百 MB 的图片，
 * 一次性同步压完会把主线程卡死、而且中间数据要在内存里堆成完整的一份。
 * 流式版本把结果切成小块交给回调，我们只是把这些块收进数组——
 * Blob 可以直接由一堆小块拼出来，不需要一整块连续内存。
 *
 * 每处理完一个文件就让出一次事件循环，这样进度条才能真的动起来。
 */
export function createZip(
  entries: ZipEntry[],
  onProgress?: (progress: ZipProgress) => void,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const chunks: BlobPart[] = []
    const stream = new Zip((error, chunk, final) => {
      if (error) {
        reject(error)
        return
      }
      if (chunk?.length) chunks.push(chunk as BlobPart)
      if (final) resolve(new Blob(chunks, { type: 'application/zip' }))
    })

    let index = 0

    const step = () => {
      // 每轮只处理一个文件，然后就回到事件循环
      if (index >= entries.length) {
        stream.end()
        return
      }

      const entry = entries[index]
      index += 1

      const file = new AsyncZipDeflate(entry.path, { level: entry.level })
      stream.add(file)
      file.push(entry.data, true)

      onProgress?.({ done: index, total: entries.length, current: entry.path })
      setTimeout(step, 0)
    }

    if (entries.length === 0) stream.end()
    else step()
  })
}

export async function readZip(blob: Blob): Promise<Map<string, Uint8Array>> {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  return new Promise((resolve, reject) => {
    unzip(buffer, (error, data) => {
      if (error) reject(error)
      else resolve(new Map(Object.entries(data)))
    })
  })
}

export function readZipText(
  entries: Map<string, Uint8Array>,
  path: string,
): string | null {
  const data = entries.get(path)
  return data ? strFromU8(data) : null
}
