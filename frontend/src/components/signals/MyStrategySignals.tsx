// 个人策略信号卡：展示用户自建策略触发的信号，与全站信号视觉上用「我的策略」
// 徽标区分开，一键下单复用 StrategiesPage 同款的 ChartOrderModal 手动下单弹窗
// （不经过 signalId，无任何 Order 相关改动）。挂在仪表盘执行卡区域与 /app
// 信号面板页两处，数据源都是 live.tsx 里 WS 推送 + 首屏拉取的 strategySignals。
//
// Personal strategy-signal card: shows signals fired by the user's own
// strategies, visually tagged "My Strategy" to distinguish them from
// platform-wide signals. One-click order reuses the same ChartOrderModal
// manual-order flow as StrategiesPage.tsx (no signalId, no Order-side
// changes). Mounted on both the dashboard's exec-card area and the /app
// signals page; both read the same `strategySignals` slice from live.tsx
// (WS push + first-load fetch).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLive, useQuotes } from '../../store/live'
import type { StrategySignal } from '../../api/types'
import { displaySymbol, fmtTime } from '../../api/utils'
import ChartOrderModal from '../ChartOrderModal'
import { useOrderPlacement, toastToneClass } from './hooks'
import { useBackToClose } from '../../utils/useBackToClose'

export default function MyStrategySignals() {
  const { t } = useTranslation()
  const { strategySignals, accounts } = useLive()
  const quotesByAccount = useQuotes()
  const [orderTarget, setOrderTarget] = useState<StrategySignal | null>(null)
  useBackToClose(orderTarget != null, () => setOrderTarget(null))
  const { toast, placeManualOrder } = useOrderPlacement()

  if (strategySignals.length === 0) return null

  const handleOrderConfirm = async (volume: number, mt5Login: string | null, stopLoss: number | null, takeProfit: number | null) => {
    if (!orderTarget) return
    await placeManualOrder(orderTarget.symbol, orderTarget.side, volume, mt5Login, stopLoss, takeProfit)
  }

  return (
    <section className="card glass p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-100">{t('strategy.mySignals')}</h3>
      <div className="flex flex-col gap-2">
        {strategySignals.slice(0, 5).map((sig) => (
          <div key={sig.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center gap-2">
              <span className="tag bg-prism-600/15 text-prism-300">{t('strategy.myStrategyBadge')}</span>
              <span className={`tag ${sig.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                {sig.side === 'BUY' ? t('common.buy') : t('common.sell')}
              </span>
              <span className="font-mono text-sm text-slate-100">{displaySymbol(sig.symbol)}</span>
              <span className="text-xs text-slate-500">{fmtTime(sig.createdAt)}</span>
            </div>
            <button onClick={() => setOrderTarget(sig)} className="btn-primary px-4 py-1.5 text-xs">
              {t('strategy.oneClickOrder')}
            </button>
          </div>
        ))}
      </div>

      {orderTarget && (
        <ChartOrderModal
          symbol={orderTarget.symbol}
          side={orderTarget.side}
          accounts={accounts}
          quotesByAccount={quotesByAccount}
          refPrice={orderTarget.entry}
          initialStopLoss={orderTarget.stopLoss}
          initialTakeProfit={orderTarget.takeProfit}
          onCancel={() => setOrderTarget(null)}
          onConfirm={handleOrderConfirm}
        />
      )}
      {toast && <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastToneClass(toast.kind)}`}>{toast.msg}</div>}
    </section>
  )
}
