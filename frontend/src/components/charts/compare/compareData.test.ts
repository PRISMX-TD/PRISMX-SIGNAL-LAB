import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../../../api/types'
import { resetOtherBars } from '../ind/otherBars'
import { CompareData, type CompareApi } from './compareData'

const bar = (t: number, c = 1): Candle => ({ t, o: c, h: c, l: c, c, v: 0 })
const M = 60
const DB: Record<string, Candle[]> = {
  AAA: Array.from({ length: 3000 }, (_, i) => bar(i * M, 10 + i)),
  BBB: Array.from({ length: 3000 }, (_, i) => bar(i * M, 50 + i)),
}

function fakeApi(opts: { batchFails?: boolean; rangeFails?: boolean } = {}) {
  const calls = { batch: 0, history: 0, range: 0, latest: 0 }
  const api: CompareApi = {
    batch: (async (symbols: string[], _iv: string, limit = 500) => {
      calls.batch++
      if (opts.batchFails) throw new Error('404')
      return { interval: '1', series: Object.fromEntries(symbols.map((s) => [s, { bars: DB[s].slice(-limit), hasMore: DB[s].length > limit }])) }
    }) as CompareApi['batch'],
    history: (async (s: string, iv: string, limit = 1000, before?: number) => {
      calls.history++
      const src = before == null ? DB[s] : DB[s].filter((b) => b.t < before)
      return { symbol: s, interval: iv, bars: src.slice(-limit), hasMore: src.length > limit }
    }) as CompareApi['history'],
    range: (async (s: string, iv: string, from: number, to: number, limit = 5000) => {
      calls.range++
      if (opts.rangeFails) throw new Error('404')
      let bars = DB[s].filter((b) => b.t >= from && b.t <= to)
      const truncated = bars.length > limit
      if (truncated) bars = bars.slice(-limit)
      return { symbol: s, interval: iv, bars, truncated, earliest: DB[s][0].t }
    }) as CompareApi['range'],
    latest: (async (s: string) => {
      calls.latest++
      const src = DB[s]
      return { bars: [...src.slice(-1), bar(src.length * M, 999)], updatedAt: null }
    }) as CompareApi['latest'],
  }
  return { api, calls }
}

describe('CompareData', () => {
  beforeEach(() => { vi.useFakeTimers(); resetOtherBars() })
  afterEach(() => { vi.useRealTimers() })

  it('loads every new symbol with one batch call, then joins the forming bar', async () => {
    const { api, calls } = fakeApi()
    const changed = vi.fn()
    const d = new CompareData('1', changed, api)
    d.setSymbols(['AAA', 'BBB'])
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.batch).toBe(1)
    expect(calls.history).toBe(0)
    expect(calls.latest).toBe(2)
    const a = d.bars('AAA')!
    expect(a.length).toBe(501)
    expect(a[a.length - 1].c).toBe(999)
    expect(d.status('AAA')).toBe('ok')
    expect(changed).toHaveBeenCalledWith('AAA')
    d.dispose()
  })

  it('falls back to per-symbol history when batch fails', async () => {
    const { api, calls } = fakeApi({ batchFails: true })
    const d = new CompareData('1', () => {}, api)
    d.setSymbols(['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.history).toBe(1)
    expect(d.bars('AAA')!.length).toBe(501)
    d.dispose()
  })

  it('pages left with range when the main chart starts earlier, and stops at the earliest bar', async () => {
    const { api, calls } = fakeApi()
    const d = new CompareData('1', () => {}, api)
    d.setSymbols(['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    d.ensureCoverage(100 * M)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.range).toBe(1)
    expect(d.bars('AAA')![0].t).toBeLessThanOrEqual(100 * M)
    d.ensureCoverage(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(d.bars('AAA')![0].t).toBe(0)
    const n = calls.range
    d.ensureCoverage(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.range).toBe(n)
    d.dispose()
  })

  it('falls back to history paging when range is unavailable', async () => {
    const { api, calls } = fakeApi({ rangeFails: true })
    const d = new CompareData('1', () => {}, api)
    d.setSymbols(['AAA'])
    await vi.advanceTimersByTimeAsync(0)
    d.ensureCoverage(100 * M)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.history).toBe(1)
    expect(d.bars('AAA')![0].t).toBe((3000 - 500 - 1000) * M)
    d.dispose()
  })

  it('drops removed symbols', async () => {
    const { api } = fakeApi()
    const d = new CompareData('1', () => {}, api)
    d.setSymbols(['AAA', 'BBB'])
    await vi.advanceTimersByTimeAsync(0)
    d.setSymbols(['BBB'])
    expect(d.bars('AAA')).toBeNull()
    expect(d.symbols()).toEqual(['BBB'])
    d.dispose()
  })
})
