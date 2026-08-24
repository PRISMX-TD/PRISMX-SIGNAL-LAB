// 胜率页共享：判定规则、配色、时间换算。
//
// 这一版页面的核心是把统计学翻译成人话：页面上**只有一条**"能不能当结论"的
// 规则（verdictOf），所有层级——总览、策略卡、时段行、钟点格、品种行——都从
// 这里拿判定，再把它渲染成「明显高于一半 / 和一半差不多 / 笔数还少」这类新手
// 一眼能懂的词。置信区间仍是判定依据，但不再作为图形让读者自己去解读。
//
// 时段的小时窗口与 IANA 时区由后端下发（sessions 字段），这里只做"翻译成浏览者
// 钟点"，绝不复制一份时段定义。
//
// Shared helpers for the win-rate page: the verdict rule, colours, time maths.
// The page's whole point is to translate statistics into plain words, so there
// is exactly ONE "can this be a conclusion" rule (verdictOf); every layer —
// hero, strategy card, session row, hour cell, symbol row — gets its verdict
// here and renders it as a phrase a newcomer understands. The confidence
// interval is still the evidence; it just stops being a glyph the reader has to
// decode. Session definitions ship from the backend; this file only restates
// them in the viewer's clock.
import type { TFunction } from 'i18next'
import type { SessionWindow } from '../../../api/types'

// 已判定样本少于这个数的格子不显示百分比。
//
// 从 5 降到 3（产品要求）：细到 24 个钟点之后，真实数据里几乎每一格都不到 5 笔，
// 整张图一片空白，等于这个维度白做。
//
// 降到 3 是安全的，因为**真正把关的是下面的 Wilson 区间，不是这个门槛**：3 笔
// 无论全赢还是全输，区间都跨过 50%（3/3 的下限只有 0.439），一律判成"还看不出
// 高低"、显示成灰色。也就是说 3 笔的格子只会露出一个数字，绝不会被涂成绿色或
// 红色、被读成结论。要拿到颜色至少得 4 笔全赢或全输（4/4 的下限 0.510）。
// 门槛留在 3 而不是干脆去掉，是为了挡住 1–2 笔那种"100%"——那个连数字都不该给。
//
// Below this many resolved trades no percentage is shown.
//
// Lowered from 5 to 3 (product decision): sliced 24 ways, real data leaves
// almost every hour cell under 5, so the whole grid came out blank and the
// dimension was wasted.
//
// Three is safe because **the Wilson interval below is what actually gates the
// verdict, not this floor**: at 3 trades the interval straddles 50% whether they
// all won or all lost (3/3 has a lower bound of just 0.439), so such a cell is
// always "can't tell yet" and always grey. A 3-trade cell can therefore show a
// number but can never be painted green or red and read as a conclusion —
// colour needs at least 4 straight wins or losses (4/4 bounds at 0.510). The
// floor stays at 3 rather than going away entirely to suppress the 1-2 trade
// "100%", which should not show a number at all.
export const MIN_SAMPLES = 3

// 区间跨过 50% 时再分两种情况：区间比这还宽（±10 个百分点以上）说「笔数还少，
// 先别下结论」，比这窄才说「和一半差不多」——前者是证据不够，后者是证据说没差。
// 在 50% 附近，宽 0.20 大约对应 90 多笔。
// When the interval straddles 50%, split two cases: wider than this (more than
// ±10 points) reads "too few to tell", narrower reads "about even" — the first
// is a lack of evidence, the second is evidence of no edge. Near 50%, a width
// of 0.20 corresponds to roughly 90 trades.
export const UNSURE_WIDTH = 0.2

// 时段配色：亚洲青 / 欧洲紫 / 纽约金，「其他时段」用说明文字灰。只用在小圆点与
// 时段色带上，是身份色不是好坏色。
// Session identity colours (asia / europe / newyork, plus the caption grey for
// 'outside'), used only for dots and timeline bands — identity, not outcome.
export const SESSION_COLORS: Record<string, string> = {
  asia: '#22d3ee',
  europe: '#c084fc',
  newyork: '#fbbf24',
  outside: 'var(--text-3)',
}

// 方向色刻意不用胜负色：做多/做空是身份分类不是好坏，用绿红会读成"做多=好"。
// Direction colours avoid the win/loss palette: long and short are identities,
// not outcomes, and green/red would read as "long = good".
export const SIDE_COLORS: Record<string, string> = { BUY: '#60a5fa', SELL: '#f0abfc' }

// waiting / broken：有信号但一笔都还没判定——全部在等结果，或全部追踪中断。
// 它们不是「只有 0 笔」：那会把"还没出结果"和"样本太少"混成一个意思。
// waiting / broken: signals exist but none has resolved yet — all still open, or
// all with broken tracking. Not "only 0 trades", which would conflate "no
// outcome yet" with "too small a sample".
export type VerdictKind = 'strong' | 'weak' | 'even' | 'unsure' | 'thin' | 'waiting' | 'broken' | 'none'

export interface RateLike {
  samples: number
  resolved: number
  winRate: number | null
  wilsonLow: number | null
  wilsonHigh: number | null
  pending?: number
  stale?: number
}

/** 四种"有百分比可看"的判定 / the four verdicts that come with a percentage */
export const isRated = (k: VerdictKind): boolean =>
  k === 'strong' || k === 'weak' || k === 'even' || k === 'unsure'

/** 全页唯一的判定规则。区间完全落在 50% 一侧才算"明显"；跨过 50% 按宽度分
 *  "说不准"与"差不多"；笔数不够只报笔数。
 *  The page's single verdict rule: only an interval entirely on one side of 50%
 *  counts as "clearly"; straddling splits by width into "unsure" vs "even";
 *  too few trades reports the count only. */
export function verdictOf(b: RateLike): VerdictKind {
  if (b.samples === 0) return 'none'
  if (b.resolved === 0) return (b.pending ?? 0) > 0 ? 'waiting' : 'broken'
  if (b.winRate === null || b.wilsonLow === null || b.wilsonHigh === null || b.resolved < MIN_SAMPLES) return 'thin'
  if (b.wilsonLow > 0.5) return 'strong'
  if (b.wilsonHigh < 0.5) return 'weak'
  if (b.wilsonHigh - b.wilsonLow > UNSURE_WIDTH) return 'unsure'
  return 'even'
}

/** Wilson 95% 区间，与后端 strategy_winrate.wilson_bounds 同一公式。只有钟点格
 *  需要在前端算——后端对每个钟点只给止盈/止损笔数，不给区间。
 *  Wilson 95% interval, the same formula as the backend's wilson_bounds. Only
 *  the hour cells need it client-side: the backend ships raw TP/SL counts
 *  per hour without bounds. */
export function wilsonBounds(hit: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null
  const p = hit / n
  const denom = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)]
}

export function rateFromCounts(tp: number, sl: number): RateLike {
  const n = tp + sl
  const bounds = wilsonBounds(tp, n)
  return {
    samples: n,
    resolved: n,
    winRate: n > 0 ? tp / n : null,
    wilsonLow: bounds ? bounds[0] : null,
    wilsonHigh: bounds ? bounds[1] : null,
    pending: 0,
    stale: 0,
  }
}

// 判定配色：绿/红是市场语义色（设计令牌里的 --up / --down），只在"能当结论"时
// 出现；其余一律中性灰，而且引用 index.css 的文字灰令牌而不是抄数值——令牌
// 抬一次，这里跟着动。
// Verdict colours: green/red are the market tokens (--up / --down) and appear
// only when something is a conclusion; everything else is neutral and refers
// to the text-grey tokens in index.css rather than copying their values, so a
// token lift moves this page with it.
export const VERDICT_COLOR: Record<VerdictKind, string> = {
  strong: 'var(--up)',
  weak: 'var(--down)',
  even: 'var(--text-2)',
  unsure: 'var(--text-3)',
  thin: 'var(--text-3)',
  waiting: 'var(--text-3)',
  broken: 'var(--text-3)',
  none: 'var(--text-3)',
}

export const VERDICT_BG: Record<VerdictKind, string> = {
  strong: 'var(--up-bg)',
  weak: 'var(--down-bg)',
  even: 'rgba(255,255,255,0.07)',
  unsure: 'rgba(255,255,255,0.05)',
  thin: 'rgba(255,255,255,0.04)',
  waiting: 'rgba(255,255,255,0.04)',
  broken: 'rgba(255,255,255,0.04)',
  none: 'transparent',
}

export const fmtPct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`
export const fmtInt = (n: number): string => n.toLocaleString('en-US')

/** 某个 IANA 时区在给定时刻的 UTC 偏移（分钟）。夏令时体现在这里。
 *  A zone's UTC offset in minutes at a given instant; DST shows up here. */
export function zoneOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at)
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0'
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!m) return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
}

/** 一天内的钟点，如「06:00」。只用于"几点"，时长请用 fmtDurationHm。
 *  A clock reading, e.g. "06:00". Times of day only; durations use fmtDurationHm. */
export function fmtClock(totalMinutes: number): string {
  const m = ((totalMinutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 分钟数 → 时长文本，如「2h14m」「45m」「3h」。刻意与 fmtClock 的「02:14」长得
 *  不一样，同一屏里钟点和倒计时靠形状就能区分。h/m 两种语言都不翻译：倒计时是
 *  紧凑读数，中文写成「2小时14分钟」会把芯片撑开。
 *  Minutes → "2h14m" / "45m" / "3h"; deliberately shaped unlike fmtClock's
 *  "02:14" so a clock and a countdown on the same screen can't be confused. */
export function fmtDurationHm(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes))
  const h = Math.floor(m / 60)
  const mins = m % 60
  if (h === 0) return `${mins}m`
  if (mins === 0) return `${h}h`
  return `${h}h${String(mins).padStart(2, '0')}m`
}

/** 把时段窗口翻译成看的人本地时区的钟点，例如「16:00–01:00」。
 *  Restate the window in the viewer's local clock, e.g. "16:00–01:00". */
export function localWindow(session: SessionWindow, now: Date): { start: string; end: string } {
  const viewerOffset = -now.getTimezoneOffset()
  const delta = viewerOffset - zoneOffsetMinutes(session.tz, now)
  return {
    start: fmtClock(session.startHour * 60 + delta),
    end: fmtClock(session.endHour * 60 + delta),
  }
}

/** 该时区此刻的钟点（分钟数）。Intl 处理 DST。
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

/** 时段状态按该时段自己时区的钟点判定，不用浏览者钟点反推——DST 切换日会错一小时。
 *  Status is judged in the session's own zone, where windows never wrap. */
export function sessionStatus(s: SessionWindow, now: Date): SessionStatus {
  const m = minutesInZone(s.tz, now)
  const start = s.startHour * 60
  const end = s.endHour * 60
  if (start <= m && m < end) return { state: 'active', minutesToEnd: end - m }
  return { state: 'upcoming', minutesToStart: (start - m + 1440) % 1440 }
}

export type DurationUnit = 'min' | 'h' | 'd'

/** 秒数 → {value, unit}。单位留给 i18n，否则中文界面会混进英文单位。
 *  Seconds → {value, unit}; the unit word goes through i18n. */
export function fmtDuration(seconds: number): { value: string; unit: DurationUnit } {
  if (seconds < 3600) return { value: String(Math.round(seconds / 60)), unit: 'min' }
  if (seconds < 86400) return { value: (seconds / 3600).toFixed(1), unit: 'h' }
  return { value: (seconds / 86400).toFixed(1), unit: 'd' }
}

/** 秒数 → 拼好单位的人话文本，如「12 分钟」「3.2 小时」/「12 min」。
 *  Seconds → a humanized string, e.g. "3.2 h" / "3.2 小时". */
export function fmtDurationText(t: TFunction, seconds: number): string {
  const { value, unit } = fmtDuration(seconds)
  return `${value} ${t(`admin.winrate.unit.${unit}`)}`
}
