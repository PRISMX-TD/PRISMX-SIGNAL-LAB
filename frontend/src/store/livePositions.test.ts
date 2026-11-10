import { describe, expect, it } from 'vitest'
import type { Position } from '../api/types'
import { impliedK, livePosition, tableK } from './livePositions'

const gold = (over: Partial<Position> = {}): Position => ({
  ticket: 1, symbol: 'XAUUSD.s', side: 'BUY', volume: 0.01,
  entryPrice: 4021.06, currentPrice: 4023.57, profit: 2.51, login: '100279', ...over,
})

describe('impliedK', () => {
  it('从服务器浮盈反推每价格单位的金额 / infers k from the server profit', () => {
    expect(impliedK(gold())).toBeCloseTo(1, 6) // 0.01 手 × 100 盎司
  })
  it('价差太小不反推 / no inference from a tiny move', () => {
    expect(impliedK(gold({ currentPrice: 4021.1, profit: 0.04 }))).toBeNull()
  })
  it('空单方向 / short side', () => {
    expect(impliedK(gold({ side: 'SELL', entryPrice: 4030, currentPrice: 4020, profit: 10 }))).toBeCloseTo(1, 6)
  })
})

describe('tableK', () => {
  it('USD 计价品种 = 手数 × 合约规模 / quote-USD symbols', () => {
    expect(tableK(gold(), 4023.57)).toBeCloseTo(1, 6)
  })
  it('不认识的品种不估 / unknown symbols are not estimated', () => {
    expect(tableK(gold({ symbol: 'EURGBP' }), 0.85)).toBeNull()
  })
})

describe('livePosition', () => {
  const anchor = { bid: 4023.5, ask: 4023.8 }

  it('多单按买价相对锚点的变化推算 / long moves with bid since the anchor', () => {
    const live = livePosition(gold(), { bid: 4025.5, ask: 4025.8 }, anchor, 1)
    expect(live.profit).toBe(4.51)
    expect(live.currentPrice).toBeCloseTo(4025.57, 6)
  })

  it('空单按卖价反向推算 / short moves against ask', () => {
    const p = gold({ side: 'SELL', profit: -2.51 })
    const live = livePosition(p, { bid: 4025.5, ask: 4025.8 }, anchor, 1)
    expect(live.profit).toBe(-4.51)
  })

  it('报价源与券商的固定价差被锚点抵消 / a constant feed offset cancels out', () => {
    // 报价没动（只是与券商现价差 0.07）→ 浮盈不变。/ Quote unchanged → profit unchanged.
    expect(livePosition(gold(), anchor, anchor, 1)).toEqual(gold())
  })

  it('缺报价 / 缺 k / 休市 / 跳得离谱 时原样返回 / falls back to the server row', () => {
    const p = gold()
    expect(livePosition(p, undefined, anchor, 1)).toBe(p)
    expect(livePosition(p, { bid: 4025, ask: 4025.3 }, anchor, null)).toBe(p)
    expect(livePosition(p, { bid: 4025, ask: 4025.3, closed: true }, anchor, 1)).toBe(p)
    expect(livePosition(p, { bid: 4500, ask: 4500.3 }, anchor, 1)).toBe(p)
  })
})
