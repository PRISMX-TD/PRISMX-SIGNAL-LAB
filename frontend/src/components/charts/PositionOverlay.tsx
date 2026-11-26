// 图表订单标记层：把当前选中账户在本品种上的**持仓**与**挂单**画到主图上——
// 各自的入场价、止损、止盈各一条线（带价格标签）。持仓的止损/止盈线可以直接拖动
// 改单，挂单的触发价 / 止损 / 止盈三条线同样能拖；松手先弹确认，确认后才发指令。
// 挂单用另一套颜色 + 点线画（见 PENDING_*），因为它们说的是「还没发生的事」。
//
// 阶段 3（图表交易，2026-11-25）加的：
// - 持仓线标签带浮动盈亏（金额 / 点数 / 占余额 %），止损止盈线标签带「到价时盈亏」；
// - 标签上的按钮：平仓（可部分）、反手、保本、拖出止盈 / 止损、去掉止盈 / 止损、撤挂单；
// - 拖线时显示读数：价格、点数、金额、占余额百分比；
// - 图上投影单（scope 'draft'）：右键 / 「+」按钮 / 多空仓位工具发起的一张未提交挂单，
//   三条线同样可拖，右上角浮动面板里提交；
// - 手机：按钮点一下即可；拖出止盈止损改成「点出一条线、再拖」；确认一律滑动。
//
// Order markers layer: the selected account's positions **and pending orders** for the
// current symbol — entry / SL / TP lines with labels. Position SL/TP and all three pending
// lines can be dragged; releasing asks for confirmation before anything is sent. Pending
// orders get their own colours and a dotted stroke, being things that have not happened yet.
//
// Phase 3 (chart trading, 2026-11-25) adds: floating P/L on position labels (money / points /
// % of balance) and the P/L-at-level on SL/TP labels; label buttons for close (partial),
// reverse, breakeven, drag-out TP / SL, remove TP / SL and cancel; a live readout while
// dragging (price, points, money, % of balance); the projected order (scope 'draft') started
// from the context menu, the "+" button or a long/short drawing, whose lines drag the same
// way and which is submitted from a floating panel; and on phones, tap buttons, tap-out legs
// that are then dragged, and slide-to-confirm everywhere.
//
// 渲染走 lightweight-charts 的 ISeriesPrimitive（与 DrawLayer 一致）；命中与拖拽用一层默认
// pointer-events:none 的透明覆盖层，只有真的悬停到某条线或某个按钮上时才抢指针事件——否则
// 原生的拖动平移与滚轮缩放永远传不到底下的图表 canvas（DrawLayer 踩过这个坑）。
// Rendering is an ISeriesPrimitive (as DrawLayer); hit-testing uses a transparent overlay that
// is pointer-events:none until a line or button is actually hovered, or the chart's own pan
// and wheel zoom would never reach the canvas underneath (a pit DrawLayer fell into).
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  IChartApi, IPrimitivePaneView, IPrimitivePaneRenderer,
  AutoscaleInfo, Logical, HandleScrollOptions, MouseEventParams,
} from 'lightweight-charts'
import type { MainSeriesApi } from './useChartEngine'
import type { PendingOrder, Position } from '../../api/types'
import { baseSymbol, lotDecimals, localizeApiError } from '../../api/utils'
import { checkPendingPrice, checkSlTp, defaultVolume, slTooClose, type SymbolSpec } from '../order/orderMath'
import SlideToConfirm from '../order/SlideToConfirm'
import { isChartAlive } from './chartLifecycle'
import { DRAG_LOCK_SCROLL, scrollAfterDrag } from './chartConfig'
import { DOWN_COLOR, UP_COLOR } from './canvasColors'
import type { TradingPrefs } from './chartPrefs'
import { EMPTY } from '../../utils/format'
import { useLastVolume } from '../../utils/useLastVolume'
import { autoEntryType, canBreakeven, fmtSigned, moveReadout, pointSize, stagedLegPrice } from './trade/tradeMath'
import { useTradeActions, type ChartPlace } from './trade/useTradeActions'
import DraftTicket, { type Draft } from './trade/DraftTicket'
import ClosePopover from './trade/ClosePopover'
import { useBackToClose } from '../../utils/useBackToClose'

// 触摸屏放宽命中容差（手指没有像素级精度）/ looser hit tolerance on touch screens
const isTouchDevice = typeof window !== 'undefined'
  && (window.matchMedia?.('(pointer: coarse)').matches ?? false)
const TOL = isTouchDevice ? 14 : 6
// 按钮的命中外扩：手指按不准，鼠标也给 2px 余量 / button hit padding
const BTN_PAD = isTouchDevice ? 6 : 2

// 起拖阈值：按下后竖向走出这么远才算拖。没有它，单击一下线、或平移时从线附近起手，
// 松手价已经偏了几个像素，就会弹出一个用户没选过价的改单确认。
// Drag threshold: without it a click on a line, or a pan starting near one, ends a few
// pixels off and pops a modify confirm with a price nobody chose.
const DRAG_SLOP_MOUSE = 4
const DRAG_SLOP_TOUCH = 8

// 触摸、以及粗指针设备上的笔，都没有「悬停」，改走「点一下选中」。
// Touch, and a pen on a coarse-pointer device, have no hover; they use tap-to-select.
const isTouchLike = (pointerType: string) => pointerType === 'touch' || (pointerType === 'pen' && isTouchDevice)

// 入场线青色是这一层独有的；涨跌色来自 canvasColors（tokens.css 的 --up-canvas / --down-canvas）。
// The cyan entry colour is local to this layer; up/down come from canvasColors.
const ENTRY_COLOR = '#22d3ee'
// 挂单：触发价琥珀色，止损止盈保持红 / 绿色相但调浅——「浅一档 + 点线」就是「还没生效」。
// Pending: amber trigger, lighter tints of red / green for SL / TP.
const PENDING_COLOR = '#f5a524'
const PENDING_DOWN_COLOR = '#ff9db0'
const PENDING_UP_COLOR = '#8fe3b4'
// 投影单：品牌紫，和真单一眼分开 / projected order: brand violet, unmistakable against real ones
const DRAFT_COLOR = '#a78bfa'

// 持仓长虚线、挂单点线、投影单短虚线：颜色之外再给一个形状上的差别（色觉障碍、压缩过的截图）。
// Positions dash, pending dot, drafts short-dash: a non-colour channel as well.
const DASH_ENTRY = [2, 3]
const DASH_LEVEL = [6, 4]
const DASH_PENDING = [2, 4]
const DASH_DRAFT = [4, 3]

// 已被占用的矩形：本帧已画出的标签，以及主图指标图例（真实上下边界，图例会换行）。
// An occupied rect: labels drawn this frame, plus the main indicator legend (real bounds).
interface LabelBox { x: number; w: number; top: number; bottom: number }

function measureLegendBox(host: HTMLElement, el: HTMLElement): LabelBox | null {
  const hr = host.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  return { x: r.left - hr.left - 4, w: r.width + 8, top: r.top - hr.top - 4, bottom: r.bottom - hr.top + 4 }
}

const LABEL_H = 16
const LABEL_X0 = 6
const BTN_W = 17
// 靠左时右边留给价格轴的最新价气泡；靠右时离右边缘留一点空。
// Left-aligned labels keep clear of the last-price bubble; right-aligned ones keep a margin.
const LABEL_RIGHT_GUARD = 70
const LABEL_RIGHT_MARGIN = 10

/**
 * 给标签找一个不与本帧已画标签重叠的横向位置：靠左时从最左往右跳，靠右时从最右往左跳，
 * 实在放不下就原地压着画（叠一下总好过推到价格轴上或推出画布）。
 * Find a horizontal slot that does not overlap the labels already drawn: hop right from
 * the left edge, or left from the right edge; with no room, fall back to the first slot.
 */
function placeLabel(taken: LabelBox[], top: number, bottom: number, w: number, bw: number, align: 'left' | 'right'): number {
  const first = align === 'left' ? LABEL_X0 : Math.max(LABEL_X0, w - LABEL_RIGHT_MARGIN - bw)
  const hitAt = (x: number) => taken.find((b) => top < b.bottom && bottom > b.top && x < b.x + b.w && x + bw > b.x)
  let x = first
  for (let i = 0; i < 8; i++) {
    const hit = hitAt(x)
    if (!hit) return x
    const next = align === 'left' ? hit.x + hit.w + 4 : hit.x - 4 - bw
    if (align === 'left' ? next + bw > w - LABEL_RIGHT_GUARD : next < LABEL_X0) break
    x = next
  }
  // 这一侧跳不开（窄屏常见）：试试另一头，还不行才压着画。
  // No room on this side (common on narrow panes): try the far edge, else overlap at the first slot.
  const far = align === 'left' ? Math.max(LABEL_X0, w - LABEL_RIGHT_GUARD - bw) : LABEL_X0
  return hitAt(far) ? first : far
}

// 窄图（手机竖屏）上标签去掉价格部分，线本身就在那个价位上；省下的宽度让几条挨着的线不叠在一起。
// On narrow panes (phones) labels drop the price: the line sits at it anyway, and the saved
// width keeps neighbouring labels apart.
const COMPACT_W = 560
const compactLabel = (s: string) => s.replace(/ @ \S+$/, '').replace(/^(SL|TP) \S+$/, '$1')

// 改单指令已发出、桥接还没报回新值的这段时间里先按拖到的值显示，免得线弹回旧价位像没生效。
// While a modify is in flight keep showing the dragged value so the line does not snap back.
const OVERRIDE_TTL_MS = 60_000

// 'price' 只属于挂单与投影单（触发价）；持仓的入场价是既成事实，改不了。
// 'price' belongs to pending orders and drafts only; a position's entry already happened.
type LineKind = 'sl' | 'tp' | 'price'
// 键里带上类别：持仓票号与挂单票号来自 MT5 不同的编号空间，可能撞号。投影单票号恒为 0。
// The key carries the family: position and order tickets can collide. Drafts use ticket 0.
type LineScope = 'pos' | 'ord' | 'draft'

interface LineHit { key: string; scope: LineScope; ticket: number; kind: LineKind; dist: number; price: number }

interface Marker { ticket: number; pos: Position; entry: number; sl: number | null; tp: number | null }
interface PendingMarker { ticket: number; label: string; order: PendingOrder; price: number; sl: number | null; tp: number | null }

const keyOf = (scope: LineScope, ticket: number, kind: LineKind) => `${scope}:${ticket}:${kind}`
function parseKey(key: string): { scope: LineScope; ticket: number; kind: LineKind } {
  const [scope, ticket, kind] = key.split(':')
  return { scope: scope as LineScope, ticket: Number(ticket), kind: kind as LineKind }
}

// ── 画法规格：组件把每条线算好交给 primitive，primitive 只管画 ──
// Paint specs: the component resolves each line, the primitive only paints.
type Glyph = 'close' | 'rev' | 'be' | 'tp' | 'sl' | 'x' | 'ok'
interface BtnSpec { id: string; glyph: Glyph; tip: string }
interface LineSpec {
  /** 可拖的线才有 / draggable lines only */
  key: string | null
  price: number
  color: string
  dash: number[]
  label: string
  extra: { text: string; color: string } | null
  buttons: BtnSpec[]
}
interface BtnHit { id: string; tip: string; x: number; y: number; w: number; h: number }
interface Readout { price: number; text: string; color: string }

interface RenderModel {
  lines: LineSpec[]
  hovered: string | null
  hoveredBtn: string | null
  dragging: string | null
  readout: Readout | null
  align: 'left' | 'right'
  legendBox: () => LabelBox | null
}

const FONT = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
const FONT_BTN = 'bold 8px ui-monospace, SFMono-Regular, Menlo, monospace'

function drawGlyph(ctx: CanvasRenderingContext2D, g: Glyph, cx: number, cy: number, color: string) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.4
  ctx.lineCap = 'round'
  ctx.beginPath()
  switch (g) {
    case 'close': case 'x':
      ctx.moveTo(cx - 3, cy - 3); ctx.lineTo(cx + 3, cy + 3)
      ctx.moveTo(cx + 3, cy - 3); ctx.lineTo(cx - 3, cy + 3)
      ctx.stroke()
      break
    case 'ok':
      ctx.moveTo(cx - 3.5, cy); ctx.lineTo(cx - 1, cy + 2.5); ctx.lineTo(cx + 3.5, cy - 2.5)
      ctx.stroke()
      break
    case 'rev':
      ctx.moveTo(cx - 2.5, cy + 4); ctx.lineTo(cx - 2.5, cy - 4)
      ctx.moveTo(cx - 5, cy - 1.5); ctx.lineTo(cx - 2.5, cy - 4); ctx.lineTo(cx, cy - 1.5)
      ctx.moveTo(cx + 2.5, cy - 4); ctx.lineTo(cx + 2.5, cy + 4)
      ctx.moveTo(cx, cy + 1.5); ctx.lineTo(cx + 2.5, cy + 4); ctx.lineTo(cx + 5, cy + 1.5)
      ctx.stroke()
      break
    default:
      ctx.font = FONT_BTN
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(g === 'be' ? 'BE' : g === 'tp' ? 'TP' : 'SL', cx, cy + 0.5)
  }
  ctx.restore()
}

class PosPrimitive {
  private _series: MainSeriesApi | null = null
  private _ru: (() => void) | null = null
  private _get: () => RenderModel
  _pv: PosPaneView
  /** 本帧画出的按钮位置，命中判定直接读 / button rects painted this frame, read by hit-testing */
  hits: BtnHit[] = []

  constructor(get: () => RenderModel) {
    this._get = get
    this._pv = new PosPaneView(this)
  }

  attached(p: { chart: IChartApi; series: MainSeriesApi; requestUpdate: () => void }) {
    this._series = p.series
    this._ru = p.requestUpdate
  }

  detached() {
    this._series = null
    this._ru = null
  }

  paneViews(): readonly IPrimitivePaneView[] { return [this._pv] }
  updateAllViews() { /* 渲染器每帧直接读实时状态 / renderer reads live state */ }
  // 不参与价格轴自动缩放：远处的止损会把价格范围撑大、把 K 线压扁。
  // Opt out of autoscale: a far-away SL would stretch the range and squash the candles.
  autoscaleInfo(_s: Logical, _e: Logical): AutoscaleInfo | null { return null }
  requestUpdate() { this._ru?.() }

  _render(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const series = this._series
    if (!series) return
    const m = this._get()
    const hits: BtnHit[] = []
    const taken: LabelBox[] = []
    const legend = m.legendBox()
    if (legend) taken.push(legend)
    for (const spec of m.lines) {
      const k = spec.key
      this._line(ctx, w, h, series, spec, k != null && m.hovered === k, k != null && m.dragging === k, m.hoveredBtn, taken, m.align, hits)
    }
    if (m.readout) this._readout(ctx, w, h, series, m.readout)
    this.hits = hits
  }

  private _line(
    ctx: CanvasRenderingContext2D, w: number, h: number, series: MainSeriesApi, spec: LineSpec,
    hovered: boolean, dragging: boolean, hoveredBtn: string | null, taken: LabelBox[], align: 'left' | 'right', hits: BtnHit[],
  ) {
    const y = series.priceToCoordinate(spec.price) as number | null
    if (y == null) return
    // 可见区间之外整条不画：线会被裁掉，标签牌却会卡在顶 / 底边上留半截碎片。
    // Outside the visible range: skip entirely, or a half-cut label plate sticks to the edge.
    if (y < 0 || y > h) return
    const active = hovered || dragging
    ctx.save()
    ctx.strokeStyle = spec.color
    ctx.globalAlpha = active ? 1 : 0.85
    ctx.lineWidth = active ? 2 : 1
    ctx.setLineDash(spec.dash)
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.font = FONT
    ctx.textBaseline = 'middle'
    const label = w < COMPACT_W ? compactLabel(spec.label) : spec.label
    const tw = ctx.measureText(label).width
    const ew = spec.extra ? ctx.measureText(spec.extra.text).width : 0
    const textW = 5 + tw + (spec.extra ? 8 + ew : 0) + 5
    const bh = LABEL_H, bw = textW + spec.buttons.length * BTN_W
    const top = y - bh / 2
    const bx = placeLabel(taken, top, top + bh, w, bw, align)
    taken.push({ x: bx, w: bw, top, bottom: top + bh })
    ctx.globalAlpha = 1
    ctx.fillStyle = 'rgba(9, 9, 11, 0.86)'
    ctx.fillRect(bx, top, bw, bh)
    ctx.fillStyle = spec.color
    ctx.fillText(label, bx + 5, y + 0.5)
    if (spec.extra) {
      ctx.fillStyle = spec.extra.color
      ctx.fillText(spec.extra.text, bx + 5 + tw + 8, y + 0.5)
    }
    spec.buttons.forEach((b, i) => {
      const x0 = bx + textW + i * BTN_W
      if (hoveredBtn === b.id) {
        ctx.fillStyle = spec.color
        ctx.globalAlpha = 0.22
        ctx.fillRect(x0, top, BTN_W, bh)
        ctx.globalAlpha = 1
      }
      ctx.strokeStyle = spec.color
      ctx.globalAlpha = 0.35
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x0 + 0.5, top + 2)
      ctx.lineTo(x0 + 0.5, top + bh - 2)
      ctx.stroke()
      ctx.globalAlpha = 1
      drawGlyph(ctx, b.glyph, x0 + BTN_W / 2 + 0.5, y, b.glyph === 'close' || b.glyph === 'x' ? '#e4e4e7' : spec.color)
      hits.push({ id: b.id, tip: b.tip, x: x0, y: top, w: BTN_W, h: bh })
    })
    ctx.strokeStyle = spec.color
    ctx.lineWidth = 1
    ctx.globalAlpha = active ? 1 : 0.6
    ctx.strokeRect(bx + 0.5, top + 0.5, bw - 1, bh - 1)

    // 抓手：可拖的线悬停 / 拖动时画在标签对侧，提示「这条能拖」
    // Grip on the side opposite the label while a draggable line is hovered / dragged.
    if (spec.key && active) {
      const gx = align === 'right' ? 10 : w - 16
      ctx.globalAlpha = 1
      ctx.fillStyle = spec.color
      for (let i = 0; i < 3; i++) ctx.fillRect(gx + i * 4, y - 4, 2, 8)
    }
    ctx.restore()
  }

  // 拖动读数：画在线上方居中，顶到边上就翻到下方。/ Drag readout above the line, flipped below near the top.
  private _readout(ctx: CanvasRenderingContext2D, w: number, h: number, series: MainSeriesApi, r: Readout) {
    const y = series.priceToCoordinate(r.price) as number | null
    if (y == null || y < 0 || y > h) return
    ctx.save()
    ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(r.text).width
    const bw = tw + 14, bh = 20
    const bx = Math.max(6, Math.min(w / 2 - bw / 2, w - bw - 6))
    const by = y - bh - 8 < 4 ? y + 8 : y - bh - 8
    ctx.fillStyle = 'rgba(9, 9, 11, 0.92)'
    ctx.fillRect(bx, by, bw, bh)
    ctx.strokeStyle = r.color
    ctx.lineWidth = 1
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1)
    ctx.fillStyle = r.color
    ctx.fillText(r.text, bx + 7, by + bh / 2 + 0.5)
    ctx.restore()
  }
}

class PosPaneView implements IPrimitivePaneView {
  _renderer: PosRenderer
  constructor(prim: PosPrimitive) { this._renderer = new PosRenderer(prim) }
  renderer(): IPrimitivePaneRenderer | null { return this._renderer }
}

class PosRenderer implements IPrimitivePaneRenderer {
  private _prim: PosPrimitive
  constructor(prim: PosPrimitive) { this._prim = prim }
  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace((scope) => {
      this._prim._render(scope.context, scope.mediaSize.width, scope.mediaSize.height)
    })
  }
}

/** 图上发起投影单的请求：nonce 变了就开一张新的。/ A request to open a projected order (new nonce = new draft). */
export interface DraftRequest { nonce: number; side: 'BUY' | 'SELL'; price: number; sl?: number | null; tp?: number | null }

// 通用确认：反手、保本、去掉止损止盈、撤挂单、拖线改单都走这里。
// A generic confirm used by reverse, breakeven, removing a leg, cancelling, and drag modifies.
interface ConfirmState {
  /** 拖线改单时那条线的键（确认框开着期间线停在新位置）/ the dragged line's key, held while open */
  key: string | null
  newPrice: number | null
  title: string
  message: string
  run: () => Promise<unknown> | void
}

// ──── 组件 / component ────
interface Props {
  chart: IChartApi
  series: MainSeriesApi
  // 已按选中账户过滤好的持仓 / 挂单（ChartsPage 的 LiveOverlay）；本组件再按品种筛。
  // Positions / pending orders already scoped to the selected account; filtered by symbol here.
  positions: Position[]
  pendingOrders: PendingOrder[]
  symbol: string
  // 展示用小数位（拿不到精度时是兜底的 2 位）/ display precision (2 when unknown)
  digits: number
  // 券商权威精度；null = 真的不知道。只有它非空时才允许对要发给 MT5 的价格取整——
  // 按猜的位数取整会把止损实打实地挪走（AUDUSD 按 2 位取整 = 偏 43 个点）。
  // The broker's precision; null means unknown. Only then may a price for MT5 be rounded.
  exactDigits: number | null
  // 参考价（图表最新收盘价），只用于本地校验；null 交给网关判。
  // Reference price (latest close) for local checks only; null defers to the gateway.
  refPrice?: number | null
  visible: boolean
  onToast: (msg: string, kind: 'success' | 'error' | 'info') => void
  trading: TradingPrefs
  // 下单账户的合约规格、余额、币种：拖动读数与盈亏换算用 / spec, balance and currency for readouts
  spec?: SymbolSpec
  balance?: number | null
  currency?: string
  // 投影单与反手用的下单账户（在线的那个）/ the (online) account drafts and reverse orders go to
  login: string | null
  // 读一眼当前买卖价（不订阅）/ read the current bid / ask without subscribing
  quote: () => { bid: number | null; ask: number | null }
  onPlace?: ChartPlace
  draftRequest?: DraftRequest | null
}

export default function PositionOverlay({
  chart, series, positions, pendingOrders, symbol, digits, exactDigits, refPrice, visible, onToast,
  trading, spec, balance = null, currency = '', login, quote, onPlace, draftRequest,
}: Props) {
  const { t } = useTranslation()
  const tt = useCallback((k: string, o?: Record<string, unknown>) => String(t(k, o)), [t])
  const actions = useTradeActions(onToast, onPlace)
  const { lastVolume, rememberVolume } = useLastVolume()

  // 拖拽中的线：grab = 线相对按下点的像素差（线不会跳到手指下）；startY / slop / active =
  // 过了起拖阈值才算真拖；pointerId = 只认按下的那根手指；fromBtn = 从标签按钮上拖出来的。
  // The line being dragged: grab keeps it from jumping under the finger, slop/active gate a
  // real drag, pointerId pins the pointer, fromBtn marks a drag-out from a label button.
  const dragRef = useRef<{ key: string; scope: LineScope; ticket: number; kind: LineKind; price: number; grab: number; startY: number; slop: number; active: boolean; pointerId: number; fromBtn: string | null } | null>(null)
  const scrollBeforeDragRef = useRef<HandleScrollOptions | boolean | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragPrice, setDragPrice] = useState<number | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [hoveredBtn, setHoveredBtn] = useState<{ id: string; tip: string; x: number; y: number } | null>(null)
  const pressedBtnRef = useRef<string | null>(null)
  const touchSelRef = useRef<string | null>(null)
  const lastTouchRef = useRef(false)
  // 已提交待回执的乐观值 / optimistic values for submitted modifies
  const [pending, setPending] = useState<Record<string, { price: number; at: number }>>({})
  // 点出来、还没确认的止盈止损线（手机的拖出方式，桌面单击按钮也是它）
  // Tapped-out, not yet confirmed SL/TP lines (the phone's drag-out, also a desktop click)
  const [staged, setStaged] = useState<Record<string, number>>({})
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [closePop, setClosePop] = useState<{ ticket: number; x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [draftBusy, setDraftBusy] = useState(false)
  // 返回手势收掉确认框 / 平仓比例弹层 / 投影单 / back closes the confirm, the close-ratio popover and the draft
  useBackToClose(confirmState != null && !confirmBusy, () => setConfirmState(null))
  useBackToClose(closePop != null, () => setClosePop(null))
  useBackToClose(draft != null && !draftBusy, () => setDraft(null))

  // 投影单请求：nonce 变了就按它开一张新的（手数取上次用过的）。
  // A projected-order request: a new nonce opens a new draft (volume = the last one used).
  const lastNonce = useRef<number | null>(null)
  useEffect(() => {
    if (!draftRequest || draftRequest.nonce === lastNonce.current) return
    lastNonce.current = draftRequest.nonce
    setDraft({
      side: draftRequest.side,
      price: draftRequest.price,
      sl: draftRequest.sl ?? null,
      tp: draftRequest.tp ?? null,
      volume: defaultVolume(lastVolume, symbol),
    })
  }, [draftRequest, lastVolume, symbol])
  // 换品种时投影单作废（它的价位属于上一个品种）/ a symbol switch voids the draft
  useEffect(() => { setDraft(null); setStaged({}); setClosePop(null) }, [symbol])

  // 品种匹配去掉券商后缀再比（持仓可能报 XAUUSD.m）；改单仍回传持仓自己的原始 symbol。
  // Compare symbols without the broker suffix; modifies still send the position's raw symbol.
  const symPositions = useMemo(() => {
    const base = baseSymbol(symbol)
    return positions.filter((p) => baseSymbol(p.symbol) === base && p.ticket != null && p.entryPrice != null)
  }, [positions, symbol])
  // 确认框里的动作在「按下确认」那一刻读最新持仓（用户可能盯着确认框几十秒，其间桥接推过新的
  // 止损止盈），所以经 ref 读，不用打开确认框那一刻的快照。
  // Confirm actions read the latest positions at the moment Confirm is pressed (the dialog can
  // sit open while the bridge reports new SL/TP), hence a ref rather than the opening snapshot.
  const symPositionsRef = useRef(symPositions)
  symPositionsRef.current = symPositions

  // 一条线此刻该显示的价：拖动中 > 确认中 > 点出来待确认 > 已提交待回执 > 真实值。
  // A line's displayed price: dragging > confirming > staged > in-flight > reported.
  const pickFor = useCallback((k: string, real: number | null | undefined, now: number): number | null => {
    if (dragKey === k && dragPrice != null) return dragPrice
    if (confirmState && confirmState.key === k && confirmState.newPrice != null) return confirmState.newPrice
    if (staged[k] != null) return staged[k]
    const opt = pending[k]
    if (opt && now - opt.at < OVERRIDE_TTL_MS) return opt.price > 0 ? opt.price : null
    return real && real > 0 ? real : null
  }, [dragKey, dragPrice, confirmState, staged, pending])

  const symPending = useMemo<PendingMarker[]>(() => {
    if (!trading.pending) return []
    const base = baseSymbol(symbol)
    const now = Date.now()
    return pendingOrders
      .filter((o) => baseSymbol(o.symbol) === base && o.price > 0)
      .map((o) => {
        const price = pickFor(keyOf('ord', o.ticket, 'price'), o.price, now) ?? o.price
        return {
          ticket: o.ticket,
          order: o,
          // 直接写 MT5 的类型名（BUY LIMIT…）：交易员的通用语，也和底部「挂单」页签对得上。
          // MT5's own type names: the trader's lingua franca, consistent with the dock.
          label: `${o.type.replace('_', ' ')} ${o.volume.toFixed(2)} @ ${price.toFixed(digits)}`,
          price,
          sl: pickFor(keyOf('ord', o.ticket, 'sl'), o.stopLoss, now),
          tp: pickFor(keyOf('ord', o.ticket, 'tp'), o.takeProfit, now),
        }
      })
  }, [pendingOrders, symbol, digits, pickFor, trading.pending])

  const markers = useMemo<Marker[]>(() => {
    const now = Date.now()
    return symPositions.map((p) => {
      const ticket = p.ticket as number
      return {
        ticket,
        pos: p,
        entry: p.entryPrice as number,
        sl: pickFor(keyOf('pos', ticket, 'sl'), p.stopLoss, now),
        tp: pickFor(keyOf('pos', ticket, 'tp'), p.takeProfit, now),
      }
    })
  }, [symPositions, pickFor])

  // 投影单三条线的显示值：拖动中的那条用拖到的价。/ The draft's displayed values, the dragged one live.
  const draftView = useMemo(() => {
    if (!draft) return null
    const live = (kind: LineKind, v: number | null) => (dragKey === keyOf('draft', 0, kind) && dragPrice != null ? dragPrice : v)
    return { ...draft, price: live('price', draft.price) ?? draft.price, sl: live('sl', draft.sl), tp: live('tp', draft.tp) }
  }, [draft, dragKey, dragPrice])

  // 桥接把新值报回来后清掉对应的乐观值。/ Drop an optimistic value once the real one catches up.
  useEffect(() => {
    setPending((prev) => {
      const keys = Object.keys(prev)
      if (keys.length === 0) return prev
      const now = Date.now()
      let changed = false
      const next: typeof prev = {}
      for (const k of keys) {
        const { scope, ticket, kind } = parseKey(k)
        let real: number | undefined
        let gone = false
        if (scope === 'pos') {
          const p = symPositions.find((x) => x.ticket === ticket)
          gone = p == null
          real = kind === 'sl' ? p?.stopLoss : p?.takeProfit
        } else {
          const o = pendingOrders.find((x) => x.ticket === ticket)
          gone = o == null
          real = kind === 'price' ? o?.price : kind === 'sl' ? o?.stopLoss : o?.takeProfit
        }
        const realNum = real && real > 0 ? real : 0
        const settled = gone || Math.abs(realNum - prev[k].price) < 1e-9
        if (settled || now - prev[k].at >= OVERRIDE_TTL_MS) { changed = true; continue }
        next[k] = prev[k]
      }
      return changed ? next : prev
    })
  }, [symPositions, pendingOrders])

  const overlayRef = useRef<HTMLDivElement>(null)

  // 主图指标图例的让位框：ResizeObserver 盯尺寸，绘制回调只读缓存（拖十字线时每帧量 rect
  // 会强制同步重排）。没有 ResizeObserver 的老内核退回每帧现测。
  // The main legend's dodge box: a ResizeObserver tracks its size and the paint callback
  // reads the cache (measuring per frame forced a synchronous layout during crosshair drags).
  const legendElRef = useRef<HTMLElement | null>(null)
  const legendBoxRef = useRef<LabelBox | null>(null)
  const legendRoRef = useRef<ResizeObserver | null>(null)
  const readLegendBox = useCallback((): LabelBox | null => {
    const host = overlayRef.current
    if (!host) return null
    let el = legendElRef.current
    if (!el || !el.isConnected) {
      el = (host.parentElement?.querySelector('.term-legend.main') as HTMLElement | null) ?? null
      legendElRef.current = el
      legendBoxRef.current = el ? measureLegendBox(host, el) : null
      const ro = legendRoRef.current
      if (ro) {
        ro.disconnect()
        if (el) ro.observe(el)
      }
    }
    if (!el) return null
    if (!legendRoRef.current) return measureLegendBox(host, el)
    return legendBoxRef.current
  }, [])

  // ── 盈亏文字 / P/L text ──
  const unit = trading.pnlUnit
  const pnlText = useCallback((r: { points: number; money: number | null; pct: number | null }): string | null => {
    if (unit === 'points') return `${fmtSigned(r.points, 0)} ${tt('charts.trade.pts')}`
    if (unit === 'pct') return r.pct != null ? `${fmtSigned(r.pct)}%` : null
    return r.money != null ? `${fmtSigned(r.money)}${currency ? ` ${currency}` : ''}` : null
  }, [unit, currency, tt])
  const signColor = (n: number) => (n > 0 ? UP_COLOR : n < 0 ? DOWN_COLOR : '#a1a1aa')
  const dg = exactDigits ?? digits

  // 一条止损 / 止盈线上的「到价盈亏」/ the P/L-at-level for an SL/TP line
  const legExtra = useCallback((side: 'BUY' | 'SELL', volume: number, entry: number, price: number) => {
    if (!trading.pnl) return null
    const r = moveReadout({ symbol, side, volume, entry, price, digits: dg, spec, balance })
    const text = pnlText(r)
    return text ? { text, color: signColor(r.money ?? r.points) } : null
  }, [trading.pnl, symbol, dg, spec, balance, pnlText])

  // ── 全部线的画法规格（画序：挂单 → 投影单 → 持仓，持仓压在最上面）──
  // Every line's paint spec. Order: pending → draft → positions (positions end up on top).
  const lines = useMemo<LineSpec[]>(() => {
    const out: LineSpec[] = []
    const btns = trading.lineButtons
    const isStaged = (k: string) => staged[k] != null
    const legBtns = (scope: LineScope, ticket: number, kind: 'sl' | 'tp'): BtnSpec[] => {
      const k = keyOf(scope, ticket, kind)
      if (isStaged(k)) return [{ id: `${k}:ok`, glyph: 'ok', tip: tt('charts.trade.tipConfirmLeg') }, { id: `${k}:unstage`, glyph: 'x', tip: tt('charts.trade.tipDiscardLeg') }]
      if (!btns && scope !== 'draft') return []
      return [{ id: `${k}:x`, glyph: 'x', tip: tt(kind === 'sl' ? 'charts.trade.tipRemoveSl' : 'charts.trade.tipRemoveTp') }]
    }
    const addBtns = (scope: LineScope, ticket: number, hasTp: boolean, hasSl: boolean): BtnSpec[] => {
      const b: BtnSpec[] = []
      if (!hasTp) b.push({ id: `${scope}:${ticket}:addtp`, glyph: 'tp', tip: tt('charts.trade.tipAddTp') })
      if (!hasSl) b.push({ id: `${scope}:${ticket}:addsl`, glyph: 'sl', tip: tt('charts.trade.tipAddSl') })
      return b
    }

    for (const q of symPending) {
      const o = q.order
      const b: BtnSpec[] = btns ? [...addBtns('ord', q.ticket, q.tp != null, q.sl != null), { id: `ord:${q.ticket}:cancel`, glyph: 'close', tip: tt('charts.trade.tipCancel') }] : []
      out.push({ key: keyOf('ord', q.ticket, 'price'), price: q.price, color: PENDING_COLOR, dash: DASH_PENDING, label: q.label, extra: null, buttons: b })
      if (q.sl != null) out.push({ key: keyOf('ord', q.ticket, 'sl'), price: q.sl, color: PENDING_DOWN_COLOR, dash: DASH_PENDING, label: `SL ${q.sl.toFixed(digits)}`, extra: legExtra(o.side, o.volume, q.price, q.sl), buttons: legBtns('ord', q.ticket, 'sl') })
      if (q.tp != null) out.push({ key: keyOf('ord', q.ticket, 'tp'), price: q.tp, color: PENDING_UP_COLOR, dash: DASH_PENDING, label: `TP ${q.tp.toFixed(digits)}`, extra: legExtra(o.side, o.volume, q.price, q.tp), buttons: legBtns('ord', q.ticket, 'tp') })
    }

    if (draftView) {
      const d = draftView
      const q = quote()
      const type = autoEntryType(d.side, d.price, q.bid, q.ask)
      const vol = parseFloat(d.volume) || 0
      out.push({
        key: keyOf('draft', 0, 'price'), price: d.price, color: DRAFT_COLOR, dash: DASH_DRAFT,
        label: `${d.side} ${type} ${vol.toFixed(lotDecimals(symbol))} @ ${d.price.toFixed(digits)}`, extra: null,
        buttons: [...addBtns('draft', 0, d.tp != null, d.sl != null), { id: 'draft:0:discard', glyph: 'close', tip: tt('charts.trade.discard') }],
      })
      if (d.sl != null) out.push({ key: keyOf('draft', 0, 'sl'), price: d.sl, color: PENDING_DOWN_COLOR, dash: DASH_DRAFT, label: `SL ${d.sl.toFixed(digits)}`, extra: legExtra(d.side, vol, d.price, d.sl), buttons: legBtns('draft', 0, 'sl') })
      if (d.tp != null) out.push({ key: keyOf('draft', 0, 'tp'), price: d.tp, color: PENDING_UP_COLOR, dash: DASH_DRAFT, label: `TP ${d.tp.toFixed(digits)}`, extra: legExtra(d.side, vol, d.price, d.tp), buttons: legBtns('draft', 0, 'tp') })
    }

    for (const m of markers) {
      const p = m.pos
      let extra: LineSpec['extra'] = null
      if (trading.pnl) {
        const cur = p.currentPrice && p.currentPrice > 0 ? p.currentPrice : null
        const r = cur != null ? moveReadout({ symbol, side: p.side, volume: p.volume, entry: m.entry, price: cur, digits: dg, spec, balance }) : null
        const money = p.profit
        const text = unit === 'money'
          ? `${fmtSigned(money)}${currency ? ` ${currency}` : ''}`
          : unit === 'pct' ? (balance && balance > 0 ? `${fmtSigned((money / balance) * 100)}%` : null)
            : r ? `${fmtSigned(r.points, 0)} ${tt('charts.trade.pts')}` : null
        if (text) extra = { text, color: signColor(money) }
      }
      const b: BtnSpec[] = []
      if (btns) {
        b.push(...addBtns('pos', m.ticket, m.tp != null, m.sl != null))
        if (canBreakeven(p.side, m.entry, p.currentPrice) && (m.sl == null || Math.abs(m.sl - m.entry) > pointSize(dg) / 2)) {
          b.push({ id: `pos:${m.ticket}:be`, glyph: 'be', tip: tt('charts.trade.tipBreakeven') })
        }
        if (onPlace) b.push({ id: `pos:${m.ticket}:rev`, glyph: 'rev', tip: tt('charts.trade.tipReverse') })
        b.push({ id: `pos:${m.ticket}:close`, glyph: 'close', tip: tt('charts.trade.tipClose') })
      }
      out.push({ key: null, price: m.entry, color: ENTRY_COLOR, dash: DASH_ENTRY, label: `${p.side} ${p.volume.toFixed(2)} @ ${m.entry.toFixed(digits)}`, extra, buttons: b })
      if (m.sl != null) out.push({ key: keyOf('pos', m.ticket, 'sl'), price: m.sl, color: DOWN_COLOR, dash: DASH_LEVEL, label: `SL ${m.sl.toFixed(digits)}`, extra: legExtra(p.side, p.volume, m.entry, m.sl), buttons: legBtns('pos', m.ticket, 'sl') })
      if (m.tp != null) out.push({ key: keyOf('pos', m.ticket, 'tp'), price: m.tp, color: UP_COLOR, dash: DASH_LEVEL, label: `TP ${m.tp.toFixed(digits)}`, extra: legExtra(p.side, p.volume, m.entry, m.tp), buttons: legBtns('pos', m.ticket, 'tp') })
    }
    return out
  }, [symPending, draftView, markers, staged, trading.lineButtons, trading.pnl, unit, currency, balance, spec, digits, dg, symbol, legExtra, quote, onPlace, tt])

  // ── 拖动读数 / drag readout ──
  const readout = useMemo<Readout | null>(() => {
    if (!dragKey || dragPrice == null) return null
    const { scope, ticket, kind } = parseKey(dragKey)
    const px = dragPrice.toFixed(digits)
    let side: 'BUY' | 'SELL' | null = null
    let vol = 0
    let entry: number | null = null
    if (scope === 'pos') {
      const m = markers.find((x) => x.ticket === ticket)
      if (m) { side = m.pos.side; vol = m.pos.volume; entry = m.entry }
    } else if (scope === 'ord') {
      const q = symPending.find((x) => x.ticket === ticket)
      if (q) { side = q.order.side; vol = q.order.volume; entry = kind === 'price' ? null : q.price }
    } else if (draft) {
      side = draft.side; vol = parseFloat(draft.volume) || 0; entry = kind === 'price' ? null : draft.price
    }
    if (!side) return null
    // 拖触发价：读数是离现价多少点 / dragging a trigger: points away from the market
    if (entry == null) {
      const q = quote()
      const ref = (side === 'BUY' ? q.ask : q.bid) ?? refPrice ?? null
      if (ref == null) return { price: dragPrice, text: px, color: DRAFT_COLOR }
      const pts = Math.round((dragPrice - ref) / pointSize(dg))
      return { price: dragPrice, text: `${px} · ${fmtSigned(pts, 0)} ${tt('charts.trade.pts')}`, color: scope === 'draft' ? DRAFT_COLOR : PENDING_COLOR }
    }
    const r = moveReadout({ symbol, side, volume: vol, entry, price: dragPrice, digits: dg, spec, balance })
    const parts = [px, `${fmtSigned(r.points, 0)} ${tt('charts.trade.pts')}`]
    if (r.money != null) parts.push(`${fmtSigned(r.money)}${currency ? ` ${currency}` : ''}`)
    if (r.pct != null) parts.push(`${fmtSigned(r.pct)}%`)
    return { price: dragPrice, text: parts.join(' · '), color: signColor(r.money ?? r.points) }
  }, [dragKey, dragPrice, digits, dg, markers, symPending, draft, quote, refPrice, symbol, spec, balance, currency, tt])

  // primitive 每帧读这份快照 / the primitive reads this snapshot each frame
  const modelRef = useRef<RenderModel>({ lines, hovered, hoveredBtn: hoveredBtn?.id ?? null, dragging: dragKey, readout, align: trading.align, legendBox: readLegendBox })
  modelRef.current = { lines, hovered, hoveredBtn: hoveredBtn?.id ?? null, dragging: dragKey, readout, align: trading.align, legendBox: readLegendBox }

  const primRef = useRef<PosPrimitive | null>(null)

  // 挂载 / 卸载 primitive：只跟随 series 与显隐，内容变化靠 requestUpdate 重绘。
  // Attach / detach: tied to the series and visibility only; content changes just repaint.
  useEffect(() => {
    if (!visible) return
    const prim = new PosPrimitive(() => modelRef.current)
    primRef.current = prim
    series.attachPrimitive(prim as never)
    return () => {
      primRef.current = null
      // chart 已销毁时跳过：detach 只会在 disposed 对象上排一帧重绘，见 isChartAlive()。
      // Skip once the chart is gone; see isChartAlive().
      if (!isChartAlive(chart)) return
      try { series.detachPrimitive(prim as never) } catch { /* 已 detach / already detached */ }
    }
  }, [chart, series, visible])

  useEffect(() => {
    primRef.current?.requestUpdate()
  }, [lines, hovered, hoveredBtn, dragKey, readout, trading.align])

  useEffect(() => {
    if (!visible || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const host = overlayRef.current
      const el = legendElRef.current
      legendBoxRef.current = host && el && el.isConnected ? measureLegendBox(host, el) : null
      primRef.current?.requestUpdate()
    })
    legendRoRef.current = ro
    const el = legendElRef.current
    if (el && el.isConnected) ro.observe(el)
    return () => {
      ro.disconnect()
      legendRoRef.current = null
    }
  }, [visible])

  // ──── 命中判定 / hit testing ────
  const linesRef = useRef<LineSpec[]>(lines)
  linesRef.current = lines
  const markersRef = useRef<Marker[]>(markers)
  markersRef.current = markers
  const pendingRef = useRef<PendingMarker[]>(symPending)
  pendingRef.current = symPending
  const draftRef = useRef<Draft | null>(draft)
  draftRef.current = draft

  // y → 命中的可拖线（只看带 key 的线）/ y → the draggable line under it (keyed lines only)
  const hitLine = useCallback((y: number): LineHit | null => {
    let best: LineHit | null = null
    for (const l of linesRef.current) {
      if (!l.key) continue
      const ly = series.priceToCoordinate(l.price) as number | null
      if (ly == null) continue
      const dist = Math.abs(y - ly)
      if (dist <= TOL && (!best || dist < best.dist)) {
        const { scope, ticket, kind } = parseKey(l.key)
        best = { key: l.key, scope, ticket, kind, dist, price: l.price }
      }
    }
    return best
  }, [series])

  // (x, y) → 命中的标签按钮（读 primitive 上一帧画出的位置）/ the label button under (x, y)
  const hitBtn = useCallback((x: number, y: number): BtnHit | null => {
    const hits = primRef.current?.hits ?? []
    for (let i = hits.length - 1; i >= 0; i--) {
      const b = hits[i]
      if (x >= b.x - BTN_PAD && x <= b.x + b.w + BTN_PAD && y >= b.y - BTN_PAD && y <= b.y + b.h + BTN_PAD) return b
    }
    return null
  }, [])

  // 悬停时才把覆盖层切成 pointer-events:auto 去抢事件，其余时候让给图表的平移 / 缩放。按帧合并。
  // Capture pointer events only while hovering a line or button; coalesced per frame.
  useEffect(() => {
    if (!visible) return
    const el = overlayRef.current
    if (!el) return
    let frame = 0
    let last: { x: number; y: number } | null = null
    const evaluate = () => {
      frame = 0
      const p = last
      if (!p) return
      if (dragRef.current) { el.style.pointerEvents = 'auto'; return }
      const r = el.getBoundingClientRect()
      const x = p.x - r.left, y = p.y - r.top
      if (x < 0 || y < 0 || x > r.width || y > r.height) {
        el.style.pointerEvents = 'none'
        setHovered(null)
        setHoveredBtn(null)
        return
      }
      const b = hitBtn(x, y)
      if (b) {
        el.style.pointerEvents = 'auto'
        el.style.cursor = 'pointer'
        setHovered(null)
        setHoveredBtn((prev) => (prev?.id === b.id ? prev : { id: b.id, tip: b.tip, x: b.x + b.w / 2, y: b.y }))
        return
      }
      setHoveredBtn(null)
      const h = hitLine(y)
      el.style.pointerEvents = h ? 'auto' : 'none'
      el.style.cursor = h ? 'ns-resize' : 'default'
      setHovered(h ? h.key : null)
    }
    const onHover = (e: PointerEvent) => {
      if (dragRef.current) { el.style.pointerEvents = 'auto'; return }
      // 触摸没有悬停：擦过一条线不能武装覆盖层，否则下一次平移会落到它身上、图表纹丝不动。
      // Touch has no hover: brushing a line must not arm the overlay, or the next pan dies on it.
      if (isTouchLike(e.pointerType)) return
      last = { x: e.clientX, y: e.clientY }
      if (frame === 0) frame = window.requestAnimationFrame(evaluate)
    }
    const onPress = (e: PointerEvent) => { lastTouchRef.current = isTouchLike(e.pointerType) }
    // 冒泡期，在 React 的 onPointerUp 之后：触摸抬起后不在拖、也没有选中的线，就把覆盖层还给图表。
    // Bubble phase, after React's onPointerUp: hand the pointer back when nothing is held.
    const onRelease = (e: PointerEvent) => {
      if (!isTouchLike(e.pointerType) || dragRef.current || touchSelRef.current) return
      el.style.pointerEvents = 'none'
    }
    window.addEventListener('pointermove', onHover, true)
    window.addEventListener('pointerdown', onPress, true)
    window.addEventListener('pointerup', onRelease)
    window.addEventListener('pointercancel', onRelease)
    return () => {
      window.removeEventListener('pointermove', onHover, true)
      window.removeEventListener('pointerdown', onPress, true)
      window.removeEventListener('pointerup', onRelease)
      window.removeEventListener('pointercancel', onRelease)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [hitBtn, hitLine, visible])

  // ──── 按钮动作 / button actions ────
  const roundPx = useCallback((v: number) => {
    // 只有拿到券商真精度才取整（见 exactDigits 的说明）/ round only with the broker's real precision
    if (exactDigits == null) return v
    const f = Math.pow(10, exactDigits)
    return Math.round(v * f) / f
  }, [exactDigits])

  const kindLabel = useCallback((k: LineKind) => (k === 'sl' ? tt('charts.ticket.sl') : k === 'tp' ? tt('charts.ticket.tp') : tt('charts.ticket.triggerPrice')), [tt])

  // 持仓改单的确认：另一条腿在确认那一刻现取（用户可能盯着确认框几十秒，其间桥接推过新值）。
  // A position modify's confirm: the other leg is re-read at confirm time, not drag time.
  const confirmPosLeg = useCallback((m: Marker, kind: 'sl' | 'tp', newPrice: number, key: string | null) => {
    const from = kind === 'sl' ? m.pos.stopLoss : m.pos.takeProfit
    setConfirmState({
      key, newPrice,
      title: tt('charts.posmark.confirmModifyTitle'),
      message: tt('charts.posmark.confirmModifyMsg', {
        symbol: baseSymbol(m.pos.symbol), side: tt(m.pos.side === 'BUY' ? 'charts.dock.buy' : 'charts.dock.sell'),
        ticket: String(m.ticket), kind: kindLabel(kind),
        from: from && from > 0 ? from.toFixed(digits) : EMPTY, to: newPrice.toFixed(digits),
      }),
      run: async () => {
        const fresh = symPositionsRef.current.find((p) => p.ticket === m.ticket) ?? m.pos
        const liveSl = fresh.stopLoss && fresh.stopLoss > 0 ? fresh.stopLoss : 0
        const liveTp = fresh.takeProfit && fresh.takeProfit > 0 ? fresh.takeProfit : 0
        const k = keyOf('pos', m.ticket, kind)
        setPending((prev) => ({ ...prev, [k]: { price: newPrice, at: Date.now() } }))
        const ok = await actions.modify(fresh, kind === 'sl' ? newPrice : liveSl, kind === 'tp' ? newPrice : liveTp)
        if (!ok) setPending((prev) => { const r = { ...prev }; delete r[k]; return r })
      },
    })
  }, [actions, digits, kindLabel, tt])

  const confirmOrdLeg = useCallback((q: PendingMarker, kind: LineKind, newPrice: number, key: string | null) => {
    const o = q.order
    const from = kind === 'price' ? o.price : kind === 'sl' ? o.stopLoss : o.takeProfit
    setConfirmState({
      key, newPrice,
      title: tt('charts.posmark.confirmModifyPendingTitle'),
      message: tt('charts.posmark.confirmModifyPendingMsg', {
        symbol: baseSymbol(o.symbol), type: tt(`order.pending.type.${o.type}`), ticket: String(q.ticket),
        kind: kindLabel(kind), from: from != null && from > 0 ? from.toFixed(digits) : EMPTY, to: newPrice.toFixed(digits),
      }),
      run: async () => {
        const k = keyOf('ord', q.ticket, kind)
        setPending((prev) => ({ ...prev, [k]: { price: newPrice, at: Date.now() } }))
        // 只发拖动的那一项：MODIFY_PENDING「没传的不碰」，不存在拿旧值覆盖新值的问题。
        // Only the dragged field: MODIFY_PENDING leaves the rest, nothing can be overwritten.
        const ok = await actions.modifyPending(o, kind === 'price' ? { price: newPrice } : kind === 'sl' ? { stopLoss: newPrice } : { takeProfit: newPrice })
        if (!ok) setPending((prev) => { const r = { ...prev }; delete r[k]; return r })
      },
    })
  }, [actions, digits, kindLabel, tt])

  // 一条腿的新价能不能用：方向校验与原来拖线时一致。返回 null = 可以，否则是错误提示。
  // Whether a leg's new price is valid (same checks as drag-to-modify); null = OK, else the error.
  const legError = useCallback((scope: LineScope, ticket: number, kind: LineKind, next: number): string | null => {
    if (scope === 'pos') {
      const m = markersRef.current.find((x) => x.ticket === ticket)
      if (!m) return EMPTY
      const slNow = m.pos.stopLoss && m.pos.stopLoss > 0 ? m.pos.stopLoss : null
      const tpNow = m.pos.takeProfit && m.pos.takeProfit > 0 ? m.pos.takeProfit : null
      const ref = m.pos.currentPrice
      const c = checkSlTp(m.pos.side === 'BUY', kind === 'sl' ? next : slNow, kind === 'tp' ? next : tpNow, ref != null && ref > 0 ? ref : null)
      return (kind === 'sl' ? c.slInvalid : c.tpInvalid) ? tt('charts.dock.slTpWrong') : null
    }
    if (scope === 'ord') {
      const q = pendingRef.current.find((x) => x.ticket === ticket)
      if (!q) return EMPTY
      const o = q.order
      const rawSl = o.stopLoss && o.stopLoss > 0 ? o.stopLoss : null
      const rawTp = o.takeProfit && o.takeProfit > 0 ? o.takeProfit : null
      const isBuy = o.side === 'BUY'
      const entry = kind === 'price' ? next : o.price
      const c = checkSlTp(isBuy, kind === 'sl' ? next : rawSl, kind === 'tp' ? next : rawTp, entry)
      if (kind === 'price' ? (c.slInvalid || c.tpInvalid) : kind === 'sl' ? c.slInvalid : c.tpInvalid) return tt('charts.dock.slTpWrong')
      if (kind === 'price') {
        const err = checkPendingPrice(o.type.endsWith('LIMIT') ? 'LIMIT' : 'STOP', isBuy, next, refPrice ?? null, refPrice ?? null)
        if (err) return tt(err, { price: refPrice != null ? refPrice.toFixed(digits) : EMPTY })
      }
      return null
    }
    return null
  }, [digits, refPrice, tt])

  // 点出一条止盈 / 止损线（手机的拖出方式；桌面单击按钮也走这里）。
  // Tap out an SL/TP line (the phone's drag-out; a desktop click on the button too).
  const stageLeg = useCallback((scope: LineScope, ticket: number, kind: 'sl' | 'tp') => {
    if (scope === 'draft') {
      const d = draftRef.current
      if (!d) return
      // 投影单的止损止盈相对它自己的入场价，不看现价 / a draft's legs are relative to its own entry
      setDraft({ ...d, [kind]: roundPx(stagedLegPrice(d.side, kind, d.price, d.price)) })
      return
    }
    let side: 'BUY' | 'SELL', entry: number, cur: number | null
    if (scope === 'pos') {
      const m = markersRef.current.find((x) => x.ticket === ticket)
      if (!m) return
      side = m.pos.side; entry = m.entry; cur = m.pos.currentPrice ?? refPrice ?? null
    } else {
      const q = pendingRef.current.find((x) => x.ticket === ticket)
      if (!q) return
      side = q.order.side; entry = q.price; cur = q.price
    }
    const k = keyOf(scope, ticket, kind)
    setStaged((prev) => ({ ...prev, [k]: roundPx(stagedLegPrice(side, kind, entry, cur)) }))
    touchSelRef.current = k
    if (overlayRef.current) overlayRef.current.style.pointerEvents = 'auto'
    setHovered(k)
  }, [refPrice, roundPx])

  const unstage = useCallback((k?: string) => {
    setStaged((prev) => {
      if (k == null) return Object.keys(prev).length ? {} : prev
      if (prev[k] == null) return prev
      const r = { ...prev }
      delete r[k]
      return r
    })
  }, [])

  // 一条腿定价后走确认（拖完松手、或点出来的线按 ✓）/ a leg with its new price goes to confirm
  const commitLeg = useCallback((scope: LineScope, ticket: number, kind: LineKind, price: number, key: string) => {
    const err = legError(scope, ticket, kind, price)
    if (err) { if (err !== EMPTY) onToast(err, 'error'); return false }
    if (scope === 'pos') {
      const m = markersRef.current.find((x) => x.ticket === ticket)
      if (m && kind !== 'price') confirmPosLeg(m, kind, price, key)
    } else if (scope === 'ord') {
      const q = pendingRef.current.find((x) => x.ticket === ticket)
      if (q) confirmOrdLeg(q, kind, price, key)
    }
    return true
  }, [confirmOrdLeg, confirmPosLeg, legError, onToast])

  const runBtn = useCallback((id: string, at: { x: number; y: number }) => {
    const parts = id.split(':')
    const scope = parts[0] as LineScope
    const ticket = Number(parts[1])
    const act = parts.slice(2).join(':')
    // 点出来的腿：确认 / 放弃 / a staged leg: confirm or discard
    if (act === 'sl:ok' || act === 'tp:ok' || act === 'sl:unstage' || act === 'tp:unstage') {
      const kind = act.slice(0, 2) as 'sl' | 'tp'
      const k = keyOf(scope, ticket, kind)
      if (act.endsWith('unstage')) { unstage(k); touchSelRef.current = null; return }
      const price = staged[k]
      if (price != null) commitLeg(scope, ticket, kind, price, k)
      return
    }
    if (act === 'addtp' || act === 'addsl') { stageLeg(scope, ticket, act === 'addtp' ? 'tp' : 'sl'); return }

    if (scope === 'draft') {
      if (act === 'discard') setDraft(null)
      else if (act === 'sl:x' || act === 'tp:x') setDraft((d) => (d ? { ...d, [act.slice(0, 2)]: null } : d))
      return
    }

    if (scope === 'ord') {
      const q = pendingRef.current.find((x) => x.ticket === ticket)
      if (!q) return
      const o = q.order
      if (act === 'cancel') {
        setConfirmState({
          key: null, newPrice: null,
          title: tt('charts.dock.cancelPendingTitle'),
          message: tt('charts.trade.cancelMsg', { symbol: baseSymbol(o.symbol), type: tt(`order.pending.type.${o.type}`), lots: o.volume.toFixed(2), price: o.price.toFixed(digits), ticket: String(o.ticket) }),
          run: () => actions.cancelPending(o),
        })
      } else if (act === 'sl:x' || act === 'tp:x') {
        const kind = act.slice(0, 2) as 'sl' | 'tp'
        const cur = kind === 'sl' ? o.stopLoss : o.takeProfit
        setConfirmState({
          key: null, newPrice: null,
          title: tt('charts.trade.removeLegTitle', { kind: kindLabel(kind) }),
          message: tt('charts.trade.removeLegMsg', { symbol: baseSymbol(o.symbol), ticket: String(o.ticket), kind: kindLabel(kind), price: cur && cur > 0 ? cur.toFixed(digits) : EMPTY }),
          run: () => actions.modifyPending(o, kind === 'sl' ? { stopLoss: 0 } : { takeProfit: 0 }),
        })
      }
      return
    }

    const m = markersRef.current.find((x) => x.ticket === ticket)
    if (!m) return
    const p = m.pos
    const sideText = tt(p.side === 'BUY' ? 'charts.dock.buy' : 'charts.dock.sell')
    if (act === 'close') {
      setClosePop({ ticket, x: at.x, y: at.y + LABEL_H / 2 + 4 })
    } else if (act === 'rev') {
      setConfirmState({
        key: null, newPrice: null,
        title: tt('charts.trade.reverseTitle'),
        message: tt('charts.trade.reverseMsg', { symbol: baseSymbol(p.symbol), side: sideText, lots: p.volume.toFixed(2), ticket: String(ticket) }),
        run: () => actions.reverse(p, digits),
      })
    } else if (act === 'be') {
      if (!canBreakeven(p.side, m.entry, p.currentPrice)) { onToast(tt('charts.trade.beNotInProfit'), 'error'); return }
      const entry = roundPx(m.entry)
      setConfirmState({
        key: keyOf('pos', ticket, 'sl'), newPrice: entry,
        title: tt('charts.trade.beTitle'),
        message: tt('charts.trade.beMsg', { symbol: baseSymbol(p.symbol), ticket: String(ticket), price: entry.toFixed(digits) }),
        run: async () => {
          const fresh = symPositionsRef.current.find((x) => x.ticket === ticket) ?? p
          const liveTp = fresh.takeProfit && fresh.takeProfit > 0 ? fresh.takeProfit : 0
          const k = keyOf('pos', ticket, 'sl')
          setPending((prev) => ({ ...prev, [k]: { price: entry, at: Date.now() } }))
          const ok = await actions.modify(fresh, entry, liveTp)
          if (!ok) setPending((prev) => { const r = { ...prev }; delete r[k]; return r })
        },
      })
    } else if (act === 'sl:x' || act === 'tp:x') {
      const kind = act.slice(0, 2) as 'sl' | 'tp'
      const cur = kind === 'sl' ? p.stopLoss : p.takeProfit
      setConfirmState({
        key: null, newPrice: null,
        title: tt('charts.trade.removeLegTitle', { kind: kindLabel(kind) }),
        message: tt('charts.trade.removeLegMsg', { symbol: baseSymbol(p.symbol), ticket: String(ticket), kind: kindLabel(kind), price: cur && cur > 0 ? cur.toFixed(digits) : EMPTY }),
        run: async () => {
          const fresh = symPositionsRef.current.find((x) => x.ticket === ticket) ?? p
          const liveSl = fresh.stopLoss && fresh.stopLoss > 0 ? fresh.stopLoss : 0
          const liveTp = fresh.takeProfit && fresh.takeProfit > 0 ? fresh.takeProfit : 0
          await actions.modify(fresh, kind === 'sl' ? 0 : liveSl, kind === 'tp' ? 0 : liveTp)
        },
      })
    }
  }, [actions, commitLeg, digits, kindLabel, onToast, roundPx, stageLeg, staged, tt, unstage])
  const runBtnRef = useRef(runBtn)
  runBtnRef.current = runBtn

  // 触摸：点一下线 = 选中（下一次按在这条线上才开始拖）；点按钮直接执行；点空白取消点出来的线。
  // 鼠标点到空白也清掉点出来、还没确认的线。
  // Touch: a tap on a line selects it, a tap on a button runs it; a tap on empty chart drops
  // staged legs (for the mouse too).
  useEffect(() => {
    if (!visible) return
    const onClick = (p: MouseEventParams) => {
      const el = overlayRef.current
      const src = p.sourceEvent
      if (!el || !src) return
      const r = el.getBoundingClientRect()
      const x = src.clientX - r.left, y = src.clientY - r.top
      if (lastTouchRef.current) {
        const b = hitBtn(x, y)
        if (b) { runBtnRef.current(b.id, { x: b.x + b.w / 2, y: b.y }); return }
        if (p.paneIndex !== 0) return
        const h = hitLine(y)
        if (h) {
          touchSelRef.current = h.key
          el.style.pointerEvents = 'auto'
          setHovered(h.key)
          return
        }
      } else if (hitBtn(x, y) || hitLine(y)) return
      unstage()
    }
    chart.subscribeClick(onClick)
    return () => {
      if (!isChartAlive(chart)) return
      chart.unsubscribeClick(onClick)
    }
  }, [chart, hitBtn, hitLine, unstage, visible])

  // 隐藏时清掉悬停 / 拖动态（拖到一半被隐藏：onUp 不会再来，这里把图表平移还回去）。
  // Clear hover / drag state when hidden (mid-drag: give the chart its pan back here).
  useEffect(() => {
    if (!visible) {
      setHovered(null)
      setHoveredBtn(null)
      touchSelRef.current = null
      const before = scrollBeforeDragRef.current
      scrollBeforeDragRef.current = null
      if (before != null && isChartAlive(chart)) chart.applyOptions({ handleScroll: scrollAfterDrag(before) })
      dragRef.current = null
      setDragKey(null)
      setDragPrice(null)
    }
  }, [chart, visible])

  // 把 y 夹在主图 pane 内（开了副图时往下拖会越过主图底边，价格会被线性外推成离谱值）。
  // Clamp y into the main pane, or dragging into a sub-pane extrapolates a nonsense price.
  const clampY = useCallback((y: number) => {
    const h = chart.panes()[0]?.getHeight?.() ?? 0
    if (h <= 0) return y
    return Math.max(0, Math.min(y, h))
  }, [chart])

  const beginDrag = useCallback((e: RPointerEvent<HTMLDivElement>, key: string, price: number, y: number, fromBtn: string | null) => {
    const el = overlayRef.current
    const lineY = series.priceToCoordinate(price) as number | null
    if (!el || lineY == null) return
    const { scope, ticket, kind } = parseKey(key)
    e.preventDefault()
    el.setPointerCapture(e.pointerId)
    dragRef.current = {
      key, scope, ticket, kind, price,
      grab: fromBtn ? 0 : lineY - y, startY: y,
      slop: isTouchLike(e.pointerType) ? DRAG_SLOP_TOUCH : DRAG_SLOP_MOUSE,
      active: false, pointerId: e.pointerId, fromBtn,
    }
    // 拖线期间关掉图表自身的拖动平移；先拷贝原值，松手原样还回去（手机价格轴靠 vertTouchDrag，踩坑 #221）。
    // Disable the chart's own drag-pan; snapshot and restore verbatim (pitfall #221).
    if (scrollBeforeDragRef.current == null) scrollBeforeDragRef.current = scrollAfterDrag(chart.options().handleScroll)
    chart.applyOptions({ handleScroll: DRAG_LOCK_SCROLL })
  }, [chart, series])

  const onDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || dragRef.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = overlayRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = e.clientX - r.left, y = e.clientY - r.top
    const b = hitBtn(x, y)
    if (b) {
      e.preventDefault()
      // 「拖出止盈 / 止损」按钮：鼠标按住就能直接拖出一条线；单击（没拖）则点出一条。
      // The add-TP / add-SL buttons: press and drag pulls a line out; a plain click stages one.
      const parts = b.id.split(':')
      const act = parts[2]
      if ((act === 'addtp' || act === 'addsl') && !isTouchLike(e.pointerType)) {
        const scope = parts[0] as LineScope
        const ticket = Number(parts[1])
        const kind = act === 'addtp' ? 'tp' : 'sl'
        const base = scope === 'pos' ? markersRef.current.find((m) => m.ticket === ticket)?.entry
          : scope === 'ord' ? pendingRef.current.find((q) => q.ticket === ticket)?.price
            : draftRef.current?.price
        if (base != null) { beginDrag(e, keyOf(scope, ticket, kind), base, y, b.id); return }
      }
      pressedBtnRef.current = b.id
      el.setPointerCapture(e.pointerId)
      return
    }
    const h = hitLine(y)
    if (!h) {
      // 点选过一条线、这一下按空了 = 取消选中；覆盖层由 window 上的 pointerup 监听撤掉。
      // A missed press after a tap selection deselects.
      const sel = touchSelRef.current
      if (sel) {
        touchSelRef.current = null
        setHovered(null)
        if (staged[sel] != null) unstage(sel)
      }
      return
    }
    beginDrag(e, h.key, h.price, y, null)
  }, [beginDrag, hitBtn, hitLine, staged, unstage])

  const restoreScroll = useCallback(() => {
    const before = scrollBeforeDragRef.current
    scrollBeforeDragRef.current = null
    if (before == null || !isChartAlive(chart)) return
    chart.applyOptions({ handleScroll: scrollAfterDrag(before) })
  }, [chart])

  const endDrag = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (overlayRef.current?.hasPointerCapture?.(e.pointerId)) overlayRef.current.releasePointerCapture(e.pointerId)
    restoreScroll()
    setDragKey(null)
    setDragPrice(null)
    return drag
  }, [restoreScroll])

  const onMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const el = overlayRef.current
    if (!el) return
    const rawY = e.clientY - el.getBoundingClientRect().top
    if (!drag.active) {
      if (Math.abs(rawY - drag.startY) < drag.slop) return
      drag.active = true
      setDragKey(drag.key)
      setHoveredBtn(null)
    }
    const price = series.coordinateToPrice(clampY(rawY + drag.grab)) as number | null
    if (price == null) return
    drag.price = price
    setDragPrice(price)
  }, [clampY, series])

  const onUp = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    // 按钮：按下和抬起都在同一颗上才算点击 / a button click needs press and release on the same one
    const pressed = pressedBtnRef.current
    if (pressed) {
      pressedBtnRef.current = null
      const el = overlayRef.current
      if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId)
      if (!el) return
      const r = el.getBoundingClientRect()
      const b = hitBtn(e.clientX - r.left, e.clientY - r.top)
      if (b && b.id === pressed) runBtn(b.id, { x: b.x + b.w / 2, y: b.y })
      return
    }
    const cur = dragRef.current
    if (cur && e.pointerId !== cur.pointerId) return // 第二根手指抬起 / a second finger lifting
    const drag = endDrag(e)
    if (drag?.active && isTouchLike(e.pointerType)) { touchSelRef.current = null; setHovered(null) }
    if (!drag) return
    // 从按钮上按下却没拖：当作单击按钮（点出一条线）/ pressed a drag-out button without dragging: a click
    if (!drag.active) {
      if (drag.fromBtn) runBtn(drag.fromBtn, { x: 0, y: 0 })
      return
    }
    // 按券商真精度取整（拿不到就原样发，见 exactDigits）/ round with the real precision only
    const next = roundPx(drag.price)
    if (next <= 0) return
    const factor = exactDigits != null ? Math.pow(10, exactDigits) : null
    const eps = factor != null ? 1 / factor / 2 : 1e-9

    // 投影单：直接改，不确认（还没提交，没有东西会被改坏）/ drafts change directly, nothing is sent yet
    if (drag.scope === 'draft') {
      setDraft((d) => (d ? { ...d, [drag.kind]: next } : d))
      return
    }
    // 点出来的腿被拖到新位置：更新暂存价，再走确认 / a staged leg dragged: update it, then confirm
    if (staged[drag.key] != null) {
      setStaged((prev) => ({ ...prev, [drag.key]: next }))
      commitLeg(drag.scope, drag.ticket, drag.kind, next, drag.key)
      return
    }
    // 与券商上报的原值比（不是被拖拽覆盖过的显示值），没实质变动就不弹确认。
    // Compare against the reported value, not the drag-overridden one; no real change, no confirm.
    if (drag.scope === 'ord') {
      const q = pendingRef.current.find((x) => x.ticket === drag.ticket)
      if (!q) return
      const o = q.order
      const orig = drag.kind === 'price' ? o.price : drag.kind === 'sl' ? (o.stopLoss && o.stopLoss > 0 ? o.stopLoss : null) : (o.takeProfit && o.takeProfit > 0 ? o.takeProfit : null)
      if (orig != null && Math.abs(next - orig) < eps) return
    } else {
      const m = markersRef.current.find((x) => x.ticket === drag.ticket)
      if (!m) return
      const raw = drag.kind === 'sl' ? m.pos.stopLoss : m.pos.takeProfit
      const orig = raw && raw > 0 ? raw : null
      if (orig != null && Math.abs(next - orig) < eps) return
    }
    commitLeg(drag.scope, drag.ticket, drag.kind, next, drag.key)
  }, [commitLeg, endDrag, exactDigits, hitBtn, roundPx, runBtn, staged])

  // 系统取消（边缘返回手势、来电）：只还原，永远不弹确认，那个价是拖到一半的。
  // A system cancel only restores; it never confirms a half-finished drag.
  const onCancel = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    pressedBtnRef.current = null
    const cur = dragRef.current
    if (cur && e.pointerId !== cur.pointerId) return
    endDrag(e)
  }, [endDrag])

  const handleConfirm = useCallback(async () => {
    const cs = confirmState
    if (!cs || confirmBusy) return
    setConfirmBusy(true)
    try {
      await cs.run()
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : tt('charts.dock.modifyFailed'), 'error')
    } finally {
      if (cs.key) unstage(cs.key)
      setConfirmBusy(false)
      setConfirmState(null)
      touchSelRef.current = null
    }
  }, [confirmBusy, confirmState, onToast, tt, unstage])

  // 取消：线弹回真实价位；点出来的腿也一并收回 / cancel: the line snaps back, a staged leg goes too
  const handleCancelConfirm = useCallback(() => {
    if (confirmState?.key) unstage(confirmState.key)
    setConfirmState(null)
    touchSelRef.current = null
  }, [confirmState, unstage])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (confirmState) { handleCancelConfirm(); return }
      if (Object.keys(staged).length) { unstage(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmState, handleCancelConfirm, staged, unstage])

  // ── 投影单提交 / submit the draft ──
  const submitDraft = useCallback(async () => {
    const d = draftRef.current
    if (!d || !onPlace || draftBusy) return
    const isBuy = d.side === 'BUY'
    const q = quote()
    const type = autoEntryType(d.side, d.price, q.bid, q.ask)
    const price = roundPx(d.price)
    const sl = d.sl != null ? roundPx(d.sl) : null
    const tp = d.tp != null ? roundPx(d.tp) : null
    const c = checkSlTp(isBuy, sl, tp, price)
    if (c.slInvalid || c.tpInvalid) { onToast(tt('charts.ticket.slTpWrong'), 'error'); return }
    if (slTooClose(sl, price)) { onToast(tt('order.slTooClose'), 'error'); return }
    const perr = checkPendingPrice(type, isBuy, price, q.bid, q.ask)
    if (perr) { onToast(tt(perr, { price: EMPTY }), 'error'); return }
    const volume = parseFloat(d.volume)
    if (!(volume > 0)) { onToast(tt('charts.ticket.invalidVolume'), 'error'); return }
    setDraftBusy(true)
    try {
      const res = await onPlace({ side: d.side, volume, login, sl, tp, type, price })
      if (res && (res.status === 'REJECTED' || res.status === 'FAILED')) return
      rememberVolume(volume)
      setDraft(null)
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : tt('charts.ticket.placeFailed'), 'error')
    } finally {
      setDraftBusy(false)
    }
  }, [draftBusy, login, onPlace, onToast, quote, rememberVolume, roundPx, tt])

  const closeTarget = closePop ? markers.find((m) => m.ticket === closePop.ticket)?.pos ?? null : null
  // 仓位平掉了 / 消失了，小窗跟着关 / the popover closes with its position
  useEffect(() => { if (closePop && !closeTarget) setClosePop(null) }, [closePop, closeTarget])

  // 提前返回必须放在所有 Hook 之后（父组件用 visible 切换而不是条件挂载）。
  // The early return comes after every Hook (the parent toggles `visible`).
  if (!visible) return null

  const touch = isTouchDevice
  return (
    <>
      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-0 z-10 touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
      />

      {/* 按钮的提示（桌面悬停）/ button tooltip on desktop hover */}
      {hoveredBtn && !dragKey && !closePop && (
        <div className="chart-trade-tip" style={{ left: hoveredBtn.x, top: hoveredBtn.y }} role="tooltip">{hoveredBtn.tip}</div>
      )}

      {closePop && closeTarget && (
        <ClosePopover
          position={closeTarget}
          x={closePop.x}
          y={closePop.y}
          touch={touch}
          onClose={() => setClosePop(null)}
          onConfirm={(vol) => { setClosePop(null); void actions.close(closeTarget, vol, digits) }}
        />
      )}

      {draft && (
        <DraftTicket
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSubmit={() => void submitDraft()}
          busy={draftBusy}
          symbol={symbol}
          digits={digits}
          quote={quote}
          spec={spec}
          balance={balance}
          currency={currency}
          login={login}
          touch={touch}
        />
      )}

      {/* 确认框：桌面按钮，手机滑动确认 / confirm: buttons on desktop, slide on phones */}
      {confirmState && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-transparent">
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className="pointer-events-auto rounded-panel float-panel p-4"
            style={{ minWidth: 280, maxWidth: 360 }}
            role="dialog"
            aria-label={confirmState.title}
            onKeyDown={(e) => { if (e.key === 'Escape') handleCancelConfirm() }}
          >
            <p className="mb-1 text-xs font-medium text-neutral-300">{confirmState.title}</p>
            <p className="mb-3 text-sm text-neutral-200">{confirmState.message}</p>
            {touch ? (
              <div className="flex flex-col gap-2">
                <SlideToConfirm disabled={confirmBusy} onConfirm={() => void handleConfirm()} label={tt('charts.trade.slideConfirm')} />
                <button type="button" onClick={handleCancelConfirm} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-400">
                  {tt('charts.posmark.cancel')}
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancelConfirm}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-neutral-400 transition hover:border-white/20 hover:text-neutral-100"
                >
                  {tt('charts.posmark.cancel')}
                </button>
                <button
                  type="button"
                  autoFocus
                  disabled={confirmBusy}
                  onClick={() => void handleConfirm()}
                  className="rounded-lg bg-prism-600/60 px-3 py-1.5 text-xs font-medium text-prism-100 transition hover:bg-prism-500/60 disabled:opacity-50"
                >
                  {tt('charts.posmark.confirm')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
