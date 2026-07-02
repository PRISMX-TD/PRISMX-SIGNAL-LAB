// 仪表盘页：英雄卡 + 执行卡 + 其他信号 + 行情表 + 市场概览
// Dashboard page: hero + exec + others + quotes + overview
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useLive } from '../store/live'
import { orderApi } from '../api/client'
import { clientOrderId } from '../api/utils'
import type { Signal } from '../api/types'
import SignalHero from '../components/signals/SignalHero'
import SignalExec from '../components/signals/SignalExec'
import SignalOthers from '../components/signals/SignalOthers'
import QuotesTable from '../components/signals/QuotesTable'
import MarketOverview from '../components/signals/MarketOverview'
import SlideOrderModal from '../components/SlideOrderModal'
import { useFocusEntries, useNewSignalIds, useNow } from '../components/signals/hooks'
import { trendStance, type TrendStance } from '../components/signals/signalView'
import type { FocusState } from '../components/signals/signalView'

export default function DashboardPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { signals, anyOnline, accounts, loaded, refreshAll, quotes, trends } = useLive()
  const now = useNow(1000)
  const newIds = useNewSignalIds(signals)
  const focusEntries = useFocusEntries(signals, now)

  const [focusIdx, setFocusIdx] = useState(0)
  const [activeSignal, setActiveSignal] = useState<Signal | null>(null)
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])

  const showToast = (msg: string, kind: 'success' | 'error' | 'info' = 'success', ms = 3000) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ msg, kind })
    toastTimer.current = window.setTimeout(() => setToast(null), ms)
  }

  const idx = Math.min(focusIdx, Math.max(0, focusEntries.length - 1))
  const cur = focusEntries[idx]
  const stance: TrendStance = cur ? trendStance(trends[cur.symbol]) : 'NEUTRAL'
  const nameOf = (sym: string) => t(`signals.symbolNames.${sym}`, { defaultValue: '' })

  const sentiment = useMemo(() => {
    let long = 0, short = 0, watch = 0
    for (const e of focusEntries) {
      const st = trendStance(trends[e.symbol])
      if (st === 'BULL') long += 1
      else if (st === 'BEAR') short += 1
      else watch += 1
    }
    return { long, short, watch, total: focusEntries.length }
  }, [focusEntries, trends])

  const otherEntries = useMemo(() => {
    return focusEntries
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.i !== idx && e.state !== 'WATCH' && e.signal != null)
      .map(({ symbol, state, signal, i }) => ({ symbol, state: state as FocusState, signal: signal!, idx: i }))
  }, [focusEntries, idx])

  const goPrev = () => setFocusIdx((i) => (i - 1 + focusEntries.length) % focusEntries.length)
  const goNext = () => setFocusIdx((i) => (i + 1) % focusEntries.length)

  const handleConfirm = async (volume: number, mt5Login: string | null, stopLoss: number | null, takeProfit: number | null) => {
    if (!activeSignal) return
    const placed = await orderApi.place({
      signalId: activeSignal.id, symbol: activeSignal.symbol, side: activeSignal.side,
      volume, clientOrderId: clientOrderId(), mt5Login, stopLoss, takeProfit,
    })
    setActiveSignal(null); refreshAll()
    if (placed.status === 'FILLED') { showToast(t('order.filled', { price: placed.filledPrice ?? '-' }), 'success'); return }
    if (placed.status === 'REJECTED' || placed.status === 'FAILED') { showToast(t('order.rejected', { msg: placed.message || '-' }), 'error'); return }
    showToast(t('order.submitted'), 'info', 8000)
    await waitForReceipt(placed.id)
  }

  const waitForReceipt = async (orderId: string) => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1500))
      try {
        const { orders } = await orderApi.list()
        const o = orders.find((x) => x.id === orderId)
        if (!o) continue
        if (o.status === 'FILLED') { showToast(t('order.filled', { price: o.filledPrice ?? '-' }), 'success'); refreshAll(); return }
        if (o.status === 'REJECTED' || o.status === 'FAILED') { showToast(t('order.rejected', { msg: o.message || '-' }), 'error'); refreshAll(); return }
      } catch { /* continue polling */ }
    }
    showToast(t('order.ackTimeout'), 'info')
  }

  const toastStyle = toast?.kind === 'error' ? 'border-down/40 bg-down/15 text-down' : toast?.kind === 'info' ? 'border-prism-600/40 bg-prism-600/15 text-prism-300' : 'border-up/40 bg-up/15 text-up'

  return (
    <div className="max-w-[1520px] mx-auto">
      {!loaded ? (
        <div className="glass flat-card flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-3 h-10 w-10 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
          <p className="text-sm text-slate-400">{t('common.loading')}</p>
        </div>
      ) : (
        <div className="dash-grid">
          {cur ? (
            <>
              <SignalHero symbol={cur.symbol} cnName={nameOf(cur.symbol)} entriesCount={focusEntries.length} focusIdx={idx} focusTotal={focusEntries.length} stance={stance} trend={trends[cur.symbol]} sentiment={sentiment} onPrev={goPrev} onNext={goNext} onSelectIdx={setFocusIdx} />
              {cur.signal ? <SignalExec signal={cur.signal} now={now} onTrade={(s) => setActiveSignal(s)} /> : (
                <section className="card glass dash-exec p-4 flex items-center justify-center text-sm text-slate-500"><span className="h-1.5 w-1.5 rounded-full bg-slate-500 animate-breathe mr-2" />{t('signals.focus.noExecutable')}</section>
              )}
              <SignalOthers entries={otherEntries} newIds={newIds} now={now} onTrade={(s) => setActiveSignal(s)} onFocus={(i) => setFocusIdx(i)} onViewAll={() => navigate('/app')} />
            </>
          ) : (
            <>
              <section className="card glass dash-hero p-8 flex flex-col items-center justify-center text-center gap-3">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="opacity-50"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
                <h2 className="text-lg font-bold text-white">{t('signals.title')}</h2>
                <p className="text-sm text-slate-400 max-w-xs">{t('signals.waitingForSignals', '等待信号引擎或 TradingView 推送信号……')}</p>
              </section>
              <section className="card glass dash-exec p-4 flex items-center justify-center text-sm text-slate-500"><span className="h-1.5 w-1.5 rounded-full bg-slate-500 animate-breathe mr-2" />{t('signals.focus.noExecutable')}</section>
              <section className="card glass dash-others p-4 flex items-center justify-center text-sm text-slate-500">{t('signals.focus.noExecutable')}</section>
            </>
          )}
          <QuotesTable signals={signals} quotes={quotes} mt5Online={anyOnline} onTrade={(s) => setActiveSignal(s)} />
          <MarketOverview signals={signals} trends={trends} />
        </div>
      )}
      {activeSignal && <SlideOrderModal signal={activeSignal} accounts={accounts} quote={quotes[activeSignal.symbol]} onCancel={() => setActiveSignal(null)} onConfirm={handleConfirm} />}
      {toast && <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastStyle}`}>{toast.msg}</div>}
    </div>
  )
}
