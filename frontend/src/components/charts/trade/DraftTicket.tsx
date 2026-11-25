// 图上投影单的浮动面板：一张还没提交的挂单，线在图上可拖（入场价 / 止损 / 止盈），
// 这里可以直接输数、调手数、换方向，看风险金额和盈亏比，最后提交。限价还是止损按入场价
// 相对现价自动判断（autoEntryType），所以拖过现价时类型会跟着变。
// The floating panel of a projected order: an unsubmitted pending order whose lines can be
// dragged on the chart (entry / SL / TP). Here the user can type the numbers, set the
// volume, flip the side, see the risk and R:R, and submit. Limit vs stop follows the entry
// relative to the market (autoEntryType), so dragging across the market changes the type.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { limitLotInput } from '../../../api/utils'
import { checkSlTp, formatMoney, normalizeVolume, previewRisk, sanitizeDecimal, slTooClose, stepVolume, type SymbolSpec } from '../../order/orderMath'
import SlideToConfirm from '../../order/SlideToConfirm'
import { useMarketClosedText, useMarketStatus } from '../../order/useMarketStatus'
import { autoEntryType, fmtSigned, moveReadout, type Side } from './tradeMath'

export interface Draft {
  side: Side
  price: number
  sl: number | null
  tp: number | null
  volume: string
}

interface Props {
  draft: Draft
  onChange: (d: Draft) => void
  onClose: () => void
  onSubmit: () => void
  busy: boolean
  symbol: string
  digits: number
  quote: () => { bid: number | null; ask: number | null }
  spec?: SymbolSpec
  balance?: number | null
  currency: string
  /** 下单账户（在线的那个）；null = 没有在线账户 / the (online) account, null when none */
  login: string | null
  touch: boolean
}

// 价格输入：自己持有正在敲的文字，失焦或外部（拖线）改了值才同步回来——不然敲到一半的
// 「2034.」会被格式化成「2034.00」。/ A price field that owns its text while typing and only
// re-syncs on blur or when the value changes from outside (a drag).
function PriceField({ label, value, digits, onValue, clearable }: { label: string; value: number | null; digits: number; onValue: (v: number | null) => void; clearable?: boolean }) {
  const fmt = (v: number | null) => (v == null ? '' : v.toFixed(digits))
  const [text, setText] = useState(fmt(value))
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(fmt(value)) }, [value, digits]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="chart-draft-row">
      <span>{label}</span>
      <input
        inputMode="decimal"
        value={text}
        aria-label={label}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; setText(fmt(value)) }}
        onChange={(e) => {
          const s = sanitizeDecimal(e.target.value)
          setText(s)
          if (s.trim() === '') { if (clearable) onValue(null); return }
          const n = parseFloat(s)
          if (Number.isFinite(n) && n > 0) onValue(n)
        }}
      />
    </label>
  )
}

export default function DraftTicket(p: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const { draft: d } = p
  const isBuy = d.side === 'BUY'
  const q = p.quote()
  const type = autoEntryType(d.side, d.price, q.bid, q.ask)
  const pendingType = `${d.side}_${type}`
  const vol = parseFloat(d.volume) || 0
  const market = useMarketStatus(p.symbol)
  const closedText = useMarketClosedText(market)

  const { slInvalid, tpInvalid } = checkSlTp(isBuy, d.sl, d.tp, d.price)
  const slClose = !slInvalid && slTooClose(d.sl, d.price)
  const risk = previewRisk(p.symbol, d.volume, d.price, d.sl, d.tp, p.spec)
  const leg = (price: number | null) => (price == null ? null : moveReadout({ symbol: p.symbol, side: d.side, volume: vol, entry: d.price, price, digits: p.digits, spec: p.spec, balance: p.balance }))
  const slR = leg(d.sl)
  const tpR = leg(d.tp)
  const legText = (r: ReturnType<typeof leg>) => {
    if (!r) return null
    const parts = [`${fmtSigned(r.points, 0)} ${tt('charts.trade.pts')}`]
    if (r.money != null) parts.push(`${fmtSigned(r.money)} ${p.currency}`.trim())
    if (r.pct != null) parts.push(`${fmtSigned(r.pct)}%`)
    return parts.join(' · ')
  }

  const error = !p.login ? tt('charts.trade.noAccount')
    : market.closed ? closedText
      : slInvalid || tpInvalid ? tt(slClose ? 'order.slTooClose' : 'charts.ticket.slTpWrong')
        : slClose ? tt('order.slTooClose')
          : !(vol > 0) ? tt('charts.ticket.invalidVolume')
            : null
  const canSubmit = error == null && !p.busy
  const set = (patch: Partial<Draft>) => p.onChange({ ...d, ...patch })
  const flip = () => set({ side: isBuy ? 'SELL' : 'BUY', sl: null, tp: null })
  const submitLabel = tt('charts.trade.submit', { type: tt(`order.pending.type.${pendingType}`) })

  return (
    <div className={`chart-draft ${isBuy ? 'buy' : 'sell'}`} role="dialog" aria-label={tt('charts.trade.draftTitle')} onPointerDown={(e) => e.stopPropagation()}>
      <div className="chart-draft-head">
        <div className="chart-draft-side" role="group" aria-label={tt('charts.trade.side')}>
          <button type="button" className={isBuy ? 'on buy' : ''} aria-pressed={isBuy} onClick={() => { if (!isBuy) flip() }}>{tt('charts.dock.buy')}</button>
          <button type="button" className={!isBuy ? 'on sell' : ''} aria-pressed={!isBuy} onClick={() => { if (isBuy) flip() }}>{tt('charts.dock.sell')}</button>
        </div>
        <b>{tt(`order.pending.type.${pendingType}`)}</b>
        <button type="button" className="chart-draft-x" aria-label={tt('charts.trade.discard')} title={tt('charts.trade.discard')} onClick={p.onClose}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <PriceField label={tt('charts.ticket.triggerPrice')} value={d.price} digits={p.digits} onValue={(v) => { if (v != null) set({ price: v }) }} />
      <PriceField label={tt('charts.ticket.sl')} value={d.sl} digits={p.digits} clearable onValue={(v) => set({ sl: v })} />
      {d.sl != null && <small className={`chart-draft-leg ${slInvalid ? 'bad' : ''}`}>{legText(slR)}</small>}
      <PriceField label={tt('charts.ticket.tp')} value={d.tp} digits={p.digits} clearable onValue={(v) => set({ tp: v })} />
      {d.tp != null && <small className={`chart-draft-leg ${tpInvalid ? 'bad' : ''}`}>{legText(tpR)}</small>}
      <div className="chart-draft-row">
        <span>{tt('charts.ticket.volume')}</span>
        <div className="chart-draft-vol">
          <button type="button" aria-label="-" onClick={() => set({ volume: stepVolume(d.volume, -1, p.symbol) })}>−</button>
          <input
            inputMode="decimal"
            aria-label={tt('charts.ticket.volume')}
            value={d.volume}
            onChange={(e) => set({ volume: limitLotInput(e.target.value, p.symbol) })}
            onBlur={() => set({ volume: normalizeVolume(d.volume, p.symbol) })}
          />
          <button type="button" aria-label="+" onClick={() => set({ volume: stepVolume(d.volume, 1, p.symbol) })}>+</button>
        </div>
      </div>
      {risk && (
        <div className="chart-draft-sum">
          {risk.riskUsd != null && <span>{tt('charts.ticket.riskAmount')} <b className="dn">{formatMoney(risk.riskUsd)}</b></span>}
          {risk.rewardUsd != null && <span>{tt('charts.ticket.potentialProfit')} <b className="up">{formatMoney(risk.rewardUsd)}</b></span>}
          {risk.rr != null && <span>{tt('charts.ticket.rr')} <b>{risk.rr.toFixed(2)}</b></span>}
        </div>
      )}
      {p.login && <small className="chart-draft-acct">{tt('charts.ticket.account')} {p.login}</small>}
      {error && <p className="chart-draft-err" role="alert">{error}</p>}
      {p.touch
        ? <SlideToConfirm disabled={!canSubmit} onConfirm={p.onSubmit} label={submitLabel} />
        : <button type="button" className={`chart-draft-go ${isBuy ? 'buy' : 'sell'}`} disabled={!canSubmit} onClick={p.onSubmit}>{submitLabel}</button>}
    </div>
  )
}
