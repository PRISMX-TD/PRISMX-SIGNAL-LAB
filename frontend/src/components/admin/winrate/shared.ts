// 胜率盯盘组件共享常量与时间换算。时段的小时窗口与 IANA 时区由后端下发
// （sessions 字段），这里只做"翻译成浏览者钟点"，绝不复制一份时段定义。
// Shared constants and time helpers. Session definitions ship from the
// backend; this file only restates them in the viewer's clock.
import type { TFunction } from 'i18next'
import type { SessionWindow } from '../../../api/types'

// 已判定样本少于这个数的格子按"样本不足"处理：只显示样本数、不显示百分比。
// 7 天再切成三个时段之后，一个格子里常常只有两三笔——"66.7% 胜率(3 笔里赢 2)"
// 是个会被当真的数字，而它和抛硬币没有区别。宁可显示"样本不足"也不给一个
// 看起来很确定的百分比。
// 这段论证原本住在 StrategyWinratePanel.tsx 里、只管一张矩阵表；搬到这里之后
// 它同时管住了矩阵格子、胜率图元、推荐榜入榜门槛、卡内品种前三四处判断——
// 作用半径变大，论证更该跟着走，不是更该被压成一行。
// Cells with fewer resolved samples than this show the count instead of a
// percentage. Seven days split three ways often leaves two or three trades per
// cell, and "66.7% (2 of 3)" is a figure people act on despite being
// indistinguishable from a coin flip. Better to say "too few" than to print a
// confident-looking percentage.
// This reasoning used to live in StrategyWinratePanel.tsx and govern one matrix
// table; here it governs four call sites at once — matrix cells, the win-rate
// glyph, the recommendation cut-off, and a card's top-3 symbols. A wider blast
// radius is a reason to carry the argument along, not to compress it away.
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

/** 一天内的**钟点**，如「06:00」。只用于"几点"，不要用来渲染"还有多久"——
 *  两者都是分钟数，但 `02:14` 当成时长读起来像个时刻，读者分不出这行字在说
 *  "凌晨两点" 还是 "还有两小时"。时长请用 `fmtDurationHm`。
 *  A clock reading within a day, e.g. "06:00". For times of day only — never for
 *  "how long left": both are minute counts, but `02:14` rendered as a duration
 *  reads like an instant, leaving no way to tell "2:14 a.m." from "2h14m left".
 *  Use `fmtDurationHm` for durations. */
export function fmtClock(totalMinutes: number): string {
  // 取模到一天内：时段换算到本地时区后可能跨零点（东京盘对欧洲用户就是凌晨）。
  // Wrap into a day: converted to the viewer's zone a session can cross midnight
  // (the Tokyo session is the small hours for a European admin).
  const m = ((totalMinutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 分钟数 → 时长文本，如「2h14m」「45m」「3h」。设计文档 §5.1 就是这个写法
 *  （"进行中剩 2h14m / 3h 后开始"），刻意与 `fmtClock` 的 `02:14` 长得不一样：
 *  时段轴里"轴标签是钟点、状态芯片是倒计时"两种数字只隔二十行，靠形状就能区分
 *  才不会被读错。整小时省掉 `0m`，与设计文档的"3h 后开始"一致。
 *  单位字母 h/m 两种语言都不翻译：倒计时是紧凑读数（同秒表、同 `12:30` 这类
 *  时间记法），中文界面里写成「2小时14分钟」会把一行芯片撑开，设计文档的中文
 *  原文用的也是 2h14m。真正要读成人话的时长（平均判定用时）走 `fmtDurationText`,
 *  那条路径的单位是过 i18n 的。
 *  Minutes → a duration string: "2h14m", "45m", "3h". This is the design doc's
 *  own notation (§5.1, "2h14m left / starts in 3h"), deliberately shaped unlike
 *  fmtClock's "02:14": the timeline puts an axis clock label and a countdown
 *  twenty lines apart, and only a different shape keeps them from being misread.
 *  A whole hour drops the "0m", matching the doc's "starts in 3h".
 *  The h/m letters stay untranslated in both languages: a countdown is a compact
 *  readout (like a stopwatch, or "12:30" itself), "2小时14分钟" would blow out
 *  the chip row, and the doc's Chinese text writes 2h14m as well. Durations that
 *  should read as prose (mean time to resolution) go through fmtDurationText,
 *  where the unit word does get translated. */
export function fmtDurationHm(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes))
  const h = Math.floor(m / 60)
  const mins = m % 60
  if (h === 0) return `${mins}m`
  if (mins === 0) return `${h}h`
  return `${h}h${String(mins).padStart(2, '0')}m`
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

/** 秒数 → 拼好单位的人话文本，如「12 分钟」「3.2 小时」/「12 min」。
 *  `fmtDuration` 只吐 {value, unit} 是为了把单位词留给 i18n（写死英文单位会漏进
 *  中文界面），但"取值 + 过 t() + 中间加一个空格"这三步每个调用方都要做同一遍，
 *  所以拼接也住在这里：RecommendationCards 与 StrategyDetail 曾经各存了一份逐字
 *  相同的私有实现，两处的空格与键名从此只能靠人肉保持一致。
 *  Seconds → a humanized string, e.g. "3.2 h" / "3.2 小时". fmtDuration returns
 *  only {value, unit} so the unit word goes through i18n (a hardcoded English
 *  word would leak into the Chinese UI) — but "read the pair, run t(), join with
 *  a space" is the same three steps at every call site, so the join lives here
 *  too: RecommendationCards and StrategyDetail each carried a verbatim copy of
 *  this helper, leaving the spacing and key names to be kept in step by hand. */
export function fmtDurationText(t: TFunction, seconds: number): string {
  const { value, unit } = fmtDuration(seconds)
  return `${value} ${t(`admin.winrate.unit.${unit}`)}`
}
