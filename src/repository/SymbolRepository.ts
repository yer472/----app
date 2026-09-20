import { db } from '@/db'
import { newId } from '@/lib/id'
import { now } from '@/lib/time'
import type { CustomSymbol, ID, ISODateTime } from '@/types/models'
import type { Point, Shape } from '@/types/scene'

/**
 * 自定义符号的读写。
 *
 * 这是**用户创作的内容**，所以它是一张正经的表、也进备份链路
 * （`BackupRepository` 的 snapshot / counts / replaceAll 三处都要认它）。
 * 图省事塞进 `settings` 表是不行的：那张表刻意不进备份，恢复一次就没了。
 *
 * 存的是**符号编辑画布里的普通图元**，不是渲染用的零件表——编辑已有符号时
 * 要把定义还原成可编辑的图元，而 `shapes` 本身就是存储形态，还原是恒等的。
 */

export interface CreateCustomSymbolInput {
  name: string
  shapes: Shape[]
  origin: Point
  width: number
  height: number
}

/** 编辑画布里允许出现的图元。放符号进去会形成递归，从数据层就挡掉 */
const ALLOWED_KINDS = new Set(['line', 'rect', 'ellipse', 'pencil'])

function sanitizeShapes(shapes: Shape[]): Shape[] {
  return shapes.filter((s) => ALLOWED_KINDS.has(s.kind))
}

export const SymbolRepository = {
  /** 全部自定义符号，按创建时间排。名字排序留给界面，这里保证顺序稳定 */
  async list(): Promise<CustomSymbol[]> {
    const all = await db.symbols.toArray()
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  },

  async get(id: ID): Promise<CustomSymbol | null> {
    return (await db.symbols.get(id)) ?? null
  },

  async create(input: CreateCustomSymbolInput): Promise<CustomSymbol> {
    const at: ISODateTime = now()
    const symbol: CustomSymbol = {
      id: newId(),
      name: input.name.trim() || '未命名符号',
      shapes: sanitizeShapes(input.shapes),
      origin: input.origin,
      width: input.width,
      height: input.height,
      createdAt: at,
      updatedAt: at,
    }
    await db.symbols.add(symbol)
    return symbol
  },

  /**
   * 改名 / 改图形。
   *
   * ⚠️ **改了不会影响已经画好的图**。图里内联着一份当时的定义（见
   * `Scene.defs`），那份副本是权威的。这是刻意的：静默重写用户画好的图
   * 比「改了不生效」危险得多。想更新老图，把里面那个符号删掉重新放一个。
   */
  async update(
    id: ID,
    patch: Partial<CreateCustomSymbolInput>,
  ): Promise<void> {
    const next: Partial<CustomSymbol> = { updatedAt: now() }
    if (patch.name !== undefined) next.name = patch.name.trim() || '未命名符号'
    if (patch.shapes !== undefined) next.shapes = sanitizeShapes(patch.shapes)
    if (patch.origin !== undefined) next.origin = patch.origin
    if (patch.width !== undefined) next.width = patch.width
    if (patch.height !== undefined) next.height = patch.height
    await db.symbols.update(id, next)
  },

  /**
   * 删除。
   *
   * 不做「还有图在用它」的检查：不需要。每张图里都内联着自己的那份定义，
   * 删掉库里的不影响任何已画好的图——这正是当初决定内联的理由。
   */
  async remove(id: ID): Promise<void> {
    await db.symbols.delete(id)
  },

  async count(): Promise<number> {
    return db.symbols.count()
  },
}
