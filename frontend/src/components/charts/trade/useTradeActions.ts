// 图上持仓线 / 挂单线上那几颗按钮背后的动作：平仓（可部分）、反手、保本、去掉止损或止盈、
// 撤挂单、去掉挂单的止损止盈。与底部持仓面板（PositionsDock）走完全同一组后端接口、同一套
// 幂等号规则（只在「没拿到任何响应」时复用，见 idempotencyKeys.ts），提示语也共用 charts.dock.*。
// The actions behind the buttons on the chart's position and pending lines: close (or
// partially close), reverse, breakeven, drop the SL or TP, cancel a pending order, drop a
// pending order's SL/TP. Same backend calls and idempotency rules as the positions dock
// (an id is reused only when no response arrived, see idempotencyKeys.ts), and the same
// charts.dock.* messages.
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Order, PendingOrder, Position } from '../../../api/types'
import { orderApi } from '../../../api/client'
import { localizeApiError } from '../../../api/utils'
import { createIdempotencyKeys } from '../../../utils/idempotencyKeys'
import { useLive } from '../../../store/live'
import { EMPTY } from '../../../utils/format'

export type Toast = (msg: string, kind: 'success' | 'error' | 'info') => void

/** 图上发起的新单（反手、投影单、买卖按钮）。/ A new order started on the chart. */
export interface ChartPlaceReq {
  side: 'BUY' | 'SELL'
  volume: number
  login: string | null
  sl: number | null
  tp: number | null
  type: 'MARKET' | 'LIMIT' | 'STOP'
  price: number | null
}
export type ChartPlace = (req: ChartPlaceReq) => Promise<Order | void>

const failed = (o: Order) => o.status === 'REJECTED' || o.status === 'FAILED'

export function useTradeActions(onToast: Toast, onPlace?: ChartPlace) {
  const { t } = useTranslation()
  const { upsertOrder, dropRow } = useLive()
  const [keys] = useState(createIdempotencyKeys)
  const errText = (e: unknown, fallback: string) => (e instanceof Error ? localizeApiError(e.message) : String(t(fallback)))

  // 平仓；volume 省略 = 全平。返回 true 表示后端收下了（成交或排队），false 表示被拒或出错。
  // Close; omitting volume closes all. true = accepted (filled or queued), false = refused / failed.
  const close = useCallback(async (p: Position, volume?: number, digits = 2): Promise<boolean> => {
    if (!p.ticket) return false
    const partial = volume != null && volume < p.volume - 1e-9
    const key = `close:${p.ticket}:${partial ? volume : 'full'}`
    let answered = false
    try {
      const res = await orderApi.close({
        clientOrderId: keys.acquire(key),
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        volume: partial ? volume : undefined,
      })
      answered = true
      keys.settle(key)
      upsertOrder(res)
      if (failed(res)) {
        onToast(res.message ? localizeApiError(res.message) : String(t('charts.dock.closeFailed')), 'error')
        return false
      }
      if (res.status === 'FILLED') {
        if (!partial) dropRow('position', p)
        const px = res.filledPrice != null ? res.filledPrice.toFixed(digits) : EMPTY
        onToast(partial ? String(t('charts.dock.partialClosed', { lots: volume, price: px })) : String(t('charts.dock.closed', { price: px })), 'success')
      } else {
        onToast(String(t(partial ? 'charts.dock.partialCloseSent' : 'charts.dock.closeSent')), 'info')
      }
      return true
    } catch (e) {
      if (!answered) keys.afterThrow(key, e)
      onToast(errText(e, 'charts.dock.closeFailed'), 'error')
      return false
    }
  }, [keys, upsertOrder, dropRow, onToast, t]) // eslint-disable-line react-hooks/exhaustive-deps

  // 改持仓的止损止盈（两条腿一起发，调用方负责另一条腿用最新值）。
  // Modify a position's SL/TP (both legs go out; the caller supplies the other leg's latest value).
  const modify = useCallback(async (p: Position, sl: number, tp: number): Promise<boolean> => {
    if (!p.ticket) return false
    const key = `modify:${p.ticket}:${sl}:${tp}`
    let answered = false
    try {
      const res = await orderApi.modify({
        clientOrderId: keys.acquire(key),
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        stopLoss: sl,
        takeProfit: tp,
      })
      answered = true
      keys.settle(key)
      upsertOrder(res)
      if (failed(res)) {
        onToast(res.message ? localizeApiError(res.message) : String(t('charts.dock.modifyFailed')), 'error')
        return false
      }
      onToast(String(t(res.status === 'FILLED' ? 'charts.dock.modified' : 'charts.dock.modifySent')), res.status === 'FILLED' ? 'success' : 'info')
      return true
    } catch (e) {
      if (!answered) keys.afterThrow(key, e)
      onToast(errText(e, 'charts.dock.modifyFailed'), 'error')
      return false
    }
  }, [keys, upsertOrder, onToast, t]) // eslint-disable-line react-hooks/exhaustive-deps

  // 反手：先全平，平仓被收下后再按相反方向开同样手数的市价单（不带止损止盈，和 TradingView
  // 一样——旧的止损止盈对反方向没有意义）。平仓被拒就停下，不会出现「没平掉却又开了反向单」。
  // Reverse: close in full, then once the close is accepted open the same volume the other
  // way at market, without SL/TP (as TradingView does — the old legs mean nothing reversed).
  // A refused close stops here, so there is never an opposite position on top of an unclosed one.
  const reverse = useCallback(async (p: Position, digits = 2): Promise<boolean> => {
    if (!onPlace) return false
    const ok = await close(p, undefined, digits)
    if (!ok) return false
    try {
      await onPlace({ side: p.side === 'BUY' ? 'SELL' : 'BUY', volume: p.volume, login: p.login ?? null, sl: null, tp: null, type: 'MARKET', price: null })
      return true
    } catch (e) {
      onToast(errText(e, 'charts.trade.reverseFailed'), 'error')
      return false
    }
  }, [close, onPlace, onToast]) // eslint-disable-line react-hooks/exhaustive-deps

  // 改挂单：只发给出的那几项，没给的保留（MODIFY_PENDING 协议「没传的不碰」）。0 = 清掉止损 / 止盈。
  // Modify a pending order: only the given fields go out (MODIFY_PENDING leaves the rest). 0 clears SL/TP.
  const modifyPending = useCallback(async (q: PendingOrder, edit: { price?: number; stopLoss?: number; takeProfit?: number }): Promise<boolean> => {
    const key = `modp:${q.ticket}:${edit.price ?? ''}:${edit.stopLoss ?? ''}:${edit.takeProfit ?? ''}`
    let answered = false
    try {
      const res = await orderApi.modifyPending({ clientOrderId: keys.acquire(key), ticket: q.ticket, symbol: q.symbol, mt5Login: q.login ?? null, ...edit })
      answered = true
      keys.settle(key)
      upsertOrder(res)
      if (failed(res)) {
        onToast(res.message ? localizeApiError(res.message) : String(t('charts.dock.modifyFailed')), 'error')
        return false
      }
      onToast(String(t(res.status === 'FILLED' ? 'charts.dock.pendingModified' : 'charts.dock.pendingModifySent')), res.status === 'FILLED' ? 'success' : 'info')
      return true
    } catch (e) {
      if (!answered) keys.afterThrow(key, e)
      onToast(errText(e, 'charts.dock.modifyFailed'), 'error')
      return false
    }
  }, [keys, upsertOrder, onToast, t]) // eslint-disable-line react-hooks/exhaustive-deps

  const cancelPending = useCallback(async (q: PendingOrder): Promise<boolean> => {
    const key = `cancelp:${q.ticket}`
    let answered = false
    try {
      const res = await orderApi.cancelPending({ clientOrderId: keys.acquire(key), ticket: q.ticket, symbol: q.symbol, mt5Login: q.login ?? null })
      answered = true
      keys.settle(key)
      upsertOrder(res)
      if (failed(res)) {
        onToast(res.message ? localizeApiError(res.message) : String(t('charts.dock.cancelFailed')), 'error')
        return false
      }
      if (res.status === 'FILLED') dropRow('pending', q)
      onToast(String(t('charts.dock.cancelSent')), 'info')
      return true
    } catch (e) {
      if (!answered) keys.afterThrow(key, e)
      onToast(errText(e, 'charts.dock.cancelFailed'), 'error')
      return false
    }
  }, [keys, upsertOrder, dropRow, onToast, t]) // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => ({ close, modify, reverse, modifyPending, cancelPending }), [close, modify, reverse, modifyPending, cancelPending])
}
