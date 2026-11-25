// 派生周期：除 1/5/15/60/240/D 六个原生周期外，所有合法周期（M30、45m、2H、12H、2D、
// 周、月、季、年……，语法见 intervals.ts）都不在库里存，也不让 EA 多推——前端拿现成的
// 源周期 K 线现场合成。源与分桶规则：
//   · n 分钟 ← {240,60,15,5,1} 里整除 n 的最大者；整除 60 的按 epoch 对齐，其余按券商
//     时间（纽约 17:00 = 券商零点）锚定，1440 不能被 n 整除时每个券商零点重新起算；
//   · nD / nW / nM ← 日线：券商日期每 n 天 / 周一起算的 n 周 / year*12+month 每 n 个月。
// （2026-11-25 前只有 M30 ← M15 与月线 ← 日线两个。）后端、数据库、EA 一行不改：
//   · 不新增一行 candles，不新增一路 /feed/candles 推送与闸门计算；
//   · 首屏、翻页、轮询发出去的请求与 M15 / 日线用户的完全同形（同周期、同 limit、
//     同 before 网格），落在 /chart/history 现成的共享缓存键上，库的压力不随看
//     派生周期的人数增长。
// Derived intervals: every valid code other than the six natives 1/5/15/60/240/D (M30,
// 45m, 2H, 12H, 2D, weekly, monthly, quarterly, yearly… — grammar in intervals.ts) is
// neither stored nor pushed by the EA; the client builds it from a native source:
//   · n minutes ← the largest of {240,60,15,5,1} dividing n; divisors of 60 are
//     epoch-aligned, the rest anchored to broker time (17:00 New York = broker midnight),
//     restarting at each broker midnight when n doesn't divide 1440;
//   · nD / nW / nM ← daily: broker days by n / Monday-start weeks by n / year*12+month by n.
// (Until 2026-11-25 only M30 ← M15 and monthly ← daily existed.) Backend, database and
// EA are untouched: no new candle rows, no extra feed
// stream, and every request has the same shape as an M15 / daily viewer's (same
// interval, limit and on-grid `before`), so it lands on /chart/history's shared
// cache keys and database load doesn't grow with the number of derived viewers.
import { chartApi } from '../../api/client'
import type { Candle } from '../../api/types'
import { HISTORY_FIRST_PAGE, barSpacingSeconds } from './chartConfig'
import {
  brokerBucketStart, brokerOffsetSec, isBrokerAnchored, isNativeInterval, minuteSource, parseInterval,
} from './intervals'

// 图表时间格式化等调用方从这里取周期分类 / 标签 / 券商时钟。
// Re-exported for callers such as the time-axis formatter.
export { brokerOffsetSec, intervalKind, intervalLabel } from './intervals'

// 后端单次 /chart/history 的上限（backend routers/chart.py CHART_HISTORY_MAX_LIMIT）。
// Backend per-request cap (CHART_HISTORY_MAX_LIMIT in routers/chart.py).
const SOURCE_MAX_LIMIT = 1000
// 合成形成中那根要用到的源 bar 尾巴的下限；实际取 max(下限, 2 × 一桶最多的源根数)，
// 保证形成中那桶与上一桶都完整在尾巴里（12M 一桶最多 372 根日线 → 744）。
// Floor for the source tail kept for the forming bar; the actual size is max(floor,
// 2 × max source bars per bucket) so the forming bucket and the one before it are both
// whole in the tail (12M: up to 372 daily bars per bucket → 744).
const TAIL_KEEP_MIN = 80

const HALF_DAY = 12 * 3600
const DAY = 86400
const mod = (a: number, b: number) => ((a % b) + b) % b

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
  // 源 bar 尾巴保留根数（覆盖形成中那桶 + 上一桶）
  // Source tail size (covers the forming bucket and the one before)
  tailKeep: number
  // 行情头的日内统计改用源 bar（一根派生 bar 跨好多小时 / 天时）
  // Header day stats use the source bars (when one derived bar spans many hours / days)
  dayStatsFromSource: boolean
}

// 券商日期的日序号：日线 t 是券商零点换算成的 UTC（GMT+3 的券商就是前一天 21:00 UTC），
// 直接取 UTC 日期会差一天；加半天再取，券商时区在 ±12 小时内都落回正确的日期。
// Broker-date day number. A daily bar's t is broker midnight in UTC (21:00 UTC the
// previous day for a GMT+3 broker), so the raw UTC date is a day early; shifting by half
// a day lands on the right date for any broker offset within ±12h.
const dayNumber = (t: number) => Math.floor((t + HALF_DAY) / DAY)
// 周一起算的周序号（1970-01-01 是周四，+3 让周一落在 7 的倍数上）。
// Monday-start week number (1970-01-01 was a Thursday; +3 puts Mondays on multiples of 7).
const weekNumber = (day: number) => Math.floor((day + 3) / 7)

// 月线按券商日期分月（理由同 dayNumber）。
// Months follow the broker's date (same reasoning as dayNumber).
function monthIndex(t: number): number {
  const d = new Date((t + HALF_DAY) * 1000)
  return d.getUTCFullYear() * 12 + d.getUTCMonth()
}

// 首页第二步补多少根源 bar：凑够约 HISTORY_FIRST_PAGE 根派生 bar，按 50 取整、封顶 1000。
// factor 2（M30）正好 50，月线 1000，与改造前完全一样。
// The first page's second step: enough source bars for ≈ HISTORY_FIRST_PAGE derived bars,
// rounded up to 50 and capped at 1000. Factor 2 (M30) gives 50 and monthly 1000, as before.
function firstPageExtraFor(factor: number): number {
  const need = HISTORY_FIRST_PAGE * factor - HISTORY_FIRST_PAGE
  return Math.min(SOURCE_MAX_LIMIT, Math.ceil(need / 50) * 50)
}

// n 分钟 ← minuteSource(n)。整除 60 的按 epoch 对齐（M30 原样）；其余按券商时间锚定，
// t 取桶的理论起点换回 UTC（<= 桶内首根源 bar 的 t），收线倒计时与间距判断照常可用。
// n minutes ← minuteSource(n). Divisors of 60 are epoch-aligned (M30 unchanged); the rest
// follow the broker clock, with t = the bucket's theoretical start converted back to UTC
// (<= the bucket's first source t), so the countdown and spacing maths keep working.
function minuteSpec(n: number): DerivedSpec {
  const s = minuteSource(n)
  const factor = n / s
  const len = n * 60
  const common = {
    source: String(s),
    pageFactor: factor,
    firstPageExtra: firstPageExtraFor(factor),
    tailKeep: Math.max(TAIL_KEEP_MIN, 2 * factor),
    // 长于 4H 的派生 bar 跨越大半天，行情头的「今日」统计用源 bar 才准。
    // Bars longer than 4H span most of a day; source bars give exact "today" stats.
    dayStatsFromSource: n > 240,
  }
  if (!isBrokerAnchored(n)) {
    return {
      ...common,
      bucketKey: (t) => Math.floor(t / len) * len,
      bucketTime: (key) => key,
      startsBucket: (t) => t % len === 0,
    }
  }
  return {
    ...common,
    bucketKey: (t) => brokerBucketStart(n, t),
    bucketTime: (key, firstT) => key - brokerOffsetSec(firstT),
    startsBucket: (t) => brokerBucketStart(n, t) === t + brokerOffsetSec(t),
  }
}

// 多日 / 周 / 月 ← 日线：t 取桶内第一根日线的 t（每月 1 号是交易日时就是券商月初零点，
// 与 MT5 的 MN1 一致）。nD 按券商日序号每 n 天一组；周按券商日期周一起算；月按
// year*12+month 每 n 个一组，所以 3M = 自然季度、6M = 半年、12M = 自然年。
// Multi-day / weekly / monthly ← daily: t is the bucket's first daily bar (broker midnight
// on the 1st when that's a trading day, matching MT5's MN1). nD groups broker day numbers
// by n; weeks start on Monday of the broker date; months group year*12+month by n, so 3M =
// calendar quarters, 6M = halves, 12M = calendar years.
function dailySpec(unit: 'D' | 'W' | 'M', n: number): DerivedSpec {
  let bucketKey: (t: number) => number
  let startsBucket: (t: number) => boolean
  // factor = 翻页 / 首页用的每桶源根数估计；maxPer = 一桶最多几根（加密货币周末也有日线）
  // factor = source bars per bucket for paging / first page; maxPer = most a bucket can hold
  let factor: number
  let maxPer: number
  if (unit === 'D') {
    bucketKey = (t) => Math.floor(dayNumber(t) / n)
    startsBucket = (t) => mod(dayNumber(t), n) === 0
    factor = n
    maxPer = n
  } else if (unit === 'W') {
    bucketKey = (t) => Math.floor(weekNumber(dayNumber(t)) / n)
    startsBucket = (t) => {
      const d = dayNumber(t)
      return mod(d + 3, 7) === 0 && mod(weekNumber(d), n) === 0
    }
    factor = 7 * n
    maxPer = 7 * n
  } else {
    bucketKey = (t) => Math.floor(monthIndex(t) / n)
    startsBucket = (t) => new Date((t + HALF_DAY) * 1000).getUTCDate() === 1 && mod(monthIndex(t), n) === 0
    factor = 23 * n
    maxPer = 31 * n
  }
  return {
    source: 'D',
    bucketKey,
    bucketTime: (_key, firstT) => firstT,
    startsBucket,
    pageFactor: factor,
    firstPageExtra: firstPageExtraFor(factor),
    tailKeep: Math.max(TAIL_KEEP_MIN, 2 * maxPer),
    dayStatsFromSource: true,
  }
}

const specCache = new Map<string, DerivedSpec>()

// 任意合法的非原生周期 → 合成规则；原生周期与不合法代码返回 null。
// Any valid non-native code → its derivation; null for native or invalid codes.
export function derivedSpec(code: string): DerivedSpec | null {
  const hit = specCache.get(code)
  if (hit) return hit
  const p = parseInterval(code)
  if (!p || isNativeInterval(code)) return null
  const spec = p.unit === 'min' ? minuteSpec(p.n) : dailySpec(p.unit, p.n)
  specCache.set(code, spec)
  return spec
}

// 老的两个派生周期，保留给按名字取的调用方 / the original two, kept for callers indexing by name
export const DERIVED_INTERVALS: Record<string, DerivedSpec> = {
  '30': derivedSpec('30')!,
  M: derivedSpec('M')!,
}

export function isDerivedInterval(code: string): boolean {
  return derivedSpec(code) != null
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
// 派生 t 必须严格递增（图表库的要求）。唯一可能倒退的是 11 月夏令时结束那一小时：券商
// 时钟往回拨 1 小时，周末还在交易的品种（加密货币）在 7m / 45m 这类不整除 60 的周期上，
// 新桶的理论起点可能早于上一桶的源 bar——这时改用桶内首根源 bar 的 t，仍 <= 桶内每根源 bar。
// Derived t must strictly increase (a chart-library requirement). The only possible
// regression is November's fall-back hour: the broker clock repeats an hour, and for
// symbols trading through the weekend (crypto) on codes like 7m / 45m a new bucket's
// theoretical start can precede the previous bucket's — then the bucket's first source t
// is used instead, still <= every source t in the bucket.
function aggregateKeyed(src: Candle[], spec: DerivedSpec): { key: number; bar: Candle }[] {
  const out: { key: number; bar: Candle }[] = []
  let curKey = NaN
  let prevSrcT = -Infinity
  for (const b of src) {
    const k = spec.bucketKey(b.t)
    const lastSrcT = prevSrcT
    prevSrcT = b.t
    if (k !== curKey) {
      // 不早于上一桶的任何源 bar：各桶的 [t, 下一桶 t) 互不重叠
      // Never at or before the previous bucket's source bars, so buckets never overlap
      let t = spec.bucketTime(k, b.t)
      if (t <= lastSrcT) t = b.t
      out.push({ key: k, bar: { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 } })
      curKey = k
      continue
    }
    const a = out[out.length - 1].bar
    if (b.h > a.h) a.h = b.h
    if (b.l < a.l) a.l = b.l
    a.c = b.c
    a.v += b.v ?? 0
  }
  return out
}

export function aggregateBars(src: Candle[], spec: DerivedSpec): Candle[] {
  return aggregateKeyed(src, spec).map((x) => x.bar)
}

type HistoryResp = Awaited<ReturnType<typeof chartApi.history>>
type LatestResp = Awaited<ReturnType<typeof chartApi.latest>>

export interface ChartFeed {
  history: (limit: number, before?: number) => Promise<HistoryResp>
  latest: (n?: number) => Promise<LatestResp>
  // 行情头日内统计用的 K 线：派生 bar 长于 4H（12H、日以上）时一根跨大半天甚至好几个月，
  // 得用源 bar；其它周期 null（用图上的 bar）。
  // Bars for the header's day stats: a derived bar longer than 4H (12H, daily and up)
  // spans most of a day or more, so use the source bars; null otherwise (chart bars).
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
  const spec = derivedSpec(interval)
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
    tail = [...byT.values()].sort((a, b) => a.t - b.t).slice(-spec.tailKeep)
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
    // 默认 n=2 正好覆盖；更长的派生 bar 由尾巴（tailKeep 覆盖整桶）补齐前面已收盘的源 bar。
    // / n passes through to the source interval, so the poll is the same request a
    // native viewer makes; the forming M30 bar is at most two M15 bars, which the default
    // n=2 covers, and longer derived bars take their earlier closed source bars from the
    // tail (tailKeep covers a whole bucket).
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
    // 整条尾巴一起合成再挑出被碰到的桶：与翻页时的合成上下文一致（t 的递增保护要看前一桶）。
    // 尾巴最多几百根，每次轮询合成一遍毫秒级以下。
    // Aggregate the whole tail, then keep the touched buckets: the same context as history
    // (the ascending-t guard looks at the previous bucket). The tail is a few hundred bars at
    // most, well under a millisecond per poll.
    const keys = new Set(touched.map((b) => spec.bucketKey(b.t)))
    const bars = aggregateKeyed(tail, spec).filter((x) => keys.has(x.key)).map((x) => x.bar)
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
