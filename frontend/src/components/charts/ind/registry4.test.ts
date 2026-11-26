import { describe, expect, it, vi } from 'vitest'
import type { Candle } from '../../../api/types'
import { computeAll } from './compute'
import { countdownText, crpLevels, crpSigma, periodEnd, pvpLtfLadder, pvpProfile, toUnits, valueAreaStop } from './math4'
import { brokerDay } from './periods'
import { defaultInputs } from './registry'
import { DEFS4 } from './registry4'
import type { IndExtras, IndInstance, Inputs } from './types'

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
const inst = (type: string, over: Inputs = {}): IndInstance =>
  ({ uid: type, type, inputs: { ...defaultInputs(DEFS4.find((d) => d.id === type)!), ...over }, styles: {}, pane: 'main' })

describe('PVP-R math', () => {
  it('value area stops before the next row would overshoot the target', () => {
    // 总量 100，目标 70：POC 40 → +20（上）= 60 → 下一行 15 会到 75 > 70，停 / total 100, target 70
    expect(valueAreaStop([5, 15, 40, 20, 10, 10], 2, 70)).toEqual([2, 3])
    // 上下相等时取上面 / ties go up
    expect(valueAreaStop([10, 30, 10], 1, 100)).toEqual([0, 2])
  })

  it('classifies ties against the previous close and spreads volume by overlap', () => {
    const prev = { c: null as number | null }
    const u = toUnits([{ t: 0, o: 1, h: 2, l: 0, c: 1.5, v: 10 }, { t: 60, o: 1.5, h: 2, l: 1, c: 1.5, v: 4 }, { t: 120, o: 1.4, h: 1.5, l: 1, c: 1.4, v: 2 }], prev)
    expect(u.map((x) => x.up)).toEqual([true, true, false])
    const p = pvpProfile(u, 2, 0, { i1: 0, i2: 2, mode: 'updown', vaPct: 70, layout: 'rows', rowSize: 4, tick: 0.01 })
    expect(p.up.length).toBe(4)
    expect(p.up.reduce((a, b) => a + b, 0)).toBeCloseTo(14)
    expect(p.dn.reduce((a, b) => a + b, 0)).toBeCloseTo(2)
  })

  it('ticks-per-row layout uses rowSize × tick and caps the row count', () => {
    const u = [{ h: 10, l: 0, v: 100, up: true }]
    const p = pvpProfile(u, 10, 0, { i1: 0, i2: 0, mode: 'delta', vaPct: 70, layout: 'ticks', rowSize: 50, tick: 0.01 })
    expect(p.step).toBeCloseTo(0.5)
    expect(p.up.length).toBe(20)
    const q = pvpProfile(u, 10, 0, { i1: 0, i2: 0, mode: 'updown', vaPct: 70, layout: 'ticks', rowSize: 1, tick: 0.01 })
    expect(q.up.length).toBe(200)
  })

  it('picks the script’s lower timeframe for each chart timeframe', () => {
    expect(pvpLtfLadder(60)).toEqual([])
    expect(pvpLtfLadder(900).map((x) => x.code)).toEqual(['1', '5'])
    expect(pvpLtfLadder(3600)[0].code).toBe('5')
    expect(pvpLtfLadder(14400)[0].code).toBe('15')
    expect(pvpLtfLadder(86400)[0].code).toBe('60')
    expect(pvpLtfLadder(604800)[0].code).toBe('240')
  })
})

describe('PVP-R indicator', () => {
  const bars = randomBars(1500, 5, 900)
  it('draws one profile per broker day, the last being the live one', () => {
    const res = computeAll({ list: [inst('pvpr')], bars, interval: '15', digits: 2, priceBased: false, symbol: 'XAUUSD' })
    const ps = res.get('pvpr')!.extras.profiles!
    const days = new Set(bars.map((b) => brokerDay(b.t))).size
    expect(ps.length).toBe(Math.min(60, days))
    expect(ps[ps.length - 1].p.i2).toBe(bars.length - 1)
    expect(ps[0]).toMatchObject({ mode: 'delta', anchor: 'left', width: 0.5, vah: 'p:vah', poc: 'p:poc', box: 'f:box', hist: true })
    const hidden = computeAll({ list: [inst('pvpr', { hideLive: true })], bars, interval: '15', digits: 2, priceBased: false, symbol: 'XAUUSD' })
    expect(hidden.get('pvpr')!.extras.profiles!.length).toBe(ps.length - 1)
  })

  it('asks for 1-minute bars on a 15-minute chart, only as far back as 3000 of them reach', () => {
    vi.useFakeTimers()
    vi.setSystemTime((bars[bars.length - 1].t + 900) * 1000)
    const intrabar = vi.fn((_code: string, t0: number) => {
      // 每根 15 分钟线拆成 15 根 1 分钟线，量都放在收盘价 / each 15m bar becomes fifteen 1m bars with volume at the close
      const out: Candle[] = []
      for (const b of bars) if (b.t >= t0) for (let i = 0; i < 15; i++) out.push({ t: b.t + i * 60, o: b.c, h: b.c, l: b.c, c: b.c, v: i === 14 ? b.v : 0 })
      return out
    })
    const res = computeAll({ list: [inst('pvpr', { volMode: 'total' })], bars, interval: '15', digits: 2, priceBased: false, symbol: 'XAUUSD', intrabar })
    vi.useRealTimers()
    expect(intrabar).toHaveBeenCalledTimes(1)
    const [code, t0] = intrabar.mock.calls[0]
    expect(code).toBe('1')
    expect((bars[bars.length - 1].t + 1800 - t0) / 60).toBeLessThanOrEqual(3000)
    // 有小周期的那天：量全落在收盘价所在的行，所以每根的量都只进一行 / volume sits on single rows
    const last = res.get('pvpr')!.extras.profiles!.slice(-1)[0].p
    const total = bars.slice(last.i1).reduce((a, b) => a + b.v, 0)
    expect(last.up.reduce((a, b) => a + b, 0) + last.dn.reduce((a, b) => a + b, 0)).toBeCloseTo(total)
  })
})

describe('CRP', () => {
  it('σ is the population stdev of the previous bars’ returns times this bar’s open', () => {
    const htf = [100, 100, 100, 100].map((o, i) => ({ t: i, o, h: o, l: o, c: o * (i % 2 ? 1.02 : 0.98), v: 0 }))
    const s = crpSigma(htf, 2)
    expect(s[0]).toBeNull()
    expect(s[1]).toBeNull()
    expect(s[2]).toBeCloseTo(2) // returns −2 %, +2 % → stdev 2 % × 100
    expect(s[3]).toBeCloseTo(2)
  })

  it('levels are sorted, mirrored below the open and remember their source level', () => {
    expect(crpLevels([{ on: true, k: 0 }, { on: true, k: 0.5 }, { on: false, k: 1 }, { on: true, k: 2 }], true))
      .toEqual([{ k: -2, j: 3 }, { k: -0.5, j: 1 }, { k: 0, j: 0 }, { k: 0.5, j: 1 }, { k: 2, j: 3 }])
    expect(crpLevels([{ on: true, k: 1 }], false)).toEqual([{ k: 1, j: 0 }])
  })

  it('a daily period ends at the next broker midnight', () => {
    const t = Date.UTC(2026, 10, 25, 12) / 1000
    const end = periodEnd('D', t)!
    expect(brokerDay(end)).toBe(brokerDay(t) + 1)
    expect(brokerDay(end - 1)).toBe(brokerDay(t))
    expect(countdownText(90061)).toBe('1d 01:01:01')
    expect(countdownText(59)).toBe('00:00:59')
  })

  const bars = randomBars(1500, 5, 900)
  const daily = randomBars(300, 9, 86400, bars[0].t - 200 * 86400)
  const other = (_s: string, iv: string) => (iv === 'D' ? daily : null)
  const run = (over: Inputs = {}): IndExtras => computeAll({ list: [inst('crp', over)], bars, interval: '15', digits: 2, priceBased: false, symbol: 'XAUUSD', other }).get('crp')!.extras

  it('draws the HTF candle panel right of the newest bar with projected levels and labels', () => {
    const x = run()
    const n = bars.length
    // 4 根投影 K 线：实体 + 两条影线 / four candles: a body and two wicks each
    const bodies = x.rects!.filter((r) => !r.back)
    expect(bodies).toHaveLength(4)
    expect(bodies[0].i1).toBe(n - 1 + 20)
    // 9 级里开了 5 级，镜像后 9 条线 / five of nine levels on, nine lines after mirroring
    const lv = x.segs!.filter((s) => s.p1 === s.p2)
    expect(lv).toHaveLength(9)
    expect(lv.every((s) => s.color === 'p:uni')).toBe(true)
    expect(x.labels!.filter((l) => l.text.startsWith('DCRP '))).toHaveLength(9)
    expect(x.labels!.find((l) => l.text.startsWith('DCRP 0 '))!.color).toBe('p:l1')
    const tl = x.labels!.find((l) => l.text === '1D')!
    expect(tl.cd).toBeGreaterThan(bars[n - 1].t)
  })

  it('legacy mode draws per-level styled lines from each period start', () => {
    const x = run({ crpMode: 'legacy', histModels: 3, visMode: 'vBoth' })
    expect(x.rects!.length).toBeGreaterThan(0)
    expect(x.rects!.every((r) => r.back && r.fill!.startsWith('f:b'))).toBe(true)
    expect(x.segs!.some((s) => s.color === 'p:l3')).toBe(true)
    expect(x.labels!.length).toBe(9) // 只有最新一期有标签 / only the latest period is labelled
  })

  it('no HTF bars yet: still draws the panel, without levels', () => {
    const x = computeAll({ list: [inst('crp')], bars, interval: '15', digits: 2, priceBased: false, symbol: 'XAUUSD', other: () => null }).get('crp')!.extras
    expect(x.rects!.length).toBe(4)
    expect(x.segs!.filter((s) => s.p1 === s.p2)).toHaveLength(0)
  })
})
