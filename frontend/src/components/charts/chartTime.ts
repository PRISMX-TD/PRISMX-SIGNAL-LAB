// 图表时间轴 / 十字线的时间格式，按用户选的时区显示（默认仍是 UTC+8，与全站一致）。
// 日线及以上周期一律按「券商交易日」写日期，不随时区变：日线 t 是券商零点（UTC 21/22 点），
// 换到 UTC 时区直接取日期会差一天——TradingView 也是按交易日标日线。
// Chart axis / crosshair time labels in the user's chosen timezone (default stays UTC+8,
// like the rest of the site). Daily-and-longer bars are always labelled with the broker
// trading date regardless of timezone: a daily t is broker midnight (21/22:00 UTC), and
// taking the UTC date would be a day early — TradingView labels daily bars by session too.
import { TickMarkType, type Time, type UTCTimestamp } from 'lightweight-charts'
import { brokerOffsetSec } from './derivedIntervals'

export type IntervalKindLike = 'intraday' | 'daily' | 'weekly' | 'monthly'

const HALF_DAY = 12 * 3600
const dtfCache = new Map<string, Intl.DateTimeFormat>()
const offCache = new Map<string, number>()

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    dtfCache.set(tz, f)
  }
  return f
}

// 某时区在 t 时刻相对 UTC 的偏移（秒）。按小时缓存：时区规则只会在整点（少数半点）切换，
// 刻度格式化一帧要调几十次，不能每次都走 Intl。
// Offset (seconds) of a zone from UTC at t, cached per hour: zone rules only switch on the
// hour, and the axis formatter runs dozens of times per frame.
export function tzOffsetSec(tz: string, t: number): number {
  if (tz === 'UTC') return 0
  if (tz === 'broker') return brokerOffsetSec(t)
  if (tz === 'local') return -new Date(t * 1000).getTimezoneOffset() * 60
  const key = `${tz}|${Math.floor(t / 3600)}`
  const hit = offCache.get(key)
  if (hit !== undefined) return hit
  let off = 0
  try {
    const parts = dtf(tz).formatToParts(new Date(t * 1000))
    const g = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'))
    off = Math.round((asUtc - Math.floor(t) * 1000) / 1000)
  } catch { off = 8 * 3600 }
  if (offCache.size > 20000) offCache.clear()
  offCache.set(key, off)
  return off
}

// 「墙上时间」：返回一个按 UTC 字段读取就是该时区本地时间的 Date。
// "Wall clock": a Date whose UTC fields read as local time in the zone.
export function wallClock(tz: string, t: number): Date {
  return new Date((t + tzOffsetSec(tz, t)) * 1000)
}

const p2 = (n: number) => String(n).padStart(2, '0')

// 时区在列表里的显示名，例如「UTC+8」「UTC−4:30」。/ Display offset label, e.g. "UTC+8".
export function offsetLabel(tz: string, t = Date.now() / 1000): string {
  const off = tzOffsetSec(tz, t)
  if (off === 0) return 'UTC'
  const sign = off > 0 ? '+' : '−'
  const a = Math.abs(off)
  const h = Math.floor(a / 3600)
  const m = Math.round((a % 3600) / 60)
  return `UTC${sign}${h}${m ? `:${p2(m)}` : ''}`
}

const monthFmtCache = new Map<string, Intl.DateTimeFormat>()
function monthName(lang: string, month0: number): string {
  let f = monthFmtCache.get(lang)
  if (!f) {
    try { f = new Intl.DateTimeFormat(lang, { month: 'short', timeZone: 'UTC' }) } catch { f = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }) }
    monthFmtCache.set(lang, f)
  }
  return f.format(new Date(Date.UTC(2000, month0, 1)))
}
const wdFmtCache = new Map<string, Intl.DateTimeFormat>()
function weekdayName(lang: string, d: Date): string {
  let f = wdFmtCache.get(lang)
  if (!f) {
    try { f = new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }) } catch { f = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }) }
    wdFmtCache.set(lang, f)
  }
  return f.format(d)
}

// 券商交易日（日线及以上用）/ broker trading date, for daily and longer bars
function brokerDate(t: number): Date {
  return new Date((t + HALF_DAY) * 1000)
}

export interface TimeFormatters {
  tick: (time: Time, type: TickMarkType) => string
  crosshair: (time: Time) => string
}

export function makeTimeFormatters(tz: string, kind: IntervalKindLike, lang: string): TimeFormatters {
  const dateOnly = kind !== 'intraday'
  const tick = (time: Time, type: TickMarkType): string => {
    const t = time as UTCTimestamp
    const d = dateOnly ? brokerDate(t) : wallClock(tz, t)
    switch (type) {
      case TickMarkType.Year: return String(d.getUTCFullYear())
      case TickMarkType.Month: return d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : monthName(lang, d.getUTCMonth())
      case TickMarkType.DayOfMonth: return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
      case TickMarkType.TimeWithSeconds: return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
      default: {
        if (dateOnly) return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
        // 时区零点的刻度写日期，其它写钟点。/ Midnight in the zone shows the date.
        if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
        return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
      }
    }
  }
  const crosshair = (time: Time): string => {
    const t = time as UTCTimestamp
    if (kind === 'monthly') {
      const d = brokerDate(t)
      return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`
    }
    if (dateOnly) {
      const d = brokerDate(t)
      return `${weekdayName(lang, d)} ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
    }
    const d = wallClock(tz, t)
    return `${weekdayName(lang, d)} ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
  }
  return { tick, crosshair }
}

// 时区选择列表：常用交易中心。'broker' = 券商服务器时间（与 MT5 终端显示一致）。
// Timezone picker list: common trading centres. 'broker' = broker server time (as MT5 shows).
export const TIMEZONES: string[] = [
  'broker', 'local', 'UTC',
  'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Berlin', 'Europe/Moscow',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Singapore',
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland',
]

// 时区名里的城市部分 / the city part of a zone id
export function tzCity(tz: string): string {
  const i = tz.lastIndexOf('/')
  return (i >= 0 ? tz.slice(i + 1) : tz).replace(/_/g, ' ')
}
