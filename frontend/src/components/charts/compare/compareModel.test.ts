import { describe, expect, it } from 'vitest'
import type { Candle } from '../../../api/types'
import { derivedSpec } from '../derivedIntervals'
import type { CompareEntry } from '../layout/paneState'
import {
  COMPARE_COLORS, SCALE_FORCE_IDLE, addableSymbols, alignCloses, guessDigits, nextCompareColor, nextScaleForce, placeEntries,
  scaleOverrideOf, type ScaleForce,
} from './compareModel'

const bar = (t: number, c: number): Candle => ({ t, o: c, h: c, l: c, c, v: 0 })
const e = (symbol: string, mode: CompareEntry['mode'], extra: Partial<CompareEntry> = {}): CompareEntry => ({ symbol, mode, color: '#ffffff', ...extra })

describe('alignCloses', () => {
  it('matches bars on the same time and leaves gaps where the compare symbol has none', () => {
    const main = [0, 60, 120, 180]
    const cmp = [bar(0, 1), bar(120, 3), bar(180, 4)]
    expect(alignCloses(main, cmp, 60)).toEqual([1, null, 3, 4])
  })
  it('never adds time points: extra compare bars are dropped', () => {
    const main = [0, 120]
    // 60 落在 [0, min(120, 0+60)) 之外 → 丢掉 / 60 is outside [0, min(120, 60)) → dropped
    expect(alignCloses(main, [bar(0, 1), bar(60, 2), bar(120, 3)], 60)).toEqual([1, 3])
  })
  it('drops weekend dailies of a 7-day symbol on a 5-day main chart', () => {
    const D = 86400
    const fri = 4 * D
    const mon = 7 * D
    const main = [fri, mon]
    const cmp = [bar(fri, 10), bar(fri + D, 11), bar(fri + 2 * D, 12), bar(mon, 13)]
    expect(alignCloses(main, cmp, D)).toEqual([10, 13])
  })
  it('takes the last close inside a window without a spacing (irregular intervals)', () => {
    expect(alignCloses([0, 100], [bar(10, 1), bar(50, 2), bar(150, 3)], null)).toEqual([2, 3])
  })
  it('aligns derived buckets by key (a holiday Monday starts one symbol week on Tuesday)', () => {
    const spec = derivedSpec('W')!
    const D = 86400
    // 2026-11-23 周一（券商零点 ≈ 前一天 21:00 UTC）/ Monday 2026-11-23 (broker midnight ≈ 21:00 UTC the day before)
    const mon = Date.UTC(2026, 10, 23) / 1000 - 3 * 3600
    // 主图上周一休市，那一周的 bar 从周二起算 / the main symbol had a Monday holiday: that week's bar starts on Tuesday
    const main = [mon - 6 * D, mon]
    const cmp = [bar(mon - 7 * D, 5), bar(mon, 6)]
    expect(alignCloses(main, cmp, null, spec.bucketKey)).toEqual([5, 6])
    // 不按 key 对齐会错位 / without keys it misaligns
    expect(alignCloses(main, cmp, null)).not.toEqual([5, 6])
  })
  it('handles empty inputs', () => {
    expect(alignCloses([], [bar(0, 1)], 60)).toEqual([])
    expect(alignCloses([0, 60], [], 60)).toEqual([null, null])
  })
})

describe('percent scale override', () => {
  const run = (steps: { pct: boolean; user: 0 | 1 | 2 | 3 }[]) => {
    let f: ScaleForce = SCALE_FORCE_IDLE
    return steps.map((s) => { f = nextScaleForce(f, s.pct, s.user); return scaleOverrideOf(f, s.user) })
  }
  it('switches normal / log to percent while a percent compare is visible, and restores after', () => {
    expect(run([{ pct: false, user: 0 }, { pct: true, user: 0 }, { pct: true, user: 0 }, { pct: false, user: 0 }])).toEqual([null, 2, 2, null])
    expect(run([{ pct: true, user: 1 }, { pct: false, user: 1 }])).toEqual([2, null])
  })
  it('leaves a user already on percent / indexed-to-100 alone', () => {
    expect(run([{ pct: true, user: 2 }, { pct: true, user: 3 }])).toEqual([null, null])
  })
  it("doesn't fight the user's toggle while active", () => {
    // 接管后用户切到对数 → 放开；再切回普通也不再抢 / user picks log while forced → released, and stays released
    expect(run([{ pct: true, user: 0 }, { pct: true, user: 1 }, { pct: true, user: 0 }])).toEqual([2, null, null])
  })
  it('takes over again after every percent compare went away and one came back', () => {
    expect(run([{ pct: true, user: 0 }, { pct: true, user: 1 }, { pct: false, user: 1 }, { pct: true, user: 1 }])).toEqual([2, null, null, 2])
  })
})

describe('placement', () => {
  it('puts percent on the right, the first scale entry on the left, others on overlay scales, panes in order', () => {
    const r = placeEntries([e('A', 'percent'), e('B', 'scale'), e('C', 'scale'), e('D', 'pane'), e('E', 'pane', { hidden: true })], false)
    expect(r.place.get('A')).toEqual({ scaleId: 'right', pane: false })
    expect(r.place.get('B')).toEqual({ scaleId: 'left', pane: false })
    expect(r.place.get('C')).toEqual({ scaleId: 'cmp-C', pane: false })
    expect(r.place.get('D')).toEqual({ scaleId: 'right', pane: true })
    expect(r.wantsLeft).toBe(true)
    expect(r.panes).toEqual(['D'])
  })
  it("doesn't take the left scale when indicators use it, nor for a hidden entry", () => {
    expect(placeEntries([e('B', 'scale')], true).place.get('B')?.scaleId).toBe('cmp-B')
    expect(placeEntries([e('B', 'scale')], true).wantsLeft).toBe(false)
    const r = placeEntries([e('B', 'scale', { hidden: true }), e('C', 'scale')], false)
    expect(r.place.get('C')?.scaleId).toBe('left')
  })
})

describe('helpers', () => {
  it('picks the first unused default colour', () => {
    expect(nextCompareColor([])).toBe(COMPARE_COLORS[0])
    expect(nextCompareColor([{ symbol: 'A', mode: 'percent', color: COMPARE_COLORS[0].toUpperCase() }])).toBe(COMPARE_COLORS[1])
  })
  it('lists addable symbols without the main one and those already added', () => {
    expect(addableSymbols(['EURUSD', 'XAUUSD', 'BTCUSD'], 'EURUSD', [e('btcusd', 'percent')])).toEqual(['XAUUSD'])
  })
  it('guesses decimals from the price level', () => {
    expect(guessDigits(1.08543)).toBe(5)
    expect(guessDigits(2650.1)).toBe(2)
    expect(guessDigits(150.2)).toBe(3)
    expect(guessDigits(null)).toBe(2)
  })
})
