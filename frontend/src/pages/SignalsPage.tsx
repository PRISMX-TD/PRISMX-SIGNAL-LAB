// 信号面板页 / Signals dashboard page
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useLive } from '../store/live'
import { orderApi } from '../api/client'
import { clientOrderId, fmtTime, calcRiskReward, calcCountdown } from '../api/utils'
import type { Signal, Quote } from '../api/types'
import OrderModal from '../components/OrderModal'

// 信号总有效时长，与后端 expire_at = created_at + 10min 一致 / lifespan matches backend
const SIGNAL_LIFESPAN_MS = 10 * 60 * 1000
// 剩余低于此值视为"即将到期" / below this is considered "expiring soon"
const EXPIRING_THRESHOLD_MS = 2 * 60 * 1000
// 新信号高亮持续时间 / how long a new signal stays highlighted
const NEW_HIGHLIGHT_MS = 6000

// focus 视图默认关注品种（与后端引擎产出对齐，XAGUSD 暂无信号则恒显观望）。
// Default watchlist (aligned with the engine's symbols; XAGUSD stays in "watch"
// until it ever emits a signal).
const DEFAULT_WATCHLIST = ['XAUUSD', 'EURUSD', 'GBPUSD', 'XAGUSD', 'BTCUSD']

// 品种在 focus 视图下的状态：观望 / 做多 / 做空 / per-symbol state in the focus view
type FocusState = 'WATCH' | 'LONG' | 'SHORT'

// 每秒滴答的当前时间，用于实时倒计时 / a per-second ticking clock for live countdowns
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}

// 跟踪新到达的信号 id，用于短暂高亮 / track freshly arrived signal ids for a brief highlight
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

// 风险回报比颜色 / risk-reward color
function rrTone(rr: number | null): string {
  if (rr == null) return 'text-slate-400'
  if (rr >= 2) return 'text-up'
  if (rr >= 1) return 'text-prism-300'
  return 'text-down'
}

// 单个关注品种在 focus 视图中的派生数据 / derived per-symbol data for the focus view
interface FocusEntry {
  symbol: string
  state: FocusState
  signal: Signal | null
}

// focus 状态的视觉映射 / visual mapping for each focus state
const FOCUS_TONE: Record<FocusState, { color: string; chipBg: string; glow: string }> = {
  WATCH: { color: 'text-slate-400', chipBg: 'bg-white/5 text-slate-400', glow: 'rgba(148,163,184,.18)' },
  LONG: { color: 'text-up', chipBg: 'bg-up/15 text-up', glow: 'rgba(47,230,160,.28)' },
  SHORT: { color: 'text-down', chipBg: 'bg-down/15 text-down', glow: 'rgba(255,77,109,.28)' },
}
const FOCUS_DOT: Record<FocusState, string> = { WATCH: '#94a3b8', LONG: '#2fe6a0', SHORT: '#ff4d6d' }

// 由实时信号派生每个关注品种的当前状态。
// 关注列表 = 默认清单 ∪ 任何当前有 ACTIVE 信号的品种（不漏掉引擎新出的品种）。
function useFocusEntries(signals: Signal[], now: number): FocusEntry[] {
  return useMemo(() => {
    const repBySymbol = new Map<string, Signal>()
    for (const s of signals) {
      if (effectiveStatus(s, now) === 'EXPIRED') continue
      const cur = repBySymbol.get(s.symbol)
      if (!cur || new Date(s.createdAt).getTime() > new Date(cur.createdAt).getTime()) {
        repBySymbol.set(s.symbol, s)
      }
    }
    const symbols = [...DEFAULT_WATCHLIST]
    for (const sym of repBySymbol.keys()) if (!symbols.includes(sym)) symbols.push(sym)
    return symbols.map((symbol) => {
      const signal = repBySymbol.get(symbol) ?? null
      const state: FocusState = !signal ? 'WATCH' : signal.side === 'BUY' ? 'LONG' : 'SHORT'
      return { symbol, state, signal }
    })
  }, [signals, now])
}

// 单行报价条：只显示当前聚焦品种的 bid/ask，用于移动端。
// Single-line quote bar: shows only the focused symbol's bid/ask, for mobile.
function QuoteBar({ quote }: { quote?: Quote }) {
  const { t } = useTranslation()
  const fmtPrice = (v: number, digits?: number) =>
    typeof digits === 'number' ? v.toFixed(digits) : String(v)
  if (!quote) return null
  return (
    <div className="glass flat-card mb-3 flex items-center gap-2 px-3 py-2.5 text-sm">
      <span className="h-2 w-2 shrink-0 rounded-full bg-up animate-breathe" />
      <span className="font-semibold text-slate-200">{quote.symbol}</span>
      <span className="ml-auto text-[10px] text-slate-500">{t('signals.quotes.bidShort')}</span>
      <span className="font-mono font-bold tabular-nums text-up">{fmtPrice(quote.bid, quote.digits)}</span>
      <span className="rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-slate-400">{t('signals.quotes.spread')}</span>
      <span className="text-[10px] text-slate-500">{t('signals.quotes.askShort')}</span>
      <span className="font-mono font-bold tabular-nums text-down">{fmtPrice(quote.ask, quote.digits)}</span>
    </div>
  )
}

// 实时报价面板：展示桥接上报的 bid/ask。未连接 MT5 时显示占位。
// Live quotes panel: shows bid/ask reported by the bridge; placeholder when MT5 offline.
function QuotePanel({ quotes, mt5Online }: { quotes: Record<string, Quote>; mt5Online: boolean }) {
  const { t } = useTranslation()
  const nameOf = (sym: string) => t(`signals.symbolNames.${sym}`, { defaultValue: '' })
  const rows = Object.values(quotes).sort((a, b) => a.symbol.localeCompare(b.symbol))
  // 严格按交易商小数位数显示，避免浮点残差（如 1.32386999…）。
  // Format strictly by broker digits to avoid float noise.
  const fmtPrice = (v: number, digits?: number) =>
    typeof digits === 'number' ? v.toFixed(digits) : String(v)

  return (
    <div className="glass flat-card mt-4 p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
          {t('signals.quotes.title')}
        </h3>
        <span
          className={`h-1.5 w-1.5 rounded-full ${mt5Online ? 'bg-up animate-breathe' : 'bg-slate-600'}`}
        />
      </div>

      {rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/12 py-6 text-xs text-slate-500">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
          {mt5Online ? t('signals.quotes.waiting') : t('signals.quotes.notConnected')}
        </div>
      ) : (
        <div className="space-y-1.5">
          {/* 列头 / column header */}
          <div className="grid grid-cols-3 px-2 text-[10px] uppercase tracking-wider text-slate-500">
            <span>{/* symbol */}</span>
            <span className="text-right">{t('signals.quotes.bid')}</span>
            <span className="text-right">{t('signals.quotes.ask')}</span>
          </div>
          {rows.map((q) => (
            <div
              key={q.symbol}
              className="grid grid-cols-3 items-center rounded-xl bg-white/[0.03] px-2 py-2"
            >
              <div className="min-w-0">
                <div className="truncate font-display text-sm font-semibold text-slate-100">{q.symbol}</div>
                {nameOf(q.symbol) && <div className="truncate text-[10px] text-slate-500">{nameOf(q.symbol)}</div>}
              </div>
              <div className="text-right font-mono text-sm font-semibold text-up">{fmtPrice(q.bid, q.digits)}</div>
              <div className="text-right font-mono text-sm font-semibold text-down">{fmtPrice(q.ask, q.digits)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// focus 视图：单品种聚焦英雄卡 + 全市场情绪 + 其他活跃信号。
function FocusView({
  entries,
  now,
  newIds,
  onTrade,
  quotes,
  anyOnline,
}: {
  entries: FocusEntry[]
  now: number
  newIds: Set<string>
  onTrade: (s: Signal) => void
  quotes: Record<string, Quote>
  anyOnline: boolean
}) {
  const { t } = useTranslation()
  const [focusIdx, setFocusIdx] = useState(0)
  // 触摸滑动切换卡片（移动端/PWA）/ touch-swipe to switch cards (mobile/PWA)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  // 其他活跃信号的筛选与排序 / filter & sort for the other-active list
  const [sideF, setSideF] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL')
  const [statusF, setStatusF] = useState<'ALL' | 'ACTIVE' | 'EXPIRING'>('ALL')
  const [sortF, setSortF] = useState<'latest' | 'expiry' | 'rr'>('latest')
  // 列表形态：卡片 / 简洁，手机端与电脑端均默认卡片 / list layout: card or compact, defaults to card on both mobile & desktop
  const [viewMode, setViewMode] = useState<'card' | 'compact'>('card')

  const idx = Math.min(focusIdx, Math.max(0, entries.length - 1))
  const cur = entries[idx]

  // 循环切换 / cyclic switch
  const goPrev = () => setFocusIdx((idx - 1 + entries.length) % entries.length)
  const goNext = () => setFocusIdx((idx + 1) % entries.length)

  // 触摸滑动：水平位移超过阈值且大于竖直位移时切换 / horizontal swipe beyond threshold switches
  const onTouchStart = (e: ReactTouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }
  const onTouchEnd = (e: ReactTouchEvent) => {
    if (touchStartX.current == null || touchStartY.current == null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    const dy = e.changedTouches[0].clientY - touchStartY.current
    touchStartX.current = null
    touchStartY.current = null
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return
    if (dx < 0) goNext()
    else goPrev()
  }

  const sentiment = useMemo(() => {
    let long = 0,
      short = 0,
      watch = 0
    for (const e of entries) {
      if (e.state === 'LONG') long += 1
      else if (e.state === 'SHORT') short += 1
      else watch += 1
    }
    return { long, short, watch, total: entries.length }
  }, [entries])

  if (!cur) return null

  const stateLabel = (s: FocusState) =>
    s === 'LONG' ? t('signals.focus.long') : s === 'SHORT' ? t('signals.focus.short') : t('signals.focus.watch')
  const nameOf = (sym: string) => t(`signals.symbolNames.${sym}`, { defaultValue: '' })

  const tone = FOCUS_TONE[cur.state]
  const hasSignal = cur.state !== 'WATCH' && cur.signal != null
  const rr = cur.signal ? calcRiskReward(cur.signal.symbol, cur.signal.entry, cur.signal.stopLoss, cur.signal.takeProfit) : null
  const total = Math.max(1, sentiment.total)
  const longW = Math.round((sentiment.long / total) * 100)
  const shortW = Math.round((sentiment.short / total) * 100)

  const others = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => i !== idx && e.state !== 'WATCH' && e.signal)

  // 应用方向 / 状态筛选 + 排序 / apply side/status filter then sort
  const visibleOthers = others
    .filter(({ e }) => {
      if (sideF !== 'ALL' && e.state !== sideF) return false
      if (statusF !== 'ALL' && effectiveStatus(e.signal!, now) !== statusF) return false
      return true
    })
    .sort((a, b) => {
      const sa = a.e.signal!
      const sb = b.e.signal!
      if (sortF === 'rr') {
        const ra = calcRiskReward(sa.symbol, sa.entry, sa.stopLoss, sa.takeProfit)?.rr ?? -1
        const rb = calcRiskReward(sb.symbol, sb.entry, sb.stopLoss, sb.takeProfit)?.rr ?? -1
        return rb - ra
      }
      if (sortF === 'expiry') {
        return (
          (calcCountdown(sa.expireAt, SIGNAL_LIFESPAN_MS, now)?.remainMs ?? 0) -
          (calcCountdown(sb.expireAt, SIGNAL_LIFESPAN_MS, now)?.remainMs ?? 0)
        )
      }
      return new Date(sb.createdAt).getTime() - new Date(sa.createdAt).getTime()
    })

  return (
    <div className="mx-auto max-w-2xl lg:max-w-6xl">
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
        {/* 左栏：聚焦英雄卡 + 实时报价 / left column: hero card + live quotes */}
        <div>
          {/* 品种滑动导航 + 状态圆点 / symbol nav + colored state dots */}
          <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={goPrev}
          className="glass no-sheen flat-card grid h-9 w-9 place-items-center text-prism-200"
          aria-label="prev"
        >
          ‹
        </button>
        <div className="flex items-center gap-2">
          <span className="font-display text-base font-bold text-slate-100">{cur.symbol}</span>
          {nameOf(cur.symbol) && <span className="text-xs text-slate-500">{nameOf(cur.symbol)}</span>}
        </div>
        <button
          type="button"
          onClick={goNext}
          className="glass no-sheen flat-card grid h-9 w-9 place-items-center text-prism-200"
          aria-label="next"
        >
          ›
        </button>
      </div>
      <div className="mb-4 flex justify-center gap-1.5">
        {entries.map((e, i) => (
          <button
            key={e.symbol}
            type="button"
            onClick={() => setFocusIdx(i)}
            className="h-2 rounded-full transition-all"
            style={{
              width: i === idx ? '20px' : '8px',
              background: i === idx ? FOCUS_DOT[e.state] : FOCUS_DOT[e.state] + '66',
            }}
            aria-label={e.symbol}
          />
        ))}
      </div>

      {/* 移动端单行报价条：仅显示当前品种 / mobile single-line quote bar: current symbol only */}
      <div className="lg:hidden">
        <QuoteBar quote={quotes[cur.symbol]} />
      </div>

      {/* 英雄卡 / hero card */}
      <div
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        className="glass animate-fade-in-up overflow-hidden p-4"
        style={{ boxShadow: `0 8px 32px rgba(0,0,0,.45), 0 0 30px ${tone.glow}, inset 0 1px 0 rgba(255,255,255,.08)` }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-400">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4l3 2" strokeLinecap="round" />
            </svg>
            {t('signals.focus.heading')} · {cur.symbol}
          </div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500">{t('signals.focus.rrLabel')}</div>
        </div>
        <div className="mt-1 flex items-end justify-between">
          <div className={`font-display text-5xl font-extrabold leading-none ${tone.color}`}>{stateLabel(cur.state)}</div>
          <div className={`font-display text-4xl font-bold leading-none ${hasSignal ? tone.color : 'text-slate-600'}`}>
            {hasSignal && rr?.rr != null ? `1:${rr.rr.toFixed(2)}` : '—'}
          </div>
        </div>

        {/* 全市场情绪条 / market sentiment bar */}
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="text-up">{t('signals.focus.long')} {sentiment.long}</span>
            <span className="uppercase tracking-wider text-slate-500">{t('signals.focus.marketSentiment')}</span>
            <span className="text-down">{t('signals.focus.short')} {sentiment.short}</span>
          </div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-white/10">
            <div style={{ width: `${longW}%`, background: 'linear-gradient(90deg,#1f9e6e,#2fe6a0)' }} />
            <div className="flex-1" />
            <div style={{ width: `${shortW}%`, background: 'linear-gradient(90deg,#ff4d6d,#b3263f)' }} />
          </div>
          <div className="mt-1 text-center text-[10px] text-slate-500">
            {t('signals.focus.watching')} {sentiment.watch} · {t('signals.focus.symbolsTotal', { n: sentiment.total })}
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5 text-sm text-slate-300">
          {hasSignal ? cur.signal!.indicator || t('signals.focus.waiting') : t('signals.focus.waiting')}
        </div>

        {hasSignal ? (
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('signals.focus.remainingTtl')}</div>
              <div className="font-mono text-sm text-amber-400">
                {calcCountdown(cur.signal!.expireAt, SIGNAL_LIFESPAN_MS, now)?.text ?? '-'}
              </div>
            </div>
            <button onClick={() => onTrade(cur.signal!)} className="btn-primary flex-1 rounded-xl py-3 text-sm font-semibold">
              {t('signals.focus.viewDetail')}
            </button>
          </div>
        ) : (
          <div className="mt-3 flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/12 py-2.5 text-xs text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-slate-500 animate-breathe" />
            {t('signals.focus.noExecutable')}
          </div>
        )}
      </div>

          {/* 实时报价区（桌面端完整面板）/ live quotes panel (desktop full panel) */}
          <div className="hidden lg:block">
            <QuotePanel quotes={quotes} mt5Online={anyOnline} />
          </div>
        </div>
        {/* 右栏：其他活跃信号 / right column: other active signals */}
        <div className="mt-5 lg:mt-0">
      {/* 其他活跃信号 / other active signals */}
      {others.length > 0 && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
              {t('signals.focus.otherActive')}
            </h3>
            <span className="chip">{others.length}</span>
          </div>

          {/* 筛选条：方向 / 状态 / 排序 + 形态切换 / filter bar + view toggle */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => setSideF((s) => (s === 'ALL' ? 'LONG' : s === 'LONG' ? 'SHORT' : 'ALL'))}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-slate-300"
            >
              {t('signals.filterSide')}{' '}
              <span className="text-slate-100">
                {sideF === 'ALL' ? t('signals.all') : sideF === 'LONG' ? t('signals.focus.long') : t('signals.focus.short')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setStatusF((s) => (s === 'ALL' ? 'ACTIVE' : s === 'ACTIVE' ? 'EXPIRING' : 'ALL'))}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-slate-300"
            >
              {t('signals.filterStatus')}{' '}
              <span className="text-slate-100">
                {statusF === 'ALL' ? t('signals.all') : statusF === 'ACTIVE' ? t('signals.active') : t('signals.expiringSoon')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setSortF((s) => (s === 'latest' ? 'expiry' : s === 'expiry' ? 'rr' : 'latest'))}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-slate-300"
            >
              {t('signals.sortBy')}{' '}
              <span className="text-slate-100">
                {sortF === 'latest' ? t('signals.sort.latest') : sortF === 'expiry' ? t('signals.sort.expiry') : t('signals.sort.rr')}
              </span>
            </button>

            {/* 形态切换：卡片 / 简洁 / view toggle: card / compact */}
            <div className="ml-auto flex items-center rounded-full border border-white/10 bg-white/5 p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('card')}
                className={`rounded-full px-3 py-1 transition-colors ${
                  viewMode === 'card' ? 'bg-prism-600/40 text-slate-100' : 'text-slate-400'
                }`}
              >
                {t('signals.viewCard')}
              </button>
              <button
                type="button"
                onClick={() => setViewMode('compact')}
                className={`rounded-full px-3 py-1 transition-colors ${
                  viewMode === 'compact' ? 'bg-prism-600/40 text-slate-100' : 'text-slate-400'
                }`}
              >
                {t('signals.viewCompact')}
              </button>
            </div>
          </div>

          <div className={viewMode === 'card' ? 'grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3' : 'grid grid-cols-1 gap-2'}>
            {visibleOthers.map(({ e, i }) => {
              const oTone = FOCUS_TONE[e.state]
              const sig = e.signal!
              const oRr = calcRiskReward(sig.symbol, sig.entry, sig.stopLoss, sig.takeProfit)
              const isNew = newIds.has(sig.id)
              const cd = calcCountdown(sig.expireAt, SIGNAL_LIFESPAN_MS, now)
              const sideTag = sig.side === 'BUY' ? t('common.buy') : t('common.sell')
              return (
                <div key={e.symbol}>
                  {/* 简洁形态：紧凑行 / compact layout: compact row */}
                  {viewMode === 'compact' && (
                  <button
                    type="button"
                    onClick={() => setFocusIdx(i)}
                    className={`glass flat-card flex w-full items-center gap-3 px-3 py-2.5 text-left ${isNew ? 'ring-2 ring-prism-500/70 animate-glow-pulse' : ''}`}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: FOCUS_DOT[e.state] + '1f' }}>
                      <span className="h-2 w-2 rounded-full" style={{ background: FOCUS_DOT[e.state] }} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-100">{e.symbol}</span>
                        <span className={`tag ${oTone.chipBg}`}>{stateLabel(e.state)}</span>
                      </div>
                      <div className="truncate text-[11px] text-slate-500">{sig.indicator || '-'}</div>
                    </div>
                    <div className="text-right">
                      <div className={`font-mono text-sm font-bold ${rrTone(oRr?.rr ?? null)}`}>
                        {oRr?.rr != null ? `1:${oRr.rr.toFixed(2)}` : '-'}
                      </div>
                      <div className="font-mono text-[10px] text-amber-400">{cd?.text ?? '-'}</div>
                    </div>
                  </button>
                  )}

                  {/* 卡片形态：完整卡片 / card layout: full card */}
                  {viewMode === 'card' && (
                  <div
                    className={`glass flat-card p-4 ${isNew ? 'ring-2 ring-prism-500/70 animate-glow-pulse' : ''}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-lg font-bold text-slate-100">{e.symbol}</span>
                        <span className={`tag ${oTone.chipBg}`}>{sideTag}</span>
                      </div>
                      <div className="text-right">
                        <div className={`font-display text-xl font-bold ${rrTone(oRr?.rr ?? null)}`}>
                          {oRr?.rr != null ? `1:${oRr.rr.toFixed(2)}` : '-'}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('signals.focus.rrLabel')}</div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <div className="min-w-0 rounded-xl bg-white/[0.03] px-1.5 py-2 text-center">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('signals.colEntry')}</div>
                        <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums tracking-tight text-slate-100">{sig.entry ?? '-'}</div>
                      </div>
                      <div className="min-w-0 rounded-xl border border-down/15 bg-down/5 px-1.5 py-2 text-center">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('signals.colSl')}</div>
                        <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums tracking-tight text-down">{sig.stopLoss ?? '-'}</div>
                      </div>
                      <div className="min-w-0 rounded-xl border border-up/15 bg-up/5 px-1.5 py-2 text-center">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('signals.colTp')}</div>
                        <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums tracking-tight text-up">{sig.takeProfit ?? '-'}</div>
                      </div>
                    </div>

                    <div className="mt-3">
                      <div className="mb-1 flex items-center justify-between text-[11px]">
                        <span className="uppercase tracking-wider text-slate-500">{t('signals.focus.remainingTtl')}</span>
                        <span className="font-mono text-amber-400">{cd?.text ?? '-'}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.round((cd?.fraction ?? 0) * 100)}%`, background: 'linear-gradient(90deg,#7c5cff,#2fe6a0)' }}
                        />
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-slate-300">{sig.indicator || '-'}</div>
                        <div className="text-[10px] text-slate-600">{fmtTime(sig.createdAt)}</div>
                      </div>
                      <button
                        onClick={() => onTrade(sig)}
                        className="btn-primary shrink-0 rounded-xl px-6 py-2.5 text-sm font-semibold"
                      >
                        {t('signals.trade')}
                      </button>
                    </div>
                  </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
        </div>
      </div>
    </div>
  )
}

export default function SignalsPage() {
  const { t } = useTranslation()
  const { signals, anyOnline, accounts, loaded, refreshAll, quotes } = useLive()
  const now = useNow(1000)
  const newIds = useNewSignalIds(signals)
  const focusEntries = useFocusEntries(signals, now)

  const [active, setActive] = useState<Signal | null>(null)
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

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

  return (
    <div>
      <div className="mb-5">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('signals.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('signals.subtitle')}</p>
      </div>

      {!loaded ? (
        <div className="glass flat-card flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-3 h-10 w-10 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
          <p className="text-sm text-slate-400">{t('common.loading')}</p>
        </div>
      ) : (
        <FocusView entries={focusEntries} now={now} newIds={newIds} onTrade={setActive} quotes={quotes} anyOnline={anyOnline} />
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
          className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastStyle}`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}
