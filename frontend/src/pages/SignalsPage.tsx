// 信号面板页 / Signals dashboard page
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLive } from '../store/live'
import { orderApi } from '../api/client'
import { clientOrderId, fmtTime, calcRiskReward, calcCountdown } from '../api/utils'
import type { Signal } from '../api/types'
import OrderModal from '../components/OrderModal'

// 信号总有效时长，与后端 expire_at = created_at + 10min 一致 / lifespan matches backend
const SIGNAL_LIFESPAN_MS = 10 * 60 * 1000
// 剩余低于此值视为"即将到期" / below this is considered "expiring soon"
const EXPIRING_THRESHOLD_MS = 2 * 60 * 1000
// 新信号高亮持续时间 / how long a new signal stays highlighted
const NEW_HIGHLIGHT_MS = 6000

type SideFilter = 'ALL' | 'BUY' | 'SELL'
type StatusFilter = 'ALL' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED'
type SortKey = 'latest' | 'expiry' | 'rr' | 'symbol' | 'indicator'
type Layout = 'group' | 'flat'
type ViewMode = 'card' | 'table'

interface Prefs {
  layout: Layout
  view: ViewMode
  sort: SortKey
}

const PREFS_KEY = 'prismx.signals.prefs'

function loadPrefs(): Prefs {
  const fallback: Prefs = { layout: 'group', view: 'card', sort: 'latest' }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return fallback
  }
}

// 每秒滴答的当前时间，用于实时倒计时 / a per-second ticking clock for live countdowns
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}

// 追踪最近新增的信号 id，用于入场高亮 / track recently added signal ids for highlight
function useNewSignalIds(signals: Signal[]): Set<string> {
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

// 信号的有效状态（结合实时倒计时）/ effective status combining live countdown
type EffStatus = 'ACTIVE' | 'EXPIRING' | 'EXPIRED'
function effectiveStatus(signal: Signal, now: number): EffStatus {
  if (signal.status === 'EXPIRED') return 'EXPIRED'
  const cd = calcCountdown(signal.expireAt, SIGNAL_LIFESPAN_MS, now)
  if (cd?.expired) return 'EXPIRED'
  if (cd && cd.remainMs <= EXPIRING_THRESHOLD_MS) return 'EXPIRING'
  return 'ACTIVE'
}

// 风险回报比文本 + 颜色 / risk-reward text + color
function rrTone(rr: number | null): string {
  if (rr == null) return 'text-slate-400'
  if (rr >= 2) return 'text-up'
  if (rr >= 1) return 'text-prism-300'
  return 'text-down'
}

// 倒计时进度条 / countdown progress bar
function CountdownBar({ signal, now }: { signal: Signal; now: number }) {
  const { t } = useTranslation()
  const cd = calcCountdown(signal.expireAt, SIGNAL_LIFESPAN_MS, now)
  if (!cd) return <span className="text-slate-500">-</span>
  const soon = cd.remainMs <= EXPIRING_THRESHOLD_MS
  const barColor = cd.expired ? 'bg-slate-600' : soon ? 'bg-amber-400' : 'bg-prism-500'
  const textColor = cd.expired ? 'text-slate-500' : soon ? 'text-amber-400' : 'text-slate-300'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-500">{t('signals.remaining')}</span>
        <span className={`font-mono ${textColor}`}>{cd.expired ? t('signals.expired') : cd.text}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${cd.fraction * 100}%` }}
        />
      </div>
    </div>
  )
}

// 风险回报展示：比值 + 风险/回报点数 / R:R display with risk·reward pips
function RiskReward({ signal }: { signal: Signal }) {
  const { t } = useTranslation()
  const rr = calcRiskReward(signal.symbol, signal.entry, signal.stopLoss, signal.takeProfit)
  if (!rr) return <span className="text-slate-500">-</span>
  const dist = (price: number, pips: number | null) =>
    pips != null ? `${pips.toFixed(1)} ${t('signals.pips')}` : price.toPrecision(3)
  return (
    <div className="flex items-center gap-2">
      <span className={`font-mono text-sm font-semibold ${rrTone(rr.rr)}`}>
        {rr.rr != null ? `1:${rr.rr.toFixed(2)}` : '-'}
      </span>
      <span className="text-[10px] text-slate-500">
        <span className="text-down">{dist(rr.riskPrice, rr.riskPips)}</span>
        {' / '}
        <span className="text-up">{dist(rr.rewardPrice, rr.rewardPips)}</span>
      </span>
    </div>
  )
}

function SignalCard({
  signal,
  now,
  isNew,
  onTrade,
}: {
  signal: Signal
  now: number
  isNew: boolean
  onTrade: (s: Signal) => void
}) {
  const { t } = useTranslation()
  const isBuy = signal.side === 'BUY'
  const eff = effectiveStatus(signal, now)
  const expired = eff === 'EXPIRED'

  const statusTag =
    eff === 'EXPIRED'
      ? 'bg-white/5 text-slate-500'
      : eff === 'EXPIRING'
        ? 'border border-amber-400/40 bg-amber-400/10 text-amber-400'
        : 'border border-prism-500/30 bg-prism-600/15 text-prism-300'
  const statusLabel =
    eff === 'EXPIRED'
      ? t('signals.expired')
      : eff === 'EXPIRING'
        ? t('signals.expiringSoon')
        : t('signals.active')

  return (
    <div
      className={`glass-neon animate-fade-in-up p-5 ${expired ? 'opacity-50 grayscale' : ''} ${
        isNew ? 'ring-2 ring-prism-500/70 animate-glow-pulse' : ''
      }`}
    >
      <div className="mb-3 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="font-display text-lg font-bold tracking-wide text-slate-100">
            {signal.symbol}
          </span>
          <span className={`tag ${isBuy ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
            {isBuy ? t('common.buy') : t('common.sell')}
          </span>
        </div>
        <span className={`tag ${statusTag}`}>{statusLabel}</span>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-white/5 bg-white/[0.03] py-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            {t('signals.entry')}
          </div>
          <div className="font-mono text-sm text-slate-100">{signal.entry}</div>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/[0.03] py-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            {t('signals.stopLoss')}
          </div>
          <div className="font-mono text-sm text-down">{signal.stopLoss}</div>
        </div>
        <div className="rounded-lg border border-white/5 bg-white/[0.03] py-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            {t('signals.takeProfit')}
          </div>
          <div className="font-mono text-sm text-up">{signal.takeProfit}</div>
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {t('signals.rr')}
        </span>
        <RiskReward signal={signal} />
      </div>

      <div className="mb-3">
        <CountdownBar signal={signal} now={now} />
      </div>

      <div className="mb-3 text-xs text-slate-400">
        <span className="text-slate-500">{t('signals.indicator')}: </span>
        {signal.indicator}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">{fmtTime(signal.createdAt)}</span>
        <button
          onClick={() => onTrade(signal)}
          disabled={expired}
          className="btn-primary px-4 py-1.5 text-sm"
        >
          {t('signals.trade')}
        </button>
      </div>
    </div>
  )
}

function SignalRow({
  signal,
  now,
  isNew,
  onTrade,
}: {
  signal: Signal
  now: number
  isNew: boolean
  onTrade: (s: Signal) => void
}) {
  const { t } = useTranslation()
  const isBuy = signal.side === 'BUY'
  const eff = effectiveStatus(signal, now)
  const expired = eff === 'EXPIRED'
  const cd = calcCountdown(signal.expireAt, SIGNAL_LIFESPAN_MS, now)
  const soon = eff === 'EXPIRING'

  return (
    <tr
      className={`border-b border-white/5 transition-colors hover:bg-white/[0.03] ${
        expired ? 'opacity-50' : ''
      } ${isNew ? 'bg-prism-600/10' : ''}`}
    >
      <td className="px-3 py-2.5 font-display text-sm font-bold text-slate-100">{signal.symbol}</td>
      <td className="px-3 py-2.5">
        <span className={`tag ${isBuy ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
          {isBuy ? t('common.buy') : t('common.sell')}
        </span>
      </td>
      <td className="px-3 py-2.5 font-mono text-sm text-slate-100">{signal.entry}</td>
      <td className="px-3 py-2.5 font-mono text-sm text-down">{signal.stopLoss}</td>
      <td className="px-3 py-2.5 font-mono text-sm text-up">{signal.takeProfit}</td>
      <td className="px-3 py-2.5">
        <RiskReward signal={signal} />
      </td>
      <td className="hidden px-3 py-2.5 text-xs text-slate-400 lg:table-cell">{signal.indicator}</td>
      <td className="px-3 py-2.5">
        <span
          className={`font-mono text-sm ${
            expired ? 'text-slate-500' : soon ? 'text-amber-400' : 'text-slate-300'
          }`}
        >
          {cd ? (cd.expired ? t('signals.expired') : cd.text) : '-'}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right">
        <button
          onClick={() => onTrade(signal)}
          disabled={expired}
          className="btn-primary px-3 py-1 text-xs"
        >
          {t('signals.trade')}
        </button>
      </td>
    </tr>
  )
}

// 小型分段切换控件 / small segmented toggle control
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-xl border border-white/10 bg-white/[0.04] p-0.5 backdrop-blur-md">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            value === o.value
              ? 'bg-prism-600/30 text-prism-200 shadow-prism'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// 自定义下拉选择：替代原生 select，统一暗色玻璃霓虹风。
// Custom dropdown: replaces native <select> with the dark glass-neon theme.
function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  // 选中项前的固定前缀（如"方向："）/ fixed prefix before the selected label
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="input flex items-center justify-between gap-2 sm:w-auto"
      >
        <span className="truncate">
          {label && <span className="text-slate-500">{label}: </span>}
          <span className="text-slate-100">{selected?.label}</span>
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          className={`shrink-0 text-prism-300 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-2 min-w-full overflow-hidden rounded-xl border border-prism-500/30 bg-ink-800/95 p-1 shadow-prism-lg backdrop-blur-xl animate-fade-in-up">
          {options.map((o) => {
            const isSel = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition ${
                  isSel
                    ? 'bg-prism-600/30 text-prism-100'
                    : 'text-slate-300 hover:bg-white/[0.06] hover:text-slate-100'
                }`}
              >
                {o.label}
                {isSel && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-prism-300">
                    <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function SignalsPage() {
  const { t } = useTranslation()
  const { signals, anyOnline, accounts, loaded, refreshAll } = useLive()
  const now = useNow(1000)
  const newIds = useNewSignalIds(signals)

  const [active, setActive] = useState<Signal | null>(null)
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  // 工具栏状态 / toolbar state
  const [search, setSearch] = useState('')
  const [sideFilter, setSideFilter] = useState<SideFilter>('ALL')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)

  // 持久化视图偏好 / persist view prefs
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // 忽略存储失败 / ignore storage errors
    }
  }, [prefs])

  // 筛选 + 排序 / filter + sort
  const visible = useMemo(() => {
    const q = search.trim().toUpperCase()
    const filtered = signals.filter((s) => {
      if (q && !s.symbol.toUpperCase().includes(q)) return false
      if (sideFilter !== 'ALL' && s.side !== sideFilter) return false
      if (statusFilter !== 'ALL' && effectiveStatus(s, now) !== statusFilter) return false
      return true
    })

    const rrOf = (s: Signal) =>
      calcRiskReward(s.symbol, s.entry, s.stopLoss, s.takeProfit)?.rr ?? -Infinity
    const timeOf = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0)

    const sorted = [...filtered]
    switch (prefs.sort) {
      case 'latest':
        sorted.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))
        break
      case 'expiry':
        sorted.sort((a, b) => timeOf(a.expireAt) - timeOf(b.expireAt))
        break
      case 'rr':
        sorted.sort((a, b) => rrOf(b) - rrOf(a))
        break
      case 'symbol':
        sorted.sort((a, b) => a.symbol.localeCompare(b.symbol))
        break
      case 'indicator':
        // 指标为空排末尾 / empty indicators sink to the end
        sorted.sort((a, b) => (a.indicator || '\uffff').localeCompare(b.indicator || '\uffff'))
        break
    }
    return sorted
  }, [signals, search, sideFilter, statusFilter, prefs.sort, now])

  // 分组：即将到期 / 活跃 / 已过期 / group buckets
  const groups = useMemo(() => {
    const buckets: Record<EffStatus, Signal[]> = { EXPIRING: [], ACTIVE: [], EXPIRED: [] }
    for (const s of visible) buckets[effectiveStatus(s, now)].push(s)
    return [
      { key: 'EXPIRING' as const, label: t('signals.groupTitle.expiring'), items: buckets.EXPIRING },
      { key: 'ACTIVE' as const, label: t('signals.groupTitle.active'), items: buckets.ACTIVE },
      { key: 'EXPIRED' as const, label: t('signals.groupTitle.expired'), items: buckets.EXPIRED },
    ].filter((g) => g.items.length > 0)
  }, [visible, now, t])

  const showToast = (msg: string, kind: 'success' | 'error' | 'info' = 'success', ms = 3000) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ msg, kind })
    toastTimer.current = window.setTimeout(() => setToast(null), ms)
  }

  const handleConfirm = async (
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
  ) => {
    if (!active) return
    const placed = await orderApi.place({
      signalId: active.id,
      symbol: active.symbol,
      side: active.side,
      volume,
      clientOrderId: clientOrderId(),
      mt5Login,
      stopLoss,
      takeProfit,
    })
    setActive(null)
    refreshAll()

    if (placed.status === 'FILLED') {
      showToast(t('order.filled', { price: placed.filledPrice ?? '-' }), 'success')
      return
    }
    if (placed.status === 'REJECTED' || placed.status === 'FAILED') {
      showToast(t('order.rejected', { msg: placed.message || '-' }), 'error')
      return
    }
    showToast(t('order.submitted'), 'info', 8000)
    await waitForReceipt(placed.id)
  }

  // 轮询订单直到终态或超时 / poll the order until terminal status or timeout
  const waitForReceipt = async (orderId: string) => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      try {
        const { orders } = await orderApi.list()
        const o = orders.find((x) => x.id === orderId)
        if (!o) continue
        if (o.status === 'FILLED') {
          showToast(t('order.filled', { price: o.filledPrice ?? '-' }), 'success')
          refreshAll()
          return
        }
        if (o.status === 'REJECTED' || o.status === 'FAILED') {
          showToast(t('order.rejected', { msg: o.message || '-' }), 'error')
          refreshAll()
          return
        }
      } catch {
        // 忽略单次失败，继续轮询 / ignore a single failure and keep polling
      }
    }
    showToast(t('order.ackTimeout'), 'info')
  }

  const toastStyle =
    toast?.kind === 'error'
      ? 'border-down/40 bg-down/15 text-down'
      : toast?.kind === 'info'
        ? 'border-prism-600/40 bg-prism-600/15 text-prism-300'
        : 'border-up/40 bg-up/15 text-up'

  // 渲染一组信号（卡片或表格）/ render a list of signals (card or table)
  const renderList = (items: Signal[]) => {
    if (prefs.view === 'table') {
      return (
        <div className="glass overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <thead>
              <tr className="border-b border-white/10 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2.5 font-medium">{t('signals.colSymbol')}</th>
                <th className="px-3 py-2.5 font-medium">{t('signals.colSide')}</th>
                <th className="px-3 py-2.5 font-medium">{t('signals.colEntry')}</th>
                <th className="px-3 py-2.5 font-medium">{t('signals.colSl')}</th>
                <th className="px-3 py-2.5 font-medium">{t('signals.colTp')}</th>
                <th className="px-3 py-2.5 font-medium">{t('signals.colRr')}</th>
                <th className="hidden px-3 py-2.5 font-medium lg:table-cell">
                  {t('signals.colIndicator')}
                </th>
                <th className="px-3 py-2.5 font-medium">{t('signals.colCountdown')}</th>
                <th className="px-3 py-2.5 text-right font-medium">{t('signals.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <SignalRow key={s.id} signal={s} now={now} isNew={newIds.has(s.id)} onTrade={setActive} />
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((s) => (
          <SignalCard key={s.id} signal={s} now={now} isNew={newIds.has(s.id)} onTrade={setActive} />
        ))}
      </div>
    )
  }

  const sortOptions: { value: SortKey; label: string }[] = [
    { value: 'latest', label: t('signals.sort.latest') },
    { value: 'expiry', label: t('signals.sort.expiry') },
    { value: 'rr', label: t('signals.sort.rr') },
    { value: 'symbol', label: t('signals.sort.symbol') },
    { value: 'indicator', label: t('signals.sort.indicator') },
  ]

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('signals.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('signals.subtitle')}</p>
      </div>

      {/* 工具栏 / toolbar */}
      <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('signals.searchPlaceholder')}
            className="input sm:max-w-[200px]"
          />
          <Dropdown<SideFilter>
            value={sideFilter}
            onChange={setSideFilter}
            label={t('signals.filterSide')}
            options={[
              { value: 'ALL', label: t('signals.all') },
              { value: 'BUY', label: t('common.buy') },
              { value: 'SELL', label: t('common.sell') },
            ]}
          />
          <Dropdown<StatusFilter>
            value={statusFilter}
            onChange={setStatusFilter}
            label={t('signals.filterStatus')}
            options={[
              { value: 'ALL', label: t('signals.all') },
              { value: 'ACTIVE', label: t('signals.active') },
              { value: 'EXPIRING', label: t('signals.expiringSoon') },
              { value: 'EXPIRED', label: t('signals.expired') },
            ]}
          />
          <Dropdown<SortKey>
            value={prefs.sort}
            onChange={(v) => setPrefs((p) => ({ ...p, sort: v }))}
            label={t('signals.sortBy')}
            options={sortOptions}
          />
        </div>
        <div className="flex items-center gap-2">
          <Segmented<Layout>
            value={prefs.layout}
            onChange={(v) => setPrefs((p) => ({ ...p, layout: v }))}
            options={[
              { value: 'group', label: t('signals.group') },
              { value: 'flat', label: t('signals.flat') },
            ]}
          />
          <Segmented<ViewMode>
            value={prefs.view}
            onChange={(v) => setPrefs((p) => ({ ...p, view: v }))}
            options={[
              { value: 'card', label: t('signals.viewCard') },
              { value: 'table', label: t('signals.viewTable') },
            ]}
          />
        </div>
      </div>

      {!loaded ? (
        <div className="glass flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-3 h-10 w-10 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
          <p className="text-sm text-slate-400">{t('common.loading')}</p>
        </div>
      ) : signals.length === 0 ? (
        <div className="glass flex flex-col items-center justify-center py-20 text-center">
          <p className="text-sm text-slate-400">{t('signals.empty')}</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="glass flex flex-col items-center justify-center py-20 text-center">
          <p className="text-sm text-slate-400">{t('signals.noMatch')}</p>
        </div>
      ) : prefs.layout === 'group' ? (
        <div className="flex flex-col gap-8">
          {groups.map((g) => (
            <section key={g.key}>
              <div className="mb-3 flex items-center gap-2">
                <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
                  {g.label}
                </h3>
                <span className="chip">{g.items.length}</span>
              </div>
              {renderList(g.items)}
            </section>
          ))}
        </div>
      ) : (
        renderList(visible)
      )}

      {active && (
        <OrderModal
          signal={active}
          eaOnline={anyOnline}
          accounts={accounts}
          onCancel={() => setActive(null)}
          onConfirm={handleConfirm}
        />
      )}

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism ${toastStyle}`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}
