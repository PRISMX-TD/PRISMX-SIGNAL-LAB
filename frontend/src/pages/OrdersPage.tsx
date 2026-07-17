// 订单与回执页 / Orders & receipts page
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'
import { useLive, usePositions } from '../store/live'
import { orderApi, automationApi } from '../api/client'
import { displaySymbol, fmtTime, localizeApiError } from '../api/utils'
import type { AutoManageSettings, ClosedTrade, Order, OrderStatus } from '../api/types'
import PositionCard from '../components/PositionCard'
import PersonalWinRateCard from '../components/PersonalWinRateCard'
import ClosedTradesList from '../components/ClosedTradesList'

const statusStyle: Record<OrderStatus, string> = {
  PENDING: 'bg-amber-500/15 text-amber-400',
  FILLED: 'bg-up/15 text-up',
  REJECTED: 'bg-down/15 text-down',
  FAILED: 'bg-down/15 text-down',
  CANCELLED: 'bg-white/10 text-slate-400',
}

type StatusFilter = 'ALL' | OrderStatus
type SideFilter = 'ALL' | 'BUY' | 'SELL'

export default function OrdersPage() {
  const { t } = useTranslation()
  const { user, refreshUser } = useAuth()
  const { orders, accounts, refreshAll } = useLive()
  const positions = usePositions()
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const [statusF, setStatusF] = useState<StatusFilter>('ALL')
  const [sideF, setSideF] = useState<SideFilter>('ALL')
  const [symbolF, setSymbolF] = useState('')

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
    })
      .then((r) => { if (alive) { setServerOrders(r.orders); setServerTotal(r.total) } })
      .catch(() => { if (alive) { setServerOrders([]); setServerTotal(0) } })
      .finally(() => { if (alive) setPageLoading(false) })
    return () => { alive = false }
  }, [dateFilterActive, page, sinceF, untilF])

  const baseOrders = dateFilterActive ? (serverOrders ?? []) : orders

  // 自动仓位管理 / auto position management
  const [autoCfg, setAutoCfg] = useState<AutoManageSettings | null>(null)
  const [autoSaving, setAutoSaving] = useState(false)
  const [autoMsg, setAutoMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  const isPro = user?.plan === 'PRO'
  // 历史信号回放入口的可见性（功能内部试用中，仅管理员）/ replay entry visibility
  // (feature in internal trial, admins only)
  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    refreshUser()                        // 每次进入页面刷新 plan，确保管理员升级后即时生效
    automationApi.getSettings().then(setAutoCfg).catch(() => {})
  }, [])

  // 我的交易表现：已平仓明细在这里统一拉取，账号标签同时驱动上方的胜率卡
  // （见下方 JSX）——一次点击，数字和明细一起切换，不会出现"胜率含旧账号
  // 战绩、明细却看不到"的不一致。
  // Personal trading performance: closed trades are fetched here once; the
  // account tab drives both the win-rate card above it and the list below
  // (see the JSX further down) — one click switches both, so the win-rate
  // number never disagrees with the visible records it's supposed to be built from.
  const [trades, setTrades] = useState<ClosedTrade[] | null>(null)
  const [selectedLogin, setSelectedLogin] = useState<string | null>(null) // null = 全部账户 / all accounts

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
  }, [])

  // 记录里出现过的账号（去重、排序）；只有超过一个才需要显示"全部/单个"标签。
  // Distinct account logins seen in the records; tabs only appear when >1.
  const tradeLogins = useMemo(() => {
    if (!trades) return []
    return [...new Set(trades.map((tr) => tr.mt5Login))].sort()
  }, [trades])
  const multiAccount = tradeLogins.length > 1

  // 选中账号已不在记录里（如刚被删掉）时回退到"全部" / fall back to "all" if the selected login vanished
  useEffect(() => {
    if (selectedLogin !== null && trades !== null && !tradeLogins.includes(selectedLogin)) {
      setSelectedLogin(null)
    }
  }, [selectedLogin, trades, tradeLogins])

  const visibleTrades = useMemo(() => {
    if (!trades) return trades
    return selectedLogin ? trades.filter((tr) => tr.mt5Login === selectedLogin) : trades
  }, [trades, selectedLogin])

  async function saveAutoCfg() {
    if (!autoCfg) return
    setAutoSaving(true)
    setAutoMsg(null)
    try {
      const updated = await automationApi.putSettings(autoCfg)
      setAutoCfg(updated)
      setAutoMsg({ kind: "ok", text: t("account.autoSaved") })
    } catch (err: unknown) {
      setAutoMsg({ kind: "err", text: err instanceof Error ? localizeApiError(err.message) : t("account.autoSaveError") })
    } finally {
      setAutoSaving(false)
    }
  }

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
    for (const p of positions) {
      pnl += p.profit
      if (p.side === 'BUY') buy += 1
      else sell += 1
    }
    return { pnl, buy, sell, total: positions.length }
  }, [positions])

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
  useEffect(() => { setPage(0) }, [statusF, sideF, symbolF])

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
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('orders.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('orders.subtitle')}</p>
      </div>

      {/* MT5 账户详情 / MT5 account details */}
      {accounts.length > 0 && (
        <div className="glass mb-5 p-5">
          <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
            {t('orders.mt5Accounts')}
          </h3>
          <div className="mt-3 space-y-3">
            {accounts.map((a, i) => (
              <div key={i} className="rounded-lg border border-white/5 bg-white/[0.03] p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-slate-100">
                    {a.login}
                    {a.server ? ` @${a.server}` : ""}
                  </span>
                  <span
                    className={`tag text-xs ${a.online ? "bg-up/15 text-up" : "bg-white/5 text-slate-500"}`}
                  >
                    {a.online ? t("common.online") : t("common.offline")}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-slate-500">{t("account.balance")}</span>
                    <div className="font-mono text-slate-100">{a.balance?.toFixed(2) ?? "-"}</div>
                  </div>
                  <div>
                    <span className="text-slate-500">{t("account.equity")}</span>
                    <div className="font-mono text-slate-100">{a.equity?.toFixed(2) ?? "-"}</div>
                  </div>
                  <div>
                    <span className="text-slate-500">{t("account.leverage")}</span>
                    <div className="font-mono text-slate-100">{a.leverage ? `1:${a.leverage}` : "-"}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 持仓概览 / positions overview */}
      <div className="glass mb-5 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-lg font-semibold text-slate-100">
            {t('orders.positions')}
          </h3>
          {positions.length > 0 && (
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="text-slate-400">
                {t('orders.summary.positions')}{' '}
                <b className="font-mono text-sm text-slate-100">{posSummary.total}</b>
              </span>
              <span className="text-slate-400">
                {t('common.buy')} <b className="font-mono text-sm text-up">{posSummary.buy}</b>
                {' '}/{' '}
                {t('common.sell')} <b className="font-mono text-sm text-down">{posSummary.sell}</b>
              </span>
              <span className="text-slate-400">
                {t('orders.summary.totalPnl')}{' '}
                <b className={`font-mono text-sm ${posSummary.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                  {posSummary.pnl >= 0 ? '+' : ''}
                  {posSummary.pnl.toFixed(2)}
                </b>
              </span>
            </div>
          )}
        </div>
        <p className="mb-3 text-xs text-slate-500">{t('orders.positionsScopeHint')}</p>
        {positions.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">{t('orders.noPositions')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {positions.map((p, i) => (
              <PositionCard key={p.ticket ?? i} position={p} onActionDone={showToast} />
            ))}
          </div>
        )}
      </div>

      {/* 我的交易表现：账号标签同时驱动胜率卡与下方明细，两者数字永远对得上 /
          Personal trading performance: the account tab drives both the
          win-rate card and the detail list below, so the numbers never disagree */}
      <div className="mb-5">
        {/* 历史信号回放入口：只对管理员显示——功能内部试用中，未对普通用户开放
            （真正的边界在后端 require_admin，这里只是不给非管理员看到入口）。
            Replay entry: admins only — the feature is in internal trial (the
            real boundary is the backend's require_admin; this hides the link). */}
        {isAdmin && (
          <div className="mb-2 flex justify-end">
            <Link to="/simulator" className="text-xs text-prism-300 hover:text-prism-200">
              {t('simulator.entry')}
            </Link>
          </div>
        )}
        {multiAccount && (
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedLogin(null)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                selectedLogin === null
                  ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
                  : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-100'
              }`}
            >
              {t('winrate.allAccounts')}
            </button>
            {tradeLogins.map((login) => (
              <button
                key={login}
                onClick={() => setSelectedLogin(login)}
                className={`rounded-lg border px-3 py-1.5 font-mono text-xs transition ${
                  selectedLogin === login
                    ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
                    : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-100'
                }`}
              >
                {t('winrate.closedTradesAccount', { login })}
              </button>
            ))}
          </div>
        )}
        <PersonalWinRateCard variant="detailed" login={selectedLogin ?? undefined} />
        <div className="mt-5">
          <ClosedTradesList trades={visibleTrades} showAccountColumn={multiAccount && selectedLogin === null} />
        </div>
      </div>

      {/* 自动仓位管理 / auto position management */}
      {autoCfg && (
        <div className={`glass mb-5 p-5 ${!isPro ? 'opacity-60' : ''}`}>
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
              {t('account.autoTitle')}
            </h3>
            {!isPro && (
              <span className="tag bg-white/10 text-slate-500">{t('orders.proExclusive')}</span>
            )}
            {isPro && (
              <span className="tag bg-prism-600/20 text-prism-300">PRO</span>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('account.autoHint')}</p>

          {!isPro ? (
            <p className="mt-3 text-xs text-slate-500">
              {t('account.autoUpgradeRequired')}{" "}
              <Link to="/upgrade" className="text-prism-400 underline hover:text-prism-300">
                {t('nav.upgrade')}
              </Link>
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-100">
                <input
                  type="checkbox"
                  checked={autoCfg.enabled}
                  onChange={(e) => setAutoCfg({ ...autoCfg, enabled: e.target.checked })}
                  className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                />
                {t('account.autoEnable')}
              </label>

              {autoCfg.enabled && (
                <div className="space-y-4 rounded-lg border border-white/5 bg-white/[0.03] p-4">
                  {/* 保本 / break-even */}
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex w-40 cursor-pointer items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={autoCfg.beEnabled}
                        onChange={(e) => setAutoCfg({ ...autoCfg, beEnabled: e.target.checked })}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                      />
                      {t('account.autoBe')}
                    </label>
                    <span className="text-xs text-slate-500">{t('account.autoTriggerAt')}</span>
                    <input
                      type="number" step={0.1} min={0.1} max={10}
                      className="input h-8 w-20 text-xs"
                      value={autoCfg.beTriggerR}
                      onChange={(e) => setAutoCfg({ ...autoCfg, beTriggerR: Number(e.target.value) })}
                    />
                    <span className="text-xs text-slate-500">R</span>
                  </div>

                  {/* 追踪止损 / trailing stop */}
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex w-40 cursor-pointer items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={autoCfg.trailEnabled}
                        onChange={(e) => setAutoCfg({ ...autoCfg, trailEnabled: e.target.checked })}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                      />
                      {t('account.autoTrail')}
                    </label>
                    <span className="text-xs text-slate-500">{t('account.autoTriggerAt')}</span>
                    <input
                      type="number" step={0.1} min={0.1} max={10}
                      className="input h-8 w-20 text-xs"
                      value={autoCfg.trailTriggerR}
                      onChange={(e) => setAutoCfg({ ...autoCfg, trailTriggerR: Number(e.target.value) })}
                    />
                    <span className="text-xs text-slate-500">R · {t('account.autoTrailDistance')}</span>
                    <input
                      type="number" step={0.1} min={0.1} max={10}
                      className="input h-8 w-20 text-xs"
                      value={autoCfg.trailDistanceR}
                      onChange={(e) => setAutoCfg({ ...autoCfg, trailDistanceR: Number(e.target.value) })}
                    />
                    <span className="text-xs text-slate-500">R</span>
                  </div>

                  {/* 分批止盈 / partial take-profit */}
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex w-40 cursor-pointer items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={autoCfg.ptpEnabled}
                        onChange={(e) => setAutoCfg({ ...autoCfg, ptpEnabled: e.target.checked })}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                      />
                      {t('account.autoPtp')}
                    </label>
                    <span className="text-xs text-slate-500">{t('account.autoTriggerAt')}</span>
                    <input
                      type="number" step={0.1} min={0.1} max={10}
                      className="input h-8 w-20 text-xs"
                      value={autoCfg.ptpTriggerR}
                      onChange={(e) => setAutoCfg({ ...autoCfg, ptpTriggerR: Number(e.target.value) })}
                    />
                    <span className="text-xs text-slate-500">R · {t('account.autoPtpFraction')}</span>
                    <input
                      type="number" step={5} min={10} max={90}
                      className="input h-8 w-20 text-xs"
                      value={Math.round(autoCfg.ptpFraction * 100)}
                      onChange={(e) => setAutoCfg({ ...autoCfg, ptpFraction: Number(e.target.value) / 100 })}
                    />
                    <span className="text-xs text-slate-500">%</span>
                  </div>

                  <p className="text-[11px] leading-relaxed text-slate-600">{t('account.autoScopeNote')}</p>
                </div>
              )}

              <button
                onClick={saveAutoCfg}
                disabled={autoSaving}
                className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
              >
                {autoSaving ? t('common.loading') : t('common.save')}
              </button>
              {autoMsg && (
                <p className={`text-sm ${autoMsg.kind === "err" ? "text-down" : "text-up"}`}>
                  {autoMsg.text}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 操作记录 / activity log */}
      <div className="mb-3">
        <h3 className="font-display text-lg font-semibold text-slate-100">{t('orders.historyTitle')}</h3>
        <p className="mt-1 text-xs text-slate-500">{t('orders.historyHint')}</p>
      </div>

      {/* 筛选条 / filter bar */}
      <div className="glass mb-3 flex flex-wrap items-center gap-3 p-3">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-slate-500">{t('orders.filterStatus')}</span>
          <select
            value={statusF}
            onChange={(e) => setStatusF(e.target.value as StatusFilter)}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-slate-100 outline-none transition focus:border-prism-500"
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
          <span className="text-slate-500">{t('orders.filterSide')}</span>
          <select
            value={sideF}
            onChange={(e) => setSideF(e.target.value as SideFilter)}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-slate-100 outline-none transition focus:border-prism-500"
          >
            <option value="ALL">{t('signals.all')}</option>
            <option value="BUY">{t('common.buy')}</option>
            <option value="SELL">{t('common.sell')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-slate-500">{t('orders.filterSymbol')}</span>
          <input
            value={symbolF}
            onChange={(e) => setSymbolF(e.target.value)}
            placeholder={t('orders.symbolPlaceholder')}
            className="w-28 rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-slate-100 outline-none transition focus:border-prism-500"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-slate-500">{t('orders.filterFrom')}</span>
          <input
            type="date"
            value={sinceF}
            max={untilF || undefined}
            onChange={(e) => { setSinceF(e.target.value); setPage(0) }}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-slate-100 outline-none transition focus:border-prism-500"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-slate-500">{t('orders.filterTo')}</span>
          <input
            type="date"
            value={untilF}
            min={sinceF || undefined}
            onChange={(e) => { setUntilF(e.target.value); setPage(0) }}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-slate-100 outline-none transition focus:border-prism-500"
          />
        </label>
        {dateFilterActive && (
          <button
            onClick={() => { setSinceF(''); setUntilF(''); setPage(0) }}
            className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-400 transition hover:text-slate-100"
          >
            {t('orders.clearDateFilter')}
          </button>
        )}
      </div>

      {/* 订单表 / orders table */}
      <div className="glass overflow-hidden">
        {visibleOrders.length === 0 ? (
          <p className="py-16 text-center text-sm text-slate-500">{t('orders.empty')}</p>
        ) : (
          <>
            {/* 桌面端表格 / desktop table */}
            <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-medium">{t('orders.colTime')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colType')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colAccount')}</th>
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
                    <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                      {fmtTime(o.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="tag border border-white/10 bg-white/[0.05] text-slate-300">
                        {t(`orders.action.${o.action ?? 'ORDER'}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-300">{o.mt5Login ?? '-'}</td>
                    <td className="px-4 py-3 font-mono text-slate-100">{displaySymbol(o.symbol)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`tag ${
                          o.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
                        }`}
                      >
                        {o.side === 'BUY' ? t('common.buy') : t('common.sell')}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-200">{o.volume}</td>
                    <td className="px-4 py-3">
                      <span className={`tag ${statusStyle[o.status]}`}>
                        {t(`orders.status.${o.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-400">{o.mt5Ticket ?? '-'}</td>
                    <td className="px-4 py-3 font-mono text-slate-200">{o.filledPrice ?? '-'}</td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-slate-400">
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
                      <span className="font-mono text-base font-bold text-slate-100">{displaySymbol(o.symbol)}</span>
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
                      <span className="text-slate-500">{t('orders.colType')}</span>
                      <span className="text-slate-300">{t(`orders.action.${o.action ?? 'ORDER'}`)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colVolume')}</span>
                      <span className="font-mono text-slate-200">{o.volume}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colAccount')}</span>
                      <span className="font-mono text-slate-300">{o.mt5Login ?? '-'}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colPrice')}</span>
                      <span className="font-mono text-slate-200">{o.filledPrice ?? '-'}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colTicket')}</span>
                      <span className="font-mono text-slate-400">{o.mt5Ticket ?? '-'}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colTime')}</span>
                      <span className="text-slate-400">{fmtTime(o.createdAt)}</span>
                    </div>
                  </div>

                  {o.message && (
                    <p className="mt-2 break-words text-xs text-slate-500">{localizeApiError(o.message)}</p>
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
        <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
          <span>
            {pageLoading
              ? t('common.loading')
              : t('orders.pageInfo', { page: safePage + 1, totalPages, total: pageTotal })}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(0, safePage - 1))}
              disabled={safePage === 0 || pageLoading}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('common.prevPage')}
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
              disabled={pageLoading || safePage + 1 >= totalPages}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('common.nextPage')}
            </button>
          </div>
        </div>
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
