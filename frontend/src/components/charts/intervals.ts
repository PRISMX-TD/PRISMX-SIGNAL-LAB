// 周期代码的语法、标签、分类与券商时区——纯函数，不依赖图表其它模块。
// 代码约定（旧代码一律原样有效）：
//   · 分钟：纯整数字符串 '1'..'1440'；小时就是 60 的倍数（'120' = 2H，'720' = 12H）；
//   · 天：'D'、'2D'…（1 天只写 'D'，不收 '1D'）；周：'W'、'2W'…；月：'M'、'3M'、'6M'、'12M'。
// 后端只存 1 / 5 / 15 / 60 / 240 / D 六个原生周期，其余全部由前端从原生周期合成（见
// derivedIntervals.ts）。合成倍数太大（一根要几百根源 bar）既拉不满一屏、又白耗流量，
// 所以「合法」= 语法对、在上限内、且合成倍数 ≤ MAX_DERIVE_FACTOR。
// Interval-code grammar, labels, kinds and the broker clock — pure helpers with no
// dependency on the rest of the chart code. Codes (every existing code stays valid):
//   · minutes: plain integer '1'..'1440'; hours are multiples of 60 ('120' = 2H);
//   · days 'D', '2D'… (one day is only 'D', never '1D'); weeks 'W', '2W'…;
//     months 'M', '3M', '6M', '12M'.
// The backend stores only the six native intervals 1 / 5 / 15 / 60 / 240 / D; everything
// else is built client-side (derivedIntervals.ts). A huge derive factor (hundreds of
// source bars per bar) can't fill a screen and wastes egress, so "valid" = grammatical,
// within the limits, and derive factor ≤ MAX_DERIVE_FACTOR.

export type IntervalUnit = 'min' | 'D' | 'W' | 'M'
export interface ParsedInterval { unit: IntervalUnit; n: number }
export type IntervalKind = 'intraday' | 'daily' | 'weekly' | 'monthly'

// 后端认的原生周期（backend routers/chart.py ALLOWED_INTERVALS）。
// Native intervals the backend accepts (ALLOWED_INTERVALS in routers/chart.py).
export const NATIVE_INTERVALS: readonly string[] = ['1', '5', '15', '60', '240', 'D']

// 各单位的上限 / per-unit maximum n
export const INTERVAL_LIMITS: Readonly<Record<IntervalUnit, number>> = { min: 1440, D: 365, W: 52, M: 12 }

// 一根派生分钟 bar 最多由多少根源 bar 合成。96 = 1440 / 15：15 的倍数一直到 24H 全部
// 合法；不是 5 的倍数的分钟数（只能从 M1 合成）到 96 为止，5 的倍数到 480 为止。
// Max source bars per derived minute bar. 96 = 1440 / 15: every multiple of 15 up to 24H
// is valid; minute counts that aren't multiples of 5 (M1-sourced) go up to 96, multiples
// of 5 up to 480.
export const MAX_DERIVE_FACTOR = 96

// 分钟周期的源：{240, 60, 15, 5, 1} 里能整除 n 的最大一个。这五个原生周期都整除
// 1440、都对齐券商零点（1/5/15/60 同时也按 epoch 对齐，因为券商时区是整小时），所以
// 源 bar 永远不会跨派生桶的边界。
// A minute interval's source: the largest of {240, 60, 15, 5, 1} dividing n. All five
// divide 1440 and sit on broker midnight (1/5/15/60 are epoch-aligned too, broker offsets
// being whole hours), so a source bar never straddles a derived bucket boundary.
export function minuteSource(n: number): number {
  for (const s of [240, 60, 15, 5, 1]) if (n % s === 0) return s
  return 1
}

const CODE_RE = /^(?:([1-9]\d{0,3})|([1-9]\d{0,2})?([DWM]))$/

// 代码 → { unit, n }；不合法（语法、上限、合成倍数）一律 null。
// Code → { unit, n }; null when invalid (grammar, limits or derive factor).
export function parseInterval(code: string | null | undefined): ParsedInterval | null {
  if (!code) return null
  const m = CODE_RE.exec(code)
  if (!m) return null
  if (m[1] != null) {
    const n = Number(m[1])
    if (n > INTERVAL_LIMITS.min || n / minuteSource(n) > MAX_DERIVE_FACTOR) return null
    return { unit: 'min', n }
  }
  const unit = m[3] as 'D' | 'W' | 'M'
  // '1D' / '1W' / '1M' 不收：1 个单位只有一种写法，存下来的偏好不会一物两码。
  // '1D' / '1W' / '1M' are rejected: one spelling per interval, so stored prefs never alias.
  if (m[2] === '1') return null
  const n = m[2] != null ? Number(m[2]) : 1
  if (n > INTERVAL_LIMITS[unit]) return null
  return { unit, n }
}

// { unit, n } → 规范代码 / canonical code
export function intervalCode(p: ParsedInterval): string {
  if (p.unit === 'min') return String(p.n)
  return p.n === 1 ? p.unit : `${p.n}${p.unit}`
}

export function isValidInterval(code: string | null | undefined): code is string {
  return parseInterval(code) != null
}

export function isNativeInterval(code: string): boolean {
  return NATIVE_INTERVALS.includes(code)
}

// 标签：1m 45m 1H 2H 4H 24H 1D 2D 1W 1M 3M 12M；不合法的代码原样返回。
// Labels: 1m 45m 1H 2H 4H 24H 1D 2D 1W 1M 3M 12M; invalid codes come back unchanged.
export function intervalLabel(code: string): string {
  const p = parseInterval(code)
  if (!p) return code
  if (p.unit === 'min') return p.n % 60 === 0 ? `${p.n / 60}H` : `${p.n}m`
  return `${p.n}${p.unit}`
}

// 分类（给时间轴格式选用）。分钟代码一律 intraday（含 1440）；不合法代码按 intraday。
// Kind, for picking the time-axis format. Every minute code is intraday (1440 included);
// invalid codes count as intraday.
export function intervalKind(code: string): IntervalKind {
  const u = parseInterval(code)?.unit
  return u === 'D' ? 'daily' : u === 'W' ? 'weekly' : u === 'M' ? 'monthly' : 'intraday'
}

// 输入框里敲的文字 → 规范代码，不合法返回 null。大写单独的 M 是月，其余单位不分大小写：
// '5' / '5m' / '5min' → '5'，'2h' → '120'，'d' / '1d' → 'D'，'3d' → '3D'，'w' → 'W'，
// 'M' / '3M' / '3mo' → 月，'y' → '12M'；也认中文单位（分 / 时 / 小时 / 天 / 日 / 周 / 月 / 年）。
// 24 小时（'24h' / '1440'）归一成 'D'，走原生日线。
// Typed text → canonical code, or null. A lone uppercase M means months; every other unit
// is case-insensitive: '5' / '5m' / '5min' → '5', '2h' → '120', 'd' / '1d' → 'D',
// '3d' → '3D', 'w' → 'W', 'M' / '3M' / '3mo' → months, 'y' → '12M'; Chinese units too.
// 24 hours ('24h' / '1440') normalises to 'D', the native daily.
export function normalizeIntervalInput(text: string): string | null {
  const m = /^(\d*)(.*)$/.exec(text.replace(/\s+/g, ''))
  if (!m || (m[1] === '' && m[2] === '')) return null
  const n = m[1] === '' ? 1 : Number(m[1])
  if (!Number.isSafeInteger(n) || n < 1) return null
  const raw = m[2]
  let unit: IntervalUnit
  let count = n
  if (raw === 'M') unit = 'M'
  else {
    switch (raw.toLowerCase()) {
      case '': case 'm': case 'min': case 'mins': case 'minute': case 'minutes': case '分': case '分钟':
        unit = 'min'; break
      case 'h': case 'hr': case 'hrs': case 'hour': case 'hours': case '时': case '小时':
        unit = 'min'; count = n * 60; break
      case 'd': case 'day': case 'days': case '天': case '日':
        unit = 'D'; break
      case 'w': case 'wk': case 'wks': case 'week': case 'weeks': case '周': case '星期':
        unit = 'W'; break
      case 'mo': case 'mon': case 'mth': case 'month': case 'months': case '月': case '个月':
        unit = 'M'; break
      case 'y': case 'yr': case 'year': case 'years': case '年':
        unit = 'M'; count = n * 12; break
      default:
        return null
    }
  }
  if (unit === 'min' && count === 1440) return 'D'
  const code = intervalCode({ unit, n: count })
  return isValidInterval(code) ? code : null
}

// 选择器的预设分组 / picker presets, grouped
export type IntervalGroup = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'
export const INTERVAL_PRESETS: readonly { group: IntervalGroup; codes: readonly string[] }[] = [
  { group: 'minutes', codes: ['1', '2', '3', '5', '10', '15', '30', '45'] },
  { group: 'hours', codes: ['60', '120', '180', '240', '360', '720'] },
  { group: 'days', codes: ['D'] },
  { group: 'weeks', codes: ['W'] },
  { group: 'months', codes: ['M', '3M', '6M', '12M'] },
]

// ---------- 券商时钟 / broker clock ----------
// 券商零点 = 纽约 17:00，即券商时间 = 纽约时间 + 7 小时：纽约夏令时（3 月第二个周日
// 当地 2:00 → 11 月第一个周日当地 2:00）为 GMT+3，否则 GMT+2。切换时刻换成 UTC 是
// 3 月那天 07:00、11 月那天 06:00——都在周末休市里，外汇 bar 不会跨切换。不用 Intl：
// 每根 bar 都要算一次，按年缓存两个切换时刻。
// Broker midnight = 17:00 New York, i.e. broker time = NY time + 7h: GMT+3 while NY is on
// daylight time (second Sunday of March 2:00 local → first Sunday of November 2:00
// local), else GMT+2. In UTC the switches are 07:00 (March) and 06:00 (November), inside
// the weekend close, so no FX bar straddles one. No Intl: this runs for every bar, so the
// two switch instants are cached per year.
const H = 3600
let cacheY0 = 0
let cacheY1 = -1
let dstStart = 0
let dstEnd = 0

export function brokerOffsetSec(t: number): number {
  if (!(t >= cacheY0 && t < cacheY1)) {
    const y = new Date(t * 1000).getUTCFullYear()
    cacheY0 = Date.UTC(y, 0, 1) / 1000
    cacheY1 = Date.UTC(y + 1, 0, 1) / 1000
    const mar1 = new Date(Date.UTC(y, 2, 1)).getUTCDay()
    const nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay()
    dstStart = Date.UTC(y, 2, 1 + ((7 - mar1) % 7) + 7, 7) / 1000
    dstEnd = Date.UTC(y, 10, 1 + ((7 - nov1) % 7), 6) / 1000
  }
  return t >= dstStart && t < dstEnd ? 3 * H : 2 * H
}

const DAY = 86400
const mod = (a: number, b: number) => ((a % b) + b) % b

// 分钟周期是否按券商时间锚定：整除 60 的（1/2/3/4/5/6/10/12/15/20/30/60）按 epoch 对齐
// 即可（券商时区是整小时，两者等价）；其余（45、7、90、2H、4H、12H…）按券商时间。
// Whether a minute interval is anchored to broker time: divisors of 60 are epoch-aligned
// (equivalent, broker offsets being whole hours); everything else (45, 7, 90, 2H, 4H,
// 12H…) follows the broker clock.
export function isBrokerAnchored(n: number): boolean {
  return 60 % n !== 0
}

// 按券商时间锚定的 n 分钟桶：t 所在桶的起点（券商时间秒数，即桶的 key）。1440 能被
// n 整除时整天连续切；不能整除（7m、300m…）时每个券商零点重新起算，当天最后一桶短一些。
// Broker-anchored n-minute bucket: the start (in broker-time seconds — the bucket key) of
// the bucket holding t. When n divides 1440 the grid runs straight through; otherwise
// (7m, 300m…) it restarts at every broker midnight and the day's last bucket is shorter.
export function brokerBucketStart(n: number, t: number): number {
  const len = n * 60
  const b = t + brokerOffsetSec(t)
  if (DAY % len === 0) return b - mod(b, len)
  const d = b - mod(b, DAY)
  return d + Math.floor((b - d) / len) * len
}

// 开盘于 t 的这根分钟 bar 之后的下一根的开盘时间（UTC 秒）。按券商锚定且 1440 不能被 n
// 整除时，下一根最晚在券商零点开。
// Open time (UTC seconds) of the minute bar after the one opening at t. For broker-anchored
// n not dividing 1440, the next bar opens at broker midnight at the latest.
export function nextMinuteBarOpen(n: number, t: number): number {
  const next = t + n * 60
  if (!isBrokerAnchored(n) || 1440 % n === 0) return next
  const off = brokerOffsetSec(t)
  const b = t + off
  const midnight = b - mod(b, DAY) + DAY - off
  return Math.min(next, midnight)
}
