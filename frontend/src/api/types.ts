// 共享类型定义 / Shared type definitions

export interface User {
  id: string
  email: string
}

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
}

export type OrderStatus = 'PENDING' | 'FILLED' | 'REJECTED' | 'FAILED'
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

export interface EAStatus {
  online: boolean
  mt5Login: string | null
  mt5Server?: string | null
  symbolSuffix?: string | null
  accountName?: string | null
  accountCurrency?: string | null
  balance?: number | null
  equity?: number | null
  leverage?: number | null
  company?: string | null
  lastHeartbeat?: string | null
}

export interface Quote {
  symbol: string
  bid: number
  ask: number
  digits?: number
  time?: string
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
  type: 'AUTH_OK' | 'AUTH_FAIL' | 'SIGNAL_NEW' | 'SIGNAL_EXPIRED' | 'ORDER_UPDATE' | 'EA_STATUS' | 'POSITIONS' | 'ACCOUNTS_STATUS' | 'QUOTES' | 'TREND_UPDATE'
  data?: unknown
  reason?: string
  userId?: string
}
