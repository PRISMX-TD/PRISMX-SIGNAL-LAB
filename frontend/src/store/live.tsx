// 实时数据共享状态：EA 状态、信号、订单、持仓。
// Shared live state: EA status, signals, orders, positions.
import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react'
import type { BrokerLock, MT5Account, Order, PendingOrder, Position, Quote, Signal, StrategySignal, Trend, WSMessage } from '../api/types'
import { accountApi, orderApi, quoteApi, signalApi, strategyApi, symbolApi, trendApi } from '../api/client'
import { useClientSocket } from './useClientSocket'
import { usePrefs } from './prefs'
import { useAuth } from './auth'
import { showFallbackNotification } from '../utils/fallbackNotify'

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
  // 每有新平仓记录入库就自增。已平仓明细的接口不分页、也不走 WS 推送数据本身，
  // 所以这里只当一个「该重拉了」的信号——订阅方把它放进 useEffect 依赖即可，
  // 不必等各自的轮询间隔。
  // Bumped whenever a new closed trade lands. The closed-trades endpoint isn't
  // paginated and the records aren't pushed over WS, so this is purely a
  // "refetch now" signal: subscribers put it in a useEffect dependency instead
  // of waiting out their own poll interval.
  closedTradeTick: number
  // 新公告发布的计数器：每收到一条 ANNOUNCEMENT_NEW 加一，铃铛据此重新拉列表。
  // Bumps on every ANNOUNCEMENT_NEW so the bell refetches its list.
  announcementTick: number
  // 站内通知的同款计数器。与公告分开而不是共用一个：公告是广播给所有人的，
  // 站内通知只发给一个人，合并会让每条公告都白白触发一次 feed 重拉。
  // Same idea for in-app notifications, kept separate from announcementTick:
  // announcements are broadcast to everyone while a notification targets one
  // user, so sharing a counter would refetch the feed on every announcement.
  notificationTick: number
  // 本页自己改了通知的已读状态后调用它（一键已读就走这条），把两个计数器一起
  // 推一格，让铃铛重拉。没有它的话，在公告页按「全部已读」之后铃铛角标还挂着
  // 数字，直到下一次打开面板才对得上——服务端早就清了，界面在说假话。
  // Call after this page changed read state itself (mark-all-read does), bumping
  // both counters so the bell refetches. Without it, pressing "mark all read" on
  // the announcements page leaves a number on the bell until the panel is next
  // opened: the server is already clear and the UI is lying.
  refreshNotifications: () => void
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
// 券商那边真实挂着的挂单。与持仓分开放：两者变化频率、消费方都不同——挂单只在
// 用户下单/撤单/触发时才变，而持仓每一两秒就跟着浮盈动一次。
// Pending orders resting at the broker. Kept apart from positions: they change only
// when one is placed, cancelled or triggered, while positions move with every tick.
const PendingOrdersContext = createContext<PendingOrder[]>([])
// 账号实时浮动盈亏：login -> 该账号所有持仓的 profit 之和，随 POSITIONS 同拍下发。
// 与账号列表分开放，因为它和持仓一样高频；放进 LiveContext 会让整树跟着抖。
// 某 login 不在表里表示该账号当前没有持仓，浮盈按 0 处理（不是"未知"）。
// Per-account live floating P/L: login -> sum of that account's position profits,
// pushed on the same tick as POSITIONS. Kept out of LiveContext because it
// updates as often as positions do. A missing login means no open positions, so
// floating P/L is zero -- not unknown.
const AccountFundsContext = createContext<Record<string, number>>({})

// 失效信号最多保留的条数 / max number of expired signals to keep
const MAX_EXPIRED = 30

// 账号列表轮询间隔。曾经是 5 秒，因为账户卡片的余额只能靠它刷新。现在余额随
// ACCOUNTS_STATUS 推送、浮盈随持仓推送，这条轮询只剩两个职责：
//   ① 发现新绑定的账号（用户装好桥接后首次出现）；
//   ② 作为"后端不可达"的第二条判据（见下方 accountFailStreak）。
// 两者都不需要 5 秒粒度，而它每次要拉全量账号加订阅配置，所以放宽到 15 秒。
//
// Accounts poll interval. It used to be 5s because the account card's balance
// could only refresh through it. Now that balances ride on ACCOUNTS_STATUS and
// floating P/L rides on position pushes, this poll has just two jobs: spotting
// newly bound accounts, and acting as the second signal for "backend
// unreachable". Neither needs 5s granularity, and each request pulls the full
// account list plus subscription config, so it's relaxed to 15s.
const ACCOUNTS_POLL_MS = 15000

// 切回前台时，隐藏了至少这么久才整份重拉。短暂切走（回条消息、看一眼通知）连接
// 多半还活着、什么都没漏，不值得七个请求；隐藏够久则一切都可能变了：后台期间
// WS 被系统掐断而 onclose 没来（见 useClientSocket 的心跳说明）、套餐到期被降级、
// 另一台设备改了东西。网页版从不需要这条——手机浏览器会把后台标签页整页丢掉再
// 重载；安卓 App 的 WebView 被保活撑着一直活着，从不重载，只有它会撞上。
// On returning to the foreground, resync everything only if hidden at least
// this long. A brief switch-away (answering a message, glancing at a
// notification) most likely kept the socket alive and missed nothing, not worth
// seven requests; a long absence means anything may have changed: the socket
// cut by the OS with no onclose (see the heartbeat notes in useClientSocket),
// the plan downgraded on expiry, edits from another device. The web never needs
// this — mobile browsers discard and reload background tabs — but the Android
// WebView is kept alive and never reloads, so it is the one that hits it.
const RESUME_RESYNC_AFTER_MS = 60_000

// 连续多少次轮询失败才判定后端不可达。间隔从 5 秒放宽到 15 秒后，仍按 3 次会
// 让红条推迟到 45 秒才出现，太迟；降到 2 次即约 30 秒。不降到 1 次是因为部署时
// 的一两秒 502、偶发网络抖动都会失败一次，据此弹红条只会制造噪音。
// How many consecutive failures mark the backend unreachable. With the interval
// relaxed from 5s to 15s, keeping 3 would delay the banner to ~45s; 2 (~30s) is
// the balance. Not 1, because a transient 502 during a deploy or a network blip
// fails once, and a banner for that is just noise.
const ACCOUNTS_FAIL_THRESHOLD = 2

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
  // 只用它的 refreshUser；套餐与信号一起重拉（见下面 resync 的说明）。
  // Only refreshUser is used here; the plan is resynced alongside the signals.
  const { refreshUser } = useAuth()
  const refreshUserRef = useRef(refreshUser)
  refreshUserRef.current = refreshUser
  const [signals, setSignals] = useState<Signal[]>([])
  const [strategySignals, setStrategySignals] = useState<StrategySignal[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([])
  const [accountFunds, setAccountFunds] = useState<Record<string, number>>({})
  const [quotes, setQuotes] = useState<Record<string, Record<string, Quote>>>({})
  const [globalQuotes, setGlobalQuotes] = useState<Record<string, Quote>>({})
  const [trends, setTrends] = useState<Record<string, Trend>>({})
  const [activeSymbols, setActiveSymbols] = useState<string[]>([])
  const [accounts, setAccounts] = useState<MT5Account[]>([])
  const [accountLimit, setAccountLimit] = useState<number | null>(null)
  const [brokerLock, setBrokerLock] = useState<BrokerLock | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [backendUnreachable, setBackendUnreachable] = useState(false)
  const [closedTradeTick, setClosedTradeTick] = useState(0)
  const [announcementTick, setAnnouncementTick] = useState(0)
  const [notificationTick, setNotificationTick] = useState(0)
  const refreshNotifications = useCallback(() => {
    setAnnouncementTick((n) => n + 1)
    setNotificationTick((n) => n + 1)
  }, [])

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

  // 「掉过线」之后的整份重拉。此前所有数据只在挂载时拉一次，之后全靠 WS 增量推送：
  // 断线期间推过来的 SIGNAL_NEW / SIGNAL_EXPIRED / ORDER_UPDATE 全部丢失，重连后
  // 服务端只补推持仓与报价（ws.py），信号列表就此停在断线前那一刻。网页版每次打开
  // 都重新挂载，撞不上；安卓 App 的页面一活好几天，后台期间产生的信号在 App 里永远
  // 看不到，用户看到的就是"网页有信号、App 没有"。
  // 套餐搭同一趟车：`user.plan` 同样只在 Layout 挂载时刷过一次（PlanExpiryBanner），
  // 试用到期后 App 里缓存的仍是 PRO，而后端已按 FREE 只回过期信号，前端再按 PRO 把
  // 过期的全部藏掉——网格直接为空，这是同一类"从不重载"的病。
  // Full resync after having been disconnected. Everything used to be fetched
  // once on mount and then live on WS deltas alone: every SIGNAL_NEW /
  // SIGNAL_EXPIRED / ORDER_UPDATE pushed while disconnected is lost, and on
  // reconnect the server re-pushes only positions and quotes (ws.py), so the
  // signal list stays frozen at the moment the socket died. The web remounts on
  // every open and never hits this; the Android WebView lives for days, so any
  // signal fired while it was backgrounded never shows up there — "the web has
  // signals, the app doesn't". The plan rides along: `user.plan` was likewise
  // refreshed once on Layout mount (PlanExpiryBanner); after a trial expires the
  // app still holds PRO while the backend serves FREE's expired-only list, which
  // the PRO-side filter hides entirely — an empty grid from the same
  // never-reloads disease.
  const resync = useCallback(async () => {
    await Promise.all([refreshAll(), refreshUserRef.current()])
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

  // 兜底轮询（间隔见 ACCOUNTS_POLL_MS）：发现新绑定的账号，并兜住偶发丢失的
  // WS 推送。在线状态与余额的实时性由推送负责，不依赖这条轮询：账号掉线由后端
  // ~7s 在线窗口加离线检测任务在数秒内置灰。
  // 页面在后台（切到别的 App、手机息屏）时跳过，避免无意义耗电；切回前台立即
  // 补一次，不用等下一拍。
  // Fallback polling (interval: ACCOUNTS_POLL_MS): spots newly bound accounts and
  // covers the occasional dropped WS push. Liveness and balances come from pushes
  // rather than this poll — a disconnect greys out within seconds via the backend's
  // ~7s online window and offline monitor. Skipped while backgrounded (switched
  // app, screen locked) to avoid pointless battery drain; refetches immediately on
  // returning to the foreground instead of waiting for the next tick.
  // 会话中途后端挂掉时，refreshAll 不会再跑（它只在挂载与少数动作时触发），所以
  // 那条判据覆盖不到。这条轮询是全站最稳定的心跳，连续失败即可作为第二条证据；
  // 阈值见 ACCOUNTS_FAIL_THRESHOLD，任一次成功立刻复位。
  // A mid-session outage isn't covered by refreshAll's check (it only runs on
  // mount and on a few actions). This poll is the steadiest heartbeat in the app,
  // so a run of failures is the second piece of evidence; the threshold is
  // ACCOUNTS_FAIL_THRESHOLD, and any success resets it immediately.
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
          if (accountFailStreak.current >= ACCOUNTS_FAIL_THRESHOLD) setBackendUnreachable(true)
        })
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) poll()
    }, ACCOUNTS_POLL_MS)
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
      case 'ANNOUNCEMENT_NEW':
        setAnnouncementTick((n) => n + 1)
        break
      case 'NOTIFICATION_NEW':
        // 帧里不带内容，只是「去重拉一次」的信号——渲染字段由 /notifications/feed
        // 一处提供，不在 WS 帧里再抄一份。
        // The frame carries no payload: it's a "refetch now" signal, keeping the
        // render fields in /notifications/feed alone rather than duplicated here.
        setNotificationTick((n) => n + 1)
        break
      case 'PUSH_FALLBACK':
        // 收不到推送的设备（大陆连不上 FCM）才会真的弹——判定全在后端，这台设备
        // 有没有推送订阅的判断在 showFallbackNotification 里，见那个文件的头注释。
        // 有订阅的 Web / PWA 用户走到这里是空操作，行为一个字节不变。
        void showFallbackNotification(msg.data)
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
      case 'POSITIONS': {
        setPositions((prev) => keepIfEqual(prev, (msg.data as Position[]) || []))
        // funds 与 data 同拍，账户卡片因此能和持仓表用同一份浮盈。
        // 整表替换而非合并：后端只下发"有持仓的账号"，合并会让已平完仓的账号
        // 停在旧浮盈上。
        // funds arrives on the same tick, so the account card shares the
        // positions table's numbers. Replace rather than merge: the backend only
        // sends accounts that have positions, so merging would leave a stale
        // figure on an account whose last position just closed.
        const nextFunds: Record<string, number> = {}
        for (const f of msg.funds || []) {
          if (!f?.login || typeof f.profit !== 'number') continue
          nextFunds[f.login] = f.profit
        }
        setAccountFunds((prev) => keepIfEqual(prev, nextFunds))
        break
      }
      case 'PENDING_ORDERS': {
        // 整表替换（与 POSITIONS 同一语义）：后端推的是该用户全部账号的挂单快照。
        // 只有真收到这一帧才替换——旧版桥接不上报挂单时后端根本不推，前端保留
        // 现有列表而不是清空。/ Whole-table replace, same as POSITIONS. The frame only
        // arrives when a channel actually reported, so an old bridge that reports no
        // pending orders leaves the list alone instead of blanking it.
        setPendingOrders((prev) => keepIfEqual(prev, (msg.data as PendingOrder[]) || []))
        break
      }
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
      case 'CLOSED_TRADE_NEW':
        // 后端刚记下一笔新平仓（Bridge 上报或 Gateway 扫描）。消息不带数据，
        // 只是催订阅方重拉，省得等 45 秒轮询。
        // A new closed trade just landed (bridge report or gateway scan). The
        // message carries no payload — it just nudges subscribers to refetch.
        setClosedTradeTick((n) => n + 1)
        break
      case 'ACCOUNTS_STATUS': {
        // 账号在线状态或余额发生变化。两者都直接就地更新：
        // 余额随消息带过来，不必为了拿它再请求一次 /bridge/accounts。
        // Account liveness or balance changed. Both are applied in place; the
        // balance rides along, so no extra /bridge/accounts request is needed.
        const data = msg.data as { onlineLogins?: string[]; balances?: Record<string, number> }
        const online = new Set(data?.onlineLogins || [])
        const balances = data?.balances
        setAccounts((prev) =>
          keepIfEqual(
            prev,
            prev.map((a) => {
              const next = { ...a, online: online.has(a.login) }
              // 只更新推送里出现的账号。未出现不代表余额归零，可能是该账号
              // 当前离线、或来自 gateway 这条不走本推送的链路——一律保留原值。
              // Only touch logins present in the push. Absence doesn't mean zero:
              // the account may be offline, or come from the gateway path which
              // doesn't use this message. Keep the existing value either way.
              if (balances && a.login in balances) next.balance = balances[a.login]
              return next
            }),
          ),
        )
        break
      }
    }
  }, [applyRemotePrefs])

  const wsConnected = useClientSocket(handleMessage)

  // 重连成功（不是首次连上）就整份重拉——首次连接由挂载那次 refreshAll 覆盖。
  // 心跳判死的僵尸连接也走这里：dropDeadConnection → 新连接 AUTH_OK → 此处。
  // Resync on every reconnect (not the first connection — mount already fetched).
  // A zombie declared dead by the heartbeat lands here too: dropDeadConnection →
  // fresh AUTH_OK → this effect.
  const sawConnection = useRef(false)
  useEffect(() => {
    if (!wsConnected) return
    if (sawConnection.current) void resync()
    sawConnection.current = true
  }, [wsConnected, resync])

  // 切回前台且隐藏够久（RESUME_RESYNC_AFTER_MS）也整份重拉。与上面那条会在同一次
  // 回前台时先后各跑一次（先这条，几秒后重连那条），两轮都是轻请求；不去合并，
  // 因为两者的语义不同：这条兜的是"连接没断但世界变了"（套餐到期、别的设备改了
  // 东西），上面那条兜的是"断线期间漏掉的推送"。
  // Also resync on returning to the foreground after a long enough absence. On
  // one resume both may run (this one first, the reconnect one seconds later);
  // both are light, and they are deliberately not merged because they cover
  // different things: this one "the socket held but the world changed" (plan
  // expiry, edits elsewhere), the other "pushes missed while disconnected".
  useEffect(() => {
    let hiddenAt: number | null = null
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt != null && Date.now() - hiddenAt >= RESUME_RESYNC_AFTER_MS) void resync()
      hiddenAt = null
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [resync])

  // 曾经连上过之后又断开，才提示"已断线"，避免首次连接前的瞬间误报。
  //
  // 用 state 而不是「渲染期写 ref」：`if (wsConnected) ref.current = true` 是渲染
  // 阶段的副作用，StrictMode 的双渲染下结果侥幸正确，但并发特性（useTransition /
  // Suspense 重放）会在一次被丢弃的渲染里就把它置真，断线横幅因此可能早一拍出现。
  // 置真是单向的，所以 setState 只在第一次连上时跑一次，不会多出渲染轮次。
  //
  // State rather than a ref written during render: `if (wsConnected)
  // ref.current = true` is a render-phase side effect. It happens to survive
  // StrictMode's double render, but under concurrent features (useTransition,
  // Suspense replays) a discarded render would already have flipped it, making
  // the offline banner appear a beat early. The flag is one-way, so this
  // setState runs exactly once — on the first successful connection — and adds
  // no repeated render passes.
  const [everConnected, setEverConnected] = useState(false)
  useEffect(() => {
    if (wsConnected) setEverConnected(true)
  }, [wsConnected])
  const wsDisconnected = everConnected && !wsConnected

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
      closedTradeTick, announcementTick, notificationTick, refreshNotifications,
    }),
    [signals, strategySignals, orders, trends, activeSymbols, accounts, accountLimit, brokerLock, loaded,
     anyOnline, onlineAccounts, refreshAll, wsConnected, wsDisconnected, backendUnreachable,
     closedTradeTick, announcementTick, notificationTick, refreshNotifications]
  )

  return (
    <LiveContext.Provider value={value}>
      <PositionsContext.Provider value={positions}>
        <PendingOrdersContext.Provider value={pendingOrders}>
          <AccountFundsContext.Provider value={accountFunds}>
            <QuotesContext.Provider value={quotes}>
              <GlobalQuotesContext.Provider value={globalQuotes}>
                {children}
              </GlobalQuotesContext.Provider>
            </QuotesContext.Provider>
          </AccountFundsContext.Provider>
        </PendingOrdersContext.Provider>
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

// 只订阅挂单 / subscribe to pending orders only
export function usePendingOrders() {
  return useContext(PendingOrdersContext)
}

// 只订阅账号实时浮动盈亏：login -> profit 之和。
// 表里没有某 login 表示该账号当前无持仓，浮盈为 0。
// Subscribe to per-account live floating P/L only: login -> summed profit.
// A login absent from the map has no open positions, so its P/L is zero.
export function useAccountFunds() {
  return useContext(AccountFundsContext)
}
