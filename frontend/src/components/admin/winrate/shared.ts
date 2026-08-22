// 胜率盯盘组件共享常量与时间换算。时段的小时窗口与 IANA 时区由后端下发
// （sessions 字段），这里只做"翻译成浏览者钟点"，绝不复制一份时段定义。
// Shared constants and time helpers. Session definitions ship from the
// backend; this file only restates them in the viewer's clock.
import type { SessionWindow } from '../../../api/types'

// 已判定不足此数只显示笔数，与后端展示纪律一致 / below this, counts only
export const MIN_SAMPLES = 5

// 时段配色：亚洲青 / 欧洲紫 / 纽约金 / for the timeline bands and highlights
export const SESSION_COLORS: Record<string, string> = {
  asia: '#22d3ee',
  europe: '#c084fc',
  newyork: '#fbbf24',
}

/** 某个 IANA 时区在给定时刻的 UTC 偏移（分钟）。夏令时体现在这里：同一个时区
 *  一月和七月返回的值不同。
 *  A zone's UTC offset in minutes at a given instant; DST shows up here, with
 *  January and July returning different values for the same zone. */
export function zoneOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at)
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0'
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!m) return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
}

export function fmtClock(totalMinutes: number): string {
  // 取模到一天内：时段换算到本地时区后可能跨零点（东京盘对欧洲用户就是凌晨）。
  // Wrap into a day: converted to the viewer's zone a session can cross midnight
  // (the Tokyo session is the small hours for a European admin).
  const m = ((totalMinutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 把时段窗口翻译成看的人本地时区的钟点，例如「16:00–01:00」。
 *  按"此刻"的偏移换算，所以夏令时切换后这行字自己就变了。
 *  Restate the window in the viewer's local clock, e.g. "16:00–01:00", using the
 *  offsets in effect right now — so it shifts by itself across a DST changeover. */
export function localWindow(session: SessionWindow, now: Date): { start: string; end: string } {
  const viewerOffset = -now.getTimezoneOffset()
  const delta = viewerOffset - zoneOffsetMinutes(session.tz, now)
  return {
    start: fmtClock(session.startHour * 60 + delta),
    end: fmtClock(session.endHour * 60 + delta),
  }
}

/** 该时区此刻的钟点（分钟数）。用 Intl 直接取该时区的 时:分，DST 天然正确。
 *  Minutes-of-day in a zone right now; Intl handles DST. */
export function minutesInZone(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return (h % 24) * 60 + m
}

export type SessionStatus =
  | { state: 'active'; minutesToEnd: number }
  | { state: 'upcoming'; minutesToStart: number }

/** 时段状态按**该时段自己时区**的钟点判定（窗口在本时区内不跨零点），
 *  不用浏览者钟点反推——DST 切换日会错一小时。
 *  Status is judged in the session's own zone, where windows never wrap. */
export function sessionStatus(s: SessionWindow, now: Date): SessionStatus {
  const m = minutesInZone(s.tz, now)
  const start = s.startHour * 60
  const end = s.endHour * 60
  if (start <= m && m < end) return { state: 'active', minutesToEnd: end - m }
  return { state: 'upcoming', minutesToStart: (start - m + 1440) % 1440 }
}

// 秒数 → 人话时长的数值+单位。单位刻意不在这里拼成文字：调用方要用
// t('admin.winrate.unit.min'|'h'|'d') 走 i18n，否则中文界面里会混进英文单位。
// Seconds → a humanized {value, unit} pair. The unit is deliberately left
// untranslated here — callers resolve it via t('admin.winrate.unit.min'|'h'|'d')
// so a Chinese UI never shows an English unit.
export type DurationUnit = 'min' | 'h' | 'd'

export function fmtDuration(seconds: number): { value: string; unit: DurationUnit } {
  if (seconds < 3600) return { value: String(Math.round(seconds / 60)), unit: 'min' }
  if (seconds < 86400) return { value: (seconds / 3600).toFixed(1), unit: 'h' }
  return { value: (seconds / 86400).toFixed(1), unit: 'd' }
}
