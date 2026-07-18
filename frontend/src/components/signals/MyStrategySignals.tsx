// 个人策略信号卡：展示用户自建策略触发的信号。视觉上直接复用「其他活跃信号」
// 同款的迷你信号卡（sig-mini-card），只在角上加一个不起眼的「我的策略」灰色
// 标注区分来源，不用另起一套更醒目的样式——避免它在仪表盘/信号面板页里显得
// 比真正的执行卡还抢眼。一键下单复用 StrategiesPage 同款的 ChartOrderModal
// 手动下单弹窗（不经过 signalId，无任何 Order 相关改动）。挂在仪表盘执行卡
// 区域与 /app 信号面板页两处，数据源都是 live.tsx 里 WS 推送 + 首屏拉取的
// strategySignals。
//
// Personal strategy-signal card: visually reuses the same mini signal card
// as "other active signals" (sig-mini-card), with only a quiet gray "My
// Strategy" marking in the corner to distinguish the source — no separate,
// louder style that would otherwise outshine the real executable-signal
// card on the dashboard. One-click order reuses the same ChartOrderModal
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
    <section className="dash-others flex flex-col gap-3">
      <div className="flex items-center gap-2 px-0.5">
        <h3 className="text-[15px] font-bold">{t('strategy.mySignals')}</h3>
        <span className="count-badge">{strategySignals.length}</span>
      </div>

      <div className="others-list">
        {strategySignals.slice(0, 5).map((sig) => {
          const isBuy = sig.side === 'BUY'
          return (
            <div key={sig.id} className="card glass sig-mini-card">
              <div className="sig-mini-top">
                <div>
                  <b className="text-base text-white">{displaySymbol(sig.symbol)}</b>
                  <span className="chip chip-dim ml-2 align-middle">{t('strategy.myStrategyBadge')}</span>
                </div>
                <span className={`chip shrink-0 ml-auto ${isBuy ? 'chip-buy' : 'chip-sell'}`}>
                  {isBuy ? t('common.buy') : t('common.sell')}
                </span>
              </div>

              <div className="sig-mini-tiles">
                <div className="sig-tile">
                  <div className="cap">{t('signals.colEntry')}</div>
                  <div className="val num">{sig.entry ?? '-'}</div>
                </div>
                <div className="sig-tile sl">
                  <div className="cap">{t('signals.colSl')}</div>
                  <div className="val num">{sig.stopLoss ?? '-'}</div>
                </div>
                <div className="sig-tile tp">
                  <div className="cap">{t('signals.colTp')}</div>
                  <div className="val num">{sig.takeProfit ?? '-'}</div>
                </div>
              </div>

              <div className="flex items-center gap-2 mt-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] text-slate-500">{fmtTime(sig.createdAt)}</div>
                </div>
                <button
                  onClick={() => setOrderTarget(sig)}
                  className="btn btn-primary rounded-lg h-[34px] px-4 text-[13px] shrink-0"
                >
                  {t('strategy.oneClickOrder')}
                </button>
              </div>
            </div>
          )
        })}
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
