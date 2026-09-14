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
import { Fragment, useEffect, useRef, useState } from 'react'
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

// 一条正在平仓的仓位：发出时刻、发出时的手数、是否部分平仓。行在这段时间里压暗并
// 显示"平仓中"，直到持仓推送里它消失（全平）或手数变小（部分），或超时兜底放开。
// A close in flight: when it went out, the volume then, and whether partial. The
// row stays dimmed with a "closing" tag until the positions feed drops it (full)
// or shrinks it (partial), or the timeout releases it.
type Closing = { at: number; volume: number; partial: boolean }
// 兜底：桥接离线、回执丢失等情况下不能让一行永远"平仓中"。
// Safety net so a lost receipt never leaves a row closing forever.
const CLOSING_TIMEOUT_MS = 12000
// 新出现的仓位行高亮多久（与 term-flash 动画时长一致）/ how long a new row flashes
const FRESH_MS = 1400
// 挂载后这段时间内出现的仓位视为首屏加载，不算"新成交"，不高亮。
// Rows arriving this soon after mount are the initial load, not a fresh fill.
const FRESH_GRACE_MS = 3000

export default function PositionsDock({ positions, orders, digitsFor, onToast, className = '' }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('positions')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState<Position | null>(null)
  // 展开做部分平仓 / 改止损止盈的仓位 ticket，及其表单值 / expanded position for
  // partial-close / modify, plus its form values
  const [expanded, setExpanded] = useState<number | null>(null)
  const [form, setForm] = useState<{ vol: string; sl: string; tp: string }>({ vol: '', sl: '', tp: '' })
  const [closing, setClosing] = useState<Record<number, Closing>>({})
  const [fresh, setFresh] = useState<Record<number, true>>({})
  const seenTickets = useRef<Set<number> | null>(null)
  const mountedAt = useRef(Date.now())

  // 持仓推送到达：① 平仓中的行若已消失 / 手数已变小就放开；② 新出现的 ticket 高亮一下。
  // On each positions push: release closing rows that are gone or shrunk; flash new tickets.
  useEffect(() => {
    const now = Date.now()
    setClosing((prev) => {
      const keys = Object.keys(prev)
      if (keys.length === 0) return prev
      let changed = false
      const next: Record<number, Closing> = { ...prev }
      for (const k of keys) {
        const ticket = Number(k)
        const c = next[ticket]
        const p = positions.find((x) => x.ticket === ticket)
        if (!p || (c.partial && p.volume < c.volume - 1e-9) || now - c.at > CLOSING_TIMEOUT_MS) {
          delete next[ticket]
          changed = true
        }
      }
      return changed ? next : prev
    })

    const current = new Set<number>()
    for (const p of positions) if (p.ticket) current.add(p.ticket)
    const seen = seenTickets.current
    if (seen && now - mountedAt.current > FRESH_GRACE_MS) {
      const newcomers: number[] = []
      current.forEach((tk) => { if (!seen.has(tk)) newcomers.push(tk) })
      if (newcomers.length > 0) {
        setFresh((prev) => {
          const next = { ...prev }
          for (const tk of newcomers) next[tk] = true
          return next
        })
        window.setTimeout(() => {
          setFresh((prev) => {
            const next = { ...prev }
            for (const tk of newcomers) delete next[tk]
            return next
          })
        }, FRESH_MS)
      }
    }
    seenTickets.current = current
  }, [positions])

  const markClosing = (ticket: number, volume: number, partial: boolean) => {
    setClosing((prev) => ({ ...prev, [ticket]: { at: Date.now(), volume, partial } }))
    // 超时放开：持仓推送不来（桥接掉线）时也不能永远压着这一行。
    // Timed release for when no positions push ever arrives (bridge offline).
    window.setTimeout(() => {
      setClosing((prev) => {
        const c = prev[ticket]
        if (!c || Date.now() - c.at < CLOSING_TIMEOUT_MS) return prev
        const next = { ...prev }
        delete next[ticket]
        return next
      })
    }, CLOSING_TIMEOUT_MS + 50)
  }
  const unmarkClosing = (ticket: number) => {
    setClosing((prev) => {
      if (!prev[ticket]) return prev
      const next = { ...prev }
      delete next[ticket]
      return next
    })
  }

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
    const ticket = p.ticket
    const partial = volume != null
    setBusyId(`p-${ticket}`)
    // 点下去的这一刻行就进入"平仓中"，不等接口回来——用户看到的第一反应要是即时的。
    // The row enters "closing" the instant the click lands, not when the API returns.
    markClosing(ticket, p.volume, partial)
    setExpanded(null)
    try {
      const res = await orderApi.close({
        clientOrderId: clientOrderId(),
        ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        volume,
      })
      // 网关账号当场回成交：提示里给成交价，行随下一拍持仓推送消失；桥接账号只是
      // 收单，提示"已发出"，行保持"平仓中"直到桥接执行完、持仓推送把它拿掉。
      // A gateway account fills synchronously: toast the price, the row goes with
      // the next positions push. A bridge account is only accepted: keep "closing"
      // until the bridge executes and the feed drops the row.
      if (res.status === 'FILLED') {
        const px = res.filledPrice != null ? res.filledPrice.toFixed(digitsFor(p.symbol)) : '—'
        onToast(
          partial
            ? String(t('charts.dock.partialClosed', { lots: volume, price: px }))
            : String(t('charts.dock.closed', { price: px })),
          'success',
        )
      } else if (res.status === 'REJECTED' || res.status === 'FAILED') {
        unmarkClosing(ticket)
        onToast(res.message ? localizeApiError(res.message) : String(t('charts.dock.closeFailed')), 'error')
      } else {
        onToast(partial ? String(t('charts.dock.partialCloseSent')) : String(t('charts.dock.closeSent')), 'info')
      }
    } catch (e) {
      unmarkClosing(ticket)
      onToast(e instanceof Error ? localizeApiError(e.message) : String(t('charts.dock.closeFailed')), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const modifyPosition = async (p: Position, sl: number, tp: number) => {
    if (!p.ticket) return
    setBusyId(`p-${p.ticket}`)
    try {
      const res = await orderApi.modify({
        clientOrderId: clientOrderId(),
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        stopLoss: sl,
        takeProfit: tp,
      })
      if (res.status === 'FILLED') onToast(String(t('charts.dock.modified')), 'success')
      else if (res.status === 'REJECTED' || res.status === 'FAILED') onToast(res.message ? localizeApiError(res.message) : String(t('charts.dock.modifyFailed')), 'error')
      else onToast(String(t('charts.dock.modifySent')), 'info')
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
              const isClosing = !!p.ticket && !!closing[p.ticket]
              const busy = busyId === `p-${p.ticket}` || isClosing
              const isOpen = expanded === p.ticket && !!p.ticket && !isClosing
              const isFresh = !!p.ticket && !!fresh[p.ticket]
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
                  <div className={`term-pr ${isOpen ? 'open' : ''} ${isClosing ? 'closing' : ''} ${isFresh ? 'fresh' : ''}`} style={{ animationDelay: `${i * 40}ms` }}>
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
                      {isClosing ? (
                        <span className="term-closing" role="status"><i aria-hidden="true" />{t('charts.dock.closing')}</span>
                      ) : (
                        <>
                          <button type="button" className="warn" disabled={!p.ticket || busy} onClick={() => setConfirmClose(p)}>
                            {t('charts.dock.close')}
                          </button>
                          <button type="button" className={isOpen ? 'on' : ''} aria-expanded={isOpen} disabled={!p.ticket || busy} onClick={() => toggleExpand(p)}>
                            {t('charts.dock.manage')}
                          </button>
                        </>
                      )}
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
