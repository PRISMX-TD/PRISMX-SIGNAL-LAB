// 挂单的「管理」展开区：改触发价 / 止损 / 止盈（2026-11-16 体验报告 M2）。
//
// 以前挂单只能在桌面图表上拖线改，手机的停靠抽屉里只有「撤销」——想把挂单价挪一点，
// 只能撤了重下。这里与持仓行的「管理」同一套样式：三格输入、一个「修改」。
// 只发改了的那几项：MODIFY_PENDING 从协议到网关都是「没传的不碰」（见 PositionOverlay 的
// submitModifyPending）。止损 / 止盈清空 = 发 0 = 清除，与持仓表单同一语义。
//
// The pending-order "manage" panel: edit trigger / SL / TP (QA report M2). Pending orders
// could only be edited by dragging lines on the desktop chart; the mobile dock offered
// nothing but cancel. Only changed fields are sent (MODIFY_PENDING leaves out what it
// doesn't receive); a blanked SL / TP is sent as 0, which clears it.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PendingOrder } from '../../api/types'
import { useGlobalQuote } from '../../store/live'
import { baseSymbol } from '../../api/utils'
import { checkPendingPrice, checkSlTp } from '../order/orderMath'
import { EMPTY } from '../../utils/format'

export interface PendingEdit {
  price?: number
  stopLoss?: number
  takeProfit?: number
}

interface Props {
  order: PendingOrder
  digits: number
  busy: boolean
  onSubmit: (edit: PendingEdit) => void
}

const text = (n: number | undefined) => (n && n > 0 ? String(n) : '')
const clean = (v: string) => v.replace(/[^0-9.]/g, '')

export default function PendingEditor({ order, digits, busy, onSubmit }: Props) {
  const { t } = useTranslation()
  const quote = useGlobalQuote(baseSymbol(order.symbol))
  const [init] = useState(() => ({ price: String(order.price), sl: text(order.stopLoss), tp: text(order.takeProfit) }))
  const [price, setPrice] = useState(init.price)
  const [sl, setSl] = useState(init.sl)
  const [tp, setTp] = useState(init.tp)

  const isBuy = order.side === 'BUY'
  const marketRef = (isBuy ? quote?.ask : quote?.bid) ?? null
  const entryType = order.type.endsWith('_STOP') ? 'STOP' : 'LIMIT'
  const priceNum = price.trim() === '' ? null : parseFloat(price)
  const priceErr = checkPendingPrice(entryType, isBuy, priceNum, quote?.bid ?? null, quote?.ask ?? null)
  const slNum = sl.trim() === '' ? null : parseFloat(sl)
  const tpNum = tp.trim() === '' ? null : parseFloat(tp)
  // 挂单的止损止盈相对触发价判方向，不是相对现价。/ SL/TP sides are judged against the trigger.
  const { slInvalid, tpInvalid } = checkSlTp(isBuy, slNum, tpNum, priceErr == null ? priceNum : null)

  const edit: PendingEdit = {}
  if (price !== init.price && priceNum != null) edit.price = priceNum
  if (sl !== init.sl) edit.stopLoss = slNum ?? 0
  if (tp !== init.tp) edit.takeProfit = tpNum ?? 0
  const changed = Object.keys(edit).length > 0
  const bad = priceErr != null || slInvalid || tpInvalid

  return (
    <div className="term-pr-x">
      <div className="term-pr-xg term-pr-xg--fill">
        <span className="term-pr-xk">{t('charts.dock.modifyPendingHead')}</span>
        <div className="term-pr-xr term-pr-xr--grid">
          <input
            className={`term-pr-inp ${priceErr ? 'bad' : ''}`}
            aria-label={String(t('charts.dock.triggerPrice'))}
            placeholder={String(t('charts.dock.triggerPrice'))}
            value={price}
            inputMode="decimal"
            onChange={(e) => setPrice(clean(e.target.value))}
          />
          <input
            className={`term-pr-inp ${slInvalid ? 'bad' : ''}`}
            aria-label={String(t('charts.ticket.sl'))}
            placeholder={String(t('charts.ticket.sl'))}
            value={sl}
            inputMode="decimal"
            onChange={(e) => setSl(clean(e.target.value))}
          />
          <input
            className={`term-pr-inp ${tpInvalid ? 'bad' : ''}`}
            aria-label={String(t('charts.ticket.tp'))}
            placeholder={String(t('charts.ticket.tp'))}
            value={tp}
            inputMode="decimal"
            onChange={(e) => setTp(clean(e.target.value))}
          />
          <button type="button" className="term-pr-btn" disabled={busy || bad || !changed} onClick={() => onSubmit(edit)}>
            {t('charts.dock.modify')}
          </button>
        </div>
        {priceErr && <span className="term-pr-warn">{t(priceErr, { price: marketRef != null ? marketRef.toFixed(digits) : EMPTY })}</span>}
        {!priceErr && (slInvalid || tpInvalid) && <span className="term-pr-warn">{t('charts.dock.slTpWrong')}</span>}
      </div>
    </div>
  )
}
