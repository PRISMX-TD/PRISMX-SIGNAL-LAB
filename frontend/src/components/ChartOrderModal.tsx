// 图表页手动下单弹窗（不绑定信号）：买/卖 + 手数 + 止盈止损 + 选择 MT5 账户，
// 滑动确认。外壳是共用的 order/OrderSheet，表单逻辑是 order/useOrderForm；与信号
// 弹窗的差别只是没有倒计时 / 过期拦截，参考价取实时报价或图表最新价。
//
// Manual (non-signal) order modal for the charts page. Shared order/OrderSheet
// shell and order/useOrderForm logic; differs from the signal modal only in
// having no countdown / expiry block, with the reference price from the live
// quote or the chart's latest close.
import type { MT5Account, Quote } from '../api/types'
import { baseSymbol } from '../api/utils'
import { useStickyOnlineAccounts } from '../utils/useStickyOnlineAccounts'
import { priceDigits } from './charts/chartConfig'
import OrderSheet, { type OrderConfirm } from './order/OrderSheet'
import { useOrderForm } from './order/useOrderForm'

interface Props {
  symbol: string
  side: 'BUY' | 'SELL'
  accounts: MT5Account[]
  // 按交易商账户区分的报价：login -> {symbol: Quote} / per-broker-account quotes
  quotesByAccount: Record<string, Record<string, Quote>>
  // 图表最新收盘价：无实时报价时作为参考价 / chart's latest close, used when no live quote
  refPrice?: number
  // 价格显示小数位。不传就从按账户报价里的券商 digits 现解（再退回品种兜底表）：
  // 以前默认值是写死的 2，而策略页调用时不传，于是策略信号的下单弹窗里 EURUSD 的
  // 现价显示成 "1.16"。
  // Price display precision. When omitted it's resolved from the broker's
  // Quote.digits (then the symbol fallback table): the old hard-coded default of 2
  // rendered EURUSD as "1.16" on the strategies page, which passes no digits.
  digits?: number
  // 预填止损止盈（如来自自定义策略触发的信号）；省略则保持空白手填
  // Prefilled SL/TP (e.g. from a triggered custom-strategy signal); omitted keeps them blank
  initialStopLoss?: number
  initialTakeProfit?: number
  onCancel: () => void
  onConfirm: OrderConfirm
}

// 从「按账户报价」里找这个品种的任意一条报价，只为拿它的 digits。品种名要按
// baseSymbol 比：报价键可能带券商后缀（XAUUSD.s），而信号侧传进来的是 BTCUSDT 这
// 类名字。只取精度，绝不把这里的键名回传到下单路径。
// Find any per-account quote for this symbol just to read its digits. Compare via
// baseSymbol (quote keys may carry a broker suffix, signal-side names may be
// BTCUSDT). Only the precision is taken; the key never flows back into placement.
function findQuote(quotesByAccount: Record<string, Record<string, Quote>>, symbol: string): Quote | undefined {
  const base = baseSymbol(symbol)
  for (const bySymbol of Object.values(quotesByAccount)) {
    for (const [key, q] of Object.entries(bySymbol)) {
      if (baseSymbol(key) === base) return q
    }
  }
  return undefined
}

export default function ChartOrderModal({ symbol, side, accounts, quotesByAccount, refPrice, digits, initialStopLoss, initialTakeProfit, onCancel, onConfirm }: Props) {
  const shownDigits = digits ?? priceDigits(symbol, findQuote(quotesByAccount, symbol))
  // 与 SlideOrderModal 同一套：在线标志抖动不应该把账户切换器整个卸载。
  // Same as SlideOrderModal: a flickering online flag must not unmount the switcher.
  const availableAccounts = useStickyOnlineAccounts(accounts)
  const form = useOrderForm({
    symbol, side,
    accounts: availableAccounts,
    quotesByAccount,
    refPrice,
    initialStopLoss,
    initialTakeProfit,
  })
  return (
    <OrderSheet
      form={form}
      symbol={symbol}
      totalAccounts={accounts.length}
      priceText={form.entryRef == null ? '-' : form.entryRef.toFixed(shownDigits)}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
