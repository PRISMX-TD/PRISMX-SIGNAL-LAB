// 图表页手动下单弹窗（不绑定信号）：买/卖 + 手数 + 止盈止损 + 选择 MT5 账户，
// 滑动确认。外壳是共用的 order/OrderSheet，表单逻辑是 order/useOrderForm；与信号
// 弹窗的差别只是没有倒计时 / 过期拦截，参考价取实时报价或图表最新价。
//
// Manual (non-signal) order modal for the charts page. Shared order/OrderSheet
// shell and order/useOrderForm logic; differs from the signal modal only in
// having no countdown / expiry block, with the reference price from the live
// quote or the chart's latest close.
import type { MT5Account, Quote } from '../api/types'
import { useStickyOnlineAccounts } from '../utils/useStickyOnlineAccounts'
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
  // 价格显示小数位 / price display precision
  digits?: number
  // 预填止损止盈（如来自自定义策略触发的信号）；省略则保持空白手填
  // Prefilled SL/TP (e.g. from a triggered custom-strategy signal); omitted keeps them blank
  initialStopLoss?: number
  initialTakeProfit?: number
  onCancel: () => void
  onConfirm: OrderConfirm
}

export default function ChartOrderModal({ symbol, side, accounts, quotesByAccount, refPrice, digits = 2, initialStopLoss, initialTakeProfit, onCancel, onConfirm }: Props) {
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
      priceText={form.entryRef == null ? '-' : form.entryRef.toFixed(digits)}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
