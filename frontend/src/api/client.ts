// REST 客户端封装 / REST client wrapper
import type { Signal, Order, EAStatus, User, MT5Account } from './types'

const TOKEN_KEY = 'prismx_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`/api${path}`, { ...options, headers })
  if (!res.ok) {
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
}

// 信号 / Signals
export const signalApi = {
  list: () => request<{ signals: Signal[] }>('/signals'),
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
  }) =>
    request<Order>('/orders', {
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

// EA 绑定 / EA binding
export const eaApi = {
  getToken: () => request<{ apiToken: string; boundAccount: string | null }>('/ea/token'),
  resetToken: () => request<{ apiToken: string }>('/ea/token/reset', { method: 'POST' }),
  registerAccount: (mt5Login: string, mt5Server: string) =>
    request<{ ok: boolean }>('/ea/account', {
      method: 'POST',
      body: JSON.stringify({ mt5Login, mt5Server }),
    }),
  setSuffix: (symbolSuffix: string) =>
    request<{ ok: boolean; symbolSuffix: string }>('/ea/suffix', {
      method: 'POST',
      body: JSON.stringify({ symbolSuffix }),
    }),
  status: () => request<EAStatus>('/ea/status'),
}
