// 仪表盘页：英雄卡 + 执行卡 + 其他信号 + 行情表 + 当前时段胜率
// Dashboard page: hero + exec + others + quotes + current-session win rate
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useGlobalQuotes, useLive, useQuotes } from '../store/live'
import { useSentiment } from '../api/useSentiment'
import NotifDeviceBanner from '../components/NotifDeviceBanner'
import OnboardingCard from '../components/OnboardingCard'
import { SkeletonPage } from '../components/Skeleton'
import SignalHero from '../components/signals/SignalHero'
import SignalExec from '../components/signals/SignalExec'
import SignalOthers from '../components/signals/SignalOthers'
import QuotesTable from '../components/signals/QuotesTable'
import SessionWinrateCard from '../components/winrate/SessionWinrateCard'
import PersonalWinRateCard from '../components/PersonalWinRateCard'
import Toast from '../components/Toast'
import SlideOrderModal from '../components/SlideOrderModal'
import { useFocusEntries, useNow, useOrderPlacement } from '../components/signals/hooks'
import { trendStance, strategySignalToDisplay, type DisplaySignal, type TrendStance } from '../components/signals/SignalView'
import type { FocusState } from '../components/signals/SignalView'
import { useBackToClose } from '../utils/useBackToClose'

export default function DashboardPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { signals, strategySignals, anyOnline, accounts, loaded, trends, activeSymbols } = useLive()
  // 展示用全站统一报价（英雄板/报价表）与按账户区分的报价（下单确认页）分开取
  // Site-wide display quotes (hero/quotes table) vs per-account quotes (order confirmation)
  const globalQuotes = useGlobalQuotes()
  const accountQuotes = useQuotes()
  const now = useNow(1000)
  const { sentiment } = useSentiment()
  // 个人策略信号混进普通信号流一起参与焦点轮播的选择——不再单独占一块地方,
  // 设计与排位都跟平台信号一视同仁；市场概览是全平台口径统计,仍然只吃
  // 原始 signals,不能把私有的策略信号混进去。
  // Personal strategy signals are folded into the normal signal stream for
  // the focus carousel's selection — no separate section, same design and
  // ranking as platform signals. Market Overview is a platform-wide stat,
  // so it still reads only the raw `signals`, never the private strategy ones.
  const combinedSignals = useMemo(
    () => [...signals, ...strategySignals.map((s) => strategySignalToDisplay(s, t('strategy.myStrategyBadge')))],
    [signals, strategySignals, t]
  )
  const focusEntries = useFocusEntries(combinedSignals, now, activeSymbols)
  const { toast, placeOrder, placeStrategyOrder } = useOrderPlacement()

  const [focusIdx, setFocusIdx] = useState(0)
  const [activeSignal, setActiveSignal] = useState<DisplaySignal | null>(null)
  // 跟信号下完单之后，弹窗自己收起来的那一刻把用户带到「订单回执 · 持仓与账户」。
  //
  // 为什么挂在关闭回调上而不是下单成功那一刻：SlideOrderModal 成功后会先展示一张
  // "已提交"的回执卡片，2 秒后才自己调 onCancel。提交成功就立刻 navigate 会在那张
  // 卡片渲染出来之前把整个弹窗卸载掉，用户永远看不到自己那一单被受理了。
  //
  // 用 ref 而不是 state：这个标记只在回调之间传一次，进 state 会白白多一轮渲染。
  //
  // After placing from a signal, land the user on the Orders page's positions tab at the
  // moment the modal closes itself. Hooked on the close rather than on success because
  // the modal shows a "submitted" receipt card for ~2s first, and navigating on success
  // would unmount it before the user ever sees that their order was accepted. A ref, not
  // state: the flag only travels between callbacks and would cost a render as state.
  const placedRef = useRef(false)
  // 下单弹窗是全屏的，手机上划返回应该先关掉弹窗、而不是直接退出仪表盘
  // （见 useBackToClose 的说明）。/ The order modal is full-screen; on
  // mobile, swiping back should close it first rather than exiting the
  // dashboard outright (see useBackToClose's comment).
  useBackToClose(activeSignal != null, () => setActiveSignal(null))

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
  const openTrade = useCallback((s: DisplaySignal) => setActiveSignal(s), [])
  const goSignals = useCallback(() => navigate('/app'), [navigate])

  const handleConfirm = async (volume: number, mt5Login: string | null, stopLoss: number | null, takeProfit: number | null, clientOrderId: string) => {
    if (!activeSignal) return
    const sig = activeSignal
    // 不在这里关弹窗，理由见 SignalsPage.tsx 同名函数的注释。
    // Don't close the modal here — see SignalsPage.tsx's matching comment.
    // 个人策略信号没有真实 signalId（strategy_signals 是独立表），走不带
    // signalId 的手动下单路径，避免污染平台胜率统计；平台信号照常走
    // placeOrder。/ Personal strategy signals have no real signalId (they
    // live in a separate strategy_signals table) — submit through the
    // signalId-less manual path so they never pollute the platform win-rate
    // stats; platform signals still go through placeOrder as before.
    if (sig.strategySignal) {
      await placeStrategyOrder(sig.symbol, sig.side, volume, mt5Login, stopLoss, takeProfit, clientOrderId)
    } else {
      await placeOrder(sig, volume, mt5Login, stopLoss, takeProfit, clientOrderId)
    }
    // 走到这里说明指令已经被后端受理（失败会抛，OrderSheet 靠这个 promise 判成败）。
    // 打上标记，等弹窗自己收起来时带用户去看这一单。
    // Reaching here means the backend accepted it (a failure throws, which is how
    // OrderSheet tells the two apart). Flag it so the close takes the user to it.
    placedRef.current = true
  }

  return (
    <div className="max-w-[1520px] mx-auto">
      <NotifDeviceBanner />
      {/* 引导卡放在仪表盘最上面：这是登录后的落点，新用户第一眼就该看到「下一步
          做什么」，而不是先滚过一屏空卡片。绑好账号后自动消失。
          The onboarding card goes at the very top of the dashboard: this is where
          login lands, so a new user should see "what to do next" first rather than
          scrolling past a screen of empty cards. It disappears once an account is
          bound. */}
      <OnboardingCard />
      {!loaded ? (
        <SkeletonPage cards={3} />
      ) : (
        <div className="dash-grid content-fade">
          {cur ? (
            <>
              <div className="dash-col-1">
                <SignalHero symbol={cur.symbol} cnName={nameOf(cur.symbol)} focusIdx={idx} focusTotal={focusEntries.length} stance={stance} trend={trends[cur.symbol]} sentiment={sentiment[cur.symbol] ?? null} onPrev={goPrev} onNext={goNext} onSelectIdx={setFocusIdx} />
                <QuotesTable symbols={activeSymbols} quotes={globalQuotes} mt5Online={anyOnline} focusSymbol={cur?.symbol} />
              </div>
              <div className="dash-col-2">
                <SignalExec signal={cur.signal} now={now} onTrade={openTrade} />
                <SessionWinrateCard />
                <PersonalWinRateCard className="dash-personal" />
              </div>
              <SignalOthers entries={otherEntries} now={now} onTrade={openTrade} onFocus={setFocusIdx} onViewAll={goSignals} />
            </>
          ) : (
            <>
              <div className="dash-col-1">
                <section className="card glass dash-hero p-8 flex flex-col items-center justify-center text-center gap-3">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--purple-hi)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="opacity-50"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
                  <h2 className="text-lg font-bold text-white">{t('signals.title')}</h2>
                  <p className="text-sm text-neutral-400 max-w-xs">{t('signals.waitingForSignals')}</p>
                </section>
                <QuotesTable symbols={activeSymbols} quotes={globalQuotes} mt5Online={anyOnline} />
              </div>
              <div className="dash-col-2">
                <SignalExec signal={null} now={now} onTrade={openTrade} />
                <SessionWinrateCard />
                <PersonalWinRateCard className="dash-personal" />
              </div>
              <section className="card glass dash-others p-4 flex items-center justify-center text-sm text-neutral-500">{t('signals.focus.noExecutable')}</section>
            </>
          )}
        </div>
      )}
      {activeSignal && <SlideOrderModal signal={activeSignal} accounts={accounts} quotesByAccount={accountQuotes} onCancel={() => {
        setActiveSignal(null)
        if (placedRef.current) {
          placedRef.current = false
          navigate('/orders', { state: { tab: 'positions' } })
        }
      }} onConfirm={handleConfirm} />}
      {toast && <Toast kind={toast.kind} message={toast.msg} />}
    </div>
  )
}
