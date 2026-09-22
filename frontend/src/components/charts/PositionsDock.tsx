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
import type { Order, PendingOrder, Position } from '../../api/types'
import { orderApi } from '../../api/client'
import { clientOrderId, displaySymbol, isLotOnStep, localizeApiError,
         limitLotInput, lotStep, minLot, snapLot } from '../../api/utils'
import { checkSlTp } from '../order/orderMath'
import { symbolMeta } from '../../utils/symbolMeta'
import ConfirmModal from '../ConfirmModal'

interface Props {
  positions: Position[]
  orders: Order[]
  // 券商那边真实挂着的挂单（PENDING_ORDERS 推送）。与上面的 `orders` 是两回事：
  // 那是平台侧的指令行（含还没被桥接取走的），这是 MT5 里真的挂着的单。
  // 「挂单」页签两样都显示，但分组、措辞和操作都不同——撤一条指令行只是让它不再
  // 下发，撤一张挂单要真的发一条指令到券商。
  // Orders actually resting at the broker. Distinct from `orders` above, which are
  // platform command rows: cancelling one of those merely stops it from being
  // dispatched, while cancelling one of these sends a real command to the broker.
  pendingOrders: PendingOrder[]
  digitsFor: (symbol: string) => number
  onToast: (msg: string, kind: 'success' | 'error' | 'info') => void
  className?: string
  // 一键平仓的作用范围，必须与传进来的 positions 同一个口径（见 ChartsPage 的
  // accountPositions）：null = 不限账号，正是单账号 / 数据没带 login 时列表的范围。
  // 两者一旦不一致，按钮就会平掉屏幕上看不见的仓位。
  // Close-all scope; must match exactly how `positions` was filtered (see
  // ChartsPage's accountPositions). null = every account, which is precisely the
  // list's scope for a single-account user or login-less rows. If the two drift,
  // the button closes positions that aren't on screen.
  mt5Login?: string | null
  accountLabel?: string
}

type Tab = 'positions' | 'orders'

// 待确认的危险动作。全平以前有 ConfirmModal、部分平仓与撤单直接发——同一行里
// 危险度相当的三个动作确认级别却不一致，最容易误触的反而没拦。2026-09-19 统一成
// 一个确认队列：全平 / 部分平仓 / 撤单 / 会清掉已有止损止盈的改单都走这里。
// A pending dangerous action. Full close had a ConfirmModal while partial close
// and cancel fired straight away — three comparably risky actions in one row with
// inconsistent confirmation. Unified 2026-09-19 into one queue that also covers a
// modify which would clear an existing SL/TP, and 2026-09-22's close-all.
// 一键平仓（2026-09-22）也走这个队列，不另开一个确认框。
type Pending =
  | { kind: 'closeAll' }
  | { kind: 'close'; position: Position }
  | { kind: 'partial'; position: Position; volume: number }
  | { kind: 'cancel'; order: Order }
  | { kind: 'cancelPending'; order: PendingOrder }
  | { kind: 'clearSlTp'; position: Position; sl: number; tp: number }

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
// busyId 里代表"一键平仓正在发"的哨兵值（其余值是 p-<ticket> / o-<id>）。
// Sentinel busyId for the in-flight close-all (other values are p-<ticket> / o-<id>).
const CLOSE_ALL_ID = 'close-all'

export default function PositionsDock({ positions, orders, pendingOrders, digitsFor, onToast, className = '', mt5Login = null, accountLabel = '' }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('positions')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  // 展开做部分平仓 / 改止损止盈的仓位 ticket，及其表单值 / expanded position for
  // partial-close / modify, plus its form values
  const [expanded, setExpanded] = useState<number | null>(null)
  const [form, setForm] = useState<{ vol: string; sl: string; tp: string }>({ vol: '', sl: '', tp: '' })
  // 展开那一刻填进表单的值。用来区分"用户改过这一格"与"还是打开时那个快照"：
  // 桥接推来新的止损止盈后，没被用户碰过的格子要跟着更新，否则用户只改止盈按下
  // 「修改」，另一条腿会把刚变的止损又覆盖回旧值（与 PositionOverlay 的确认框同一
  // 类问题）。用户已经改过的格子绝不覆盖——正在打字的内容被改掉是最糟的交互。
  // The values the form was opened with, used to tell "the user edited this field"
  // from "still the opening snapshot": when the bridge reports a new SL/TP, an
  // untouched field must follow, or pressing Modify after editing only the TP
  // would write the stale SL back over the newer one. A field the user has typed
  // in is never overwritten.
  const [formInit, setFormInit] = useState<{ vol: string; sl: string; tp: string }>({ vol: '', sl: '', tp: '' })
  const [closing, setClosing] = useState<Record<number, Closing>>({})
  const [fresh, setFresh] = useState<Record<number, true>>({})
  const seenTickets = useRef<Set<number> | null>(null)
  const mountedAt = useRef(Date.now())

  // 高亮 / 平仓中兜底都靠 setTimeout，id 以前没人收着，切页签或关抽屉把组件卸载
  // 之后它们照样会 setFresh / setClosing。React 18 不报错，但持仓多时就是一串悬挂
  // 定时器。统一收进这里，卸载时全清。
  // The flash and closing-timeout callbacks used to fire after unmount (switching
  // tabs / closing the sheet) because their timer ids were never kept. Collected
  // here and cleared on unmount.
  const timers = useRef<Set<number>>(new Set())
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => { timers.current.delete(id); fn() }, ms)
    timers.current.add(id)
    return id
  }
  useEffect(() => () => {
    for (const id of timers.current) window.clearTimeout(id)
    timers.current.clear()
  }, [])

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
        later(() => {
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
    later(() => {
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

  // 还没被执行的平台指令（等桥接拉取）。这不是「挂单」，是「指令在路上」——
  // 挂单指令（action='PENDING'）在挂出去之前也长这样，所以两种都收。
  // Platform commands not yet executed (waiting for the bridge). These are not
  // pending orders but commands in flight; a pending-order command looks like this
  // too until it reaches the broker, so both actions are collected.
  const inFlight = orders.filter(
    (o) => o.status === 'PENDING' && ['ORDER', 'PENDING'].includes(o.action ?? 'ORDER'),
  )
  const pnlSum = positions.reduce((s, p) => s + p.profit, 0)

  const toggleExpand = (p: Position) => {
    if (!p.ticket) return
    if (expanded === p.ticket) {
      setExpanded(null)
      return
    }
    setExpanded(p.ticket)
    const next = { vol: String(p.volume), sl: p.stopLoss ? String(p.stopLoss) : '', tp: p.takeProfit ? String(p.takeProfit) : '' }
    setForm(next)
    setFormInit(next)
  }

  // 展开期间持仓被推送更新时，同步那些用户还没碰过的格子（见 formInit 的说明）。
  // Sync the untouched fields while the row is expanded (see formInit).
  useEffect(() => {
    if (expanded == null) return
    const p = positions.find((x) => x.ticket === expanded)
    if (!p) return
    const latest = { vol: String(p.volume), sl: p.stopLoss ? String(p.stopLoss) : '', tp: p.takeProfit ? String(p.takeProfit) : '' }
    if (formInit.vol === latest.vol && formInit.sl === latest.sl && formInit.tp === latest.tp) return
    setForm((f) => ({
      vol: f.vol === formInit.vol ? latest.vol : f.vol,
      sl: f.sl === formInit.sl ? latest.sl : f.sl,
      tp: f.tp === formInit.tp ? latest.tp : f.tp,
    }))
    setFormInit(latest)
  }, [positions, expanded, formInit])

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

  // 一键平仓：一个请求排完整批指令（后端 POST /orders/close-all），不在这里循环调
  // closePosition——循环共用下单那个按 IP 的限流桶，仓位多时可能只平掉一半；
  // 且每条回执都会单独推一条通知，而后端那条路径整批只响一次（见 services/close_all.py）。
  // 接口只回"已受理"，所以这里把看得见的仓位全部标成"平仓中"，等持仓推送把行拿掉
  // ——与单行平仓一模一样的体感。只标本次真的排下去的那几笔（queued）意义不大，
  // 因为被跳过的那几笔本来就已经在平了（skipped），整批都该是“平仓中”。
  // One request queues the whole batch (POST /orders/close-all) instead of looping
  // closePosition here: the loop shares the per-IP order rate-limit bucket and one
  // notification per receipt, while the backend path notifies once per batch. The
  // response only acknowledges, so every visible row is marked "closing" and waits
  // for the positions feed — identical to how a single close behaves.
  const closeAllPositions = async () => {
    setBusyId(CLOSE_ALL_ID)
    const tickets = positions.map((p) => p.ticket).filter((tk): tk is number => !!tk)
    try {
      const res = await orderApi.closeAll({ clientOrderId: clientOrderId(), mt5Login })
      for (const tk of tickets) {
        const p = positions.find((x) => x.ticket === tk)
        markClosing(tk, p?.volume ?? 0, false)
      }
      onToast(
        res.queued > 0
          ? String(t('orders.closeAll.sent', { count: res.queued }))
          : String(t('orders.closeAll.busy')),
        'info',
      )
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : String(t('orders.closeAll.failed')), 'error')
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

  // 撤一张真实的 MT5 挂单。走 orderApi.cancelPending（发指令到券商），不是
  // orderApi.cancel（只作废平台指令行）——两者名字像，作用完全不同。
  // Cancel a real MT5 pending order via orderApi.cancelPending, which sends a command
  // to the broker — not orderApi.cancel, which only voids a platform command row.
  const cancelPendingOrder = async (o: PendingOrder) => {
    setBusyId(`q-${o.ticket}`)
    try {
      const res = await orderApi.cancelPending({
        clientOrderId: clientOrderId(),
        ticket: o.ticket,
        symbol: o.symbol,
        mt5Login: o.login ?? null,
      })
      // 网关账号当场回结果；桥接账号只是收单，行要等下一拍挂单快照才消失。
      // A gateway account answers synchronously; a bridge one is merely accepted and
      // the row goes away with the next pending-orders snapshot.
      if (res.status === 'REJECTED' || res.status === 'FAILED') {
        onToast(res.message ? localizeApiError(res.message) : String(t('charts.dock.cancelFailed')), 'error')
      } else {
        onToast(String(t('charts.dock.cancelSent')), 'info')
      }
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
          {t('charts.dock.orders')} <b>{pendingOrders.length + inFlight.length}</b>
        </button>
        {positions.length > 0 && (
          <span className="term-dk-sum">
            {t('charts.dock.colPnl')}
            <b className={pnlSum >= 0 ? 'up' : 'down'}>{pnlSum >= 0 ? '+' : ''}{pnlSum.toFixed(2)}</b>
          </span>
        )}
        {/* 全部平仓：只在持仓页签且有仓时出现。文案与订单页共用 orders.closeAll.*，
            不在 charts.dock.* 下再抄一份——同一个动作两个入口，文案要是两份就会各自漂移。
            Close-all appears on the positions tab only. Wording is shared with the
            orders page (orders.closeAll.*) rather than copied under charts.dock.*:
            one action with two entry points must not carry two copies of the text. */}
        {tab === 'positions' && positions.length > 0 && (
          <button
            type="button"
            className="term-dk-closeall"
            disabled={busyId === CLOSE_ALL_ID}
            onClick={() => setPending({ kind: 'closeAll' })}
          >
            {t('orders.closeAll.btn')}
          </button>
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
              // 部分平仓手数校验：[最小手数, 持仓量]，且必须落在该品种的步长上。
              // 步长按品种取（原油 0.1，其余 0.01）。非整数倍的手数会被券商收下却
              // 永不成交，并把这张仓位锁死，后续平仓全部被拒（见 isLotOnStep）。
              // Partial-close volume must sit in [minLot, size] and on the symbol's
              // step: an off-step volume is accepted but never fills, locking the position.
              const pStep = lotStep(p.symbol)
              const pMinVol = minLot(p.symbol)
              const volNum = parseFloat(form.vol)
              const volBad = Number.isNaN(volNum) || volNum < pMinVol || volNum > p.volume
                || !isLotOnStep(volNum, p.symbol)
              // 改止损止盈校验统一走下单表单那份 checkSlTp：方向（买单止损须低于
              // 现价）之外还带「两条腿都填时不许互穿」，后者不依赖现价，所以桥接
              // 没报现价的仓位也挡得住。以前这里是独立的一份，只有方向那一半。
              // Route the modify check through the order form's checkSlTp: besides
              // the side rule it enforces that a filled pair doesn't cross, which
              // needs no current price — so positions with no reported price are
              // still guarded. This used to be a separate, weaker copy.
              const slN = form.sl.trim() === '' ? null : parseFloat(form.sl)
              const tpN = form.tp.trim() === '' ? null : parseFloat(form.tp)
              const ref = p.currentPrice
              const { slInvalid: slBad, tpInvalid: tpBad } =
                checkSlTp(isBuy, slN, tpN, ref != null && ref > 0 ? ref : null)
              // 「留空 = 清除」是这张表单刻意的语义（分组标题里写着「0 或留空清除」），
              // 但只改一条腿时另一条被顺手清掉是真事故。要清掉已有的止损/止盈就弹
              // 确认，其余照旧直接发。/ "Blank clears" is this form's deliberate
              // semantic (the group label says so), but clearing the other leg by
              // accident while editing one is a real incident. Clearing an existing
              // SL/TP now asks first; everything else still submits directly.
              const modSl = parseFloat(form.sl) || 0
              const modTp = parseFloat(form.tp) || 0
              const wouldClear = (!!p.stopLoss && p.stopLoss > 0 && modSl === 0)
                || (!!p.takeProfit && p.takeProfit > 0 && modTp === 0)
              return (
                // key 用 ticket；ticket 缺失的仓位（极少，旧记录）拿品种+方向+开仓价
                // 兜底，而不是数组下标——下标会在推送重排时把展开态与输入框内容串到
                // 另一条仓位上。/ Key by ticket, falling back to a content-derived key
                // rather than the array index, which would carry the expanded state
                // and the typed values onto a different position when the feed
                // reorders.
                <Fragment key={p.ticket ?? `${p.symbol}-${p.side}-${p.entryPrice ?? i}`}>
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
                          <button type="button" className="warn" disabled={!p.ticket || busy} onClick={() => setPending({ kind: 'close', position: p })}>
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
                            title={String(t('positions.lotStepHint', { step: pStep, min: pMinVol }))}
                            // 失焦吸附到该品种的步长，别让用户自己猜哪个数合法。
                            // Snap to the symbol's step on blur.
                            onBlur={() => setForm((f) => {
                              const v = parseFloat(f.vol)
                              if (!Number.isFinite(v) || v <= 0) return f
                              return { ...f, vol: String(Math.min(p.volume, snapLot(v, p.symbol))) }
                            })}
                            onChange={(e) => setForm((f) => ({ ...f, vol: limitLotInput(e.target.value, p.symbol) }))}
                          />
                          <button type="button" className="term-pr-btn" disabled={busy || volBad} onClick={() => setPending({ kind: 'partial', position: p, volume: volNum })}>
                            {t('charts.dock.closeLots', { lots: volBad ? '' : volNum })}
                          </button>
                        </div>
                      </div>
                      <div className="term-pr-xg">
                        <span className="term-pr-xk">{t('charts.dock.modifySlTp')}</span>
                        <div className="term-pr-xr">
                          {/* placeholder 用「留空即清除」而不是 SL / TP：持仓卡
                              （PositionCard）早就是这么写的，这两处行为完全一样却
                              只有那边说了，最容易误删止损的恰好是没说的这一处。
                              The placeholder spells out "blank clears", matching
                              PositionCard: identical behaviour, and this was the
                              copy that didn't say so. */}
                          <input
                            className={`term-pr-inp ${slBad ? 'bad' : ''}`}
                            placeholder={String(t('positions.clearHint'))}
                            aria-label={String(t('charts.ticket.sl'))}
                            value={form.sl}
                            inputMode="decimal"
                            onChange={(e) => setForm((f) => ({ ...f, sl: e.target.value.replace(/[^0-9.]/g, '') }))}
                          />
                          <input
                            className={`term-pr-inp ${tpBad ? 'bad' : ''}`}
                            placeholder={String(t('positions.clearHint'))}
                            aria-label={String(t('charts.ticket.tp'))}
                            value={form.tp}
                            inputMode="decimal"
                            onChange={(e) => setForm((f) => ({ ...f, tp: e.target.value.replace(/[^0-9.]/g, '') }))}
                          />
                          <button
                            type="button"
                            className="term-pr-btn"
                            disabled={busy || slBad || tpBad}
                            onClick={() => (wouldClear
                              ? setPending({ kind: 'clearSlTp', position: p, sl: modSl, tp: modTp })
                              : modifyPosition(p, modSl, modTp))}
                          >
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
        ) : pendingOrders.length === 0 && inFlight.length === 0 ? (
          <div className="term-dk-empty">{t('charts.dock.noOrders')}</div>
        ) : (
          <>
            {/* 券商那边真实挂着的挂单：有触发价、有止损止盈，撤单会真的发指令过去。
                Real orders resting at the broker: they carry a trigger price and
                SL/TP, and cancelling one sends a command to the broker. */}
            {pendingOrders.map((o, i) => {
              const meta = symbolMeta(o.symbol)
              const isBuy = o.side === 'BUY'
              const d = digitsFor(o.symbol)
              return (
                <div key={`q-${o.login ?? ''}-${o.ticket}`} className="term-pr pend q" style={{ animationDelay: `${i * 40}ms` }}>
                  <div className="term-pr-id">
                    <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
                    <b>{displaySymbol(o.symbol)}</b>
                    <span className={`term-tag ${isBuy ? 'buy' : 'sell'}`}>
                      {t(`order.pending.type.${o.type}`)} {o.volume.toFixed(2)}
                    </span>
                  </div>
                  <Cell k={String(t('charts.dock.triggerPrice'))} v={fmt(o.price, d)} area="c-en" />
                  <Cell k={String(t('charts.ticket.sl'))} v={o.stopLoss ? fmt(o.stopLoss, d) : '—'} area="c-sl" />
                  <Cell k={String(t('charts.ticket.tp'))} v={o.takeProfit ? fmt(o.takeProfit, d) : '—'} area="c-tp" />
                  <div className="term-pa">
                    <button type="button" className="warn" disabled={busyId === `q-${o.ticket}`} onClick={() => setPending({ kind: 'cancelPending', order: o })}>
                      {t('charts.dock.cancel')}
                    </button>
                  </div>
                </div>
              )
            })}
            {/* 平台指令在路上（还没到券商）。与上面那组分开，因为「撤」的含义不同：
                这里只是让它不再下发，仓位/挂单本来就还不存在。
                Commands still in flight to the broker. Kept apart because "cancel"
                means something else here: it only stops the dispatch, and nothing
                exists at the broker yet either way. */}
            {inFlight.map((o, i) => {
              const meta = symbolMeta(o.symbol)
              const isBuy = o.side === 'BUY'
              return (
                <div key={o.id} className="term-pr pend" style={{ animationDelay: `${(pendingOrders.length + i) * 40}ms` }}>
                  <div className="term-pr-id">
                    <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
                    <b>{displaySymbol(o.symbol)}</b>
                    <span className={`term-tag ${isBuy ? 'buy' : 'sell'}`}>{isBuy ? t('charts.dock.buy') : t('charts.dock.sell')} {o.volume.toFixed(2)}</span>
                  </div>
                  <div className="c-st"><span className="term-tag pending">{t('charts.dock.pending')}</span></div>
                  <div className="term-pa">
                    <button type="button" className="warn" disabled={busyId === `o-${o.id}`} onClick={() => setPending({ kind: 'cancel', order: o })}>
                      {t('charts.dock.cancel')}
                    </button>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      {pending && (() => {
        const sideOf = (side: string) => String(side === 'BUY' ? t('charts.dock.buy') : t('charts.dock.sell'))
        // 五种危险动作共用一个确认框；文案全部由既有键拼出，不新造字符串。
        // （原来是一条四层嵌套三元，加到五种就读不动了，改成提前返回。）
        // One dialog for all five dangerous actions, worded from existing keys.
        const view = ((): { title: string; message: string; label: string; busyId: string } => {
          if (pending.kind === 'closeAll') {
            return {
              title: String(t('orders.closeAll.title')),
              message: String(t('orders.closeAll.msg', {
                account: accountLabel || mt5Login || '',
                count: positions.length,
                pnl: `${pnlSum >= 0 ? '+' : ''}${pnlSum.toFixed(2)}`,
              })),
              label: String(t('orders.closeAll.confirm')),
              busyId: CLOSE_ALL_ID,
            }
          }
          if (pending.kind === 'close') {
            return {
              title: String(t('charts.dock.confirmCloseTitle')),
              message: String(t('charts.dock.confirmCloseMsg', {
                symbol: displaySymbol(pending.position.symbol),
                side: sideOf(pending.position.side),
                volume: pending.position.volume,
              })),
              label: String(t('charts.dock.close')),
              busyId: `p-${pending.position.ticket}`,
            }
          }
          if (pending.kind === 'partial') {
            return {
              title: String(t('charts.dock.closeLots', { lots: pending.volume })),
              message: String(t('charts.dock.confirmCloseMsg', {
                symbol: displaySymbol(pending.position.symbol),
                side: sideOf(pending.position.side),
                volume: pending.volume,
              })),
              label: String(t('charts.dock.close')),
              busyId: `p-${pending.position.ticket}`,
            }
          }
          if (pending.kind === 'cancelPending') {
            return {
              title: String(t('charts.dock.cancelPendingTitle')),
              message: String(t('charts.dock.cancelPendingMsg', {
                symbol: displaySymbol(pending.order.symbol),
                type: String(t(`order.pending.type.${pending.order.type}`)),
                volume: pending.order.volume,
                price: fmt(pending.order.price, digitsFor(pending.order.symbol)),
              })),
              label: String(t('charts.dock.cancel')),
              busyId: `q-${pending.order.ticket}`,
            }
          }
          if (pending.kind === 'cancel') {
            return {
              title: String(t('charts.dock.cancel')),
              message: `${displaySymbol(pending.order.symbol)} · ${sideOf(pending.order.side)} ${pending.order.volume}`,
              label: String(t('charts.dock.cancel')),
              busyId: `o-${pending.order.id}`,
            }
          }
          return {
            title: String(t('charts.posmark.confirmModifyTitle')),
            // 每条被清掉的腿写一行「从 X 改至 —」，用的是拖动改单那条同样的
            // 模板，所以「清除」这件事是看得见的，而不是藏在留空语义里。
            // One line per cleared leg reusing the drag-modify template, so
            // the removal is visible rather than implied by an empty field.
            message: (['sl', 'tp'] as const)
              .filter((leg) => {
                const cur = leg === 'sl' ? pending.position.stopLoss : pending.position.takeProfit
                const next = leg === 'sl' ? pending.sl : pending.tp
                return !!cur && cur > 0 && next === 0
              })
              .map((leg) => String(t('charts.posmark.confirmModifyMsg', {
                symbol: displaySymbol(pending.position.symbol),
                side: sideOf(pending.position.side),
                ticket: String(pending.position.ticket ?? ''),
                kind: String(leg === 'sl' ? t('charts.ticket.sl') : t('charts.ticket.tp')),
                from: String((leg === 'sl' ? pending.position.stopLoss : pending.position.takeProfit) ?? '—'),
                to: '—',
              })))
              .join(' · '),
            label: String(t('charts.dock.modify')),
            busyId: `p-${pending.position.ticket}`,
          }
        })()
        return (
          <ConfirmModal
            title={view.title}
            message={view.message}
            confirmLabel={view.label}
            danger
            busy={busyId === view.busyId}
            onConfirm={() => {
              const act = pending
              setPending(null)
              if (act.kind === 'closeAll') void closeAllPositions()
              else if (act.kind === 'close') void closePosition(act.position)
              else if (act.kind === 'partial') void closePosition(act.position, act.volume)
              else if (act.kind === 'cancel') void cancelOrder(act.order)
              else if (act.kind === 'cancelPending') void cancelPendingOrder(act.order)
              else void modifyPosition(act.position, act.sl, act.tp)
            }}
            onCancel={() => setPending(null)}
          />
        )
      })()}
    </div>
  )
}
