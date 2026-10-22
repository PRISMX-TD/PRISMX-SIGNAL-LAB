// 轮盘页倒计时：后端时间是不带 Z 的 naive UTC，必须走 parseTime，直接 new Date(iso)
// 会按本机时区解析、差出几小时。
// Lucky-wheel countdown: backend datetimes are naive UTC without a `Z`, so go through parseTime —
// `new Date(iso)` would read them in the device's timezone and be off by hours.
import { parseTime } from '../api/utils'

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
