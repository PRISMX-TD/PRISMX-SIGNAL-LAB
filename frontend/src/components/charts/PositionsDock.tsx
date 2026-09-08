// 交易终端：持仓 / 挂单停靠（中栏底部 / 手机抽屉）。
// Trading terminal: positions / pending-orders dock (bottom of the center column / mobile sheet).
//
// 持仓来自 usePositions()（桥接实时上报），挂单来自 useLive().orders 里状态为
// PENDING 的开仓指令。平仓复用 orderApi.close（全平，带确认），撤单复用
// orderApi.cancel——与订单页/持仓卡完全同一套后端流程。2026-09-08 起不再是表格：
// 一仓一行发丝线，操作按钮悬停才出现（触屏常显），「管理」在行下展开部分平仓与
// 改止损止盈。
// Positions come from usePositions() (bridge-reported live); pending orders are
// the PENDING open-commands in useLive().orders. Close reuses orderApi.close
// (full close, with a confirm); cancel reuses orderApi.cancel. Since 2026-09-08
// this is hairline rows rather than a table: actions appear on hover (always on
// touch) and "manage" expands partial-close / modify SL·TP under the row.
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Order, Position } from '../../api/types'
import { orderApi } from '../../api/client'
import { clientOrderId, displaySymbol, localizeApiError } from '../../api/utils'
import { symbolMeta } from '../../utils/symbolMeta'
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
  const pnlSum = positions.reduce((s, p) => s + p.profit, 0)

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

  const fmt = (n: number | null | undefined, digits: number) => (n == null ? '—' : n.toFixed(digits))
  const Cell = ({ k, v, tone, area }: { k: string; v: string; tone?: 'up' | 'down'; area: string }) => (
    <div className={area}>
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ''}`}>{v}</div>
    </div>
  )

  return (
    <div className={`term-dock ${className}`}>
      <div className="term-dk-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'positions'} className={`term-dk-tab ${tab === 'positions' ? 'on' : ''}`} onClick={() => setTab('positions')}>
          {t('charts.dock.positions')} <b>{positions.length}</b>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'orders'} className={`term-dk-tab ${tab === 'orders' ? 'on' : ''}`} onClick={() => setTab('orders')}>
          {t('charts.dock.orders')} <b>{pendingOrders.length}</b>
        </button>
        {positions.length > 0 && (
          <span className="term-dk-sum">
            {t('charts.dock.colPnl')}
            <b className={pnlSum >= 0 ? 'up' : 'down'}>{pnlSum >= 0 ? '+' : ''}{pnlSum.toFixed(2)}</b>
          </span>
        )}
      </div>

      <div className="term-dk-body no-sb">
        {tab === 'positions' ? (
          positions.length === 0 ? (
            <div className="term-dk-empty">{t('charts.dock.noPositions')}</div>
          ) : (
            positions.map((p, i) => {
              const d = digitsFor(p.symbol)
              const up = p.profit >= 0
              const isBuy = p.side === 'BUY'
              const busy = busyId === `p-${p.ticket}`
              const isOpen = expanded === p.ticket && !!p.ticket
              const meta = symbolMeta(p.symbol)
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
                  <div className={`term-pr ${isOpen ? 'open' : ''}`} style={{ animationDelay: `${i * 40}ms` }}>
                    <div className="term-pr-id">
                      <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
                      <b>{displaySymbol(p.symbol)}</b>
                      <span className={`term-tag ${isBuy ? 'buy' : 'sell'}`}>{isBuy ? t('charts.dock.buy') : t('charts.dock.sell')} {p.volume.toFixed(2)}</span>
                    </div>
                    <Cell area="c-e" k={String(t('charts.dock.colEntry'))} v={fmt(p.entryPrice, d)} />
                    <Cell area="c-c" k={String(t('charts.dock.colCurrent'))} v={fmt(p.currentPrice, d)} />
                    <Cell area="c-sl" k={String(t('charts.dock.colSl'))} v={p.stopLoss ? fmt(p.stopLoss, d) : '—'} tone={p.stopLoss ? 'down' : undefined} />
                    <Cell area="c-tp" k={String(t('charts.dock.colTp'))} v={p.takeProfit ? fmt(p.takeProfit, d) : '—'} tone={p.takeProfit ? 'up' : undefined} />
                    <div className={`term-pnl pnl ${up ? 'up' : 'down'}`}>{up ? '+' : ''}{p.profit.toFixed(2)}</div>
                    <div className="term-pa">
                      <button type="button" className="warn" disabled={!p.ticket || busy} onClick={() => setConfirmClose(p)}>
                        {t('charts.dock.close')}
                      </button>
                      <button type="button" className={isOpen ? 'on' : ''} aria-expanded={isOpen} disabled={!p.ticket || busy} onClick={() => toggleExpand(p)}>
                        {t('charts.dock.manage')}
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="term-pr-x">
                      <div className="term-pr-xg">
                        <span className="term-pr-xk">{t('charts.dock.partialClose', { max: p.volume })}</span>
                        <div className="term-pr-xr">
                          <input
                            className={`term-pr-inp ${volBad ? 'bad' : ''}`}
                            value={form.vol}
                            inputMode="decimal"
                            onChange={(e) => setForm((f) => ({ ...f, vol: e.target.value.replace(/[^0-9.]/g, '') }))}
                          />
                          <button type="button" className="term-pr-btn" disabled={busy || volBad} onClick={() => closePosition(p, volNum)}>
                            {t('charts.dock.closeLots', { lots: volBad ? '' : volNum })}
                          </button>
                        </div>
                      </div>
                      <div className="term-pr-xg">
                        <span className="term-pr-xk">{t('charts.dock.modifySlTp')}</span>
                        <div className="term-pr-xr">
                          <input
                            className={`term-pr-inp ${slBad ? 'bad' : ''}`}
                            placeholder={String(t('charts.ticket.sl'))}
                            value={form.sl}
                            inputMode="decimal"
                            onChange={(e) => setForm((f) => ({ ...f, sl: e.target.value.replace(/[^0-9.]/g, '') }))}
                          />
                          <input
                            className={`term-pr-inp ${tpBad ? 'bad' : ''}`}
                            placeholder={String(t('charts.ticket.tp'))}
                            value={form.tp}
                            inputMode="decimal"
                            onChange={(e) => setForm((f) => ({ ...f, tp: e.target.value.replace(/[^0-9.]/g, '') }))}
                          />
                          <button type="button" className="term-pr-btn" disabled={busy || slBad || tpBad} onClick={() => modifyPosition(p, parseFloat(form.sl) || 0, parseFloat(form.tp) || 0)}>
                            {t('charts.dock.modify')}
                          </button>
                        </div>
                        {(slBad || tpBad) && <span className="term-pr-warn">{t('charts.dock.slTpWrong')}</span>}
                      </div>
                    </div>
                  )}
                </Fragment>
              )
            })
          )
        ) : pendingOrders.length === 0 ? (
          <div className="term-dk-empty">{t('charts.dock.noOrders')}</div>
        ) : (
          pendingOrders.map((o, i) => {
            const meta = symbolMeta(o.symbol)
            const isBuy = o.side === 'BUY'
            return (
              <div key={o.id} className="term-pr pend" style={{ animationDelay: `${i * 40}ms` }}>
                <div className="term-pr-id">
                  <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
                  <b>{displaySymbol(o.symbol)}</b>
                  <span className={`term-tag ${isBuy ? 'buy' : 'sell'}`}>{isBuy ? t('charts.dock.buy') : t('charts.dock.sell')} {o.volume.toFixed(2)}</span>
                </div>
                <div className="c-st"><span className="term-tag pending">{t('charts.dock.pending')}</span></div>
                <div className="term-pa">
                  <button type="button" className="warn" disabled={busyId === `o-${o.id}`} onClick={() => cancelOrder(o)}>
                    {t('charts.dock.cancel')}
                  </button>
                </div>
              </div>
            )
          })
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
