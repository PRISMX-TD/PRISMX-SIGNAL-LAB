import { describe, it, expect } from 'vitest'
import type { Candle } from '../../../api/types'
import { computeAll } from './compute'
import { DEFS3 } from './registry3'
import { defaultInputs } from './registry'
import type { IndExtras, IndInstance } from './types'

function randomBars(n: number, seed: number, step: number, t0 = 1_760_000_000): Candle[] {
  let x = seed
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  const out: Candle[] = []
  let c = 2600
  for (let i = 0; i < n; i++) {
    const o = c
    c = o + (rnd() - 0.48) * 6
    out.push({ t: t0 + i * step, o, h: Math.max(o, c) + rnd() * 3, l: Math.min(o, c) - rnd() * 3, c, v: 10 + Math.floor(rnd() * 500) })
  }
  return out
}
const bars = randomBars(1500, 5, 900)
const daily = randomBars(600, 9, 86400, bars[0].t - 450 * 86400)
const eur = randomBars(1500, 13, 900).map((b) => ({ ...b, o: b.o / 2400, h: b.h / 2400, l: b.l / 2400, c: b.c / 2400 }))
const other = (sym: string, iv: string) => (iv === 'D' ? daily : sym === 'EURUSD' ? eur : null)
const inst = (type: string): IndInstance => ({ uid: type, type, inputs: defaultInputs(DEFS3.find((d) => d.id === type)!), styles: {}, pane: 'main' })

describe('batch 3 indicators', () => {
  const res = computeAll({ list: DEFS3.map((d) => inst(d.id)), bars, interval: '15', digits: 2, priceBased: false, symbol: 'XAUUSD', other })
  const x = (id: string): IndExtras => res.get(id)!.extras

  it('every kind computes', () => {
    for (const d of DEFS3) expect(res.get(d.id), d.id).toBeTruthy()
    expect(DEFS3.length).toBe(12)
  })
  it('profiles, TPO and boxes', () => {
    expect(x('vpvr').vpVisible?.rows).toBe(24)
    expect(x('vpsv').profiles!.length).toBeGreaterThan(5)
    expect(x('tpo').tpos!.length).toBeGreaterThan(3)
    expect(x('mtfbox').rects!.length).toBeGreaterThan(10)
  })
  it('patterns and fib', () => {
    expect(x('cpatterns').markers!.length).toBeGreaterThan(5)
    const named = x('cpatterns').markers!.filter((m) => m.text)
    expect(named.length).toBeGreaterThan(0)
    expect(named.length).toBeLessThanOrEqual(15)
    expect(named.every((m) => m.text!.startsWith('mk.cp_'))).toBe(true)
    const f = x('autofib')
    expect(f.segs!.length).toBe(8)
    expect(f.labels!.length).toBe(7)
    const ap = x('autopatterns')
    expect((ap.labels ?? []).every((l) => l.text.startsWith('mk.ch_'))).toBe(true)
  })
  it('52w, performance, rating, correlation, spread', () => {
    const hl = res.get('hl52')!.out
    const n = bars.length
    expect(hl.hi[n - 1]).toBeGreaterThanOrEqual(Math.max(...bars.slice(-50).map((b) => b.h)))
    expect(x('perf').table!.rows.map((r) => r.k)).toEqual(['mk.perf_w1', 'mk.perf_m1', 'mk.perf_m3', 'mk.perf_m6', 'mk.perf_ytd', 'mk.perf_y1'])
    expect(x('perf').table!.rows[0].v).toMatch(/^[+-]\d+\.\d\d%$/)
    expect(x('techrating').gauge!.text).toMatch(/^mk\.tr_/)
    const cc = res.get('corr')!.out.corr
    expect(cc.filter((v) => v != null).length).toBeGreaterThan(1000)
    expect(cc.every((v) => v == null || Math.abs(v) <= 1 + 1e-9)).toBe(true)
    expect(res.get('spread')!.out.spread[n - 1]).toBeCloseTo(bars[n - 1].c / eur[n - 1].c)
  })
  it('missing other bars stay empty instead of failing', () => {
    const r = computeAll({ list: [inst('corr'), inst('perf')], bars, interval: '15', digits: 2, priceBased: false, symbol: 'XAUUSD', other: () => null })
    expect(r.get('corr')!.out.corr.every((v) => v == null)).toBe(true)
    expect(r.get('perf')!.extras.table!.rows[0].v).toBe('…')
  })
  it('TPO and HTF boxes stay off where they make no sense', () => {
    const d = randomBars(300, 3, 86400)
    const r = computeAll({ list: [inst('tpo'), { ...inst('mtfbox'), inputs: { tf: 'h1', wick: true } }], bars: d, interval: 'D', digits: 2, priceBased: false })
    expect(r.get('tpo')!.extras.tpos).toBeUndefined()
    expect(r.get('mtfbox')!.extras.rects).toBeUndefined()
  })
})
