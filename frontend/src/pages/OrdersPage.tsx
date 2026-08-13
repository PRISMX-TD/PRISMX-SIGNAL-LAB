// 订单与回执页 / Orders & receipts page
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'
import { useLive, usePositions } from '../store/live'
import { orderApi } from '../api/client'
import { displaySymbol, fmtTime, localizeApiError } from '../api/utils'
import type { ClosedTrade, Order, OrderStatus } from '../api/types'
import PositionCard from '../components/PositionCard'
import PersonalWinRateCard from '../components/PersonalWinRateCard'
import DisciplineScoreCard from '../components/DisciplineScoreCard'
import ClosedTradesList from '../components/ClosedTradesList'
import AutoManageCard from '../components/AutoManageCard'
import OnboardingCard from '../components/OnboardingCard'
import { symbolMeta } from '../utils/symbolMeta'

const statusStyle: Record<OrderStatus, string> = {
  PENDING: 'bg-amber-500/15 text-amber-400',
  FILLED: 'bg-up/15 text-up',
  REJECTED: 'bg-down/15 text-down',
  FAILED: 'bg-down/15 text-down',
  CANCELLED: 'bg-white/10 text-neutral-400',
}

type StatusFilter = 'ALL' | OrderStatus
type SideFilter = 'ALL' | 'BUY' | 'SELL'

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

export default function OrdersPage() {
  const { t } = useTranslation()
  const { user, refreshUser } = useAuth()
  const { orders, accounts, refreshAll, closedTradeTick } = useLive()
  const positions = usePositions()
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const [statusF, setStatusF] = useState<StatusFilter>('ALL')
  const [sideF, setSideF] = useState<SideFilter>('ALL')
  const [symbolF, setSymbolF] = useState('')

  // 全页只有一个账号选择器：页头选中的账号同时决定账户横条、持仓、胜率卡、
  // 纪律分、已平仓明细和操作记录。以前账户卡和绩效区各有一套，点了上面那套
  // 发现下面数字没变，很容易误解成数据不对。声明放在最前面，因为下面的订单
  // 请求和各处派生值都要用它。
  // One account selector for the whole page: the header choice drives the
  // account bar, positions, win-rate card, discipline score, closed trades and
  // the activity log alike. Previously the account card and the performance
  // section each had their own, so clicking one left the other's numbers
  // unchanged — easy to misread as bad data. Declared first because the order
  // fetch and several derived values below depend on it.
  const [selectedLogin, setSelectedLogin] = useState<string | null>(null)
  useEffect(() => {
    if (accounts.length === 0) return
    if (selectedLogin === null || !accounts.some((a) => a.login === selectedLogin)) {
      setSelectedLogin(accounts[0].login)
    }
  }, [accounts, selectedLogin])
  const activeAccount = accounts.find((a) => a.login === selectedLogin) ?? accounts[0]

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
  // win-rate card and discipline score use, so the aggregates always agree
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

  const filteredOrders = useMemo(() => {
    return baseOrders.filter((o) => {
      if (statusF !== 'ALL' && o.status !== statusF) return false
      if (sideF !== 'ALL' && o.side !== sideF) return false
      // 品种搜索框按用户看到的名字来，BTCUSD 展示成 BTCUSDT 后，搜索框也得认
      // "BTCUSDT" 才能搜出那些行，不能只匹配后端原始的 BTCUSD 字符串。
      // The symbol search box should match what the user actually sees — now
      // that BTCUSD displays as BTCUSDT, typing "BTCUSDT" must still find
      // those rows, not just the raw backend BTCUSD string.
      const q = symbolF.trim().toLowerCase()
      if (q && !o.symbol.toLowerCase().includes(q) && !displaySymbol(o.symbol).toLowerCase().includes(q)) return false
      return true
    })
  }, [baseOrders, statusF, sideF, symbolF])

  // 状态/方向/品种筛选变化时回到第一页，避免停在一个筛选后已不存在的页码上。
  // 日期筛选的回第一页放在各自的 onChange 里同步做（见下方日期输入框），这样切到
  // 服务端分页时不会先按旧页码多发一次请求。
  // Reset to page 0 when the status/side/symbol filters change. Date-filter
  // resets happen synchronously in their own onChange handlers (see the date
  // inputs below) so switching into server pagination doesn't fire an extra
  // request at the stale page first.
  useEffect(() => { setPage(0) }, [statusF, sideF, symbolF, selectedLogin])

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

  return (
    <div>
      {/* 页头：标题 + 全页统一账号切换器 / page head: title + page-wide account switcher */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold text-neutral-100">
            <span className="neon-text">{t('orders.title')}</span>
          </h2>
          <p className="mt-1 text-sm text-neutral-400">{t('orders.subtitle')}</p>
        </div>
        {accounts.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {accounts.map((a) => (
              <button
                key={a.login}
                onClick={() => setSelectedLogin(a.login)}
                className={`rounded-lg border px-3 py-1.5 font-mono text-xs transition ${
                  a.login === selectedLogin
                    ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
                    : 'border-white/10 bg-white/5 text-neutral-400 hover:text-neutral-100'
                }`}
              >
                {a.login}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tab 导航 / tab navigation */}
      <div className="seg-tabs mb-5" role="tablist">
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
        <>
          {/* 一个账号都没绑时，这个 Tab 原本只剩「暂无持仓」和一张用不了的自动
              仓管卡，账户横条因为 activeAccount 为 undefined 干脆不渲染——页面
              等于什么都没说。引导卡补上「下一步做什么」。
              With no account bound this tab was just "no open positions" plus an
              auto-manage card they can't use, and the account bar didn't render at
              all (activeAccount is undefined) — the page said nothing. The
              onboarding card supplies the next step. */}
          <OnboardingCard />

          {/* 账户状态紧凑横条：详细的账号管理在 /account 页，这里只回答"这个账号
              现在什么状态"。/ Compact account bar: detailed account management
              lives on /account; this only answers "how is this account doing". */}
          {activeAccount && (
            <div className="glass mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-xs">
              <span className="font-mono text-sm text-neutral-100">
                {activeAccount.login}
                {activeAccount.server ? ` @${activeAccount.server}` : ''}
              </span>
              <span className={`tag text-xs ${activeAccount.online ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-500'}`}>
                {activeAccount.online ? t('common.online') : t('common.offline')}
              </span>
              <span className="text-neutral-500">
                {t('account.balance')}{' '}
                <b className="font-mono text-sm font-medium text-neutral-100">{activeAccount.balance?.toFixed(2) ?? '-'}</b>
              </span>
              <span className="text-neutral-500">
                {t('account.equity')}{' '}
                <b className="font-mono text-sm font-medium text-neutral-100">{activeAccount.equity?.toFixed(2) ?? '-'}</b>
              </span>
              <span className="text-neutral-500">
                {t('account.leverage')}{' '}
                <b className="font-mono text-sm font-medium text-neutral-100">
                  {activeAccount.leverage ? `1:${activeAccount.leverage}` : '-'}
                </b>
              </span>
            </div>
          )}

          {/* 持仓概览 / positions overview */}
          <div className="glass p-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-display text-lg font-semibold text-neutral-100">
                {t('orders.positions')}
              </h3>
              {visiblePositions.length > 0 && (
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <span className="text-neutral-400">
                    {t('orders.summary.positions')}{' '}
                    <b className="font-mono text-sm text-neutral-100">{posSummary.total}</b>
                  </span>
                  <span className="text-neutral-400">
                    {t('common.buy')} <b className="font-mono text-sm text-up">{posSummary.buy}</b>
                    {' '}/{' '}
                    {t('common.sell')} <b className="font-mono text-sm text-down">{posSummary.sell}</b>
                  </span>
                  <span className="text-neutral-400">
                    {t('orders.summary.totalPnl')}{' '}
                    <b className={`font-mono text-sm ${posSummary.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                      {posSummary.pnl >= 0 ? '+' : ''}
                      {posSummary.pnl.toFixed(2)}
                    </b>
                  </span>
                </div>
              )}
            </div>
            <p className="mb-3 text-xs text-neutral-500">{t('orders.positionsScopeHint')}</p>
            {visiblePositions.length === 0 ? (
              <p className="py-4 text-center text-sm text-neutral-500">{t('orders.noPositions')}</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
          <div className="mt-6 border-t border-white/10 pt-6">
            <p className="mb-3 text-xs text-neutral-500">{t('orders.autoManageScopeHint')}</p>
            <AutoManageCard isPro={isPro} />
          </div>
        </>
      )}

      {/* 绩效分析：胜率卡、纪律分与已平仓明细都跟着页头选中的账号 /
          Performance: win-rate card, discipline score and closed trades all
          follow the account selected in the page head */}
      {tab === 'performance' && (
        <>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <PersonalWinRateCard variant="detailed" login={selectedLogin ?? undefined} />
            <DisciplineScoreCard login={selectedLogin ?? undefined} isPro={isPro} />
          </div>
          <div className="mt-5">
            <ClosedTradesList trades={visibleTrades} />
          </div>
        </>
      )}


      {/* 操作记录：只列选中账号的指令，所以表里不再重复"账户"一列 /
          Activity log: scoped to the selected account, so the table no longer
          repeats an "account" column */}
      {tab === 'activity' && (
      <>
      {/* Tab 名已经写着"操作记录"，这里不再重复标题，只留一行说明 /
          the tab is already labelled "Activity Log", so no repeated heading */}
      <p className="mb-3 text-xs text-neutral-500">{t('orders.historyHint')}</p>

      {/* 筛选条 / filter bar */}
      <div className="glass mb-3 flex flex-wrap items-center gap-3 p-3">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-neutral-500">{t('orders.filterStatus')}</span>
          <select
            value={statusF}
            onChange={(e) => setStatusF(e.target.value as StatusFilter)}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-neutral-100 outline-none transition focus:border-prism-500"
          >
            <option value="ALL">{t('signals.all')}</option>
            <option value="PENDING">{t('orders.status.PENDING')}</option>
            <option value="FILLED">{t('orders.status.FILLED')}</option>
            <option value="REJECTED">{t('orders.status.REJECTED')}</option>
            <option value="FAILED">{t('orders.status.FAILED')}</option>
            <option value="CANCELLED">{t('orders.status.CANCELLED')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-neutral-500">{t('orders.filterSide')}</span>
          <select
            value={sideF}
            onChange={(e) => setSideF(e.target.value as SideFilter)}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-neutral-100 outline-none transition focus:border-prism-500"
          >
            <option value="ALL">{t('signals.all')}</option>
            <option value="BUY">{t('common.buy')}</option>
            <option value="SELL">{t('common.sell')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-neutral-500">{t('orders.filterSymbol')}</span>
          <input
            value={symbolF}
            onChange={(e) => setSymbolF(e.target.value)}
            placeholder={t('orders.symbolPlaceholder')}
            className="w-28 rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-neutral-100 outline-none transition focus:border-prism-500"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-neutral-500">{t('orders.filterFrom')}</span>
          <input
            type="date"
            value={sinceF}
            max={untilF || undefined}
            onChange={(e) => { setSinceF(e.target.value); setPage(0) }}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-neutral-100 outline-none transition focus:border-prism-500"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-neutral-500">{t('orders.filterTo')}</span>
          <input
            type="date"
            value={untilF}
            min={sinceF || undefined}
            onChange={(e) => { setUntilF(e.target.value); setPage(0) }}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-neutral-100 outline-none transition focus:border-prism-500"
          />
        </label>
        {dateFilterActive && (
          <button
            onClick={() => { setSinceF(''); setUntilF(''); setPage(0) }}
            className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-neutral-400 transition hover:text-neutral-100"
          >
            {t('orders.clearDateFilter')}
          </button>
        )}
      </div>

      {/* 订单表 / orders table */}
      <div className="glass overflow-hidden">
        {visibleOrders.length === 0 ? (
          <p className="py-16 text-center text-sm text-neutral-500">{t('orders.empty')}</p>
        ) : (
          <>
            {/* 桌面端表格 / desktop table */}
            <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-neutral-500">
                  <th className="px-4 py-3 font-medium">{t('orders.colTime')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colType')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colSymbol')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colSide')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colVolume')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colStatus')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colTicket')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colPrice')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colMessage')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colAction')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleOrders.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-white/5 transition hover:bg-prism-600/10"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-neutral-400">
                      {fmtTime(o.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="tag border border-white/10 bg-white/[0.05] text-neutral-300">
                        {t(`orders.action.${o.action ?? 'ORDER'}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="sym-ava"
                          style={{ background: symbolMeta(o.symbol).color + '33', color: symbolMeta(o.symbol).ink }}
                        >
                          {symbolMeta(o.symbol).letter}
                        </span>
                        <span className="font-mono text-neutral-100">{displaySymbol(o.symbol)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`tag ${
                          o.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
                        }`}
                      >
                        {o.side === 'BUY' ? t('common.buy') : t('common.sell')}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-neutral-200">{o.volume}</td>
                    <td className="px-4 py-3">
                      <span className={`tag ${statusStyle[o.status]}`}>
                        {t(`orders.status.${o.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-neutral-400">{o.mt5Ticket ?? '-'}</td>
                    <td className="px-4 py-3 font-mono text-neutral-200">{o.filledPrice ?? '-'}</td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-neutral-400">
                      {o.message ? localizeApiError(o.message) : '-'}
                    </td>
                    <td className="px-4 py-3">
                      {o.status === 'PENDING' && (
                        <button
                          onClick={() => doCancel(o.id)}
                          disabled={cancellingId === o.id}
                          className="rounded-lg border border-down/40 bg-down/10 px-2.5 py-1 text-xs font-medium text-down transition hover:bg-down/20 disabled:opacity-50"
                        >
                          {t('common.cancel')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {/* 移动端卡片列表 / mobile card list */}
            <div className="divide-y divide-white/5 md:hidden">
              {visibleOrders.map((o) => (
                <div key={o.id} className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="sym-ava"
                        style={{ background: symbolMeta(o.symbol).color + '33', color: symbolMeta(o.symbol).ink }}
                      >
                        {symbolMeta(o.symbol).letter}
                      </span>
                      <span className="font-mono text-base font-bold text-neutral-100">{displaySymbol(o.symbol)}</span>
                      <span
                        className={`tag ${
                          o.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
                        }`}
                      >
                        {o.side === 'BUY' ? t('common.buy') : t('common.sell')}
                      </span>
                    </div>
                    <span className={`tag ${statusStyle[o.status]}`}>
                      {t(`orders.status.${o.status}`)}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div className="flex justify-between gap-2">
                      <span className="text-neutral-500">{t('orders.colType')}</span>
                      <span className="text-neutral-300">{t(`orders.action.${o.action ?? 'ORDER'}`)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-neutral-500">{t('orders.colVolume')}</span>
                      <span className="font-mono text-neutral-200">{o.volume}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-neutral-500">{t('orders.colPrice')}</span>
                      <span className="font-mono text-neutral-200">{o.filledPrice ?? '-'}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-neutral-500">{t('orders.colTicket')}</span>
                      <span className="font-mono text-neutral-400">{o.mt5Ticket ?? '-'}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-neutral-500">{t('orders.colTime')}</span>
                      <span className="text-neutral-400">{fmtTime(o.createdAt)}</span>
                    </div>
                  </div>

                  {o.message && (
                    <p className="mt-2 break-words text-xs text-neutral-500">{localizeApiError(o.message)}</p>
                  )}

                  {o.status === 'PENDING' && (
                    <button
                      onClick={() => doCancel(o.id)}
                      disabled={cancellingId === o.id}
                      className="mt-3 w-full rounded-lg border border-down/40 bg-down/10 py-1.5 text-xs font-medium text-down transition hover:bg-down/20 disabled:opacity-50"
                    >
                      {t('common.cancel')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 分页：每页 10 条。不设日期筛选时在实时集合上本地翻页（新单即时可见）；
          设了日期筛选则向后端按页请求，可翻到实时那 100 条之外的历史订单。
          Pagination: 10 per page. Without a date filter, page the live set
          locally (new orders show instantly); with a date filter, page via the
          backend, reaching history beyond the live 100. */}
      {(visibleOrders.length > 0 || dateFilterActive) && (
        <div className="mt-3 flex items-center justify-between text-xs text-neutral-400">
          <span>
            {pageLoading
              ? t('common.loading')
              : t('orders.pageInfo', { page: safePage + 1, totalPages, total: pageTotal })}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(0, safePage - 1))}
              disabled={safePage === 0 || pageLoading}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('common.prevPage')}
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
              disabled={pageLoading || safePage + 1 >= totalPages}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('common.nextPage')}
            </button>
          </div>
        </div>
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
