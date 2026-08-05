// REST 客户端封装 / REST client wrapper
import type { Signal, Order, User, MT5Account, Trend, SignalDailyCount, SignalWinRate, PersonalWinRate, DisciplineScore, ClosedTrade, AdminUser, AdminMetrics, AdminPageStats, AdminPricingSettings, AdminTrialSettings, AdminDisciplineSettings, AdminCandleSettings, AdminStrategySettings, TrialStatus, SimulateResult, UserRole, UserPlan, BrokerLock, AdminBrokerSettings, AutoManageSettings, Candle, SentimentRatio, Quote, StrategyPresets, UserStrategy, StrategyBacktestResult, StrategySignal, StrategyTemplateKey, StopLossMethod, TakeProfitMethod, StrategyCoverageResponse, StrategyPerformance, StrategySessionFilter, Ticket, TicketListItem, TicketCategory, TicketPriority, TicketStatus } from './types'
import type { ConditionPayload, UsageCatalog } from '../components/strategies/conditionTypes'

const TOKEN_KEY = 'prismx_token'

// API 基础地址：生产用 VITE_API_BASE 指向线上后端，开发留空走 Vite 代理。
// API base: prod uses VITE_API_BASE to point at the deployed backend; dev leaves it empty to use the Vite proxy.
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

// 未授权（401）回调：登录态过期时由 AuthProvider 注册，用于清状态并跳登录页。
// Unauthorized (401) callback: registered by AuthProvider to clear state and redirect.
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}
// 限流（429）的兜底文案。写成后端惯用的「中文 / English」双语格式，
// localizeApiError 会按界面语言取对应那半，不必单独走 i18n。
// Fallback message for rate limiting (429). Written in the backend's usual
// "中文 / English" bilingual shape so localizeApiError picks the right half by UI
// language, with no separate i18n plumbing needed.
const RATE_LIMITED =
  '操作过于频繁，已被限流，请稍等一分钟再试 / Too many requests, you have been rate limited — wait a minute and try again'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${API_BASE}/api${path}`, { ...options, headers })
  // 滑动续期：后端在 token 剩余有效期不足一半时经此头下发新 token，
  // 静默替换本地 token，活跃用户不再每天被踢回登录页。
  // Sliding renewal: the backend issues a fresh token via this header when the
  // current one is past half-life; swap it in silently so active users never
  // get kicked back to the login page.
  const refreshed = res.headers.get('X-Refreshed-Token')
  if (refreshed) setToken(refreshed)
  if (!res.ok) {
    // 凭证失效：清除登录态并通知上层跳转登录页。
    // Token expired/invalid: clear auth state and notify the app to redirect.
    if (res.status === 401) {
      clearToken()
      onUnauthorized?.()
    }
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      // slowapi 的限流响应把说明放在 error 字段、没有 detail，落到下面的分支就只剩
      // "HTTP 429" 这种对用户毫无意义的字符串。这里给 429 一个兜底标记，交给
      // localizeApiError 换成能看懂的说明；后端自己抛的 429（比如「已有回测在跑」）
      // 带 detail，仍走下面的分支、保留原文案。
      // slowapi's rate-limit response puts its message in `error` with no
      // `detail`, so the branches below would leave the useless string "HTTP 429".
      // Tag such responses so localizeApiError can turn them into something
      // readable; backend-raised 429s (e.g. "a backtest is already running") do
      // carry `detail` and keep their own wording via the branches below.
      if (res.status === 429 && !body.detail) detail = RATE_LIMITED
      // FastAPI 的字段校验错误（422）里 detail 是一个对象数组（{loc,msg,type}...），
      // 直接当字符串抛会显示成 "[object Object]"。这里把它拍平成可读的 msg 文本；
      // 普通业务错误的 detail 本就是字符串，原样使用。
      // FastAPI's field-validation errors (422) put an array of objects in
      // detail ({loc,msg,type}...); throwing that as-is renders "[object
      // Object]". Flatten it to readable msg text; ordinary business errors
      // already carry a string detail and are used as-is.
      if (Array.isArray(body.detail)) {
        const msgs = body.detail
          .map((e: unknown) =>
            e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : String(e)
          )
          .filter(Boolean)
        detail = msgs.join('; ') || detail
      } else if (body.detail) {
        detail = body.detail
      }
    } catch {
      // 响应体不是 JSON（网关直接挡掉的限流常是纯文本或空体）。429 在这里也要给出
      // 说明，否则又退回 "HTTP 429"。
      // Body wasn't JSON (rate limiting blocked at the gateway often returns plain
      // text or nothing). 429 still needs its message here, or we fall back to the
      // bare "HTTP 429" again.
      if (res.status === 429) detail = RATE_LIMITED
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

// 认证 / Auth
export const authApi = {
  register: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  google: (credential: string) =>
    request<{ token: string; user: User }>('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }),
}

// 信号 / Signals
export const signalApi = {
  list: () => request<{ signals: Signal[] }>('/signals'),
  stats: () => request<{ daily: SignalDailyCount[]; total: number }>('/signals/stats'),
  winrate: () => request<SignalWinRate>('/signals/winrate'),
}

// 历史信号回放（模拟器）：**当前仅管理员可调**（后端 require_admin），
// 非管理员会拿到 403——功能先内部试用，入口也只对管理员显示。
// Historical signal replay: **admin-only for now** (backend require_admin);
// non-admins get a 403. The feature is in internal trial and its entry points
// are likewise admin-gated.
export const simulateApi = {
  run: (params: { days: number; risk: number; capital: number; mode: 'compound' | 'flat' }) =>
    request<SimulateResult>(
      `/signals/simulate?days=${params.days}&risk=${params.risk}&capital=${params.capital}&mode=${params.mode}`
    ),
}

// 多周期趋势 / Multi-timeframe trends
export const trendApi = {
  list: () => request<{ trends: Trend[] }>('/trends'),
}

// 全站统一报价快照（EA 推送，不区分用户/账户；首屏用，之后靠 WS GLOBAL_QUOTES 增量）
// Site-wide quote snapshot (EA-pushed, not user/account-scoped); first load,
// WS GLOBAL_QUOTES delivers deltas afterwards
export const quoteApi = {
  list: () => request<{ quotes: Quote[] }>('/quotes'),
}

// 当前活跃品种：EA 的 InpSymbols 实际在推什么，就返回什么，不是写死的列表。
// 报价表/图表选择器/仪表盘英雄板都应以此为准渲染。
// Currently active symbols: whatever the EA's InpSymbols is actually
// pushing, not a hardcoded list. The quotes table / chart symbol picker /
// dashboard hero should all render from this.
export const symbolApi = {
  list: () => request<{ symbols: string[] }>('/symbols'),
}

// 行情 K 线（自建中央 MT5 喂价源，取代 TradingView Widget）
// Chart candles from the self-hosted central MT5 feed (replaces the TradingView widget)
export const chartApi = {
  // before 是往更早翻页的游标：传当前最早那根的 t，拿到它之前的一页。
  // hasMore 为 false 表示数据库里没有更早的了，前端可以停止继续请求。
  // `before` is the cursor for paging backwards: pass the earliest bar's `t` to
  // get the page before it. hasMore=false means the database holds nothing
  // earlier, so the client can stop asking.
  history: (symbol: string, interval: string, limit = 1000, before?: number) =>
    request<{ symbol: string; interval: string; bars: Candle[]; hasMore: boolean }>(
      `/chart/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}` +
        (before !== undefined ? `&before=${before}` : '')
    ),
  latest: (symbol: string, interval: string) =>
    request<{ bars: Candle[]; updatedAt: number | null }>(
      `/chart/latest?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`
    ),
}

// 下单 / Orders
export const orderApi = {
  // 不传参数时行为不变(最新 100 条),供 useLive() 的实时订单跟踪继续用；
  // 传 limit/offset/since/until/login 时用于订单页的分页、日期与账号筛选。
  // login 交给后端在 SQL 里过滤，这样 total 和页码与筛选结果一致。
  // Unparameterized behavior is unchanged (latest 100), used by useLive()'s
  // real-time order tracking; pass limit/offset/since/until/login for the
  // Orders page's paginated, date- and account-filtered history browsing.
  // login is filtered server-side in SQL so total and page numbers match the
  // filtered set.
  list: (params: { limit?: number; offset?: number; since?: string; until?: string; login?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.offset) qs.set('offset', String(params.offset))
    if (params.since) qs.set('since', params.since)
    if (params.until) qs.set('until', params.until)
    if (params.login) qs.set('login', params.login)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<{ orders: Order[]; total: number }>(`/orders${suffix}`)
  },
  place: (payload: {
    signalId: string | null
    symbol: string
    side: 'BUY' | 'SELL'
    volume: number
    clientOrderId: string
    mt5Login?: string | null
    stopLoss?: number | null
    takeProfit?: number | null
  }) =>
    request<Order>('/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  close: (payload: {
    clientOrderId: string
    ticket: number
    symbol: string
    side: 'BUY' | 'SELL'
    mt5Login?: string | null
    volume?: number | null
  }) =>
    request<Order>('/orders/close', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  modify: (payload: {
    clientOrderId: string
    ticket: number
    symbol: string
    side: 'BUY' | 'SELL'
    mt5Login?: string | null
    stopLoss: number
    takeProfit: number
  }) =>
    request<Order>('/orders/modify', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  cancel: (id: string) => request<Order>(`/orders/${id}/cancel`, { method: 'POST' }),
  // login：只看这一个账号（订单页的账号标签）；不传则统计当前仍绑定的全部账号。
  // login: narrow to one account (the Orders page's account tab); omitted scopes to all currently-bound accounts.
  winrate: (login?: string) =>
    request<PersonalWinRate>(`/orders/winrate${login ? `?login=${encodeURIComponent(login)}` : ''}`),
  closedTrades: () => request<{ trades: ClosedTrade[] }>('/orders/closed-trades'),
  // 纪律分：对所有登录用户开放，FREE/PRO 的明细裁剪见 api/types.ts 的 DisciplineScore 注释。
  // Discipline score: open to all logged-in users; FREE/PRO detail gating is
  // described in api/types.ts's DisciplineScore comment.
  discipline: (login?: string) =>
    request<DisciplineScore>(`/orders/discipline${login ? `?login=${encodeURIComponent(login)}` : ''}`),
}

// 自定义策略：挑条件 → 查数据覆盖 → 回测 → 启用 → 触发个人信号 → 一键下单
// Custom strategies: pick conditions, check data coverage, backtest, enable, get
// personal signals on trigger, one-click order
export const strategyApi = {
  // 六条新手预设的逻辑与条件列表，不含品种周期（用户自己选）。
  // The six beginner presets' logic and condition lists, without symbol/interval
  // (the user picks those).
  templates: () => request<{ presets: StrategyPresets }>('/strategies/templates'),
  // 指标与用法目录：参数规格、取值范围、镜像关系。指标选择器与参数表单完全由它
  // 驱动，前端不带副本——两边各存一份的话，加一个用法就得改两处。
  // The indicator/usage catalogue: param specs, ranges and mirrors. It drives the
  // indicator picker and param forms entirely; the frontend keeps no copy, since
  // two copies mean adding a usage takes two edits.
  usages: () => request<UsageCatalog>('/strategies/usages'),
  list: () => request<{ strategies: UserStrategy[] }>('/strategies'),
  // 不传参即查"当前有报价的全部品种 × 六档周期"。回测之前调用，用来显示实际
  // 可用范围并把未接入品种置灰。
  // With no arguments this covers every currently quoted symbol across all six
  // intervals. Called before a backtest to show the actual available range and
  // grey out unfed symbols.
  coverage: (symbols?: string[], intervals?: string[]) => {
    const qs = new URLSearchParams()
    if (symbols?.length) qs.set('symbols', symbols.join(','))
    if (intervals?.length) qs.set('intervals', intervals.join(','))
    const suffix = qs.toString()
    return request<StrategyCoverageResponse>(`/strategies/coverage${suffix ? `?${suffix}` : ''}`)
  },
  // 策略编辑器的候选品种。与 coverage() 分开是因为首屏只要名单：coverage 不传参
  // 会对每个 (品种, 周期) 组合各算一行，代价随历史累积增长，而它返回的统计字段
  // 首屏一个都不读。
  // Candidate symbols for the strategy editor. Separate from coverage() because
  // the first paint only needs names: an argument-less coverage computes a row
  // per (symbol, interval) pair, growing as history accrues, and the first paint
  // reads none of the statistics it returns.
  symbolsWithHistory: () =>
    request<{ symbols: string[]; activeSymbols: string[] }>('/strategies/symbols'),
  // rules 与 template 二选一：给了 rules 就按它建，只给 template 则后端填该预设的
  // 条件。rules 里的 symbol / interval 必须与顶层的一致，否则 400。
  // Either rules or template: with rules it's built from them, with only a
  // template the backend fills in that preset's conditions. The symbol/interval
  // inside rules must equal the top-level ones or it's a 400.
  create: (payload: {
    template?: StrategyTemplateKey | null
    name?: string | null
    rules?: ConditionPayload
    symbol: string
    interval: string
    stopLossMethod: StopLossMethod
    stopLossValue: number
    takeProfitMethod: TakeProfitMethod
    takeProfitValue: number
    oneTradeAtATime: boolean
    exitTimeoutBars?: number | null
    sessionFilter?: StrategySessionFilter | null
    dailySignalCap?: number | null
    cooldownMinutes?: number | null
  }) => request<UserStrategy>('/strategies', { method: 'POST', body: JSON.stringify(payload) }),
  update: (
    id: string,
    payload: Partial<{
      name: string | null
      rules: ConditionPayload
      symbol: string
      interval: string
      stopLossMethod: StopLossMethod
      stopLossValue: number
      takeProfitMethod: TakeProfitMethod
      takeProfitValue: number
      oneTradeAtATime: boolean
      exitTimeoutBars: number | null
      sessionFilter: StrategySessionFilter | null
      dailySignalCap: number | null
      cooldownMinutes: number | null
      enabled: boolean
    }>
  ) => request<UserStrategy>(`/strategies/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  remove: (id: string) => request<{ ok: boolean }>(`/strategies/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 回测的 symbol / interval 与策略本身一致，单独传是因为回测不必先存策略——
  // 草稿状态就能试。
  // The backtest's symbol/interval match the strategy's own; they're passed
  // separately because a backtest doesn't require saving first — a draft can be
  // tried as-is.
  backtest: (payload: {
    template?: StrategyTemplateKey | null
    rules?: ConditionPayload
    symbol: string
    interval: string
    stopLossMethod: StopLossMethod
    stopLossValue: number
    takeProfitMethod: TakeProfitMethod
    takeProfitValue: number
    oneTradeAtATime: boolean
    exitTimeoutBars?: number | null
    days: number
    riskPct: number
    capital: number
    mode: 'compound' | 'flat'
  }) => request<StrategyBacktestResult>('/strategies/backtest', { method: 'POST', body: JSON.stringify(payload) }),
  // 回测图的 K 线。必须用这条而不是 chartApi.history：后者读的是内存缓存（最近
  // 500 根），与回测按 days 窗口从 Candle 表取的那一段范围不同，交易标记会大量
  // 落在蜡烛范围之外——这条与回测在后端共用同一个取数函数。
  // Candles for the backtest chart. Must be this and not chartApi.history: that
  // one reads the in-memory cache (newest 500 bars), a different range than the
  // `days` window the backtest pulls from the Candle table, leaving most trade
  // markers outside the charted candles. This shares the backend's single
  // bar-loading function with the backtest itself.
  backtestBars: (symbol: string, interval: string, days: number) =>
    request<{ symbol: string; interval: string; days: number; bars: Candle[] }>(
      `/strategies/backtest/bars?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&days=${days}`
    ),
  // 单个策略的绩效。回测面板用它与刚跑完的回测并排对比，那里只关心当前这一条。
  // One strategy's performance. The backtest panel uses this to sit beside the
  // run it just made, where only the current strategy matters.
  performance: (id: string) =>
    request<StrategyPerformance>(`/strategies/${encodeURIComponent(id)}/performance`),
  // 全部策略的绩效，一次取回。策略列表要的是"每张卡片都有绩效"，逐个调
  // performance(id) 会让请求数随策略数线性增长。
  // Every strategy's performance in one call. The list needs a figure on each
  // card, and calling performance(id) per strategy grows the request count
  // linearly with the number of strategies.
  allPerformance: () =>
    request<{ performance: StrategyPerformance[] }>('/strategies/performance'),
  signals: (limit = 50) => request<{ signals: StrategySignal[] }>(`/strategies/signals?limit=${limit}`),
  clearSignals: () => request<{ ok: boolean }>('/strategies/signals', { method: 'DELETE' }),
}

// 多账号 / Multi-account
export const accountApi = {
  // accountLimit：当前订阅等级最多可连接的账户数，null 表示不限；brokerLock：合作券商限制展示信息
  // accountLimit: max accounts for the current plan (null = unlimited); brokerLock: partner-broker lock info
  list: () => request<{ accounts: MT5Account[]; accountLimit: number | null; brokerLock: BrokerLock }>('/bridge/accounts'),
  setSuffix: (login: string, symbolSuffix: string) =>
    request<{ ok: boolean; login: string; symbolSuffix: string }>('/bridge/accounts/suffix', {
      method: 'POST',
      body: JSON.stringify({ login, symbolSuffix }),
    }),
  remove: (login: string, server?: string | null) =>
    request<{ ok: boolean }>(
      `/bridge/accounts/${encodeURIComponent(login)}${server ? `?server=${encodeURIComponent(server)}` : ''}`,
      { method: 'DELETE' }
    ),
}

// Bridge 版本状态：该用户最近上报的版本 + 当前最新发布版本，用于"有新版本
// 可更新"提示。current 为 null 表示该用户从未连过带版本号上报的 Bridge。
// Bridge version status: this user's most recently reported version + the
// current latest release, for the "a newer version is available" notice.
// current is null if this user has never connected a version-reporting Bridge.
export const bridgeVersionApi = {
  status: () => request<{ current: string | null; latest: string | null; downloadUrl: string | null }>('/bridge/version-status'),
}

// API Token（连接 MT5 用）：库中只存哈希，明文仅在重置（生成）响应中出现一次。
// API token for connecting MT5: only the hash is stored; the plaintext
// appears once in the reset (generation) response.
export const eaApi = {
  getToken: () => request<{ apiToken: string | null; boundAccount: string | null }>('/ea/token'),
  resetToken: () => request<{ apiToken: string }>('/ea/token/reset', { method: 'POST' }),
}

// Gateway API（Make Capital 用户通过 Gateway 连接 MT5，无需本地 Bridge）
// Gateway API for Make Capital users — no local Bridge required
export const gatewayApi = {
  verify: (login: number, password: string, investorOnly?: boolean) =>
    request<{
      ok: boolean; valid: boolean; retcode: string
      login: number; name: string; group: string
      leverage: number; balance: number; equity: number
    }>('/gateway/verify', {
      method: 'POST',
      body: JSON.stringify({ login, password, investorOnly: investorOnly ?? false }),
    }),
  list: () =>
    request<{ accounts: Array<{ login: string; source: string; accountName: string; balance: number; equity: number; leverage: number }> }>('/gateway/accounts'),
  refresh: (login: string) =>
    request<{ login: string; balance: number; equity: number }>(`/gateway/account/${login}/refresh`, { method: 'POST' }),
  remove: (login: string) =>
    request<{ ok: boolean }>(`/gateway/account/${login}`, { method: 'DELETE' }),
}

// 账户信息 / User account (profile, password)
export const userApi = {
  me: () =>
    request<{
      id: string
      email: string
      plan: UserPlan
      planExpiresAt: string | null
      // 当前 PRO 是否为免费试用（区别于正式付费/管理员赠送）
      // whether the current PRO is a free trial (vs. paid or admin-granted)
      planIsTrial: boolean
      hasPassword: boolean
      createdAt: string | null
      mt5Accounts: Array<{
        login: string
        server: string | null
        accountName: string | null
        accountCurrency: string | null
        balance: number | null
        equity: number | null
        leverage: number | null
        company: string | null
        online: boolean
      }>
    }>('/auth/me'),
  // 后端会在改密时让所有旧 token 失效（见 account.py 的说明），并随响应
  // 带回一个已盖新会话版本号的 token——调用方必须用它替换本地 token，
  // 否则这次请求自己带的旧 token 也已失效，下一个请求会被 401 踢出登录。
  // The backend invalidates every old token on a password change (see
  // account.py's docstring) and returns a freshly stamped one in the
  // response — callers must swap it into local storage, or even this
  // request's own (now-invalidated) token will 401 on the very next call.
  changePassword: (oldPassword: string | null, newPassword: string) =>
    request<{ ok: boolean; token: string }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    }),
  // 跨设备同步的界面偏好 / cross-device UI prefs
  getPrefs: () => request<{ data: Record<string, unknown> }>('/auth/prefs'),
  // 只传发生变化的那一个命名空间，服务端合并进已存文档（不再整份覆盖），
  // 返回/推送的都是合并后的完整文档。见后端 account.py 的 UserPrefsIn 说明。
  // Only the namespace that changed; the server merges it into the stored
  // document (no longer a full overwrite); the response/push both carry the
  // merged, complete document. See the backend's UserPrefsIn docstring.
  putPrefs: (namespace: string, data: Record<string, unknown>) =>
    request<{ data: Record<string, unknown> }>('/auth/prefs', {
      method: 'PUT',
      body: JSON.stringify({ namespace, data }),
    }),
}

// 通知 / Notifications
export const notificationApi = {
  getPrefs: () =>
    request<{
      enabled: boolean
      selected_categories: string[]
      selected_symbols: string[]
      event_types: string[]
    }>('/notifications/prefs'),
  // eventTypes：账户/交易事件白名单（订单成交/拒绝、自动仓管触发、Bridge 掉线），
  // 与 selectedCategories/selectedSymbols（信号策略类别·品种白名单）是独立设置——
  // 后两者按"与"关系联合过滤同一条信号推送。
  // eventTypes: account/trading event whitelist (order fill/reject, auto-manage
  // trigger, bridge offline) — independent from selectedCategories/selectedSymbols
  // (the signal strategy-category & symbol whitelists, ANDed together to gate the
  // same signal push).
  putPrefs: (
    enabled: boolean,
    selectedCategories: string[],
    eventTypes: string[] = [],
    selectedSymbols: string[] = [],
  ) =>
    request<{
      enabled: boolean
      selected_categories: string[]
      selected_symbols: string[]
      event_types: string[]
    }>('/notifications/prefs', {
      method: 'PUT',
      body: JSON.stringify({
        enabled,
        selected_categories: selectedCategories,
        selected_symbols: selectedSymbols,
        event_types: eventTypes,
      }),
    }),
  getIndicators: () => request<string[]>('/notifications/indicators'),
  getSymbols: () => request<string[]>('/notifications/symbols'),
}

// 工单 / Tickets
export const ticketApi = {
  list: () => request<TicketListItem[]>('/tickets'),
  get: (id: string) => request<Ticket>(`/tickets/${encodeURIComponent(id)}`),
  // 用户不设优先级：后端默认 normal，之后由管理员在后台判定。
  // Users don't set priority: the backend defaults to normal and admins triage it later.
  create: (payload: { title: string; category: TicketCategory; body: string }) =>
    request<Ticket>('/tickets', { method: 'POST', body: JSON.stringify(payload) }),
  reply: (id: string, body: string, reopen = false) =>
    request<Ticket>(`/tickets/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body, reopen }),
    }),
}

// 管理后台 / Admin
export const adminApi = {
  pageStats: (days = 7) => request<AdminPageStats>(`/admin/page-stats?days=${days}`),
  listUsers: (params: { q?: string; plan?: string; role?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    if (params.plan) qs.set('plan', params.plan)
    if (params.role) qs.set('role', params.role)
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.offset) qs.set('offset', String(params.offset))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<{ users: AdminUser[]; total: number; limit: number; offset: number }>(`/admin/users${suffix}`)
  },
  updateUser: (
    userId: string,
    payload: Partial<{ role: UserRole; plan: UserPlan; planExpiresAt: string | null; planNote: string | null }>
  ) =>
    request<AdminUser>(`/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  bulkUpdateUsers: (
    userIds: string[],
    payload: Partial<{ role: UserRole; plan: UserPlan; planExpiresAt: string | null; planNote: string | null }>
  ) =>
    request<{ updated: number }>('/admin/users/bulk', {
      method: 'PATCH',
      body: JSON.stringify({ userIds, ...payload }),
    }),
  metrics: () => request<AdminMetrics>('/admin/metrics'),
  getSettings: () => request<AdminBrokerSettings>('/admin/settings'),
  updateSettings: (payload: AdminBrokerSettings) =>
      request<AdminBrokerSettings>('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getPricing: () => request<AdminPricingSettings>('/admin/pricing'),
    updatePricing: (payload: AdminPricingSettings) =>
      request<AdminPricingSettings>('/admin/pricing', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getTrial: () => request<AdminTrialSettings>('/admin/trial'),
    updateTrial: (payload: AdminTrialSettings) =>
      request<AdminTrialSettings>('/admin/trial', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getDiscipline: () => request<AdminDisciplineSettings>('/admin/discipline'),
    updateDiscipline: (payload: AdminDisciplineSettings) =>
      request<AdminDisciplineSettings>('/admin/discipline', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getCandleHistory: () => request<AdminCandleSettings>('/admin/candle-history'),
    updateCandleHistory: (payload: AdminCandleSettings) =>
      request<AdminCandleSettings>('/admin/candle-history', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getStrategySettings: () => request<AdminStrategySettings>('/admin/strategy-settings'),
    updateStrategySettings: (payload: AdminStrategySettings) =>
      request<AdminStrategySettings>('/admin/strategy-settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    // ---- 工单管理 / Ticket management ----
    listTickets: (params: { status?: string; category?: string; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams()
      if (params.status) qs.set('status', params.status)
      if (params.category) qs.set('category', params.category)
      if (params.limit) qs.set('limit', String(params.limit))
      if (params.offset) qs.set('offset', String(params.offset))
      const suffix = qs.toString() ? `?${qs.toString()}` : ''
      return request<TicketListItem[]>(`/admin/tickets${suffix}`)
    },
    getTicket: (id: string) => request<Ticket>(`/admin/tickets/${encodeURIComponent(id)}`),
    replyTicket: (id: string, body: string, opts?: { status?: TicketStatus; priority?: TicketPriority }) =>
      request<Ticket>(`/admin/tickets/${encodeURIComponent(id)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body, ...opts }),
      }),
    updateTicket: (id: string, patch: { status?: TicketStatus; priority?: TicketPriority }) =>
      request<Ticket>(`/admin/tickets/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
  }

// 自动仓位管理（PRO）/ auto position management (PRO)
export const automationApi = {
  getSettings: () => request<AutoManageSettings>('/automation/settings'),
  putSettings: (payload: AutoManageSettings) =>
    request<AutoManageSettings>('/automation/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
}

// 社区多空情绪：读后端缓存（数据源见后端 sentiment_store.py 说明）
// Community sentiment: reads the backend's cache (data source documented in
// the backend's sentiment_store.py)
export const sentimentApi = {
  get: () =>
    request<{ sentiment: Record<string, SentimentRatio>; updatedAt: number | null; stale: boolean }>(
      '/sentiment'
    ),
}

// 支付（NOWPayments 加密货币）/ Payments (NOWPayments crypto)
export const paymentApi = {
  getPlans: () =>
    request<{
      plans: Array<{ id: string; name: string; price_usd: number; original_price_usd?: number | null; days: number; tag?: string }>
      sale?: { percent: number; badge: string; end_at: string; monthly: number; yearly: number } | null
    }>('/payments/plans'),
  getCurrencies: () => request<{ currencies: string[] }>('/payments/currencies'),
  create: (plan: string, payCurrency: string) =>
    request<{
      id: string
      payment_id: string
      pay_address: string
      pay_amount: number
      pay_currency: string
      amount_usd: number
      plan: string
      status: string
      created_at: string
      valid_until: string | null
    }>('/payments/create', {
      method: 'POST',
      body: JSON.stringify({ plan, pay_currency: payCurrency }),
    }),
  status: (paymentId: string) =>
    request<{
      id: string
      payment_id: string
      pay_address: string
      pay_amount: number
      pay_currency: string
      amount_usd: number
      plan: string
      status: string
      // NOWPayments 报告的实际到账金额（同 pay_currency 计价）；null 表示
      // 尚无数据或从未同步过。低于 pay_amount 说明用户少转了。
      // Actual amount received (same currency as pay_currency), as reported
      // by NOWPayments; null means no data yet / never synced. Less than
      // pay_amount means the user under-sent.
      actually_paid: number | null
      finished_at: string | null
      created_at: string
    }>(`/payments/status/${paymentId}`),
  getTrial: () => request<TrialStatus>('/payments/trial'),
  claimTrial: () =>
    request<{ ok: boolean; planExpiresAt: string; days: number }>('/payments/trial/claim', {
      method: 'POST',
    }),
}

// 推送订阅 / Push subscriptions
export const pushApi = {
  getVapidKey: () => request<{ publicKey: string }>('/notifications/push/vapid-public-key'),
  subscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    request<{ ok: boolean }>('/notifications/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint, keys }),
    }),
  unsubscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    request<{ ok: boolean }>('/notifications/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint, keys }),
    }),
  // 诊断用：后端记录了几个订阅、其中是否包含本设备当前的 endpoint。
  // "浏览器里有订阅"与"后端收到了订阅"是两件事，分开查才能定位上报环节的问题。
  // Diagnostics: how many subscriptions the backend holds and whether this
  // device's current endpoint is among them. "The browser has a subscription"
  // and "the backend received it" are different things; querying them
  // separately is what pinpoints a broken reporting step.
  getStatus: (endpoint?: string) =>
    request<{ count: number; current_endpoint_registered: boolean }>(
      `/notifications/push/status${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`,
    ),
  // 给本账号所有设备发一条测试通知，端到端验证链路。
  // Send one test notification to every device on the account — end-to-end check.
  sendTest: () =>
    request<{ sent: number; failed: number; pruned: number }>('/notifications/push/test', {
      method: 'POST',
    }),
}
