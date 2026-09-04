// 共享类型定义 / Shared type definitions

// 条件配置的形状定义在条件构建器目录、由这里引用（而不是反过来）：那份形状是
// 构建器的领域知识，构建器是它唯一的生产者。
// The condition payload's shape lives in the builder's directory and is imported
// here (not the other way round): that shape is the builder's domain knowledge
// and the builder is its only producer.
import type {
  ConditionLogic,
  ConditionPayload,
  StrategyCondition,
} from '../components/strategies/conditionTypes'

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
  phone?: string | null
  // 是否还欠一个手机号。由后端算（存量用户 phone 也为空但豁免，前端分不出来）。
  // Whether a phone is still owed; computed server-side because grandfathered
  // users also have an empty phone but are exempt.
  needsPhone?: boolean
  // 当前 PRO 是否为免费试用；登录/注册响应不带这个字段（未知），
  // 只有 refreshUser()（调 GET /auth/me）之后才会补上。
  // Whether the current PRO is a free trial; absent (unknown) on the
  // login/register response — only populated after refreshUser() (GET /auth/me).
  planIsTrial?: boolean
  // PRO 到期时间（ISO 字符串）；null = 永不过期（管理员赠送/内测）。
  // 与 planIsTrial 一样，登录/注册响应里没有，refreshUser() 之后才有值，
  // 所以是可选的——undefined 表示「还不知道」，与 null 的「永不过期」是两回事，
  // 到期横幅必须区分这两者，否则页面刚加载的一瞬间会把所有人都当成永久 PRO。
  // PRO expiry as an ISO string; null = never expires (comp grant / beta).
  // Like planIsTrial it's absent from the login/register response and only
  // filled in by refreshUser(), hence optional — undefined means "not known
  // yet", which is a different thing from null's "never expires". The expiry
  // banner has to tell them apart or, for one render right after load, it would
  // treat everyone as a permanent PRO.
  planExpiresAt?: string | null
  // 游戏化功能对该用户是否可见（内测开关）。与 planIsTrial/planExpiresAt 同样
  // 不在登录/注册响应里，只有 refreshUser()（GET /auth/me）之后才会补上——
  // 导航入口据此门控，登录瞬间的一次渲染里入口先不出现，随后台判定补上,
  // 优于把内测用户提前漏出去。
  // Whether gamification is visible to this user (beta gate). Like
  // planIsTrial/planExpiresAt, absent from the login/register response and
  // only filled in by refreshUser() (GET /auth/me); nav entries gate on this,
  // so it's fine for them to be briefly absent right after login rather than
  // leaking the beta feature to everyone from the first render.
  gamificationVisible?: boolean
  // 排行榜对该用户是否可见（内测开关，独立于 gamificationVisible——见后端
  // GamificationSettings.leaderboardVisible）。同样只在 refreshUser() 之后
  // 才会补上，先例见 gamificationVisible 上方注释。
  // Whether the leaderboard is visible to this user (a beta gate independent
  // of gamificationVisible — see the backend's
  // GamificationSettings.leaderboardVisible). Likewise only filled in by
  // refreshUser(); see the gamificationVisible comment above for the precedent.
  leaderboardVisible?: boolean
  // 比赛（Phase 3）对该用户是否可见（内测开关，独立于上面两个——见后端
  // GamificationSettings.competitionsVisible）。同样只在 refreshUser() 之后
  // 才会补上，先例同 gamificationVisible/leaderboardVisible。
  // Whether competitions (Phase 3) are visible to this user (a beta gate
  // independent of the two above — see the backend's
  // GamificationSettings.competitionsVisible). Likewise only filled in by
  // refreshUser(); see the gamificationVisible comment above for the precedent.
  competitionsVisible?: boolean
  // 等级/称号（§7）：随 gamificationVisible 一起搭 refreshUser()（GET
  // /auth/me）这趟便车下发，用户菜单角标不用再单独请求 gamificationApi.me()。
  // 只有 gamificationVisible 为真时后端才会算，否则是 null——先例同上面三个
  // 可见性开关。
  // Level/title (§7): piggyback on the same refreshUser() (GET /auth/me)
  // round trip as gamificationVisible, so the user-menu badge costs no extra
  // request. The backend only computes these when gamificationVisible is
  // true for this user, otherwise null — same precedent as the three
  // visibility flags above.
  gamificationLevel?: number | null
  gamificationTitle?: string | null
}

// 管理后台：用户列表条目 / admin: one row in the user list
export interface AdminUser {
  id: string
  email: string
  // 存量用户为空（强制记录上线前注册的一律豁免），不是数据缺失
  // Empty for accounts grandfathered before the mandatory-phone rule shipped
  phone?: string | null
  role: UserRole
  plan: UserPlan
  planExpiresAt: string | null
  planNote: string | null
  createdAt: string | null
  lastActiveAt: string | null
  mt5AccountCount: number
}

// 邀请链接（管理后台）。registrations 按隐藏归因码统计，与备注文本解耦。
// Admin invite link; registrations count by the hidden attribution code.
export interface InviteLink {
  id: string
  code: string
  label: string
  clicks: number
  registrations: number
  isActive: boolean
  // 经此链接注册是否自动开通 PRO 试用。是否真的会发还要看全局试用开关，
  // 管理页在全局关闭时把这一列置灰（后端 _trial_grant_days 是唯一判定处）。
  // Whether signups through this link auto-receive the PRO trial; the global
  // trial switch still gates it, so the admin panel greys the column out when
  // that switch is off.
  grantsTrial: boolean
  createdAt: string | null
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

// 管理后台：策略 × 交易时段胜率
// admin: per-strategy, per-session win rate
export interface SessionWindow {
  key: string // asia / europe / newyork
  tz: string // IANA 时区名，夏令时由它承担 / IANA zone; DST comes from it
  startHour: number
  endHour: number // 左闭右开 / half-open
}

export interface WinRateBucket {
  hitTp: number
  hitSl: number
  pending: number // 尚未走出结果，不进分母 / no outcome yet, out of the denominator
  stale: number // 行情追踪中断，不进分母 / tracking broke, out of the denominator
  resolved: number // hitTp + hitSl
  samples: number
  // 分母为 0 时为 null——与真实的 0% 胜率不是一回事
  // null on an empty denominator — not the same thing as a real 0%
  winRate: number | null
  // Wilson 95% 置信下限，推荐榜排序键；分母为 0 时 null（后端算，前端只排序）
  // ranking key computed server-side; null when unresolved
  wilsonLow: number | null
  // Wilson 区间上限。[wilsonLow, wilsonHigh] 在点图上画成横杠——区间宽窄就是
  // 样本厚薄的可视化，5 笔的 50% 与上千笔的 50% 因此一眼可分。
  // The interval's upper bound; [low, high] is drawn as a whisker so sample
  // thickness is visible rather than something to read in fine print.
  wilsonHigh: number | null
  // 平均判定秒数；无已判定时 null / mean seconds to resolution
  avgResolveSeconds: number | null
  // samples ÷ days × 7 / normalized weekly count
  weeklySignals: number
  // 自窗口起点每 24h 一格的信号总数（含未判定），旧→新，长度=days。
  // 推荐卡的活跃度柱图用。品种层与方向桶为 null。
  // Signal totals per 24h from the window start (unresolved included),
  // oldest→newest, length = days; feeds the recommendation sparkline.
  // Null at the symbol layer and on side buckets.
  daily: number[] | null
  // 按钟点（UTC，0–23）累计的止盈/止损，长度恒 24，**只含已判定**。
  // By hour of day (UTC, 0-23), always length 24, **resolved signals only**.
  hourly: HourOutcome[] | null
}

// 一天中某个钟点在整个窗口内累计的止盈/止损笔数。只含已判定的信号——未判定的
// 不出现在这张图上，等它真走出结果那天再计进来。后端不算百分比：一个钟点在薄
// 窗口里只有三五笔时百分比会在 100/0/50 之间跳，是否显示由前端按样本门槛决定。
//
// **索引是 UTC 钟点，不是本地钟点**：后端不可能知道看的人在哪个时区。前端负责
// 旋转成浏览者本地钟点（24 格是一个完整循环，旋转无损）。
//
// Take-profit / stop-loss counts for one hour of day across the window. Resolved
// signals only — unresolved ones are absent and join on the day they reach an
// outcome. No percentage server-side: with a handful of trades an hour's rate
// swings between 100/0/50, so showing one is the UI's call against its sample
// floor. **The index is the UTC hour, not a local one** — the backend cannot
// know the reader's zone; the frontend rotates these into the viewer's clock
// (24 slots are a full cycle, so the rotation is lossless).
export interface HourOutcome {
  tp: number
  sl: number
}

export interface SymbolWinRate {
  symbol: string
  total: WinRateBucket
  sessions: Record<string, WinRateBucket>
  // 键为 BUY / SELL。方向认不出的历史行不进任何一侧，故两者之和可能小于
  // total.samples——刻意如此，不是漏计。
  // Keyed BUY / SELL. Legacy rows with an unrecognized side join neither, so the
  // two may sum to less than total.samples — deliberate, not a miscount.
  sides: Record<string, WinRateBucket>
}

export interface StrategyWinRate {
  strategy: string // 空串 = 信号没带策略名 / empty = the signal carried no strategy name
  total: WinRateBucket
  // 键：asia / europe / newyork / outside。时段之间有重叠，各时段 samples 之和
  // 会大于 total.samples。
  // Keyed asia / europe / newyork / outside. Sessions overlap, so the per-session
  // samples sum to more than total.samples.
  sessions: Record<string, WinRateBucket>
  // 键为 BUY / SELL。方向认不出的历史行不进任何一侧，故两者之和可能小于
  // total.samples——刻意如此，不是漏计。
  // Keyed BUY / SELL. Legacy rows with an unrecognized side join neither, so the
  // two may sum to less than total.samples — deliberate, not a miscount.
  sides: Record<string, WinRateBucket>
  // 品种子分层，已判定笔数降序；overall 行恒为 [] / per-symbol layer, [] on overall
  symbols: SymbolWinRate[]
}

// 胜率公开设置：管理页那张表的一行。
// `resolved == 0` 且 `winRate == null` = 这个策略近 N 天没有已判定信号（新上线，
// 或早已停用）。这种行照样返回并显示"近 N 天没有信号"，不静默丢弃——丢掉会让
// 管理员以为自己没勾过它。
// One row of the win-rate publication settings table. `resolved == 0` with a null
// winRate means no resolved signals in the window (new, or long retired). Such
// rows are still shown, labelled as such, rather than dropped silently — which
// would read as "I never ticked that".
export interface AdminWinrateStrategy {
  strategy: string
  resolved: number
  winRate: number | null
  public: boolean
}

export interface AdminWinrateSettings {
  days: number
  strategies: AdminWinrateStrategy[]
}

export interface AdminStrategyWinRate {
  days: number
  windowStart: string
  windowEnd: string
  // 最近一次成功判定的时间，不受窗口限制；null = 从未判定成功。
  // 判定只在 /webhook/trend 带 high/low 时发生，这是那条链路是否还活着的读数。
  // Last successful resolution, window-independent; null means it never happened.
  // Resolution only runs on /webhook/trend with high/low — this is that path's pulse.
  lastResolvedAt: string | null
  sessions: SessionWindow[]
  overall: StrategyWinRate
  strategies: StrategyWinRate[] // 已判定样本数降序 / by resolved samples desc
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
  exitSlDistancePct: number
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
  // 统计回看窗口（天）。这些数字只覆盖最近这么多天，不是全历史——后端给订单
  // 查询加了时间上界，否则它会随用户交易时长无界增长（口径见后端
  // trade_performance.WINDOW_DAYS）。必须展示出来：一个有范围的数字被当成全
  // 历史战绩来读，就是在误导用户。
  // Look-back window in days. These figures cover only the last N days, not all
  // history — the backend bounds the order query, which would otherwise grow
  // without limit as a user keeps trading (see trade_performance.WINDOW_DAYS).
  // It has to be shown: a bounded number read as an all-time record misleads.
  windowDays: number
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
  // 直连绑定已失效，需要用户重新输一次 MT5 主密码。与 online 分开：离线是
  // "等一会儿"，失效是"你不动手它永远不会好"，显示成同一个灰徽标会让用户一直等。
  // Revoked direct-connect binding needing the MT5 main password re-entered.
  // Separate from `online`: offline means wait, this means act.
  needsReverify?: boolean
  revokedReason?: string | null
  // 账户类型：0=模拟，1=竞赛，2=实盘，null/undefined=尚未判定。消费方须把
  // 未知当"非实盘"处理，不能默认放行（例如比赛报名选择器）。
  // Account trade mode: 0=demo, 1=contest, 2=real, null/undefined=not yet
  // determined. Consumers must treat unknown as "not real", never
  // default-allow (e.g. the competition registration picker).
  tradeMode?: number | null
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

// 平台策略介绍：管理员手工维护的内容，用户端只读展示。
//
// 刻意不含胜率、盈亏比等业绩数字：真实战绩的唯一来源是信号表的 result 判定
// （后端 services/signal_resolution.py），在这里手填数字会与之冲突。本结构只
// 描述策略的设计特征——适用行情、持仓时长、风险回报比设计值、所用指标。
//
// Platform strategy write-ups: admin-authored content, read-only for users.
//
// Deliberately carries no win-rate or profit-factor figures: the only source of
// real performance is the signals table's result adjudication (backend
// services/signal_resolution.py), and hand-entered numbers would contradict it.
// This describes design characteristics only — market regime, holding time,
// designed risk:reward, indicators used.
// 详细说明的一个内容块。分块而不是一段长文本：长文本在页面上挤成一团，而支持
// Markdown/HTML 又要引入解析器和注入面。四种已知类型让渲染不需要解析任何标记。
// text 的含义随 kind 变化：heading 小标题、paragraph 正文段落、list 要点列表
//（按换行切分每条）、image 图注（可空，图片本体在 imageUrl）。
// One block of the long description. Blocks rather than one blob: a blob reads as
// a wall of text, while Markdown/HTML would mean a parser and its injection
// surface. Four known types mean rendering parses no markup.
// `text` means: heading = subheading, paragraph = body, list = bullets (split on
// newlines), image = optional caption (the image itself is in imageUrl).
export type PlatformStrategyBlockKind = 'heading' | 'paragraph' | 'list' | 'image'

export interface PlatformStrategyBlock {
  kind: PlatformStrategyBlockKind
  textZh: string
  textEn: string
  imageUrl: string
}

export interface PlatformStrategy {
  id: string
  order: number
  published: boolean
  nameZh: string
  nameEn: string
  summaryZh: string
  summaryEn: string
  // 结构化内容块，按顺序渲染 / structured blocks, rendered in order
  blocks: PlatformStrategyBlock[]
  // 第一版的单段纯文本，已被 blocks 取代。保留以免丢已录入内容：blocks 为空时
  // 详情页回落渲染它。新内容一律写 blocks。
  // First version's single blob, superseded by blocks. Kept so entered copy isn't
  // lost: the detail page falls back to it when blocks is empty. New content goes
  // into blocks.
  detailZh: string
  detailEn: string
  symbols: string[]
  indicators: string[]
  timeframes: string[]
  marketRegimeZh: string
  marketRegimeEn: string
  holdingTimeZh: string
  holdingTimeEn: string
  riskReward: string
  imageUrl: string
}

// 六条新手预设，与后端 presets.TEMPLATE_KEYS 一致。载入后条件完全可改，引擎侧
// 不认识 template，它只记录「这条策略当初从哪个预设起步」。
// The six beginner presets, matching the backend's presets.TEMPLATE_KEYS. The
// conditions are freely editable once loaded; the engine knows nothing about
// templates, which only record which preset a strategy started from.
export type StrategyTemplateKey =
  | 'ma_trend'
  | 'macd_cross'
  | 'rsi_reversal'
  | 'bollinger_breakout'
  | 'donchian_breakout'
  | 'macd_rsi_combo'

// 预设只给逻辑与条件，不含品种周期：那两项由用户在表单里选，前端补齐后才是一份
// 完整的 rules。
// A preset carries only logic and conditions, no symbol/interval: the user picks
// those in the form and the frontend fills them in to make a complete `rules`.
export type StrategyPresets = Record<
  StrategyTemplateKey,
  { logic: ConditionLogic; conditions: StrategyCondition[] }
>

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

// 用户自定义策略：一份条件配置 + 出场设定，盯一个 (品种, 周期) 持续评估。
// 一条策略只对应一个组合——想覆盖多个组合就建多条，各自独立的绩效与去重游标。
// template 仅记录"从哪个预设起步"，纯自定义策略为 null。
// rules 里也带着 symbol / interval，与外层两个字段始终相等（后端写入时保证）。
// A user strategy: one condition payload plus exit settings, evaluated on one
// (symbol, interval). One strategy means one pair — covering several means
// several strategies, each with its own performance and de-dup cursor.
// `template` only records which preset it started from and is null for a
// from-scratch strategy. `rules` carries symbol/interval too, always equal to
// the outer fields (the backend guarantees it on write).
export interface UserStrategy {
  id: string
  template: StrategyTemplateKey | null
  name: string | null
  rules: ConditionPayload
  symbol: string
  interval: string
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
  // maxLossStreak 的回看范围（笔已判定信号）。连亏是顺序相关指标，无法聚合，
  // 不限窗口就得扫该策略的全部历史。UI 必须把这个范围标出来，否则用户会把
  // 一个有范围的数字读成"全历史最长连亏"。
  // The look-back for maxLossStreak, in resolved signals. A losing run is
  // order-dependent and can't be aggregated, so without a window it would scan
  // the strategy's entire history. The UI must state the range, or users will
  // read a bounded number as an all-time figure.
  streakWindow: number
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

// 随 POSITIONS 一起下发的账号实时资金：按 login 汇总的持仓浮动盈亏。
// 前端用它加上余额算实时净值，不必等 5 秒一次的账号列表轮询。
// Live per-account funds shipped with POSITIONS: floating P/L summed per login.
// The frontend adds balance to get live equity without waiting on the 5s poll.
export interface AccountFunds {
  login: string
  profit: number
}

export interface WSMessage {
  type: 'AUTH_OK' | 'AUTH_FAIL' | 'SIGNAL_NEW' | 'SIGNAL_EXPIRED' | 'ORDER_UPDATE' | 'POSITIONS' | 'ACCOUNTS_STATUS' | 'QUOTES' | 'GLOBAL_QUOTES' | 'TREND_UPDATE' | 'PREFS_UPDATE' | 'STRATEGY_SIGNAL' | 'CLOSED_TRADE_NEW'
  data?: unknown
  // 仅 POSITIONS 携带 / only present on POSITIONS
  funds?: AccountFunds[]
  reason?: string
  userId?: string
}

// 工单系统 / ticket system
export type TicketCategory = 'account' | 'payment' | 'technical' | 'feature'
export type TicketPriority = 'low' | 'normal' | 'urgent'
export type TicketStatus = 'open' | 'in_progress' | 'closed'

export interface TicketReply {
  id: string
  authorId: string
  authorEmail: string
  authorRole: 'user' | 'admin'
  body: string
  createdAt: string
}

export interface Ticket {
  id: string
  userId: string
  userEmail: string
  title: string
  category: TicketCategory
  priority: TicketPriority
  status: TicketStatus
  createdAt: string
  updatedAt: string
  replies: TicketReply[]
}

export interface TicketListItem {
  id: string
  userEmail: string
  title: string
  category: TicketCategory
  priority: TicketPriority
  status: TicketStatus
  updatedAt: string
  latestReply: TicketReply | null
}

// 游戏化（设计 §6/§11）/ Gamification
// 勋章稀有度 / badge rarity tiers
export type GamificationBadgeRarity = 'common' | 'rare' | 'epic' | 'legendary' | 'limited'

export interface GamificationBadge {
  id: string
  rarity: GamificationBadgeRarity
  category: string
  earned: boolean
  awardedAt: string | null
  equipped: boolean
  // 全站拥有此勋章的用户数（一次分组计数覆盖全部勋章，见 build_me_payload）。
  // Sitewide holder count for this badge (one grouped count over all badges,
  // see build_me_payload).
  owners: number
}

// 单个条件（任务）的判定状态。progressNow/progressTarget/currentWinRate 只在
// 有进度可展示的条件上出现（如"累计交易日 30 天"），纯布尔条件（如"设置昵称"）
// 不带这些字段。state 为 locked 时表示同组前置条件未满足，任务尚未开始计入。
// One task's judged state. progressNow/progressTarget/currentWinRate appear only
// on conditions that have progress to show (e.g. "30 real-account trading
// days"); purely boolean conditions (e.g. "set a nickname") omit them. state
// "locked" means the group's prerequisite tasks aren't met yet, so this one
// hasn't started counting.
export interface GamificationTask {
  id: string
  done: boolean
  // 进度种类：前端据此选单位与画法（后端 condition_states 下发）
  // Progress kind — the page picks units and bar style from it (sent by condition_states)
  kind?: 'boolean' | 'days' | 'trades' | 'lots' | 'profit' | 'winrate'
  progressNow?: number
  progressTarget?: number
  state?: 'locked' | 'pending' | 'done'
  currentWinRate?: number | null
}

export interface GamificationGroup {
  group: string
  tasks: GamificationTask[]
}

// 单个 MT5 账号在胜率窗口内的表现 / one MT5 login's performance within the win-rate window
export interface GamificationPerLoginWinRate {
  login: string
  trades: number
  wins: number
  winRate: number | null
  // 该账号在窗口内被剔出统计范围的下单数（非实盘等），不是一个布尔标记。
  // Count of this login's window orders excluded from the assessment (e.g.
  // non-real-account orders) — a count, not a boolean flag.
  excluded: number
}

export interface GamificationWinRate {
  value: number | null
  windowDays: number
  perLogin: GamificationPerLoginWinRate[]
}

// GET /gamification/me 的完整响应。 / full response of GET /gamification/me
export interface GamificationMe {
  level: number
  title: string
  groups: GamificationGroup[]
  badges: GamificationBadge[]
  winRate: GamificationWinRate
  nickname: string | null
  nicknamePublic: boolean
  leaderboardOptOut: boolean
  // equippedBadge 是列表首枚（榜单/比赛行上画的那枚默认）；equippedBadges 是
  // 全部佩戴（有序，最多 3 枚），只在成就页展示。
  // equippedBadge is the list's first entry (the default drawn on leaderboard /
  // competition rows); equippedBadges is the full ordered set (max 3), shown
  // only on the achievements page.
  equippedBadge: string | null
  equippedBadges: string[]
  // 全站用户数（详情层拥有率 owners/population 的分母）。
  // Sitewide user count (the denominator for the detail layer's owners/population rate).
  population: number
}

// GET /gamification/winrate-summary 的响应（设计 §2.4/§7）：仪表盘胜率卡的
// 轻量并行数据源——独立于 /gamification/me，服务端做了 60 秒缓存，可以放心
// 跟 orderApi.winrate() 同一个 45 秒轮询节奏一起拉。
// Response of GET /gamification/winrate-summary (§2.4/§7): the lightweight,
// parallel data source for the dashboard win-rate card — separate from
// /gamification/me, server-side cached for 60s, safe to poll on the same 45s
// cadence as orderApi.winrate().
export interface GamificationWinRateSummary {
  winRate: number | null
  windowDays: number
  trades: number
  level: number
  title: string
  // 下一级毕业线的胜率门槛；下一关不含胜率条件（如一级 qicheng）或已满级时为
  // null——区分这两种 null 要看 isMaxLevel。
  // The next level's win-rate graduation bar; null when the next group has no
  // win-rate condition (e.g. level 1's qicheng) or at max level — disambiguate
  // the two via isMaxLevel.
  nextWinRateTarget: number | null
  // 是否已达下一级胜率门槛（严格大于，跟 conditions.py 的判定口径一致，
  // ==target 不算达标）；nextWinRateTarget 为 null 时这里也是 null。
  // Whether the next win-rate bar is already cleared (strictly greater than,
  // matching conditions.py's judging — == target does not count); null
  // whenever nextWinRateTarget is null.
  metNext: boolean | null
  // 距下一级还差多少个百分点：null=胜率未知（trades=0）、下一关无胜率条件、
  // 或已满级；0=恰好卡在门槛上或以上（配合 metNext 判断到底是否已达标）；
  // 否则是正数（尚差多少个百分点）。
  // Percentage points still needed to clear the next bar: null = win rate
  // unknown (trades=0), the next group has no win-rate condition, or max
  // level; 0 = sitting at or above the bar (pair with metNext to know whether
  // it's actually cleared); otherwise a positive number of points still needed.
  gapPct: number | null
  // 下一关里还没做完的条件数（含非胜率条件）；已满级时为 null。
  // Undone condition count in the next group (including non-win-rate ones);
  // null at max level.
  remainingToNext: number | null
  // 是否已满级（GROUPS 里没有下一关了），取代前端曾经硬编码的 level >= 6。
  // Whether the user is already at max level (no next group in GROUPS) —
  // replaces the frontend's former hardcoded level >= 6 check.
  isMaxLevel: boolean
}

// PATCH /auth/profile 的请求体：全部可选，只改传了的字段。equippedBadge 显式
// 传 null 表示卸下勋章，与不传（保持不变）不同。
// PATCH /auth/profile request body: every field optional, only sent ones
// change. equippedBadge: null explicitly unequips, distinct from omitting it.
export interface ProfilePatch {
  nickname?: string
  nicknamePublic?: boolean
  leaderboardOptOut?: boolean
  equippedBadge?: string | null
  // 有序佩戴列表，首枚为默认；传 [] = 全部卸下。同时传两个字段时后端以本字段为准。
  // Ordered equipped list, first = default; [] unequips all. When both fields are
  // sent the backend takes this one.
  equippedBadges?: string[]
}

export interface ProfileOut {
  nickname: string | null
  nicknamePublic: boolean
  leaderboardOptOut: boolean
  equippedBadge: string | null
  equippedBadges: string[]
}

// 排行榜（设计 §4.3）/ Leaderboard
// 榜单 id：收益率榜 / 胜率榜——与后端 LEADERBOARD_BOARDS 一一对应。
// Board id: return-rate board / win-rate board — matches backend LEADERBOARD_BOARDS 1:1.
export type LeaderboardBoard = 'return_pct' | 'win_rate'

// 榜单一行：displayName 已按 nickname_public 打码（未公开昵称时脱敏），不是
// 原始邮箱/昵称本身。 One leaderboard row: displayName is already masked per
// nickname_public (redacted when the nickname isn't public) — not the raw
// email/nickname.
export interface LeaderboardRow {
  rank: number
  displayName: string
  login: string
  score: number
  // sample 仍在负载里（排序的次级键、未上榜进度都要用），只是榜单页不再展示。
  // sample stays in the payload (it is the sort tiebreaker and feeds the
  // not-ranked progress block); the board just no longer displays it.
  sample: number
  isSelf: boolean
  equippedBadge: string | null
  // 以下三个只在管理端预览（GET /admin/gamification/leaderboard）里出现——
  // 用户端响应永远不带它们（昵称打码、不下发 user_id 是 §4.3 的契约）。
  // These three appear only in the admin preview (GET
  // /admin/gamification/leaderboard); the user-facing response never carries
  // them (masked names and no user_id are the §4.3 contract).
  userId?: string
  nickname?: string | null
  email?: string
}

// GET /gamification/leaderboard 、GET /admin/gamification/leaderboard 的完整
// 响应。me 为 null 表示本期未上榜（含未参与）。
// Full response of GET /gamification/leaderboard and
// GET /admin/gamification/leaderboard. me is null when not ranked this
// period (including not having participated).
// 当前生效的入榜门槛（后端 boards.board_gates 下发，管理端可调）——前端渲染
// 榜规文案/未上榜提示用这份活数字，不再写死 5/20/500。比赛详情页
// （CompetitionDetail.board）复用同一个 LeaderboardPayload 形状，因此也带这份
// gates。
// The currently effective entry gates (sent by the backend's
// boards.board_gates, admin-adjustable) — the frontend renders its rules copy
// / not-ranked hint from this live number instead of hardcoding 5/20/500. The
// competition detail page reuses this same LeaderboardPayload shape
// (CompetitionDetail.board), so it carries gates too.
export interface LeaderboardGates {
  minTradesReturn: number
  minTradesWinrate: number
  minBaselineUsd: number
  // 胜率榜是否要求本期盈亏为正（管理端可配，默认关）。为 false 时不渲染那条榜规芯片。
  // Whether the win-rate board requires positive period P&L (admin-configurable,
  // default off). When false, that gate chip isn't rendered.
  winrateRequireProfit: boolean
}

// 观众本期未上榜但已拍过基线时的进度块（多账户取本期已判定整仓数最多的
// 那个）；本期从未拍过基线（未参与/未开实盘账户）时为 null。
// The viewer's progress block when unranked this period but with at least
// one account baseline taken (with multiple accounts, the one with the most
// resolved positions this period); null when no baseline was ever taken
// this period (didn't participate / no real account yet).
export interface LeaderboardProgress {
  login: string
  sample: number
  baselineUsd: number
  minTrades: number
  minBaselineUsd: number
}

// 上期冠军（领奖台/空榜提示用）——上一个自然周/月的第一名，displayName 已
// 按同一套打码规则处理。比赛榜（period_key 形如 comp:<id>）没有"上一期"概念，
// 恒为 null。
// Previous period's #1 (used by the podium / empty-state hint) — the prior
// natural week/month's rank-1 row, displayName masked by the same rules. A
// competition board (period_key like comp:<id>) has no "previous period"
// concept and this is always null there.
export interface LeaderboardPreviousWinner {
  displayName: string
  score: number
}

export interface LeaderboardPayload {
  board: string
  periodKey: string
  rows: LeaderboardRow[]
  me: { rank: number; score: number; sample: number; login: string } | null
  progress?: LeaderboardProgress | null
  previousWinner?: LeaderboardPreviousWinner | null
  gates: LeaderboardGates
  // 周期边界/封存时间：只对能被自然周/月 key 解析出边界的榜单出现——比赛
  // 详情页复用同一个响应形状，其 period_key（comp:<id>）解析不了边界，
  // 三个字段整段缺席，而不是 null。
  // Period bounds / seal time: present only for a board whose period key
  // resolves to natural week/month bounds — the competition detail page
  // reuses this same response shape, and its period_key (comp:<id>) has no
  // bounds to derive, so the three fields are absent entirely, not null.
  periodStart?: string
  periodEnd?: string
  sealAt?: string
  // 上次快照写入时间——快照为空（还没人上榜）时没有可取的时间，缺席。
  // When the snapshot was last written — absent when there are no rows to
  // take a time from (nobody has qualified yet).
  snapshotAt?: string
}

// 游戏化设置组（管理端，GET/PATCH /admin/gamification/settings）。
// Gamification settings group (admin, GET/PATCH /admin/gamification/settings).
export interface GamificationSettings {
  userVisible: boolean
  leaderboardVisible: boolean
  competitionsVisible: boolean
  minBaselineUsd: number
  // 两榜入榜笔数门槛（管理端可调，内测期放松、生产期收紧）。
  // Trade-count gates for the two boards (admin-adjustable; loose in beta,
  // strict in production).
  minTradesReturn: number
  minTradesWinrate: number
  // 胜率榜盈亏正闸：设计上是条原则（高胜率 ≠ 赚钱），2026-09-04 改成可配，默认关。
  // Win-rate profit gate: a principle by design (a high win rate isn't profit);
  // made configurable on 2026-09-04, default off.
  winrateRequireProfit: boolean
}

// PATCH /admin/gamification/settings 请求体：全部可选，只改传了的字段。
// PATCH /admin/gamification/settings request body: every field optional,
// only the ones actually sent change.
export interface GamificationSettingsPatch {
  userVisible?: boolean
  leaderboardVisible?: boolean
  competitionsVisible?: boolean
  minBaselineUsd?: number
  minTradesReturn?: number
  minTradesWinrate?: number
  winrateRequireProfit?: boolean
}

// 交易比赛（设计 §1.7/§1.8/§1.9，Phase 3）/ Trading competitions
// 计分指标：与排行榜同一套值域（后端 _METRICS 与 LEADERBOARD_BOARDS 完全一致），
// 复用 LeaderboardBoard 而不是另定义一遍同样的两个字面量。
// Scoring metric: the same value domain as the leaderboard (backend _METRICS
// matches LEADERBOARD_BOARDS exactly) — reuses LeaderboardBoard rather than
// redeclaring the same two literals.
export type CompetitionMetric = LeaderboardBoard
// 参赛方式：signup 报名制（用户在报名窗口内自选账户）/ auto 自动参赛（开赛时
// 全部达标实盘账户自动入场，退榜用户除外）。
// Enrollment mode: signup (user picks an account within the registration
// window) / auto (every qualifying real account is auto-enrolled at start,
// opted-out users excluded).
export type CompetitionEnrollment = 'signup' | 'auto'
// 状态只进不退：draft→upcoming→running→ended→settled。draft 对用户端一律
// 视同不存在（后端 404），只出现在管理端。
// Status only advances: draft→upcoming→running→ended→settled. draft is
// treated as nonexistent on the user-facing API (backend 404s it) and only
// ever appears on the admin side.
export type CompetitionStatus = 'draft' | 'upcoming' | 'running' | 'ended' | 'settled'

// 比赛概览（用户端 GET /competitions 的分组列表项，GET /competitions/{id} 详情
// 的基础字段）。startsAt/endsAt 理论上非 draft 比赛必填，但后端输出防御性地
// 允许 null，这里如实跟随。
// Competition summary (list-grouping item of the user-facing GET /competitions,
// and the base fields of GET /competitions/{id}). startsAt/endsAt are required
// for any non-draft competition in practice, but the backend's output is
// defensively nullable, so this follows suit.
// 参赛账户类型：real 只收实盘、demo 只收模拟/赛区。一场比赛只收一类。
// Account track: real takes live accounts only, demo takes demo/contest only.
// A competition takes one kind.
export type CompetitionTrack = 'real' | 'demo'

export interface CompetitionSummary {
  id: string
  name: string
  description: string | null
  metric: CompetitionMetric
  enrollment: CompetitionEnrollment
  status: CompetitionStatus
  // 参赛账户类型：报名选择器按它过滤（见 CompetitionsPage）。
  // Account track; the registration selector filters by it (see CompetitionsPage).
  track: CompetitionTrack
  regOpensAt: string | null
  regClosesAt: string | null
  startsAt: string | null
  endsAt: string | null
  prizeNote: string | null
}

// GET /competitions 的完整响应：非 draft 比赛按状态分组。
// Full response of GET /competitions: non-draft competitions grouped by status.
export interface CompetitionListGrouped {
  upcoming: CompetitionSummary[]
  running: CompetitionSummary[]
  finished: CompetitionSummary[]
}

// 当前用户在这场比赛下的一个参赛条目（GET /competitions/{id} 的 myEntries 项）。
// One of the current user's entries in this competition (an item of
// GET /competitions/{id}'s myEntries).
export interface CompetitionEntry {
  login: string
  scoringFrom: string | null
  finalRank: number | null
  finalScore: number | null
  disqualified: boolean
}

// GET /competitions/{id} 的完整响应：概览 + 实时榜（LeaderboardPayload 同一套
// 形状，行构造复用 gamification.build_board_rows_payload）+ 我的参赛条目 +
// 是否待终审（status=="ended"）。
// Full response of GET /competitions/{id}: summary + live board (same shape as
// LeaderboardPayload — the row construction is shared with
// gamification.build_board_rows_payload) + my entries + whether it's pending
// final settlement (status=="ended").
export interface CompetitionDetail extends CompetitionSummary {
  board: LeaderboardPayload
  myEntries: CompetitionEntry[]
  pendingSettle: boolean
}

// POST /competitions/{id}/register 的响应。 / response of POST /competitions/{id}/register
export interface CompetitionRegisterResult {
  login: string
  scoringFrom: string | null
}

// 管理端比赛行（GET/POST /admin/competitions、PATCH /admin/competitions/{id}
// 的响应）：概览字段之上多带 track（Phase 4 预留，恒为 "real"）、createdAt、
// participantCount。autoEnrolled 只在这次 PATCH 把状态推进到 running 且
// enrollment=="auto" 时才出现——展示"这次自动拉入了几个账户"。
// Admin competition row (response of GET/POST /admin/competitions and
// PATCH /admin/competitions/{id}): adds track (reserved for Phase 4, always
// "real"), createdAt, participantCount on top of the summary fields.
// autoEnrolled appears only when this PATCH advanced status to running with
// enrollment=="auto" — how many accounts were just auto-enrolled.
export interface CompetitionAdminRow extends CompetitionSummary {
  track: CompetitionTrack
  // 本场专属门槛；null = 跟随管理端「游戏化」页签的全局设置。
  // This competition's own gates; null = follow the global settings on the admin
  // Gamification tab.
  minBaselineUsd: number | null
  minTrades: number | null
  createdAt: string | null
  participantCount: number
  autoEnrolled?: number
}

// POST /admin/competitions 请求体。startsAt/endsAt 必填，其余按管理端表单可选。
// POST /admin/competitions request body. startsAt/endsAt are required; the
// rest follow the admin form's optionality.
export interface CompetitionCreate {
  name: string
  description?: string | null
  metric: CompetitionMetric
  enrollment: CompetitionEnrollment
  regOpensAt?: string | null
  regClosesAt?: string | null
  startsAt: string
  endsAt: string
  prizeNote?: string | null
  track?: CompetitionTrack
  // 省略 = 跟随全局；显式 null（仅 PATCH）= 改回跟随全局。
  // Omitted = follow the global settings; an explicit null (PATCH only) = go back
  // to following them.
  minBaselineUsd?: number | null
  minTrades?: number | null
}

// PATCH /admin/competitions/{id} 请求体：全部可选，只改传了的字段——draft 状态
// 下全字段可改，非 draft 状态下后端只接受文案与报名窗口字段（其余出现即 400），
// status 走单独的相邻推进校验。这些约束由后端强制，此处仅描述字段形状。
// PATCH /admin/competitions/{id} request body: every field optional, only the
// ones sent change. In draft, every field is editable; once non-draft the
// backend accepts only copy + registration-window fields (anything else 400s),
// and status follows its own adjacent-advance check. Those constraints are
// enforced server-side; this only describes the field shapes.
export interface CompetitionPatch {
  name?: string
  description?: string | null
  metric?: CompetitionMetric
  enrollment?: CompetitionEnrollment
  regOpensAt?: string | null
  regClosesAt?: string | null
  startsAt?: string
  endsAt?: string
  prizeNote?: string | null
  status?: CompetitionStatus
  track?: CompetitionTrack
  minBaselineUsd?: number | null
  minTrades?: number | null
}

// GET /admin/competitions/{id}/participants 的一行、PATCH 参赛条目的响应。
// One row of GET /admin/competitions/{id}/participants, and the response of
// PATCHing a participant.
export interface ParticipantAdminRow {
  id: string
  userId: string
  email: string | null
  login: string
  registeredAt: string | null
  scoringFrom: string | null
  finalScore: number | null
  finalRank: number | null
  disqualified: boolean
  disqualifyReason: string | null
}

// PATCH /admin/competitions/{id}/participants/{pid} 请求体：取消/恢复资格。
// disqualifyReason 仅在 disqualified=true 时落库，恢复资格（false）时后端
// 自动清空，不必显式传 null。
// PATCH /admin/competitions/{id}/participants/{pid} request body:
// disqualify/restore. disqualifyReason is only stored when disqualified is
// true; restoring (false) clears it server-side automatically, no need to
// pass null explicitly.
export interface ParticipantPatch {
  disqualified: boolean
  disqualifyReason?: string | null
}

// POST /admin/competitions/{id}/settle 的响应。badgeErrors 非空不代表终审本身
// 失败——名次与 status 已在此前一次独立 commit 中落定，只是某枚勋章发放失败
// （可人工补发，幂等）。
// Response of POST /admin/competitions/{id}/settle. A non-empty badgeErrors
// does not mean settlement itself failed — ranks and status were already
// committed in a prior, separate commit; only a badge award failed (can be
// re-granted manually, idempotently).
export interface CompetitionSettleResult {
  ranked: number
  badges: Array<{ userId: string; badgeId: string }>
  badgeErrors: Array<{ userId: string; badgeId: string; error: string }>
}
