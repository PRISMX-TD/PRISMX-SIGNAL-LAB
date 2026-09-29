// 把一条订单并入本地列表（WS ORDER_UPDATE 与接口回执共用），并防止「回退」。
//
// 下单/平仓/改单/撤单的 HTTP 回执直接整条返回订单。桥接账号先回 PENDING，随后 WS 的
// ORDER_UPDATE(FILLED) 可能抢在回执之前到达——回执再覆盖就把已成交行打回 PENDING。
// 所以只接受「不比现有更旧」的状态：PENDING < PLACED < 终态（FILLED/REJECTED/FAILED/
// CANCELLED）；同档时 updatedAt 更旧的丢弃。列表里没有就插到最前。
//
// Merge one order into the local list (shared by WS ORDER_UPDATE and REST receipts) without
// letting it regress. A bridge account's HTTP receipt says PENDING, and the WS
// ORDER_UPDATE(FILLED) may beat it; overwriting would push a filled row back to PENDING. Only a
// state no older than the current one is accepted: PENDING < PLACED < terminal; at equal rank an
// older updatedAt is dropped. Not in the list: prepend.
import type { Order, OrderStatus } from '../api/types'

const TERMINAL: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['FILLED', 'REJECTED', 'FAILED', 'CANCELLED'])

export function isTerminalOrder(status: OrderStatus): boolean {
  return TERMINAL.has(status)
}

function rank(status: OrderStatus): number {
  if (TERMINAL.has(status)) return 2
  return status === 'PLACED' ? 1 : 0
}

function ts(s: string | undefined): number {
  const n = s ? Date.parse(s) : NaN
  return Number.isNaN(n) ? 0 : n
}

/** 返回并入后的新列表；不需要变化时返回原数组引用。/ New list, or the same array if unchanged. */
export function upsertOrderList(list: Order[], incoming: Order): Order[] {
  const idx = list.findIndex((o) => o.id === incoming.id)
  if (idx < 0) return [incoming, ...list]
  const cur = list[idx]
  const rc = rank(cur.status)
  const ri = rank(incoming.status)
  if (ri < rc) return list
  if (ri === rc && ts(incoming.updatedAt) < ts(cur.updatedAt)) return list
  const next = [...list]
  next[idx] = incoming
  return next
}
