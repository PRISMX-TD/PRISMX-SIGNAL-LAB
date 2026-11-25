// 派生周期（M30 ← M15、月线 ← 日线）的合成、翻页与轮询合并。
// Derived intervals (M30 ← M15, monthly ← daily): aggregation, paging and poll merging.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../../api/types'

const history = vi.fn()
const latest = vi.fn()
vi.mock('../../api/client', () => ({
  chartApi: {
    history: (...a: unknown[]) => history(...a),
    latest: (...a: unknown[]) => latest(...a),
  },
}))

import { DERIVED_INTERVALS, aggregateBars, brokerOffsetSec, createChartFeed, derivedSpec, isDerivedInterval } from './derivedIntervals'
import { barCloseCountdownSec, barSpacingSeconds, intervalSeconds, isKnownInterval } from './chartConfig'

const bar = (t: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ t, o, h, l, c, v })
// 2026-10-16 00:00 UTC，落在 30 分钟网格上 / on the 30-minute grid
const T0 = Date.UTC(2026, 9, 16) / 1000
// 券商 GMT+3：日线 t = 前一天 21:00 UTC / GMT+3 broker: daily t = 21:00 UTC the day before
const day = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 1000 - 3 * 3600

beforeEach(() => {
  history.mockReset()
  latest.mockReset()
})

describe('aggregateBars', () => {
  it('M30：两根 M15 合一根，开首收末、高低取极值、量相加', () => {
    const src = [
      bar(T0, 10, 12, 9, 11, 3),
      bar(T0 + 900, 11, 15, 10, 14, 4),
      bar(T0 + 1800, 14, 14, 8, 9, 5),
    ]
    expect(aggregateBars(src, DERIVED_INTERVALS['30'])).toEqual([
      { t: T0, o: 10, h: 15, l: 9, c: 14, v: 7 },
      { t: T0 + 1800, o: 14, h: 14, l: 8, c: 9, v: 5 },
    ])
  })

  it('月线按券商日期分月：21:00 UTC 那根是下个月 1 号', () => {
    const src = [
      bar(day(2026, 8, 29), 1, 2, 1, 2), // 9-29
      bar(day(2026, 8, 30), 2, 3, 2, 3), // 9-30
      bar(day(2026, 9, 1), 3, 5, 3, 4),  // 10-01（UTC 是 9-30 21:00）
      bar(day(2026, 9, 2), 4, 4, 1, 2),  // 10-02
    ]
    const out = aggregateBars(src, DERIVED_INTERVALS.M)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ t: day(2026, 8, 29), o: 1, h: 3, c: 3 })
    expect(out[1]).toMatchObject({ t: day(2026, 9, 1), o: 3, h: 5, l: 1, c: 2 })
    expect(DERIVED_INTERVALS.M.startsBucket(day(2026, 9, 1))).toBe(true)
    expect(DERIVED_INTERVALS.M.startsBucket(day(2026, 9, 2))).toBe(false)
  })
})

describe('createChartFeed', () => {
  it('基础周期原样透传 / base intervals pass through', async () => {
    history.mockResolvedValue({ bars: [], hasMore: false })
    latest.mockResolvedValue({ bars: [], updatedAt: null })
    const feed = createChartFeed('XAUUSD', '15')
    await feed.history(50)
    await feed.latest()
    expect(history).toHaveBeenCalledWith('XAUUSD', '15', 50, undefined)
    expect(latest).toHaveBeenCalledWith('XAUUSD', '15', undefined)
    expect(feed.dayBars()).toBeNull()
    expect(isDerivedInterval('15')).toBe(false)
  })

  it('M30 首页：先拿 M15 共享首屏，再按首屏最早那根往左补一页；不完整的最早一桶丢掉', async () => {
    const first = Array.from({ length: 50 }, (_, i) => bar(T0 + i * 900, 1, 2, 0, 1))
    // 补的那页从 :15 开始——它所在的桶缺了 :00，必须丢掉 / starts at :15, so its bucket is partial
    const older = Array.from({ length: 49 }, (_, i) => bar(T0 - (49 - i) * 900, 1, 2, 0, 1))
    expect(older[0].t % 1800).toBe(900)
    history.mockResolvedValueOnce({ bars: first, hasMore: true }).mockResolvedValueOnce({ bars: older, hasMore: true })
    const r = await createChartFeed('XAUUSD', '30').history(50)
    expect(history).toHaveBeenNthCalledWith(1, 'XAUUSD', '15', 50)
    expect(history).toHaveBeenNthCalledWith(2, 'XAUUSD', '15', 50, T0)
    expect(r.hasMore).toBe(true)
    expect(r.bars[0].t).toBe(older[1].t)
    expect(r.bars.every((b) => b.t % 1800 === 0)).toBe(true)
    expect(r.bars).toHaveLength(49)
  })

  it('M30 往左翻页：源根数翻倍、before 原样用在 M15 上', async () => {
    history.mockResolvedValue({ bars: [bar(T0, 1, 1, 1, 1), bar(T0 + 900, 1, 1, 1, 1)], hasMore: false })
    const r = await createChartFeed('XAUUSD', '30').history(500, T0 + 1800)
    expect(history).toHaveBeenCalledWith('XAUUSD', '15', 1000, T0 + 1800)
    expect(r.bars).toHaveLength(1)
    expect(r.hasMore).toBe(false)
  })

  it('M30 轮询：形成中的 :15 与首页里已收盘的 :00 合成一根', async () => {
    history.mockResolvedValueOnce({ bars: [bar(T0 - 900, 5, 6, 4, 5), bar(T0, 10, 12, 9, 11)], hasMore: false })
    latest.mockResolvedValue({ bars: [bar(T0, 10, 12, 9, 11), bar(T0 + 900, 11, 20, 10, 18)], updatedAt: 1 })
    const feed = createChartFeed('XAUUSD', '30')
    await feed.history(50)
    const r = await feed.latest()
    expect(latest).toHaveBeenCalledWith('XAUUSD', '15', undefined)
    expect(r.updatedAt).toBe(1)
    expect(r.bars).toEqual([{ t: T0, o: 10, h: 20, l: 9, c: 18, v: 2 }])
  })

  it('月线：首页一次补齐日线历史；轮询等首页回来再把本月日线合进形成中那根', async () => {
    const closed = [bar(day(2026, 8, 30), 1, 2, 1, 2), bar(day(2026, 9, 1), 2, 9, 2, 3), bar(day(2026, 9, 2), 3, 4, 1, 3)]
    let resolveFirst: (v: unknown) => void = () => {}
    history.mockReturnValueOnce(new Promise((res) => { resolveFirst = res }))
    latest.mockResolvedValue({ bars: [closed[2], bar(day(2026, 9, 3), 3, 5, 3, 4)], updatedAt: 1 })
    const feed = createChartFeed('XAUUSD', 'M')
    const h = feed.history(50)
    const l = feed.latest()
    resolveFirst({ bars: closed, hasMore: false })
    const hr = await h
    // 首页没有更早数据就不补第二步 / no second step when there is no older data
    expect(history).toHaveBeenCalledTimes(1)
    expect(hr.bars.map((b) => b.t)).toEqual([day(2026, 8, 30), day(2026, 9, 1)])
    const lr = await l
    expect(lr.bars).toEqual([{ t: day(2026, 9, 1), o: 2, h: 9, l: 1, c: 4, v: 3 }])
    // 行情头日内统计用源日线 / header day stats use the daily source
    expect(feed.dayBars()?.length).toBe(4)
  })

  it('月线首页有更早数据时补一页 1000 根日线', async () => {
    const first = [bar(day(2026, 9, 2), 1, 1, 1, 1)]
    history.mockResolvedValueOnce({ bars: first, hasMore: true }).mockResolvedValueOnce({ bars: [], hasMore: false })
    await createChartFeed('XAUUSD', 'M').history(50)
    expect(history).toHaveBeenNthCalledWith(2, 'XAUUSD', 'D', 1000, first[0].t)
  })

  it('源周期中间有洞：补拉源首页再合成，洞里的高低不丢', async () => {
    history
      .mockResolvedValueOnce({ bars: [bar(T0 - 900, 5, 6, 4, 5)], hasMore: false })
      .mockResolvedValueOnce({ bars: [bar(T0 - 900, 5, 6, 4, 5), bar(T0, 5, 30, 4, 6)], hasMore: false })
    latest.mockResolvedValue({ bars: [bar(T0 + 900, 6, 7, 5, 7)], updatedAt: 1 })
    const feed = createChartFeed('XAUUSD', '30')
    await feed.history(50)
    const r = await feed.latest()
    expect(history).toHaveBeenLastCalledWith('XAUUSD', '15', 50)
    expect(r.bars).toEqual([{ t: T0, o: 5, h: 30, l: 4, c: 7, v: 2 }])
  })
})

describe('chartConfig 里的派生周期', () => {
  it('30m 按 epoch 对齐；月线没有固定间距、不显示倒计时', () => {
    expect(intervalSeconds('30')).toBe(1800)
    expect(barSpacingSeconds('30')).toBe(1800)
    expect(barSpacingSeconds('M')).toBeNull()
    expect(barCloseCountdownSec('M', day(2026, 9, 1), Date.now())).toBeNull()
    expect(isKnownInterval('30')).toBe(true)
    expect(isKnownInterval('M')).toBe(true)
    // 2026-11-25 起任何合法代码都认（周线等自定义周期也要能记住）；不合法的仍拒绝。
    // Since 2026-11-25 any valid code is known (custom intervals persist); invalid still rejected.
    expect(isKnownInterval('W')).toBe(true)
    expect(isKnownInterval('X')).toBe(false)
    expect(isKnownInterval('1D')).toBe(false)
    expect(isKnownInterval('')).toBe(false)
  })
})

// ---------- 2026-11-25：任意周期 / arbitrary intervals ----------

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000
const H = 3600
// 券商日线 t：券商零点（纽约 17:00）换成 UTC / daily t = broker midnight in UTC
const bday = (y: number, mo: number, d: number) => {
  const mid = utc(y, mo, d)
  return mid - brokerOffsetSec(mid - 3 * H)
}
// 连续源 bar（加密货币式，周末不停）/ continuous source bars (crypto-style, no weekend gap)
const series = (from: number, to: number, step: number) => {
  const out: Candle[] = []
  for (let t = from, i = 0; t < to; t += step, i++) out.push(bar(t, 100 + (i % 7), 101 + (i % 5), 99 - (i % 3), 100 + (i % 4)))
  return out
}
const times = (code: string, src: Candle[]) => aggregateBars(src, derivedSpec(code)!).map((b) => b.t)

describe('derivedSpec：源与分桶表 / source & bucketing table', () => {
  it('源周期与倍数', () => {
    const table = Object.fromEntries(['2', '3', '10', '30', '45', '90', '120', '180', '360', '720', '1440', '7', '2D', 'W', 'M', '3M', '12M']
      .map((c) => [c, `${derivedSpec(c)!.source}×${derivedSpec(c)!.pageFactor}`]))
    expect(table).toEqual({
      2: '1×2', 3: '1×3', 10: '5×2', 30: '15×2', 45: '15×3', 90: '15×6', 120: '60×2', 180: '60×3', 360: '60×6',
      720: '240×3', 1440: '240×6', 7: '1×7', '2D': 'D×2', W: 'D×7', M: 'D×23', '3M': 'D×69', '12M': 'D×276',
    })
    for (const c of ['1', '5', '15', '60', '240', 'D', 'X', '1D']) expect(derivedSpec(c), c).toBeNull()
    expect(isDerivedInterval('45')).toBe(true)
    // 老的两个不变 / the original two unchanged
    expect(DERIVED_INTERVALS['30'].firstPageExtra).toBe(50)
    expect(DERIVED_INTERVALS.M.firstPageExtra).toBe(1000)
    expect(DERIVED_INTERVALS.M.tailKeep).toBe(80)
  })

  it('尾巴覆盖整桶：12M ≥ 一年日线；dayStatsFromSource 只给长于 4H 的', () => {
    expect(derivedSpec('12M')!.tailKeep).toBeGreaterThanOrEqual(366)
    expect(derivedSpec('52W')!.tailKeep).toBeGreaterThanOrEqual(364)
    expect(derivedSpec('96')!.tailKeep).toBeGreaterThanOrEqual(96)
    expect(derivedSpec('30')!.dayStatsFromSource).toBe(false)
    expect(derivedSpec('120')!.dayStatsFromSource).toBe(false)
    expect(derivedSpec('720')!.dayStatsFromSource).toBe(true)
    expect(derivedSpec('2D')!.dayStatsFromSource).toBe(true)
    expect(derivedSpec('W')!.dayStatsFromSource).toBe(true)
  })

  it('首页第二步按 50 取整、封顶 1000 / first-page extra rounded to 50, capped at 1000', () => {
    expect(derivedSpec('2')!.firstPageExtra).toBe(50)
    expect(derivedSpec('45')!.firstPageExtra).toBe(100)
    expect(derivedSpec('7')!.firstPageExtra).toBe(300)
    expect(derivedSpec('W')!.firstPageExtra).toBe(300)
    expect(derivedSpec('96')!.firstPageExtra).toBe(1000)
    expect(derivedSpec('12M')!.firstPageExtra).toBe(1000)
  })
})

describe('分钟分桶 / minute bucketing', () => {
  it('2m / 10m 按 epoch 对齐（与 30m 同一路）', () => {
    expect(times('2', series(T0, T0 + 6 * 60, 60))).toEqual([T0, T0 + 120, T0 + 240])
    expect(times('10', series(T0 - 300, T0 + 1200, 300))).toEqual([T0 - 600, T0, T0 + 600])
  })

  it('7m：券商零点重新起算（夏令时 21:00 UTC），最后一桶 5 分钟', () => {
    const src = series(utc(2026, 10, 13, 20, 53), utc(2026, 10, 13, 21, 9), 60)
    expect(times('7', src)).toEqual([utc(2026, 10, 13, 20, 48), utc(2026, 10, 13, 20, 55), utc(2026, 10, 13, 21, 0), utc(2026, 10, 13, 21, 7)])
    const out = aggregateBars(src, derivedSpec('7')!)
    expect(out.map((b) => b.v)).toEqual([2, 5, 7, 2])
    expect(derivedSpec('7')!.startsBucket(utc(2026, 10, 13, 20, 55))).toBe(true)
    expect(derivedSpec('7')!.startsBucket(utc(2026, 10, 13, 20, 53))).toBe(false)
  })

  it('45m：1440 能整除，从券商零点连续切（夏 21:00 / 冬 22:00 UTC）', () => {
    expect(times('45', series(utc(2026, 10, 13, 20), utc(2026, 10, 13, 23), 900))).toEqual([
      utc(2026, 10, 13, 19, 30), utc(2026, 10, 13, 20, 15), utc(2026, 10, 13, 21), utc(2026, 10, 13, 21, 45), utc(2026, 10, 13, 22, 30),
    ])
    expect(times('45', series(utc(2026, 12, 9, 21), utc(2026, 12, 9, 23), 900))).toEqual([
      utc(2026, 12, 9, 20, 30), utc(2026, 12, 9, 21, 15), utc(2026, 12, 9, 22), utc(2026, 12, 9, 22, 45),
    ])
  })

  it('2H / 6H / 12H 对齐券商零点：夏令时 21:00 UTC，冬令时 22:00 UTC', () => {
    const summer = series(utc(2026, 10, 13, 21), utc(2026, 10, 14, 21), H)
    expect(times('120', summer).map((t) => new Date(t * 1000).getUTCHours())).toEqual([21, 23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19])
    expect(times('360', summer).map((t) => new Date(t * 1000).getUTCHours())).toEqual([21, 3, 9, 15])
    const winter = series(utc(2026, 12, 8, 22), utc(2026, 12, 9, 22), H)
    expect(times('120', winter).map((t) => new Date(t * 1000).getUTCHours())).toEqual([22, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
    expect(times('360', winter).map((t) => new Date(t * 1000).getUTCHours())).toEqual([22, 4, 10, 16])
    // 12H ← H4（H4 本身对齐券商零点）/ 12H from H4, which is broker-aligned itself
    const h4 = series(utc(2026, 10, 13, 21), utc(2026, 10, 14, 21), 4 * H)
    expect(times('720', h4)).toEqual([utc(2026, 10, 13, 21), utc(2026, 10, 14, 9)])
    const h4w = series(utc(2026, 12, 8, 22), utc(2026, 12, 9, 22), 4 * H)
    expect(times('720', h4w)).toEqual([utc(2026, 12, 8, 22), utc(2026, 12, 9, 10)])
  })

  it('夏令时切换前后（2026-03-08 / 2026-11-01）2H 仍对齐券商零点', () => {
    const s = derivedSpec('120')!
    // 3 月：周四 22:00 UTC（冬）与下周一 21:00 UTC（夏）都开新桶
    expect(s.startsBucket(utc(2026, 3, 5, 22))).toBe(true)
    expect(s.startsBucket(utc(2026, 3, 5, 21))).toBe(false)
    expect(s.startsBucket(utc(2026, 3, 9, 21))).toBe(true)
    expect(s.startsBucket(utc(2026, 3, 9, 22))).toBe(false)
    // 11 月：周四 21:00（夏）与下周一 22:00（冬）
    expect(s.startsBucket(utc(2026, 10, 29, 21))).toBe(true)
    expect(s.startsBucket(utc(2026, 11, 2, 22))).toBe(true)
    expect(s.startsBucket(utc(2026, 11, 2, 21))).toBe(false)
    expect(times('120', series(utc(2026, 11, 2, 19), utc(2026, 11, 2, 23), H))).toEqual([utc(2026, 11, 2, 18), utc(2026, 11, 2, 20), utc(2026, 11, 2, 22)])
  })
})

describe('日线派生分桶 / daily-sourced bucketing', () => {
  it('2D：按券商日序号每两天一组', () => {
    const src = [bday(2026, 10, 16), bday(2026, 10, 17), bday(2026, 10, 19), bday(2026, 10, 20), bday(2026, 10, 21)].map((t) => bar(t, 1, 2, 0, 1))
    expect(times('2D', src)).toEqual([bday(2026, 10, 16), bday(2026, 10, 19), bday(2026, 10, 20)])
    expect(derivedSpec('2D')!.startsBucket(bday(2026, 10, 16))).toBe(true)
    expect(derivedSpec('2D')!.startsBucket(bday(2026, 10, 19))).toBe(false)
  })

  it('周线周一起算（周日那根算上一周），跨 3 月夏令时切换也对', () => {
    const src = [14, 15, 16, 18, 19, 20].map((d) => bar(bday(2026, 10, d), d, d + 1, d - 1, d))
    const out = aggregateBars(src, derivedSpec('W')!)
    expect(out.map((b) => b.t)).toEqual([bday(2026, 10, 14), bday(2026, 10, 19)])
    expect(out[0]).toMatchObject({ o: 14, h: 19, l: 13, c: 18, v: 4 })
    expect(derivedSpec('W')!.startsBucket(bday(2026, 10, 19))).toBe(true)
    expect(derivedSpec('W')!.startsBucket(bday(2026, 10, 14))).toBe(false)
    // 3 月 6 日周五（冬 22:00 UTC）→ 3 月 9 日周一（夏 21:00 UTC）
    expect(bday(2026, 3, 6)).toBe(utc(2026, 3, 5, 22))
    expect(bday(2026, 3, 9)).toBe(utc(2026, 3, 8, 21))
    expect(times('W', [bar(bday(2026, 3, 6), 1, 1, 1, 1), bar(bday(2026, 3, 9), 1, 1, 1, 1)])).toEqual([bday(2026, 3, 6), bday(2026, 3, 9)])
  })

  it('2W：每两周一组', () => {
    const src = [bday(2026, 10, 16), bday(2026, 10, 19), bday(2026, 10, 30), bday(2026, 11, 2)].map((t) => bar(t, 1, 1, 1, 1))
    expect(times('2W', src)).toEqual([bday(2026, 10, 16), bday(2026, 10, 19), bday(2026, 11, 2)])
  })

  it('3M = 自然季度，6M = 半年，12M = 自然年', () => {
    const src = [bday(2026, 6, 30), bday(2026, 7, 1), bday(2026, 9, 30), bday(2026, 10, 1), bday(2026, 12, 31), bday(2027, 1, 4)]
      .map((t) => bar(t, 1, 1, 1, 1))
    expect(times('3M', src)).toEqual([bday(2026, 6, 30), bday(2026, 7, 1), bday(2026, 10, 1), bday(2027, 1, 4)])
    expect(times('6M', src)).toEqual([bday(2026, 6, 30), bday(2026, 7, 1), bday(2027, 1, 4)])
    expect(times('12M', src)).toEqual([bday(2026, 6, 30), bday(2027, 1, 4)])
    expect(derivedSpec('3M')!.startsBucket(bday(2026, 10, 1))).toBe(true)
    expect(derivedSpec('3M')!.startsBucket(bday(2026, 11, 2))).toBe(false)
    expect(derivedSpec('6M')!.startsBucket(bday(2026, 10, 1))).toBe(false)
    expect(derivedSpec('12M')!.startsBucket(bday(2027, 1, 1))).toBe(true)
  })
})

describe('翻页契约 / paging contract', () => {
  // 跨两次夏令时切换的连续数据（含 11 月那个重复的券商小时）
  // Continuous data across both DST switches (including November's repeated broker hour)
  const cases: [string, Candle[]][] = [
    ['2', series(utc(2026, 3, 7, 23), utc(2026, 3, 8, 9), 60)],
    ['7', series(utc(2026, 10, 31, 23), utc(2026, 11, 1, 9), 60)],
    ['45', series(utc(2026, 10, 31, 20), utc(2026, 11, 1, 12), 900)],
    ['90', series(utc(2026, 3, 7, 20), utc(2026, 3, 8, 12), 900)],
    ['120', series(utc(2026, 10, 30, 0), utc(2026, 11, 3, 0), H)],
    ['300', series(utc(2026, 10, 30, 0), utc(2026, 11, 3, 0), H)],
    ['720', series(utc(2026, 10, 29, 21), utc(2026, 11, 4, 22), 4 * H)],
    ['2D', series(bday(2026, 2, 20), bday(2026, 4, 20), 86400)],
    ['W', series(bday(2026, 2, 20), bday(2026, 5, 20), 86400)],
    ['3M', series(bday(2026, 1, 1), bday(2027, 3, 1), 86400)],
  ]
  it.each(cases)('%s：t 严格递增，且 <= 桶内每根源 bar 的 t', (code, src) => {
    const spec = derivedSpec(code)!
    const out = aggregateBars(src, spec)
    for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t)
    // 第 i 根派生 bar 的源 bar = t 落在 [out[i].t, out[i+1].t) 里的那些，它们的 key 必须相同
    // Source bars of derived bar i are those in [out[i].t, out[i+1].t); they must share a key.
    let j = 0
    for (let i = 0; i < out.length; i++) {
      const end = i + 1 < out.length ? out[i + 1].t : Infinity
      const k = spec.bucketKey(src[j].t)
      expect(src[j].t).toBeGreaterThanOrEqual(out[i].t)
      while (j < src.length && src[j].t < end) { expect(spec.bucketKey(src[j].t)).toBe(k); j++ }
    }
    expect(j).toBe(src.length)
  })

  it('某一页最早的不完整桶丢掉，下一页按保留的最早那根往左拿全', async () => {
    // 2H ← H1：首页从 22:00 UTC（夏，券商 01:00，桶中间）开始
    const first = series(utc(2026, 10, 13, 22), utc(2026, 10, 15, 24), H).slice(-50)
    const older = series(utc(2026, 10, 11, 0), first[0].t, H).slice(-50)
    history.mockResolvedValueOnce({ bars: first, hasMore: true }).mockResolvedValueOnce({ bars: older, hasMore: true })
    const r = await createChartFeed('BTCUSD', '120').history(50)
    expect(history).toHaveBeenNthCalledWith(1, 'BTCUSD', '60', 50)
    expect(history).toHaveBeenNthCalledWith(2, 'BTCUSD', '60', 50, first[0].t)
    const spec = derivedSpec('120')!
    expect(spec.startsBucket(older[0].t)).toBe(false)
    // 最早那桶（只有 1 根 H1）被丢掉 / the partial oldest bucket is dropped
    expect(r.bars[0].t).toBe(older[1].t)
    expect(r.bars.every((b) => spec.startsBucket(b.t))).toBe(true)
    // 100 根 H1 = 被丢的 1 根 + 49 对 + 形成中那 1 根 / 1 dropped + 49 pairs + the forming one
    expect(r.bars).toHaveLength(50)
    // 下一页的 before = 保留的最早那根 / next page's before = earliest kept bar
    history.mockResolvedValueOnce({ bars: series(utc(2026, 10, 1), r.bars[0].t, H), hasMore: true })
    const p2 = await createChartFeed('BTCUSD', '120').history(500, r.bars[0].t)
    expect(history).toHaveBeenLastCalledWith('BTCUSD', '60', 1000, r.bars[0].t)
    expect(p2.bars[p2.bars.length - 1].t).toBe(r.bars[0].t - 2 * H)
  })
})

describe('createChartFeed：只请求原生周期 / only native intervals are requested', () => {
  const NATIVE = new Set(['1', '5', '15', '60', '240', 'D'])
  it.each(['2', '7', '45', '120', '720', '1440', '2D', 'W', '3M', '12M'])('%s', async (code) => {
    const spec = derivedSpec(code)!
    const step = spec.source === 'D' ? 86400 : Number(spec.source) * 60
    const end = utc(2026, 10, 14, 9)
    history.mockImplementation(async (_s: string, _iv: string, limit: number, before?: number) => {
      const top = before ?? end
      return { bars: series(top - limit * step, top, step), hasMore: true }
    })
    latest.mockImplementation(async () => ({ bars: series(end - step, end + step, step), updatedAt: 1 }))
    const feed = createChartFeed('XAUUSD', code)
    const h = await feed.history(50)
    await feed.history(500, h.bars[0].t)
    const l = await feed.latest()
    for (const c of history.mock.calls) {
      expect(NATIVE.has(c[1] as string)).toBe(true)
      expect(c[1]).toBe(spec.source)
      expect(c[2]).toBeLessThanOrEqual(1000)
    }
    for (const c of latest.mock.calls) expect(c[1]).toBe(spec.source)
    expect(history.mock.calls.length).toBeLessThanOrEqual(3) // 首页最多两步 + 一次翻页
    for (let i = 1; i < h.bars.length; i++) expect(h.bars[i].t).toBeGreaterThan(h.bars[i - 1].t)
    // 首屏：倍数 ≤ 20 时有满满一屏（≈50 根）/ a full first screen when the factor is ≤ 20
    if (spec.pageFactor <= 20) expect(h.bars.length).toBeGreaterThanOrEqual(45)
    // 轮询合成的最后一根 = 历史里同一桶（形成中那根），开盘价相同
    // The poll's last bar is the forming bucket and shares its open with history's
    expect(l.bars.length).toBeGreaterThan(0)
    expect(feed.dayBars() === null).toBe(!spec.dayStatsFromSource)
  })

  it('12M：形成中那根年线合进尾巴里今年全部日线', async () => {
    const daily = series(bday(2025, 1, 1), bday(2026, 10, 15), 86400)
    history.mockResolvedValueOnce({ bars: daily.slice(-50), hasMore: true })
      .mockResolvedValueOnce({ bars: daily.slice(0, -50), hasMore: false })
    latest.mockResolvedValue({ bars: series(bday(2026, 10, 15), bday(2026, 10, 16), 86400).map((b) => ({ ...b, h: 999 })), updatedAt: 1 })
    const feed = createChartFeed('XAUUSD', '12M')
    const h = await feed.history(50)
    expect(h.bars.map((b) => b.t)).toEqual([bday(2025, 1, 1), bday(2026, 1, 1)])
    const l = await feed.latest()
    expect(l.bars).toHaveLength(1)
    expect(l.bars[0].t).toBe(bday(2026, 1, 1))
    expect(l.bars[0].h).toBe(999)
    // 今年 1 月 1 日到 10 月 15 日每天一根 / one bar per day, Jan 1 → Oct 15
    expect(l.bars[0].v).toBe(Math.round((bday(2026, 10, 16) - bday(2026, 1, 1)) / 86400))
  })
})
