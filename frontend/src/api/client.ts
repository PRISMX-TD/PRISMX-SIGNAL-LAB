// REST 客户端封装 / REST client wrapper
import type { Signal, Order, User, MT5Account, Trend, SignalDailyCount } from './types'

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
}

// 多周期趋势 / Multi-timeframe trends
export const trendApi = {
  list: () => request<{ trends: Trend[] }>('/trends'),
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
}

// 多账号 / Multi-account
export const accountApi = {
  list: () => request<{ accounts: MT5Account[] }>('/bridge/accounts'),
  setSuffix: (login: string, symbolSuffix: string) =>
    request<{ ok: boolean; login: string; symbolSuffix: string }>('/bridge/accounts/suffix', {
      method: 'POST',
      body: JSON.stringify({ login, symbolSuffix }),
    }),
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
