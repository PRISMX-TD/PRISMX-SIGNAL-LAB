// 信号面板页：信号网格 + 返回仪表盘
// Signals page: signal grid + back to dashboard
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useLive } from '../store/live'
import type { Signal } from '../api/types'
import SignalGrid from '../components/signals/SignalGrid'
import SlideOrderModal from '../components/SlideOrderModal'
import { useNow, useOrderPlacement, toastToneClass } from '../components/signals/hooks'

export default function SignalsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { signals, accounts, loaded, quotes } = useLive()
  const now = useNow(1000)
  const [activeSignal, setActiveSignal] = useState<Signal | null>(null)
  const { toast, placeOrder } = useOrderPlacement()

  const openTrade = useCallback((s: Signal) => setActiveSignal(s), [])

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
        <div>
          <button onClick={() => navigate('/dashboard')} className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            {t('signals.focus.backToDashboard', '返回仪表盘')}
          </button>
          <SignalGrid signals={signals} now={now} onTrade={openTrade} />
        </div>
      )}
      {activeSignal && <SlideOrderModal signal={activeSignal} accounts={accounts} quote={quotes[activeSignal.symbol]} onCancel={() => setActiveSignal(null)} onConfirm={handleConfirm} />}
      {toast && <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastToneClass(toast.kind)}`}>{toast.msg}</div>}
    </div>
  )
}
