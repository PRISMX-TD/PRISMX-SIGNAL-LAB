// 交易终端：底部持仓 / 挂单面板（中栏底部）。
// Trading terminal: positions / pending-orders dock (bottom of the center column).
//
// 持仓来自 usePositions()（桥接实时上报），挂单来自 useLive().orders 里状态为
// PENDING 的开仓指令。平仓复用 orderApi.close（全平，带确认），撤单复用
// orderApi.cancel——与订单页/持仓卡完全同一套后端流程，只是在这里以密集表格
// 呈现，贴合终端。
// Positions come from usePositions() (bridge-reported live); pending orders are
// the PENDING open-commands in useLive().orders. Close reuses orderApi.close
// (full close, with a confirm); cancel reuses orderApi.cancel — the exact same
// backend flow as the orders page / position card, just rendered as a dense
// terminal table.
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Order, Position } from '../../api/types'
import { orderApi } from '../../api/client'
import { clientOrderId, displaySymbol, localizeApiError } from '../../api/utils'
import ConfirmModal from '../ConfirmModal'

interface Props {
  positions: Position[]
  orders: Order[]
  digitsFor: (symbol: string) => number
  onToast: (msg: string, kind: 'success' | 'error' | 'info') => void
  className?: string
}

type Tab = 'positions' | 'orders'

export default function PositionsDock({ positions, orders, digitsFor, onToast, className = '' }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('positions')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState<Position | null>(null)
  // 展开做部分平仓 / 改止损止盈的仓位 ticket，及其表单值 / expanded position for
  // partial-close / modify, plus its form values
  const [expanded, setExpanded] = useState<number | null>(null)
  const [form, setForm] = useState<{ vol: string; sl: string; tp: string }>({ vol: '', sl: '', tp: '' })

  // 未完成的开仓挂单（等待桥接拉取执行）/ open-orders still pending execution
  const pendingOrders = orders.filter((o) => o.status === 'PENDING' && (o.action ?? 'ORDER') === 'ORDER')

  const toggleExpand = (p: Position) => {
    if (!p.ticket) return
    if (expanded === p.ticket) {
      setExpanded(null)
      return
    }
    setExpanded(p.ticket)
    setForm({ vol: String(p.volume), sl: p.stopLoss ? String(p.stopLoss) : '', tp: p.takeProfit ? String(p.takeProfit) : '' })
  }

  const closePosition = async (p: Position, volume?: number) => {
    if (!p.ticket) return
    setBusyId(`p-${p.ticket}`)
    try {
      await orderApi.close({
        clientOrderId: clientOrderId(),
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        volume,
      })
      onToast(volume != null ? String(t('charts.dock.partialCloseSent')) : String(t('charts.dock.closeSent')), 'info')
      setExpanded(null)
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : String(t('charts.dock.closeFailed')), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const modifyPosition = async (p: Position, sl: number, tp: number) => {
    if (!p.ticket) return
    setBusyId(`p-${p.ticket}`)
    try {
      await orderApi.modify({
        clientOrderId: clientOrderId(),
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        stopLoss: sl,
        takeProfit: tp,
      })
      onToast(String(t('charts.dock.modifySent')), 'info')
      setExpanded(null)
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : String(t('charts.dock.modifyFailed')), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const cancelOrder = async (o: Order) => {
    setBusyId(`o-${o.id}`)
    try {
      await orderApi.cancel(o.id)
      onToast(String(t('charts.dock.cancelSent')), 'info')
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : String(t('charts.dock.cancelFailed')), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const fmt = (n: number | null | undefined, digits: number) =>
    n == null ? '—' : n.toFixed(digits)

  return (
    <div className={`term-panel term-dock ${className}`}>
      <div className="term-dock-tabs">
        <button type="button" className={`term-dock-tab ${tab === 'positions' ? 'on' : ''}`} onClick={() => setTab('positions')}>
          {t('charts.dock.positions')} <span className="term-dock-cnt">{positions.length}</span>
        </button>
        <button type="button" className={`term-dock-tab ${tab === 'orders' ? 'on' : ''}`} onClick={() => setTab('orders')}>
          {t('charts.dock.orders')} <span className="term-dock-cnt">{pendingOrders.length}</span>
        </button>
      </div>

      <div className="term-dock-body no-sb">
        {tab === 'positions' ? (
          positions.length === 0 ? (
            <div className="term-dock-empty">{t('charts.dock.noPositions')}</div>
          ) : (
            <table className="term-tbl">
              <thead>
                <tr>
                  <th>{t('charts.dock.colSymbol')}</th><th>{t('charts.dock.colSide')}</th><th>{t('charts.dock.colVolume')}</th><th>{t('charts.dock.colEntry')}</th><th>{t('charts.dock.colCurrent')}</th>
                  <th>{t('charts.dock.colSl')}</th><th>{t('charts.dock.colTp')}</th><th>{t('charts.dock.colPnl')}</th><th></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => {
                  const d = digitsFor(p.symbol)
                  const up = p.profit >= 0
                  const isBuy = p.side === 'BUY'
                  const busy = busyId === `p-${p.ticket}`
                  const isOpen = expanded === p.ticket && !!p.ticket
                  // 部分平仓手数校验：[0.01, 持仓量] / partial-close volume must be in [0.01, size]
                  const volNum = parseFloat(form.vol)
                  const volBad = Number.isNaN(volNum) || volNum < 0.01 || volNum > p.volume
                  // 改止损止盈方向校验（现价缺失时跳过）/ SL/TP direction check (skipped without a price)
                  const slN = form.sl.trim() === '' ? null : parseFloat(form.sl)
                  const tpN = form.tp.trim() === '' ? null : parseFloat(form.tp)
                  const ref = p.currentPrice
                  const slBad = slN != null && !Number.isNaN(slN) && ref != null && ref > 0 && (isBuy ? slN >= ref : slN <= ref)
                  const tpBad = tpN != null && !Number.isNaN(tpN) && ref != null && ref > 0 && (isBuy ? tpN <= ref : tpN >= ref)
                  return (
                    <Fragment key={p.ticket ?? i}>
                      <tr className={isOpen ? 'term-tbl-open' : ''}>
                        <td className="term-tbl-sym">{displaySymbol(p.symbol)}</td>
                        <td><span className={`term-pill ${isBuy ? 'buy' : 'sell'}`}>{isBuy ? t('charts.dock.buy') : t('charts.dock.sell')}</span></td>
                        <td className="num">{p.volume.toFixed(2)}</td>
                        <td className="num">{fmt(p.entryPrice, d)}</td>
                        <td className="num">{fmt(p.currentPrice, d)}</td>
                        <td className="num down">{p.stopLoss ? fmt(p.stopLoss, d) : '—'}</td>
                        <td className="num up">{p.takeProfit ? fmt(p.takeProfit, d) : '—'}</td>
                        <td className={`num ${up ? 'up' : 'down'}`}>{up ? '+' : ''}{p.profit.toFixed(2)}</td>
                        <td className="term-tbl-actions">
                          <button
                            type="button"
                            className="term-x-btn"
                            disabled={!p.ticket || busy}
                            onClick={() => setConfirmClose(p)}
                          >
                            {t('charts.dock.close')}
                          </button>
                          <button
                            type="button"
                            className={`term-x-btn alt ${isOpen ? 'on' : ''}`}
                            disabled={!p.ticket || busy}
                            onClick={() => toggleExpand(p)}
                          >
                            {t('charts.dock.manage')}
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="term-pos-expand">
                          <td colSpan={9}>
                            <div className="term-pos-panel">
                              {/* 部分平仓 / partial close */}
                              <div className="term-pos-group">
                                <span className="term-pos-group-k">{t('charts.dock.partialClose', { max: p.volume })}</span>
                                <div className="term-pos-row">
                                  <input
                                    className={`term-pos-inp num ${volBad ? 'bad' : ''}`}
                                    value={form.vol}
                                    inputMode="decimal"
                                    onChange={(e) => setForm((f) => ({ ...f, vol: e.target.value.replace(/[^0-9.]/g, '') }))}
                                  />
                                  <button
                                    type="button"
                                    className="term-pos-btn"
                                    disabled={busy || volBad}
                                    onClick={() => closePosition(p, volNum)}
                                  >
                                    {t('charts.dock.closeLots', { lots: volBad ? '' : volNum })}
                                  </button>
                                </div>
                              </div>
                              {/* 改止损止盈 / modify SL·TP */}
                              <div className="term-pos-group">
                                <span className="term-pos-group-k">{t('charts.dock.modifySlTp')}</span>
                                <div className="term-pos-row">
                                  <input
                                    className={`term-pos-inp num ${slBad ? 'bad' : ''}`}
                                    placeholder={String(t('charts.ticket.sl'))}
                                    value={form.sl}
                                    inputMode="decimal"
                                    onChange={(e) => setForm((f) => ({ ...f, sl: e.target.value.replace(/[^0-9.]/g, '') }))}
                                  />
                                  <input
                                    className={`term-pos-inp num ${tpBad ? 'bad' : ''}`}
                                    placeholder={String(t('charts.ticket.tp'))}
                                    value={form.tp}
                                    inputMode="decimal"
                                    onChange={(e) => setForm((f) => ({ ...f, tp: e.target.value.replace(/[^0-9.]/g, '') }))}
                                  />
                                  <button
                                    type="button"
                                    className="term-pos-btn"
                                    disabled={busy || slBad || tpBad}
                                    onClick={() => modifyPosition(p, parseFloat(form.sl) || 0, parseFloat(form.tp) || 0)}
                                  >
                                    {t('charts.dock.modify')}
                                  </button>
                                </div>
                                {(slBad || tpBad) && <span className="term-pos-warn">{t('charts.dock.slTpWrong')}</span>}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )
        ) : pendingOrders.length === 0 ? (
          <div className="term-dock-empty">{t('charts.dock.noOrders')}</div>
        ) : (
          <table className="term-tbl">
            <thead>
              <tr>
                <th>{t('charts.dock.colSymbol')}</th><th>{t('charts.dock.colSide')}</th><th>{t('charts.dock.colVolume')}</th><th>{t('charts.dock.colStatus')}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pendingOrders.map((o) => (
                <tr key={o.id}>
                  <td className="term-tbl-sym">{displaySymbol(o.symbol)}</td>
                  <td><span className={`term-pill ${o.side === 'BUY' ? 'buy' : 'sell'}`}>{o.side === 'BUY' ? t('charts.dock.buy') : t('charts.dock.sell')}</span></td>
                  <td className="num">{o.volume.toFixed(2)}</td>
                  <td className="term-tbl-status">{t('charts.dock.pending')}</td>
                  <td>
                    <button
                      type="button"
                      className="term-x-btn"
                      disabled={busyId === `o-${o.id}`}
                      onClick={() => cancelOrder(o)}
                    >
                      {t('charts.dock.cancel')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {confirmClose && (
        <ConfirmModal
          title={String(t('charts.dock.confirmCloseTitle'))}
          message={String(t('charts.dock.confirmCloseMsg', {
            symbol: displaySymbol(confirmClose.symbol),
            side: confirmClose.side === 'BUY' ? t('charts.dock.buy') : t('charts.dock.sell'),
            volume: confirmClose.volume,
          }))}
          confirmLabel={String(t('charts.dock.close'))}
          danger
          busy={busyId === `p-${confirmClose.ticket}`}
          onConfirm={() => {
            const p = confirmClose
            setConfirmClose(null)
            void closePosition(p)
          }}
          onCancel={() => setConfirmClose(null)}
        />
      )}
    </div>
  )
}
