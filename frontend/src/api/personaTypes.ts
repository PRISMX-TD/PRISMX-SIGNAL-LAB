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

export interface PersonaTaggedTrade {
  symbol: string
  side: string
  volume: number
  openAt: string
  closeAt: string
  profit: number
  unrealized: boolean
  tags: PersonaTag[]
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
}

export type PersonaOverview =
  | { status: 'demo' }
  | { status: 'locked'; progress: PersonaProgress }
  | { status: 'unlocked'; persona: Persona; months: string[]; report: PersonaReport | null }

export interface PersonaClient { email: string; nickname: string | null }
