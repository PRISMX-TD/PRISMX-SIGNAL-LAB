// 订单与回执页 / Orders & receipts page
//
// 2026-09-08 重做视觉（样式见 styles/orders.css）：三个页签共用页头（眉题 + 标题 +
// 账号药丸 + 光谱线）；操作记录从表格改成「一行一张回执单」；绩效分析只剩净盈亏、
// 胜率、品种盈亏三样加已平仓明细；持仓页签的账户信息改成账本条。数据流与筛选 /
// 分页逻辑没有变，下面那些注释仍然有效。
// Visual redesign 2026-09-08 (styles in styles/orders.css): one shared head; the
// activity log became one receipt slip per order; the performance tab is just
// net P&L, win rate, P&L by symbol plus the closed-trade list; the account bar
// became a ledger strip. Data flow, filtering and paging are unchanged.
//
// 2026-09-11 手机版重排（只动 ≤767px，桌面不变）：持仓页签第一屏原来要滑过标题副题、
// 折成两行的账号药丸和六格竖着摊开的账本条才看得见自己的仓位。现在页头副题在手机上
// 隐藏、账号药丸与状态芯片压成一条横滑、账本条搬到仓位卡之后并改成发丝线账本行，
// 作用范围小字跟到卡片下面。顺序靠 .ord-ptab / .ord-pos 两层包裹的 flex order 换，
// 桌面上这两层是 display:contents。
// Mobile rearrangement 2026-09-11 (≤767px only): the positions tab used to bury
// the user's own positions under the head, a two-row pill wrap and a six-cell
// ledger. The subtitle now hides on phones, pills and status chips became single
// horizontal scrollers, and the ledger moved below the position cards as a
// hairline row list with the scope note trailing the cards. The reordering rides
// on flex order in .ord-ptab / .ord-pos, which are display:contents on desktop.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import Pager from '../components/Pager'
import { useAuth } from '../store/auth'
import { useLive, usePositions } from '../store/live'
import { usePrefs } from '../store/prefs'
import { orderApi } from '../api/client'
import { baseSymbol, displaySymbol, localizeApiError } from '../api/utils'
import type { ClosedTrade, Order, OrderStatus } from '../api/types'
import PositionCard from '../components/PositionCard'
import PerformanceSummary from '../components/PerformanceSummary'
import ClosedTradesList from '../components/ClosedTradesList'
import AutoManageCard from '../components/AutoManageCard'
import OnboardingCard from '../components/OnboardingCard'
import PageHead from '../components/PageHead'
import { usePartnerBroker } from '../components/PartnerBrokerCard'
import { symbolMeta } from '../utils/symbolMeta'

type StatusFilter = 'ALL' | OrderStatus
const STATUS_FILTERS: StatusFilter[] = ['ALL', 'PENDING', 'FILLED', 'REJECTED', 'FAILED', 'CANCELLED']

// 页面分三个 Tab：实时（持仓与账户）、回顾（绩效分析）、查询（操作记录）。
// 三者节奏完全不同，摊在一条滚动线上会让页面过长；分开后每屏只回答一个问题。
// Tab 选择记在 localStorage，刷新后仍停在原来那个 Tab。
// Three tabs: live (positions & account), retrospective (performance), lookup
// (activity log). Their rhythms differ completely, and stacking them made one
// endless scroll; split, each screen answers one question. The choice persists
// in localStorage so a refresh keeps you on the same tab.
type OrdersTab = 'positions' | 'performance' | 'activity'
const TAB_STORAGE_KEY = 'prismx.orders.tab'
const TABS: OrdersTab[] = ['positions', 'performance', 'activity']

// 时间全部按 UTC+8 显示，与 fmtTime 同一时区；没带时区的 ISO 串按 UTC 解。
// All times render in UTC+8 like fmtTime; a zone-less ISO string is read as UTC.
const TZ = 'Asia/Shanghai'
function parseIso(iso: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z')
}
function clockOf(iso: string): string {
  return parseIso(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function dayKeyOf(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }) // YYYY-MM-DD
}
// 成交价：整数位与小数位拆开，小数位在回执单上降一号。
// Fill price split into integer and fraction; the fraction renders one size down.
function priceParts(n: number): { int: string; frac: string | null } {
  const s = n.toLocaleString('en-US', { maximumFractionDigits: 5 })
  const i = s.indexOf('.')
  return i < 0 ? { int: s, frac: null } : { int: s.slice(0, i), frac: s.slice(i + 1) }
}
const money2 = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function OrdersPage() {
  const { t, i18n } = useTranslation()
  const { user, refreshUser } = useAuth()
  const { orders, accounts, refreshAll, closedTradeTick } = useLive()
  // gateway 账号不落库券商名，账户横条的券商列回落到合作券商名（与绑定页一致）
  // Gateway rows don't store a company; the account bar's broker falls back to
  // the partner broker name, matching the bind page.
  const { name: brokerName } = usePartnerBroker()
  const positions = usePositions()
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const [statusF, setStatusF] = useState<StatusFilter>('ALL')
  const [symbolF, setSymbolF] = useState('')

  // 全页只有一个账号选择器：页头选中的账号同时决定账户横条、持仓、胜率卡、
  // 纪律分、已平仓明细和操作记录。以前账户卡和绩效区各有一套，点了上面那套
  // 发现下面数字没变，很容易误解成数据不对。声明放在最前面，因为下面的订单
  // 请求和各处派生值都要用它。
  // One account selector for the whole page: the header choice drives the
  // account bar, positions, win-rate card, closed trades and
  // the activity log alike. Previously the account card and the performance
  // section each had their own, so clicking one left the other's numbers
  // unchanged — easy to misread as bad data. Declared first because the order
  // fetch and several derived values below depend on it.
  //
  // 记住用户最后点的账号（prefs `orders.lastAccount`，按用户存后端、跨设备），下次
  // 进来默认还是它，而不是永远回到第一个。只在用户点击时写入；下面那条"选中的
  // 账号不在列表里就回落"是代码纠正状态，不写记忆——否则记忆的账号临时掉线一次
  // 就被冲掉（与 useLastAccount 同一原则）。与下单表单的 trade.lastAccount 分开存：
  // 这里看的是回执，不该改变默认下单账户。
  // Remembers the last clicked account (prefs `orders.lastAccount`, server-side
  // per user) so the page reopens on it instead of the first one. Written only
  // on an explicit click; the fallback below never writes, so a transient
  // dropout can't erase the preference. Kept separate from the order form's
  // trade.lastAccount — viewing receipts must not change the ordering default.
  const { getPref, setPref } = usePrefs()
  const rememberedLogin = getPref<string>('orders', 'lastAccount', '')
  const [selectedLogin, setSelectedLogin] = useState<string | null>(() => rememberedLogin || null)
  const touchedRef = useRef(false)
  const chooseLogin = (login: string) => { touchedRef.current = true; setSelectedLogin(login); setPref('orders', 'lastAccount', login) }
  useEffect(() => {
    if (accounts.length === 0) return
    const remembered = rememberedLogin && accounts.some((a) => a.login === rememberedLogin) ? rememberedLogin : null
    if (selectedLogin === null || !accounts.some((a) => a.login === selectedLogin)) {
      setSelectedLogin(remembered ?? accounts[0].login)
    } else if (!touchedRef.current && remembered && remembered !== selectedLogin) {
      // 记忆从云端晚到（新设备没本地缓存）：用户还没点过就补应用
      // Memory arriving late from the cloud (fresh device): apply it if the user hasn't clicked yet
      setSelectedLogin(remembered)
    }
  }, [accounts, selectedLogin, rememberedLogin])
  const activeAccount = accounts.find((a) => a.login === selectedLogin) ?? accounts[0]

  // 手机上账号药丸压成了一条横滑（styles/orders.css 的 ≤767px 段），四个账号里选中的
  // 那个常常在屏幕外——横滑条自己不会跟着选中态走。这里把它滚进视野中间；只动容器的
  // scrollLeft，不用 scrollIntoView（那会连页面一起纵向滚，把持仓卡顶掉）。
  // The account pills collapse into one horizontal scroller on phones, where the
  // selected one is often off-screen. Bring it into view by setting the container's
  // scrollLeft only — scrollIntoView would also scroll the page vertically and push
  // the position cards out of the first screen.
  const pillsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const box = pillsRef.current
    if (!box || box.scrollWidth <= box.clientWidth) return
    const on = box.querySelector<HTMLElement>('.ord-acct.on')
    if (!on) return
    const left = on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2
    box.scrollLeft = Math.max(0, left)
  }, [selectedLogin, accounts.length])

  const [tab, setTab] = useState<OrdersTab>(() => {
    const saved = localStorage.getItem(TAB_STORAGE_KEY)
    return TABS.includes(saved as OrdersTab) ? (saved as OrdersTab) : 'positions'
  })
  useEffect(() => { localStorage.setItem(TAB_STORAGE_KEY, tab) }, [tab])

  // 操作记录：每页 10 条。不设日期筛选时用 useLive().orders（WS 实时更新、秒级
  // 新鲜，覆盖最近约 100 条），在本地按 10 条一页切片——下单/成交能即时看到，
  // 翻页也不发请求。一旦设了日期区间，改成向后端按 offset/limit(=10) 请求那段
  // 历史（可翻到实时那 100 条之外的旧单），不影响实时跟踪用的那份 orders 状态。
  // Activity log: 10 rows per page. With no date filter it uses
  // useLive().orders (WS-live, always fresh, ~latest 100) and client-slices by
  // 10 — new fills show instantly and paging costs no request. Once a date
  // range is set it switches to a backend fetch (offset/limit=10) for that
  // window, reaching history beyond the live 100, without touching the orders
  // state used for real-time tracking.
  const ORDERS_PAGE_SIZE = 10
  const [sinceF, setSinceF] = useState('')
  const [untilF, setUntilF] = useState('')
  const [page, setPage] = useState(0)
  const [serverOrders, setServerOrders] = useState<Order[] | null>(null)
  const [serverTotal, setServerTotal] = useState(0)
  const [pageLoading, setPageLoading] = useState(false)
  const dateFilterActive = !!sinceF || !!untilF

  useEffect(() => {
    if (!dateFilterActive) { setServerOrders(null); return }
    let alive = true
    setPageLoading(true)
    // until 传"选中截止日 + 1 天"的零点，让用户选的截止日本身也算在内
    // (后端用 < 而非 <=)。/ pass "selected end date + 1 day" at midnight so
    // the picked end date itself is included (backend uses < not <=).
    const untilParam = untilF
      ? new Date(new Date(untilF + 'T00:00:00Z').getTime() + 24 * 3600 * 1000).toISOString()
      : undefined
    orderApi.list({
      limit: ORDERS_PAGE_SIZE,
      offset: page * ORDERS_PAGE_SIZE,
      since: sinceF ? `${sinceF}T00:00:00Z` : undefined,
      until: untilParam,
      login: selectedLogin ?? undefined,
    })
      .then((r) => { if (alive) { setServerOrders(r.orders); setServerTotal(r.total) } })
      .catch(() => { if (alive) { setServerOrders([]); setServerTotal(0) } })
      .finally(() => { if (alive) setPageLoading(false) })
    return () => { alive = false }
  }, [dateFilterActive, page, sinceF, untilF, selectedLogin])

  // 账号过滤分两条路：设了日期筛选走后端（login 参数，见上），否则在实时集合上
  // 本地过滤。两条路都限定在选中的那个账号内，页码统计也跟着走。
  // Account filtering takes two paths: with a date filter the backend does it
  // (login param, above); otherwise filter the live set locally. Both stay
  // within the selected account, and the page counts follow suit.
  const baseOrders = useMemo(() => {
    const source = dateFilterActive ? (serverOrders ?? []) : orders
    if (dateFilterActive || !selectedLogin) return source
    return source.filter((o) => String(o.mt5Login ?? '') === String(selectedLogin))
  }, [dateFilterActive, serverOrders, orders, selectedLogin])

  const isPro = user?.plan === 'PRO'

  useEffect(() => {
    refreshUser()                        // 每次进入页面刷新 plan，确保管理员升级后即时生效
  }, [])

  // 已平仓明细一次拉全（接口不分页），按页头选中的账号在前端过滤——与胜率卡、
  // 纪律分用的是同一份数据源，所以数字和明细永远对得上。
  // Closed trades are fetched in full (the endpoint isn't paginated) and
  // filtered client-side by the header's account — the same data source the
  // win-rate card uses, so the aggregates always agree
  // with the records shown beneath them.
  const [trades, setTrades] = useState<ClosedTrade[] | null>(null)

  useEffect(() => {
    let mounted = true
    const load = () => {
      orderApi.closedTrades()
        .then((r) => { if (mounted) setTrades(r.trades) })
        .catch(() => { if (mounted) setTrades((prev) => prev ?? []) })
    }
    load()
    const timer = window.setInterval(() => {
      if (!document.hidden) load()
    }, 45_000)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      mounted = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
    // closedTradeTick 变化 = 后端刚记下新平仓，立刻重拉而不是等 45 秒轮询。
    // 轮询保留：WS 断线期间它是唯一的兜底。
    // A bumped closedTradeTick means a new close just landed — refetch now
    // instead of waiting out the 45s poll, which stays as the fallback for
    // whenever the WS is down.
  }, [closedTradeTick])

  const visibleTrades = useMemo(() => {
    if (!trades) return trades
    return selectedLogin ? trades.filter((tr) => tr.mt5Login === selectedLogin) : trades
  }, [trades, selectedLogin])

  // 持仓也跟着页头的账号走。position.login 可能缺失（旧记录），此时不显示在
  // 单账号视角下，避免把别的账号的仓位算进汇总。
  // Positions follow the header's account too. position.login can be missing
  // on older records; those are left out of the single-account view rather than
  // risk counting another account's exposure in the summary.
  const visiblePositions = useMemo(
    () => (selectedLogin ? positions.filter((p) => String(p.login ?? '') === String(selectedLogin)) : positions),
    [positions, selectedLogin],
  )

  const showToast = (msg: string, kind: 'success' | 'error' | 'info' = 'success') => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ msg, kind })
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
    refreshAll()
  }

  const toastStyle =
    toast?.kind === 'error'
      ? 'border-down/40 bg-down/15 text-down'
      : toast?.kind === 'info'
        ? 'border-prism-600/40 bg-prism-600/15 text-prism-300'
        : 'border-up/40 bg-up/15 text-up'

  // 持仓汇总 / positions summary
  const posSummary = useMemo(() => {
    let pnl = 0
    let buy = 0
    let sell = 0
    for (const p of visiblePositions) {
      pnl += p.profit
      if (p.side === 'BUY') buy += 1
      else sell += 1
    }
    return { pnl, buy, sell, total: visiblePositions.length }
  }, [visiblePositions])

  // 品种搜索框按用户看到的名字来，BTCUSD 展示成 BTCUSDT 后，搜索框也得认
  // "BTCUSDT" 才能搜出那些行，不能只匹配后端原始的 BTCUSD 字符串。
  // The symbol search box should match what the user actually sees — now
  // that BTCUSD displays as BTCUSDT, typing "BTCUSDT" must still find
  // those rows, not just the raw backend BTCUSD string.
  const symbolQuery = symbolF.trim().toLowerCase()
  const matchesSymbol = (o: Order) =>
    !symbolQuery || o.symbol.toLowerCase().includes(symbolQuery) || displaySymbol(o.symbol).toLowerCase().includes(symbolQuery)

  const filteredOrders = useMemo(() => {
    return baseOrders.filter((o) => {
      if (statusF !== 'ALL' && o.status !== statusF) return false
      return matchesSymbol(o)
    })
  }, [baseOrders, statusF, symbolQuery])

  // 状态筛选芯片上的计数：按品种筛完、还没按状态筛的那一份来数。日期筛选时集合
  // 在服务端分页，前端只拿到一页，数不出全量——那时不显示计数。
  // Counts on the status chips come from the set after the symbol filter but
  // before the status filter. Under a date filter the set is server-paged and
  // only one page is here, so no counts are shown.
  const statusCounts = useMemo(() => {
    if (dateFilterActive) return null
    const c: Partial<Record<StatusFilter, number>> = { ALL: 0 }
    for (const o of baseOrders) {
      if (!matchesSymbol(o)) continue
      c.ALL = (c.ALL ?? 0) + 1
      c[o.status] = (c[o.status] ?? 0) + 1
    }
    return c
  }, [baseOrders, symbolQuery, dateFilterActive])

  // 状态/品种筛选变化时回到第一页，避免停在一个筛选后已不存在的页码上。
  // 日期筛选的回第一页放在各自的 onChange 里同步做（见下方日期输入框），这样切到
  // 服务端分页时不会先按旧页码多发一次请求。
  // Reset to page 0 when the status/symbol filters change. Date-filter
  // resets happen synchronously in their own onChange handlers (see the date
  // inputs below) so switching into server pagination doesn't fire an extra
  // request at the stale page first.
  useEffect(() => { setPage(0) }, [statusF, symbolF, selectedLogin])

  // 分页派生：日期筛选时服务端每页只取 10 条（serverTotal 为该区间总数）；否则在
  // 实时集合上本地切 10 条一页。safePage 夹紧，防止数据刷新后停在越界页码。
  // Pagination: with a date filter the server returns 10 per page (serverTotal
  // is the range total); otherwise slice the live set locally, 10 per page.
  // safePage clamps so a live refresh can't leave us on an out-of-range page.
  const totalPages = dateFilterActive
    ? Math.max(1, Math.ceil(serverTotal / ORDERS_PAGE_SIZE))
    : Math.max(1, Math.ceil(filteredOrders.length / ORDERS_PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const visibleOrders = dateFilterActive
    ? filteredOrders
    : filteredOrders.slice(safePage * ORDERS_PAGE_SIZE, safePage * ORDERS_PAGE_SIZE + ORDERS_PAGE_SIZE)
  const pageTotal = dateFilterActive ? serverTotal : filteredOrders.length

  // 回执单按日分组（UTC+8）：今天 / 昨天 / MM-DD 周几。
  // Slips grouped by day (UTC+8): today / yesterday / MM-DD weekday.
  const dayGroups = useMemo(() => {
    const now = new Date()
    const todayKey = dayKeyOf(now)
    const yesterdayKey = dayKeyOf(new Date(now.getTime() - 86_400_000))
    const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-GB'
    const groups: { key: string; label: string; sub: string; items: Order[] }[] = []
    for (const o of visibleOrders) {
      const d = parseIso(o.createdAt)
      const key = dayKeyOf(d)
      let g = groups[groups.length - 1]
      if (!g || g.key !== key) {
        const md = key.slice(5)
        const weekday = d.toLocaleDateString(locale, { timeZone: TZ, weekday: 'short' })
        g = key === todayKey
          ? { key, label: t('orders.day.today'), sub: `${md} ${weekday}`, items: [] }
          : key === yesterdayKey
            ? { key, label: t('orders.day.yesterday'), sub: `${md} ${weekday}`, items: [] }
            : { key, label: md, sub: weekday, items: [] }
        groups.push(g)
      }
      g.items.push(o)
    }
    return groups
  }, [visibleOrders, i18n.language, t])

  // 印章落下的动画只在状态真的变了（WS 推来回执）时播一次：记住每条上次渲染的
  // 状态，本次不同就给印章加 land。首屏没有"上次"，所以不播。
  // The stamp-drop animation plays only when a status actually changed (a
  // receipt arrived over WS): remember each order's last rendered status and
  // mark the stamp when it differs. First paint has no "last", so nothing plays.
  const seenStatus = useRef<Map<string, OrderStatus>>(new Map())
  const landed = new Set<string>()
  for (const o of visibleOrders) {
    const prev = seenStatus.current.get(o.id)
    if (prev && prev !== o.status) landed.add(o.id)
  }
  useEffect(() => {
    for (const o of visibleOrders) seenStatus.current.set(o.id, o.status)
  })

  const doCancel = async (id: string) => {
    setCancellingId(id)
    try {
      await orderApi.cancel(id)
      showToast(t('orders.cancelSent'), 'info')
    } catch (e) {
      showToast(e instanceof Error ? localizeApiError(e.message) : 'error', 'error')
    } finally {
      setCancellingId(null)
    }
  }

  const accountLabel = activeAccount
    ? `${activeAccount.login} · ${activeAccount.company || (activeAccount.source === 'gateway' ? brokerName : '')}`.replace(/ · $/, '')
    : ''

  // 一张回执单 / one receipt slip
  const renderSlip = (o: Order, i: number) => {
    const meta = symbolMeta(baseSymbol(o.symbol))
    const shown = displaySymbol(o.symbol)
    const zhName = t(`signals.symbolNames.${baseSymbol(o.symbol)}`, { defaultValue: '' })
    const statusLabel = t(`orders.status.${o.status}`)
    const bad = o.status === 'REJECTED' || o.status === 'FAILED'
    const msg = o.message ? localizeApiError(o.message) : o.status === 'PENDING' ? t('orders.awaitingReceipt') : null
    const price = o.filledPrice != null ? priceParts(o.filledPrice) : null
    return (
      <article key={o.id} className="ord-slip" data-status={o.status} style={{ '--i': i } as CSSProperties}>
        <div className="ord-stub">
          <div className="ord-stub-t">{clockOf(o.createdAt)}</div>
          {/* 本地库里有少量旧行 action 是 'OPEN'（不在 OrderAction 枚举里），
              兜底成「开仓」而不是把 i18n 键名原样打出来。
              A few legacy rows carry action 'OPEN' (outside the OrderAction
              enum); fall back to "Open" rather than printing the raw i18n key. */}
          <div className="ord-stub-a">
            {t(`orders.action.${o.action ?? 'ORDER'}`, { defaultValue: t('orders.action.ORDER') })}
          </div>
        </div>
        <div className="ord-body">
          <div className="ord-ident">
            <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
            <span className="ord-name">{shown}</span>
            {zhName && zhName !== shown && <span className="ord-zh">{zhName}</span>}
            <span className={`tag ${o.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
              {o.side === 'BUY' ? t('common.buy') : t('common.sell')}
            </span>
            <span className="ord-vol">{o.volume}<small>{t('positions.lots')}</small></span>
          </div>
          {msg && <div className={`ord-msg ${bad ? 'bad' : ''}`}>{msg}</div>}
        </div>
        <div className="ord-price">
          <div className="ord-k">{t('orders.colPrice')}</div>
          <div className={`ord-v ${price ? '' : 'none'}`}>
            {price ? <>{price.int}{price.frac != null && <>.<span className="frac">{price.frac}</span></>}</> : '—'}
          </div>
        </div>
        <div className="ord-tk">
          <div className="ord-k">{t('orders.colTicket')}</div>
          <div className={`ord-v ${o.mt5Ticket ? '' : 'none'}`}>{o.mt5Ticket ? `#${o.mt5Ticket}` : '—'}</div>
        </div>
        <div className="ord-stampcell">
          {o.status === 'PENDING' && (
            <button
              type="button"
              onClick={() => doCancel(o.id)}
              disabled={cancellingId === o.id}
              className="btn rounded-pill border border-down/40 bg-down/10 text-down hover:bg-down/20"
            >
              {t('common.cancel')}
            </button>
          )}
          <span key={o.status} className={`ord-stamp ${landed.has(o.id) ? 'land' : ''}`}>
            {o.status}
            {statusLabel.toUpperCase() !== o.status && (
              <>
                <i />
                <span className="zh">{statusLabel}</span>
              </>
            )}
          </span>
        </div>
      </article>
    )
  }

  // 日期筛选请求中的骨架：贴合回执单的形状 / date-filter loading: slip-shaped skeletons
  const skeletonSlips = (
    <div className="ord-slips mt-5">
      {[0, 1, 2].map((i) => (
        <article key={i} className="ord-slip skel" aria-hidden>
          <div className="ord-stub"><span className="skeleton" style={{ display: 'block', width: 64, height: 14 }} /><span className="skeleton" style={{ display: 'block', width: 28, height: 10, marginTop: 10 }} /></div>
          <div className="ord-body"><span className="skeleton" style={{ display: 'block', width: '46%', height: 16 }} /></div>
          <div className="ord-price"><span className="skeleton" style={{ display: 'block', width: 80, height: 14, marginLeft: 'auto' }} /></div>
          <div className="ord-tk"><span className="skeleton" style={{ display: 'block', width: 70, height: 12, marginLeft: 'auto' }} /></div>
          <div className="ord-stampcell"><span className="skeleton" style={{ display: 'block', width: 104, height: 26, borderRadius: 4 }} /></div>
        </article>
      ))}
    </div>
  )

  return (
    <div>
      {/* 页头：全站统一的 PageHead，右侧是全页统一的账号切换器。原来这页自带一套
          「等宽大写眉题 + 42px 标题 + 光谱线」，2026-09-08 统一掉。
          Page head: the site-wide PageHead with the page-wide account switcher on
          the right. This page used to carry its own mono-caps eyebrow, 42px title
          and spectral rule; unified 2026-09-08. */}
      <PageHead
        className="ord-head"
        as="h1"
        title={t('orders.title')}
        subtitle={t('orders.subtitle')}
        actions={accounts.length > 1 ? (
          <div ref={pillsRef} className="ord-accts" role="tablist">
            {accounts.map((a) => (
              <button
                key={a.login}
                type="button"
                role="tab"
                aria-selected={a.login === selectedLogin}
                onClick={() => chooseLogin(a.login)}
                className={`ord-acct ${a.login === selectedLogin ? 'on' : ''} ${a.online ? 'online' : ''}`}
              >
                <span className="ord-acct-dot" />
                {a.login}
                {a.balance != null && <span className="ord-acct-bal">{money2(a.balance)}</span>}
              </button>
            ))}
          </div>
        ) : undefined}
      />

      {/* Tab 导航 / tab navigation */}
      <div className="seg-tabs mb-4 md:mb-6" role="tablist">
        {TABS.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={tab === key ? 'on' : ''}
          >
            {t(`orders.tab.${key}`)}
          </button>
        ))}
      </div>

      {tab === 'positions' && (
        <div className="ord-ptab">
          {/* 一个账号都没绑时，这个 Tab 原本只剩「暂无持仓」和一张用不了的自动
              仓管卡，账户横条因为 activeAccount 为 undefined 干脆不渲染——页面
              等于什么都没说。引导卡补上「下一步做什么」。
              With no account bound this tab was just "no open positions" plus an
              auto-manage card they can't use, and the account bar didn't render at
              all (activeAccount is undefined) — the page said nothing. The
              onboarding card supplies the next step. */}
          <OnboardingCard />

          {/* 账户账本条：详细的账号管理在 /account 页，这里只回答"这个账号现在什么
              状态"。两种连接方式展示同一组信息：登录号、状态、账户名、券商、余额、
              净值、杠杆；bridge 账号原来多带的 "@server" 后缀去掉，券商列已经回答了
              "这是哪家"。
              Account ledger strip: detailed account management lives on /account;
              this only answers "how is this account doing". Both connection types
              show one identical info set; the bridge-only "@server" suffix is gone
              because the broker column already answers "which broker". */}
          {activeAccount && (
            <div className="ord-acctwrap">
              <h3 className="ord-acct-h">{t('orders.acct.section')}</h3>
              <div className="ord-strip">
                <div className="ord-cell">
                  <div className="ord-k">{t('orders.acct.login')}</div>
                  <div className="ord-v">
                    {activeAccount.login}
                    <span className={activeAccount.online ? 'ord-pill-on' : 'ord-pill-off'}>
                      {activeAccount.online ? t('common.online') : t('common.offline')}
                    </span>
                  </div>
                </div>
                <div className="ord-cell ord-cell-wide">
                  <div className="ord-k">{t('bind.accountName')}</div>
                  <div className="ord-v sans">{activeAccount.accountName || '—'}</div>
                </div>
                <div className="ord-cell">
                  <div className="ord-k">{t('bind.company')}</div>
                  <div className="ord-v sans">{activeAccount.company || (activeAccount.source === 'gateway' ? brokerName : '—')}</div>
                </div>
                <div className="ord-cell">
                  <div className="ord-k">{t('account.balance')}</div>
                  <div className="ord-v">
                    {money2(activeAccount.balance)}
                    {activeAccount.accountCurrency && <small>{activeAccount.accountCurrency}</small>}
                  </div>
                </div>
                <div className="ord-cell">
                  <div className="ord-k">{t('account.equity')}</div>
                  <div className="ord-v">
                    {money2(activeAccount.equity)}
                    {activeAccount.accountCurrency && <small>{activeAccount.accountCurrency}</small>}
                  </div>
                </div>
                <div className="ord-cell">
                  <div className="ord-k">{t('account.leverage')}</div>
                  <div className="ord-v">{activeAccount.leverage ? `1:${activeAccount.leverage}` : '—'}</div>
                </div>
              </div>
            </div>
          )}

          {/* 持仓概览 / positions overview。手机上这一块靠 .ord-pos 的 flex order
              抬到账本条前面，作用范围小字则压到仓位卡下面——手机一屏只有 ~600px，
              先看到自己的单子比先读一句解释要紧。
              On phones this block is lifted above the account ledger by flex order
              on .ord-pos, and the scope note drops below the cards: a phone screen
              is ~600px, so the user's own positions come before the explanation. */}
          <div className="ord-pos">
            <div className="ord-sec">
              <h3>{t('orders.positions')}</h3>
              {visiblePositions.length > 0 && (
                <div className="ord-sec-sum">
                  <span>{t('orders.summary.positions')} <b>{posSummary.total}</b></span>
                  <span>
                    {t('common.buy')} <b className="text-up">{posSummary.buy}</b>
                    {' '}/{' '}
                    {t('common.sell')} <b className="text-down">{posSummary.sell}</b>
                  </span>
                  <span>
                    {t('orders.summary.totalPnl')}{' '}
                    <b className={posSummary.pnl >= 0 ? 'text-up' : 'text-down'}>
                      {posSummary.pnl >= 0 ? '+' : ''}
                      {posSummary.pnl.toFixed(2)}
                    </b>
                  </span>
                </div>
              )}
            </div>
            <p className="ord-p ord-pos-hint">{t('orders.positionsScopeHint')}</p>
            {visiblePositions.length === 0 ? (
              <p className="ord-pos-none py-8 text-sm text-neutral-500">{t('orders.noPositions')}</p>
            ) : (
              <div className="ord-pos-grid mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visiblePositions.map((p, i) => (
                  <PositionCard key={p.ticket ?? i} position={p} onActionDone={showToast} />
                ))}
              </div>
            )}
          </div>

          {/* 自动仓位管理：放在持仓下方（管理对象就是上面这些仓位，挨着看最直观），
              但必须显式划出来——它是每用户一条的全局配置（AutoManageSettings 的
              user_id 上有 unique 约束），不跟随页头的账号选择器，而本 Tab 其余内容
              都跟随。不加区分的话，用户在账号 A 下调完阈值、切到 B 看见同样的值，
              会以为"串号了"或"没保存上"。所以用一条分隔线 + 明确的作用范围说明把它
              和上面按账号过滤的区域隔开。
              Auto position management sits below the positions it acts on (most
              intuitive adjacent), but is deliberately set apart: it's a single
              per-user config (unique constraint on AutoManageSettings.user_id)
              that does NOT follow the page-head account selector, while
              everything else in this tab does. Without the separation, a user
              who tunes it under account A and switches to B sees identical
              values and reasonably concludes it leaked across accounts or
              failed to save. Hence the divider plus an explicit scope note. */}
          <AutoManageCard isPro={isPro} scopeHint={t('orders.autoManageScopeHint')} />
        </div>
      )}

      {/* 绩效分析：净盈亏 / 胜率 / 品种盈亏 + 已平仓明细，都跟着页头选中的账号
          （纪律分已于 2026-09-07 整体撤销）/ Performance: net P&L, win rate, P&L by
          symbol and the closed-trade list, all following the account selected in
          the page head (the discipline score was withdrawn on 2026-09-07) */}
      {tab === 'performance' && (
        <>
          <PerformanceSummary login={selectedLogin ?? undefined} accountLabel={accountLabel} />
          <ClosedTradesList trades={visibleTrades} />
        </>
      )}

      {/* 操作记录：只列选中账号的指令，一行一张回执单 /
          Activity log: scoped to the selected account, one receipt slip per order */}
      {tab === 'activity' && (
        <>
          {/* 筛选条：状态芯片（带计数）+ 品种 + 日期区间 / filter bar */}
          <div className="ord-tb">
            <div className="ord-chips" role="tablist" aria-label={t('orders.filterStatus')}>
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={statusF === s}
                  onClick={() => setStatusF(s)}
                  className={`ord-chip ${statusF === s ? 'on' : ''}`}
                >
                  {s === 'ALL' ? t('signals.all') : t(`orders.status.${s}`)}
                  {statusCounts && statusCounts[s] != null && <b>{statusCounts[s]}</b>}
                </button>
              ))}
            </div>
            <div className="ord-tb-r">
              <input
                value={symbolF}
                onChange={(e) => setSymbolF(e.target.value)}
                placeholder={t('orders.symbolPlaceholder')}
                aria-label={t('orders.filterSymbol')}
                className="input ord-in-sym w-36"
              />
              <div className="ord-tb-dates">
                <input
                  type="date"
                  value={sinceF}
                  max={untilF || undefined}
                  aria-label={t('orders.filterFrom')}
                  onChange={(e) => { setSinceF(e.target.value); setPage(0) }}
                  className="input"
                />
                <span className="ord-tb-sep">–</span>
                <input
                  type="date"
                  value={untilF}
                  min={sinceF || undefined}
                  aria-label={t('orders.filterTo')}
                  onChange={(e) => { setUntilF(e.target.value); setPage(0) }}
                  className="input"
                />
              </div>
              {dateFilterActive && (
                <button
                  type="button"
                  onClick={() => { setSinceF(''); setUntilF(''); setPage(0) }}
                  className="btn btn-ghost h-8 px-3 text-xs"
                >
                  {t('orders.clearDateFilter')}
                </button>
              )}
            </div>
          </div>

          {pageLoading && visibleOrders.length === 0 ? (
            skeletonSlips
          ) : visibleOrders.length === 0 ? (
            <div className="ord-ghost">
              <div className="ord-ghost-t">--:--:--</div>
              <div className="ord-ghost-b">
                <b>{t('orders.empty')}</b>
                <p>{t('orders.emptyHint')}</p>
              </div>
            </div>
          ) : (
            dayGroups.map((g, gi) => (
              <div key={g.key}>
                <div className="ord-day">
                  <div className="ord-day-d">{g.label}<span>{g.sub}</span></div>
                  <div className="ord-day-n">{t('orders.day.count', { n: g.items.length })}</div>
                </div>
                <div className="ord-slips">
                  {g.items.map((o, i) => renderSlip(o, gi * ORDERS_PAGE_SIZE + i))}
                </div>
              </div>
            ))
          )}

          {/* 分页：每页 10 条。不设日期筛选时在实时集合上本地翻页（新单即时可见）；
              设了日期筛选则向后端按页请求，可翻到实时那 100 条之外的历史订单。
              Pagination: 10 per page. Without a date filter, page the live set
              locally (new orders show instantly); with a date filter, page via the
              backend, reaching history beyond the live 100. */}
          {(visibleOrders.length > 0 || dateFilterActive) && (
            <Pager
              page={safePage}
              totalPages={totalPages}
              total={pageTotal}
              loading={pageLoading}
              onPrev={() => setPage(Math.max(0, safePage - 1))}
              onNext={() => setPage(Math.min(totalPages - 1, safePage + 1))}
              className="mt-5"
            />
          )}
        </>
      )}

      {toast && (
        <div
          className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastStyle}`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}
