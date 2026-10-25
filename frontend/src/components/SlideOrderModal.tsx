// 信号下单弹窗（滑动确认）：在共用外壳 order/OrderSheet 之上加信号特有的两件事——
// 倒计时（弹窗打开期间信号也可能到期，到期即禁止滑动）和止损止盈按信号预填。
// 表单逻辑在 order/useOrderForm，与图表手动弹窗、终端面板同一份。
//
// 2026-10-11 加正向 / 反向切换：反向 = 方向与信号相反、止盈止损对调。
//
// Signal order modal: the shared order/OrderSheet plus the two signal-specific
// bits — a countdown that blocks the slide once the signal expires, and SL/TP
// prefilled from the signal. Form logic is order/useOrderForm, shared with the
// chart modal and the docked ticket.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useGlobalQuote, useQuotes } from '../store/live'
import type { MT5Account, Quote, Signal } from '../api/types'
import { brokerSymbol, calcCountdown } from '../api/utils'
import { SIGNAL_LIFESPAN_MS } from './signals/SignalView'
import { useNow } from './signals/hooks'
import { useStickyOnlineAccounts } from '../utils/useStickyOnlineAccounts'
import OrderSheet from './order/OrderSheet'
import { useOrderForm } from './order/useOrderForm'
import { useMarketClosedBlock } from './order/useMarketStatus'

interface Props {
  signal: Signal
  accounts: MT5Account[]
  // 按交易商账户区分的报价：login -> {symbol: Quote}。选中哪个账户就用哪个交易商的报价。
  // Per-broker-account quotes: whichever account is selected drives which broker's quote is used.
  // 可省略：省略时弹窗自己订阅（顶层页面不必为它订阅报价而每 0.5 秒整页重渲染）。
  // Optional: when omitted the modal subscribes itself, so pages needn't subscribe just for it
  // (and re-render the whole page every 0.5s).
  quotesByAccount?: Record<string, Record<string, Quote>>
  onCancel: () => void
  // 比 OrderSheet 的 OrderConfirm 多一个 reverse：这一单是不是反向跟单。
  // OrderSheet's OrderConfirm plus `reverse`: whether this is a reverse copy.
  onConfirm: (
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
    clientOrderId: string,
    reverse: boolean,
  ) => Promise<void>
}

// 止损止盈预填值：反向时信号的止盈当止损、止损当止盈。
// Prefill: in reverse the signal's TP becomes the stop and its SL the target.
const levelText = (v: number | null) => (v != null ? String(v) : '')

export default function SlideOrderModal({ signal, accounts, quotesByAccount: quotesByAccountProp, onCancel, onConfirm }: Props) {
  const { t } = useTranslation()
  const ctxAccountQuotes = useQuotes()
  const quotesByAccount = quotesByAccountProp ?? ctxAccountQuotes
  // 不用 accounts.filter(a => a.online)：在线标志抖一下就会把切换器整个卸载，
  // 表现为"一点切换账号，弹窗就没了"。见 useStickyOnlineAccounts 的说明。
  // Not a plain online filter — a flickering flag would unmount the switcher mid-click.
  const availableAccounts = useStickyOnlineAccounts(accounts)
  // 兜底报价：网关账户没有按账户报价，取 EA 全站报价，按券商品种名（BTCUSDT → BTCUSD）查。
  // Fallback quote for gateway accounts (no per-account feed): the site-wide EA
  // feed, keyed by the broker's symbol name (BTCUSDT → BTCUSD).
  // 只订阅这一个品种：其它品种跳价不会让弹窗重渲染。
  // Subscribe to this one symbol only: other symbols ticking won't re-render the modal.
  const fallbackQuote = useGlobalQuote(brokerSymbol(signal.symbol))
  // 正向 / 反向：每次打开默认正向。反向 = 方向与信号相反、止盈止损对调。
  // Forward / reverse: every open starts forward. Reverse = opposite side, SL/TP swapped.
  const [reverse, setReverse] = useState(false)
  const signalSide = signal.side === 'BUY' ? 'BUY' : 'SELL'
  const side = reverse ? (signalSide === 'BUY' ? 'SELL' : 'BUY') : signalSide
  const slFromSignal = reverse ? signal.takeProfit : signal.stopLoss
  const tpFromSignal = reverse ? signal.stopLoss : signal.takeProfit
  const form = useOrderForm({
    symbol: signal.symbol,
    side,
    accounts: availableAccounts,
    quotesByAccount,
    fallbackQuote,
    refPrice: signal.entry,
    initialStopLoss: signal.stopLoss,
    initialTakeProfit: signal.takeProfit,
  })

  // 倒计时：弹窗打开期间信号也可能到期，到期即禁止滑动确认。
  // Countdown: the signal can expire while this modal is open; once expired, the slide is disabled.
  const now = useNow(1000)
  const cd = calcCountdown(signal.expireAt, SIGNAL_LIFESPAN_MS, now)
  const expired = cd?.expired ?? false
  // 休市（MT5 交易时段外）同样禁止滑动确认 / closed market (outside MT5 sessions) blocks the slide too
  const marketClosed = useMarketClosedBlock(signal.symbol)
  const cdTone = cd && cd.remainMs < 2 * 60 * 1000 ? 'text-down' : 'text-neutral-300'

  // 切换正向 / 反向时把止损止盈重置成该方向下的信号值（用户之前手改的值作废——
  // 方向都换了，旧值必然在错的那一侧）。
  // Switching direction resets SL/TP to the signal's values for that direction (any
  // manual edit is dropped — with the side flipped it would sit on the wrong side).
  const pickDirection = (rev: boolean) => {
    if (rev === reverse) return
    setReverse(rev)
    form.setSl(levelText(rev ? signal.takeProfit : signal.stopLoss))
    form.setTp(levelText(rev ? signal.stopLoss : signal.takeProfit))
  }

  // 现价：有报价按报价精度显示，没有就用信号入场价。
  // Live price at the quote's precision, else the signal's entry.
  const q = form.quote
  const live = form.isBuy ? q?.ask : q?.bid
  const priceText = live != null ? live.toFixed(q?.digits ?? 5) : String(signal.entry ?? '-')

  return (
    <OrderSheet
      form={form}
      symbol={signal.symbol}
      totalAccounts={accounts.length}
      priceText={priceText}
      slPlaceholder={slFromSignal != null ? String(slFromSignal) : 'SL'}
      tpPlaceholder={tpFromSignal != null ? String(tpFromSignal) : 'TP'}
      headExtra={(
        <>
          {cd && (
            <div className={`mt-2 flex items-center justify-center gap-1.5 text-xs font-semibold ${cdTone}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
              </svg>
              <span>{t('order.signalExpiresIn')}</span>
              <span className="num">{cd.text}</span>
            </div>
          )}
          {/* 正向 / 反向信号切换：左边正向（默认），右边反向。
              Forward / reverse switch: forward on the left (default), reverse on the right. */}
          <div className={`slide-dir ${reverse ? 'rev' : ''}`} role="radiogroup" aria-label={t('order.direction')}>
            <button type="button" role="radio" aria-checked={!reverse} className={!reverse ? 'on' : ''} onClick={() => pickDirection(false)}>
              {t('order.forwardSignal')}
            </button>
            <button type="button" role="radio" aria-checked={reverse} className={reverse ? 'on' : ''} onClick={() => pickDirection(true)}>
              {t('order.reverseSignal')}
            </button>
          </div>
          {reverse && (
            <p className={`slide-dir-note ${form.slTpInvalid ? 'warn' : ''}`} role="note">
              {form.slTpInvalid ? t('order.reverseLevelsStale') : t('order.reverseNote')}
            </p>
          )}
        </>
      )}
      blocked={expired ? {
        banner: <div className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{t('order.signalExpiredInModal')}</div>,
        error: t('order.signalExpiredInModal'),
      } : marketClosed}
      onCancel={onCancel}
      onConfirm={(volume, mt5Login, stopLoss, takeProfit, clientOrderId) =>
        onConfirm(volume, mt5Login, stopLoss, takeProfit, clientOrderId, reverse)}
    />
  )
}
