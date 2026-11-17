import type { Order, OrderStatus } from '../api/types'

// 交易日志的状态芯片按「用户在回执上看到的那个状态」归类，而不是按库里的原始状态。
//
// 撤挂单成功在库里记作 FILLED，回执上却印「已撤销」（见 OrdersPage 的 DONE_STAMP）；按原始
// 状态筛，它落在「已成交」里，点「已撤销」反而找不到。挂单挂出去记作 PLACED，原来没有对应的
// 芯片，任何筛选都看不到它，各芯片的数加起来也凑不到「全部」。
//
// Log status chips group rows by the status the slip shows, not the raw stored one. A
// successful pending-order cancel is stored as FILLED but stamped "Cancelled" (see DONE_STAMP
// in OrdersPage), so filtering on the raw status put it under "Filled" and "Cancelled" missed
// it. A placed pending order (PLACED) had no chip at all, so no filter showed it and the chip
// counts did not add up to "All".
export function orderLogBucket(o: Pick<Order, 'status' | 'action'>): OrderStatus {
  if (o.status === 'FILLED' && o.action === 'CANCEL_PENDING') return 'CANCELLED'
  return o.status
}

export type StatusFilter = 'ALL' | OrderStatus

// 「已挂出」只在有这类记录（或正选着它）时出现：多数人从不挂单，不必多一个永远是空的芯片。
// "Placed" shows only when there are such rows (or it is selected): most people never place
// pending orders and need no chip that is always empty.
const BASE_FILTERS: StatusFilter[] = ['ALL', 'PENDING', 'FILLED', 'PLACED', 'REJECTED', 'FAILED', 'CANCELLED']

export function visibleStatusFilters(
  counts: Partial<Record<StatusFilter, number>> | null,
  selected: StatusFilter,
): StatusFilter[] {
  return BASE_FILTERS.filter((s) => s !== 'PLACED' || selected === 'PLACED' || (counts?.PLACED ?? 0) > 0)
}
