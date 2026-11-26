import { describe, expect, it } from 'vitest'
import type { Candle } from '../../../api/types'
import { derivedSpec } from '../derivedIntervals'
import {
  REPLAY_AHEAD_SRC, REPLAY_BEFORE_SRC, appendNewer, buildDerived, chunkWindow, indexAtOrBefore, mergeDerived, needsMore,
  prependOlder, randomStartTime, resolveStart, snapSpeed, speedMs, startWindow, stepState,
} from './replayModel'

const bar = (t: number, c = 1): Candle => ({ t, o: c, h: c, l: c, c, v: 1 })
const series = (from: number, n: number, step: number) => Array.from({ length: n }, (_, i) => bar(from + i * step, 100 + i))

describe('speed', () => {
  it('maps bars per second to a tick length', () => {
    expect(speedMs(1)).toBe(1000)
    expect(speedMs(0.5)).toBe(2000)
    expect(speedMs(10)).toBe(100)
    expect(speedMs(3)).toBe(333)
  })
  it('snaps to the nearest step', () => {
    expect(snapSpeed(4)).toBe(3)
    expect(snapSpeed(100)).toBe(10)
    expect(snapSpeed(0)).toBe(0.5)
  })
})

describe('locating the start', () => {
  const bars = series(1000, 10, 60)
  it('finds the last bar at or before a time', () => {
    expect(indexAtOrBefore(bars, 1000)).toBe(0)
    expect(indexAtOrBefore(bars, 1059)).toBe(0)
    expect(indexAtOrBefore(bars, 1060)).toBe(1)
    expect(indexAtOrBefore(bars, 99999)).toBe(9)
    expect(indexAtOrBefore(bars, 999)).toBe(-1)
    expect(indexAtOrBefore([], 5)).toBe(-1)
  })
  it('clamps a pick before the data (or before the stored earliest) to the first bar', () => {
    expect(resolveStart(bars, 500, null)).toEqual({ idx: 0, clamped: true })
    expect(resolveStart(bars, 1200, 1100)).toEqual({ idx: 3, clamped: false })
    expect(resolveStart(bars, 1050, 1060)).toEqual({ idx: 0, clamped: true })
    expect(resolveStart([], 1050, null)).toBeNull()
  })
})

describe('step state machine', () => {
  it('steps while bars remain, waits for the next chunk, ends when done', () => {
    expect(stepState(10, 3, false, false)).toBe('ok')
    expect(stepState(10, 9, false, false)).toBe('wait')
    expect(stepState(10, 9, true, false)).toBe('end')
  })
  it('does not step onto a possibly partial derived tail bucket until done', () => {
    expect(stepState(10, 8, false, true)).toBe('wait')
    expect(stepState(10, 8, true, true)).toBe('ok')
    expect(stepState(10, 7, false, true)).toBe('ok')
  })
  it('prefetches near the right end only while not done', () => {
    expect(needsMore(1000, 100, false)).toBe(false)
    expect(needsMore(1000, 800, false)).toBe(true)
    expect(needsMore(1000, 800, true)).toBe(false)
  })
})

describe('fetch windows', () => {
  it('spans history before and bars ahead of the start, never past now', () => {
    const w = startWindow(1_000_000, 60, 2_000_000)
    expect(w.from).toBe(1_000_000 - REPLAY_BEFORE_SRC * 60)
    expect(w.to).toBe(1_000_000 + REPLAY_AHEAD_SRC * 60)
    expect(startWindow(1_000_000, 60, 1_000_100).to).toBe(1_000_100)
    // 一个窗口最多的根数在 range 的 5000 上限以内 / a window can never exceed range's 5000 cap
    expect(REPLAY_BEFORE_SRC + REPLAY_AHEAD_SRC + 1).toBeLessThan(5000)
  })
  it('continues right after the fetched end', () => {
    expect(chunkWindow(5000, 60, 1e9)).toEqual({ from: 5001, to: 5000 + REPLAY_AHEAD_SRC * 60 })
  })
  it('picks a random start inside [earliest + 300 bars, now - 100 bars]', () => {
    expect(randomStartTime(0, 100_000, 60, () => 0)).toBe(300 * 60)
    expect(randomStartTime(0, 100_000, 60, () => 0.999999)).toBeLessThanOrEqual(100_000 - 100 * 60)
    // 数据太少：取中点 / too little data: the midpoint
    expect(randomStartTime(0, 1000, 60, () => 0.5)).toBe(500)
  })
})

describe('merging chunks', () => {
  it('appends only newer bars and replaces an equal last bar', () => {
    const a = series(0, 3, 60)
    const out = appendNewer(a, [bar(60, 9), bar(120, 7), bar(180, 8)])
    expect(out.map((b) => b.t)).toEqual([0, 60, 120, 180])
    expect(out[2].c).toBe(7)
    expect(out[1].c).toBe(101)
  })
  it('prepends only older bars', () => {
    const r = prependOlder(series(600, 3, 60), [bar(480), bar(540), bar(600, 5)])
    expect(r.inserted).toBe(2)
    expect(r.bars.map((b) => b.t)).toEqual([480, 540, 600, 660, 720])
  })
})

describe('derived chunks', () => {
  const spec = derivedSpec('30')!
  it('drops a partial head bucket and keeps the tail bucket source bars', () => {
    // 15 分钟源从 00:15 开始：第一桶（00:00）只有后半截 / M15 source from 00:15: the 00:00 bucket is half
    const src = series(900, 6, 900) // 00:15 … 01:30
    const ch = buildDerived(src, spec, true)
    expect(ch.bars.map((b) => b.t)).toEqual([1800, 3600, 5400])
    expect(ch.srcTail.map((b) => b.t)).toEqual([5400])
  })
  it('re-aggregates the partial tail bucket with the next chunk', () => {
    const src = series(0, 5, 900) // 00:00 … 01:00 → buckets 0, 1800, 3600(partial)
    const first = buildDerived(src, spec, false)
    expect(first.bars.length).toBe(3)
    const next = mergeDerived(first, [bar(4500, 50), bar(5400, 60)], spec)
    expect(next.bars.map((b) => b.t)).toEqual([0, 1800, 3600, 5400])
    // 3600 桶 = 3600 + 4500 两根源 bar，收盘取后一根 / the 3600 bucket now spans both source bars
    expect(next.bars[2].c).toBe(50)
    expect(next.bars[2].o).toBe(104)
    expect(next.srcTail.map((b) => b.t)).toEqual([5400])
  })
  it('ignores chunk bars already merged', () => {
    const first = buildDerived(series(0, 4, 900), spec, false)
    expect(mergeDerived(first, [bar(1800), bar(2700)], spec)).toBe(first)
  })
})
