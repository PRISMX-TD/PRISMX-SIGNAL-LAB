import { describe, it, expect } from 'vitest'
import type { Candle } from '../../../api/types'
import * as legacy from '../../../utils/indicators'
import {
  sma, ema, rma, wma, hma, dema, tema, vwma, alma, lsma, ma, stdev, highest, lowest, change, sum,
  trueRange, atr, bollinger, keltner, donchian, envelope, ichimoku, dmi, aroon, zigzag, fractals,
  alligatorLines, rsi, stoch, stochRsi, macd, cci, willr, mom, roc, ao, ac, mfi, obv, vwapAnchored,
  pivots, shift, src,
} from './math'

// 固定种子的随机 K 线 / seeded random bars
function randomBars(n: number, seed = 7): Candle[] {
  let x = seed
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  const out: Candle[] = []
  let c = 100
  for (let i = 0; i < n; i++) {
    const o = c
    c = o + (rnd() - 0.5) * 2
    const h = Math.max(o, c) + rnd()
    const l = Math.min(o, c) - rnd()
    out.push({ t: i * 60, o, h, l, c, v: Math.floor(rnd() * 100) })
  }
  return out
}

// 由价格路径造 K 线（h = p+0.5, l = p−0.5）/ bars from a price path
const pathBars = (ps: number[]): Candle[] => ps.map((p, i) => ({ t: i * 60, o: p, h: p + 0.5, l: p - 0.5, c: p, v: 1 }))

const close = (a: Candle[]) => src(a, 'close')
const firstIdx = (a: (number | null)[]) => a.findIndex((v) => v != null)

describe('moving averages', () => {
  it('sma basic + null inside the window', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
    expect(sma([1, 2, null, 4, 5, 6], 3)).toEqual([null, null, null, null, null, 5])
    expect(sma([1, 2, 3], 0)).toEqual([null, null, null])
  })

  it('ema seeds with SMA, skips a null after seeding and continues', () => {
    expect(ema([2, 4, 6, 8, 20], 3)).toEqual([null, null, 4, 6, 13])
    expect(ema([null, 2, 4, 6, 8], 3)).toEqual([null, null, null, 4, 6])
    expect(ema([2, 4, 6, null, 8], 3)).toEqual([null, null, 4, null, 6])
    // 种子前遇到 null 需重新攒满窗口 / a null before seeding restarts the window
    expect(ema([1, null, 2, 4, 6], 3)).toEqual([null, null, null, null, 4])
  })

  it('rma uses alpha = 1/len', () => {
    const r = rma([2, 4, 6, 8], 3)
    expect(r.slice(0, 3)).toEqual([null, null, 4])
    expect(r[3]).toBeCloseTo(16 / 3, 12)
  })

  it('wma weights newest highest', () => {
    expect(wma([1, 2, 3], 3)[2]).toBeCloseTo(14 / 6, 12)
    expect(wma([3, 2, 1], 3)[2]).toBeCloseTo(10 / 6, 12)
  })

  it('hma warm-up = len−1 + round(√len)−1 and tracks a linear ramp exactly', () => {
    const ramp = Array.from({ length: 40 }, (_, i) => i)
    const h = hma(ramp, 9)
    expect(firstIdx(h)).toBe(10)
    for (let i = 10; i < 40; i++) expect(h[i]).toBeCloseTo(i, 9)
  })

  it('lsma / alma / dema / tema sanity', () => {
    const ramp = Array.from({ length: 30 }, (_, i) => 2 * i + 1)
    expect(lsma(ramp, 10)[20]).toBeCloseTo(41, 9)
    expect(lsma(ramp, 10, 2)[20]).toBeCloseTo(37, 9)
    expect(alma(new Array(20).fill(5), 9)[19]).toBeCloseTo(5, 12)
    expect(dema(ramp, 5)[29]).toBeCloseTo(59, 6)
    expect(firstIdx(tema(ramp, 5))).toBe(12)
    expect(vwma([1, 3], [1, 3], 2)[1]).toBeCloseTo(10 / 4, 12)
    expect(ma('vwma', [1, 3], 2)).toEqual(sma([1, 3], 2))
  })

  it('ema / rsi / atr agree with the legacy implementations on dense data', () => {
    const b = randomBars(300)
    const c = close(b)
    const pairs: [(number | null)[], (number | null)[]][] = [
      [ema(c, 20), legacy.ema(c, 20)],
      [rsi(c, 14), legacy.rsi(c, 14)],
      [atr(b, 14), legacy.atr(b, 14)],
    ]
    for (const [a, l] of pairs) a.forEach((v, i) => (v == null ? expect(l[i]).toBeNull() : expect(v).toBeCloseTo(l[i] as number, 9)))
  })
})

describe('stats', () => {
  it('stdev is population stdev', () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[7]).toBeCloseTo(2, 12)
  })
  it('highest / lowest / change / sum', () => {
    expect(highest([1, 5, 2, 3, 1], 3)).toEqual([null, null, 5, 5, 3])
    expect(lowest([1, 5, 2, 3, 1], 3)).toEqual([null, null, 1, 2, 1])
    expect(highest([1, null, 2, 3], 2)).toEqual([null, null, null, 3])
    expect(change([1, 4, 9], 1)).toEqual([null, 3, 5])
    expect(sum([1, 2, 3, 4], 2)).toEqual([null, 3, 5, 7])
  })
  it('trueRange first bar is h−l', () => {
    const b = pathBars([10, 12])
    expect(trueRange(b)).toEqual([1, 2.5])
  })
})

describe('oscillators', () => {
  it('rsi on a hand-computed series', () => {
    const r = rsi([1, 2, 3, 2, 1], 2)
    expect(r.slice(0, 3)).toEqual([null, null, 100])
    expect(r[3]).toBeCloseTo(50, 12)
    expect(r[4]).toBeCloseTo(25, 12)
  })

  it('macd hist = macd − signal', () => {
    const m = macd(close(randomBars(200)))
    expect(firstIdx(m.macd)).toBe(25)
    expect(firstIdx(m.signal)).toBe(33)
    m.hist.forEach((h, i) => {
      if (h != null) expect(h).toBeCloseTo((m.macd[i] as number) - (m.signal[i] as number), 12)
    })
  })

  it('stoch / stochRsi / willr stay in bounds', () => {
    const b = randomBars(300)
    const s = stoch(b, 14, 3, 3)
    const sr = stochRsi(close(b))
    for (const v of [...s.k, ...s.d, ...sr.k, ...sr.d]) if (v != null) expect(v >= 0 && v <= 100).toBe(true)
    for (const v of willr(b)) if (v != null) expect(v >= -100 && v <= 0).toBe(true)
    expect(firstIdx(s.k)).toBe(15)
    expect(firstIdx(s.d)).toBe(17)
  })

  it('cci / mom / roc / ao / ac / mfi basics', () => {
    const b = randomBars(120)
    expect(cci([1, 1, 1], 3)[2]).toBeNull()
    expect(cci([1, 2, 3], 3)[2]).toBeCloseTo(1 / (0.015 * (2 / 3)), 9)
    expect(mom([1, 2, 4], 2)).toEqual([null, null, 3])
    expect(roc([2, 3, 4], 2)).toEqual([null, null, 100])
    expect(firstIdx(ao(b))).toBe(33)
    expect(firstIdx(ac(b))).toBe(37)
    const m = mfi(b, 14)
    expect(firstIdx(m)).toBe(14)
    for (const v of m) if (v != null) expect(v >= 0 && v <= 100).toBe(true)
  })
})

describe('trend', () => {
  it('dmi / adx finite after warm-up', () => {
    const d = dmi(randomBars(200))
    expect(firstIdx(d.plus)).toBe(14)
    expect(firstIdx(d.adx)).toBe(27)
    for (let i = 27; i < 200; i++) {
      expect(Number.isFinite(d.adx[i])).toBe(true)
      expect((d.adx[i] as number) >= 0 && (d.adx[i] as number) <= 100).toBe(true)
    }
  })

  it('aroon up = 100 on a new high', () => {
    const b = pathBars([5, 4, 3, 4, 5, 6, 7])
    const a = aroon(b, 4)
    expect(a.up[3]).toBeNull()
    expect(a.up[6]).toBe(100)
    expect(a.down[6]).toBe(0) // 最低在 4 根前 / lowest 4 bars ago
  })

  it('zigzag returns pivots only (plus the tentative leg end)', () => {
    const nodes: [number, number][] = [[0, 100], [15, 120], [30, 100], [45, 130], [55, 110]]
    const ps: number[] = []
    for (let k = 0; k + 1 < nodes.length; k++) {
      const [i0, p0] = nodes[k]
      const [i1, p1] = nodes[k + 1]
      for (let i = i0; i < i1; i++) ps.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0))
    }
    ps.push(110)
    const z = zigzag(pathBars(ps), 5, 10)
    const hits = z.map((v, i) => (v == null ? null : [i, v])).filter(Boolean)
    expect(hits).toEqual([[15, 120.5], [30, 99.5], [45, 130.5], [55, 109.5]])
    // 偏离不足的小波动不算拐点 / sub-threshold swings are ignored
    expect(zigzag(pathBars(ps), 50, 10).filter((v) => v != null).length).toBe(2)
  })

  it('fractals detect a constructed peak and trough', () => {
    const f = fractals(pathBars([1, 2, 5, 2, 1, 0, -3, 0, 1]))
    expect(f.up.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([2])
    expect(f.down.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([6])
  })

  it('ichimoku / donchian / alligator shapes', () => {
    const b = randomBars(100)
    const ich = ichimoku(b)
    expect(firstIdx(ich.conv)).toBe(8)
    expect(firstIdx(ich.spanA)).toBe(25)
    expect(firstIdx(ich.spanB)).toBe(51)
    const dc = donchian(b, 5)
    expect(dc.basis[10]).toBeCloseTo(((dc.upper[10] as number) + (dc.lower[10] as number)) / 2, 12)
    expect(firstIdx(alligatorLines(b).jaw)).toBe(12)
  })
})

describe('bands', () => {
  it('bollinger is symmetric around the basis', () => {
    const bb = bollinger(close(randomBars(100)), 20, 2)
    expect(firstIdx(bb.basis)).toBe(19)
    bb.basis.forEach((m, i) => {
      if (m != null) expect((bb.upper[i] as number) - m).toBeCloseTo(m - (bb.lower[i] as number), 9)
    })
  })
  it('keltner / envelope', () => {
    const b = randomBars(60)
    const k = keltner(b, close(b), 20, 2, 10)
    const a = atr(b, 10)
    expect((k.upper[30] as number) - (k.basis[30] as number)).toBeCloseTo(2 * (a[30] as number), 9)
    const e = envelope([100, 100], 2, 10)
    expect(e.upper[1]).toBeCloseTo(110, 9)
    expect(e.lower[1]).toBeCloseTo(90, 9)
  })
})

describe('volume', () => {
  it('obv accumulates signed volume', () => {
    const b = pathBars([1, 2, 1, 1])
    b.forEach((x, i) => (x.v = i + 1))
    expect(obv(b)).toEqual([0, 2, -1, -1])
  })

  it('vwapAnchored resets on key change, bands use volume-weighted stdev, 0 volume counts as 1', () => {
    const mk = (t: number, p: number, v: number): Candle => ({ t, o: p, h: p, l: p, c: p, v })
    const b = [mk(0, 10, 1), mk(1, 20, 3), mk(100, 50, 2), mk(101, 30, 0)]
    const r = vwapAnchored(b, (t) => Math.floor(t / 100), [2])
    expect(r.vwap[0]).toBe(10)
    expect(r.vwap[1]).toBeCloseTo(17.5, 12)
    expect(r.bands[0].upper[1]).toBeCloseTo(17.5 + 2 * Math.sqrt(18.75), 9)
    expect(r.bands[0].lower[0]).toBeCloseTo(10, 9)
    expect(r.vwap[2]).toBe(50)
    expect(r.vwap[3]).toBeCloseTo((100 + 30) / 3, 12)
  })
})

describe('pivots', () => {
  const mk = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1 })
  // 周期 A: H=12 L=8 C=10；周期 B: H=20 L=10 C=18 / period A then B, then C
  const b = [
    mk(0, 9, 11, 8, 9), mk(10, 9, 12, 9, 10),
    mk(100, 11, 15, 10, 14), mk(110, 14, 20, 13, 17), mk(120, 17, 19, 15, 18),
    mk(200, 18, 19, 17, 18), mk(210, 18, 19, 17, 18),
  ]
  const key = (t: number) => Math.floor(t / 100)

  it('traditional levels come from the previous period and break on the last bar', () => {
    const r = pivots(b, key, 'traditional')
    expect(r.p.slice(0, 2)).toEqual([null, null])
    expect(r.p[2]).toBeCloseTo(10, 12)
    expect(r.p[3]).toBeCloseTo(10, 12)
    expect(r.p[4]).toBeNull() // 周期 B 的最后一根 / last bar of period B
    expect(r.r1[2]).toBeCloseTo(12, 12)
    expect(r.s1[2]).toBeCloseTo(8, 12)
    expect(r.r2[2]).toBeCloseTo(14, 12)
    expect(r.r3[2]).toBeCloseTo(16, 12)
    expect(r.s3[2]).toBeCloseTo(4, 12)
    expect(r.p[5]).toBeCloseTo(16, 12)
    expect(r.p[6]).toBeCloseTo(16, 12) // 数据末根不断开 / final bar of the data stays
  })

  it('woodie uses the current period open', () => {
    const r = pivots(b, key, 'woodie')
    expect(r.p[2]).toBeCloseTo((12 + 8 + 2 * 11) / 4, 12)
    expect(pivots(b, key, 'camarilla').r1[2]).toBeCloseTo(10 + (1.1 * 4) / 12, 12)
    expect(pivots(b, key, 'fibonacci').r1[2]).toBeCloseTo(10 + 0.382 * 4, 12)
  })
})

describe('invariants', () => {
  it('shift pads with null', () => {
    expect(shift([1, 2, 3], 1)).toEqual([null, 1, 2])
    expect(shift([1, 2, 3], -2)).toEqual([3, null, null])
  })

  it('every output has the input length; len <= 0 gives all nulls', () => {
    const b = randomBars(80)
    const c = close(b)
    const v = src(b, 'volume')
    const outs: unknown[][] = [
      sma(c, 5), ema(c, 5), wma(c, 5), rma(c, 5), hma(c, 5), dema(c, 5), tema(c, 5), vwma(c, v, 5),
      alma(c, 5), lsma(c, 5), stdev(c, 5), highest(c, 5), lowest(c, 5), change(c), sum(c, 5), trueRange(b),
      atr(b, 5, 'ema'), cci(c), willr(b), mom(c), roc(c), ao(b), ac(b), mfi(b), obv(b), rsi(c),
      zigzag(b), fractals(b).up, shift(c, 3), ...Object.values(dmi(b)), ...Object.values(aroon(b)),
      ...Object.values(pivots(b, (t) => Math.floor(t / 600), 'classic')),
      ...(['sma', 'ema', 'wma', 'rma', 'hma', 'dema', 'tema', 'vwma', 'alma', 'lsma'] as const).map((t) => ma(t, c, 7, v)),
    ]
    for (const o of outs) expect(o.length).toBe(80)
    for (const f of [sma, ema, wma, rma, hma, stdev, highest]) expect(f(c, 0).every((x) => x == null)).toBe(true)
    expect(atr(b, -1).every((x) => x == null)).toBe(true)
  })
})
