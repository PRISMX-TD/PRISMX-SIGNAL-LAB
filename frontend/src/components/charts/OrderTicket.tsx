// 交易终端：停靠式下单面板（右栏）/ Trading terminal: docked order ticket.
//
// 手数、止损止盈、账户、风险预览都内嵌在图表右侧常驻面板里，点"下单"即提交。
// 表单逻辑是 order/useOrderForm（与两个滑动弹窗同一份，校验规则不会分叉），本组件
// 只管面板布局与就地回执提示；下单 / 回执走父级传入的 onPlace。
// 账户列表这里用纯在线过滤而不是弹窗那套"保留掉线账号"：面板常驻，掉线的账号
// 留在列表里会误导。
//
// Volume, SL/TP, account and a risk preview live inline in the right rail;
// clicking Place submits. Form logic is order/useOrderForm (shared with both
// slide modals); this component owns only the layout and inline receipt. The
// account list is a plain online filter here — the panel is persistent, so the
// modals' "keep offline accounts" rule would mislead.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Select from '../Select'
import type { MT5Account, Quote } from '../../api/types'
import { localizeApiError } from '../../api/utils'
import { QUICK_LOTS, QUICK_RISK_PCTS, formatMoney } from '../order/orderMath'
import { useOrderForm, type Side } from '../order/useOrderForm'

interface Props {
  symbol: string
  accounts: MT5Account[]
  // 按交易商账户区分的报价：login -> {symbol: Quote}（下单参考价用选中账户的）
  // Per-account quotes: login -> {symbol: Quote} (entry price uses the selected account's)
  quotesByAccount: Record<string, Record<string, Quote>>
  // 全站统一报价（EA 推送）：选中账户没有该品种报价时的兜底 bid/ask
  // Site-wide quote (EA-pushed): fallback bid/ask when the account has none
  globalQuote: Quote | undefined
  // 图表最新收盘价：连报价都没有时的最后兜底 / chart's latest close, last-resort fallback
  refPrice: number
  digits: number
  onPlace: (
    side: Side,
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
    clientOrderId: string,
  ) => Promise<void>
  // 受控的选中账户 login（由父级 ChartsPage 持有，用于联动账户摘要/持仓/挂单）。
  // Controlled selected-account login (owned by ChartsPage to sync the summary/positions/orders).
  selectedLogin?: string
  onSelectLogin?: (login: string) => void
  className?: string
}

export default function OrderTicket({ symbol, accounts, quotesByAccount, globalQuote, refPrice, digits, onPlace, selectedLogin, onSelectLogin, className = '' }: Props) {
  const { t } = useTranslation()
  const onlineAccounts = useMemo(() => accounts.filter((a) => a.online), [accounts])
  const [side, setSide] = useState<Side>('BUY')
  const form = useOrderForm({
    symbol, side,
    accounts: onlineAccounts,
    quotesByAccount,
    fallbackQuote: globalQuote,
    refPrice,
    login: selectedLogin,
    onLoginChange: onSelectLogin,
  })
  const { isBuy, selected } = form
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<{ kind: 'ok' | 'error' | 'info'; msg: string } | null>(null)

  const canSubmit = form.hasAccounts && !form.slTpInvalid && !submitting
  const ccy = selected?.accountCurrency ?? ''

  const submit = async () => {
    const vol = form.parsedVolume
    if (vol == null) {
      setReceipt({ kind: 'error', msg: String(t('charts.ticket.invalidVolume')) })
      return
    }
    setSubmitting(true)
    setReceipt({ kind: 'info', msg: String(t('charts.ticket.submitting')) })
    try {
      // 幂等号在成功前固定不变：失败后再点一次复用同一个号，"已收单但没收到回执"
      // 不会变成两笔。成功后换新号，下一单是新的。
      // The idempotency key stays fixed until a success, so a retry after "received
      // but no receipt" can't double-place; rotated after success for the next order.
      await onPlace(side, vol, form.login || null, form.slNum, form.tpNum, form.orderId)
      form.rotateOrderId()
      setReceipt({ kind: 'ok', msg: String(t('charts.ticket.submitted')) })
      setTimeout(() => setReceipt(null), 2500)
    } catch (e) {
      setReceipt({ kind: 'error', msg: e instanceof Error ? localizeApiError(e.message) : String(t('charts.ticket.placeFailed')) })
    } finally {
      setSubmitting(false)
    }
  }

  const px = (v: number | null) => (v == null ? '—' : v.toFixed(digits))
  const money = (v: number | null | undefined) => formatMoney(v, '—')
  const rr = form.riskPreview

  return (
    <div className={`term-panel ${className}`}>
      <div className="term-pane-head">
        {t('charts.ticket.title')} <span className="term-pane-head-r">{symbol || '—'}</span>
      </div>
      <div className="term-ticket no-sb">
        {/* 买卖切换 / buy-sell toggle */}
        <div className="term-bs-row">
          <button type="button" className={`term-bs sell ${!isBuy ? 'on' : ''}`} onClick={() => setSide('SELL')}>
            <span className="lab">{t('charts.ticket.sell')}</span>
            <span className="px num">{px(form.bid)}</span>
          </button>
          <button type="button" className={`term-bs buy ${isBuy ? 'on' : ''}`} onClick={() => setSide('BUY')}>
            <span className="lab">{t('charts.ticket.buy')}</span>
            <span className="px num">{px(form.ask)}</span>
          </button>
        </div>

        {/* 账户选择（多个在线账户时）/ account picker (when >1 online) */}
        {onlineAccounts.length > 1 && (
          <label className="term-field">
            <span className="term-field-k">{t('charts.ticket.account')}</span>
            <Select
              className="term-acct-select"
              value={form.login}
              onChange={form.chooseLogin}
              options={onlineAccounts.map((a) => ({
                value: a.login,
                label: `${a.login}${a.accountName ? ` · ${a.accountName}` : ''}`,
              }))}
            />
          </label>
        )}

        {/* 手数模式切换 / size mode */}
        <div className="term-seg2">
          <button type="button" className={form.sizeMode === 'quick' ? 'on' : ''} onClick={() => form.setSizeMode('quick')}>{t('charts.ticket.sizeLots')}</button>
          <button type="button" className={form.sizeMode === 'risk' ? 'on' : ''} onClick={() => form.setSizeMode('risk')}>{t('charts.ticket.sizeRisk')}</button>
        </div>

        {/* 手数输入 / volume */}
        <label className="term-field">
          <span className="term-field-k">{t('charts.ticket.volume')}</span>
          <div className="term-stepper">
            <button type="button" onClick={() => form.stepLot(-1)}>−</button>
            <input
              className="num"
              value={form.volume}
              inputMode="decimal"
              onChange={(e) => form.typeVolume(e.target.value)}
              onBlur={form.blurVolume}
            />
            <button type="button" onClick={() => form.stepLot(1)}>＋</button>
          </div>
        </label>

        {form.sizeMode === 'quick' ? (
          <div className="term-chips">
            {QUICK_LOTS.map((q) => (
              <button key={q} type="button" className="term-chip num" onClick={() => form.setVolume(q.toFixed(2))}>
                {q.toFixed(2)}
              </button>
            ))}
          </div>
        ) : (
          <div className="term-chips">
            {QUICK_RISK_PCTS.map((p) => (
              <button key={p} type="button" className={`term-chip num ${form.riskPct === String(p) ? 'on' : ''}`} onClick={() => form.setRiskPct(String(p))}>
                {p}%
              </button>
            ))}
          </div>
        )}
        {form.riskNeedsSl && <p className="term-ticket-warn">{t('charts.ticket.riskNeedsSl')}</p>}

        {/* 止损止盈 / SL & TP */}
        <div className="term-field-row">
          <label className="term-field">
            <span className="term-field-k down">{t('charts.ticket.sl')}</span>
            <div className={`term-inp ${form.slInvalid ? 'bad' : ''}`}>
              <input className="num" value={form.sl} inputMode="decimal" placeholder="—" onChange={(e) => form.setSl(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
          </label>
          <label className="term-field">
            <span className="term-field-k up">{t('charts.ticket.tp')}</span>
            <div className={`term-inp ${form.tpInvalid ? 'bad' : ''}`}>
              <input className="num" value={form.tp} inputMode="decimal" placeholder="—" onChange={(e) => form.setTp(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
          </label>
        </div>
        {form.slTpInvalid && <p className="term-ticket-warn">{t('charts.ticket.slTpWrong')}</p>}

        {/* 风险预览 / risk preview */}
        <div className="term-risk">
          <span className="k">{t('charts.ticket.riskAmount')}</span>
          <span className="v down">{rr?.riskUsd != null ? `−${money(rr.riskUsd)} ${ccy}` : '—'}</span>
          <span className="k">{t('charts.ticket.potentialProfit')}</span>
          <span className="v up">{rr?.rewardUsd != null ? `+${money(rr.rewardUsd)} ${ccy}` : '—'}</span>
          <span className="k">{t('charts.ticket.rr')}</span>
          <span className="v">{rr?.rr != null ? `1 : ${rr.rr.toFixed(2)}` : '—'}</span>
          <span className="k">{t('charts.ticket.requiredMargin')}</span>
          <span className="v">{form.estMargin != null ? `≈ ${money(form.estMargin)} ${ccy}` : '—'}</span>
        </div>

        {!form.hasAccounts && (
          <p className="term-ticket-warn">
            {accounts.length === 0 ? t('charts.ticket.noBridge') : t('charts.ticket.offline')}
          </p>
        )}

        <button type="button" className={`term-place ${isBuy ? 'buy' : 'sell'}`} disabled={!canSubmit} onClick={submit}>
          {submitting
            ? t('charts.ticket.submitting')
            : t('charts.ticket.place', { side: isBuy ? t('charts.ticket.buy') : t('charts.ticket.sell'), volume: form.parsedVolume ?? 0 })}
        </button>

        {receipt && <p className={`term-ticket-receipt ${receipt.kind}`}>{receipt.msg}</p>}
      </div>
    </div>
  )
}
