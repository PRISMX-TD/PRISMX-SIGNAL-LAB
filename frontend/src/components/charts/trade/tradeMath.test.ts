import { describe, expect, it } from 'vitest'
import {
  autoEntryType, barOf, canBreakeven, fmtSigned, groupExecutions, moveReadout, partialVolume, pointSize, stagedLegPrice,
} from './tradeMath'

describe('moveReadout', () => {
  const spec = { tickSize: 0.01, tickValue: 1, contractSize: 100 }
  it('signs by side and converts with the broker spec', () => {
    const buy = moveReadout({ symbol: 'XAUUSD', side: 'BUY', volume: 1, entry: 2000, price: 1990, digits: 2, spec, balance: 10000 })
    expect(buy.points).toBe(-1000)
    expect(buy.money).toBeCloseTo(-1000)
    expect(buy.pct).toBeCloseTo(-10)
    const sell = moveReadout({ symbol: 'XAUUSD', side: 'SELL', volume: 0.5, entry: 2000, price: 1990, digits: 2, spec, balance: null })
    expect(sell.points).toBe(1000)
    expect(sell.money).toBeCloseTo(500)
    expect(sell.pct).toBeNull()
  })
  it('zero distance is zero, not negative zero noise', () => {
    const r = moveReadout({ symbol: 'XAUUSD', side: 'BUY', volume: 1, entry: 2000, price: 2000, digits: 2, spec, balance: 1000 })
    expect(r.points).toBe(0)
    expect(r.money).toBe(0)
  })
})

describe('autoEntryType', () => {
  it('buy below ask is a limit, above a stop', () => {
    expect(autoEntryType('BUY', 99, 100, 100.2)).toBe('LIMIT')
    expect(autoEntryType('BUY', 101, 100, 100.2)).toBe('STOP')
  })
  it('sell above bid is a limit, below a stop', () => {
    expect(autoEntryType('SELL', 101, 100, 100.2)).toBe('LIMIT')
    expect(autoEntryType('SELL', 99, 100, 100.2)).toBe('STOP')
  })
  it('no quote falls back to limit', () => {
    expect(autoEntryType('BUY', 99, null, null)).toBe('LIMIT')
  })
})

describe('partialVolume', () => {
  it('floors onto the lot step', () => {
    expect(partialVolume(1, 0.25, 'XAUUSD')).toBe(0.25)
    expect(partialVolume(0.07, 0.5, 'XAUUSD')).toBe(0.03)
  })
  it('too small is null, leaving dust is a full close', () => {
    expect(partialVolume(0.01, 0.5, 'XAUUSD')).toBeNull()
    // 0.015 向下吸附到 0.01，剩下的 0.01 仍是合法最小手数 / floors to 0.01; the 0.01 left is still a legal lot
    expect(partialVolume(0.02, 0.75, 'XAUUSD')).toBe(0.01)
    expect(partialVolume(0.3, 1, 'XAUUSD')).toBe(0.3)
  })
})

describe('stagedLegPrice', () => {
  it('always lands on the valid side of the market', () => {
    // 买单浮亏：现价低于入场 / a losing buy
    const sl = stagedLegPrice('BUY', 'sl', 100, 98)
    const tp = stagedLegPrice('BUY', 'tp', 100, 98)
    expect(sl).toBeLessThan(98)
    expect(tp).toBeGreaterThan(100)
    // 卖单浮盈：现价低于入场 / a winning sell
    expect(stagedLegPrice('SELL', 'sl', 100, 97)).toBeGreaterThan(100)
    expect(stagedLegPrice('SELL', 'tp', 100, 97)).toBeLessThan(97)
  })
})

describe('canBreakeven', () => {
  it('needs the position in profit', () => {
    expect(canBreakeven('BUY', 100, 101)).toBe(true)
    expect(canBreakeven('BUY', 100, 99)).toBe(false)
    expect(canBreakeven('SELL', 100, 99)).toBe(true)
    expect(canBreakeven('SELL', 100, null)).toBe(false)
  })
})

describe('executions', () => {
  const times = [100, 200, 300, 400]
  it('barOf finds the containing bar', () => {
    expect(barOf(times, 50)).toBeNull()
    expect(barOf(times, 100)).toBe(100)
    expect(barOf(times, 250)).toBe(200)
    expect(barOf(times, 9999)).toBe(400)
  })
  it('groups same bar + side with a volume-weighted price', () => {
    const g = groupExecutions([
      { t: 210, price: 10, side: 'BUY', kind: 'open', volume: 1 },
      { t: 290, price: 13, side: 'BUY', kind: 'open', volume: 2 },
      { t: 250, price: 12, side: 'SELL', kind: 'close', volume: 1, profit: 5 },
      { t: 10, price: 12, side: 'SELL', kind: 'close', volume: 1 },
    ], times)
    expect(g).toHaveLength(2)
    const buy = g.find((x) => x.side === 'BUY')!
    expect(buy.count).toBe(2)
    expect(buy.volume).toBe(3)
    expect(buy.price).toBeCloseTo(12)
    expect(g.find((x) => x.side === 'SELL')!.profit).toBe(5)
  })
})

describe('formatting', () => {
  it('pointSize and fmtSigned', () => {
    expect(pointSize(5)).toBeCloseTo(0.00001)
    expect(fmtSigned(1.5)).toBe('+1.50')
    expect(fmtSigned(-2)).toBe('-2.00')
    expect(fmtSigned(0)).toBe('0.00')
  })
})
