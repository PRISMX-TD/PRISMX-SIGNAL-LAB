// 胜率页共享：判定规则、配色、时间换算。
//
// 页面上**只有一条**判定规则（verdictOf），所有层级——钟点格、品种行、方向行——
// 都从这里拿判定，再渲染成颜色：51% 起绿、40–50% 橙、40% 以下红。
// 判定词本身已从界面上全部撤掉（只留给读屏器），所以这条规则的唯一出口就是颜色。
// 亚 / 欧 / 美盘那一套时段工具已于 2026-10-11 删掉：策略分析页与仪表盘卡都改成按小时看。
//
// Shared helpers for the win-rate page: the verdict rule, colours, time maths.
// There is exactly ONE verdict rule (verdictOf); every layer — strategy card,
// hour cell, symbol row, side row — takes its verdict here
// and renders it as colour: green from 51%, amber 40-50%, red below. The worded verdicts are
// gone from the interface (screen readers still get them), so colour is this
// rule's only outlet. The Asia / Europe / New York session helpers were removed
// on 2026-10-11 when both the analysis page and the dashboard card moved to hours.
import type { TFunction } from 'i18next'
import type { HourOutcome } from '../../api/types'

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
 *  3 笔里赢 2 笔（67%）和 300 笔里赢 200 笔（67%）是同一个绿。
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
 *  "statistically established". 2 of 3 and 200 of 300 are the same green. */
export function verdictOf(b: RateLike, digits = PCT_DIGITS): VerdictKind {
  if (b.samples === 0) return 'none'
  if (b.resolved === 0) return (b.pending ?? 0) > 0 ? 'waiting' : 'broken'
  if (b.winRate === null || b.resolved < MIN_SAMPLES) return 'thin'
  return bandOf(b.winRate, digits)
}

/** 只按胜率分三档，不看笔数。verdictOf 去掉样本门槛之后剩下的那一半；
 *  「最高 / 最低时段」榜按产品要求不设样本门槛（2026-10-11），用的就是它。
 *  先四舍五入到显示精度再比，读者看到几就按几判——颜色永远说得通。
 *  The three bands by rate alone, ignoring sample size — verdictOf minus its
 *  floor. The best/worst hour lists carry no sample floor (product decision,
 *  2026-10-11) and use this. Rounds to the displayed precision first so the
 *  colour always matches the number shown. */
export function bandOf(winRate: number, digits = PCT_DIGITS): 'strong' | 'mid' | 'weak' {
  const shown = Number((winRate * 100).toFixed(digits))
  if (shown >= GREEN_FROM_PCT) return 'strong'
  if (shown >= AMBER_FROM_PCT) return 'mid'
  return 'weak'
}

// ── 最高 / 最低时段 / best and worst hours ──────────────────────────────
//
// 2026-10-11 产品要求：策略分析不再按亚 / 欧 / 美盘展示，改成「胜率最高的三个时段 +
// 胜率最低的三个时段」，时段 = 一天中的一个小时（浏览者本地钟点）。**不设样本门槛**
// （产品决定）：只要这个小时有已判定的信号就参与排名。单数界面上不显示（产品要求，
// 2026-10-12），`n` 只用来在同胜率时把笔数多的排前面。
// 排序：胜率高低为主，同胜率时笔数多的在前（更可信的排前面）。最低榜不会和最高榜
// 重复：可排名的小时不足六个时，先满足最高榜，剩下的才进最低榜。
//
// Product request (2026-10-11): the analysis drops the Asia/Europe/New York
// sessions in favour of "the three best hours + the three worst hours", an hour
// being one hour of the viewer's local day. **No sample floor** (product call):
// any hour with a resolved signal is ranked. Trade counts are not displayed
// (product request, 2026-10-12); `n` only breaks ties. Order: by rate, then by
// count (the better-supported first). The worst list never repeats the best: with
// fewer than six ranked hours the best list fills first.

export type HourStat = { localMinutes: number; rate: number; n: number; kind: VerdictKind }

export function bestWorstHours(
  hourly: HourOutcome[] | null,
  now: Date,
  limit = 3,
): { best: HourStat[]; worst: HourStat[] } {
  if (!hourly) return { best: [], worst: [] }
  const viewerOffset = -now.getTimezoneOffset()
  const all: HourStat[] = []
  hourly.forEach((h, utcHour) => {
    const n = h.tp + h.sl
    if (n <= 0) return
    const rate = h.tp / n
    all.push({
      localMinutes: (((utcHour * 60 + viewerOffset) % 1440) + 1440) % 1440,
      rate,
      n,
      kind: bandOf(rate),
    })
  })
  const best = [...all].sort((a, b) => b.rate - a.rate || b.n - a.n).slice(0, limit)
  const taken = new Set(best.map((h) => h.localMinutes))
  const worst = all
    .filter((h) => !taken.has(h.localMinutes))
    .sort((a, b) => a.rate - b.rate || b.n - a.n)
    .slice(0, limit)
  return { best, worst }
}

/** 「15:00–16:00」：一个小时时段的起止。/ an hour slot as "15:00–16:00". */
export function fmtHourRange(localMinutes: number): string {
  return `${fmtClock(localMinutes)}–${fmtClock(localMinutes + 60)}`
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

/** 一天内的钟点，如「06:00」。/ A clock reading, e.g. "06:00". */
export function fmtClock(totalMinutes: number): string {
  const m = ((totalMinutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
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
