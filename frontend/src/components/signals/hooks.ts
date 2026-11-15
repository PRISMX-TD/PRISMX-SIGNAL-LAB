// 信号面板专用 Hook / hooks used by the signals panel
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import { useLive } from '../../store/live'
import type { Order, OrderEntryType, Signal } from '../../api/types'
import { useToastState } from '../../utils/useToastState'
import { OrderRejectedError } from '../order/orderRejected'
import {
  NEW_HIGHLIGHT_MS,
  effectiveStatus,
  type FocusEntry,
  type FocusState,
} from './SignalView'
import { APP_BACKGROUND_EVENT, APP_FOREGROUND_EVENT, isAppHidden } from '../../utils/appVisibility'
import { EMPTY } from '../../utils/format'

// ---------- 下单 + 回执提示 / order placement + receipt toasts ----------

// 等待回执的兜底时长：正常回执 WS 几秒内就到 / fallback window; WS receipts arrive in seconds
const RECEIPT_FALLBACK_MS = 20000

/** submitOrder 的可选行为 / optional submitOrder behaviour */
export interface SubmitOrderOptions {
  // true：券商当场拒单（REJECTED）或结果未知（FAILED）时不弹 toast，改为抛 OrderRejectedError。
  // 滑动确认弹窗（OrderSheet）的两条路径（placeOrder、placeStrategyOrder）固定传 true：弹窗
  // 自己在回执卡里报错，再弹一条 toast 就是同一件事说两遍。图表页的 placeManualOrder 不传，
  // 它拿返回值渲染就地回执。
  // true: on an on-the-spot REJECTED / FAILED, throw OrderRejectedError instead of toasting.
  // The two OrderSheet paths (placeOrder, placeStrategyOrder) always pass it: the sheet reports
  // the failure in its receipt card, and a toast on top says the same thing twice. The charts
  // page's placeManualOrder does not; it renders an inline receipt from the return value.
  throwOnReject?: boolean
  // true：不弹这一笔的即时结果 toast（成交 / 挂出 / 被拒 / 已提交），调用方自己就地报。PENDING
  // 的单仍登记等回执，稍后到达的结果照常弹 toast。图表页下单票用它：按钮下面有自己的就地回执，
  // 再在屏幕正中弹一条就是同一件事说两遍。
  // true: skip the immediate result toast; the caller reports it in place. PENDING orders still
  // register, and their later result still toasts. The charts ticket uses it: it has its own
  // inline receipt under the button, and a centred toast would say the same thing twice.
  silent?: boolean
}

/**
 * 下单 + 等待真实回执的共享逻辑（Dashboard 与信号页共用）。
 * 回执经 WS ORDER_UPDATE 推入 live orders，这里监听即可，无需 REST 轮询。
 * Shared order placement + receipt handling (dashboard & signals page).
 * Receipts arrive via the WS ORDER_UPDATE into live orders — we just watch
 * them instead of polling REST.
 */
export function useOrderPlacement() {
  const { t } = useTranslation()
  const { orders, upsertOrder } = useLive()
  const { toast, showToast } = useToastState()
  // 正在等待回执的订单 id 集合。两件事必须这样：
  // ① 是**集合**不是单个 id：终端下单票允许连续下多单（成功即 rotateOrderId），
  //    以前第二笔一提交就把第一笔的 id 覆盖掉，第一笔的成交/被拒提示永远不出现，
  //    用户以为它还在路上。
  // ② 是 **state** 不是 ref：下面监听 orders 的 effect 依赖它。网关账号几乎即时
  //    成交，ORDER_UPDATE 可能在这里登记之前就把 orders 更新完了——那一轮 effect
  //    已经跑过，ref 赋值不会再触发它，于是要一直等到 20 秒兜底才提示"未收到回
  //    执"，而单其实早就成交了。登记本身即状态变化，effect 会再跑一次对账。
  // The set of order ids awaiting a receipt. It must be a set (the terminal ticket
  // allows back-to-back orders; a single ref dropped the first one's receipt) and
  // it must be state, not a ref: the watcher effect below depends on it, and a
  // gateway account can fill before registration, in which case a ref assignment
  // would never re-run the effect and the user would wait out the 20s fallback.
  const [pendingIds, setPendingIds] = useState<string[]>([])
  // 同一份数据的 ref 镜像：定时器回调要在不触发渲染的情况下判断"这笔还在等吗"，
  // 而 setState 的更新函数里不能做 toast 这类副作用（StrictMode 会跑两次）。
  // A ref mirror so timer callbacks can ask "is this one still pending?" without
  // doing side effects inside a setState updater (StrictMode runs those twice).
  const pendingRef = useRef<Set<string>>(new Set())
  const fallbackTimers = useRef<Map<string, number>>(new Map())

  const settle = useCallback((id: string) => {
    const timer = fallbackTimers.current.get(id)
    if (timer != null) window.clearTimeout(timer)
    fallbackTimers.current.delete(id)
    if (!pendingRef.current.delete(id)) return false
    setPendingIds((prev) => prev.filter((x) => x !== id))
    return true
  }, [])

  useEffect(
    () => () => {
      for (const timer of fallbackTimers.current.values()) window.clearTimeout(timer)
      fallbackTimers.current.clear()
    },
    []
  )

  // 监听 live orders：等待中的订单到达终态即提示 / watch live orders for the terminal state
  useEffect(() => {
    if (pendingIds.length === 0) return
    for (const id of pendingIds) {
      const o = orders.find((x) => x.id === id)
      if (!o) continue
      if (o.status === 'PLACED') {
        if (settle(id)) showToast(t('order.pendingPlaced', { price: o.price ?? EMPTY }), 'success')
      } else if (o.status === 'FILLED') {
        if (settle(id)) showToast(t('order.filled', { price: o.filledPrice ?? EMPTY }), 'success')
      } else if (o.status === 'REJECTED' || o.status === 'FAILED') {
        if (settle(id)) showToast(t('order.rejected', { msg: o.message ? localizeApiError(o.message) : EMPTY }), 'error')
      }
    }
  }, [orders, pendingIds, settle, showToast, t])

  // 一笔刚拿到结果的单按状态报成一条 toast。submitOrder 内部用它；图表页在 silent 下单后，
  // 手机抽屉切到持仓、下单票随之卸载时也用它补报（就地回执跟着票一起没了）。
  // Report a just-answered order as one toast. submitOrder uses it; the charts page calls it
  // after a silent order when the mobile sheet switches away and unmounts the ticket, taking
  // its inline receipt with it.
  const reportPlaced = useCallback((placed: Order) => {
    if (placed.status === 'PLACED') {
      // 挂单挂出成功。这一支必须排在 FILLED 之前、而且不能并进去：挂单还没
      // 成交，说"已成交"会让用户以为仓位已经建立。
      // A placed pending order. Kept ahead of and apart from FILLED: nothing has
      // traded, and saying it has makes the user believe a position exists.
      showToast(t('order.pendingPlaced', { price: placed.price ?? EMPTY }), 'success')
    } else if (placed.status === 'FILLED') {
      showToast(t('order.filled', { price: placed.filledPrice ?? EMPTY }), 'success')
    } else if (placed.status === 'REJECTED' || placed.status === 'FAILED') {
      showToast(t('order.rejected', { msg: placed.message ? localizeApiError(placed.message) : EMPTY }), 'error')
    } else {
      // 停留时长按种类走 useToastState 的 TOAST_MS（info 4 秒）。
      // Duration comes from TOAST_MS in useToastState (info: 4s).
      showToast(t('order.submitted'), 'info')
    }
  }, [showToast, t])

  // 下单 + 等待回执的共享核心；signalId 为 null 即手动下单（图表页）。
  // clientOrderId 由下单弹窗持有并在重试间保持不变（一个弹窗=一笔下单意图），
  // 这样"发出去了但没收到回执→用户再滑一次"时，服务端按同一个幂等号识别为
  // 同一笔，不会重复下单。绝不能在这里现生成——那样每次重试都是新号，幂等失效。
  // Shared submit + receipt core; signalId=null means a manual order (charts
  // page). clientOrderId is owned by the order modal and kept stable across
  // retries (one modal = one order intent), so a "sent but no receipt → user
  // slides again" retry is deduped server-side by the same id instead of
  // double-placing. It must NOT be generated here — that would mint a fresh id
  // per retry and defeat idempotency.
  const submitOrder = useCallback(
    async (payload: {
      signalId: string | null
      symbol: string
      side: 'BUY' | 'SELL'
      volume: number
      mt5Login: string | null
      stopLoss: number | null
      takeProfit: number | null
      clientOrderId: string
      orderType?: OrderEntryType
      price?: number | null
      source?: 'STRATEGY' | null
      reverse?: boolean
    }, opts: SubmitOrderOptions = {}) => {
      // API 错误向上抛给下单弹窗展示 / API errors propagate to the modal
      const placed = await orderApi.place(payload)
      // 不再重拉 /orders：POST 已把这一条订单整条返回，直接并入本地列表（upsertOrder 带防回退，
      // WS 的终态不会被这条 PENDING 回执覆盖）；持仓 / 挂单随 WS 推送。
      // No /orders refetch: the POST already returns the whole order, so merge it into the local
      // list (upsertOrder is regress-safe: a WS terminal state is never overwritten by this
      // PENDING receipt); positions / pending orders ride the WS.
      upsertOrder(placed)
      const answered = placed.status === 'PLACED' || placed.status === 'FILLED'
        || placed.status === 'REJECTED' || placed.status === 'FAILED'
      // 滑动确认弹窗的路径：抛错，让 OrderSheet 走错误回执，不弹 toast（见 SubmitOrderOptions）。
      // The slide-to-confirm path throws so OrderSheet shows its error receipt; no toast.
      if ((placed.status === 'REJECTED' || placed.status === 'FAILED') && opts.throwOnReject) {
        throw new OrderRejectedError(placed)
      }
      // silent：调用方自己就地报结果（图表页下单票），这里不再弹同一句（见 SubmitOrderOptions）。
      // silent: the caller reports the result in place (charts ticket); don't repeat it here.
      if (!opts.silent) reportPlaced(placed)
      // 把回执原样交回调用方：图表页的下单票要按 FILLED / PENDING / REJECTED 在按钮
      // 下面就地给出不同的回执（成交价、耗时），而不是只有一句"已提交"。
      // Hand the receipt back to the caller: the charts ticket renders a
      // status-specific inline receipt (fill price, elapsed) under the button.
      if (answered) return placed
      // 还没结果（PENDING）：登记等回执。silent 也照样登记：稍后到达的成交 / 被拒是异步结果，
      // 那时下单票上的就地回执早已消失，toast 是它唯一的回音。
      // No result yet (PENDING): register for the receipt. Silent callers register too: the
      // fill or rejection arrives later, after the ticket's inline receipt is gone.
      if (!pendingRef.current.has(placed.id)) {
        pendingRef.current.add(placed.id)
        setPendingIds((prev) => [...prev, placed.id])
      }
      // 每笔一个兜底定时器（以前全局只有一个，第二笔会把第一笔的兜底也顶掉）。
      // One fallback timer per order; a single shared one cancelled the first
      // order's fallback as soon as a second went out.
      const timer = window.setTimeout(() => {
        if (settle(placed.id)) showToast(t('order.ackTimeout'), 'info')
      }, RECEIPT_FALLBACK_MS)
      fallbackTimers.current.set(placed.id, timer)
      return placed
    },
    [upsertOrder, settle, showToast, reportPlaced, t]
  )

  const placeOrder = useCallback(
    (
      signal: Signal,
      volume: number,
      mt5Login: string | null,
      stopLoss: number | null,
      takeProfit: number | null,
      clientOrderId: string,
      // 反向跟单：方向取信号的反方向；止盈止损由弹窗按对调值预填，后端再按信号核一遍方向。
      // Reverse copy: the opposite side; the modal prefills swapped SL/TP and the backend
      // re-checks the side against the signal.
      reverse = false
    ) =>
      submitOrder({
        signalId: signal.id,
        symbol: signal.symbol,
        side: reverse ? (signal.side === 'BUY' ? 'SELL' : 'BUY') : signal.side,
        volume,
        mt5Login,
        stopLoss,
        takeProfit,
        clientOrderId,
        ...(reverse ? { reverse: true } : {}),
      }, { throwOnReject: true }),
    [submitOrder]
  )

  // 图表页手动下单（不绑定信号）：市价或挂单。orderType 省略 = 市价，与这两个
  // 参数出现之前完全一致。/ Manual order from the charts page (no signal), market or
  // pending. Omitting orderType means MARKET, exactly as before these params existed.
  const placeManualOrder = useCallback(
    (
      symbol: string,
      side: 'BUY' | 'SELL',
      volume: number,
      mt5Login: string | null,
      stopLoss: number | null,
      takeProfit: number | null,
      clientOrderId: string,
      orderType: OrderEntryType = 'MARKET',
      price: number | null = null,
      opts: SubmitOrderOptions = {},
    ) => submitOrder({
      signalId: null, symbol, side, volume, mt5Login, stopLoss, takeProfit, clientOrderId,
      orderType, price,
    }, opts),
    [submitOrder]
  )

  // 个人策略信号下单：与手动下单同一条路径（不带 signalId），只多标一个来源，
  // 让券商备注写成 PRISMX-STRAT。/ Personal strategy order: the manual path plus
  // a source flag so the broker comment reads PRISMX-STRAT.
  const placeStrategyOrder = useCallback(
    (
      symbol: string,
      side: 'BUY' | 'SELL',
      volume: number,
      mt5Login: string | null,
      stopLoss: number | null,
      takeProfit: number | null,
      clientOrderId: string,
    ) => submitOrder({
      signalId: null, symbol, side, volume, mt5Login, stopLoss, takeProfit, clientOrderId,
      source: 'STRATEGY',
    }, { throwOnReject: true }),
    [submitOrder]
  )

  // showToast 暴露给终端的持仓/挂单面板：平仓/撤单直接走 orderApi（不经
  // submitOrder），需要复用同一套 toast 展示。/ Exposed so the terminal's
  // positions/orders dock (which calls orderApi.close/cancel directly, not via
  // submitOrder) can surface feedback through the same toast.
  return { toast, placeOrder, placeManualOrder, placeStrategyOrder, showToast, reportPlaced }
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

// 按 bucketMs 分桶的当前时间：只在跨过桶边界时更新一次（setTimeout 对齐到下一个边界），
// 给「只关心过没过期、不显示秒数」的地方用。useNow(1000) 每秒 setState，挂在页面顶层
// 就是整页每秒重渲染一遍——仪表盘以前就是这样。
// The current time floored to bucketMs, updating once per bucket boundary (the
// timeout is aligned to the next boundary). For callers that only care whether
// something expired, never the seconds: useNow(1000) sets state every second, and at
// a page's top level that is a whole-page re-render every second — as the dashboard was.
export function useBucketedNow(bucketMs: number): number {
  const floor = (n: number) => Math.floor(n / bucketMs) * bucketMs
  const [now, setNow] = useState(() => floor(Date.now()))
  useEffect(() => {
    let timer: number | undefined
    const arm = () => {
      const n = Date.now()
      // +5ms：别恰好落在边界前一毫秒，导致 floor 还是上一个桶 / land just past the boundary
      timer = window.setTimeout(() => {
        setNow(floor(Date.now()))
        arm()
      }, bucketMs - (n % bucketMs) + 5)
    }
    setNow(floor(Date.now()))
    arm()
    return () => { if (timer != null) window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- floor derives from bucketMs
  }, [bucketMs])
  return now
}

// ---------- 全局共享秒级时钟 / global shared per-second clock ----------
// 单一定时器 + 订阅：只让订阅的叶子节点（如倒计时）重渲染，而不是整个列表；
// 无订阅者时自动停表，避免空转。
// 页面或 App 在后台时也停表（isAppHidden：document.hidden 或 App 壳的
// apppack:background）。看不见的倒计时以前每秒照样唤醒 JS、让 React 重渲染；App 锁屏
// 时 WebView 不暂停定时器，白白耗电。回到前台立刻补走一格再重新起表，数字不会停在
// 离开的那一秒。第一个订阅者到来时先把时间刷新：停表期间 clockNow 没在走，不刷新的话
// 刚挂上的倒计时会先显示离开那一刻的时间，一秒后才跳对。
// One interval + subscribers: only subscribed leaves (e.g. countdowns) re-render,
// not the whole list; the timer stops when nobody is listening.
// It also stops while the page or app is in the background (isAppHidden: document.hidden
// or the App shell's apppack:background). Invisible countdowns used to wake JS and
// re-render every second, and a locked phone's WebView doesn't pause timers. Back in the
// foreground it ticks at once and restarts, so the digits never sit on the second you left.
// The first subscriber refreshes the time: clockNow is frozen while stopped, and without
// the refresh a freshly mounted countdown would show the moment you left for a second
// before jumping to the right value.
let clockNow = Date.now()
const clockSubs = new Set<() => void>()
let clockTimer: number | undefined

function tickClock() {
  clockNow = Date.now()
  clockSubs.forEach((fn) => fn())
}

function startClock() {
  if (clockTimer == null) clockTimer = window.setInterval(tickClock, 1000)
}

function stopClock() {
  if (clockTimer != null) {
    window.clearInterval(clockTimer)
    clockTimer = undefined
  }
}

// 前后台切换时调用：后台停表；回到前台且还有订阅者时，先补走一格再起表。
// Called on every foreground / background change: stop in the background; back in front
// with subscribers, tick once immediately and restart.
function syncClockVisibility() {
  if (isAppHidden()) {
    stopClock()
  } else if (clockSubs.size > 0 && clockTimer == null) {
    tickClock()
    startClock()
  }
}

function subscribeClock(cb: () => void): () => void {
  if (clockSubs.size === 0) {
    document.addEventListener('visibilitychange', syncClockVisibility)
    window.addEventListener(APP_BACKGROUND_EVENT, syncClockVisibility)
    window.addEventListener(APP_FOREGROUND_EVENT, syncClockVisibility)
    clockNow = Date.now()
  }
  clockSubs.add(cb)
  if (!isAppHidden()) startClock()
  return () => {
    clockSubs.delete(cb)
    if (clockSubs.size === 0) {
      stopClock()
      document.removeEventListener('visibilitychange', syncClockVisibility)
      window.removeEventListener(APP_BACKGROUND_EVENT, syncClockVisibility)
      window.removeEventListener(APP_FOREGROUND_EVENT, syncClockVisibility)
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
// now 在这里只用来剔除已过期的信号，不参与任何展示，所以按 10 秒分桶。调用方传的
// 是每秒一跳的时钟，直接进 memo 依赖就是每秒产出一个新数组、下游列表每秒重算一遍
// ——而信号的存活时长以分钟计，晚 10 秒判过期没有任何可感知差异。
// `now` is used only to drop expired signals, never rendered, so it's bucketed to
// 10s. Callers pass a per-second clock, which as a raw dependency produced a new
// array every second and re-ran the whole downstream list; signal lifespans are
// measured in minutes, so expiring up to 10s late is imperceptible.
const FOCUS_EXPIRY_BUCKET_MS = 10_000

export function useFocusEntries(signals: Signal[], now: number, activeSymbols: string[]): FocusEntry[] {
  const nowBucket = Math.floor(now / FOCUS_EXPIRY_BUCKET_MS) * FOCUS_EXPIRY_BUCKET_MS
  return useMemo(() => {
    const repBySymbol = new Map<string, Signal>()
    for (const s of signals) {
      if (effectiveStatus(s, nowBucket) === 'EXPIRED') continue
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
  }, [signals, nowBucket, activeSymbols])
}
