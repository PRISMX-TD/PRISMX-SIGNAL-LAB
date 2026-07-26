// 共享类型定义 / Shared type definitions

// 规则 AST 的形状定义在规则构建器目录、由这里引用（而不是反过来）：AST 的形状是
// 构建器的领域知识，构建器是它唯一的生产者。
// The rule AST's shape lives in the builder's directory and is imported here
// (not the other way round): that shape is the builder's domain knowledge and
// the builder is its only producer.
import type { RuleEnvelope } from '../components/strategies/ruleTypes'

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

// 管理后台：页面访问统计（每页每天的人数/次数/平均停留）
// admin: page stats (visitors/views/avg dwell per page per day)
export interface AdminPageDayPoint {
  date: string // YYYY-MM-DD (UTC)
  visitors: number
  views: number
  avgSeconds: number
}

export interface AdminPageStat {
  path: string
  views: number
  // 窗口内去重人数，不等于 daily 各天 visitors 之和（同一个人多天来只算一个）
  // Distinct visitors for the window; not the sum of daily visitors
  visitors: number
  avgSeconds: number
  daily: AdminPageDayPoint[] // 与 AdminPageStats.dates 同序、同长度
}

export interface AdminPageStats {
  days: number
  totalViews: number
  totalVisitors: number
  avgSecondsOverall: number
  dates: string[] // 公共日期轴，连续无缺口 / contiguous shared date axis
  pages: AdminPageStat[]
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

// 管理后台：纪律分参数设置 / admin: discipline-score parameter settings
export interface AdminDisciplineSettings {
  windowDays: number
  weightStop: number
  weightVolume: number
  weightExit: number
  slTolerancePct: number
  volumeMultiple: number
  volumeHistoryMin: number
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

// 历史信号回放（模拟器）：用已判定的真实信号回放净值曲线。数据源是全局信号表，
// 不含任何用户私有数据。**当前仅管理员可访问**（后端 require_admin），功能先内部
// 试用；对外开放时只需放开后端依赖与前端入口判断。
// Historical signal replay (simulator): an equity curve from real, resolved
// signals. Sourced from the global signals table — no user-private data.
// **Admin-only for now** (backend require_admin) while the feature is trialed
// internally; releasing it means loosening the backend dep + the entry checks.
export interface SimulateTrade {
  id: string
  symbol: string
  side: 'BUY' | 'SELL'
  createdAt: string | null
  resolvedAt: string | null
  result: 'HIT_TP' | 'HIT_SL'
  rr: number
  pnlPct: number
  equityAfter: number
}

export interface SimulateSummary {
  finalEquity: number
  returnPct: number
  maxDrawdownPct: number
  maxLossStreak: number
  wins: number
  losses: number
  winRate: number | null
  avgRr: number | null
  // 数据不完整、未参与回放的信号数（如实展示，不静默丢弃）
  // signals skipped as incomplete (disclosed, never silently dropped)
  skipped: number
  // 净值在回放中途归零，其后信号不再累计 / equity wiped out mid-replay
  busted: boolean
}

export interface SimulateResult {
  params: { days: number; risk: number; capital: number; mode: 'compound' | 'flat' }
  summary: SimulateSummary
  points: Array<{ t: string | null; equity: number }>
  trades: SimulateTrade[]
}

// 个人跟单胜率：基于真实平仓明细，只有自己能看到自己的
// Personal win rate: based on real closed trades, visible only to the user themself
export interface PersonalWinRate {
  wins: number
  losses: number
  totalResolved: number
  winRate: number | null
  openPositions: number
  bySymbol: { symbol: string; count: number }[]
}

// 纪律分单一维度的评分明细 / one scoring dimension of the discipline score
export interface DisciplineDimension {
  score: number | null
  violations: number
  samples: number
}

// 纪律分：回答"有没有按计划执行"，与赚不赚钱无关，只有自己能看到自己的。
// 对所有登录用户开放。
// Discipline score: whether the plan was followed, independent of P&L,
// visible only to the user themself. Open to all logged-in users.
export interface DisciplineScore {
  total: number | null
  windowDays: number
  positions: number
  trend: Array<{ date: string; total: number | null }>
  // 只有 PRO 才有这个键（后端按 user.plan 裁剪，不是前端隐藏）
  // Present only for PRO (gated server-side by user.plan, not hidden client-side)
  dimensions?: {
    stopLoss: DisciplineDimension
    volume: DisciplineDimension
    exit: DisciplineDimension
  }
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
  // 休市兜底：EA 在市场关闭读不到实时报价时退回最后成交价继续推送，
  // true 表示这不是实时跳动的价格。仅全站统一展示报价（EA 推送）携带。
  // Closed-market fallback: true means this is the EA's last-known trade
  // price re-sent while the market is closed, not a live-moving quote.
  // Present only on the site-wide display feed (EA-pushed).
  closed?: boolean
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

// 管理后台：K 线历史保留策略设置 / admin: candle-history retention settings
export interface AdminCandleSettings {
  m1RetentionDays: number
}

// 管理后台：自定义策略平台设置 / admin: custom-strategy platform settings
export interface AdminStrategySettings {
  maxStrategiesPerUser: number
  proOnly: boolean
}

// 自定义策略：模板名 + 该模板一个参数的定义（用于动态渲染调参表单，不写死）
// Custom strategy: one template parameter's definition, used to render the
// tuning form dynamically instead of hardcoding it
export type StrategyParamSpec =
  | { type: 'enum'; options: string[]; default: string }
  | { type: 'int'; min: number; max: number; default: number }
  | { type: 'float'; min: number; max: number; default: number }

export type StrategyTemplateKey =
  | 'ma_cross'
  | 'rsi_reversal'
  | 'bollinger_reversion'
  | 'macd_cross'
  | 'ma_pullback'
  | 'bollinger_breakout'
  | 'rsi_momentum'
  | 'donchian_breakout'
  | 'momentum_breakout'
  | 'trend_rsi_filter'

export type StrategyTemplateSchemas = Record<StrategyTemplateKey, Record<string, StrategyParamSpec>>

// 止损方式：percent(按入场价百分比距离) / steps(点数) / atr(ATR 的倍数)
// 止盈方式：rr(止损距离的倍数) / percent / steps / atr
// SL: percent (distance as % of entry) / steps (points) / atr (multiple of ATR).
// TP: rr (multiple of the SL distance) / percent / steps / atr.
export type StopLossMethod = 'percent' | 'steps' | 'atr'
export type TakeProfitMethod = 'rr' | 'percent' | 'steps' | 'atr'

// 交易时段过滤：UTC+8 小时区间，左闭右开；startHour > endHour 表示跨零点
// Session filter: UTC+8 hour range, half-open; startHour > endHour spans midnight
export interface StrategySessionFilter {
  startHour: number
  endHour: number
}

// 用户自定义策略：一棵规则树（AST）+ 出场设定，对若干品种/周期持续评估。
// template 仅记录"从哪个预设起步"，纯自定义策略为 null。
// A user strategy: one rule tree (AST) plus exit settings, evaluated
// continuously across several symbols/intervals. `template` only records which
// preset it started from and is null for a from-scratch strategy.
export interface UserStrategy {
  id: string
  template: StrategyTemplateKey | null
  name: string | null
  rules: RuleEnvelope
  symbols: string[]
  intervals: string[]
  stopLossMethod: StopLossMethod
  stopLossValue: number
  takeProfitMethod: TakeProfitMethod
  takeProfitValue: number
  // 一次一单：开着仓时不再触发新信号，关闭则只要条件满足就触发
  // One trade at a time: no new signal while a position is open; off means
  // any bar meeting the condition fires regardless
  oneTradeAtATime: boolean
  // 超时平仓：持仓超过 N 根 K 线仍未触及 SL/TP 则按收盘价平掉，null = 不启用
  // Timeout exit: close at the bar's close after N bars without an SL/TP touch;
  // null disables it
  exitTimeoutBars: number | null
  sessionFilter: StrategySessionFilter | null
  dailySignalCap: number | null
  cooldownMinutes: number | null
  enabled: boolean
  createdAt: string
}

// 与 SimulateSummary 结构近似,但策略回测不存在"数据不完整的信号被跳过"这个
// 概念(没有 skipped 字段),故单独定义,不复用 SimulateSummary。
// Structurally similar to SimulateSummary, but a strategy backtest has no
// "incomplete signal, skipped" concept — no `skipped` field — so this is its
// own type rather than reusing SimulateSummary.
export interface StrategyBacktestSummary {
  finalEquity: number
  returnPct: number
  maxDrawdownPct: number
  maxLossStreak: number
  wins: number
  losses: number
  winRate: number | null
  avgRr: number | null
  busted: boolean
}

// 样本内 / 样本外各一套完整指标。切分固定 70/30，无开关。
// A full metric set for each of the in- and out-of-sample sections. The split is
// fixed at 70/30 with no toggle.
export interface StrategySampleSection {
  barsUsed: number
  summary: StrategyBacktestSummary
  trades: StrategyBacktestTrade[]
}

// 过拟合判定。insufficientSample 为 true 时不作判断（任一段不足 10 笔），
// 此时 flagged 恒为 false，界面应显示"样本不足，未评估"而不是"无风险"。
// Overfit verdict. With insufficientSample true no judgement is made (either
// section has fewer than 10 trades); flagged is then always false and the UI
// must read "not evaluated, insufficient sample" rather than "no risk".
export interface StrategyOverfitRisk {
  flagged: boolean
  reason: 'winRateDrop' | 'returnFlip' | null
  insufficientSample: boolean
}

// 某个 (品种, 周期) 的实际数据覆盖情况。回测执行之前就能拿到，用来告诉用户
// "已选 365 天，实际可用 47 天"，以及把未接入品种置灰。
// Actual data coverage for one (symbol, interval), available before a backtest
// runs: powers "365 days requested, 47 available" and greying out unfed symbols.
export interface StrategyCoverage {
  symbol: string
  interval: string
  bars: number
  earliestT: number | null
  latestT: number | null
  spanDays: number
  gapCount: number
  missingSeconds: number
  feedActive: boolean
}

export interface StrategyCoverageResponse {
  coverage: StrategyCoverage[]
  activeSymbols: string[]
}

// 策略回测的逐单明细：在 SimulateTrade 的字段基础上，多带入场/出场那根 K 线的
// epoch 秒与成交价，供图表精确定位标记，不用把 ISO 时间字符串再解析回时间戳。
// result 比 SimulateTrade 多一种 TIMEOUT（超时平仓，按当根收盘价出场）——平台
// 信号回放没有这个概念，所以只能在这里把该字段覆写宽一档，不能直接继承。
// A strategy-backtest trade: like SimulateTrade, plus the entry/exit bar's epoch
// seconds and fill price, so the chart can place markers precisely without
// re-parsing the ISO timestamps. `result` carries one more case than
// SimulateTrade — TIMEOUT (a timeout exit at that bar's close) — a notion the
// platform-signal replay doesn't have, so the field is widened here by override
// rather than inherited as-is.
export interface StrategyBacktestTrade extends Omit<SimulateTrade, 'result'> {
  result: 'HIT_TP' | 'HIT_SL' | 'TIMEOUT'
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
}

// 到数据末尾都没摸到止损/止盈的仓位——不计入 trades/summary,但通过这个
// 字段明确告诉前端"不是没有信号,是这些还开着",避免用户看到一份没有任何
// 解释的"0 笔交易"。一次一单模式下最多只有 1 条(一碰到未解决就不再继续
// 扫描);关掉一次一单时,同一时间可以有多笔各自独立"还开着",全部列出。
// entryTime 是那根入场 K 线的 epoch 秒。
// Positions (if any) that never hit SL/TP before the data ran out —
// excluded from trades/summary, but surfaced here so the frontend can
// explain "not zero signals, just still open" instead of showing an
// unexplained 0-trades result. Under one-trade-at-a-time there's at most
// one (scanning stops entirely on the first unresolved signal); with it
// off, several independent positions can be open at once, all listed here.
// entryTime is the entry bar's epoch seconds.
export interface StrategyBacktestOpenPosition {
  side: 'BUY' | 'SELL'
  entryPrice: number
  stopLoss: number
  takeProfit: number
  entryTime: number
}

// 响应不再有 bars 与 params / barsAvailable：蜡烛图数据改由既有的 chartApi
// 拉取，barsUsed + coverage 取代 barsAvailable。insufficientData 为 true 时
// 后端只回 barsUsed / requestedDays / coverage / cached 四项，其余字段缺席，
// 消费方必须先判这一项再读 summary。
// No more bars / params / barsAvailable: candles come from the existing chartApi,
// and barsUsed + coverage replace barsAvailable. When insufficientData is true
// the backend returns only barsUsed / requestedDays / coverage / cached, so
// consumers must check that flag before reading summary.
export interface StrategyBacktestResult {
  summary: StrategyBacktestSummary
  points: Array<{ t: string | null; equity: number }>
  trades: StrategyBacktestTrade[]
  openPositions: StrategyBacktestOpenPosition[]
  inSample: StrategySampleSection
  outOfSample: StrategySampleSection
  overfitRisk: StrategyOverfitRisk
  // 本次回测扣除的总成本，以及不含成本的对照结果——并列展示才能让成本可见。
  // Total cost deducted, plus the cost-free comparison: showing both is what
  // makes the cost visible.
  totalCost: number
  withoutCosts: { summary: StrategyBacktestSummary; trades: StrategyBacktestTrade[] }
  barsUsed: number
  requestedDays: number
  coverage: StrategyCoverage
  insufficientData: boolean
  cached: boolean
}

// 策略触发的个人信号：只有策略主人自己能看到 / a strategy-fired personal
// signal, visible only to its owner
export interface StrategySignal {
  id: string
  strategyId: string
  symbol: string
  interval: string | null
  side: 'BUY' | 'SELL'
  entry: number
  stopLoss: number
  takeProfit: number
  // PENDING / HIT_TP / HIT_SL / TIMEOUT / STALE。TIMEOUT 是真实出场（计入绩效），
  // STALE 是数据源中断的兜底（不计入）。
  // PENDING / HIT_TP / HIT_SL / TIMEOUT / STALE. TIMEOUT is a real exit (counts
  // toward performance); STALE is the feed-outage fallback (does not).
  result: 'PENDING' | 'HIT_TP' | 'HIT_SL' | 'TIMEOUT' | 'STALE'
  barsHeld: number
  resolvedAt: string | null
  createdAt: string
}

// 实盘绩效。insufficientSample 为 true 时 winRate / avgRr 为 null，界面显示
// "样本不足"——不足 10 笔的百分比会误导。
// Live performance. With insufficientSample true, winRate/avgRr are null and the
// UI shows "insufficient sample": a percentage over fewer than 10 trades misleads.
export interface StrategyPerformance {
  strategyId: string
  resolved: number
  wins: number
  losses: number
  timeouts: number
  pending: number
  winRate: number | null
  avgRr: number | null
  maxLossStreak: number
  insufficientSample: boolean
  sampleThreshold: number
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
  type: 'AUTH_OK' | 'AUTH_FAIL' | 'SIGNAL_NEW' | 'SIGNAL_EXPIRED' | 'ORDER_UPDATE' | 'POSITIONS' | 'ACCOUNTS_STATUS' | 'QUOTES' | 'GLOBAL_QUOTES' | 'TREND_UPDATE' | 'PREFS_UPDATE' | 'STRATEGY_SIGNAL'
  data?: unknown
  reason?: string
  userId?: string
}
