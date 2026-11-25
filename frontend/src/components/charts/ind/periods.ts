// 指标用的时间分桶：券商日期 / 周 / 月，时段锚点（自动按周期选），以及多周期的分桶键。
// 枢轴点、VWAP / TWAP 锚点、成交量分布与 TPO 的时段、多周期计算、多周期 K 线箱体都按券商服务器时间切。
// Time bucketing for indicators: broker day / week / month, session anchors (auto by interval) and
// higher-timeframe bucket keys. Pivots, VWAP / TWAP anchors, volume-profile and TPO sessions,
// multi-timeframe compute and HTF candle boxes all split on broker server time.
import { brokerBucketStart, brokerOffsetSec, isBrokerAnchored, parseInterval } from '../intervals'

export const brokerDay = (t: number) => Math.floor((t + brokerOffsetSec(t)) / 86400)
export const brokerWeek = (t: number) => Math.floor((brokerDay(t) + 3) / 7)
export function brokerMonth(t: number): number {
  const d = new Date(brokerDay(t) * 86400_000)
  return d.getUTCFullYear() * 12 + d.getUTCMonth()
}
export const brokerYear = (t: number) => Math.floor(brokerMonth(t) / 12)

// 'auto' 按图表周期选：≤15 分钟按日、≤4 小时按周、其余分钟与日线按月、更大按年
// 'auto' picks by interval: ≤15m → day, ≤4h → week, other minutes and daily → month, larger → year
export function periodKeyOf(kind: string, interval: string): (t: number) => number {
  let k = kind
  if (k === 'auto') {
    const p = parseInterval(interval)
    k = !p ? 'day' : p.unit === 'min' ? (p.n <= 15 ? 'day' : p.n <= 240 ? 'week' : 'month') : p.unit === 'D' ? 'month' : 'year'
  }
  if (k === 'week') return brokerWeek
  if (k === 'month') return brokerMonth
  if (k === 'year') return brokerYear
  return brokerDay
}

// 多周期的分桶键 / bucket key for a higher timeframe
export function tfKeyFn(code: string): ((t: number) => number) | null {
  const p = parseInterval(code)
  if (!p) return null
  if (p.unit === 'min') {
    const len = p.n * 60
    return isBrokerAnchored(p.n) ? (t) => brokerBucketStart(p.n, t) : (t) => Math.floor(t / len)
  }
  if (p.unit === 'D') return (t) => Math.floor(brokerDay(t) / p.n)
  if (p.unit === 'W') return (t) => Math.floor(brokerWeek(t) / p.n)
  return (t) => Math.floor(brokerMonth(t) / p.n)
}

// 一根 K 线大约多少秒（日线以上按自然时长）/ rough seconds per bar
export function barSeconds(code: string): number {
  const p = parseInterval(code)
  if (!p) return 60
  if (p.unit === 'min') return p.n * 60
  if (p.unit === 'D') return p.n * 86400
  if (p.unit === 'W') return p.n * 604800
  return p.n * 2592000
}
