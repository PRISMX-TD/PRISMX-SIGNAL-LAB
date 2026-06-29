// 信号面板页 / Signals dashboard page
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLive } from '../store/live'
import { orderApi } from '../api/client'
import { clientOrderId, fmtTime } from '../api/utils'
import type { Signal } from '../api/types'
import OrderModal from '../components/OrderModal'

function SignalCard({ signal, onTrade }: { signal: Signal; onTrade: (s: Signal) => void }) {
  const { t } = useTranslation()
  const isBuy = signal.side === 'BUY'
  const expired = signal.status === 'EXPIRED'

  return (
    <div className={`glass-neon animate-fade-in-up p-5 ${expired ? 'opacity-50 grayscale' : ''}`}>
      <div className="mb-3 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="font-display text-lg font-bold tracking-wide text-slate-100">
            {signal.symbol}
          </span>
          <span className={`tag ${isBuy ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
            {isBuy ? t('common.buy') : t('common.sell')}
          </span>
        </div>
        <span
          className={`tag ${
            expired ? 'bg-white/5 text-slate-500' : 'border border-prism-500/30 bg-prism-600/15 text-prism-300'
          }`}
        >
          {expired ? t('signals.expired') : t('signals.active')}
        </span>
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

export default function SignalsPage() {
  const { t } = useTranslation()
  const { signals, anyOnline, accounts, loaded, refreshAll } = useLive()
  const [active, setActive] = useState<Signal | null>(null)
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

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

    // 若已是终态直接提示；否则轮询等待真实回执 / show terminal status, else poll for the real receipt
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
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('signals.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('signals.subtitle')}</p>
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
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {signals.map((s) => (
            <SignalCard key={s.id} signal={s} onTrade={setActive} />
          ))}
        </div>
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
