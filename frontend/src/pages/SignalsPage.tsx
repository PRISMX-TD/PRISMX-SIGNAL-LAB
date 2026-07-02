// 信号面板页：信号网格 + 返回仪表盘
// Signals page: signal grid + back to dashboard
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useLive } from '../store/live'
import { orderApi } from '../api/client'
import { clientOrderId } from '../api/utils'
import type { Signal } from '../api/types'
import SignalGrid from '../components/signals/SignalGrid'
import SlideOrderModal from '../components/SlideOrderModal'
import { useNewSignalIds, useNow } from '../components/signals/hooks'

export default function SignalsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { signals, accounts, loaded, refreshAll, quotes } = useLive()
  const now = useNow(1000)
  const newIds = useNewSignalIds(signals)

  const [activeSignal, setActiveSignal] = useState<Signal | null>(null)
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])

  const showToast = (msg: string, kind: 'success' | 'error' | 'info' = 'success', ms = 3000) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ msg, kind })
    toastTimer.current = window.setTimeout(() => setToast(null), ms)
  }

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
        <div>
          <button onClick={() => navigate('/dashboard')} className="mb-4 flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            {t('signals.focus.backToDashboard', '返回仪表盘')}
          </button>
          <SignalGrid signals={signals} newIds={newIds} now={now} onTrade={(s) => setActiveSignal(s)} />
        </div>
      )}
      {activeSignal && <SlideOrderModal signal={activeSignal} accounts={accounts} quote={quotes[activeSignal.symbol]} onCancel={() => setActiveSignal(null)} onConfirm={handleConfirm} />}
      {toast && <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastStyle}`}>{toast.msg}</div>}
    </div>
  )
}
