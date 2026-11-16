// 持仓 / 挂单的「先显示、后确认」叠加层（2026-11-16 体验报告 H1）。
//
// 网关账号下单，POST 0.37 秒就带着成交回执回来了，但持仓行要等下一帧 POSITIONS 推送
// （网关优先读一次再推），实测 1.18 秒才出现——中间那 0.8 秒用户看到的是「成交了，
// 但仓位在哪？」。回执里已经有开出这张仓所需的一切（票号、品种、方向、手数、成交价），
// 所以先把它画出来，服务器那一帧到了再换成真实数字。
//
// 两种叠加：
//   added   回执说开出来了、服务器帧里还没有的行（市价成交 → 持仓；挂单挂出 → 挂单）。
//   removed 回执说已经没了、服务器帧里还在的行（全平成交、撤挂单成功）。
// 服务器帧一旦对上（added 的出现了 / removed 的消失了）就把叠加项撤掉，以服务器为准；
// 对不上的最多保留 ttl 毫秒——回执说成交但仓位立刻被止损打掉这类极端情况，过期后
// 服务器的那一份照样会接管，不会让一行假数据永远挂着。
//
// Optimistic overlay for positions / pending orders (QA report H1, 2026-11-16).
// A gateway fill answers in ~0.37s, yet the position row waited for the next POSITIONS
// push (~1.18s). The receipt already carries everything needed to draw the row, so it is
// shown at once and replaced by the server's figures when its frame catches up. `added`
// rows are waiting to appear in a frame, `removed` ones waiting to disappear; each entry
// lives until a frame confirms it or `ttl` passes, after which the server always wins.

import type { Order, PendingOrder, Position } from '../api/types'

export const OPTIMISTIC_TTL_MS = 8000

/** 止损止盈：下单时填的值（回执里不带）。/ SL/TP as sent with the order (the receipt omits them). */
export interface SlTp {
  stopLoss?: number | null
  takeProfit?: number | null
}

const leg = (v: number | null | undefined) => (v != null && v > 0 ? v : undefined)

/**
 * 回执能画出的那一行：市价单成交 → 持仓，挂单挂出 → 挂单；其余（未成交、被拒、没有票号、
 * 桥接通道的只是收单）返回 null，照旧等服务器推送。
 * The row a receipt can draw: a filled market order → a position, a placed pending order
 * → a pending order. Anything else (not yet answered, rejected, no ticket, a bridge
 * acceptance) returns null and keeps waiting for the server push.
 */
export function rowFromReceipt(
  o: Order,
  sltp: SlTp = {},
): { kind: 'position'; row: Position } | { kind: 'pending'; row: PendingOrder } | null {
  if (!o.mt5Ticket || !(o.volume > 0)) return null
  const action = o.action ?? 'ORDER'
  const login = o.mt5Login ?? null
  if (action === 'ORDER' && o.status === 'FILLED' && o.filledPrice != null && o.filledPrice > 0) {
    return {
      kind: 'position',
      row: {
        ticket: o.mt5Ticket,
        symbol: o.symbol,
        side: o.side,
        volume: o.volume,
        profit: 0,
        entryPrice: o.filledPrice,
        currentPrice: o.filledPrice,
        stopLoss: leg(sltp.stopLoss),
        takeProfit: leg(sltp.takeProfit),
        login,
      },
    }
  }
  if (action === 'PENDING' && o.status === 'PLACED' && o.pendingType && o.price != null && o.price > 0) {
    return {
      kind: 'pending',
      row: {
        ticket: o.mt5Ticket,
        symbol: o.symbol,
        type: o.pendingType,
        side: o.side,
        volume: o.volume,
        price: o.price,
        stopLoss: leg(sltp.stopLoss),
        takeProfit: leg(sltp.takeProfit),
        login,
      },
    }
  }
  return null
}

export interface OptimisticOverlay<T> {
  added: Map<string, { item: T; at: number }>
  removed: Map<string, number>
}

export function createOverlay<T>(): OptimisticOverlay<T> {
  return { added: new Map(), removed: new Map() }
}

/** 持仓与挂单共用的行键：账号 + 票号；没有票号的行不参与叠加。/ Row key: login + ticket. */
export function rowKey(r: { ticket?: number | null; login?: string | null }): string | null {
  return r.ticket ? `${r.login ?? ''}:${r.ticket}` : null
}

/**
 * 把叠加层合到服务器的一帧上。会就地清掉已被确认或已过期的叠加项。
 * 没有任何叠加项时原样返回 server（同一个引用），调用方的 keepIfEqual 照常生效。
 * Merges the overlay onto a server frame, pruning confirmed / expired entries in place.
 * Returns `server` itself when nothing is overlaid.
 */
export function overlayRows<T extends { ticket?: number | null; login?: string | null }>(
  server: T[],
  ov: OptimisticOverlay<T>,
  now: number,
  ttl = OPTIMISTIC_TTL_MS,
): T[] {
  if (ov.added.size === 0 && ov.removed.size === 0) return server
  const present = new Set<string>()
  for (const r of server) {
    const k = rowKey(r)
    if (k) present.add(k)
  }
  for (const [k, v] of ov.added) if (present.has(k) || now - v.at > ttl) ov.added.delete(k)
  for (const [k, at] of ov.removed) if (!present.has(k) || now - at > ttl) ov.removed.delete(k)
  if (ov.added.size === 0 && ov.removed.size === 0) return server
  const kept = ov.removed.size > 0
    ? server.filter((r) => {
        const k = rowKey(r)
        return !(k && ov.removed.has(k))
      })
    : server
  if (ov.added.size === 0) return kept
  return [...kept, ...Array.from(ov.added.values(), (v) => v.item)]
}
