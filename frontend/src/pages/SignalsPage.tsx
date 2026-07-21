// 信号面板页：信号网格 + 返回仪表盘
// Signals page: signal grid + back to dashboard
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../store/auth'
import { useLive, useQuotes } from '../store/live'
import SignalGrid from '../components/signals/SignalGrid'
import SlideOrderModal from '../components/SlideOrderModal'
import { useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import { strategySignalToDisplay, type DisplaySignal } from '../components/signals/SignalView'
import { useBackToClose } from '../utils/useBackToClose'

export default function SignalsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { signals, strategySignals, accounts, loaded } = useLive()
  const accountQuotes = useQuotes()
  const [activeSignal, setActiveSignal] = useState<DisplaySignal | null>(null)
  // 下单弹窗是全屏的，手机上划返回应该先关掉弹窗、而不是直接退出信号面板页
  // （见 useBackToClose 的说明）。/ The order modal is full-screen; on
  // mobile, swiping back should close it first rather than exiting the
  // signals page outright (see useBackToClose's comment).
  useBackToClose(activeSignal != null, () => setActiveSignal(null))
  const { toast, placeOrder, placeManualOrder } = useOrderPlacement()

  // 个人策略信号混进普通信号网格一起展示——同样的卡片、按时间统一排序，
  // 不再单独占一块地方。/ Personal strategy signals are folded into the
  // normal signal grid — same card, sorted into the same chronological
  // order, no separate section.
  const combinedSignals = useMemo(
    () => [...signals, ...strategySignals.map((s) => strategySignalToDisplay(s, t('strategy.myStrategyBadge')))],
    [signals, strategySignals, t]
  )

  const openTrade = useCallback((s: DisplaySignal) => setActiveSignal(s), [])

  const handleConfirm = async (volume: number, mt5Login: string | null, stopLoss: number | null, takeProfit: number | null, clientOrderId: string) => {
    if (!activeSignal) return
    const sig = activeSignal
    // 提交成功后不在这里关弹窗：SlideOrderModal 自己会展示"已提交"回执卡片，
    // 再等 2 秒调用 onCancel 关闭。这里若立刻 setActiveSignal(null)，弹窗会
    // 在回执卡片渲染出来之前就被卸载，用户永远看不到提交确认。
    // Don't close the modal here on success: SlideOrderModal shows its own
    // "submitted" receipt card and calls onCancel itself ~2s later. Closing it
    // immediately here used to unmount the modal before the receipt card ever
    // got to render, so the user never saw a submit confirmation.
    // 个人策略信号没有真实 signalId,走不带 signalId 的手动下单路径,避免
    // 污染平台胜率统计;平台信号照常走 placeOrder。
    // Personal strategy signals have no real signalId — submit through the
    // signalId-less manual path so they never pollute the platform win-rate
    // stats; platform signals still go through placeOrder as before.
    if (sig.strategySignal) {
      await placeManualOrder(sig.symbol, sig.side, volume, mt5Login, stopLoss, takeProfit, clientOrderId)
    } else {
      await placeOrder(sig, volume, mt5Login, stopLoss, takeProfit, clientOrderId)
    }
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
          <SignalGrid signals={combinedSignals} onTrade={openTrade} userPlan={user?.plan} />
        </div>
      )}
      {activeSignal && <SlideOrderModal signal={activeSignal} accounts={accounts} quotesByAccount={accountQuotes} onCancel={() => setActiveSignal(null)} onConfirm={handleConfirm} />}
      {toast && <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastToneClass(toast.kind)}`}>{toast.msg}</div>}
    </div>
  )
}
