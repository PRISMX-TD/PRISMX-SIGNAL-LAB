import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle, ChartRangeOut } from '../../../api/types'
import { ReplayController, resetReplayCaches, type RangeFetcher, type ReplayEngine } from './replayController'

const bar = (t: number, c = 1): Candle => ({ t, o: c, h: c, l: c, c, v: 1 })
const M = 60
const NOW = 10_000 * M
// 库里：M1 从 t=0 到 NOW，每分钟一根 / stored: M1 bars every minute from 0 to NOW
const DB: Candle[] = Array.from({ length: 10_000 }, (_, i) => bar(i * M, 100 + i))
const EARLIEST = 0

function fakeEngine() {
  const calls = { all: 0, tail: 0, recompute: 0, scroll: 0 }
  const live = [bar(NOW - 2 * M, 1), bar(NOW - M, 2)]
  const eng: ReplayEngine & { calls: typeof calls } = {
    calls,
    chartRef: { current: { timeScale: () => ({ scrollToRealTime: () => { calls.scroll++ } }) } as never },
    candlesRef: { current: live },
    lastTimeRef: { current: NOW - M },
    hasMoreHistoryRef: { current: true },
    isFollowingLiveRef: { current: true },
    renderAll: () => { calls.all++ },
    renderTail: () => { calls.tail++ },
    recomputeIndicators: () => { calls.recompute++ },
  }
  return { eng, live }
}

function fakeFetch(): RangeFetcher & { calls: { from: number; to: number; limit?: number }[] } {
  const calls: { from: number; to: number; limit?: number }[] = []
  const f = (async (_s: string, _i: string, from: number, to: number, limit?: number): Promise<ChartRangeOut> => {
    calls.push({ from, to, limit })
    let bars = DB.filter((b) => b.t >= from && b.t <= to)
    const cap = limit ?? 5000
    const truncated = bars.length > cap
    if (truncated) bars = bars.slice(-cap)
    return { symbol: 'X', interval: '1', bars, truncated, earliest: EARLIEST }
  }) as RangeFetcher & { calls: typeof calls }
  f.calls = calls
  return f
}

describe('ReplayController', () => {
  beforeEach(() => { resetReplayCaches(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const setup = () => {
    const { eng, live } = fakeEngine()
    const fetch = fakeFetch()
    const ctl = new ReplayController(fetch, () => NOW * 1000)
    const dataKeyRef = { current: 'X|1' }
    const restored = vi.fn()
    const cursor = vi.fn()
    ctl.setEngine(eng)
    ctl.attach({ symbol: 'X', interval: '1', dataKeyRef, onLiveRestored: restored, onCursor: cursor })
    return { ctl, eng, live, fetch, dataKeyRef, restored, cursor }
  }

  it('starts at the picked bar, shows bars up to it and hides the live data key', async () => {
    const { ctl, eng, dataKeyRef } = setup()
    ctl.beginSelect()
    expect(ctl.getState().selecting).toBe(true)
    await ctl.start(5000 * M + 30)
    const st = ctl.getState()
    expect(st.active).toBe(true)
    expect(st.selecting).toBe(false)
    expect(st.cursorTime).toBe(5000 * M)
    expect(eng.candlesRef.current[eng.candlesRef.current.length - 1].t).toBe(5000 * M)
    expect(eng.lastTimeRef.current).toBe(5000 * M)
    // 起点前至少有 1500 根历史 / at least 1500 bars of history before the start
    expect(eng.candlesRef.current.length).toBeGreaterThanOrEqual(1500)
    expect(dataKeyRef.current).toBe('replay|X|1')
    expect(eng.calls.all).toBeGreaterThan(0)
  })

  it('steps one bar at a time with an incremental render and an indicator recompute', async () => {
    const { ctl, eng, cursor } = setup()
    await ctl.start(5000 * M)
    const n = eng.candlesRef.current.length
    const tail = eng.calls.tail
    const rec = eng.calls.recompute
    expect(ctl.step()).toBe('ok')
    expect(eng.candlesRef.current.length).toBe(n + 1)
    expect(eng.candlesRef.current[n].t).toBe(5001 * M)
    expect(eng.calls.tail).toBe(tail + 1)
    expect(eng.calls.recompute).toBe(rec + 1)
    expect(cursor).toHaveBeenLastCalledWith(DB[5001])
    expect(ctl.getState().cursorTime).toBe(5001 * M)
  })

  it('plays at the chosen speed and pauses', async () => {
    const { ctl } = setup()
    await ctl.start(5000 * M)
    ctl.setSpeed(10)
    ctl.play()
    expect(ctl.getState().playing).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctl.getState().cursorTime).toBe(5010 * M)
    ctl.setSpeed(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctl.getState().cursorTime).toBe(5012 * M)
    ctl.pause()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ctl.getState().cursorTime).toBe(5012 * M)
    expect(ctl.getState().playing).toBe(false)
  })

  it('prefetches the next chunk near the right end and stops at the latest bar', async () => {
    const { ctl, fetch } = setup()
    // 起点离现在 50 根：首块就到现在，done / start 50 bars before now: the first chunk reaches now
    await ctl.start(NOW - 50 * M)
    expect(fetch.calls.length).toBe(1)
    let s = 'ok'
    let k = 0
    while (s === 'ok' && k++ < 100) s = ctl.step()
    expect(s).toBe('end')
    expect(ctl.getState().atEnd).toBe(true)
    expect(ctl.getState().hint?.kind).toBe('end')
  })

  it('fetches further chunks while playing deep in the past', async () => {
    const { ctl, fetch } = setup()
    await ctl.start(1000 * M)
    // 首块到 1000+3000 根；走到右端前 300 根时预取 / first chunk reaches bar 4000; prefetch 300 bars before
    for (let i = 0; i < 2750; i++) ctl.step()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch.calls.length).toBe(2)
    expect(fetch.calls[1].from).toBe(4000 * M + 1)
    for (let i = 0; i < 400; i++) ctl.step()
    expect(ctl.getState().cursorTime).toBe(4150 * M)
  })

  it('clamps a pick before the earliest stored bar and says so', async () => {
    const { ctl } = setup()
    await ctl.start(-500 * M)
    expect(ctl.getState().cursorTime).toBe(0)
    expect(ctl.getState().hint?.kind).toBe('clamped')
  })

  it('re-picks inside the fetched range without another request', async () => {
    const { ctl, fetch, eng } = setup()
    await ctl.start(5000 * M)
    ctl.beginSelect()
    await ctl.start(4800 * M)
    expect(fetch.calls.length).toBe(1)
    expect(ctl.getState().cursorTime).toBe(4800 * M)
    expect(eng.candlesRef.current[eng.candlesRef.current.length - 1].t).toBe(4800 * M)
  })

  it('exit puts the stashed live data back exactly and asks the data layer to poll', async () => {
    const { ctl, eng, live, dataKeyRef, restored } = setup()
    await ctl.start(5000 * M)
    ctl.play()
    ctl.exit()
    expect(eng.candlesRef.current).toBe(live)
    expect(eng.lastTimeRef.current).toBe(NOW - M)
    expect(eng.hasMoreHistoryRef.current).toBe(true)
    expect(dataKeyRef.current).toBe('X|1')
    expect(restored).toHaveBeenCalledTimes(1)
    expect(ctl.getState().active).toBe(false)
    expect(ctl.getState().playing).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(eng.candlesRef.current).toBe(live)
  })

  it('paging left during a replay merges into the replay data and keeps the cursor bar', async () => {
    const { ctl } = setup()
    await ctl.start(5000 * M)
    const older = [bar(3400 * M), bar(3450 * M)]
    const vis = ctl.prependOlderVisible(older)!
    expect(vis[0].t).toBe(3400 * M)
    expect(vis[vis.length - 1].t).toBe(5000 * M)
    expect(ctl.step()).toBe('ok')
    expect(ctl.getState().cursorTime).toBe(5001 * M)
  })

  it('abandons (no restore) when the symbol changes and hands back the live bars', async () => {
    const { ctl, live, restored } = setup()
    await ctl.start(5000 * M)
    expect(ctl.detach()).toBe(live)
    expect(ctl.getState().active).toBe(false)
    expect(restored).not.toHaveBeenCalled()
  })

  it('reports noData and stays idle when the window is empty', async () => {
    const { eng } = fakeEngine()
    const ctl = new ReplayController(async () => ({ symbol: 'X', interval: '1', bars: [], truncated: false, earliest: null }), () => NOW * 1000)
    ctl.setEngine(eng)
    ctl.attach({ symbol: 'X', interval: '1' })
    await ctl.start(100)
    expect(ctl.getState().active).toBe(false)
    expect(ctl.getState().hint?.kind).toBe('noData')
  })

  it('random start uses the earliest bar from the range endpoint', async () => {
    const { ctl, fetch } = setup()
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0)
    await ctl.startRandom()
    rnd.mockRestore()
    expect(fetch.calls[0].limit).toBe(1)
    expect(ctl.getState().active).toBe(true)
    expect(ctl.getState().cursorTime).toBe(300 * M)
    expect(ctl.getState().earliest).toBe(0)
  })
})
