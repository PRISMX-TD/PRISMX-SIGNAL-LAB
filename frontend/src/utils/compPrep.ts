// 站内比赛页的纯逻辑：资金门槛、参赛准备清单、错误分类、报名意图何时作废。
// 规则来源：设计 §1.11（只收本人、直连、未撤销的账户）、§1.12（报名时实时核资：精确金额赛
// |balance-目标|≤0.005 且 |equity-balance|≤0.005；范围赛看 balance）、§1.13（撞号 409）。
// 前端只是提前把结果告诉用户，后端报名时仍独立复核。
// Pure logic for the in-app competition page: funds gate, entry checklist, error
// classification, and when a stored sign-up intent is stale. Rules: spec §1.11 (own,
// direct-connected, non-revoked accounts only), §1.12 (live funds check: exact-amount
// competitions need |balance-target|≤0.005 and |equity-balance|≤0.005; ranges use the
// balance), §1.13 (409 on a taken account). The frontend only previews the outcome; the
// backend re-checks at registration.
import { ApiHttpError } from '../api/client'
import type { CompetitionDetail, CompetitionTrack, MT5Account, PublicCompetitionGates } from '../api/types'
import { regState } from './competitionTime'

export type CompGates = PublicCompetitionGates
export const FUNDS_TOLERANCE = 0.005

// tradeMode: 0=模拟, 1=竞赛, 2=实盘, null=未判定（两个赛道都不收）。
// tradeMode: 0=demo, 1=contest, 2=real, null=unclassified (neither track takes it).
export const matchesTrack = (a: Pick<MT5Account, 'tradeMode'>, track: CompetitionTrack): boolean =>
  track === 'demo' ? a.tradeMode === 0 || a.tradeMode === 1 : a.tradeMode === 2

const isGateway = (a: Pick<MT5Account, 'source'>) => a.source === 'gateway'

export function gatesOfDetail(d: Pick<CompetitionDetail, 'metric' | 'board'>): CompGates {
  const g = d.board.gates
  return {
    minBaselineUsd: g.minBaselineUsd,
    maxBaselineUsd: g.maxBaselineUsd ?? null,
    minTrades: d.metric === 'win_rate' ? g.minTradesWinrate : g.minTradesReturn,
  }
}

export type FundsRule =
  | { kind: 'exact'; usd: number }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'min'; min: number }

export function fundsRule(g: CompGates): FundsRule {
  if (g.maxBaselineUsd != null && Math.abs(g.maxBaselineUsd - g.minBaselineUsd) < 1e-9) {
    return { kind: 'exact', usd: g.minBaselineUsd }
  }
  if (g.maxBaselineUsd != null) return { kind: 'range', min: g.minBaselineUsd, max: g.maxBaselineUsd }
  return { kind: 'min', min: g.minBaselineUsd }
}

// true/false = 能判定；null = 余额（精确赛还要净值）还没读到。
// true/false = decidable; null = balance (and, for exact amounts, equity) not read yet.
export function fundsOk(a: Pick<MT5Account, 'balance' | 'equity'>, g: CompGates): boolean | null {
  const bal = a.balance
  if (bal == null || !Number.isFinite(bal)) return null
  const r = fundsRule(g)
  if (r.kind === 'exact') {
    if (a.equity == null || !Number.isFinite(a.equity)) return null
    return Math.abs(bal - r.usd) <= FUNDS_TOLERANCE && Math.abs(a.equity - bal) <= FUNDS_TOLERANCE
  }
  if (bal < r.min) return false
  if (r.kind === 'range' && bal > r.max) return false
  return true
}

export function eligibleAccounts(accounts: MT5Account[], track: CompetitionTrack, entered: ReadonlySet<string>): MT5Account[] {
  return accounts.filter((a) => isGateway(a) && matchesTrack(a, track) && !a.needsReverify && !entered.has(a.login))
}

export type BindHint = 'noAccounts' | 'gatewayOnly' | 'pendingType' | 'wrongTrack' | null

export function bindHint(accounts: MT5Account[], track: CompetitionTrack): BindHint {
  if (accounts.length === 0) return 'noAccounts'
  const direct = accounts.filter((a) => isGateway(a) && !a.needsReverify)
  if (direct.length === 0) return 'gatewayOnly'
  if (direct.some((a) => matchesTrack(a, track))) return null
  if (direct.some((a) => a.tradeMode == null)) return 'pendingType'
  return 'wrongTrack'
}

export type PrepKey = 'email' | 'openAccount' | 'bind' | 'funds' | 'register'
export interface PrepStep { key: PrepKey; done: boolean }
export interface PrepState { steps: PrepStep[]; eligible: MT5Account[]; fundsReady: MT5Account[] }

export function prepState(i: {
  emailVerified: boolean
  accounts: MT5Account[]
  track: CompetitionTrack
  gates: CompGates
  enteredLogins: ReadonlySet<string>
  hasOpenAccountUrl: boolean
}): PrepState {
  const eligible = eligibleAccounts(i.accounts, i.track, i.enteredLogins)
  const fundsReady = eligible.filter((a) => fundsOk(a, i.gates) === true)
  // 「开户」无法从站内得知是否完成：有了可参赛的直连账户就视为已开好。
  // Account opening can't be observed in-app: an eligible direct account means it's done.
  const bound = eligible.length > 0
  const steps: PrepStep[] = [{ key: 'email', done: i.emailVerified }]
  if (i.hasOpenAccountUrl) steps.push({ key: 'openAccount', done: bound })
  steps.push(
    { key: 'bind', done: bound },
    { key: 'funds', done: fundsReady.length > 0 },
    { key: 'register', done: i.enteredLogins.size > 0 },
  )
  return { steps, eligible, fundsReady }
}

export type DetailLoadError = 'forbidden' | 'notFound' | 'retry'

export function classifyDetailError(err: unknown): DetailLoadError {
  if (err instanceof ApiHttpError) {
    if (err.status === 403) return 'forbidden'
    if (err.status === 404) return 'notFound'
  }
  return 'retry'
}

// 409/503 用前端自己的 5 语文案；其余（400 非直连、资金不符……）用后端的中英消息
// （localizeApiError 取对应一半）。
// 409/503 get our own 5-language copy; everything else (400 not-direct, funds mismatch…)
// uses the backend's zh/en message via localizeApiError.
export function registerErrorKey(err: unknown): string | null {
  if (err instanceof ApiHttpError) {
    if (err.status === 409) return 'competition.regErr.taken'
    if (err.status === 503) return 'competition.regErr.fundsUnavailable'
  }
  return null
}

// 报名意图（Part D 的 prismx.compIntent）何时作废：已报名、非报名制、报名已截止或比赛已结束。
// 否则 14 天内每次登录都会被带回这场比赛（Part D 计划「Notes」第 3 条）。
// When the stored sign-up intent is stale: entered, not a signup competition, window
// closed or competition over. Otherwise every sign-in for 14 days lands here (Part D note 3).
export function shouldClearIntent(
  d: Pick<CompetitionDetail, 'status' | 'enrollment' | 'regOpensAt' | 'regClosesAt' | 'myEntries'>,
  nowMs: number,
): boolean {
  if (d.myEntries.length > 0) return true
  if (d.status === 'ended' || d.status === 'settled') return true
  const rs = regState(d, nowMs)
  return rs === null || rs === 'closed'
}
