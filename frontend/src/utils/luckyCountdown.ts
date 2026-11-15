// 轮盘页倒计时：后端时间是不带 Z 的 naive UTC，必须走 parseTime，直接 new Date(iso)
// 会按本机时区解析、差出几小时。
// Lucky-wheel countdown: backend datetimes are naive UTC without a `Z`, so go through parseTime —
// `new Date(iso)` would read them in the device's timezone and be off by hours.
import { fmtStamp, parseTime } from '../api/utils'
import { EMPTY } from './format'

export type Countdown = { d: number; h: number; m: number; s: number; done: boolean }

export function countdownParts(to: string | null | undefined, nowMs: number): Countdown | null {
  const end = parseTime(to)
  if (!end || Number.isNaN(end.getTime())) return null
  const ms = Math.max(0, end.getTime() - nowMs)
  return {
    d: Math.floor(ms / 86400000),
    h: Math.floor(ms / 3600000) % 24,
    m: Math.floor(ms / 60000) % 60,
    s: Math.floor(ms / 1000) % 60,
    done: ms === 0,
  }
}

// 开放时间段：「10-21 15:00 ～ 10-29 15:00 UTC+8」。写法与全站 fmtStamp 一致（月-日），不带年份和秒、
// 只在末尾标一次时区，放在标题下面不至于折成三行。
// The open window as "10-21 15:00 ～ 10-29 15:00 UTC+8": the site's fmtStamp form (month-day) without
// year or seconds, the zone labelled once, so it fits under the title without wrapping three times.
export function fmtWindow(from: string | null | undefined, to: string | null | undefined): string {
  const one = (iso: string | null | undefined) => {
    const d = parseTime(iso)
    if (!d || Number.isNaN(d.getTime())) return EMPTY
    return fmtStamp(d, { year: 'never', clock: 'hm' })
  }
  return `${one(from)} ～ ${one(to)} UTC+8`
}
