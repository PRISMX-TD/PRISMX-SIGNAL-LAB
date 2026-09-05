// 图表持仓标记层：把当前选中账户在本品种上的持仓画到主图上——开仓价、止损、
// 止盈各一条线（带价格标签），并支持直接拖动止损/止盈线改单：松手即发 MODIFY
// 指令，与底部持仓面板的"管理"表单走完全同一套后端流程。可在工具栏一键显隐。
// Position markers layer: draws the selected account's positions for the current
// symbol onto the main pane — entry / SL / TP lines with price labels — and lets
// the user drag the SL/TP lines to modify them: dropping sends the same MODIFY
// command the dock's "manage" form does. Toggleable from the toolbar.
//
// 渲染走 lightweight-charts 的 ISeriesPrimitive（与 DrawLayer 一致）；命中与
// 拖拽用一层默认 pointer-events:none 的透明覆盖层，只有真的悬停到某条止损/
// 止盈线上时才抢指针事件——否则它常驻盖在图表上，原生的拖动平移与滚轮缩放
// 永远传不到底下的图表 canvas（DrawLayer 踩过这个坑，见其同名注释）。
//
// 拖拽松手会弹出确认框，用户确认后才真正发 MODIFY 指令——避免误触或拖错。
// Dragging a line and releasing shows a confirm dialog; the MODIFY is only
// sent after the user explicitly confirms — prevents accidental modifications.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  IChartApi, ISeriesApi, IPrimitivePaneView, IPrimitivePaneRenderer,
  AutoscaleInfo, Logical,
} from 'lightweight-charts'
import type { Position } from '../../api/types'
import { orderApi } from '../../api/client'
import { baseSymbol, clientOrderId, localizeApiError } from '../../api/utils'
import { isChartAlive } from './chartLifecycle'

// 触摸屏放宽命中容差（手指没有像素级精度）/ looser hit tolerance on touch screens
const isTouchDevice = typeof window !== 'undefined'
  && (window.matchMedia?.('(pointer: coarse)').matches ?? false)
const TOL = isTouchDevice ? 14 : 6

const UP_COLOR = '#2ee07e'
const DOWN_COLOR = '#ff4d67'
const ENTRY_COLOR = '#22d3ee'

// 改单指令已发出、桥接还没把新值报回来的这段时间里，先按用户拖到的值显示，
// 免得线"弹回"旧价位看起来像没生效。超过这个时限就放弃等待，回归真实数据。
// While a MODIFY is in flight (the bridge reports asynchronously) keep showing
// the dragged value so the line doesn't snap back and look like a no-op. Give
// up waiting after this long and fall back to the reported truth.
const OVERRIDE_TTL_MS = 60_000

type LineKind = 'sl' | 'tp'

interface Marker {
  ticket: number
  pos: Position
  entry: number
  sl: number | null
  tp: number | null
}

const keyOf = (ticket: number, kind: LineKind) => `${ticket}:${kind}`

// 渲染模型：一次画完全部持仓标记，比"每条线一个 primitive"少一大堆 attach/
// detach 记账。primitive 只持有一个取数函数，每帧读最新状态。
// Render model: one primitive paints every marker, which avoids a pile of
// attach/detach bookkeeping versus one primitive per line. The primitive holds
// only a getter and reads the latest state each frame.
interface RenderModel {
  markers: Marker[]
  digits: number
  hovered: string | null
  dragging: string | null
}

class PosPrimitive {
  private _series: ISeriesApi<'Candlestick'> | null = null
  private _ru: (() => void) | null = null
  private _get: () => RenderModel
  _pv: PosPaneView

  constructor(get: () => RenderModel) {
    this._get = get
    this._pv = new PosPaneView(this)
  }

  attached(p: { chart: IChartApi; series: ISeriesApi<'Candlestick'>; requestUpdate: () => void }) {
    this._series = p.series
    this._ru = p.requestUpdate
  }

  detached() {
    this._series = null
    this._ru = null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._pv]
  }

  updateAllViews() { /* no-op：渲染器每帧直接读实时状态 / renderer reads live state */ }

  // 持仓标记不参与价格轴自动缩放：与画线同理，一个远离行情的止损会把价格范围
  // 强行撑大、把 K 线压扁。/ Markers opt out of autoscale for the same reason
  // drawings do: a far-away SL would stretch the range and squash the candles.
  autoscaleInfo(_s: Logical, _e: Logical): AutoscaleInfo | null {
    return null
  }

  requestUpdate() {
    this._ru?.()
  }

  _render(ctx: CanvasRenderingContext2D, w: number) {
    const series = this._series
    if (!series) return
    const { markers, digits, hovered, dragging } = this._get()

    for (const m of markers) {
      this._line(ctx, w, series, m.entry, ENTRY_COLOR, entryLabel(m, digits), false, false)
      if (m.sl != null) {
        const k = keyOf(m.ticket, 'sl')
        this._line(ctx, w, series, m.sl, DOWN_COLOR, `SL ${m.sl.toFixed(digits)}`, hovered === k, dragging === k)
      }
      if (m.tp != null) {
        const k = keyOf(m.ticket, 'tp')
        this._line(ctx, w, series, m.tp, UP_COLOR, `TP ${m.tp.toFixed(digits)}`, hovered === k, dragging === k)
      }
    }
  }

  // 单条水平线 + 左侧价格标签（可拖动的线在悬停/拖拽时加粗并显示抓手点）
  // One horizontal line + a left-side label (draggable ones thicken and show a
  // grip while hovered/dragged).
  private _line(
    ctx: CanvasRenderingContext2D, w: number, series: ISeriesApi<'Candlestick'>,
    price: number, color: string, label: string, hovered: boolean, dragging: boolean,
  ) {
    const y = series.priceToCoordinate(price) as number | null
    if (y == null) return
    const active = hovered || dragging
    const draggable = color !== ENTRY_COLOR

    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = active ? 1 : 0.85
    ctx.lineWidth = active ? 2 : 1
    ctx.setLineDash(color === ENTRY_COLOR ? [2, 3] : [6, 4])
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    ctx.setLineDash([])

    // 标签：深底 + 同色描边文字，压在左侧，避开右侧价格轴的最新价气泡
    // Label: dark plate + same-color text, pinned left to clear the last-price
    // bubble on the right price axis.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(label).width
    const bx = 6, bh = 15, bw = tw + 10
    ctx.globalAlpha = 1
    ctx.fillStyle = 'rgba(10, 7, 16, 0.82)'
    ctx.fillRect(bx, y - bh / 2, bw, bh)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.globalAlpha = active ? 1 : 0.6
    ctx.strokeRect(bx, y - bh / 2, bw, bh)
    ctx.fillStyle = color
    ctx.globalAlpha = 1
    ctx.fillText(label, bx + 5, y + 0.5)

    // 抓手：只有可拖动的止损/止盈线画，提示"这条能拖"
    // Grip: only on draggable SL/TP lines, hinting that they can be dragged.
    if (draggable && active) {
      const gx = w - 16
      ctx.fillStyle = color
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(gx + i * 4, y - 4, 2, 8)
      }
    }
    ctx.restore()
  }
}

function entryLabel(m: Marker, digits: number): string {
  return `${m.pos.side === 'BUY' ? 'BUY' : 'SELL'} ${m.pos.volume.toFixed(2)} @ ${m.entry.toFixed(digits)}`
}

class PosPaneView implements IPrimitivePaneView {
  _renderer: PosRenderer
  constructor(prim: PosPrimitive) {
    this._renderer = new PosRenderer(prim)
  }
  renderer(): IPrimitivePaneRenderer | null {
    return this._renderer
  }
}

class PosRenderer implements IPrimitivePaneRenderer {
  private _prim: PosPrimitive
  constructor(prim: PosPrimitive) {
    this._prim = prim
  }
  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace((scope) => {
      this._prim._render(scope.context, scope.mediaSize.width)
    })
  }
}

// ──── 组件 / component ────
interface Props {
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  // 已按选中账户过滤好的持仓（ChartsPage 的 accountPositions）；本组件再按品种筛。
  // Positions already filtered by the selected account; filtered by symbol here.
  positions: Position[]
  symbol: string
  digits: number
  visible: boolean
  onToast: (msg: string, kind: 'success' | 'error' | 'info') => void
}

export default function PositionOverlay({ chart, series, positions, symbol, digits, visible, onToast }: Props) {
  const { t } = useTranslation()

  // 拖拽中的线与其当前价位（未提交），以及已提交待回执的乐观值。
  // The line being dragged plus its uncommitted price, and optimistic values
  // for modifies that are submitted but not yet reported back by the bridge.
  const dragRef = useRef<{ key: string; ticket: number; kind: LineKind; price: number } | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragPrice, setDragPrice] = useState<number | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, { price: number; at: number }>>({})

  // 拖拽松手后待确认的改单信息；确认框显示期间线停在拖到的位置，取消则弹回。
  // Pending confirm state after a drag is released; the line stays at the
  // dragged position while the dialog is open, reverting on cancel.
  type ConfirmState = {
    key: string
    ticket: number
    kind: LineKind
    newPrice: number
    marker: Marker
  }
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)

  // 品种匹配去掉券商后缀再比：持仓上报的可能是 XAUUSD.m 之类，而图表用的是基础
  // 品种名，直接全等会一条标记都匹配不上。改单请求仍然回传持仓自己的原始
  // p.symbol，绝不能把规整后的名字发给 MT5。
  // Compare symbols with the broker suffix stripped: a position may report
  // XAUUSD.m while the chart uses the base name, and a strict equality check
  // would match nothing. The modify request still sends the position's own raw
  // p.symbol — never the normalized name — back to MT5.
  const symPositions = useMemo(() => {
    const base = baseSymbol(symbol)
    return positions.filter((p) => baseSymbol(p.symbol) === base && p.ticket != null && p.entryPrice != null)
  }, [positions, symbol])

  // 标记列表：真实持仓叠加"已提交待回执"的乐观值 + 正在拖动的实时值 + 待确认的拖拽值。
  // Markers: real positions overlaid with in-flight optimistic values, the
  // live value of the line being dragged, and pending-confirm dragged values.
  const markers = useMemo<Marker[]>(() => {
    const now = Date.now()
    return symPositions.map((p) => {
      const ticket = p.ticket as number
      const pick = (kind: LineKind, real: number | undefined): number | null => {
        const k = keyOf(ticket, kind)
        // 正在拖动中 / being dragged
        if (dragKey === k && dragPrice != null) return dragPrice
        // 松手后等待确认 / released, awaiting confirmation
        if (confirmState && confirmState.key === k) return confirmState.newPrice
        const opt = pending[k]
        if (opt && now - opt.at < OVERRIDE_TTL_MS) return opt.price > 0 ? opt.price : null
        return real && real > 0 ? real : null
      }
      return {
        ticket,
        pos: p,
        entry: p.entryPrice as number,
        sl: pick('sl', p.stopLoss),
        tp: pick('tp', p.takeProfit),
      }
    })
  }, [symPositions, dragKey, dragPrice, pending, confirmState])

  // 桥接把新值报回来后清掉对应的乐观值（真实值已经追上，不再需要覆盖）。
  // Drop an optimistic value once the bridge reports a matching real one.
  useEffect(() => {
    setPending((prev) => {
      const keys = Object.keys(prev)
      if (keys.length === 0) return prev
      const now = Date.now()
      let changed = false
      const next: typeof prev = {}
      for (const k of keys) {
        const [ticketStr, kind] = k.split(':')
        const p = symPositions.find((x) => String(x.ticket) === ticketStr)
        const real = kind === 'sl' ? p?.stopLoss : p?.takeProfit
        const realNum = real && real > 0 ? real : 0
        const settled = p == null || Math.abs(realNum - prev[k].price) < 1e-9
        if (settled || now - prev[k].at >= OVERRIDE_TTL_MS) { changed = true; continue }
        next[k] = prev[k]
      }
      return changed ? next : prev
    })
  }, [symPositions])

  // primitive 每帧读这份快照 / the primitive reads this snapshot each frame
  const modelRef = useRef<RenderModel>({ markers, digits, hovered, dragging: dragKey })
  modelRef.current = { markers, digits, hovered, dragging: dragKey }

  const primRef = useRef<PosPrimitive | null>(null)

  // 挂载/卸载 primitive：只跟随 series 与显隐，内容变化靠 requestUpdate 重绘。
  // Attach/detach the primitive: tied only to the series and visibility;
  // content changes just requestUpdate.
  useEffect(() => {
    if (!visible) return
    const prim = new PosPrimitive(() => modelRef.current)
    primRef.current = prim
    series.attachPrimitive(prim as never)
    return () => {
      primRef.current = null
      // chart 已销毁时直接跳过：父组件的 cleanup 先跑 chart.remove()，此时 detach
      // 只会排出一帧在 disposed 对象上重绘的动作，见 isChartAlive()。
      // Skip entirely once the chart is gone: the parent's cleanup already ran
      // chart.remove(), so detaching would only schedule a repaint on a disposed
      // object. See isChartAlive().
      if (!isChartAlive(chart)) return
      try { series.detachPrimitive(prim as never) } catch { /* 已 detach / already detached */ }
    }
  }, [chart, series, visible])

  useEffect(() => {
    primRef.current?.requestUpdate()
  }, [markers, digits, hovered, dragKey])

  // ──── 命中判定 / hit testing ────
  const overlayRef = useRef<HTMLDivElement>(null)
  const markersRef = useRef<Marker[]>(markers)
  markersRef.current = markers

  // y 像素 → 命中的止损/止盈线（只有这两种可拖，开仓价线不可拖）。
  // y pixel → the SL/TP line under it (entry lines aren't draggable).
  const hitLine = useCallback((y: number) => {
    let best: { key: string; ticket: number; kind: LineKind; dist: number } | null = null
    for (const m of markersRef.current) {
      for (const kind of ['sl', 'tp'] as LineKind[]) {
        const price = kind === 'sl' ? m.sl : m.tp
        if (price == null) continue
        const ly = series.priceToCoordinate(price) as number | null
        if (ly == null) continue
        const dist = Math.abs(y - ly)
        if (dist <= TOL && (!best || dist < best.dist)) {
          best = { key: keyOf(m.ticket, kind), ticket: m.ticket, kind, dist }
        }
      }
    }
    return best
  }, [series])

  // 悬停时才把覆盖层切成 pointer-events:auto 去抢事件，其余时候让位给图表的
  // 拖动平移/滚轮缩放（DrawLayer 同一套做法，见其注释里记录的那个坑）。
  // Only capture pointer events while hovering a line; otherwise leave them to
  // the chart's own pan/zoom (same approach as DrawLayer, see its comment).
  useEffect(() => {
    if (!visible) return
    const el = overlayRef.current
    if (!el) return
    const onHover = (e: PointerEvent) => {
      if (dragRef.current) { el.style.pointerEvents = 'auto'; return }
      const r = el.getBoundingClientRect()
      const x = e.clientX - r.left, y = e.clientY - r.top
      if (x < 0 || y < 0 || x > r.width || y > r.height) {
        el.style.pointerEvents = 'none'
        setHovered(null)
        return
      }
      const h = hitLine(y)
      el.style.pointerEvents = h ? 'auto' : 'none'
      setHovered(h ? h.key : null)
    }
    window.addEventListener('pointermove', onHover, true)
    return () => window.removeEventListener('pointermove', onHover, true)
  }, [hitLine, visible])

  // 隐藏时清掉悬停态，免得再显示出来时还留着上次的高亮。
  // Clear hover state when hidden so re-showing doesn't keep a stale highlight.
  useEffect(() => {
    if (!visible) {
      setHovered(null)
      dragRef.current = null
      setDragKey(null)
      setDragPrice(null)
    }
  }, [visible])

  // ──── 拖拽改单 / drag to modify ────
  const submitModify = useCallback(async (m: Marker, sl: number, tp: number) => {
    try {
      await orderApi.modify({
        clientOrderId: clientOrderId(),
        ticket: m.ticket,
        symbol: m.pos.symbol,
        side: m.pos.side,
        mt5Login: m.pos.login ?? null,
        stopLoss: sl,
        takeProfit: tp,
      })
      onToast(String(t('charts.dock.modifySent')), 'info')
      return true
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : String(t('charts.dock.modifyFailed')), 'error')
      return false
    }
  }, [onToast, t])

  // 把 y 夹在主图 pane 内：覆盖层铺满整个容器，但价格坐标只在主图 pane 里有
  // 意义——开了副图（成交量/RSI/MACD）时往下拖会越过主图底边，
  // coordinateToPrice 在那之外是线性外推，会算出离谱的价位。
  // Clamp y into the main pane: the overlay covers the whole container, but
  // price coordinates only make sense inside the main pane — with sub-panes
  // (volume/RSI/MACD) enabled, dragging past its bottom edge would have
  // coordinateToPrice linearly extrapolate into nonsense.
  const clampY = useCallback((y: number) => {
    const panes = chart.panes()
    const h = panes[0]?.getHeight?.() ?? 0
    if (h <= 0) return y
    return Math.max(0, Math.min(y, h))
  }, [chart])

  const onDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const el = overlayRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const y = e.clientY - r.top
    const h = hitLine(y)
    if (!h) return
    const price = series.coordinateToPrice(y) as number | null
    if (price == null) return
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    dragRef.current = { key: h.key, ticket: h.ticket, kind: h.kind, price }
    setDragKey(h.key)
    setDragPrice(price)
    // 拖线期间关掉图表自身的拖动平移，否则同一次按压会连带把图表也拖走。
    // Disable the chart's own drag-pan while dragging a line, otherwise the
    // same press would pan the chart along with it.
    chart.applyOptions({ handleScroll: { pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false } })
  }, [chart, hitLine, series])

  const onMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const el = overlayRef.current
    if (!el) return
    const y = clampY(e.clientY - el.getBoundingClientRect().top)
    const price = series.coordinateToPrice(y) as number | null
    if (price == null) return
    drag.price = price
    setDragPrice(price)
  }, [clampY, series])

  const onUp = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (overlayRef.current?.hasPointerCapture?.(e.pointerId)) {
      overlayRef.current.releasePointerCapture(e.pointerId)
    }
    chart.applyOptions({ handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } })
    setDragKey(null)
    setDragPrice(null)
    if (!drag) return

    const m = markersRef.current.find((x) => x.ticket === drag.ticket)
    if (!m) return
    // 按品种精度取整：拖出来的价格是任意小数，直接发过去 MT5 也会自己截断，
    // 不如前端先规整，让线的落点和提示里的数字一致。
    // Round to the symbol's precision: a dragged price is an arbitrary float
    // that MT5 would truncate anyway; normalizing up front keeps the line and
    // the toast in agreement.
    const factor = Math.pow(10, digits)
    const next = Math.round(drag.price * factor) / factor
    // 对比原始持仓的止损/止盈（而非标记覆盖后的值——拖拽过程中 pick() 已经把
    // 标记值换成了拖拽位置，拿 m.sl/m.tp 比 next 永远是同一个价，会被当成
    // "没有实质性变动"而静默跳过，于是线弹回去、确认框不弹）。
    // Compare against the position's raw SL/TP (NOT the marker value — during a
    // drag, pick() overrides the marker with the dragged price, so comparing
    // m.sl/m.tp against next always sees the same price and silently skips the
    // confirm dialog as "no meaningful change", snapping the line back).
    const rawSl = m.pos.stopLoss
    const rawTp = m.pos.takeProfit
    const orig = drag.kind === 'sl' ? (rawSl && rawSl > 0 ? rawSl : null) : (rawTp && rawTp > 0 ? rawTp : null)
    if (next <= 0 || (orig != null && Math.abs(next - orig) < 1 / factor / 2)) return

    // 方向校验：与底部持仓面板同一套规则（买单止损须低于现价、止盈须高于现价）。
    // Direction check: same rule as the positions dock.
    const ref = m.pos.currentPrice
    const isBuy = m.pos.side === 'BUY'
    if (ref != null && ref > 0) {
      const wrong = drag.kind === 'sl'
        ? (isBuy ? next >= ref : next <= ref)
        : (isBuy ? next <= ref : next >= ref)
      if (wrong) {
        onToast(String(t('charts.dock.slTpWrong')), 'error')
        return
      }
    }

    // 弹出确认框而非直接发送 —— 避免误拖 / show confirm dialog instead of sending immediately
    setConfirmState({ key: drag.key, ticket: drag.ticket, kind: drag.kind, newPrice: next, marker: m })
  }, [chart, digits, onToast, t])

  // 用户确认改单 / user confirms the modify
  const handleConfirm = useCallback(async () => {
    const cs = confirmState
    if (!cs) return
    const m = cs.marker
    const sl = cs.kind === 'sl' ? cs.newPrice : (m.sl ?? 0)
    const tp = cs.kind === 'tp' ? cs.newPrice : (m.tp ?? 0)
    setPending((prev) => ({ ...prev, [cs.key]: { price: cs.newPrice, at: Date.now() } }))
    setConfirmState(null)
    const ok = await submitModify(m, sl, tp)
    if (!ok) {
      setPending((prev) => {
        const next2 = { ...prev }
        delete next2[cs.key]
        return next2
      })
    }
  }, [confirmState, submitModify])

  // 用户取消改单 —— 线弹回真实价位（confirmState 一清，markers 就走回真实值）
  // User cancels — line snaps back to the truth (clearing confirmState lets
  // markers fall back to the real value).
  const handleCancelConfirm = useCallback(() => {
    setConfirmState(null)
  }, [])

  // 确认框显示期间按 Escape 等同于取消 / Escape cancels the confirm dialog
  useEffect(() => {
    if (!confirmState) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmState(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmState])

  // 确认框里用的品种名：去后缀 / symbol name for the confirm dialog, suffix stripped
  const displaySymbol = useMemo(() => {
    if (!confirmState) return ''
    return baseSymbol(confirmState.marker.pos.symbol)
  }, [confirmState])
  const oldPrice = confirmState
    ? (confirmState.kind === 'sl' ? confirmState.marker.sl : confirmState.marker.tp)
    : null

  // 提前返回必须放在所有 Hook 之后：父组件用 visible 属性切换显示而不是条件挂载，
  // 若在 useMemo 之前返回，visible 翻转时 Hook 数量会变，React 直接报错。
  // The early return has to come after every Hook: the parent toggles `visible`
  // as a prop rather than mounting conditionally, so returning above the useMemo
  // changes the Hook count between renders and React throws.
  if (!visible) return null

  return (
    <>
      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-0 z-10 touch-none"
        style={{ cursor: hovered || dragKey || confirmState ? 'ns-resize' : 'default' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />

      {/* 拖拽松手后的确认弹窗 / confirmation dialog after releasing a dragged line */}
      {confirmState && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-transparent">
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className="pointer-events-auto rounded-xl border border-white/10 bg-ink-900/95 p-4 shadow-prism backdrop-blur-md"
            style={{ minWidth: 280 }}
            onKeyDown={(e) => { if (e.key === 'Escape') handleCancelConfirm() }}
          >
            <p className="mb-1 text-xs font-medium text-neutral-300">
              {String(t('charts.posmark.confirmModifyTitle'))}
            </p>
            <p className="mb-3 text-sm text-neutral-200">
              {String(t('charts.posmark.confirmModifyMsg', {
                symbol: displaySymbol,
                side: confirmState.marker.pos.side === 'BUY' ? String(t('charts.dock.buy')) : String(t('charts.dock.sell')),
                ticket: String(confirmState.ticket),
                kind: confirmState.kind === 'sl' ? String(t('charts.ticket.sl')) : String(t('charts.ticket.tp')),
                from: oldPrice != null ? oldPrice.toFixed(digits) : '—',
                to: confirmState.newPrice.toFixed(digits),
              }))}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelConfirm}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-400 transition hover:border-white/20 hover:text-neutral-100"
              >
                {String(t('charts.posmark.cancel'))}
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="rounded-lg bg-prism-600/60 px-3 py-1.5 text-xs font-medium text-prism-100 transition hover:bg-prism-500/60"
              >
                {String(t('charts.posmark.confirm'))}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
