// 下单票当前的仓位设置（手数 / 风险 %），给图上的多空仓位工具读。
// 下单票是页面里唯一知道「用户这单打算下多大」的地方；画线层在图表里另一棵树上，
// 用一个模块级的小仓库互通，不为这点事去穿 props 或开 context。下单票卸载（手机抽屉
// 关上、专业版切走面板）后保留最后一次的值：用户刚设好的仓位不该因为收起票就失效。
// The order ticket's current sizing (lots / risk %) for the chart's long/short position
// tool. The ticket is the only place that knows how big the next order is meant to be;
// the drawing layer lives in another subtree, so a tiny module-level store bridges them
// instead of threading props or a context. The last value survives the ticket
// unmounting (mobile sheet closed, pro panel switched): sizing the user just set should
// not lapse because the ticket was tucked away.

export type TicketSizing =
  | { mode: 'lots'; lots: number }
  | { mode: 'risk'; pct: number; equity: number | null; lots: number | null }

let current: TicketSizing | null = null
const subs = new Set<() => void>()

export function getTicketSizing(): TicketSizing | null {
  return current
}

function same(a: TicketSizing | null, b: TicketSizing | null): boolean {
  if (a === b) return true
  if (!a || !b || a.mode !== b.mode) return false
  if (a.mode === 'lots' && b.mode === 'lots') return a.lots === b.lots
  if (a.mode === 'risk' && b.mode === 'risk') return a.pct === b.pct && a.equity === b.equity && a.lots === b.lots
  return false
}

export function setTicketSizing(next: TicketSizing | null): void {
  if (same(current, next)) return
  current = next
  for (const f of subs) f()
}

export function subscribeTicketSizing(f: () => void): () => void {
  subs.add(f)
  return () => { subs.delete(f) }
}
