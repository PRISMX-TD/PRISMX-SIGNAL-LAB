// 操作日志的时间口径：全部按北京时间（UTC+8，无夏令时）显示、分日期组、换算筛选范围。
//
// 为什么不用 toLocaleString({timeZone})：分日期组要的是「这一行落在北京时间哪一天」这个
// 可比较的键，筛选要的是「北京时间某一天的 0 点是 UTC 几点」，两个方向都是纯算术。直接
// 把 UTC 毫秒数加 8 小时、再用 getUTC* 读出来，结果与浏览器所在时区无关——欧美时区的管理
// 员看到的分组和中国的一样，单测在任何机器上也是同一个答案。时差常量用全站那一份
// （utils/indicators 的 DAY_TZ_OFFSET_SEC），解析后端时间用 api/utils 的 parseTime
// （「不带时区就是 UTC」的唯一实现），这里一份都不再抄。
//
// The activity log's single notion of time: displayed, grouped by day and converted for
// filters in Beijing time (UTC+8, no DST). Grouping needs a comparable "which Beijing day"
// key and filtering needs "UTC instant of a Beijing midnight" — both plain arithmetic, so
// UTC millis + 8h read back with getUTC* gives the same answer in every browser zone and on
// every test machine. The offset is the app-wide DAY_TZ_OFFSET_SEC and backend times go
// through api/utils' parseTime (the one "no zone means UTC" rule); nothing is re-copied.
import type { TFunction } from 'i18next'
import { parseTime } from '../../../api/utils'
import { DAY_TZ_OFFSET_SEC } from '../../../utils/indicators'

const OFFSET_MS = DAY_TZ_OFFSET_SEC * 1000
const DAY_MS = 86_400_000
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

const pad = (n: number) => String(n).padStart(2, '0')

/** 一个时刻在北京时间的各个分量；读不出来为 null。/ Beijing wall-clock parts of an instant. */
export function bjParts(input: string | Date | null | undefined) {
  const d = input instanceof Date ? input : parseTime(input)
  if (!d || Number.isNaN(d.getTime())) return null
  const s = new Date(d.getTime() + OFFSET_MS)
  return {
    y: s.getUTCFullYear(),
    m: s.getUTCMonth() + 1,
    d: s.getUTCDate(),
    hh: s.getUTCHours(),
    mm: s.getUTCMinutes(),
    ss: s.getUTCSeconds(),
    dow: s.getUTCDay(),
  }
}

/** 北京时间的日期键 YYYY-MM-DD（分组与比较用）。/ Beijing day key, for grouping and comparison. */
export function bjDayKey(input: string | Date | null | undefined): string {
  const p = bjParts(input)
  return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : ''
}

/** HH:mm:ss（列表的时间列）。/ HH:mm:ss for the time column. */
export function bjClock(input: string | Date | null | undefined): string {
  const p = bjParts(input)
  return p ? `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}` : '—'
}

/** HH:mm（「更新于」与句子里提到的时刻）。/ HH:mm for "updated at" and times inside sentences. */
export function bjHm(input: string | Date | null | undefined): string {
  const p = bjParts(input)
  return p ? `${pad(p.hh)}:${pad(p.mm)}` : '—'
}

/** YYYY-MM-DD（会员到期这类只关心哪一天的值）。/ Date only, for values such as plan expiry. */
export function bjDate(input: string | Date | null | undefined): string {
  return bjDayKey(input) || '—'
}

/** YYYY-MM-DD HH:mm（比赛起止这类要精确到分钟的值）。/ Minute precision, e.g. competition times. */
export function bjDateTime(input: string | Date | null | undefined): string {
  const p = bjParts(input)
  return p ? `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}` : '—'
}

/** 详情里的完整时间，带秒和时区后缀。/ Full timestamp with seconds and zone suffix, for the drawer. */
export function bjFull(input: string | Date | null | undefined): string {
  const p = bjParts(input)
  return p ? `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)} UTC+8` : '—'
}

/** 北京时间某一天 0 点对应的 UTC 时刻。/ The UTC instant of a Beijing midnight. */
export function bjDayStart(dayKey: string): Date | null {
  const m = ISO_DAY.exec(dayKey)
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - OFFSET_MS)
}

/** 日期键前后挪 n 天。/ Shift a day key by n days. */
export function shiftDay(dayKey: string, n: number): string {
  const start = bjDayStart(dayKey)
  return start ? bjDayKey(new Date(start.getTime() + n * DAY_MS)) : ''
}

export type DatePreset = 'all' | 'today' | 'yesterday' | 'week' | 'day'
export const DATE_PRESETS: DatePreset[] = ['all', 'today', 'yesterday', 'week', 'day']

/**
 * 日期筛选 → 后端的 since / until（UTC ISO，左闭右开）。「今天」「最近 7 天」不给上界：
 * 上界写成明天 0 点和不写是同一个结果，不写还省得面板开过零点之后漏掉新的一天。
 * 「指定日期」没选好日子时等于不筛。
 * Date filter → the backend's since / until (UTC ISO, half-open). "Today" and "last 7 days"
 * carry no upper bound: tomorrow's midnight would mean the same thing, and leaving it out
 * keeps a panel left open past midnight from missing the new day. "Pick a day" without a
 * valid day means no filter.
 */
export function dateRange(preset: DatePreset, now: Date, day?: string | null): { since: string | null; until: string | null } {
  const today = bjDayKey(now)
  const span = (from: string, days: number | null) => {
    const start = bjDayStart(from)
    if (!start) return { since: null, until: null }
    return {
      since: start.toISOString(),
      until: days == null ? null : new Date(start.getTime() + days * DAY_MS).toISOString(),
    }
  }
  switch (preset) {
    case 'today':
      return span(today, null)
    case 'yesterday':
      return span(shiftDay(today, -1), 1)
    case 'week':
      // 含今天在内的 7 个北京日 / seven Beijing days including today
      return span(shiftDay(today, -6), null)
    case 'day':
      return day && ISO_DAY.test(day) ? span(day, 1) : { since: null, until: null }
    default:
      return { since: null, until: null }
  }
}

/**
 * 日期分隔行的文字：「今天 · 10月9日 周四」/「Today · Thu 9 Oct」；不是今年的带上年份。
 * 月日与星期走文案键而不是 Intl：结果与浏览器语言环境无关，单测也能钉死。
 * The day separator's label; the year appears only when it isn't the current one. Month,
 * day and weekday go through copy keys rather than Intl so the result doesn't depend on
 * the browser locale and tests can pin it.
 */
export function dayLabel(dayKey: string, now: Date, t: TFunction): string {
  const start = bjDayStart(dayKey)
  const p = start ? bjParts(start) : null
  if (!p) return dayKey
  const today = bjDayKey(now)
  const date = String(p.y) === today.slice(0, 4)
    ? t('admin.log.day.md', { m: p.m, d: p.d, wd: t(`admin.log.day.weekday.${p.dow}`), mon: t(`admin.log.day.month.${p.m}`) })
    : t('admin.log.day.ymd', { y: p.y, m: p.m, d: p.d, wd: t(`admin.log.day.weekday.${p.dow}`), mon: t(`admin.log.day.month.${p.m}`) })
  if (dayKey === today) return `${t('admin.log.day.today')} · ${date}`
  if (dayKey === shiftDay(today, -1)) return `${t('admin.log.day.yesterday')} · ${date}`
  return date
}

/**
 * 按北京日分组，组内保持传入顺序（调用方已按 ts 倒序排好）。
 * Group by Beijing day, keeping the given order within a group (the caller sorts by ts desc).
 */
export function groupByDay<T extends { ts: string }>(items: T[]): { day: string; items: T[] }[] {
  const out: { day: string; items: T[] }[] = []
  for (const it of items) {
    const day = bjDayKey(it.ts)
    const last = out[out.length - 1]
    if (last && last.day === day) last.items.push(it)
    else out.push({ day, items: [it] })
  }
  return out
}
