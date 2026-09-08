// 信号面板共享常量与纯函数 / shared constants & pure helpers for the signals panel
import type { Signal, SignalResult, StrategySignal, Trend } from '../../api/types'
import { calcCountdown, parseTime } from '../../api/utils'

// 个人策略信号在 UI 上混进普通信号流展示（同样的卡片、同样按时间排位），
// 不再单独开一块区域；strategySignal 标记只用于下单时选择提交路径（不带
// signalId，避免污染平台胜率统计）和排除出「市场概览」这类全平台口径的
// 聚合统计，卡片渲染本身完全一视同仁。
// Personal strategy signals are folded into the normal signal stream for
// display (same card, same chronological ranking) instead of a separate
// section. The strategySignal flag exists only to pick the right order
// submit path (no signalId, so it never pollutes the platform win-rate
// stats) and to exclude it from platform-wide aggregates like Market
// Overview — the card itself renders identically either way.
export interface DisplaySignal extends Signal {
  strategySignal?: true
}

export function strategySignalToDisplay(sig: StrategySignal, myStrategyLabel: string): DisplaySignal {
  // 倒计时/过期跟平台信号同一套机制(effectiveStatus + calcCountdown),
  // 所以给一个真实的 expireAt(创建时间 + 与平台一致的存活时长),而不是
  // null——null 会让倒计时永远显示"-"、到期也不会自然消失。
  // Countdown/expiry uses the same mechanism as platform signals
  // (effectiveStatus + calcCountdown), so give it a real expireAt (created
  // time + the same lifespan as platform signals) instead of null — null
  // would leave the countdown stuck at "-" and it would never naturally
  // expire out of the list.
  // createdAt 是后端裸时间戳(无时区后缀),必须走 parseTime()按 UTC 解释,
  // 不能直接 new Date(...)——那会按浏览器本地时区解释,在非 UTC 时区下
  // 算出的 expireAt 会整体偏移,可能刚生成就被判定"已过期"。
  // createdAt is a bare backend timestamp (no timezone suffix) and must go
  // through parseTime() to be interpreted as UTC — a raw new Date(...)
  // would parse it in the browser's local timezone, skewing the computed
  // expireAt in any non-UTC zone and potentially marking a signal expired
  // the instant it's created.
  const created = parseTime(sig.createdAt)?.getTime() ?? Date.now()
  const expireAt = new Date(created + SIGNAL_LIFESPAN_MS).toISOString()
  return {
    id: sig.id,
    symbol: sig.symbol,
    side: sig.side,
    entry: sig.entry,
    stopLoss: sig.stopLoss,
    takeProfit: sig.takeProfit,
    indicator: myStrategyLabel,
    status: 'ACTIVE',
    createdAt: sig.createdAt,
    expireAt,
    result: 'PENDING',
    resolvedAt: null,
    strategySignal: true,
  }
}

// 信号总有效时长，与后端 expire_at = created_at + 10min 一致 / lifespan matches backend
export const SIGNAL_LIFESPAN_MS = 10 * 60 * 1000
// 剩余低于此值视为"即将到期" / below this is considered "expiring soon"
export const EXPIRING_THRESHOLD_MS = 2 * 60 * 1000
// 新信号高亮持续时间 / how long a new signal stays highlighted
export const NEW_HIGHLIGHT_MS = 6000

// focus 视图的关注品种不再是这里的写死常量——已改成运行时从 useLive()
// .activeSymbols 读取（EA 实际在推什么就是什么），逻辑与比特币排除规则见
// hooks.ts 的 useFocusEntries/HERO_EXCLUDED。
// The focus view's watchlist is no longer a constant here — it now comes
// from useLive().activeSymbols at runtime (whatever the EA is actually
// pushing). See hooks.ts's useFocusEntries/HERO_EXCLUDED for the logic and
// the Bitcoin exclusion rationale.

// 品种在 focus 视图下的状态：观望 / 做多 / 做空 / per-symbol state in the focus view
export type FocusState = 'WATCH' | 'LONG' | 'SHORT'

// 单个关注品种在 focus 视图中的派生数据 / derived per-symbol data for the focus view
export interface FocusEntry {
  symbol: string
  state: FocusState
  signal: Signal | null
}

// 信号的有效状态（结合实时倒计时）/ effective status combining live countdown
export type EffStatus = 'ACTIVE' | 'EXPIRING' | 'EXPIRED'
export function effectiveStatus(signal: Signal, now: number): EffStatus {
  if (signal.status === 'EXPIRED') return 'EXPIRED'
  const cd = calcCountdown(signal.expireAt, SIGNAL_LIFESPAN_MS, now)
  if (cd?.expired) return 'EXPIRED'
  if (cd && cd.remainMs <= EXPIRING_THRESHOLD_MS) return 'EXPIRING'
  return 'ACTIVE'
}

// ── 牌面上的价格与时间写法（信号板、仪表盘可执行信号卡、其他活跃信号行共用）──
// Price and time formatting shared by every signal ticket.

// 三个价位按同一位数显示。后端给的是浮点数，1.35100 会以 1.351 到达，与旁边的
// 1.35386 并排就是「一个五位一个三位」——同一张牌上的三个价位必须对齐到同一
// 精度。位数取三者中最长的一个（上限 5），数值本身不变。
// All three prices on a ticket share one precision: the longest fractional
// length among them (capped at 5); the values are untouched.
function decimalsOf(v: number | null): number {
  if (v == null || !Number.isFinite(v)) return 0
  const frac = String(v).split('.')[1]
  return frac ? Math.min(frac.length, 5) : 0
}
export function priceDecimals(entry: number | null, sl: number | null, tp: number | null): number {
  return Math.max(decimalsOf(entry), decimalsOf(sl), decimalsOf(tp))
}
export function fmtPx(v: number | null, decimals: number): string {
  if (v == null || !Number.isFinite(v)) return '-'
  return v.toFixed(decimals)
}

// 风险｜回报尺的分割点：风险距离占（风险 + 回报）的比例，夹在 8%–92% 之间，
// 极端比例下两段与刻度线都还看得见。算不出（缺价位）返回 null，调用方画空轨道。
// 止损永远在左、止盈永远在右，不随买卖方向翻转：这是一条「风险｜回报」尺，
// 不是价格轴，整板列序一致才扫得快。
// The risk|reward rule's split: risk over (risk + reward), clamped to 8–92% so
// both segments and the notch survive extreme ratios; null when a price is
// missing. SL is always left and TP always right regardless of side.
export function riskFraction(riskPrice: number, rewardPrice: number): number | null {
  const total = riskPrice + rewardPrice
  if (!(total > 0)) return null
  return Math.min(0.92, Math.max(0.08, riskPrice / total))
}

// 牌上的发出时间只到时分秒。fmtTime 的完整写法「08/09, 14:33:48 UTC+8」有 21 个
// 字符，和策略名并排放不下。这块牌只活 10 分钟，日期与时区后缀在这里是冗余；
// 订单回执页仍用完整写法。时区按全站约定取上海时间，只是不再写出来。
// Clock-only issue time: fmtTime's 21-character form does not share a line with
// the strategy name, and a ten-minute ticket needs no date or zone suffix.
export function fmtIssueClock(iso: string | null | undefined): string {
  const d = parseTime(iso)
  if (!d || Number.isNaN(d.getTime())) return '-'
  return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// 风险回报比颜色 / risk-reward color
export function rrTone(rr: number | null): string {
  if (rr == null) return 'text-neutral-400'
  if (rr >= 2) return 'text-up'
  if (rr >= 1) return 'text-prism-300'
  return 'text-down'
}

// 信号客观胜负的颜色与文案：FREE 用户只能看到已过期的信号，展示它最终判定
// 的输赢结果（而不是让"下单"按钮点开才告知过期）。
// Color and label for a signal's objective win/loss: FREE users only ever
// see already-expired signals, so show the final judged result instead of
// only revealing "it's expired" once they tap Trade.
export function resultTone(result: SignalResult): string {
  if (result === 'HIT_TP') return 'text-up'
  if (result === 'HIT_SL') return 'text-down'
  return 'text-neutral-400'
}

export function resultLabel(result: SignalResult, t: (key: string) => string): string {
  switch (result) {
    case 'HIT_TP':
      return t('signals.resultHitTp')
    case 'HIT_SL':
      return t('signals.resultHitSl')
    case 'STALE':
      return t('signals.resultStale')
    default:
      return t('signals.resultPending')
  }
}

// focus 状态的视觉映射 / visual mapping for each focus state
export const FOCUS_TONE: Record<FocusState, { color: string; chipBg: string; glow: string }> = {
  WATCH: { color: 'text-neutral-400', chipBg: 'bg-white/5 text-neutral-400', glow: 'rgba(148,163,184,.18)' },
  LONG: { color: 'text-up', chipBg: 'bg-up/15 text-up', glow: 'rgba(47,230,160,.28)' },
  SHORT: { color: 'text-down', chipBg: 'bg-down/15 text-down', glow: 'rgba(255,77,109,.28)' },
}
export const FOCUS_DOT: Record<FocusState, string> = { WATCH: '#94a3b8', LONG: 'var(--up)', SHORT: 'var(--down)' }

// 多周期趋势要展示的固定周期顺序 / fixed order of timeframes shown in the trend widget
export const TREND_TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'] as const

// 多周期加权：越大周期权重越高。M1 权重为 0——不是"最低权重"而是完全不计入
// 综合判定：M1/M5/M15 若都给权重 1，三个短周期凑起来正好达到下面的阈值 3，
// 会让"看多/看空"在完全没有 M30 及以上中长周期确认的情况下，单靠三个最容易
// 噪声乱跳的短周期一致就翻转，判定会变得过于敏感。M1 权重 0 保证综合分数与
// 加 M1 之前（只有 M5/M15/M30/H1/H4 五档）完全等价，M1 仅作为界面上的参考
// 箭头展示，不参与大方向判断。
// Per-timeframe weights, larger TF weighs more. M1's weight is 0 — not "the
// lowest" but excluded from the composite score entirely: if M1/M5/M15 each
// weighed 1, those three short timeframes alone could sum to the threshold
// below, flipping the overall stance with zero confirmation from M30 or
// higher — over-sensitive to noise. Weight 0 keeps the composite score
// mathematically identical to before M1 existed (only M5/M15/M30/H1/H4); M1
// is shown as a reference arrow in the UI only, never sways the stance.
const TF_WEIGHT: Record<string, number> = { M1: 0, M5: 1, M15: 1, M30: 2, H1: 3, H4: 3 }
// 表态阈值：|score| ≥ 此值才看多/看空，中间地带为观望 / stance threshold
const STANCE_THRESHOLD = 3

// 由多周期趋势加权合成的立场：看多 / 看空 / 观望 / synthesized stance
export type TrendStance = 'BULL' | 'BEAR' | 'NEUTRAL'

// 把一个品种的多周期趋势加权合成一个立场。
// Weighted synthesis of one symbol's multi-timeframe trends into a single stance.
export function trendStance(trend?: Trend): TrendStance {
  let score = 0
  for (const tf of TREND_TFS) {
    const dir = trend?.timeframes?.[tf]
    const w = TF_WEIGHT[tf] ?? 1
    if (dir === 'UP') score += w
    else if (dir === 'DOWN') score -= w
  }
  return score >= STANCE_THRESHOLD ? 'BULL' : score <= -STANCE_THRESHOLD ? 'BEAR' : 'NEUTRAL'
}

// 立场视觉：颜色 + 光晕 + 圆点 / stance visuals
export const STANCE_TONE: Record<TrendStance, { color: string; glow: string; dot: string }> = {
  BULL: { color: 'text-up', glow: 'rgba(46,224,126,.28)', dot: 'var(--up)' },
  BEAR: { color: 'text-down', glow: 'rgba(255,77,103,.28)', dot: 'var(--down)' },
  NEUTRAL: { color: 'text-neutral-400', glow: 'rgba(148,163,184,.22)', dot: '#94a3b8' },
}
