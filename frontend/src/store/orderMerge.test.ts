import { describe, expect, it } from 'vitest'
import type { Order, OrderStatus } from '../api/types'
import { upsertOrderList } from './orderMerge'

const mk = (id: string, status: OrderStatus, updatedAt = '2026-09-29T10:00:00Z'): Order => ({
  id,
  clientOrderId: `c-${id}`,
  signalId: null,
  symbol: 'XAUUSD',
  side: 'BUY',
  volume: 0.1,
  status,
  mt5Ticket: null,
  filledPrice: null,
  message: null,
  createdAt: '2026-09-29T09:00:00Z',
  updatedAt,
})

describe('upsertOrderList', () => {
  it('新订单插到最前 / prepends an unknown order', () => {
    const list = [mk('a', 'FILLED')]
    const next = upsertOrderList(list, mk('b', 'PENDING'))
    expect(next.map((o) => o.id)).toEqual(['b', 'a'])
  })
  it('PENDING 不能覆盖已是终态的行 / PENDING never overwrites a terminal row', () => {
    const list = [mk('a', 'FILLED')]
    expect(upsertOrderList(list, mk('a', 'PENDING'))).toBe(list)
    expect(upsertOrderList(list, mk('a', 'PLACED'))).toBe(list)
  })
  it('PENDING → 终态正常前进 / advances PENDING to terminal', () => {
    const list = [mk('a', 'PENDING')]
    const next = upsertOrderList(list, mk('a', 'REJECTED'))
    expect(next[0].status).toBe('REJECTED')
  })
  it('同档时更旧的 updatedAt 丢弃、更新的替换 / equal rank: older updatedAt dropped, newer wins', () => {
    const list = [mk('a', 'PENDING', '2026-09-29T10:00:05Z')]
    expect(upsertOrderList(list, mk('a', 'PENDING', '2026-09-29T10:00:01Z'))).toBe(list)
    const next = upsertOrderList(list, { ...mk('a', 'PENDING', '2026-09-29T10:00:09Z'), message: 'x' })
    expect(next[0].message).toBe('x')
  })
})
