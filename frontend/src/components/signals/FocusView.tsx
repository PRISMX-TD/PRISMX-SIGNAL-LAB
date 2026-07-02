// focus 视图：单品种聚焦英雄卡 + 全市场情绪 + 其他活跃信号。
// Focus view: per-symbol hero card + market sentiment + other active signals.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { usePrefs } from '../../store/prefs'
import { fmtTime, calcRiskReward, calcCountdown } from '../../api/utils'
import type { Signal, Quote, Trend } from '../../api/types'
import MultiTfTrend from './MultiTfTrend'
import { QuoteBar, QuotePanel } from './QuotePanel'
import {
  FOCUS_DOT,
  FOCUS_TONE,
  SIGNAL_LIFESPAN_MS,
  STANCE_TONE,
  effectiveStatus,
  rrTone,
  trendStance,
  type FocusEntry,
  type FocusState,
  type TrendStance,
} from './signalView'

export default function FocusView({
  entries,
  now,
  newIds,
  onTrade,
  quotes,
  trends,
  anyOnline,
}: {
  entries: FocusEntry[]
  now: number
  newIds: Set<string>
  onTrade: (s: Signal) => void
  quotes: Record<string, Quote>
  trends: Record<string, Trend>
  anyOnline: boolean
}) {
  const { t } = useTranslation()
  const { getPref, setPref } = usePrefs()
  const [focusIdx, setFocusIdx] = useState(0)
  // 触摸滑动切换卡片（移动端/PWA）/ touch-swipe to switch cards (mobile/PWA)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  // 其他活跃信号的筛选与排序 / filter & sort for the other-active list
  const [sideF, setSideF] = useState<'ALL' | 'LONG' | 'SHORT'>(
    () => (getPref<string>('signals', 'sideF', 'ALL')) as 'ALL' | 'LONG' | 'SHORT'
  )
  const [statusF, setStatusF] = useState<'ALL' | 'ACTIVE' | 'EXPIRING'>(
    () => (getPref<string>('signals', 'statusF', 'ALL')) as 'ALL' | 'ACTIVE' | 'EXPIRING'
  )
  const [sortF, setSortF] = useState<'latest' | 'expiry' | 'rr'>(
    () => (getPref<string>('signals', 'sortF', 'latest')) as 'latest' | 'expiry' | 'rr'
  )
  // 列表形态：卡片 / 简洁 / list layout: card or compact
  const [viewMode, setViewMode] = useState<'card' | 'compact'>(
    () => (getPref<string>('signals', 'viewMode', 'card')) as 'card' | 'compact'
  )

  // 持久化筛选/排序/视图偏好到云端 / persist filter/sort/view prefs to cloud
  useEffect(() => { setPref('signals', 'sideF', sideF) }, [sideF, setPref])
  useEffect(() => { setPref('signals', 'statusF', statusF) }, [statusF, setPref])
  useEffect(() => { setPref('signals', 'sortF', sortF) }, [sortF, setPref])
  useEffect(() => { setPref('signals', 'viewMode', viewMode) }, [viewMode, setPref])

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
      const st = trendStance(trends[e.symbol])
      if (st === 'BULL') long += 1
      else if (st === 'BEAR') short += 1
      else watch += 1
    }
    return { long, short, watch, total: entries.length }
  }, [entries, trends])

  if (!cur) return null

  // 立场标签：由多周期趋势加权合成，与交易信号解耦 / stance label from weighted trend
  const stanceLabel = (st: TrendStance) =>
    st === 'BULL' ? t('signals.focus.bull') : st === 'BEAR' ? t('signals.focus.bear') : t('signals.focus.neutral')
  const stanceAdvice = (st: TrendStance) =>
    st === 'BULL' ? t('signals.focus.adviceBull') : st === 'BEAR' ? t('signals.focus.adviceBear') : t('signals.focus.adviceNeutral')
  // 交易信号方向标签（其他活跃信号列表用，仍是做多/做空）/ trade-signal side label
  const stateLabel = (s: FocusState) =>
    s === 'LONG' ? t('signals.focus.long') : s === 'SHORT' ? t('signals.focus.short') : t('signals.focus.watch')
  const nameOf = (sym: string) => t(`signals.symbolNames.${sym}`, { defaultValue: '' })

  const stance = trendStance(trends[cur.symbol])
  const tone = STANCE_TONE[stance]
  const hasSignal = cur.state !== 'WATCH' && cur.signal != null
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
        {entries.map((e, i) => {
          // 圆点颜色随多周期趋势立场，与英雄卡大字一致 / dots follow trend stance
          const dot = STANCE_TONE[trendStance(trends[e.symbol])].dot
          return (
            <button
              key={e.symbol}
              type="button"
              onClick={() => setFocusIdx(i)}
              className="h-2 rounded-full transition-all"
              style={{
                width: i === idx ? '20px' : '8px',
                background: i === idx ? dot : dot + '66',
              }}
              aria-label={e.symbol}
            />
          )
        })}
      </div>

      {/* 移动端单行报价条：仅显示当前品种 / mobile single-line quote bar: current symbol only */}
      <div className="lg:hidden">
        <QuoteBar quote={quotes[cur.symbol]} />
      </div>

      {/* 英雄卡 + 可执行信号：两张独立卡 / hero + signal as two separate cards */}
      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} className="space-y-3">
        {/* 多周期趋势英雄卡 / multi-TF trend hero card */}
        <div className="glass animate-fade-in-up p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-400">
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4l3 2" strokeLinecap="round" />
            </svg>
            {t('signals.focus.heading')} · {cur.symbol}
          </div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500">{t('signals.focus.trendLabel')}</div>
        </div>
        <div className="mt-2.5 flex items-end justify-between">
          <div className={`font-display text-4xl font-extrabold leading-none ${tone.color}`}>{stanceLabel(stance)}</div>
          <MultiTfTrend trend={trends[cur.symbol]} />
        </div>

        {/* 全市场情绪条 / market sentiment bar */}
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="text-up">{t('signals.focus.bull')} {sentiment.long}</span>
            <span className="uppercase tracking-wider text-slate-500">{t('signals.focus.marketSentiment')}</span>
            <span className="text-down">{t('signals.focus.bear')} {sentiment.short}</span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
            <div style={{ width: `${longW}%`, background: 'linear-gradient(90deg,#1f9e6e,#2ee07e)' }} />
            <div className="flex-1" />
            <div style={{ width: `${shortW}%`, background: 'linear-gradient(90deg,#ff4d67,#c22743)' }} />
          </div>
          <div className="mt-1.5 text-center text-[10px] text-slate-500">
            {t('signals.focus.watching')} {sentiment.watch} · {t('signals.focus.symbolsTotal', { n: sentiment.total })}
          </div>
        </div>

        {/* 趋势立场解读 / stance interpretation */}
        <div className="mt-3 rounded-inner border border-white/[0.08] bg-white/[0.05] px-3 py-2.5 text-center text-[13px] text-slate-300">
          {stanceAdvice(stance)}
        </div>
        </div>

        {/* 可执行信号：独立卡片 / executable signal: separate card */}
        <div className="glass p-4">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-400">
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 17l5-6 4 4 5-7 4 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t('signals.focus.signalHeading')}
        </div>

        {hasSignal ? (
          <>
            <div className="mt-2 flex items-center gap-2">
              <span className="font-display text-base font-bold text-slate-100">{cur.symbol}</span>
              <span className={`tag ${cur.signal!.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                {cur.signal!.side === 'BUY' ? t('common.buy') : t('common.sell')}
              </span>
              {cur.signal!.indicator && (
                <span className="ml-auto text-xs text-slate-400">{cur.signal!.indicator}</span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div className="min-w-0 rounded-inner bg-white/[0.05] px-1.5 py-2 text-center">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('signals.colEntry')}</div>
                <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums tracking-tight text-slate-100">{cur.signal!.entry ?? '-'}</div>
              </div>
              <div className="min-w-0 rounded-inner border border-down/20 bg-down/5 px-1.5 py-2 text-center">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('signals.colSl')}</div>
                <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums tracking-tight text-down">{cur.signal!.stopLoss ?? '-'}</div>
              </div>
              <div className="min-w-0 rounded-inner border border-up/20 bg-up/5 px-1.5 py-2 text-center">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">{t('signals.colTp')}</div>
                <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums tracking-tight text-up">{cur.signal!.takeProfit ?? '-'}</div>
              </div>
            </div>
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="uppercase tracking-wider text-slate-500">{t('signals.focus.remainingTtl')}</span>
                <span className="font-mono text-prism-300">
                  {calcCountdown(cur.signal!.expireAt, SIGNAL_LIFESPAN_MS, now)?.text ?? '-'}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.round((calcCountdown(cur.signal!.expireAt, SIGNAL_LIFESPAN_MS, now)?.fraction ?? 0) * 100)}%`, background: 'linear-gradient(90deg,#7c3aed,#a855f7)' }}
                />
              </div>
            </div>
            <button onClick={() => onTrade(cur.signal!)} className="btn-primary mt-3 w-full py-2.5 text-sm font-semibold">
              {t('signals.trade')}
            </button>
          </>
        ) : (
          <div className="mt-2 flex items-center justify-center gap-2 rounded-inner bg-white/[0.02] py-4 text-xs text-slate-500">
            <span className="h-1.5 w-1.5 rounded-full bg-slate-500 animate-breathe" />
            {t('signals.focus.noExecutable')}
          </div>
        )}
      </div>
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
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => setSideF((s) => (s === 'ALL' ? 'LONG' : s === 'LONG' ? 'SHORT' : 'ALL'))}
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300"
            >
              {t('signals.filterSide')}{' '}
              <span className="text-slate-100">
                {sideF === 'ALL' ? t('signals.all') : sideF === 'LONG' ? t('signals.focus.long') : t('signals.focus.short')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setStatusF((s) => (s === 'ALL' ? 'ACTIVE' : s === 'ACTIVE' ? 'EXPIRING' : 'ALL'))}
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300"
            >
              {t('signals.filterStatus')}{' '}
              <span className="text-slate-100">
                {statusF === 'ALL' ? t('signals.all') : statusF === 'ACTIVE' ? t('signals.active') : t('signals.expiringSoon')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setSortF((s) => (s === 'latest' ? 'expiry' : 'latest'))}
              className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300"
            >
              {t('signals.sortBy')}{' '}
              <span className="text-slate-100">
                {sortF === 'latest' ? t('signals.sort.latest') : t('signals.sort.expiry')}
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
                      <div className="font-mono text-[10px] text-prism-300">{cd?.text ?? '-'}</div>
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
                        <span className="font-mono text-prism-300">{cd?.text ?? '-'}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.round((cd?.fraction ?? 0) * 100)}%`, background: 'linear-gradient(90deg,#7c3aed,#a855f7)' }}
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
