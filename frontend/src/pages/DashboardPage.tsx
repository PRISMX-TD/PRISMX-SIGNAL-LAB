// 仪表盘页：英雄卡 + 执行卡 + 其他信号 + 行情表 + 市场概览
// Dashboard page: hero + exec + others + quotes + overview
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useLive, useQuotes } from '../store/live'
import { useSentiment } from '../api/useSentiment'
import type { Signal } from '../api/types'
import SignalHero from '../components/signals/SignalHero'
import SignalExec from '../components/signals/SignalExec'
import SignalOthers from '../components/signals/SignalOthers'
import QuotesTable from '../components/signals/QuotesTable'
import MarketOverview from '../components/signals/MarketOverview'
// 信号客观胜率卡暂时隐藏，暂不使用 / hidden for now
// import StrategyWinRateCard from '../components/signals/StrategyWinRateCard'
import PersonalWinRateCard from '../components/PersonalWinRateCard'
import SlideOrderModal from '../components/SlideOrderModal'
import { useFocusEntries, useNow, useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import { trendStance, type TrendStance } from '../components/signals/signalView'
import type { FocusState } from '../components/signals/signalView'

export default function DashboardPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { signals, anyOnline, accounts, loaded, trends } = useLive()
  const quotes = useQuotes()
  const now = useNow(1000)
  const { sentiment } = useSentiment()
  const focusEntries = useFocusEntries(signals, now)
  const { toast, placeOrder } = useOrderPlacement()

  const [focusIdx, setFocusIdx] = useState(0)
  const [activeSignal, setActiveSignal] = useState<Signal | null>(null)

  const idx = Math.min(focusIdx, Math.max(0, focusEntries.length - 1))
  const cur = focusEntries[idx]
  const stance: TrendStance = cur ? trendStance(trends[cur.symbol]) : 'NEUTRAL'
  const nameOf = (sym: string) => t(`signals.symbolNames.${sym}`, { defaultValue: '' })

  const otherEntries = useMemo(() => {
    return focusEntries
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.i !== idx && e.state !== 'WATCH' && e.signal != null)
      .map(({ symbol, state, signal, i }) => ({ symbol, state: state as FocusState, signal: signal!, idx: i }))
  }, [focusEntries, idx])

  // 稳定回调，让 memo 化的子组件不因父级重渲染而更新
  // stable callbacks so memoized children skip parent-driven re-renders
  const total = focusEntries.length
  const goPrev = useCallback(() => setFocusIdx((i) => (i - 1 + total) % total), [total])
  const goNext = useCallback(() => setFocusIdx((i) => (i + 1) % total), [total])
  const openTrade = useCallback((s: Signal) => setActiveSignal(s), [])
  const goSignals = useCallback(() => navigate('/app'), [navigate])

  const handleConfirm = async (volume: number, mt5Login: string | null, stopLoss: number | null, takeProfit: number | null) => {
    if (!activeSignal) return
    const sig = activeSignal
    await placeOrder(sig, volume, mt5Login, stopLoss, takeProfit)
    setActiveSignal(null)
  }

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
              <div className="dash-col-1">
                <SignalHero symbol={cur.symbol} cnName={nameOf(cur.symbol)} focusIdx={idx} focusTotal={focusEntries.length} stance={stance} trend={trends[cur.symbol]} sentiment={sentiment[cur.symbol] ?? null} onPrev={goPrev} onNext={goNext} onSelectIdx={setFocusIdx} />
                <QuotesTable quotes={quotes} mt5Online={anyOnline} focusSymbol={cur?.symbol} />
              </div>
              <div className="dash-col-2">
                <SignalExec signal={cur.signal} now={now} onTrade={openTrade} />
                <MarketOverview signals={signals} />
                {/* 信号客观胜率卡暂时隐藏，暂不使用 / hidden for now */}
                {/* <StrategyWinRateCard /> */}
                <PersonalWinRateCard />
              </div>
              <SignalOthers entries={otherEntries} now={now} onTrade={openTrade} onFocus={setFocusIdx} onViewAll={goSignals} />
            </>
          ) : (
            <>
              <div className="dash-col-1">
                <section className="card glass dash-hero p-8 flex flex-col items-center justify-center text-center gap-3">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="opacity-50"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
                  <h2 className="text-lg font-bold text-white">{t('signals.title')}</h2>
                  <p className="text-sm text-slate-400 max-w-xs">{t('signals.waitingForSignals', '等待信号引擎或 TradingView 推送信号……')}</p>
                </section>
                <QuotesTable quotes={quotes} mt5Online={anyOnline} />
              </div>
              <div className="dash-col-2">
                <SignalExec signal={null} now={now} onTrade={openTrade} />
                <MarketOverview signals={signals} />
                {/* 信号客观胜率卡暂时隐藏，暂不使用 / hidden for now */}
                {/* <StrategyWinRateCard /> */}
                <PersonalWinRateCard />
              </div>
              <section className="card glass dash-others p-4 flex items-center justify-center text-sm text-slate-500">{t('signals.focus.noExecutable')}</section>
            </>
          )}
        </div>
      )}
      {activeSignal && <SlideOrderModal signal={activeSignal} accounts={accounts} quote={quotes[activeSignal.symbol]} onCancel={() => setActiveSignal(null)} onConfirm={handleConfirm} />}
      {toast && <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastToneClass(toast.kind)}`}>{toast.msg}</div>}
    </div>
  )
}
