// 胜率页共享：判定规则、配色、时间换算。
//
// 页面上**只有一条**判定规则（verdictOf），所有层级——策略卡、时段行、钟点格、
// 品种行、顶层芯片——都从这里拿判定，再渲染成颜色：51% 起绿、40–50% 橙、40% 以下红。
// 判定词本身已从界面上全部撤掉（只留给读屏器），所以这条规则的唯一出口就是颜色。
//
// 时段的小时窗口与 IANA 时区由后端下发（sessions 字段），这里只做"翻译成浏览者
// 钟点"，绝不复制一份时段定义。
//
// Shared helpers for the win-rate page: the verdict rule, colours, time maths.
// There is exactly ONE verdict rule (verdictOf); every layer — strategy card,
// session row, hour cell, symbol row, top-layer chip — takes its verdict here
// and renders it as colour: green from 51%, amber 40-50%, red below. The worded verdicts are
// gone from the interface (screen readers still get them), so colour is this
// rule's only outlet. Session definitions ship from the backend; this file only
// restates them in the viewer's clock.
import type { TFunction } from 'i18next'
import type { HourOutcome, SessionWindow } from '../../api/types'

// 已判定样本少于这个数的格子不显示百分比——只挡住 1–2 笔那种「100%」，
// 那个连数字都不该给。3 笔起就照常显示。
// Below this many resolved trades no percentage is shown. It only suppresses the
// 1-2 trade "100%", which should not show a number at all; from 3 up, a cell
// renders normally.
export const MIN_SAMPLES = 3

// 三档的两条分界线，单位是**百分点**，因为判定按显示出来的那个数字切（见
// verdictOf）。用原始小数切会在边界上自相矛盾：0.3999 显示成 40.0% 却落进红档。
// The two cuts, in percentage points, because the verdict is decided on the
// number as displayed (see verdictOf). Cutting on the raw fraction contradicts
// itself at the boundary: 0.3999 renders as 40.0% yet lands in the red band.
export const AMBER_FROM_PCT = 40
export const GREEN_FROM_PCT = 51

// 百分比一律一位小数。判定和显示必须用同一个精度，否则边界上会打架。
// One decimal everywhere. The verdict and the display must share a precision or
// they disagree at the cuts.
export const PCT_DIGITS = 1

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
export type VerdictKind = 'strong' | 'mid' | 'weak' | 'thin' | 'waiting' | 'broken' | 'none'

export interface RateLike {
  samples: number
  resolved: number
  winRate: number | null
  wilsonLow: number | null
  wilsonHigh: number | null
  pending?: number
  stale?: number
}

/** 三种"有百分比可看"的判定 / the three verdicts that come with a percentage */
export const isRated = (k: VerdictKind): boolean =>
  k === 'strong' || k === 'mid' || k === 'weak'

/** 全页唯一的判定规则，三档：**51% 及以上绿、40–50% 橙、40% 以下红**。
 *
 *  档位按显示出来的百分比切，所以颜色和读者眼里的数字永远对得上：39.9% 是红、
 *  40.0% 到 50.9% 是橙、51.0% 起是绿，不会出现"看着 50 点几却是绿的"。
 *
 *  `digits` 要和该处 fmtPct 用的精度一致。全站默认一位小数，只有 24 小时格用
 *  整数（格子太窄），那里必须传 0——否则 50.5% 会显示成「51%」却判成橙。
 *
 *  中间那档是后加的（产品要求）。原来只有绿红两档、以 50% 一刀切，结果 49.8%
 *  和 12% 同样是红、50.2% 和 88% 同样是绿——一刀两侧的差别其实全在噪声里，
 *  颜色却给得一样重。橙色把"贴着五五开"单独拎出来，读者一眼能分出"真的偏好"
 *  和"其实没什么区别"。
 *
 *  这里刻意不用 Wilson 区间把关（更早的产品决定）。之前的规则是"区间整体落在
 *  50% 一侧才上色，否则显示成灰色的'还看不出高低'"——统计上更严谨，但切到 24
 *  个钟点之后每格只有三五笔，区间必然跨过 50%，于是整张图全是灰的，等于什么都
 *  没说。产品的判断是：先看方向，笔数会随时间自己攒起来。
 *
 *  **代价要清楚**：绿色不等于"统计上站得住"，只等于"到目前为止 51% 以上"。
 *  3 笔里赢 2 笔（67%）和 300 笔里赢 200 笔（67%）是同一个绿。排序仍然用
 *  Wilson 下限（见 rankHours），所以榜单里薄样本还是会沉底
 *  ——把关只是从"显示"退到了"排序"。
 *
 *  The page's single verdict rule, in three bands: **green at 51% and above,
 *  amber from 40% to 50%, red below 40%**.
 *
 *  The cuts match the displayed percentage, so the colour never contradicts the
 *  number a reader sees: 39.9% is red, 40.0%-50.9% amber, 51.0% and up green.
 *  `digits` must equal the precision fmtPct is called with at that spot: one
 *  decimal everywhere except the 24-hour cells, which are too narrow and use
 *  integers — pass 0 there, or 50.5% renders as "51%" yet judges amber.
 *
 *  The middle band was added later (product decision). With only green and red
 *  split at 50%, 49.8% looked as red as 12% and 50.2% as green as 88% — the
 *  difference across that cut is noise, yet the colour weighed it the same.
 *  Amber pulls "basically a coin flip" out on its own.
 *
 *  The Wilson interval deliberately does not gate this (an earlier product
 *  call): sliced 24 ways each cell holds a handful of trades, the interval
 *  always straddles 50%, and the whole grid came out grey, saying nothing.
 *
 *  **The cost is explicit**: green means "above 51% so far", not
 *  "statistically established". 2 of 3 and 200 of 300 are the same green.
 *  Ranking still uses the Wilson lower bound (rankHours), so thin
 *  candidates still sink in the top lists — the gate moved from display to
 *  ordering, it did not disappear. */
export function verdictOf(b: RateLike, digits = PCT_DIGITS): VerdictKind {
  if (b.samples === 0) return 'none'
  if (b.resolved === 0) return (b.pending ?? 0) > 0 ? 'waiting' : 'broken'
  if (b.winRate === null || b.resolved < MIN_SAMPLES) return 'thin'
  // 先四舍五入到显示精度再比，读者看到几就按几判——颜色永远说得通。
  // Round to the displayed precision first, so the colour always matches the
  // number the reader is looking at.
  const shown = Number((b.winRate * 100).toFixed(digits))
  if (shown >= GREEN_FROM_PCT) return 'strong'
  if (shown >= AMBER_FROM_PCT) return 'mid'
  return 'weak'
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

// ── 排名：选前几名用 Wilson 下限，显示顺序用胜率 ──────────────────────────
//
// 两步是刻意的。**选**谁进榜用 Wilson 下限，薄样本自然沉底：3 笔全赢（下限
// 0.439）排在 300 笔 62%（下限约 0.56）后面，不会因为"100%"就顶上来。**排**好
// 之后按胜率显示，因为入榜的都已经过筛，读者看到 62% 排在 58% 前面才不困惑。
//
// Ranking in two steps, deliberately. Selection goes by the Wilson lower bound so
// thin samples sink on their own: 3 straight wins (bound 0.439) sorts below 62%
// of 300 (bound ≈0.56) rather than jumping the queue on the strength of "100%".
// Display then goes by the raw rate, because everything shown has already passed
// selection and a reader seeing 58% above 62% would just be confused.

export type HourPick = { localMinutes: number; rate: number; kind: VerdictKind }

/** 钟点排名。`keep` 只保留某个时段内的钟点，`greenOnly` 只留绿档的。
 *
 *  门槛写成「只留绿的」而不是一个数字，是因为这两个榜的措辞是推荐（「可以留意」
 *  「胜率最高的时间」），推荐一条橙色的 50.x% 会自相矛盾；写成判定本身，档位
 *  以后再调也不会和配色走散。
 *
 *  标签换算成浏览者本地钟点——后端按 UTC 分桶，24 格是完整循环，旋转无损。
 *  Rank hours; `keep` restricts to one session's hours, `greenOnly` to the green
 *  band. The floor is the verdict itself rather than a number: both lists are
 *  worded as recommendations, so an amber 50-something has no business in them,
 *  and tying the two together means moving a cut can never desync the colour.
 *  Labels are in the viewer's clock: the backend buckets in UTC and 24 slots are
 *  a full cycle, so the rotation is lossless. */
export function rankHours(
  hourly: HourOutcome[] | null,
  now: Date,
  opts: { limit: number; greenOnly?: boolean; keep?: (utcHour: number) => boolean },
): HourPick[] {
  if (!hourly) return []
  const viewerOffset = -now.getTimezoneOffset()
  const candidates: (HourPick & { low: number })[] = []
  hourly.forEach((h, utcHour) => {
    if (opts.keep && !opts.keep(utcHour)) return
    const rate = rateFromCounts(h.tp, h.sl)
    const kind = verdictOf(rate)
    if (!isRated(kind) || rate.winRate === null) return
    if (opts.greenOnly && kind !== 'strong') return
    candidates.push({
      localMinutes: (((utcHour * 60 + viewerOffset) % 1440) + 1440) % 1440,
      rate: rate.winRate,
      kind,
      low: rate.wilsonLow ?? 0,
    })
  })
  candidates.sort((a, b) => b.low - a.low)
  return candidates.slice(0, opts.limit).sort((a, b) => b.rate - a.rate)
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

// 判定配色三档全部走设计令牌（--up / --mid / --down），「还没数可看」的几种状态
// 一律中性灰。这里引用 index.css 的令牌而不是抄数值——令牌抬一次，这页跟着动。
// All three verdict colours come from the market tokens (--up / --mid / --down);
// the several "nothing to show yet" states stay neutral. Referring to the tokens
// rather than copying their values means a token lift moves this page with it.
export const VERDICT_COLOR: Record<VerdictKind, string> = {
  strong: 'var(--up)',
  mid: 'var(--mid)',
  weak: 'var(--down)',
  thin: 'var(--text-3)',
  waiting: 'var(--text-3)',
  broken: 'var(--text-3)',
  none: 'var(--text-3)',
}

export const VERDICT_BG: Record<VerdictKind, string> = {
  strong: 'var(--up-bg)',
  mid: 'var(--mid-bg)',
  weak: 'var(--down-bg)',
  thin: 'rgba(255,255,255,0.04)',
  waiting: 'rgba(255,255,255,0.04)',
  broken: 'rgba(255,255,255,0.04)',
  none: 'transparent',
}

export const fmtPct = (v: number, digits = PCT_DIGITS): string => `${(v * 100).toFixed(digits)}%`
export const fmtInt = (n: number): string => n.toLocaleString('en-US')

/** 某个 IANA 时区在给定时刻的 UTC 偏移（分钟）。夏令时体现在这里。
 *  A zone's UTC offset in minutes at a given instant; DST shows up here. */
/** 某个 UTC 钟点落在哪些时段内。与后端 session_keys_for 同一条判断（时段按该金融
 *  中心的本地钟点定义），只是这里一次判一个钟点而不是一条信号。以前在时段胜率卡
 *  与「现在该盯什么」两处各写一份。
 *  Which sessions a given UTC hour falls in — the backend's session_keys_for rule
 *  applied to an hour. Was duplicated in SessionWinrateCard and WatchNow. */
export function sessionsForUtcHour(hour: number, sessions: SessionWindow[], now: Date): string[] {
  const hit = sessions.filter((s) => {
    const local = ((((hour * 60 + zoneOffsetMinutes(s.tz, now)) % 1440) + 1440) % 1440) / 60
    return s.startHour <= local && local < s.endHour
  })
  return hit.length > 0 ? hit.map((s) => s.key) : ['outside']
}

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
