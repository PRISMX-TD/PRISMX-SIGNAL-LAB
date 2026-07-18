// REST 客户端封装 / REST client wrapper
import type { Signal, Order, User, MT5Account, Trend, SignalDailyCount, SignalWinRate, PersonalWinRate, DisciplineScore, ClosedTrade, AdminUser, AdminMetrics, AdminPricingSettings, AdminTrialSettings, AdminDisciplineSettings, AdminCandleSettings, AdminStrategySettings, TrialStatus, SimulateResult, UserRole, UserPlan, BrokerLock, AdminBrokerSettings, AutoManageSettings, Candle, SentimentRatio, Quote, StrategyTemplateSchemas, UserStrategy, StrategyBacktestResult, StrategySignal, StrategyTemplateKey, StopLossMethod, TakeProfitMethod } from './types'

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
// 主动触发未授权处理（如 WebSocket 鉴权失败时）/ trigger the unauthorized flow manually.
export function triggerUnauthorized() {
  clearToken()
  onUnauthorized?.()
}

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
      detail = body.detail || detail
    } catch {
      /* ignore */
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
  history: (symbol: string, interval: string, limit = 500) =>
    request<{ symbol: string; interval: string; bars: Candle[] }>(
      `/chart/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`
    ),
  latest: (symbol: string, interval: string) =>
    request<{ bars: Candle[]; updatedAt: number | null }>(
      `/chart/latest?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`
    ),
}

// 下单 / Orders
export const orderApi = {
  // 不传参数时行为不变(最新 100 条),供 useLive() 的实时订单跟踪继续用；
  // 传 limit/offset/since/until 时用于订单页的分页与日期筛选浏览历史。
  // Unparameterized behavior is unchanged (latest 100), used by useLive()'s
  // real-time order tracking; pass limit/offset/since/until for the Orders
  // page's paginated, date-filtered history browsing.
  list: (params: { limit?: number; offset?: number; since?: string; until?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.offset) qs.set('offset', String(params.offset))
    if (params.since) qs.set('since', params.since)
    if (params.until) qs.set('until', params.until)
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

// 自定义策略：模板选好参数 → 回测 → 启用 → 触发个人信号 → 一键下单
// Custom strategies: pick a template, tune it, backtest, enable, get
// personal signals on trigger, one-click order
export const strategyApi = {
  templates: () => request<{ templates: StrategyTemplateSchemas }>('/strategies/templates'),
  list: () => request<{ strategies: UserStrategy[] }>('/strategies'),
  create: (payload: {
    template: StrategyTemplateKey
    name?: string | null
    symbol: string
    interval: string
    params: Record<string, string | number>
    stopLossMethod: StopLossMethod
    stopLossValue: number
    takeProfitMethod: TakeProfitMethod
    takeProfitValue: number
  }) => request<UserStrategy>('/strategies', { method: 'POST', body: JSON.stringify(payload) }),
  update: (
    id: string,
    payload: Partial<{
      name: string | null
      params: Record<string, string | number>
      stopLossMethod: StopLossMethod
      stopLossValue: number
      takeProfitMethod: TakeProfitMethod
      takeProfitValue: number
      enabled: boolean
    }>
  ) => request<UserStrategy>(`/strategies/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  remove: (id: string) => request<{ ok: boolean }>(`/strategies/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  backtest: (payload: {
    template: StrategyTemplateKey
    symbol: string
    interval: string
    params: Record<string, string | number>
    stopLossMethod: StopLossMethod
    stopLossValue: number
    takeProfitMethod: TakeProfitMethod
    takeProfitValue: number
    days: number
    riskPct: number
    capital: number
    mode: 'compound' | 'flat'
  }) => request<StrategyBacktestResult>('/strategies/backtest', { method: 'POST', body: JSON.stringify(payload) }),
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
  changePassword: (oldPassword: string | null, newPassword: string) =>
    request<{ ok: boolean }>('/auth/password', {
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

// 管理后台 / Admin
export const adminApi = {
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
}
