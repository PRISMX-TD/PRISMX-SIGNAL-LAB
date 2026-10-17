// 派生周期：M30 与月线不在库里单独存，也不让 EA 多推两路——前端拿现成的源周期
// K 线（M30 ← M15，月线 ← 日线）现场合成。后端、数据库、EA 一行不改：
//   · 不新增一行 candles，不新增一路 /feed/candles 推送与闸门计算；
//   · 首屏、翻页、轮询发出去的请求与 M15 / 日线用户的完全同形（同周期、同 limit、
//     同 before 网格），落在 /chart/history 现成的共享缓存键上，库的压力不随看
//     派生周期的人数增长。
// Derived intervals: M30 and monthly bars are neither stored nor pushed by the EA —
// the client builds them from an existing source interval (M30 ← M15, monthly ←
// daily). Backend, database and EA are untouched: no new candle rows, no extra feed
// stream, and every request has the same shape as an M15 / daily viewer's (same
// interval, limit and on-grid `before`), so it lands on /chart/history's shared
// cache keys and database load doesn't grow with the number of derived viewers.
import { chartApi } from '../../api/client'
import type { Candle } from '../../api/types'
import { HISTORY_FIRST_PAGE, barSpacingSeconds } from './chartConfig'

// 后端单次 /chart/history 的上限（backend routers/chart.py CHART_HISTORY_MAX_LIMIT）。
// Backend per-request cap (CHART_HISTORY_MAX_LIMIT in routers/chart.py).
const SOURCE_MAX_LIMIT = 1000
// 合成形成中那根要用到的源 bar 尾巴：月线最多 31 根日线，留到 80 根够跨两个月。
// Source tail kept for the forming bar: a month is at most 31 daily bars; 80 spans two.
const TAIL_KEEP = 80

const HALF_DAY = 12 * 3600

export interface DerivedSpec {
  source: string
  // 落在同一根派生 bar 里的源 bar 返回同一个 key / same key = same derived bar
  bucketKey: (t: number) => number
  // 派生 bar 的时间戳：key 与桶里最早那根源 bar 的 t。必须 <= 桶内每根源 bar 的 t，
  // 这样派生 bar 的 t 直接当 before 游标往左翻页，拿到的正好是更早的桶。
  // The derived bar's time, from the key and the bucket's earliest source t. It must be
  // <= every source t in the bucket, so it doubles as the `before` cursor for paging.
  bucketTime: (key: number, firstT: number) => number
  // 这根源 bar 一定是所在桶的第一根（拿不准就 false）
  // This source bar certainly opens its bucket (false when unsure)
  startsBucket: (t: number) => boolean
  // 往左翻页：源 bar 根数 = 派生根数 × pageFactor（再封顶 SOURCE_MAX_LIMIT）
  // Paging left: source limit = derived limit × pageFactor (capped)
  pageFactor: number
  // 首页在 HISTORY_FIRST_PAGE 根之后再往左补一页的源 bar 根数（0 = 不补）
  // Source bars fetched as a second step left of the first HISTORY_FIRST_PAGE (0 = none)
  firstPageExtra: number
  // 行情头的日内统计改用源 bar（一根派生 bar 跨好多天时）
  // Header day stats use the source bars (when one derived bar spans many days)
  dayStatsFromSource: boolean
}

// 月线按券商日期分月。日线 t 是券商零点换算成的 UTC（GMT+3 的券商就是前一天
// 21:00 UTC），直接取 UTC 月份会把每月 1 号那根算进上个月；加半天再取，券商时区
// 在 ±12 小时内都落回正确的日期。
// Months follow the broker's date. A daily bar's t is broker midnight in UTC (21:00
// UTC the previous day for a GMT+3 broker), so the raw UTC month would file the 1st
// under the previous month; shifting by half a day lands on the right date for any
// broker offset within ±12h.
function monthKey(t: number): number {
  const d = new Date((t + HALF_DAY) * 1000)
  return d.getUTCFullYear() * 12 + d.getUTCMonth()
}

export const DERIVED_INTERVALS: Record<string, DerivedSpec> = {
  // M30 ← M15：M15 按 epoch 对齐，券商时区是整小时，30 分钟网格同样 epoch 对齐。
  // M30 ← M15: M15 is epoch-aligned and broker offsets are whole hours, so the
  // 30-minute grid is epoch-aligned too.
  '30': {
    source: '15',
    bucketKey: (t) => Math.floor(t / 1800) * 1800,
    bucketTime: (key) => key,
    startsBucket: (t) => t % 1800 === 0,
    pageFactor: 2,
    // 首页 50 根 M15 只够 25 根 M30，再补 50 根凑满一屏 50 根。
    // 50 M15 bars make only 25 M30 bars; 50 more fill the usual 50-bar first screen.
    firstPageExtra: HISTORY_FIRST_PAGE,
    dayStatsFromSource: false,
  },
  // 月线 ← 日线：t 取当月第一根日线的 t（每月 1 号是交易日时就是券商月初零点，与
  // MT5 的 MN1 一致）。库里日线一共才几百根，首页一次补齐全部历史。
  // Monthly ← daily: t is the month's first daily bar (broker midnight on the 1st
  // when that's a trading day, matching MT5's MN1). Daily history is only a few
  // hundred rows, so the first page fetches all of it.
  M: {
    source: 'D',
    bucketKey: monthKey,
    bucketTime: (_key, firstT) => firstT,
    startsBucket: (t) => new Date((t + HALF_DAY) * 1000).getUTCDate() === 1,
    pageFactor: 23,
    firstPageExtra: SOURCE_MAX_LIMIT,
    dayStatsFromSource: true,
  },
}

export function isDerivedInterval(code: string): boolean {
  return code in DERIVED_INTERVALS
}

// 月线的时间轴 / 十字准线标签：2026-02。通用的「日/月 时:分」不带年份，放在月线上
// 既看不出哪一年、又多出一个没意义的钟点。按与分桶相同的券商日期取年月，标签
// 与 K 线归属的月份永远一致。
// Monthly axis / crosshair label: 2026-02. The shared "DD/MM, HH:mm" has no year and a
// meaningless clock time on a monthly bar. Year and month come from the same broker
// date the bucketing uses, so the label always matches the bar's month.
export function fmtMonthTime(t: number): string {
  const d = new Date((t + HALF_DAY) * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// 源 bar（按 t 升序）→ 派生 bar。连续同 key 的源 bar 合成一根：开取首根、收取末根、
// 高低取极值、量相加。
// Source bars (ascending t) → derived bars: consecutive same-key bars merge into one
// (first open, last close, extreme high/low, summed volume).
export function aggregateBars(src: Candle[], spec: DerivedSpec): Candle[] {
  const out: Candle[] = []
  let curKey = NaN
  for (const b of src) {
    const k = spec.bucketKey(b.t)
    if (k !== curKey) {
      out.push({ t: spec.bucketTime(k, b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 })
      curKey = k
      continue
    }
    const a = out[out.length - 1]
    if (b.h > a.h) a.h = b.h
    if (b.l < a.l) a.l = b.l
    a.c = b.c
    a.v += b.v ?? 0
  }
  return out
}

type HistoryResp = Awaited<ReturnType<typeof chartApi.history>>
type LatestResp = Awaited<ReturnType<typeof chartApi.latest>>

export interface ChartFeed {
  history: (limit: number, before?: number) => Promise<HistoryResp>
  latest: (n?: number) => Promise<LatestResp>
  // 行情头日内统计用的 K 线：月线一根就是一个月，得用源日线；其它周期 null（用图上的 bar）。
  // Bars for the header's day stats: a monthly bar spans a month, so use the source
  // daily bars; null for every other interval (use the chart's own bars).
  dayBars: () => Candle[] | null
}

// 一次「品种 + 周期」的数据源，useChartData 每切一次品种 / 周期建一个。基础周期原样
// 透传 chartApi；派生周期在这里合成，并记住源周期最近一段尾巴，好把轮询拿回来的
// 最新一两根源 bar 合进形成中那根派生 bar。
// The data source for one symbol + interval, created per switch in useChartData. Base
// intervals pass straight through to chartApi; derived ones are built here, keeping a
// tail of recent source bars so the newest one or two the poll returns can be merged
// into the forming derived bar.
export function createChartFeed(symbol: string, interval: string): ChartFeed {
  const spec = DERIVED_INTERVALS[interval]
  if (!spec) {
    return {
      history: (limit, before) => chartApi.history(symbol, interval, limit, before),
      latest: (n) => chartApi.latest(symbol, interval, n),
      dayBars: () => null,
    }
  }

  const src = spec.source
  const srcSpacing = barSpacingSeconds(src) ?? 0
  let tail: Candle[] = []
  // 首页还没回来时，轮询先等它：月线形成中那根要靠首页里本月已收盘的日线才完整。
  // Polls wait for the first page: the forming month needs this month's closed daily bars.
  let firstLoad: Promise<unknown> = Promise.resolve()

  const absorb = (bars: Candle[]) => {
    if (bars.length === 0) return
    const byT = new Map<number, Candle>()
    for (const b of tail) byT.set(b.t, b)
    for (const b of bars) byT.set(b.t, b)
    tail = [...byT.values()].sort((a, b) => a.t - b.t).slice(-TAIL_KEEP)
  }

  const fetchFirstPage = async () => {
    // 头一步与 M15 / 日线用户的首屏是同一个请求（limit = HISTORY_FIRST_PAGE，后端共享缓存）。
    // Step one is the exact request an M15 / daily viewer's first screen makes (shared cache).
    const first = await chartApi.history(symbol, src, HISTORY_FIRST_PAGE)
    let bars = first.bars
    let hasMore = first.hasMore
    if (spec.firstPageExtra > 0 && hasMore && bars.length > 0) {
      // before 取首页最早那根，落在网格上，后端按 120 秒缓存，同一时段打开的人共用。
      // `before` is the first page's earliest bar — on the grid, so cached 120s and shared.
      const older = await chartApi.history(symbol, src, spec.firstPageExtra, bars[0].t)
      bars = [...older.bars, ...bars]
      hasMore = older.hasMore
    }
    return { bars, hasMore }
  }

  const history = async (limit: number, before?: number): Promise<HistoryResp> => {
    const load = async () => {
      const r = before === undefined
        ? await fetchFirstPage()
        : await chartApi.history(symbol, src, Math.min(SOURCE_MAX_LIMIT, limit * spec.pageFactor), before)
      if (before === undefined) absorb(r.bars)
      let bars = aggregateBars(r.bars, spec)
      // 这一页最早那个桶可能只拿到后半截（它的前半截在更早一页里）：还有更早数据、
      // 又不能确定首根就是桶的开头时丢掉它。下一页的 before 是保留下来的最早那根，
      // 被丢的桶会整个落在下一页里，拿全了再画。
      // The page's oldest bucket may hold only its later part (the rest sits on an older
      // page): drop it when more history exists and its first source bar isn't certainly
      // the bucket's start. The next page's `before` is the earliest kept bar, so the
      // dropped bucket arrives whole on that page.
      if (r.hasMore && bars.length > 1 && r.bars.length > 0 && !spec.startsBucket(r.bars[0].t)) {
        bars = bars.slice(1)
      }
      return { symbol, interval, bars, hasMore: r.hasMore }
    }
    const p = load()
    if (before === undefined) firstLoad = p.catch(() => {})
    return p
  }

  const latest = async (n?: number): Promise<LatestResp> => {
    // n 原样用在源周期上：轮询与 M15 / 日线用户同一个请求。M30 形成中那根最多两根 M15，
    // 默认 n=2 正好覆盖。/ n passes through to the source interval, so the poll is the
    // same request an M15 / daily viewer makes; the forming M30 bar is at most two M15
    // bars, which the default n=2 covers.
    const pending = firstLoad
    const r = await chartApi.latest(symbol, src, n)
    await pending
    let touched = r.bars
    const prevLast = tail.length ? tail[tail.length - 1].t : null
    // 源周期中间有洞（App 冻在后台很久）：补拉一次源首页再合成，不然形成中那根
    // 派生 bar 会漏掉洞里那些源 bar 的高低。首页走后端共享缓存。
    // A hole in the source series (the app sat frozen in the background): refetch the
    // source first page (shared cache) before merging, or the forming derived bar would
    // miss the highs / lows of the bars in the hole.
    if (prevLast != null && srcSpacing > 0 && r.bars.length > 0 && r.bars[0].t > prevLast + srcSpacing) {
      try {
        const h = await chartApi.history(symbol, src, HISTORY_FIRST_PAGE)
        absorb(h.bars)
        touched = [...h.bars.filter((b) => b.t > prevLast), ...r.bars]
      } catch { /* 补不上就按手头的合成 / merge with what we have */ }
    }
    absorb(r.bars)
    const keys = new Set(touched.map((b) => spec.bucketKey(b.t)))
    const bars = aggregateBars(tail.filter((b) => keys.has(spec.bucketKey(b.t))), spec)
    return { ...r, bars }
  }

  return {
    history,
    latest,
    // 尾巴还空着时返回 []：行情头显示占位，而不是拿月线算出一个「整段窗口」的涨跌。
    // An empty tail returns []: the header shows placeholders instead of whole-window stats.
    dayBars: () => (spec.dayStatsFromSource ? tail : null),
  }
}
