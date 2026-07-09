// 实时数据共享状态：EA 状态、信号、订单、持仓。
// Shared live state: EA status, signals, orders, positions.
import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react'
import type { BrokerLock, MT5Account, Order, Position, Quote, Signal, Trend, WSMessage } from '../api/types'
import { accountApi, orderApi, signalApi, trendApi } from '../api/client'
import { useClientSocket } from './useClientSocket'
import { usePrefs } from './prefs'

interface LiveContextValue {
  signals: Signal[]
  orders: Order[]
  // 多周期趋势 {symbol: Trend}（由 TradingView 经 webhook 推送）/ trends pushed via webhook
  trends: Record<string, Trend>
  accounts: MT5Account[]
  // 当前订阅等级最多可连接的账户数，null 表示不限 / max accounts for the current plan; null = unlimited
  accountLimit: number | null
  // 合作券商限制展示信息，null = 尚未加载 / partner-broker lock info; null = not loaded yet
  brokerLock: BrokerLock | null
  // 首屏数据是否加载完成 / whether the first data load has completed
  loaded: boolean
  // 聚合连接状态（以桥接上报的账号为准）/ aggregated connection (bridge accounts are the source of truth)
  anyOnline: boolean
  onlineAccounts: MT5Account[]
  refreshAll: () => Promise<void>
  // 网页自身到后端的 WebSocket 是否连通；断开时报价/持仓可能已过时。
  // Whether the page's own WebSocket to the backend is up; quotes/positions
  // may be stale while it's down.
  wsConnected: boolean
  // 曾经连上过之后又断开——用于避免首次加载瞬间的误报横幅。
  // Was connected at least once and then dropped — avoids a false-positive
  // banner during the brief instant right after first load.
  wsDisconnected: boolean
}

const LiveContext = createContext<LiveContextValue | null>(null)
// 高频推送的报价与持仓单独放各自的 Context，避免它们变化时把只关心信号/账号的
// 组件也一起重渲染。/ Quotes & positions get their own contexts so their frequent
// updates don't re-render components that only care about signals/accounts.
const QuotesContext = createContext<Record<string, Quote>>({})
const PositionsContext = createContext<Position[]>([])

// 失效信号最多保留的条数 / max number of expired signals to keep
const MAX_EXPIRED = 30

// 浅比较两个对象的自有字段（值均为原始类型时可靠）/ shallow-compare own fields
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false
  }
  return true
}

// 内容未变则保留旧引用，避免无意义的整树重渲染（持仓每 1.5 秒、账号每 5 秒
// 会重复推送相同数据）。改用浅比较替代双重 JSON.stringify，省下主线程序列化开销。
// Keep the previous reference when content is unchanged, so identical pushes
// (positions every 1.5s, accounts every 5s) don't re-render. Uses a shallow
// comparison instead of a double JSON.stringify to save main-thread work.
function keepIfEqual<T>(prev: T, next: T): T {
  if (prev === next) return prev
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) return next
    for (let i = 0; i < prev.length; i++) {
      if (!shallowEqual(prev[i], next[i])) return next
    }
    return prev
  }
  return shallowEqual(prev, next) ? prev : next
}

// 保留全部有效信号，过期信号只保留最新的 MAX_EXPIRED 条（按生成时间倒序）。
// Keep all active signals; cap expired ones to the newest MAX_EXPIRED (by created time).
function capExpired(signals: Signal[]): Signal[] {
  let kept = 0
  const ts = (s: Signal) => (s.createdAt ? new Date(s.createdAt).getTime() : 0)
  // 先按生成时间倒序，保证保留的是最新的过期信号 / newest-first so we keep the latest expired
  const ordered = [...signals].sort((a, b) => ts(b) - ts(a))
  const limited = ordered.filter((s) => {
    if (s.status !== 'EXPIRED') return true
    kept += 1
    return kept <= MAX_EXPIRED
  })
  // 恢复原有顺序（保留进入数组的相对次序）/ restore the original ordering
  const allow = new Set(limited)
  return signals.filter((s) => allow.has(s))
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { applyRemotePrefs } = usePrefs()
  const [signals, setSignals] = useState<Signal[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [trends, setTrends] = useState<Record<string, Trend>>({})
  const [accounts, setAccounts] = useState<MT5Account[]>([])
  const [accountLimit, setAccountLimit] = useState<number | null>(null)
  const [brokerLock, setBrokerLock] = useState<BrokerLock | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refreshAll = useCallback(async () => {
    const [sig, ord, acc, trd] = await Promise.all([
      signalApi.list().catch(() => ({ signals: [] })),
      orderApi.list().catch(() => ({ orders: [] })),
      accountApi.list().catch(() => ({ accounts: [], accountLimit: null, brokerLock: null })),
      trendApi.list().catch(() => ({ trends: [] })),
    ])
    setSignals(capExpired(sig.signals))
    setOrders(ord.orders)
    setAccounts(acc.accounts)
    setAccountLimit(acc.accountLimit)
    setBrokerLock((prev) => keepIfEqual(prev, acc.brokerLock))
    setTrends(Object.fromEntries((trd.trends || []).map((t) => [t.symbol, t])))
    setLoaded(true)
  }, [])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // 兜底轮询：每 5 秒刷新一次账号在线状态，防止 WebSocket 推送丢失导致状态卡住。
  // 配合后端 ~7s 在线窗口与离线检测任务，断线可在数秒内置灰。
  // Fallback polling: refresh account online status every 5s in case a WS push
  // is missed, so a disconnect greys out within seconds alongside the backend monitor.
  useEffect(() => {
    const timer = window.setInterval(() => {
      accountApi.list().then((r) => setAccounts((prev) => keepIfEqual(prev, r.accounts))).catch(() => {})
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const handleMessage = useCallback((msg: WSMessage) => {
    switch (msg.type) {
      case 'SIGNAL_NEW':
        setSignals((prev) => capExpired([msg.data as Signal, ...prev]))
        break
      case 'SIGNAL_EXPIRED': {
        // 信号到期：置为 EXPIRED，前端置灰并禁用下单 / mark expired, grey out & disable
        const { id } = msg.data as { id: string }
        setSignals((prev) =>
          capExpired(prev.map((s) => (s.id === id ? { ...s, status: 'EXPIRED' as const } : s)))
        )
        break
      }
      case 'ORDER_UPDATE': {
        const updated = msg.data as Order
        setOrders((prev) => {
          const idx = prev.findIndex((o) => o.id === updated.id)
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = updated
            return next
          }
          return [updated, ...prev]
        })
        break
      }
      case 'POSITIONS':
        setPositions((prev) => keepIfEqual(prev, (msg.data as Position[]) || []))
        break
      case 'QUOTES': {
        // 合并变化的报价到现有快照 / merge changed quotes into the snapshot
        const list = (msg.data as Quote[]) || []
        if (list.length === 0) break
        setQuotes((prev) => {
          const next = { ...prev }
          for (const q of list) next[q.symbol] = q
          return next
        })
        break
      }
      case 'TREND_UPDATE': {
        // 某品种多周期趋势变化：按 symbol 覆盖最新快照 / overwrite the latest trend snapshot by symbol
        const t = msg.data as Trend
        if (!t?.symbol) break
        setTrends((prev) => ({ ...prev, [t.symbol]: t }))
        break
      }
      case 'PREFS_UPDATE': {
        // 其它设备保存了偏好（如画线）：实时应用到本设备 / another device saved prefs (e.g. drawings)
        applyRemotePrefs((msg.data as Record<string, unknown>) || {})
        break
      }
      case 'ACCOUNTS_STATUS': {
        // 桥接程序上报账号在线变化，拉取最新账号列表 / refresh accounts on status change
        const data = msg.data as { onlineLogins?: string[] }
        const online = new Set(data?.onlineLogins || [])
        setAccounts((prev) =>
          prev.map((a) => ({ ...a, online: online.has(a.login) }))
        )
        accountApi.list().then((r) => setAccounts((prev) => keepIfEqual(prev, r.accounts))).catch(() => {})
        break
      }
    }
  }, [applyRemotePrefs])

  const wsConnected = useClientSocket(handleMessage)

  // 曾经连上过之后又断开，才提示"已断线"，避免首次连接前的瞬间误报。
  // Only flag "disconnected" after having connected at least once, so the
  // brief instant before the first connection lands doesn't false-trigger it.
  const everConnected = useRef(false)
  if (wsConnected) everConnected.current = true
  const wsDisconnected = everConnected.current && !wsConnected

  // 以桥接上报的在线账号作为统一连接状态来源 / unified connection status from bridge accounts
  const onlineAccounts = useMemo(() => accounts.filter((a) => a.online), [accounts])
  const anyOnline = onlineAccounts.length > 0

  // memo 化主 value：仅在这些字段真正变化时才换新引用；报价/持仓走各自 Context，
  // 因此它们高频更新不会让 useLive() 的消费者重渲染。
  // Memoize the main value so its identity only changes when these fields change;
  // quotes/positions live in their own contexts, so their frequent updates never
  // re-render useLive() consumers.
  const value = useMemo<LiveContextValue>(
    () => ({
      signals, orders, trends, accounts, accountLimit, brokerLock, loaded,
      anyOnline, onlineAccounts, refreshAll, wsConnected, wsDisconnected,
    }),
    [signals, orders, trends, accounts, accountLimit, brokerLock, loaded,
     anyOnline, onlineAccounts, refreshAll, wsConnected, wsDisconnected]
  )

  return (
    <LiveContext.Provider value={value}>
      <PositionsContext.Provider value={positions}>
        <QuotesContext.Provider value={quotes}>
          {children}
        </QuotesContext.Provider>
      </PositionsContext.Provider>
    </LiveContext.Provider>
  )
}

export function useLive() {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLive must be used within LiveProvider')
  return ctx
}

// 只订阅实时报价，避免因信号/账号变化而重渲染 / subscribe to quotes only
export function useQuotes() {
  return useContext(QuotesContext)
}

// 只订阅持仓 / subscribe to positions only
export function usePositions() {
  return useContext(PositionsContext)
}
