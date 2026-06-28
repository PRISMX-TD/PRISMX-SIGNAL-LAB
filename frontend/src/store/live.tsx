// 实时数据共享状态：EA 状态、信号、订单、持仓。
// Shared live state: EA status, signals, orders, positions.
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { EAStatus, MT5Account, Order, Position, Signal, WSMessage } from '../api/types'
import { accountApi, eaApi, orderApi, signalApi } from '../api/client'
import { useClientSocket } from './useClientSocket'

interface LiveContextValue {
  signals: Signal[]
  orders: Order[]
  positions: Position[]
  eaStatus: EAStatus
  accounts: MT5Account[]
  // 聚合连接状态（以桥接上报的账号为准）/ aggregated connection (bridge accounts are the source of truth)
  anyOnline: boolean
  onlineAccounts: MT5Account[]
  refreshAll: () => Promise<void>
}

const LiveContext = createContext<LiveContextValue | null>(null)

export function LiveProvider({ children }: { children: ReactNode }) {
  const [signals, setSignals] = useState<Signal[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [eaStatus, setEaStatus] = useState<EAStatus>({ online: false, mt5Login: null })
  const [accounts, setAccounts] = useState<MT5Account[]>([])

  const refreshAll = useCallback(async () => {
    const [sig, ord, st, acc] = await Promise.all([
      signalApi.list().catch(() => ({ signals: [] })),
      orderApi.list().catch(() => ({ orders: [] })),
      eaApi.status().catch(() => ({ online: false, mt5Login: null }) as EAStatus),
      accountApi.list().catch(() => ({ accounts: [] })),
    ])
    setSignals(sig.signals)
    setOrders(ord.orders)
    setEaStatus(st)
    setAccounts(acc.accounts)
  }, [])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  const handleMessage = useCallback((msg: WSMessage) => {
    switch (msg.type) {
      case 'SIGNAL_NEW':
        setSignals((prev) => [msg.data as Signal, ...prev].slice(0, 50))
        break
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
      case 'EA_STATUS':
        setEaStatus((prev) => ({ ...prev, ...(msg.data as EAStatus) }))
        break
      case 'POSITIONS':
        setPositions((msg.data as Position[]) || [])
        break
      case 'ACCOUNTS_STATUS': {
        // 桥接程序上报账号在线变化，拉取最新账号列表 / refresh accounts on status change
        const data = msg.data as { onlineLogins?: string[] }
        const online = new Set(data?.onlineLogins || [])
        setAccounts((prev) =>
          prev.map((a) => ({ ...a, online: online.has(a.login) }))
        )
        accountApi.list().then((r) => setAccounts(r.accounts)).catch(() => {})
        break
      }
    }
  }, [])

  useClientSocket(handleMessage)

  // 以桥接上报的在线账号作为统一连接状态来源 / unified connection status from bridge accounts
  const onlineAccounts = accounts.filter((a) => a.online)
  const anyOnline = onlineAccounts.length > 0

  return (
    <LiveContext.Provider
      value={{ signals, orders, positions, eaStatus, accounts, anyOnline, onlineAccounts, refreshAll }}
    >
      {children}
    </LiveContext.Provider>
  )
}

export function useLive() {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error('useLive must be used within LiveProvider')
  return ctx
}
