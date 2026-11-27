// 交易报告 + 交易人格（2026-11-22）的接口类型，对应后端 routers/persona.py 与 services/persona/*。
// Types for the trading report + persona endpoints (backend routers/persona.py, services/persona/*).

export type PersonaAxisKey = 'judge' | 'risk' | 'tempo' | 'manage'
export type PersonaFamily = 'strategist' | 'maverick' | 'executor' | 'chaser'

// value：0–100，越大越靠近第二个字母（R / G / Q / M），50 是分界。
// value: 0–100 toward the second pole (R / G / Q / M); 50 is the cut.
export interface PersonaAxis {
  letter: string
  value: number
  share?: number
  holdRatio?: number | null
  payoff?: number | null
  stopOutPct?: number
  medianHoldMin?: number | null
  perDay?: number | null
}

export interface Persona {
  code: string
  family: PersonaFamily | null
  positions: number
  provisional: boolean
  axes: Record<PersonaAxisKey, PersonaAxis>
  computedAt: string | null
}

export interface PersonaProgress {
  unlocked: boolean
  actions: number
  actionsNeed: number
  days: number
  daysNeed: number
  needMore: boolean
}

export interface PersonaBucket {
  key: string | number
  trades: number
  wins: number
  profit: number
}

export type PersonaTag = 'unprotected' | 'heldLoser' | 'earlyExit' | 'movedStop' | 'revenge' | 'stoppedOut'
export type PersonaBadge = 'lightning' | 'multiSymbol' | 'contrarian' | 'stacker' | 'bull' | 'bear' | 'autopilot' | 'lotSteady' | 'lotWild'

export interface PersonaSummary {
  trades: number
  wins: number
  losses: number
  winRate: number | null
  profit: number
  grossWin: number
  grossLoss: number
  avgWin: number | null
  avgLoss: number | null
  payoff: number | null
  profitFactor: number | null
  medianHoldMin: number | null
  lots: number
  tradingDays: number
  greenDays: number
  best: number | null
  worst: number | null
  score: number | null
  maxDrawdown: number
}

// 一笔单的定位信息：点它能跳到图表上那一段。价格是 2026-11-27 加的，更早存档的报告里没有。
// Enough of a trade to open the chart on it. Prices were added 2026-11-27; older archives lack them.
export interface PersonaTradeRef {
  symbol: string
  side: string
  volume: number
  openAt: string
  closeAt: string
  openPrice?: number | null
  closePrice?: number | null
  profit: number
  unrealized: boolean
}

export interface PersonaTaggedTrade extends PersonaTradeRef {
  tags: PersonaTag[]
}

// 「如果今天结算」的人格（只在当月报告里）：和月底存档同一个算法。
// The persona "if the month closed today" (live month only), computed like the month-end archive.
export interface PersonaOutlook {
  code: string
  family: PersonaFamily
  from: string
  changed: boolean
  axes: Record<PersonaAxisKey, { letter: string; value: number }>
}

// 上个月的几项指标，用来画「比上月」的升降。/ Last month's figures for the month-over-month arrows.
export interface PersonaPrevious {
  period: string
  trades: number | null
  profit: number | null
  winRate: number | null
  payoff: number | null
  score: number | null
  maxDrawdown: number | null
  medianHoldMin: number | null
}

export interface PersonaReport {
  version: number
  period: string
  live: boolean
  asOf: string
  persona: Persona | null
  summary: PersonaSummary
  calendar: { day: string; profit: number; trades: number }[]
  breakdowns: Record<'symbol' | 'session' | 'weekday' | 'hold' | 'source', PersonaBucket[]>
  tags: Record<PersonaTag, { count: number; profit: number }>
  taggedTrades: PersonaTaggedTrade[]
  badges: PersonaBadge[]
  openLosers: number
  change: { from: string; to: string } | null
  previousCode: string | null
  comment: Partial<Record<'zh' | 'en' | 'ja' | 'th' | 'vi', string>> | null
  archivedAt: string | null
  // 以下是 2026-11-27 加的，旧版后端 / 旧存档可能没有。/ Added 2026-11-27; may be absent.
  bestTrade?: PersonaTradeRef | null
  worstTrade?: PersonaTradeRef | null
  // 当月：此刻还没计入的浮亏持仓（笔数、合计金额，负数）。/ Live month: floating losers not yet counted.
  floating?: { count: number; loss: number } | null
  outlook?: PersonaOutlook | null
  previous?: PersonaPrevious | null
  // 最近几个月的综合评分，从早到晚，最后一项是这个月。/ Scores of recent months, oldest first.
  trend?: { period: string; score: number }[]
}

export type PersonaOverview =
  | { status: 'demo' }
  | { status: 'locked'; progress: PersonaProgress }
  | { status: 'unlocked'; persona: Persona; months: string[]; report: PersonaReport | null }

export interface PersonaClient { email: string; nickname: string | null }
