// 信号下单弹窗（滑动确认）：在共用外壳 order/OrderSheet 之上加信号特有的两件事——
// 倒计时（弹窗打开期间信号也可能到期，到期即禁止滑动）和止损止盈按信号预填。
// 表单逻辑在 order/useOrderForm，与图表手动弹窗、终端面板同一份。
//
// Signal order modal: the shared order/OrderSheet plus the two signal-specific
// bits — a countdown that blocks the slide once the signal expires, and SL/TP
// prefilled from the signal. Form logic is order/useOrderForm, shared with the
// chart modal and the docked ticket.
import { useTranslation } from 'react-i18next'
import { useGlobalQuotes } from '../store/live'
import type { MT5Account, Quote, Signal } from '../api/types'
import { brokerSymbol, calcCountdown } from '../api/utils'
import { SIGNAL_LIFESPAN_MS } from './signals/SignalView'
import { useNow } from './signals/hooks'
import { useStickyOnlineAccounts } from '../utils/useStickyOnlineAccounts'
import OrderSheet, { type OrderConfirm } from './order/OrderSheet'
import { useOrderForm } from './order/useOrderForm'

interface Props {
  signal: Signal
  accounts: MT5Account[]
  // 按交易商账户区分的报价：login -> {symbol: Quote}。选中哪个账户就用哪个交易商的报价。
  // Per-broker-account quotes: whichever account is selected drives which broker's quote is used.
  quotesByAccount: Record<string, Record<string, Quote>>
  onCancel: () => void
  onConfirm: OrderConfirm
}

export default function SlideOrderModal({ signal, accounts, quotesByAccount, onCancel, onConfirm }: Props) {
  const { t } = useTranslation()
  // 不用 accounts.filter(a => a.online)：在线标志抖一下就会把切换器整个卸载，
  // 表现为"一点切换账号，弹窗就没了"。见 useStickyOnlineAccounts 的说明。
  // Not a plain online filter — a flickering flag would unmount the switcher mid-click.
  const availableAccounts = useStickyOnlineAccounts(accounts)
  // 兜底报价：网关账户没有按账户报价，取 EA 全站报价，按券商品种名（BTCUSDT → BTCUSD）查。
  // Fallback quote for gateway accounts (no per-account feed): the site-wide EA
  // feed, keyed by the broker's symbol name (BTCUSDT → BTCUSD).
  const globalQuotes = useGlobalQuotes()
  const form = useOrderForm({
    symbol: signal.symbol,
    side: signal.side === 'BUY' ? 'BUY' : 'SELL',
    accounts: availableAccounts,
    quotesByAccount,
    fallbackQuote: globalQuotes[brokerSymbol(signal.symbol)],
    refPrice: signal.entry,
    initialStopLoss: signal.stopLoss,
    initialTakeProfit: signal.takeProfit,
  })

  // 倒计时：弹窗打开期间信号也可能到期，到期即禁止滑动确认。
  // Countdown: the signal can expire while this modal is open; once expired, the slide is disabled.
  const now = useNow(1000)
  const cd = calcCountdown(signal.expireAt, SIGNAL_LIFESPAN_MS, now)
  const expired = cd?.expired ?? false
  const cdTone = cd && cd.remainMs < 2 * 60 * 1000 ? 'text-down' : 'text-neutral-300'

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
      slPlaceholder={signal.stopLoss != null ? String(signal.stopLoss) : 'SL'}
      tpPlaceholder={signal.takeProfit != null ? String(signal.takeProfit) : 'TP'}
      headExtra={cd && (
        <div className={`mt-2 flex items-center justify-center gap-1.5 text-xs font-semibold ${cdTone}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
          <span>{t('order.signalExpiresIn')}</span>
          <span className="num">{cd.text}</span>
        </div>
      )}
      blocked={expired ? {
        banner: <div className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{t('order.signalExpiredInModal')}</div>,
        error: t('order.signalExpiredInModal'),
      } : null}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
