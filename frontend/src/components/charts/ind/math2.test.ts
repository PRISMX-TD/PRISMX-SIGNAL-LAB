import { describe, it, expect } from 'vitest'
import type { Candle } from '../../../api/types'
import * as M from './math2'

function randomBars(n: number, seed = 11): Candle[] {
  let x = seed
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  const out: Candle[] = []
  let c = 100
  for (let i = 0; i < n; i++) {
    const o = c
    c = o + (rnd() - 0.5) * 2
    out.push({ t: i * 60, o, h: Math.max(o, c) + rnd(), l: Math.min(o, c) - rnd(), c, v: 1 + Math.floor(rnd() * 100) })
  }
  return out
}
const bars = randomBars(400)
const close = bars.map((b) => b.c)
const near = (a: number | null, b: number, eps = 1e-9) => expect(a == null ? NaN : Math.abs(a - b)).toBeLessThan(eps)

describe('math2 shapes', () => {
  const all: Record<string, (number | null)[]> = {
    kama: M.kama(close), mcginley: M.mcginley(close), ppo: M.ppo(close).ppo, trix: M.trix(close), uo: M.ultimate(bars),
    cmo: M.cmo(close), dpo: M.dpo(close), fisher: M.fisher(bars).fisher, crsi: M.connorsRsi(close), rvi: M.rvi(bars).rvi,
    smi: M.smi(bars).smi, tsi: M.tsi(close).tsi, coppock: M.coppock(close), kst: M.kst(close).kst, bbp: M.bullBear(bars),
    bop: M.bop(bars), pctb: M.bbPercent(close), bbw: M.bbWidth(close), hv: M.histVol(close), chop: M.choppiness(bars),
    mass: M.massIndex(bars), ulcer: M.ulcer(close), adr: M.adr(bars), ad: M.accDist(bars), cmf: M.cmf(bars),
    cho: M.chaikinOsc(bars), efi: M.efi(bars), eom: M.eom(bars), kvo: M.klinger(bars).kvo, pvt: M.pvt(bars),
    nv: M.netVolume(bars), vo: M.volumeOsc(bars), twap: M.twap(bars, (t) => Math.floor(t / 3600)),
    vip: M.vortex(bars).plus, ce: M.chandelier(bars).long, vs: M.volStop(bars).short, ck: M.chandeKroll(bars).long,
    pc: M.priceChannel(bars).upper, lr: M.linregChannel(close).basis, cz: M.chopZone(bars).v,
  }
  for (const [k, v] of Object.entries(all)) {
    it(`${k}: same length, finite, has values`, () => {
      expect(v.length).toBe(bars.length)
      expect(v.every((x) => x == null || Number.isFinite(x))).toBe(true)
      expect(v.some((x) => x != null)).toBe(true)
    })
  }
  it('bounded oscillators stay in range', () => {
    for (const k of ['uo', 'crsi', 'chop']) expect(all[k].every((x) => x == null || (x >= -1e-9 && x <= 100 + 1e-9))).toBe(true)
    expect(all.cmo.every((x) => x == null || Math.abs(x) <= 100 + 1e-9)).toBe(true)
  })
})

describe('math2 values', () => {
  it('kama / mcginley on a flat line stay flat', () => {
    const flat = new Array(60).fill(5)
    expect(M.kama(flat).filter((x) => x != null).every((x) => x === 5)).toBe(true)
    expect(M.mcginley(flat).filter((x) => x != null).every((x) => Math.abs((x as number) - 5) < 1e-12)).toBe(true)
  })
  it('linreg channel fits a straight line exactly', () => {
    const line = Array.from({ length: 50 }, (_, i) => 2 * i + 1)
    const r = M.linregChannel(line, 20, 2)
    expect(r.basis.slice(0, 30).every((x) => x == null)).toBe(true)
    near(r.basis[49], 99); near(r.upper[49], 99); near(r.lower[30], 61)
  })
  it('cmo / tsi of a rising series are 100', () => {
    const up = Array.from({ length: 80 }, (_, i) => i + 1)
    near(M.cmo(up, 9)[20], 100)
    near(M.tsi(up).tsi[70], 100)
  })
  it('percentRank and swma', () => {
    expect(M.percentRank([1, 2, 3, 4, 2], 4)[4]).toBe(50)
    near(M.swma([1, 2, 3, 4])[3], (1 + 4 + 6 + 4) / 6)
  })
  it('bop, accDist, pvt, netVolume', () => {
    const b: Candle[] = [{ t: 0, o: 1, h: 3, l: 1, c: 2, v: 10 }, { t: 60, o: 2, h: 4, l: 2, c: 4, v: 5 }]
    expect(M.bop(b)).toEqual([0.5, 1])
    expect(M.accDist(b)).toEqual([0, 5])
    expect(M.pvt(b)).toEqual([0, 5])
    expect(M.netVolume(b)).toEqual([null, 5])
  })
  it('twap resets per period', () => {
    const b: Candle[] = [0, 1, 2, 3].map((i) => ({ t: i * 1800, o: i, h: i, l: i, c: i, v: 1 }))
    expect(M.twap(b, (t) => Math.floor(t / 3600))).toEqual([0, 0.5, 2, 2.5])
  })
  it('histVol of a constant-growth series is 0', () => {
    const g = Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i)
    near(M.histVol(g, 10)[25], 0, 1e-6)
  })
  it('crosses', () => {
    expect(M.crosses([1, 3, 1], [2, 2, 2])).toEqual([{ i: 1, dir: 1 }, { i: 2, dir: -1 }])
  })
  it('stops flip with the trend', () => {
    const up = Array.from({ length: 80 }, (_, i) => ({ t: i, o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 1 }))
    const down = up.map((b, i) => ({ ...b, t: 80 + i, o: 80 - i, h: 81 - i, l: 79 - i, c: 79.5 - i }))
    const r = M.chandelier([...up, ...down], 10, 2)
    expect(r.long[60]).not.toBeNull()
    expect(r.short[150]).not.toBeNull()
    expect(r.flips.some((f) => f.dir === -1)).toBe(true)
    const v = M.volStop([...up, ...down], 10, 2)
    expect(v.flips.some((f) => f.dir === -1)).toBe(true)
  })
})
