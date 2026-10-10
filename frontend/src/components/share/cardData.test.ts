// 分享卡上每个数字的算法：用手算好的样例钉住，改动适配器时这里会先红。
// Pins every number on the share cards against hand-computed examples.
import { describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { badgeCard, compCard, compPublicLink, loadMonthOfficial, loadTradeReturn, monthCard, tradeCard } from './cardData'

// 后端分享接口的替身：返回收益榜口径的值 / stand-in for the backend share endpoints
const api = vi.hoisted(() => ({
  shareTrade: vi.fn(async () => ({ returnPct: 12.3456 })),
  shareMonth: vi.fn(async () => ({ returnPct: 1186.123, total: 5000, trades: 17, wins: 10 })),
}))
vi.mock('../../api/client', () => ({ gamificationApi: api }))

// 测试里的 t 原样回 key（带参数时拼出来），只看数字不看文案。
// The test t returns the key (with params appended) so only numbers are asserted.
const t = ((k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k)) as unknown as TFunction

describe('tradeCard', () => {
  const row = {
    symbol: 'XAUUSD', side: 'BUY' as const, volume: 0.5, openPrice: 4012.35, closePrice: 4038.03,
    // 不带时区 = UTC（与后端一致）/ naive = UTC, like the backend
    openTime: '2026-09-30T10:35:00', closeTime: '2026-09-30T13:47:00', net: 1284,
  }
  it('pips and holding time; return is never estimated client-side', () => {
    const c = tradeCard(t, row)
    expect(c.pips).toBe(256.8)                 // (4038.03 - 4012.35) / 0.1
    expect(c.pct).toBeNull()
    expect(c.hold).toBe('share.card.durH:{"h":3,"m":12}')
    expect(c.pnl).toBe(1284)
  })
  it('losing short: pips negative', () => {
    const c = tradeCard(t, { ...row, side: 'SELL', openPrice: 4026.1, closePrice: 4034.35, net: -412.5, openTime: '2026-09-29T14:21:00Z', closeTime: '2026-09-29T15:08:00Z' })
    expect(c.pips).toBe(-82.5)                 // price rose 8.25 against a short
    expect(c.hold).toBe('share.card.durM:{"m":47}')
  })
  it('unknown symbol -> no pips', () => {
    expect(tradeCard(t, { ...row, symbol: 'FOOBAR' }).pips).toBeNull()
  })
  it('official return comes from the backend, keyed by position only (no client profit)', async () => {
    api.shareTrade.mockClear()
    expect(await loadTradeReturn('602907', { ...row, positionTicket: 4455 })).toBe(12.35)
    expect(api.shareTrade).toHaveBeenCalledWith('602907', 4455)
    // 仓位号 0 也是合法值 / ticket 0 is still a value
    await loadTradeReturn('602907', { ...row, positionTicket: 0 })
    expect(api.shareTrade).toHaveBeenLastCalledWith('602907', 0)
    api.shareTrade.mockClear()
    expect(await loadTradeReturn('602907', { ...row, positionTicket: 4455, openTime: null })).toBeNull()   // legacy row
    expect(await loadTradeReturn('602907', row)).toBeNull()                                                // no position
    expect(await loadTradeReturn(undefined, { ...row, positionTicket: 4455 })).toBeNull()
    expect(api.shareTrade).not.toHaveBeenCalled()
  })
  it('naive and Z timestamps give the same holding time', () => {
    const a = tradeCard(t, row).hold
    const b = tradeCard(t, { ...row, openTime: row.openTime + 'Z', closeTime: row.closeTime + 'Z' }).hold
    expect(a).toBe(b)
  })
})

describe('monthCard', () => {
  // 一笔仓位分两腿平仓（同一 positionTicket）应只算一笔 / a position closed in two legs counts once
  const trades = [
    { profit: 100, closedAt: '2026-09-01T03:00:00', mt5Login: '1', positionTicket: 11 },
    { profit: 50, closedAt: '2026-09-01T04:00:00', mt5Login: '1', positionTicket: 11 },
    { profit: -30, closedAt: '2026-09-02T03:00:00', mt5Login: '1', positionTicket: 12 },
    { profit: 200, closedAt: '2026-09-10T03:00:00', mt5Login: '1', positionTicket: 13 },
    { profit: 999, closedAt: '2026-08-31T03:00:00', mt5Login: '1', positionTicket: 9 }, // other month
  ]
  it('totals, per-position count and win rate (UTC month)', () => {
    const m = monthCard(trades, 2026, 9)!
    expect(m.total).toBe(320)
    expect(m.trades).toBe(3)                   // positions 11, 12, 13
    expect(m.winRate).toBe(66.7)               // 2 of 3
    expect(m.pct).toBeNull()                   // never estimated client-side
    expect(m.days.length).toBe(30)
    expect(m.bestDay).toBe(10)
    expect(m.days.reduce((a, b) => a + b, 0)).toBe(320)
    expect(m.firstWeekday).toBe(2)             // 2026-09-01 is a Tuesday
  })
  it('empty month -> null', () => {
    expect(monthCard(trades, 2026, 7)).toBeNull()
  })
  it('UTC boundary: 2026-09-30T23:30Z belongs to September even in UTC+8', () => {
    expect(monthCard([{ profit: 5, closedAt: '2026-09-30T23:30:00Z' }], 2026, 9)!.days[29]).toBe(5)
  })
  it('official month numbers replace the client ones', async () => {
    const m = await loadMonthOfficial('602907', monthCard(trades, 2026, 9)!)
    expect(api.shareMonth).toHaveBeenCalledWith('602907', '2026-09')
    expect([m.pct, m.total, m.trades, m.winRate]).toEqual([1186.1, 5000, 17, 58.8])
  })
})

describe('badgeCard rarity', () => {
  it('tiered: this tier and above over population', () => {
    // silver holders who later reached gold still "earned silver": (80 + 12) / 500
    expect(badgeCard(t, { id: 'veteran', tier: 2, maxTier: 3, owners: 392, tierOwners: [300, 80, 12] }, 500).rarity).toBe(18.4)
    expect(badgeCard(t, { id: 'veteran', tier: 3, maxTier: 3, owners: 392, tierOwners: [300, 80, 12] }, 500).rarity).toBe(2.4)
  })
  it('standalone uses owners; tiny shares floor at 0.1%', () => {
    expect(badgeCard(t, { id: 'comp_back_to_back', tier: 0, maxTier: 0, owners: 1, tierOwners: [] }, 5000).rarity).toBe(0.1)
  })
})

describe('compCard', () => {
  it('ordinal suffix and arena medal tier', () => {
    expect(compCard('x', 1, 10, 9).rankSuffix).toBe('st')
    expect(compCard('x', 2, 10, 9).rankSuffix).toBe('nd')
    expect(compCard('x', 3, 10, 9).rankSuffix).toBe('rd')
    expect(compCard('x', 11, 10, 99).rankSuffix).toBe('th')
    expect(compCard('x', 22, 10, 99).rankSuffix).toBe('nd')
    expect(compCard('x', 1, 10, 9).medal.tier).toBe(3)
    expect(compCard('x', 3, 10, 9).medal.tier).toBe(2)
    expect(compCard('x', 4, 10, 9).medal.tier).toBe(1)
  })
})

describe('compCard link', () => {
  it('carries the public page link only when given', () => {
    expect(compCard('x', 1, 10, 9).link).toBeUndefined()
    expect(compCard('x', 1, 10, 9, compPublicLink('abc')).link).toBe('https://www.prismxsignallab.com/c/abc')
  })
  it('encodes the id', () => {
    expect(compPublicLink('a/b')).toBe('https://www.prismxsignallab.com/c/a%2Fb')
  })
})
