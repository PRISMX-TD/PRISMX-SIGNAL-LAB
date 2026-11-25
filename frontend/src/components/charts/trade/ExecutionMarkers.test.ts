import { describe, expect, it } from 'vitest'
import type { ClosedTrade, Order, Position } from '../../../api/types'
import { ExecPrimitive, tradeLegsFrom } from './ExecutionMarkers'
import { placeLegs, type TradeLeg } from './tradeMath'
import { DOWN_COLOR, UP_COLOR } from '../canvasColors'

interface Stroke { from: [number, number]; to: [number, number]; color: string; dash: number[] }

// 画一遍，记下虚线段和填充次数 / draw once, recording dashed strokes and fills
function draw(legs: TradeLeg[]) {
  const prim = new ExecPrimitive()
  // 时间 t → x = t，价位 p → y = p，方便断言 / time t → x = t, price p → y = p
  const chart = { timeScale: () => ({ options: () => ({ barSpacing: 10 }), timeToCoordinate: (t: number) => t }) }
  const series = { priceToCoordinate: (p: number) => p }
  prim.attached({ chart, series, requestUpdate: () => {} } as never)
  prim.legs = placeLegs(legs, [100, 200, 300, 400])
  const strokes: Stroke[] = []
  let dash: number[] = []
  let path: [number, number][] = []
  let fills = 0
  const st: Record<string, unknown> = {}
  const ctx = new Proxy(st, {
    get: (o, k) => {
      if (k === 'setLineDash') return (d: number[]) => { dash = d }
      if (k === 'beginPath') return () => { path = [] }
      if (k === 'moveTo' || k === 'lineTo') return (x: number, y: number) => { path.push([x, y]) }
      if (k === 'stroke') return () => { if (dash.length) strokes.push({ from: path[0], to: path[1], color: String(o.strokeStyle), dash }) }
      if (k === 'fill') return () => { fills++ }
      return k in o ? o[k as string] : () => {}
    },
    set: (o, k, v) => { o[k as string] = v; return true },
  })
  ;(prim as unknown as { _draw: (c: unknown, w: number, h: number) => void })._draw(ctx, 800, 600)
  return { strokes, fills }
}

describe('ExecPrimitive (trade history lines)', () => {
  it('joins entry and exit with a dashed line coloured by the result', () => {
    const { strokes } = draw([
      { side: 'BUY', t1: 110, p1: 50, t2: 310, p2: 80, profit: 12 },
      { side: 'SELL', t1: 210, p1: 60, t2: 410, p2: 70, profit: -4 },
    ])
    expect(strokes).toEqual([
      { from: [100, 50], to: [300, 80], color: UP_COLOR, dash: [5, 4] },
      { from: [200, 60], to: [400, 70], color: DOWN_COLOR, dash: [5, 4] },
    ])
  })

  it('open positions get an entry arrow and no line', () => {
    const { strokes, fills } = draw([{ side: 'BUY', t1: 110, p1: 50, t2: null, p2: null, profit: null }])
    expect(strokes).toEqual([])
    expect(fills).toBe(1)
  })

  it('a partial close draws one entry arrow and a hollow arrow per exit', () => {
    const leg = { side: 'BUY' as const, t1: 110, p1: 50 }
    const { strokes, fills } = draw([
      { ...leg, t2: 210, p2: 60, profit: 3 },
      { ...leg, t2: 310, p2: 70, profit: 5 },
    ])
    expect(strokes).toHaveLength(2)
    // 开仓 1 次实心 + 两个平仓各 2 次（外框 + 挖空）/ one solid entry + two exits × (shape + hollow)
    expect(fills).toBe(5)
  })
})

describe('tradeLegsFrom', () => {
  const ct = (o: Partial<ClosedTrade>) => ({
    id: 'c', mt5Login: '1', symbol: 'XAUUSD', side: 'BUY', closeVolume: 0.1, closePrice: 12, profit: 2,
    positionTicket: 1, dealTicket: 1, closedAt: '2026-11-25T10:00:00Z', openTime: '2026-11-25T09:00:00Z', openPrice: 10, ...o,
  }) as ClosedTrade
  it('pairs closed trades and adds still-open fills once', () => {
    const closed = [ct({}), ct({ symbol: 'EURUSD', positionTicket: 2 })]
    const orders = [
      { id: 'o', symbol: 'XAUUSD', side: 'SELL', volume: 0.1, status: 'FILLED', action: 'ORDER', filledPrice: 11, mt5Ticket: 5, updatedAt: '2026-11-25T11:00:00Z' },
      { id: 'o2', symbol: 'XAUUSD', side: 'BUY', volume: 0.1, status: 'FILLED', action: 'ORDER', filledPrice: 11, mt5Ticket: 1, updatedAt: '2026-11-25T09:00:00Z' },
    ] as unknown as Order[]
    const positions = [{ ticket: 5, symbol: 'XAUUSD' }, { ticket: 1, symbol: 'XAUUSD' }] as unknown as Position[]
    const legs = tradeLegsFrom('XAUUSD', closed, orders, positions)
    expect(legs).toEqual([
      { side: 'BUY', t1: Date.parse('2026-11-25T09:00:00Z') / 1000, p1: 10, t2: Date.parse('2026-11-25T10:00:00Z') / 1000, p2: 12, profit: 2 },
      { side: 'SELL', t1: Date.parse('2026-11-25T11:00:00Z') / 1000, p1: 11, t2: null, p2: null, profit: null },
    ])
  })

  it('reads naive backend timestamps as UTC, not local time', () => {
    const legs = tradeLegsFrom('XAUUSD', [ct({ openTime: '2026-11-25T09:00:00', closedAt: '2026-11-25T10:00:00.123456' })], [], [])
    expect(legs[0].t1).toBe(Date.parse('2026-11-25T09:00:00Z') / 1000)
    expect(legs[0].t2).toBe(Math.floor(Date.parse('2026-11-25T10:00:00.123Z') / 1000))
  })
})
