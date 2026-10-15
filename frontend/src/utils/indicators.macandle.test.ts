import { describe, expect, it } from 'vitest'
import type { Candle } from '../api/types'
import { maCandle } from './indicators'

const bar = (t: number, o: number, c: number): Candle => ({ t, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 0 }) as Candle

describe('maCandle', () => {
  it('splits rising and falling legs', () => {
    const closes = [1, 2, 3, 4, 3, 2, 1]
    const r = maCandle(closes.map((c, i) => bar(i, c, c)), 1, 1)
    expect(r.up.slice(0, 4)).toEqual([1, 2, 3, 4])
    expect(r.dn.slice(3)).toEqual([4, 3, 2, 1])
    expect(r.up[5]).toBeNull()
    // 每个点起始那段的方向：0→1→2→3 涨，3→4→5→6 跌 / direction of the segment starting at each point
    expect(r.segDir).toEqual([1, 1, 1, -1, -1, -1, -1])
    expect(r.ma).toEqual(closes)
  })

  it('fires a sell after the MA turns down and de-duplicates', () => {
    // SMA(2) 在第 5 根拐头向下，第 6 根开收盘都在均线(2.5)下方 / MA turns down at 5; bar 6 opens+closes below it
    const rows: [number, number][] = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [3, 3], [2.4, 2], [1, 1], [0, 0], [0, 0]]
    const bars = rows.map(([o, c], i) => bar(i, o, c))
    const r = maCandle(bars, 2, 1)
    const sigs = r.sig.map((s, i) => [i, s]).filter(([, s]) => s != null)
    expect(sigs.length).toBeGreaterThan(0)
    expect(sigs.every(([, s]) => s === -1)).toBe(true)
    expect(sigs).toEqual([[6, -1]])
    // 最后一根（未收盘）不出信号 / never on the forming bar
    expect(r.sig[bars.length - 1]).toBeNull()
  })
})
