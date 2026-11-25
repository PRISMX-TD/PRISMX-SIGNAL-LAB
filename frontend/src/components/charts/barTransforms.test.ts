// 非标准图表类型的 K 线变换：手算的小序列 + 2 万根随机游走的性能与时间顺序。
// Bar transforms for non-standard chart types: hand-checked small series, plus speed and time
// order on a 20 000-bar random walk.
import { describe, expect, it } from 'vitest'
import type { Candle } from '../../api/types'
import {
  atr, autoBoxSize, heikinAshi, kagi, lineBreak, pointFigure, renko, transformBars,
  type TransformKind, type XBar,
} from './barTransforms'

const bar = (i: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ t: i * 60, o, h, l, c, v })
// 只有收盘价的序列 / close-only series
const closes = (cs: number[]): Candle[] => cs.map((c, i) => bar(i, c, c, c, c))
const pick = (xs: XBar[], keys: (keyof XBar)[]) =>
  xs.map((x) => Object.fromEntries(keys.map((k) => [k, x[k]])))
const ascendingInts = (xs: XBar[]) =>
  xs.every((x, i) => Number.isInteger(x.t) && (i === 0 || x.t > xs[i - 1].t))

describe('heikinAshi', () => {
  it('首根 haOpen = (o+c)/2，之后按标准公式；保留 t、v / standard HA values', () => {
    const src = [bar(0, 10, 12, 9, 11, 5), bar(1, 11, 14, 10, 13, 6), bar(2, 13, 13.5, 8, 9, 7)]
    expect(heikinAshi(src)).toEqual([
      { t: 0, o: 10.5, h: 12, l: 9, c: 10.5, v: 5, dir: 1 },
      { t: 60, o: 10.5, h: 14, l: 10, c: 12, v: 6, dir: 1 },
      { t: 120, o: 11.25, h: 13.5, l: 8, c: 10.875, v: 7, dir: -1 },
    ])
  })
})

describe('atr / autoBoxSize', () => {
  const src = [bar(0, 10, 12, 9, 11), bar(1, 11, 14, 10, 13), bar(2, 13, 13.5, 8, 9), bar(3, 9, 10, 9, 9.5)]

  it('Wilder ATR：TR = 3, 4, 5.5, 1', () => {
    expect(atr(src, 4)).toBeCloseTo(3.375, 12)
    // 种子 (3+4)/2 = 3.5 → (3.5+5.5)/2 = 4.5 → (4.5+1)/2 = 2.75
    expect(atr(src, 2)).toBeCloseTo(2.75, 12)
    expect(atr(src, 1)).toBeCloseTo(1, 12)
    expect(atr(src, 5)).toBeNull()
    expect(atr(src, 0)).toBeNull()
    expect(atr([], 14)).toBeNull()
  })

  it('各模式与回退：数据不够 / ATR 为 0 / 非法参数 → 最新收盘价 1%，再不行 1', () => {
    expect(autoBoxSize(src, { type: 'atr', length: 2 })).toBeCloseTo(2.75, 12)
    expect(autoBoxSize(src, { type: 'atr', length: 14 })).toBeCloseTo(0.095, 12)
    const flat = Array.from({ length: 20 }, (_, i) => bar(i, 50, 50, 50, 50))
    expect(autoBoxSize(flat, { type: 'atr', length: 14 })).toBeCloseTo(0.5, 12)
    expect(autoBoxSize(src, { type: 'fixed', size: 0.25 })).toBe(0.25)
    expect(autoBoxSize(src, { type: 'fixed', size: 0 })).toBeCloseTo(0.095, 12)
    expect(autoBoxSize(src, { type: 'fixed', size: NaN })).toBeCloseTo(0.095, 12)
    expect(autoBoxSize(src, { type: 'fixed', size: -1 })).toBeCloseTo(0.095, 12)
    expect(autoBoxSize(closes([200]), { type: 'percent', pct: 2 })).toBe(4)
    expect(autoBoxSize(closes([200]), { type: 'percent', pct: 0 })).toBe(2)
    expect(autoBoxSize([], { type: 'atr', length: 14 })).toBe(1)
    expect(autoBoxSize([], { type: 'percent', pct: 1 })).toBe(1)
    expect(autoBoxSize(closes([0]), { type: 'fixed', size: 0 })).toBe(1)
  })

  it('tick 取整到最小变动价位的整数倍，至少 1 个 tick / rounds to tick, min one tick', () => {
    expect(autoBoxSize(src, { type: 'fixed', size: 0.123 }, 0.05)).toBe(0.1)
    expect(autoBoxSize(src, { type: 'fixed', size: 0.01 }, 0.05)).toBe(0.05)
    expect(autoBoxSize(src, { type: 'fixed', size: 0.3 }, 0.1)).toBe(0.3)
  })
})

describe('renko', () => {
  const series = closes([100, 100.5, 101.2, 103.7, 103.1, 102.2, 101.9, 100.4, 104])

  it('顺势 1 格出砖、反转要 2 格、小波动不出砖；量按砖分 / up run, 2-box reversal, volume', () => {
    const out = renko(series, { box: 1 })
    expect(pick(out, ['t', 'o', 'c', 'h', 'l', 'dir', 'v', 'box'])).toEqual([
      { t: 120, o: 100, c: 101, h: 101, l: 100, dir: 1, v: 3, box: 1 },
      { t: 180, o: 101, c: 102, h: 102, l: 101, dir: 1, v: 0.5, box: 1 },
      { t: 181, o: 102, c: 103, h: 103, l: 102, dir: 1, v: 0.5, box: 1 },
      // 103 顶部回落 1.8（101.9）不反转，跌到 100.4 才出一块下跌砖 102→101
      { t: 420, o: 102, c: 101, h: 102, l: 101, dir: -1, v: 4, box: 1 },
      { t: 480, o: 102, c: 103, h: 103, l: 102, dir: 1, v: 0.5, box: 1 },
      { t: 481, o: 103, c: 104, h: 104, l: 103, dir: 1, v: 0.5, box: 1 },
    ])
  })

  it('先跌：第一块下跌砖只要 1 格，向上反转要 2 格 / first brick down, then 2-box reversal up', () => {
    expect(pick(renko(closes([100, 98.5, 100.5]), { box: 1 }), ['o', 'c', 'dir'])).toEqual([
      { o: 100, c: 99, dir: -1 },
    ])
    expect(pick(renko(closes([100, 98.5, 100.5, 101]), { box: 1 }), ['o', 'c', 'dir'])).toEqual([
      { o: 100, c: 99, dir: -1 },
      { o: 100, c: 101, dir: 1 },
    ])
  })

  it('波动不满 1 格不出砖；空输入、单根、非法格值 / no bricks on small moves, bad input', () => {
    expect(renko(closes([100, 100.9, 99.1, 100.99, 99.01]), { box: 1 })).toEqual([])
    expect(renko([], { box: 1 })).toEqual([])
    expect(renko(closes([100]), { box: 1 })).toEqual([])
    expect(renko(series, { box: 0 })).toEqual([])
    expect(renko(series, { box: NaN })).toEqual([])
  })

  it('影线：期间最低价给第一块砖的下影，最高价给最后一块的上影 / wicks', () => {
    const src = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 100.4, 98.6, 100.3),
      bar(2, 100.3, 101.8, 100.1, 101.5),
      bar(3, 101.5, 103.4, 101.2, 103.2),
    ]
    expect(pick(renko(src, { box: 1, wicks: true }), ['t', 'o', 'c', 'h', 'l'])).toEqual([
      { t: 120, o: 100, c: 101, h: 101.8, l: 98.6 },
      { t: 180, o: 101, c: 102, h: 102, l: 101 },
      { t: 181, o: 102, c: 103, h: 103.4, l: 102 },
    ])
    expect(pick(renko(src, { box: 1 }), ['h', 'l'])).toEqual([
      { h: 101, l: 100 },
      { h: 102, l: 101 },
      { h: 103, l: 102 },
    ])
  })

  it('下跌砖的影线：第一块拿上影、最后一块拿下影 / down-brick wicks', () => {
    const src = [bar(0, 100, 100, 100, 100), bar(1, 100, 100.7, 97.6, 97.8)]
    expect(pick(renko(src, { box: 1, wicks: true }), ['o', 'c', 'h', 'l'])).toEqual([
      { o: 100, c: 99, h: 100.7, l: 99 },
      { o: 99, c: 98, h: 99, l: 97.6 },
    ])
  })

  it("'hl' 取价：最高价出砖，最低价反转；同样的 bar 用收盘价一块都不出", () => {
    const src = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 102.3, 99.5, 100.2),
      bar(2, 100.2, 101.5, 99.4, 99.8),
    ]
    expect(pick(renko(src, { box: 1, source: 'hl' }), ['t', 'o', 'c', 'dir'])).toEqual([
      { t: 60, o: 100, c: 101, dir: 1 },
      { t: 61, o: 101, c: 102, dir: 1 },
      { t: 120, o: 101, c: 100, dir: -1 },
    ])
    expect(renko(src, { box: 1 })).toEqual([])
  })

  it('一根源 bar 出很多砖：t 依次 +1，后面的砖被顺延，始终严格递增 / burst keeps t ascending', () => {
    const src: Candle[] = [
      { t: 0, o: 100, h: 100, l: 100, c: 100, v: 1 },
      { t: 60, o: 100, h: 150, l: 100, c: 150, v: 1 },
      { t: 100, o: 150, h: 160, l: 150, c: 160, v: 1 },
      { t: 200, o: 160, h: 161, l: 160, c: 161, v: 1 },
    ]
    const out = renko(src, { box: 1 })
    expect(out).toHaveLength(61)
    expect(out[0].t).toBe(60)
    expect(out[49].t).toBe(109)
    expect(out[50].t).toBe(110)
    expect(out[59].t).toBe(119)
    expect(out[60].t).toBe(200)
    expect(ascendingInts(out)).toBe(true)
  })

  it('价位由整数 k 算出，无浮点漂移 / no float drift', () => {
    const out = renko(closes([1.1, 2.1, 1.75]), { box: 0.1 })
    expect(out.slice(0, 10).map((x) => x.c)).toEqual([1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.1])
    expect(out.slice(10).map((x) => [x.o, x.c])).toEqual([[2, 1.9], [1.9, 1.8]])
  })
})

describe('lineBreak', () => {
  it('首条线、顺势新线、三线反转（反转线从上一条线的起点画起）/ first lines + 3-line reversal', () => {
    const out = lineBreak(closes([10, 11, 12, 13, 12.5, 11.5, 9.5, 14]))
    expect(pick(out, ['t', 'o', 'c', 'h', 'l', 'dir', 'v'])).toEqual([
      { t: 60, o: 10, c: 11, h: 11, l: 10, dir: 1, v: 2 },
      { t: 120, o: 11, c: 12, h: 12, l: 11, dir: 1, v: 1 },
      { t: 180, o: 12, c: 13, h: 13, l: 12, dir: 1, v: 1 },
      // 12.5、11.5 都没跌破三条线的最低 10；9.5 才反转
      { t: 360, o: 12, c: 9.5, h: 12, l: 9.5, dir: -1, v: 3 },
      // 最近三条线最高 13，14 突破 → 反转向上，从 12 画起
      { t: 420, o: 12, c: 14, h: 14, l: 12, dir: 1, v: 1 },
    ])
  })

  it('反转要突破最近 N 条线：2 线与 3 线结果不同 / N matters', () => {
    const src = closes([10, 11, 12, 13, 10.9])
    expect(lineBreak(src, { lines: 2 }).map((x) => [x.o, x.c])).toEqual([[10, 11], [11, 12], [12, 13], [12, 10.9]])
    expect(lineBreak(src, { lines: 3 }).map((x) => [x.o, x.c])).toEqual([[10, 11], [11, 12], [12, 13]])
    expect(lineBreak(src).length).toBe(3)
  })

  it('下跌续线、首条线向下、平盘不画 / down continuation, first line down, equal closes', () => {
    expect(lineBreak(closes([10, 10, 9, 8, 8, 8.5])).map((x) => [x.t, x.o, x.c, x.dir])).toEqual([
      [120, 10, 9, -1],
      [180, 9, 8, -1],
    ])
    expect(lineBreak([])).toEqual([])
    expect(lineBreak(closes([5, 5, 5]))).toEqual([])
  })
})

describe('kagi', () => {
  it('阴阳切换与在肩 / 腰处拆段 / yang-yin switching and split', () => {
    const out = kagi(closes([100, 101, 103, 104, 101.5, 100, 102.5, 99, 98, 101, 103]), { reversal: 2 })
    expect(pick(out, ['t', 'o', 'c', 'h', 'l', 'dir', 'thick', 'v'])).toEqual([
      { t: 120, o: 100, c: 104, h: 104, l: 100, dir: 1, thick: true, v: 4 },
      { t: 240, o: 104, c: 100, h: 104, l: 100, dir: -1, thick: true, v: 2 },
      { t: 360, o: 100, c: 102.5, h: 102.5, l: 100, dir: 1, thick: true, v: 1 },
      // 跌破上一个腰 100：在 100 处拆成粗 / 细两段，t 连续
      { t: 420, o: 102.5, c: 100, h: 102.5, l: 100, dir: -1, thick: true, v: 0 },
      { t: 421, o: 100, c: 98, h: 100, l: 98, dir: -1, thick: false, v: 2 },
      // 向上反转仍是细线，直到突破上一个肩 102.5
      { t: 540, o: 98, c: 102.5, h: 102.5, l: 98, dir: 1, thick: false, v: 1 },
      { t: 600, o: 102.5, c: 103, h: 103, l: 102.5, dir: 1, thick: true, v: 1 },
    ])
  })

  it('不满反转幅度不画、不反转；第一条向下为阴 / below-reversal moves, first line down = yin', () => {
    expect(kagi(closes([100, 101, 99, 101.9]), { reversal: 2 })).toEqual([])
    const out = kagi(closes([100, 97, 98.5, 96]), { reversal: 2 })
    expect(pick(out, ['o', 'c', 'dir', 'thick'])).toEqual([{ o: 100, c: 96, dir: -1, thick: false }])
    expect(kagi([], { reversal: 1 })).toEqual([])
    expect(kagi(closes([1, 5]), { reversal: 0 })).toEqual([])
  })

  it('细线向上直接越过肩：同一根源 bar 拆成两段，t 连续 / split inside one source bar', () => {
    // 100→104 阳，104→98 跌破腰？没有腰（第一条下行线），保持粗；98→103 粗；
    // 103→95 跌破腰 98 → 粗/细；95→110 越过肩 103 → 细/粗，同一根 bar
    const out = kagi(closes([100, 104, 98, 103, 95, 110]), { reversal: 2 })
    expect(pick(out, ['t', 'o', 'c', 'thick'])).toEqual([
      { t: 60, o: 100, c: 104, thick: true },
      { t: 120, o: 104, c: 98, thick: true },
      { t: 180, o: 98, c: 103, thick: true },
      { t: 240, o: 103, c: 98, thick: true },
      { t: 241, o: 98, c: 95, thick: false },
      { t: 300, o: 95, c: 103, thick: false },
      { t: 301, o: 103, c: 110, thick: true },
    ])
  })
})

describe('pointFigure', () => {
  it('收盘价：X 列延长、3 格反转开 O 列（从顶下一格起）/ columns and 3-box reversal', () => {
    const out = pointFigure(closes([100, 101.5, 103.2, 101.5, 100, 99.5, 98.9, 101, 102]), { box: 1 })
    expect(pick(out, ['t', 'o', 'c', 'h', 'l', 'dir', 'boxes', 'box', 'v'])).toEqual([
      { t: 60, o: 101, c: 103, h: 103, l: 101, dir: 1, boxes: 3, box: 1, v: 4 },
      { t: 240, o: 102, c: 99, h: 102, l: 99, dir: -1, boxes: 4, box: 1, v: 4 },
      { t: 480, o: 100, c: 102, h: 102, l: 100, dir: 1, boxes: 3, box: 1, v: 1 },
    ])
  })

  it('反转格数可调：1 格反转 / reversal size', () => {
    const out = pointFigure(closes([100, 103, 102, 104]), { box: 1, reversal: 1 })
    expect(pick(out, ['o', 'c', 'dir', 'boxes'])).toEqual([
      { o: 101, c: 103, dir: 1, boxes: 3 },
      { o: 102, c: 102, dir: -1, boxes: 1 },
      { o: 103, c: 104, dir: 1, boxes: 2 },
    ])
  })

  it("'hl' 取价：X 列先看最高价延长，再看最低价反转；O 列反之", () => {
    const src = [
      bar(0, 100, 100, 100, 100),
      bar(1, 100, 103.5, 99.2, 103),
      bar(2, 103, 104.2, 100.5, 101),
      bar(3, 101, 103.9, 100.6, 101),
      // O 列里：最低价能延长就不看最高价（104.1 本来也够反转）
      bar(4, 101, 104.1, 98.5, 99),
    ]
    expect(pick(pointFigure(src, { box: 1, source: 'hl' }), ['t', 'o', 'c', 'dir', 'boxes'])).toEqual([
      { t: 60, o: 101, c: 104, dir: 1, boxes: 4 },
      { t: 180, o: 103, c: 99, dir: -1, boxes: 5 },
    ])
    expect(pick(pointFigure(src, { box: 1 }), ['t', 'o', 'c', 'dir', 'boxes'])).toEqual([
      { t: 60, o: 101, c: 103, dir: 1, boxes: 3 },
      { t: 240, o: 102, c: 99, dir: -1, boxes: 4 },
    ])
  })

  it('第一列向下；格线对齐 box 的整数倍且无漂移；空输入 / first column down, grid, empty', () => {
    const out = pointFigure(closes([1.23, 1.0]), { box: 0.1 })
    expect(pick(out, ['o', 'c', 'dir', 'boxes'])).toEqual([{ o: 1.1, c: 1, dir: -1, boxes: 2 }])
    expect(pointFigure([], { box: 1 })).toEqual([])
    expect(pointFigure(closes([1, 9]), { box: 0 })).toEqual([])
  })
})

describe('transformBars', () => {
  const src = closes([100, 100.5, 101.2, 103.7, 103.1, 102.2, 101.9, 100.4, 104])

  it('按类型调度，格值来自 autoBoxSize / dispatches with autoBoxSize', () => {
    expect(transformBars('renko', src, { renko: { boxMode: { type: 'fixed', size: 1 } } })).toEqual(
      renko(src, { box: 1 }),
    )
    expect(
      transformBars('renko', src, { renko: { boxMode: { type: 'fixed', size: 1 }, source: 'hl', wicks: true } }),
    ).toEqual(renko(src, { box: 1, source: 'hl', wicks: true }))
    expect(transformBars('pointFigure', src, { pointFigure: { boxMode: { type: 'fixed', size: 1 } } })).toEqual(
      pointFigure(src, { box: 1, reversal: 3 }),
    )
    expect(
      transformBars('pointFigure', src, { pointFigure: { boxMode: { type: 'fixed', size: 0.5 }, reversal: 2 } }),
    ).toEqual(pointFigure(src, { box: 0.5, reversal: 2 }))
    expect(transformBars('kagi', src, { kagi: { reversalMode: { type: 'fixed', size: 2 } } })).toEqual(
      kagi(src, { reversal: 2 }),
    )
    expect(transformBars('lineBreak', src)).toEqual(lineBreak(src, { lines: 3 }))
    expect(transformBars('lineBreak', src, { lineBreak: { lines: 2 } })).toEqual(lineBreak(src, { lines: 2 }))
    // tick 取整 / tick rounding: 1.04 → 1
    expect(transformBars('renko', src, { tick: 0.5 })).toEqual(renko(src, { box: 1 }))
    expect(transformBars('heikinAshi', src)).toEqual(heikinAshi(src))
    // 默认 ATR(14)：只有 9 根 → 回退最新收盘价的 1% = 1.04
    expect(transformBars('renko', src)).toEqual(renko(src, { box: 1.04 }))
    expect(transformBars('none', src)).toEqual(src.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v })))
  })

  it('空输入一律返回空数组 / empty input', () => {
    const kinds: TransformKind[] = ['none', 'heikinAshi', 'renko', 'lineBreak', 'kagi', 'pointFigure']
    for (const k of kinds) expect(transformBars(k, [])).toEqual([])
    expect(heikinAshi([])).toEqual([])
  })
})

describe('20 000 根随机游走 / 20 000-bar random walk', () => {
  // 固定种子的伪随机数，结果可复现 / seeded PRNG for reproducible runs
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const N = 20_000
  const src: Candle[] = []
  let price = 2000
  for (let i = 0; i < N; i++) {
    const o = price
    const c = o + (rnd() + rnd() + rnd() - 1.5) * 2
    const h = Math.max(o, c) + rnd() * 0.8
    const l = Math.min(o, c) - rnd() * 0.8
    src.push({ t: 1_700_000_000 + i * 60, o, h, l, c, v: Math.floor(rnd() * 100) })
    price = c
  }
  const totalV = src.reduce((s, b) => s + b.v, 0)

  const runAll = () => ({
    heikinAshi: transformBars('heikinAshi', src),
    renko: transformBars('renko', src),
    renkoHlWicks: transformBars('renko', src, { renko: { source: 'hl', wicks: true } }),
    lineBreak: transformBars('lineBreak', src),
    kagi: transformBars('kagi', src),
    pointFigure: transformBars('pointFigure', src),
    pointFigureHl: transformBars('pointFigure', src, { pointFigure: { source: 'hl' } }),
  })

  it('全部变换合计 < 100 ms，t 严格递增、数值有限 / all transforms < 100 ms, ascending t', () => {
    // 先预热一次再取 3 次最快，构建机（Vercel / CI）较慢放宽到 300 ms
    // Warm up, take the best of 3; build machines (Vercel / CI) are slower, so allow 300 ms there.
    let res = runAll()
    let ms = Infinity
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      res = runAll()
      ms = Math.min(ms, performance.now() - t0)
    }
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
    const budget = env.CI || env.VERCEL ? 300 : 100
    expect(ms).toBeLessThan(budget)
    for (const [name, out] of Object.entries(res)) {
      expect(out.length, name).toBeGreaterThan(name === 'heikinAshi' ? N - 1 : 50)
      expect(ascendingInts(out), name).toBe(true)
      const bad = out.findIndex(
        (x) => !Number.isFinite(x.o + x.h + x.l + x.c + x.v) || x.h < Math.max(x.o, x.c) || x.l > Math.min(x.o, x.c),
      )
      expect(bad, name).toBe(-1)
    }
    // 列 / 线段型：成交量全部分完；砖 / 线型：只差最后未完成的那一段
    // Columns / segments account for all volume; bricks / lines only miss the unfinished tail.
    const sumV = (xs: XBar[]) => xs.reduce((s, x) => s + x.v, 0)
    expect(sumV(res.kagi)).toBeCloseTo(totalV, 6)
    expect(sumV(res.pointFigure)).toBeCloseTo(totalV, 6)
    expect(sumV(res.renko)).toBeLessThanOrEqual(totalV + 1e-6)
    expect(sumV(res.lineBreak)).toBeLessThanOrEqual(totalV + 1e-6)
    // P&F 每列格数与 o/c 一致 / P&F boxes match o/c
    for (const x of res.pointFigure) {
      expect(Math.round(Math.abs(x.c - x.o) / x.box!) + 1).toBe(x.boxes)
    }
  })
})
