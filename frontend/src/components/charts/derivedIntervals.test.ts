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

import { DERIVED_INTERVALS, aggregateBars, createChartFeed, isDerivedInterval } from './derivedIntervals'
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
    expect(isKnownInterval('W')).toBe(false)
    expect(isKnownInterval('')).toBe(false)
  })
})
