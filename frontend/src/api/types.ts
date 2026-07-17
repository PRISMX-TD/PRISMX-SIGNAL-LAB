// 共享类型定义 / Shared type definitions

export type UserRole = 'user' | 'admin'
export type UserPlan = 'FREE' | 'PRO'

// 合作券商锁的展示信息（绑定页提示用）/ partner-broker lock display info for the Bind page
export interface BrokerLock {
  enabled: boolean
  displayName: string
  referralUrl: string
}

// 管理后台：合作券商锁设置 / admin: partner-broker lock settings
export interface AdminBrokerSettings {
  brokerLockEnabled: boolean
  brokerPatterns: string[]
  brokerDisplayName: string
  brokerReferralUrl: string
}

// 自动仓位管理设置（PRO 专属）；阈值以 R 为单位（R = 开仓时的止损距离）
// auto position-management settings (PRO only); thresholds in R units
// (R = the stop distance at open)
export interface AutoManageSettings {
  enabled: boolean
  beEnabled: boolean
  beTriggerR: number
  trailEnabled: boolean
  trailTriggerR: number
  trailDistanceR: number
  ptpEnabled: boolean
  ptpTriggerR: number
  ptpFraction: number
}

export interface User {
  id: string
  email: string
  role: UserRole
  plan: UserPlan
  // 当前 PRO 是否为免费试用；登录/注册响应不带这个字段（未知），
  // 只有 refreshUser()（调 GET /auth/me）之后才会补上。
  // Whether the current PRO is a free trial; absent (unknown) on the
  // login/register response — only populated after refreshUser() (GET /auth/me).
  planIsTrial?: boolean
}

// 管理后台：用户列表条目 / admin: one row in the user list
export interface AdminUser {
  id: string
  email: string
  role: UserRole
  plan: UserPlan
  planExpiresAt: string | null
  planNote: string | null
  createdAt: string | null
  lastActiveAt: string | null
  mt5AccountCount: number
}

// 管理后台：基础运营指标 / admin: basic operating metrics
export interface AdminMetrics {
  totalUsers: number
  dau: number
  wau: number
  planCounts: Record<string, number>
  signupsLast7d: Array<{ date: string; count: number }>
}

// 管理后台：订阅定价设置 / admin: subscription pricing settings
export interface AdminPricingSettings {
  proMonthlyPrice: number
  proYearlyPrice: number
  saleEnabled: boolean
  salePercent: number
  saleBadge: string
  saleEndAt: string
}

// 管理后台：免费试用设置 / admin: free-trial settings
export interface AdminTrialSettings {
  trialEnabled: boolean
  trialDays: number
}

// 免费试用当前状态（用户端）/ current free-trial status (user-facing)
export interface TrialStatus {
  enabled: boolean
  days: number
  eligible: boolean
  usedAt: string | null
}

// 信号客观胜负：与 status（能否下单）完全独立的第二条状态线，见后端
// signal_resolution.py。PENDING = 还没判出；STALE = 追踪中断太久，不计入胜率。
// Objective win/loss for the signal: a second status axis, independent of
// `status` (whether it can still be traded) — see the backend's
// signal_resolution.py. PENDING = not yet resolved; STALE = tracking was
// interrupted for too long, excluded from the win rate.
export type SignalResult = 'PENDING' | 'HIT_TP' | 'HIT_SL' | 'STALE'

export interface Signal {
  id: string
  symbol: string
  side: 'BUY' | 'SELL'
  entry: number | null
  stopLoss: number | null
  takeProfit: number | null
  indicator: string | null
  status: 'ACTIVE' | 'EXPIRED'
  createdAt: string
  expireAt: string | null
  result: SignalResult
  resolvedAt: string | null
}

// 近 N 天每日信号发出量统计 / daily signal count for the last N days
export interface SignalDailyCount {
  date: string
  count: number
}

// 信号客观胜率：基于行情是否先碰到止盈/止损判定，与任何用户操作无关，全平台统一
// Objective signal win rate: based on whether price hit TP or SL first,
// independent of any user's behavior; the same for everyone on the platform
export interface SignalWinRate {
  hitTp: number
  hitSl: number
  pending: number
  stale: number
  totalResolved: number
  winRate: number | null
}

// 个人跟单胜率：基于真实平仓明细，只有自己能看到自己的
// Personal win rate: based on real closed trades, visible only to the user themself
export interface PersonalWinRate {
  wins: number
  losses: number
  totalResolved: number
  winRate: number | null
  openPositions: number
}

// 真实平仓成交明细（逐笔），个人跟单胜率同一份数据源，只有自己能看到自己的
// A single real closed-trade leg; same data source as the personal win rate,
// visible only to the user themself.
export interface ClosedTrade {
  id: string
  mt5Login: string
  symbol: string
  side: 'BUY' | 'SELL'
  closeVolume: number
  closePrice: number | null
  profit: number
  positionTicket: number
  dealTicket: number
  closedAt: string | null
}

export type OrderStatus = 'PENDING' | 'FILLED' | 'REJECTED' | 'FAILED' | 'CANCELLED'
export type OrderAction = 'ORDER' | 'CLOSE' | 'MODIFY'

export interface Order {
  id: string
  clientOrderId: string
  signalId: string | null
  action?: OrderAction
  symbol: string
  side: 'BUY' | 'SELL'
  volume: number
  ticket?: number | null
  mt5Login?: string | null
  status: OrderStatus
  mt5Ticket: number | null
  filledPrice: number | null
  message: string | null
  createdAt: string
  updatedAt: string
}

export interface MT5Account {
  login: string
  server?: string | null
  source?: string | null
  accountName?: string | null
  accountCurrency?: string | null
  balance?: number | null
  equity?: number | null
  leverage?: number | null
  company?: string | null
  symbolSuffix?: string | null
  online: boolean
  lastHeartbeat?: string | null
}

export interface Quote {
  symbol: string
  bid: number
  ask: number
  digits?: number
  time?: string
  // 上报该报价的 MT5 账号 login：仅按账户区分的报价（下单确认页用）携带此字段，
  // 全站统一展示报价（EA 推送）没有 / present only on per-account quotes (order
  // confirmation); absent on the site-wide display feed (EA-pushed).
  login?: string
}

// 一根 K 线（自建中央 MT5 喂价源）：t=epoch 秒(UTC)，o/h/l/c=开高低收，
// v=成交量（EA 上报的 MT5 tick_volume，即该 bar 内报价跳动次数；现货外汇/CFD
// 无交易所真实成交量，这是唯一可用的量能代理）。后端 FeedBar 默认 0，故永远有值。
// One candle (self-hosted central MT5 feed): t=epoch seconds (UTC), o/h/l/c=OHLC,
// v=volume (MT5 tick_volume reported by the EA — the number of price changes
// within the bar; spot FX/CFDs have no exchange volume, so this is the only
// available volume proxy). The backend's FeedBar defaults it to 0, so it's
// always present.
export interface Candle {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

// 单周期趋势方向：多 / 空 / 震荡(或无数据) / per-timeframe trend direction
export type TrendDir = 'UP' | 'DOWN' | 'FLAT'

// 一个品种的多周期趋势快照：tf 名(如 "H1") -> 方向 / multi-timeframe trend snapshot for one symbol
export interface Trend {
  symbol: string
  // 各周期趋势，键为周期名(M5/M15/H1/H4)，值为方向 / per-timeframe map, key is tf name
  timeframes: Record<string, TrendDir>
  // 最近更新时间(ISO) / last update time
  updatedAt?: string
}

// 社区多空情绪（单品种）：后端定时抓取 + 缓存，见 GET /api/sentiment
// Community long/short sentiment (one symbol): fetched & cached by the
// backend on a timer, see GET /api/sentiment
export interface SentimentRatio {
  longPct: number
  shortPct: number
}

export interface Position {
  ticket?: number
  symbol: string
  side: 'BUY' | 'SELL'
  volume: number
  profit: number
  entryPrice?: number
  currentPrice?: number
  stopLoss?: number
  takeProfit?: number
  login?: string | null
}

export interface WSMessage {
  type: 'AUTH_OK' | 'AUTH_FAIL' | 'SIGNAL_NEW' | 'SIGNAL_EXPIRED' | 'ORDER_UPDATE' | 'POSITIONS' | 'ACCOUNTS_STATUS' | 'QUOTES' | 'GLOBAL_QUOTES' | 'TREND_UPDATE' | 'PREFS_UPDATE'
  data?: unknown
  reason?: string
  userId?: string
}
