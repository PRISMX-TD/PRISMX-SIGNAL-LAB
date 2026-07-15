// 信号面板专用 Hook / hooks used by the signals panel
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../../api/client'
import { clientOrderId, localizeApiError } from '../../api/utils'
import { useLive } from '../../store/live'
import type { Signal } from '../../api/types'
import {
  NEW_HIGHLIGHT_MS,
  effectiveStatus,
  type FocusEntry,
  type FocusState,
} from './SignalView'

// ---------- 下单 + 回执提示 / order placement + receipt toasts ----------

export interface OrderToast {
  msg: string
  kind: 'success' | 'error' | 'info'
}

// toast 配色 / toast tone classes
export function toastToneClass(kind: OrderToast['kind']): string {
  if (kind === 'error') return 'border-down/40 bg-down/15 text-down'
  if (kind === 'info') return 'border-prism-600/40 bg-prism-600/15 text-prism-300'
  return 'border-up/40 bg-up/15 text-up'
}

// 等待回执的兜底时长：正常回执 WS 几秒内就到 / fallback window; WS receipts arrive in seconds
const RECEIPT_FALLBACK_MS = 20000

/**
 * 下单 + 等待真实回执的共享逻辑（Dashboard 与信号页共用）。
 * 回执经 WS ORDER_UPDATE 推入 live orders，这里监听即可，无需 REST 轮询。
 * Shared order placement + receipt handling (dashboard & signals page).
 * Receipts arrive via the WS ORDER_UPDATE into live orders — we just watch
 * them instead of polling REST.
 */
export function useOrderPlacement() {
  const { t } = useTranslation()
  const { orders, refreshAll } = useLive()
  const [toast, setToast] = useState<OrderToast | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const fallbackTimer = useRef<number | undefined>(undefined)
  // 正在等待回执的订单 id / order id awaiting its receipt
  const pendingId = useRef<string | null>(null)

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current)
    },
    []
  )

  const showToast = useCallback((msg: string, kind: OrderToast['kind'] = 'success', ms = 3000) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ msg, kind })
    toastTimer.current = window.setTimeout(() => setToast(null), ms)
  }, [])

  // 监听 live orders：等待中的订单到达终态即提示 / watch live orders for the terminal state
  useEffect(() => {
    if (!pendingId.current) return
    const o = orders.find((x) => x.id === pendingId.current)
    if (!o) return
    if (o.status === 'FILLED') {
      pendingId.current = null
      if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current)
      showToast(t('order.filled', { price: o.filledPrice ?? '-' }), 'success')
    } else if (o.status === 'REJECTED' || o.status === 'FAILED') {
      pendingId.current = null
      if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current)
      showToast(t('order.rejected', { msg: o.message ? localizeApiError(o.message) : '-' }), 'error')
    }
  }, [orders, showToast, t])

  // 下单 + 等待回执的共享核心；signalId 为 null 即手动下单（图表页）。
  // Shared submit + receipt core; signalId=null means a manual order (charts page).
  const submitOrder = useCallback(
    async (payload: {
      signalId: string | null
      symbol: string
      side: 'BUY' | 'SELL'
      volume: number
      mt5Login: string | null
      stopLoss: number | null
      takeProfit: number | null
    }) => {
      // API 错误向上抛给下单弹窗展示 / API errors propagate to the modal
      const placed = await orderApi.place({ ...payload, clientOrderId: clientOrderId() })
      refreshAll()
      if (placed.status === 'FILLED') {
        showToast(t('order.filled', { price: placed.filledPrice ?? '-' }), 'success')
        return
      }
      if (placed.status === 'REJECTED' || placed.status === 'FAILED') {
        showToast(t('order.rejected', { msg: placed.message ? localizeApiError(placed.message) : '-' }), 'error')
        return
      }
      showToast(t('order.submitted'), 'info', 8000)
      pendingId.current = placed.id
      if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current)
      fallbackTimer.current = window.setTimeout(() => {
        if (pendingId.current === placed.id) {
          pendingId.current = null
          showToast(t('order.ackTimeout'), 'info')
        }
      }, RECEIPT_FALLBACK_MS)
    },
    [refreshAll, showToast, t]
  )

  const placeOrder = useCallback(
    (
      signal: Signal,
      volume: number,
      mt5Login: string | null,
      stopLoss: number | null,
      takeProfit: number | null
    ) =>
      submitOrder({
        signalId: signal.id,
        symbol: signal.symbol,
        side: signal.side,
        volume,
        mt5Login,
        stopLoss,
        takeProfit,
      }),
    [submitOrder]
  )

  // 图表页手动下单（不绑定信号）/ manual order from the charts page (no signal)
  const placeManualOrder = useCallback(
    (
      symbol: string,
      side: 'BUY' | 'SELL',
      volume: number,
      mt5Login: string | null,
      stopLoss: number | null,
      takeProfit: number | null
    ) => submitOrder({ signalId: null, symbol, side, volume, mt5Login, stopLoss, takeProfit }),
    [submitOrder]
  )

  return { toast, placeOrder, placeManualOrder }
}

// 每秒滴答的当前时间，用于实时倒计时 / a per-second ticking clock for live countdowns
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}

// ---------- 全局共享秒级时钟 / global shared per-second clock ----------
// 单一定时器 + 订阅：只让订阅的叶子节点（如倒计时）重渲染，而不是整个列表；
// 无订阅者时自动停表，避免空转。
// One interval + subscribers: only subscribed leaves (e.g. countdowns) re-render,
// not the whole list; the timer stops when nobody is listening.
let clockNow = Date.now()
const clockSubs = new Set<() => void>()
let clockTimer: number | undefined

function subscribeClock(cb: () => void): () => void {
  clockSubs.add(cb)
  if (clockTimer == null) {
    clockTimer = window.setInterval(() => {
      clockNow = Date.now()
      clockSubs.forEach((fn) => fn())
    }, 1000)
  }
  return () => {
    clockSubs.delete(cb)
    if (clockSubs.size === 0 && clockTimer != null) {
      window.clearInterval(clockTimer)
      clockTimer = undefined
    }
  }
}

// 订阅共享时钟：组件每秒拿到最新时间戳，但不会牵动父组件重渲染。
// Subscribe to the shared clock: the component gets a fresh timestamp each
// second without dragging its parent into a re-render.
export function useClock(): number {
  return useSyncExternalStore(subscribeClock, () => clockNow, () => clockNow)
}

// 跟踪新到达的信号 id，用于短暂高亮 / track freshly arrived signal ids for a brief highlight
export function useNewSignalIds(signals: Signal[]): Set<string> {
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set())
  const seen = useRef<Set<string>>(new Set())
  const firstRun = useRef(true)

  useEffect(() => {
    // 首次加载不高亮已有信号 / don't highlight pre-existing signals on first load
    if (firstRun.current) {
      firstRun.current = false
      seen.current = new Set(signals.map((s) => s.id))
      return
    }
    const fresh = signals.filter((s) => !seen.current.has(s.id)).map((s) => s.id)
    if (fresh.length === 0) return
    fresh.forEach((id) => seen.current.add(id))
    setNewIds((prev) => {
      const next = new Set(prev)
      fresh.forEach((id) => next.add(id))
      return next
    })
    const timer = window.setTimeout(() => {
      setNewIds((prev) => {
        const next = new Set(prev)
        fresh.forEach((id) => next.delete(id))
        return next
      })
    }, NEW_HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [signals])

  return newIds
}

// 比特币不进关注列表：真实信号上报的品种名是 "BTCUSDT"（与 EA/报价用的
// "BTCUSD" 是两个不同字符串）。若把 EA 活跃列表里的 "BTCUSD" 也当常驻关注
// 品种，一旦真的来一条 BTCUSDT 信号，切换点里会同时出现一个信号驱动的
// "BTCUSDT" 卡和一个只是改了显示名的旧 "BTCUSD" 观望卡——两个标签相同却是
// 两份不同数据。比特币只在真的有活跃信号时才经下面的动态追加逻辑出现一次。
// Bitcoin is excluded from the watchlist: real signals report it as
// "BTCUSDT" (a different string from the EA/quote symbol "BTCUSD"). If the
// EA's active "BTCUSD" were kept as a permanent watch slot, a real BTCUSDT
// signal would produce a second focus stop with the same rendered label,
// backed by different data. Bitcoin only appears once, dynamically, when an
// actual active signal exists.
const HERO_EXCLUDED = new Set(['BTCUSD'])

// 由实时信号派生每个关注品种的当前状态。
// 关注列表 = 活跃品种列表（EA 实际在推的，见 useLive().activeSymbols，剔除
// BTCUSD）∪ 任何当前有 ACTIVE 信号的品种（不漏掉信号里出现但 EA 未配置的
// 品种）。
// Focus-view watchlist derived from live signals. Watchlist = the active
// symbol list (whatever the EA is actually pushing, see
// useLive().activeSymbols, minus BTCUSD) ∪ any symbol with a current ACTIVE
// signal (so a signal for a symbol the EA isn't configured with still shows up).
export function useFocusEntries(signals: Signal[], now: number, activeSymbols: string[]): FocusEntry[] {
  return useMemo(() => {
    const repBySymbol = new Map<string, Signal>()
    for (const s of signals) {
      if (effectiveStatus(s, now) === 'EXPIRED') continue
      const cur = repBySymbol.get(s.symbol)
      if (!cur || new Date(s.createdAt).getTime() > new Date(cur.createdAt).getTime()) {
        repBySymbol.set(s.symbol, s)
      }
    }
    const symbols = activeSymbols.filter((s) => !HERO_EXCLUDED.has(s))
    for (const sym of repBySymbol.keys()) if (!symbols.includes(sym)) symbols.push(sym)
    return symbols.map((symbol) => {
      const signal = repBySymbol.get(symbol) ?? null
      const state: FocusState = !signal ? 'WATCH' : signal.side === 'BUY' ? 'LONG' : 'SHORT'
      return { symbol, state, signal }
    })
  }, [signals, now, activeSymbols])
}
