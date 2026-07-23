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
      onToast(volume != null ? '部分平仓指令已发出' : '平仓指令已发出', 'info')
      setExpanded(null)
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : '平仓失败', 'error')
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
      onToast('改止损止盈指令已发出', 'info')
      setExpanded(null)
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : '改单失败', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const cancelOrder = async (o: Order) => {
    setBusyId(`o-${o.id}`)
    try {
      await orderApi.cancel(o.id)
      onToast('已撤销挂单', 'info')
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : '撤销失败', 'error')
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
          持仓 <span className="term-dock-cnt">{positions.length}</span>
        </button>
        <button type="button" className={`term-dock-tab ${tab === 'orders' ? 'on' : ''}`} onClick={() => setTab('orders')}>
          挂单 <span className="term-dock-cnt">{pendingOrders.length}</span>
        </button>
      </div>

      <div className="term-dock-body no-sb">
        {tab === 'positions' ? (
          positions.length === 0 ? (
            <div className="term-dock-empty">暂无持仓 / No open positions</div>
          ) : (
            <table className="term-tbl">
              <thead>
                <tr>
                  <th>品种</th><th>方向</th><th>手数</th><th>开仓价</th><th>现价</th>
                  <th>止损</th><th>止盈</th><th>浮动盈亏</th><th></th>
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
                        <td><span className={`term-pill ${isBuy ? 'buy' : 'sell'}`}>{isBuy ? '买' : '卖'}</span></td>
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
                            平仓
                          </button>
                          <button
                            type="button"
                            className={`term-x-btn alt ${isOpen ? 'on' : ''}`}
                            disabled={!p.ticket || busy}
                            onClick={() => toggleExpand(p)}
                          >
                            管理
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="term-pos-expand">
                          <td colSpan={9}>
                            <div className="term-pos-panel">
                              {/* 部分平仓 / partial close */}
                              <div className="term-pos-group">
                                <span className="term-pos-group-k">部分平仓（最多 {p.volume}）</span>
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
                                    平掉 {volBad ? '' : volNum} 手
                                  </button>
                                </div>
                              </div>
                              {/* 改止损止盈 / modify SL·TP */}
                              <div className="term-pos-group">
                                <span className="term-pos-group-k">改止损 / 止盈（0 或留空清除）</span>
                                <div className="term-pos-row">
                                  <input
                                    className={`term-pos-inp num ${slBad ? 'bad' : ''}`}
                                    placeholder="止损 SL"
                                    value={form.sl}
                                    inputMode="decimal"
                                    onChange={(e) => setForm((f) => ({ ...f, sl: e.target.value.replace(/[^0-9.]/g, '') }))}
                                  />
                                  <input
                                    className={`term-pos-inp num ${tpBad ? 'bad' : ''}`}
                                    placeholder="止盈 TP"
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
                                    修改
                                  </button>
                                </div>
                                {(slBad || tpBad) && <span className="term-pos-warn">方向填反了：买单止损须低于现价、止盈须高于现价</span>}
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
          <div className="term-dock-empty">暂无挂单 / No pending orders</div>
        ) : (
          <table className="term-tbl">
            <thead>
              <tr>
                <th>品种</th><th>方向</th><th>手数</th><th>状态</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pendingOrders.map((o) => (
                <tr key={o.id}>
                  <td className="term-tbl-sym">{displaySymbol(o.symbol)}</td>
                  <td><span className={`term-pill ${o.side === 'BUY' ? 'buy' : 'sell'}`}>{o.side === 'BUY' ? '买' : '卖'}</span></td>
                  <td className="num">{o.volume.toFixed(2)}</td>
                  <td className="term-tbl-status">待执行</td>
                  <td>
                    <button
                      type="button"
                      className="term-x-btn"
                      disabled={busyId === `o-${o.id}`}
                      onClick={() => cancelOrder(o)}
                    >
                      撤销
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
          title="全部平仓"
          message={`确认平掉 ${displaySymbol(confirmClose.symbol)} ${confirmClose.side === 'BUY' ? '买' : '卖'} ${confirmClose.volume} 手？`}
          confirmLabel="平仓"
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
