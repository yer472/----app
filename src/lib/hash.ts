/**
 * 一个快速的字符串哈希（cyrb53 变体，53 位）。
 *
 * 用途是判断「内容变没变」，不是密码学用途——备份前要拿它跟上次的记录比对，
 * 决定这篇笔记要不要重写。用 crypto.subtle.digest 也能做，但那个是异步的、
 * 还要把整段文本编码成 Uint8Array；这里每次都要过一遍几 MB 的正文，
 * 用同步的纯字符串哈希更省事。
 *
 * 53 位空间下，几万篇笔记里撞一次的概率可以忽略，而且撞了也只是少备份一次，
 * 不会损坏数据——备份本身是全量的，不依赖这个哈希。
 */
export function hashString(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
