import { describe, expect, it } from 'vitest'
import type { ClosedTrade } from '../api/types'
import { mergeClosedLegs } from './useClosedTrades'

const leg = (id: string, closedAt: string, extra: Partial<ClosedTrade> = {}): ClosedTrade => ({
  id,
  mt5Login: '600306',
  symbol: 'XAUUSD',
  side: 'BUY',
  closeVolume: 0.01,
  closePrice: 4000,
  profit: 1,
  positionTicket: 1,
  dealTicket: 1,
  closedAt,
  ...extra,
})

describe('mergeClosedLegs', () => {
  it('两页拼起来按平仓时间倒序 / pages concatenate newest first', () => {
    const head = [leg('c', '2026-11-23T10:00:00'), leg('b', '2026-11-22T10:00:00')]
    const older = [leg('a', '2026-11-21T10:00:00')]
    expect(mergeClosedLegs(older, head).map((l) => l.id)).toEqual(['c', 'b', 'a'])
  })

  it('两页重叠的腿只留一条 / an overlapping leg is kept once', () => {
    // 第一页为了凑齐仓位带上了较早的腿 a；下一页把 a 当正常行又返回一次
    const head = [leg('c', '2026-11-23T10:00:00'), leg('a', '2026-11-20T10:00:00')]
    const older = [leg('b', '2026-11-21T10:00:00'), leg('a', '2026-11-20T10:00:00')]
    expect(mergeClosedLegs(older, head).map((l) => l.id)).toEqual(['c', 'b', 'a'])
  })

  it('同 id 以新取回的为准（回扫补齐了开仓价）/ the fresh copy of a leg wins', () => {
    const kept = [leg('a', '2026-11-20T10:00:00', { openPrice: null })]
    const fresh = [leg('a', '2026-11-20T10:00:00', { openPrice: 3990 })]
    expect(mergeClosedLegs(fresh, kept)[0].openPrice).toBe(3990)
  })

  it('刷新最新一页不丢掉已加载的更早记录 / a head refresh keeps loaded history', () => {
    const loaded = [leg('c', '2026-11-23T10:00:00'), leg('b', '2026-11-22T10:00:00'), leg('a', '2026-11-21T10:00:00')]
    const refreshedHead = [leg('d', '2026-11-24T10:00:00'), leg('c', '2026-11-23T10:00:00')]
    expect(mergeClosedLegs(refreshedHead, loaded).map((l) => l.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('同一时刻的腿顺序固定；带不带小数秒都排得对 / stable ties, fractional seconds sort correctly', () => {
    const out = mergeClosedLegs(
      [leg('x', '2026-11-23T10:00:00'), leg('y', '2026-11-23T10:00:00'), leg('z', '2026-11-23T10:00:00.500000')],
      [],
    )
    expect(out.map((l) => l.id)).toEqual(['z', 'y', 'x'])
  })
})
