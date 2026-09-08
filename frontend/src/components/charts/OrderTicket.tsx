// 交易终端：下单票（右栏 / 手机抽屉）/ Trading terminal: order ticket.
//
// 手数、止损止盈、账户、风险预览都在这一张票里，点「买 / 卖」即提交。表单逻辑是
// order/useOrderForm（与两个滑动弹窗同一份，校验规则不会分叉），本组件只管布局与
// 就地回执；下单 / 回执走父级传入的 onPlace。票头（标题 + 品种）由调用方渲染：
// 桌面是右栏的栏目标题，手机是抽屉的把手行。
// 账户列表用纯在线过滤而不是弹窗那套"保留掉线账号"：面板常驻，掉线的账号留在
// 列表里会误导。
// Volume, SL/TP, account and the risk preview live on one ticket; the CTA
// submits. Form logic is order/useOrderForm (shared with both slide modals);
// this component owns layout and the inline receipt only. The head (title +
// symbol) is rendered by the caller: the pane head on desktop, the sheet
// handle row on mobile. Accounts are a plain online filter here.
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
  // 手机端从交易条的哪一侧点进来 / which side of the mobile trade bar opened this
  initialSide?: Side
  className?: string
}

// 价格末两位加粗：交易员盯的是点位，不是大手。/ Bold the last two digits: the pips.
function PipPrice({ v, digits }: { v: number | null; digits: number }) {
  if (v == null) return <span className="px">—</span>
  const s = v.toFixed(digits)
  if (digits < 2) return <span className="px">{s}</span>
  return <span className="px">{s.slice(0, -2)}<b>{s.slice(-2)}</b></span>
}

export default function OrderTicket({
  symbol, accounts, quotesByAccount, globalQuote, refPrice, digits, onPlace, selectedLogin, onSelectLogin, initialSide = 'BUY', className = '',
}: Props) {
  const { t } = useTranslation()
  const onlineAccounts = useMemo(() => accounts.filter((a) => a.online), [accounts])
  const [side, setSide] = useState<Side>(initialSide)
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

  const money = (v: number | null | undefined) => formatMoney(v, '—')
  const rr = form.riskPreview
  // 点差与止损/止盈距离都按最小价位（point）计，与报价条同一单位。
  // Spread and SL/TP distances in points, the same unit as the quote strip.
  const pt = Math.pow(10, digits)
  const spread = form.bid != null && form.ask != null && form.ask >= form.bid ? Math.round((form.ask - form.bid) * pt) : null
  const entry = form.entryRef
  const slPts = entry != null && form.slNum != null && !form.slInvalid ? Math.round(Math.abs(entry - form.slNum) * pt) : null
  const tpPts = entry != null && form.tpNum != null && !form.tpInvalid ? Math.round(Math.abs(form.tpNum - entry) * pt) : null
  const rMult = slPts && tpPts ? tpPts / slPts : null
  const sideLabel = isBuy ? t('charts.ticket.buy') : t('charts.ticket.sell')

  return (
    <div className={`term-tk no-sb ${className}`}>
      {onlineAccounts.length > 1 && (
        <Select
          className="term-acct-select"
          value={form.login}
          onChange={form.chooseLogin}
          options={onlineAccounts.map((a) => ({
            value: a.login,
            label: `${a.login}${a.accountName ? ` · ${a.accountName}` : ''}`,
          }))}
        />
      )}

      {/* 连体卖 / 买 + 点差徽记 / conjoined sell / buy with the spread badge */}
      <div className="term-side">
        <button type="button" className={`sell ${!isBuy ? 'on' : ''}`} aria-pressed={!isBuy} onClick={() => setSide('SELL')}>
          <span className="lab">{t('charts.ticket.sell')}</span>
          <PipPrice v={form.bid} digits={digits} />
        </button>
        <button type="button" className={`buy ${isBuy ? 'on' : ''}`} aria-pressed={isBuy} onClick={() => setSide('BUY')}>
          <span className="lab">{t('charts.ticket.buy')}</span>
          <PipPrice v={form.ask} digits={digits} />
        </button>
        {spread != null && <span className="term-spread">{spread}<small>{t('charts.ticket.points')}</small></span>}
      </div>

      {/* 手数 + 模式 / volume + size mode */}
      <div className="term-fk">
        <span>{t('charts.ticket.volume')}</span>
        <span className="term-mode" role="tablist">
          <button type="button" role="tab" aria-selected={form.sizeMode === 'quick'} className={form.sizeMode === 'quick' ? 'on' : ''} onClick={() => form.setSizeMode('quick')}>{t('charts.ticket.sizeLots')}</button>
          <button type="button" role="tab" aria-selected={form.sizeMode === 'risk'} className={form.sizeMode === 'risk' ? 'on' : ''} onClick={() => form.setSizeMode('risk')}>{t('charts.ticket.sizeRisk')}</button>
        </span>
      </div>
      <div className="term-step">
        <button type="button" aria-label="−" onClick={() => form.stepLot(-1)}>−</button>
        <input
          className="num"
          value={form.volume}
          inputMode="decimal"
          aria-label={String(t('charts.ticket.volume'))}
          onChange={(e) => form.typeVolume(e.target.value)}
          onBlur={form.blurVolume}
        />
        <button type="button" aria-label="+" onClick={() => form.stepLot(1)}>+</button>
      </div>
      {form.sizeMode === 'quick' ? (
        <div className="term-pre">
          {QUICK_LOTS.map((q) => (
            <button key={q} type="button" onClick={() => form.setVolume(q.toFixed(2))}>{q.toFixed(2)}</button>
          ))}
        </div>
      ) : (
        <div className="term-pre">
          {QUICK_RISK_PCTS.map((p) => (
            <button key={p} type="button" className={form.riskPct === String(p) ? 'on' : ''} onClick={() => form.setRiskPct(String(p))}>{p}%</button>
          ))}
        </div>
      )}
      {form.riskNeedsSl && <p className="term-warn">{t('charts.ticket.riskNeedsSl')}</p>}

      {/* 止损 / 止盈，下面直接给点数与 R / SL & TP with points and R underneath */}
      <div className="term-two">
        <label className="term-fld">
          <span className="term-fk"><span>{t('charts.ticket.sl')}</span></span>
          <input className={`term-inp ${form.slInvalid ? 'bad' : ''}`} value={form.sl} inputMode="decimal" placeholder="—" onChange={(e) => form.setSl(e.target.value.replace(/[^0-9.]/g, ''))} />
          <span className="term-fh">{slPts != null && <><span className="down">−{slPts} {t('charts.ticket.points')}</span> · 1.0 R</>}</span>
        </label>
        <label className="term-fld">
          <span className="term-fk"><span>{t('charts.ticket.tp')}</span></span>
          <input className={`term-inp ${form.tpInvalid ? 'bad' : ''}`} value={form.tp} inputMode="decimal" placeholder="—" onChange={(e) => form.setTp(e.target.value.replace(/[^0-9.]/g, ''))} />
          <span className="term-fh">{tpPts != null && <><span className="up">+{tpPts} {t('charts.ticket.points')}</span>{rMult != null && ` · ${rMult.toFixed(1)} R`}</>}</span>
        </label>
      </div>
      {form.slTpInvalid && <p className="term-warn">{t('charts.ticket.slTpWrong')}</p>}

      {/* 风险账本 / risk ledger */}
      <div className="term-led">
        <div className="term-lr"><span>{t('charts.ticket.riskAmount')}</span><b className={rr?.riskUsd != null ? 'down' : ''}>{rr?.riskUsd != null ? <>−{money(rr.riskUsd)}<small>{ccy}</small></> : '—'}</b></div>
        <div className="term-lr"><span>{t('charts.ticket.potentialProfit')}</span><b className={rr?.rewardUsd != null ? 'up' : ''}>{rr?.rewardUsd != null ? <>+{money(rr.rewardUsd)}<small>{ccy}</small></> : '—'}</b></div>
        <div className="term-lr"><span>{t('charts.ticket.requiredMargin')}</span><b>{form.estMargin != null ? <>≈ {money(form.estMargin)}<small>{ccy}</small></> : '—'}</b></div>
        <div className="term-lr em"><span>{t('charts.ticket.rr')}</span><b>{rr?.rr != null ? `1 : ${rr.rr.toFixed(1)}` : '—'}</b></div>
      </div>

      {!form.hasAccounts && (
        <p className="term-warn">{accounts.length === 0 ? t('charts.ticket.noBridge') : t('charts.ticket.offline')}</p>
      )}

      <button type="button" className={`term-cta ${isBuy ? 'buy' : 'sell'}`} disabled={!canSubmit} onClick={submit}>
        {submitting ? (
          t('charts.ticket.submitting')
        ) : (
          <>
            {t('charts.ticket.place', { side: sideLabel, volume: (form.parsedVolume ?? 0).toFixed(2) })}
            {entry != null && <span className="px">@ {entry.toFixed(digits)}</span>}
          </>
        )}
      </button>
      {receipt ? (
        <p className={`term-receipt ${receipt.kind}`}>{receipt.msg}</p>
      ) : (
        <p className="term-ctah">{t('charts.ticket.footnote')}</p>
      )}
    </div>
  )
}
