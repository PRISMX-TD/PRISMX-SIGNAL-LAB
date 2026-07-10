// 信号面板共享常量与纯函数 / shared constants & pure helpers for the signals panel
import type { Signal, Trend } from '../../api/types'
import { calcCountdown } from '../../api/utils'

// 信号总有效时长，与后端 expire_at = created_at + 10min 一致 / lifespan matches backend
export const SIGNAL_LIFESPAN_MS = 10 * 60 * 1000
// 剩余低于此值视为"即将到期" / below this is considered "expiring soon"
export const EXPIRING_THRESHOLD_MS = 2 * 60 * 1000
// 新信号高亮持续时间 / how long a new signal stays highlighted
export const NEW_HIGHLIGHT_MS = 6000

// focus 视图默认关注品种（与后端引擎产出对齐，XAGUSD 暂无信号则恒显观望）。
// Default watchlist (aligned with the engine's symbols; XAGUSD stays in "watch"
// until it ever emits a signal).
export const DEFAULT_WATCHLIST = ['XAUUSD', 'EURUSD', 'GBPUSD', 'XAGUSD', 'BTCUSD']

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

// 风险回报比颜色 / risk-reward color
export function rrTone(rr: number | null): string {
  if (rr == null) return 'text-slate-400'
  if (rr >= 2) return 'text-up'
  if (rr >= 1) return 'text-prism-300'
  return 'text-down'
}

// focus 状态的视觉映射 / visual mapping for each focus state
export const FOCUS_TONE: Record<FocusState, { color: string; chipBg: string; glow: string }> = {
  WATCH: { color: 'text-slate-400', chipBg: 'bg-white/5 text-slate-400', glow: 'rgba(148,163,184,.18)' },
  LONG: { color: 'text-up', chipBg: 'bg-up/15 text-up', glow: 'rgba(47,230,160,.28)' },
  SHORT: { color: 'text-down', chipBg: 'bg-down/15 text-down', glow: 'rgba(255,77,109,.28)' },
}
export const FOCUS_DOT: Record<FocusState, string> = { WATCH: '#94a3b8', LONG: '#2ee07e', SHORT: '#ff4d67' }

// 多周期趋势要展示的固定周期顺序 / fixed order of timeframes shown in the trend widget
export const TREND_TFS = ['M5', 'M15', 'M30', 'H1', 'H4'] as const

// 多周期加权：越大周期权重越高 / per-timeframe weights, larger TF weighs more
const TF_WEIGHT: Record<string, number> = { M5: 1, M15: 1, M30: 2, H1: 3, H4: 3 }
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
  BULL: { color: 'text-up', glow: 'rgba(46,224,126,.28)', dot: '#2ee07e' },
  BEAR: { color: 'text-down', glow: 'rgba(255,77,103,.28)', dot: '#ff4d67' },
  NEUTRAL: { color: 'text-slate-400', glow: 'rgba(148,163,184,.22)', dot: '#94a3b8' },
}
