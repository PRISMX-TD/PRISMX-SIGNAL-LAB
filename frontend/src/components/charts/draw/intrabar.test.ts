import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const history = vi.fn()
const latest = vi.fn()
vi.mock('../../../api/client', () => ({ chartApi: { history: (...a: unknown[]) => history(...a), latest: (...a: unknown[]) => latest(...a) } }))

import { intrabarBars, intrabarLadder, resetIntrabar, subscribeIntrabar } from './intrabar'
import { placeIntrabar } from './ext/volume'

const m1 = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: from + i * 60, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }))
const flush = async () => { await vi.advanceTimersByTimeAsync(400); await Promise.resolve() }

describe('intrabar bars for volume profiles', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-26T12:00:00Z')); history.mockReset(); latest.mockReset(); resetIntrabar() })
  afterEach(() => { vi.useRealTimers() })

  it('follows TradingView’s ladder: smallest timeframe below the chart’s with few enough bars', () => {
    expect(intrabarLadder(3600, 16 * 3600).map((x) => x.code)).toEqual(['1', '5', '15'])
    expect(intrabarLadder(3600, 5 * 86400).map((x) => x.code)).toEqual(['5', '15']) // 7200 M1 bars > 3000
    expect(intrabarLadder(60, 3600)).toEqual([]) // nothing below 1 minute
  })

  it('waits for the range to settle, loads once, then serves the bars from cache', async () => {
    const t0 = Date.UTC(2026, 10, 25, 0) / 1000
    history.mockResolvedValue({ bars: m1(t0 - 600, 30), hasMore: true })
    const hit = vi.fn()
    subscribeIntrabar(hit)
    expect(intrabarBars('EURUSD', '60', t0, t0 + 1200, 'd1')).toBeNull()
    expect(intrabarBars('EURUSD', '60', t0, t0 + 1200, 'd1')).toBeNull() // same range: still one timer
    await flush()
    expect(history).toHaveBeenCalledTimes(1)
    expect(history.mock.calls[0]).toEqual(['EURUSD', '1', 1000, t0 + 1200])
    expect(hit).toHaveBeenCalled()
    const r = intrabarBars('EURUSD', '60', t0, t0 + 1200, 'd1')!
    expect(r.code).toBe('1')
    expect(r.bars).toHaveLength(20) // [t0, t0 + 1200)
    expect(r.bars[0].t).toBe(t0)
    // 区间缩小仍在已拉的范围内：不再请求 / a narrower range inside the loaded span: no new request
    expect(intrabarBars('EURUSD', '60', t0 + 300, t0 + 900, 'd1')!.bars).toHaveLength(10)
    expect(history).toHaveBeenCalledTimes(1)
  })

  it('steps up a level when the database has no 1-minute history that far back', async () => {
    const t0 = Date.UTC(2026, 9, 1, 0) / 1000
    history.mockImplementation((_s: string, code: string) => Promise.resolve(code === '1'
      ? { bars: m1(t0 + 7200, 10), hasMore: false } // starts two hours late
      : { bars: Array.from({ length: 4 }, (_, i) => ({ t: t0 + i * 300, o: 1, h: 2, l: 0.5, c: 1.5, v: 5 })), hasMore: true }))
    expect(intrabarBars('EURUSD', '60', t0, t0 + 1200, 'd2')).toBeNull()
    await flush()
    expect(intrabarBars('EURUSD', '60', t0, t0 + 1200, 'd2')).toBeNull() // M1 short → now loading M5
    await flush()
    const r = intrabarBars('EURUSD', '60', t0, t0 + 1200, 'd2')!
    expect(r.code).toBe('5')
    expect(r.bars).toHaveLength(4)
  })

  it('places each lower-timeframe bar at the chart bar it falls in', () => {
    const chart = [{ x: 10, t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }, { x: 20, t: 3600, o: 1, h: 1, l: 1, c: 1, v: 1 }]
    const ib = [0, 1800, 3600, 5400].map((t) => ({ x: NaN, t, o: 1, h: 1, l: 1, c: 1, v: 1 }))
    expect(placeIntrabar(ib, chart).map((b) => b.x)).toEqual([10, 10, 20, 20])
  })
})
