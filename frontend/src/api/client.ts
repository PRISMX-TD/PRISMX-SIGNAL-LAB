// REST 客户端封装 / REST client wrapper
import type { Signal, Order, User, MT5Account, Trend, SignalDailyCount, SignalWinRate, PersonalWinRate, AdminUser, AdminMetrics, UserRole, UserPlan, BrokerLock, AdminBrokerSettings, AutoManageSettings, Candle, SentimentRatio } from './types'

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

// 多周期趋势 / Multi-timeframe trends
export const trendApi = {
  list: () => request<{ trends: Trend[] }>('/trends'),
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
  list: () => request<{ orders: Order[] }>('/orders'),
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
  winrate: () => request<PersonalWinRate>('/orders/winrate'),
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
  putPrefs: (data: Record<string, unknown>) =>
    request<{ data: Record<string, unknown> }>('/auth/prefs', {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),
}

// 通知 / Notifications
export const notificationApi = {
  getPrefs: () =>
    request<{ enabled: boolean; selected_categories: string[] }>('/notifications/prefs'),
  putPrefs: (enabled: boolean, selectedCategories: string[]) =>
    request<{ enabled: boolean; selected_categories: string[] }>('/notifications/prefs', {
      method: 'PUT',
      body: JSON.stringify({ enabled, selected_categories: selectedCategories }),
    }),
  getIndicators: () => request<string[]>('/notifications/indicators'),
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
