// 实时数据共享状态：EA 状态、信号、订单、持仓。
// Shared live state: EA status, signals, orders, positions.
import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react'
import type { BrokerLock, MT5Account, Order, Position, Quote, Signal, StrategySignal, Trend, WSMessage } from '../api/types'
import { accountApi, orderApi, quoteApi, signalApi, strategyApi, symbolApi, trendApi } from '../api/client'
import { useClientSocket } from './useClientSocket'
import { usePrefs } from './prefs'

interface LiveContextValue {
  signals: Signal[]
  // 用户自建策略触发的个人信号——与 signals 完全独立（见 strategy_engine.py
  // 的分表说明），最新在前。/ Personal signals fired by the user's own
  // strategies — fully separate from `signals` (see strategy_engine.py's
  // rationale for the split table), newest first.
  strategySignals: StrategySignal[]
  orders: Order[]
  // 多周期趋势 {symbol: Trend}（由 TradingView 经 webhook 推送）/ trends pushed via webhook
  trends: Record<string, Trend>
  // 当前活跃品种：EA 的 InpSymbols 实际在推什么，就是什么，不是写死的列表——
  // 报价表/图表选择器/仪表盘英雄板都应以此为准渲染。
  // Currently active symbols: whatever the EA's InpSymbols is actually
  // pushing. The quotes table / chart symbol picker / dashboard hero should
  // all render from this instead of a hardcoded list.
  activeSymbols: string[]
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
  // 后端整体不可达。此前每个请求都各自 .catch() 成空数据、最后无条件
  // setLoaded(true)，于是后端挂掉时页面渲染得完全正常、只是什么都没有——用户
  // 读到的是「今天没信号」，不是「服务出问题了」。他会等，而你收不到任何报障。
  // 判据刻意是「关键请求**全部**失败」而不是「任一失败」：单个接口 500 是局部
  // 故障，把它报成整站不可用会制造更糟的误报（踩坑记录 #22 里 Promise.all 把
  // 通知接口的故障扩散成整个账户页崩掉，是同一类错误的反面教材）。
  // Whether the backend is unreachable as a whole. Every request used to
  // .catch() into empty data with an unconditional setLoaded(true) at the end,
  // so a backend outage rendered a perfectly normal page that simply had
  // nothing in it — the user reads "no signals today", not "the service is
  // down". They wait, and you never hear about it.
  // The test is deliberately "ALL critical requests failed", not "any failed":
  // one endpoint 500ing is a partial failure, and reporting that as a total
  // outage would be a worse false positive (pitfall #22, where Promise.all
  // spread a notifications failure across the whole account page, is the same
  // mistake in the opposite direction).
  backendUnreachable: boolean
}

const LiveContext = createContext<LiveContextValue | null>(null)
// 高频推送的报价与持仓单独放各自的 Context，避免它们变化时把只关心信号/账号的
// 组件也一起重渲染。/ Quotes & positions get their own contexts so their frequent
// updates don't re-render components that only care about signals/accounts.
// 按交易商账户区分的报价（桥接上报），下单确认页用：login -> {symbol: Quote}。
// Per-broker-account quotes (bridge-reported), used by the order-confirmation
// pages: login -> {symbol: Quote}.
const QuotesContext = createContext<Record<string, Record<string, Quote>>>({})
// 全站统一展示报价（EA 推送，不区分账户）：symbol -> Quote。
// Site-wide display quotes (EA-pushed, not account-scoped): symbol -> Quote.
const GlobalQuotesContext = createContext<Record<string, Quote>>({})
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
  const [strategySignals, setStrategySignals] = useState<StrategySignal[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [quotes, setQuotes] = useState<Record<string, Record<string, Quote>>>({})
  const [globalQuotes, setGlobalQuotes] = useState<Record<string, Quote>>({})
  const [trends, setTrends] = useState<Record<string, Trend>>({})
  const [activeSymbols, setActiveSymbols] = useState<string[]>([])
  const [accounts, setAccounts] = useState<MT5Account[]>([])
  const [accountLimit, setAccountLimit] = useState<number | null>(null)
  const [brokerLock, setBrokerLock] = useState<BrokerLock | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [backendUnreachable, setBackendUnreachable] = useState(false)

  const refreshAll = useCallback(async () => {
    // 关键请求单独包一层，除了拿数据还要拿到「这条到底成没成」。其余请求
    // （策略信号、趋势、报价、品种）继续静默吞掉：它们各自失败都属于局部
    // 问题，不能作为「整个后端挂了」的证据。
    // Wrap the critical calls so we learn whether each one actually succeeded,
    // not just what it returned. The rest (strategy signals, trends, quotes,
    // symbols) keep swallowing their errors: any of those failing is a local
    // problem and must not count as evidence that the whole backend is down.
    // 回落值与成功值允许是不同类型（如 brokerLock 成功时是 BrokerLock、失败时
    // 是 null），所以两个类型参数、返回联合类型——写成同一个 T 会逼着回落值去
    // 迁就成功值的类型，反而要在调用处硬转。
    // The fallback may have a different type from the success value (brokerLock
    // is a BrokerLock on success and null on failure), hence two type parameters
    // and a union return — collapsing both into one T would force the fallback to
    // match the success type and push a cast to every call site.
    const settle = <T, F>(p: Promise<T>, fallback: F) =>
      p
        .then((value): { ok: boolean; value: T | F } => ({ ok: true, value }))
        .catch((): { ok: boolean; value: T | F } => ({ ok: false, value: fallback }))

    const [sig, stratSig, ord, acc, trd, gq, sym] = await Promise.all([
      settle(signalApi.list(), { signals: [] as Signal[] }),
      // 目前仅管理员可用（功能内部试用中）；非管理员在此静默拿回空数组，
      // 不影响其它数据的加载。/ Admin-only for now (feature in internal
      // trial); non-admins silently get an empty array here, without
      // affecting the rest of the load.
      strategyApi.signals(20).catch(() => ({ signals: [] })),
      orderApi.list().catch(() => ({ orders: [], total: 0 })),
      settle(accountApi.list(), { accounts: [] as MT5Account[], accountLimit: null, brokerLock: null as BrokerLock | null }),
      trendApi.list().catch(() => ({ trends: [] })),
      quoteApi.list().catch(() => ({ quotes: [] })),
      symbolApi.list().catch(() => ({ symbols: [] })),
    ])

    // 两条关键请求都失败才判定后端不可达。选这两条是因为它们覆盖面最广：
    // 一条读全站共享数据、一条读该用户私有数据，两条都打不通，几乎不可能是
    // 单个端点的问题。凭证失效（401）不会走到这里——client.ts 收到 401 会清
    // 登录态并跳登录页，根本不会停留在应用内。
    // Only when both critical calls fail do we call the backend unreachable.
    // These two are chosen for breadth: one reads shared site-wide data, the
    // other this user's private data, and both failing at once is very unlikely
    // to be a single endpoint's fault. An expired credential never reaches this
    // path — a 401 makes client.ts clear the session and bounce to login, so we
    // aren't sitting inside the app at all.
    setBackendUnreachable(!sig.ok && !acc.ok)

    setSignals(capExpired(sig.value.signals))
    setStrategySignals(stratSig.signals)
    setOrders(ord.orders)
    setAccounts(acc.value.accounts)
    setAccountLimit(acc.value.accountLimit)
    setBrokerLock((prev) => keepIfEqual(prev, acc.value.brokerLock))
    setTrends(Object.fromEntries((trd.trends || []).map((t) => [t.symbol, t])))
    setGlobalQuotes(Object.fromEntries((gq.quotes || []).map((q) => [q.symbol, q])))
    setActiveSymbols((prev) => keepIfEqual(prev, sym.symbols || []))
    setLoaded(true)
  }, [])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // 兜底轮询：每 20 秒刷新一次活跃品种列表——EA 在 InpSymbols 里增删品种后，
  // 不需要等用户手动刷新页面，网页会在这个间隔内自动跟上。页面在后台时跳过，
  // 避免无意义请求；切回前台立即补一次。
  // Fallback polling: refresh the active-symbol list every 20s, so adding or
  // removing a symbol in the EA's InpSymbols is picked up without a manual
  // page refresh. Skipped while backgrounded; refetches immediately on
  // returning to the foreground.
  useEffect(() => {
    const poll = () => {
      symbolApi.list().then((r) => setActiveSymbols((prev) => keepIfEqual(prev, r.symbols || []))).catch(() => {})
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) poll()
    }, 20000)
    const onVisible = () => { if (!document.hidden) poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // 兜底轮询：每 5 秒刷新一次账号在线状态，防止 WebSocket 推送丢失导致状态卡住。
  // 配合后端 ~7s 在线窗口与离线检测任务，断线可在数秒内置灰。
  // 页面在后台（切到别的 App、手机息屏）时跳过，避免无意义耗电；切回前台
  // 立即补一次，不用等最多 5 秒才刷新出最新状态。
  // Fallback polling: refresh account online status every 5s in case a WS push
  // is missed, so a disconnect greys out within seconds alongside the backend
  // monitor. Skipped while the page is backgrounded (switched app, screen
  // locked) to avoid pointless battery drain; refetches immediately on
  // returning to the foreground instead of waiting up to 5s for the next tick.
  // 会话中途后端挂掉时，refreshAll 不会再跑（它只在挂载与少数动作时触发），
  // 所以那条判据覆盖不到。这个 5 秒轮询是全站最稳定的心跳，连续失败即可作为
  // 第二条证据。要求连续 3 次（约 15 秒）而不是 1 次：偶发的网络抖动、部署时
  // 的一两秒 502 都会失败一次，据此弹红条只会制造噪音，等用户学会忽略它，真
  // 出事时也就没人看了。任一次成功立刻复位。
  // A mid-session outage isn't covered by refreshAll's check (it only runs on
  // mount and on a few actions). This 5s poll is the steadiest heartbeat in the
  // app, so a run of failures is the second piece of evidence. Three in a row
  // (~15s) rather than one: a transient network blip or a second of 502 during a
  // deploy fails once, and flashing a red banner for that just trains users to
  // ignore it — by the time something real happens, nobody is reading it. Any
  // success resets it immediately.
  const accountFailStreak = useRef(0)
  useEffect(() => {
    const poll = () => {
      accountApi
        .list()
        .then((r) => {
          accountFailStreak.current = 0
          setBackendUnreachable(false)
          setAccounts((prev) => keepIfEqual(prev, r.accounts))
        })
        .catch(() => {
          accountFailStreak.current += 1
          if (accountFailStreak.current >= 3) setBackendUnreachable(true)
        })
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) poll()
    }, 5000)
    const onVisible = () => { if (!document.hidden) poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
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
      case 'STRATEGY_SIGNAL':
        // 命中即推：与 SIGNAL_NEW 同样的"新增插到最前"模式,只是没有过期概念
        // (个人策略信号不会像平台信号那样被标记 EXPIRED)。
        // Pushed on fire, same "prepend" pattern as SIGNAL_NEW — no expiry
        // concept here (personal strategy signals are never marked EXPIRED
        // the way platform signals are).
        setStrategySignals((prev) => [msg.data as StrategySignal, ...prev].slice(0, 50))
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
      case 'POSITIONS':
        setPositions((prev) => keepIfEqual(prev, (msg.data as Position[]) || []))
        break
      case 'QUOTES': {
        // 按交易商账户区分的报价（下单确认页用），合并变化项到现有快照
        // Per-broker-account quotes (order-confirmation pages), merge changed
        // entries into the snapshot
        const list = (msg.data as Quote[]) || []
        if (list.length === 0) break
        setQuotes((prev) => {
          const next = { ...prev }
          for (const q of list) {
            if (!q.login) continue
            next[q.login] = { ...next[q.login], [q.symbol]: q }
          }
          return next
        })
        break
      }
      case 'GLOBAL_QUOTES': {
        // 全站统一展示报价（EA 推送），合并变化的报价到现有快照
        // Site-wide display quotes (EA-pushed); merge changed entries into the snapshot
        const list = (msg.data as Quote[]) || []
        if (list.length === 0) break
        setGlobalQuotes((prev) => {
          const next = { ...prev }
          for (const q of list) next[q.symbol] = q
          return next
        })
        // 顺带把没见过的新品种加进活跃列表——EA 新增品种后不用等 20 秒轮询，
        // 第一条报价一到就能立刻出现。移除品种仍靠轮询的活跃窗口过期判定。
        // Also fold any never-seen symbol into the active list — a symbol the
        // EA newly starts pushing shows up the instant its first quote
        // arrives, instead of waiting for the 20s poll. Removal still relies
        // on the poll's freshness-window expiry.
        setActiveSymbols((prev) => {
          const fresh = list.map((q) => q.symbol).filter((s) => !prev.includes(s))
          return fresh.length === 0 ? prev : [...prev, ...fresh].sort()
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
      signals, strategySignals, orders, trends, activeSymbols, accounts, accountLimit, brokerLock, loaded,
      anyOnline, onlineAccounts, refreshAll, wsConnected, wsDisconnected, backendUnreachable,
    }),
    [signals, strategySignals, orders, trends, activeSymbols, accounts, accountLimit, brokerLock, loaded,
     anyOnline, onlineAccounts, refreshAll, wsConnected, wsDisconnected, backendUnreachable]
  )

  return (
    <LiveContext.Provider value={value}>
      <PositionsContext.Provider value={positions}>
        <QuotesContext.Provider value={quotes}>
          <GlobalQuotesContext.Provider value={globalQuotes}>
            {children}
          </GlobalQuotesContext.Provider>
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

// 只订阅按交易商账户区分的报价（下单确认页用），避免因信号/账号变化而重渲染
// Subscribe to per-broker-account quotes only (order-confirmation pages)
export function useQuotes() {
  return useContext(QuotesContext)
}

// 只订阅全站统一展示报价（EA 推送），避免因信号/账号变化而重渲染
// Subscribe to the site-wide display quotes only (EA-pushed)
export function useGlobalQuotes() {
  return useContext(GlobalQuotesContext)
}

// 只订阅持仓 / subscribe to positions only
export function usePositions() {
  return useContext(PositionsContext)
}
