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

export interface PersonaReport extends PersonaReportExtras {
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

export type PersonaOverview = (
  | { status: 'demo' }
  | { status: 'locked'; progress: PersonaProgress }
  | { status: 'unlocked'; persona: Persona; months: string[]; report: PersonaReport | null }
) & PersonaOverviewExtras

export interface PersonaClient { email: string; nickname: string | null }

// ---------------------------------------------------------------- 2026-11-28（rev 58）新增 / added
// 周小结（只在当月报告里）：本周和上周，周一到周日（UTC）。/ Weekly digest (live month only), Monday–Sunday UTC.
export interface PersonaWeek {
  start: string
  end: string
  current: boolean
  summary: Pick<PersonaSummary, 'trades' | 'wins' | 'losses' | 'winRate' | 'profit' | 'payoff' | 'score' | 'tradingDays' | 'greenDays' | 'maxDrawdown' | 'medianHoldMin'>
  tags: Record<PersonaTag, number>
  topSymbol: PersonaBucket | null
  bestDay: { day: string; profit: number; trades: number } | null
  worstDay: { day: string; profit: number; trades: number } | null
}

// 纪律连续记录：连续带止损的笔数、连续多少天没有扛单 / 报复加仓 / 反向挪止损。
// Discipline streaks: trades in a row with a stop, days in a row without a held loser / revenge / moved stop.
export type PersonaStreakKey = 'stops' | 'noHeldLoser' | 'noRevenge' | 'noMovedStop'
export interface PersonaStreak {
  key: PersonaStreakKey
  unit: 'trades' | 'days'
  current: number
  best: number
  broken: { at: string; length: number } | null
}

// 本月目标 + 目标人格。dir：ge = 做到这个数以上，le = 不超过这个数。
// Monthly goals + target persona. dir: ge = reach at least, le = stay at or below.
export type PersonaGoalKey = 'winRate' | 'payoff' | 'score' | 'maxDrawdown' | 'trades' | 'unprotected' | 'heldLoser' | 'revenge' | 'movedStop'
export interface PersonaGoalRow {
  key: PersonaGoalKey
  dir: 'ge' | 'le'
  target: number
  value: number | null
  met: boolean
}
export interface PersonaTarget {
  code: string
  family: PersonaFamily
  axes: { axis: PersonaAxisKey; want: string; have: string | null; value: number | null; met: boolean }[]
  reached: boolean
}
export interface PersonaGoal {
  goals: PersonaGoalRow[]
  target: PersonaTarget | null
  setAt: string | null
}

// 同人格对比：同代号（不足 20 人时退到同家族）的人的中位数。
// Same-persona comparison: medians over users sharing the code (the family when fewer than 20).
export interface PersonaPeers {
  scope: 'code' | 'family'
  key: string
  family: PersonaFamily
  count: number
  medians: Record<'medianHoldMin' | 'perDay' | 'payoff' | 'holdRatio' | 'signalShare' | 'manageShare', number | null>
}

export interface PersonaFeatures {
  demoPreview: boolean
  goals: boolean
  agentBoard: boolean
  goalMenu: Record<PersonaGoalKey, { dir: 'ge' | 'le'; min: number; max: number }> | null
  goalsMax: number
}

export interface PersonaAlert { limit: number | null; enabled: boolean; firedToday: boolean }

// 模拟盘预览：用模拟盘的单算的人格（不够条件时是模拟盘上的进度）。
// Demo preview: a persona computed from demo trades, or the demo progress while not enough.
export type PersonaPreview =
  | { unlocked: true; persona: Persona }
  | { unlocked: false; progress: PersonaProgress }

export interface PersonaReportExtras {
  weeks?: PersonaWeek[]
  streaks?: PersonaStreak[]
  goal?: PersonaGoal | null
}

export interface PersonaOverviewExtras {
  features?: PersonaFeatures
  alert?: PersonaAlert
  preview?: PersonaPreview
  annuals?: number[]
  peers?: PersonaPeers | null
}

// 年度报告 / annual report
export interface PersonaAnnualMonth {
  period: string
  trades: number
  profit: number
  winRate: number | null
  score: number | null
  code: string | null
  badges: PersonaBadge[]
}
export interface PersonaAnnualHalf {
  trades: number
  winRate: number | null
  payoff: number | null
  score: number | null
  profit: number
  tagRates: Record<PersonaTag, number | null>
}
type DayRow = { day: string; profit: number; trades: number }
export interface PersonaAnnual {
  version: number
  year: number
  live: boolean
  asOf: string
  months: string[]
  firstTradeAt: string | null
  persona: Persona | null
  summary: PersonaSummary
  calendar: DayRow[]
  monthly: PersonaAnnualMonth[]
  journey: { steps: { period: string; code: string }[]; distinct: number; changes: number; mostCommon: string | null }
  breakdowns: PersonaReport['breakdowns']
  tags: PersonaReport['tags']
  badges: Partial<Record<PersonaBadge, number>>
  streaks: { key: PersonaStreakKey; unit: 'trades' | 'days'; best: number }[]
  halves: { split: string; first: PersonaAnnualHalf; second: PersonaAnnualHalf } | null
  records: {
    bestTrade: PersonaTradeRef | null
    worstTrade: PersonaTradeRef | null
    longestHold: (PersonaTradeRef & { holdMin: number }) | null
    bestDay: DayRow | null
    worstDay: DayRow | null
    busiestDay: DayRow | null
    bestMonth: string | null
    worstMonth: string | null
    winRun: number
    lossRun: number
    topSymbol: PersonaBucket | null
    bestSymbol: PersonaBucket | null
    topSession: PersonaBucket | null
    topWeekday: PersonaBucket | null
    holdHours: number
  }
  archivedAt: string | null
}

// 推荐官的客户看板 / ambassador customer board
export interface PersonaBoardClient {
  email: string
  nickname: string | null
  code: string | null
  family: PersonaFamily | null
  period: string | null
  score: number | null
  scoreDelta: number | null
  trades: number | null
  lastTradeAt: string | null
  idleDays: number | null
  inactive: boolean
  dropped: boolean
}
export interface PersonaBoard {
  total: number
  withPersona: number
  families: Partial<Record<PersonaFamily, number>>
  codes: Record<string, number>
  inactive: number
  dropped: number
  inactiveDays?: number
  dropPoints?: number
  clients: PersonaBoardClient[]
}
