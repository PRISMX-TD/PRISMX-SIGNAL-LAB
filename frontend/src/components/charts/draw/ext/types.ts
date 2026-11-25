// 第二批画线工具的统一接口：每个工具一份 绘制 / 命中 / 手柄 / 拖手柄。
// The common shape of a batch 2 drawing tool: render / hit / handles / handle drag.
import type { Drawing, Point } from '../model'
import { type DrawEnv, type Px, tolOf } from '../paint'

export interface ToolDef {
  // hot = 选中或悬停 / hot = selected or hovered
  render: (ctx: CanvasRenderingContext2D, d: Drawing, px: Px[], env: DrawEnv, hot: boolean) => void
  // 返回距离（越小越近），没命中返回 null / distance (smaller = closer), null when missed
  hit: (d: Drawing, px: Px[], env: DrawEnv, x: number, y: number) => number | null
  // 缺省 = 每个点一个手柄 / default: one handle per point
  handles?: (d: Drawing, px: Px[], env: DrawEnv) => Px[]
  // 缺省 = 拖哪个点改哪个点 / default: the dragged handle moves its own point
  drag?: (d: Drawing, i: number, pt: Point, orig: Point[]) => Point[]
}
export type ToolDefs = Partial<Record<Drawing['type'], ToolDef>>

// 最近距离在容差内就算命中 / the nearest distance counts when within tolerance
export function nearest(env: DrawEnv, ...ds: number[]): number | null {
  const tol = tolOf(env)
  let m = Infinity
  for (const d of ds) if (d < m) m = d
  return m <= tol ? m : null
}
// 命中线身，或者（有填充时）落在区域里 / on an outline, or inside the area when filled
export function hitOrInside(env: DrawEnv, dist: number, inside: boolean): number | null {
  const n = nearest(env, dist)
  if (n != null) return n
  return inside ? tolOf(env) : null
}
export const inRect = (x: number, y: number, r: { x: number; y: number; w: number; h: number }, pad = 0) =>
  x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad
