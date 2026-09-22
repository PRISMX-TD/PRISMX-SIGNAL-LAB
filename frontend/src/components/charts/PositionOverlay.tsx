// 图表订单标记层：把当前选中账户在本品种上的**持仓**与**挂单**画到主图上——
// 各自的入场价、止损、止盈各一条线（带价格标签）。持仓的止损/止盈线可以直接拖动
// 改单：松手即发 MODIFY 指令，与底部持仓面板的"管理"表单走完全同一套后端流程。
// 可在工具栏一键显隐。
//
// 挂单的三条线同样可以拖：触发价、止损、止盈，松手发 MODIFY_PENDING。它们用另一
// 套颜色 + 点线画（见 PENDING_*），因为它们说的是"还没发生的事"——同一个品种上
// 同时有持仓和挂单时，两组线必须一眼分得开。
//
// Order markers layer: draws the selected account's positions **and pending orders**
// for the current symbol — entry / SL / TP lines with price labels for each. A
// position's SL/TP lines can be dragged to modify; dropping sends the same MODIFY the
// dock's "manage" form does. A pending order's three lines drag the same way and send
// MODIFY_PENDING. They are painted in their own colours with a dotted stroke, because
// they describe something that has not happened yet and must be distinguishable at a
// glance from live positions on the same symbol.
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
import type { PendingOrder, Position } from '../../api/types'
import { orderApi } from '../../api/client'
import { baseSymbol, clientOrderId, localizeApiError } from '../../api/utils'
import { checkPendingPrice, checkSlTp } from '../order/orderMath'
import { isChartAlive } from './chartLifecycle'

// 触摸屏放宽命中容差（手指没有像素级精度）/ looser hit tolerance on touch screens
const isTouchDevice = typeof window !== 'undefined'
  && (window.matchMedia?.('(pointer: coarse)').matches ?? false)
const TOL = isTouchDevice ? 14 : 6

// 画布调色板是这一层自己的，与 tokens.css 的 --up/--down 刻意不同源：canvas 读不到
// CSS 变量，而这几条线画在 K 线上，饱和度要比卡片上的数据色更高才压得住。
// The canvas palette is local on purpose: canvas cannot read CSS variables, and these
// lines sit on top of candles where they need more saturation than the card tokens.
const UP_COLOR = '#2ee07e'
const DOWN_COLOR = '#ff4d67'
const ENTRY_COLOR = '#22d3ee'

// 挂单用另一套：触发价琥珀色（与持仓的青色入场线一眼分开），止损止盈保持红/绿的
// **色相**但调浅——方向语义（红=止损、绿=止盈）不能因为换色就丢掉，而"浅一档 + 点线"
// 恰好说的就是它们还没生效。
// Pending orders get their own set: amber for the trigger (unmistakable against the
// cyan entry line), and lighter tints of the same red/green for SL/TP — the direction
// semantics (red = stop, green = target) must survive the recolour, while "one shade
// lighter, dotted" is exactly what "not active yet" should look like.
const PENDING_COLOR = '#f5a524'
const PENDING_DOWN_COLOR = '#ff9db0'
const PENDING_UP_COLOR = '#8fe3b4'

// 持仓线用长虚线，挂单线用点线。颜色之外再给一个形状上的差别：色觉障碍用户、
// 以及截图被压过之后，形状仍然分得开。
// Positions dash, pending orders dot. A second, non-colour channel so the two groups
// stay separable for colour-blind users and in a recompressed screenshot.
const DASH_ENTRY = [2, 3]
const DASH_LEVEL = [6, 4]
const DASH_PENDING = [2, 4]

// 一个"这块地方已经被占了"的矩形：本帧已画出的标签，以及主图的指标图例。
// 存的是真实上下边界而不是"中心 y + 固定高度"——图例是个会换行的 DOM 元素，
// 高度随开了几个指标而变，用固定高度算它必然算错。
// An occupied rect: labels already drawn this frame, plus the main indicator legend.
// Real top/bottom rather than "centre y + fixed height", because the legend is a
// wrapping DOM element whose height depends on how many overlays are on.
interface LabelBox { x: number; w: number; top: number; bottom: number }

const LABEL_H = 15
const LABEL_X0 = 6
// 右边留给价格轴的最新价气泡，标签不许挤进去。
// Reserved for the price axis's last-price bubble; labels must not reach it.
const LABEL_RIGHT_GUARD = 70

/**
 * 给一个标签找一个不与本帧已画标签重叠的横向位置：从最左开始，撞上就挪到那个
 * 标签的右边再试，实在放不下就原地压着画。
 *
 * 为什么需要：一张挂单自带三条线（触发价 / 止损 / 止盈），同一个品种上挂两三张
 * 单时，价位差十几个点的标签在屏幕上只差几像素，叠在一起就全都读不出来了——
 * 而"看得见"正是这层标记存在的唯一理由。持仓标记一直有同样的毛病，只是一张
 * 持仓最多三条线、不容易撞上。
 *
 * Find a horizontal slot for a label that does not overlap the ones already drawn this
 * frame: start at the left, and on a collision hop to the right of the offender. One
 * pending order brings three lines, so two or three orders on the same symbol put
 * labels a few pixels apart and they become mutually unreadable — which defeats the
 * only purpose this layer has. Positions always had the same flaw, just less often.
 */
function placeLabel(taken: LabelBox[], top: number, bottom: number, w: number, bw: number): number {
  let x = LABEL_X0
  // 每次至多挪 8 次:够躲开一屏里现实可能出现的标签数,又不至于在病态输入下空转。
  // At most 8 hops: enough for any realistic screenful, bounded for pathological input.
  for (let i = 0; i < 8; i++) {
    const hit = taken.find((b) =>
      top < b.bottom && bottom > b.top && x < b.x + b.w && x + bw > b.x)
    if (!hit) break
    const next = hit.x + hit.w + 4
    // 右边放不下就退回最左边原样画:那正是加这套让位之前的样子,叠一下总好过
    // 把标签推到价格轴上、或者推出画布外彻底看不见。
    // No room to the right → fall back to the leftmost slot, i.e. exactly how it
    // looked before any of this: an overlap beats shoving the label onto the price
    // axis or off-canvas entirely.
    if (next + bw > w - LABEL_RIGHT_GUARD) return LABEL_X0
    x = next
  }
  return x
}

// 改单指令已发出、桥接还没把新值报回来的这段时间里，先按用户拖到的值显示，
// 免得线"弹回"旧价位看起来像没生效。超过这个时限就放弃等待，回归真实数据。
// While a MODIFY is in flight (the bridge reports asynchronously) keep showing
// the dragged value so the line doesn't snap back and look like a no-op. Give
// up waiting after this long and fall back to the reported truth.
const OVERRIDE_TTL_MS = 60_000

// 'price' 只属于挂单——那是它的触发价；持仓的入场价是既成事实，改不了。
// 'price' belongs to pending orders only: their trigger. A position's entry already
// happened and cannot be edited.
type LineKind = 'sl' | 'tp' | 'price'

// 一条线属于哪一类。键里必须带上它：持仓票号与挂单票号来自 MT5 的不同编号空间，
// 撞号完全可能，只按 `${ticket}:${kind}` 做键会让两条线共用一个身份——悬停高亮
// 跑到另一条上，拖一条提交的是另一条。
// Which family a line belongs to. The key must carry it: position tickets and order
// tickets come from different MT5 numbering spaces and can collide, so keying on
// `${ticket}:${kind}` alone would let two lines share one identity — hover highlighting
// the wrong one, and a drag submitting against the wrong one.
type LineScope = 'pos' | 'ord'

/** 命中的那条线。必须是个具名类型、并显式标成 hitLine 的返回值：`best` 只在内层
 *  回调里被赋值，TypeScript 会把它窄化成 `null`，调用方拿到的就成了 `never`。
 *  A named type, and hitLine's return annotation: `best` is only assigned inside a
 *  callback, so TypeScript narrows it to `null` and callers end up with `never`. */
interface LineHit {
  key: string
  scope: LineScope
  ticket: number
  kind: LineKind
  dist: number
}

interface Marker {
  ticket: number
  pos: Position
  entry: number
  sl: number | null
  tp: number | null
}

/** 一张挂单的三条线。与 Marker 分开放，是因为两者能改的东西不一样：持仓只能改
 *  止损止盈，挂单连入场价（触发价）也能改，而且走的是另一条后端指令。
 *  Kept apart from Marker because they are editable in different ways: a position's
 *  entry already happened, a pending order's trigger has not — and they go out as
 *  different backend commands. */
interface PendingMarker {
  ticket: number
  label: string
  /** 券商上报的原始挂单，改单时要拿它的 login 与品种原名回传。
   *  The reported order, whose login and raw symbol go back with a modify. */
  order: PendingOrder
  price: number
  sl: number | null
  tp: number | null
}

const keyOf = (scope: LineScope, ticket: number, kind: LineKind) => `${scope}:${ticket}:${kind}`

// 渲染模型：一次画完全部持仓标记，比"每条线一个 primitive"少一大堆 attach/
// detach 记账。primitive 只持有一个取数函数，每帧读最新状态。
// Render model: one primitive paints every marker, which avoids a pile of
// attach/detach bookkeeping versus one primitive per line. The primitive holds
// only a getter and reads the latest state each frame.
interface RenderModel {
  markers: Marker[]
  pending: PendingMarker[]
  digits: number
  hovered: string | null
  dragging: string | null
  /** 主图指标图例当前占的位置；没有开启主图指标时为 null。
   *  Where the main indicator legend currently sits; null when no overlay is on. */
  legendBox: () => LabelBox | null
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

  _render(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const series = this._series
    if (!series) return
    const { markers, pending, digits, hovered, dragging, legendBox } = this._get()
    // 本帧已画出的标签框。按画的顺序累积,后画的躲开先画的——所以画序决定了谁
    // 留在最左边:挂单先画,持仓的标签会被挤到右边一点。持仓才是更该一眼看到的,
    // 但它的线本身是高亮可拖的,已经足够显眼,让位给标签的可读性更划算。
    // Label rects already drawn this frame; later labels dodge earlier ones, so paint
    // order decides who keeps the leftmost slot. Pending orders paint first, nudging
    // position labels right — positions matter more, but their lines are already the
    // highlighted, draggable ones, so trading that slot for legibility is the better deal.
    const taken: LabelBox[] = []

    // 指标图例先占位。它是画在 canvas 之上的 DOM（z-index 20），谁也不会让谁——
    // 之前一条贴着图表顶部的标记线，标签就直接被 "MA 89 4279.40" 盖住读不出来。
    // 图例不是我们画的，所以只能让标签躲它。
    // The indicator legend claims its space first. It is a DOM element painted above the
    // canvas (z-index 20), so neither yields: a marker near the top of the chart had its
    // label buried under "MA 89 4279.40". We do not draw the legend, so the label dodges.
    const legend = legendBox()
    if (legend) taken.push(legend)

    // 挂单先画：持仓的线是可交互的（悬停加粗、能拖），价位重叠时它压在上面才对。
    // Pending first: position lines are interactive, so they belong on top when the
    // two overlap at the same price.
    for (const q of pending) {
      const kp = keyOf('ord', q.ticket, 'price')
      this._line(ctx, w, series, q.price, PENDING_COLOR, q.label, DASH_PENDING, hovered === kp, dragging === kp, true, taken, h)
      if (q.sl != null) {
        const k = keyOf('ord', q.ticket, 'sl')
        this._line(ctx, w, series, q.sl, PENDING_DOWN_COLOR, `SL ${q.sl.toFixed(digits)}`, DASH_PENDING, hovered === k, dragging === k, true, taken, h)
      }
      if (q.tp != null) {
        const k = keyOf('ord', q.ticket, 'tp')
        this._line(ctx, w, series, q.tp, PENDING_UP_COLOR, `TP ${q.tp.toFixed(digits)}`, DASH_PENDING, hovered === k, dragging === k, true, taken, h)
      }
    }

    for (const m of markers) {
      this._line(ctx, w, series, m.entry, ENTRY_COLOR, entryLabel(m, digits), DASH_ENTRY, false, false, false, taken, h)
      if (m.sl != null) {
        const k = keyOf('pos', m.ticket, 'sl')
        this._line(ctx, w, series, m.sl, DOWN_COLOR, `SL ${m.sl.toFixed(digits)}`, DASH_LEVEL, hovered === k, dragging === k, true, taken, h)
      }
      if (m.tp != null) {
        const k = keyOf('pos', m.ticket, 'tp')
        this._line(ctx, w, series, m.tp, UP_COLOR, `TP ${m.tp.toFixed(digits)}`, DASH_LEVEL, hovered === k, dragging === k, true, taken, h)
      }
    }
  }

  // 单条水平线 + 左侧价格标签（可拖动的线在悬停/拖拽时加粗并显示抓手点）
  // One horizontal line + a left-side label (draggable ones thicken and show a
  // grip while hovered/dragged).
  private _line(
    ctx: CanvasRenderingContext2D, w: number, series: ISeriesApi<'Candlestick'>,
    price: number, color: string, label: string, dash: number[],
    hovered: boolean, dragging: boolean, draggable: boolean, taken: LabelBox[],
    h: number,
  ) {
    const y = series.priceToCoordinate(price) as number | null
    if (y == null) return
    // 价位在可见区间之外就整条不画。priceToCoordinate 对区间外的价格照样给坐标
    // （负数或超出画布），线本身被裁掉看不见，却会留下半截标签牌卡在图表顶/底边
    // 上——一块读不全的碎片，比什么都不画更碍事。
    // Skip entirely when the price is outside the visible range. priceToCoordinate
    // still returns a coordinate there (negative or past the canvas); the line itself
    // is clipped away but its label plate leaves a half-cut fragment pinned to the top
    // or bottom edge — an unreadable scrap, worse than drawing nothing.
    if (y < 0 || y > h) return
    const active = hovered || dragging
    // draggable 由调用方显式给出。原来这里是 `color !== ENTRY_COLOR`——只要不是入场
    // 色就当作能拖，于是挂单的止损止盈线一加进来就会画出抓手，暗示一个后端根本
    // 不存在的动作。
    // draggable is passed in. It used to be inferred as `color !== ENTRY_COLOR`, which
    // would have drawn a grip on pending SL/TP lines the moment they were added —
    // advertising an action the backend does not have.

    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = active ? 1 : 0.85
    ctx.lineWidth = active ? 2 : 1
    ctx.setLineDash(dash)
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
    const bh = LABEL_H, bw = tw + 10
    const bx = placeLabel(taken, y - bh / 2, y + bh / 2, w, bw)
    taken.push({ x: bx, w: bw, top: y - bh / 2, bottom: y + bh / 2 })
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
      this._prim._render(scope.context, scope.mediaSize.width, scope.mediaSize.height)
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
  // 已按选中账户过滤好的挂单（ChartsPage 的 accountPendingOrders）；同样在这里按品种筛。
  // Pending orders already filtered by the selected account; filtered by symbol here.
  pendingOrders: PendingOrder[]
  symbol: string
  // 展示用小数位（拿不到精度时是兜底的 2 位）/ display precision (2 when unknown)
  digits: number
  // 券商权威精度；null = 真的不知道。**只有它非空时才允许对要发给 MT5 的价格取整**
  // ——按猜的位数取整会把止损实打实地挪走（AUDUSD 按 2 位取整 = 偏 43 个点）。
  // The broker's authoritative precision; null means genuinely unknown. Rounding
  // a price destined for MT5 is only allowed when this is non-null: rounding to a
  // guessed precision physically moves the stop (43 points on AUDUSD at 2 digits).
  exactDigits: number | null
  // 参考价（图表最新收盘价），只用于**本地**校验拖出来的挂单触发价在不在正确的
  // 一侧。null = 不校验，交给网关判——它读得到真实买卖价，是更权威的那一层。
  // Reference price (the chart's latest close), used only to check locally that a
  // dragged trigger lands on the correct side. null skips the check and defers to the
  // gateway, which has the real bid/ask and is the authority.
  refPrice?: number | null
  visible: boolean
  onToast: (msg: string, kind: 'success' | 'error' | 'info') => void
}

export default function PositionOverlay({ chart, series, positions, pendingOrders, symbol, digits, exactDigits, refPrice, visible, onToast }: Props) {
  const { t } = useTranslation()

  // 拖拽中的线与其当前价位（未提交），以及已提交待回执的乐观值。
  // The line being dragged plus its uncommitted price, and optimistic values
  // for modifies that are submitted but not yet reported back by the bridge.
  const dragRef = useRef<{ key: string; scope: LineScope; ticket: number; kind: LineKind; price: number } | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragPrice, setDragPrice] = useState<number | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, { price: number; at: number }>>({})

  // 拖拽松手后待确认的改单信息；确认框显示期间线停在拖到的位置，取消则弹回。
  // Pending confirm state after a drag is released; the line stays at the
  // dragged position while the dialog is open, reverting on cancel.
  // 两支联合而不是一个带可选字段的结构：确认与提交的两条路要的东西完全不同
  // （持仓要重读另一条腿，挂单不用），用 scope 判别式强制在编译期分开。
  // A union rather than one shape with optional fields: the two confirm/submit paths
  // need different things (a position must re-read its other leg, a pending order must
  // not), and the discriminant makes the compiler keep them apart.
  type ConfirmState =
    | { key: string; scope: 'pos'; ticket: number; kind: LineKind; newPrice: number; marker: Marker }
    | { key: string; scope: 'ord'; ticket: number; kind: LineKind; newPrice: number; order: PendingMarker }
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

  // 挂单按同一套规则筛（券商后缀同样要剥掉），并和持仓一样叠上三层覆盖：正在
  // 拖动的实时值、松手待确认的值、已提交待回执的乐观值。三层的理由与持仓一字不
  // 差——线不能在提交后弹回旧价位，那看起来就像改单没生效。
  // Pending orders, filtered the same way and carrying the same three overlays as
  // positions: the live dragged value, the released-awaiting-confirm value, and the
  // submitted-awaiting-receipt optimistic one. Same reason as positions — the line must
  // not snap back to the old price after a submit, which reads as "it didn't work".
  const symPending = useMemo<PendingMarker[]>(() => {
    const base = baseSymbol(symbol)
    const now = Date.now()
    return pendingOrders
      .filter((o) => baseSymbol(o.symbol) === base && o.price > 0)
      .map((o) => {
        const pick = (kind: LineKind, real: number | undefined): number | null => {
          const k = keyOf('ord', o.ticket, kind)
          if (dragKey === k && dragPrice != null) return dragPrice
          if (confirmState && confirmState.key === k) return confirmState.newPrice
          const opt = pending[k]
          if (opt && now - opt.at < OVERRIDE_TTL_MS) return opt.price > 0 ? opt.price : null
          return real && real > 0 ? real : null
        }
        // 触发价永远有值（挂单没有"没有触发价"这回事），所以单独取、不走 pick 的
        // null 分支。/ A trigger always exists, so it never takes pick's null branch.
        const price = pick('price', o.price) ?? o.price
        return {
          ticket: o.ticket,
          order: o,
          // 标签直接写 MT5 的类型名：这四个词（BUY LIMIT / SELL STOP…）是交易员的
          // 通用语，比翻译过的中文更不容易误读，也和底部「挂单」页签对得上。
          // The label uses MT5's own type names: those four terms are the trader's lingua
          // franca, less ambiguous than a translation and consistent with the dock.
          label: `${o.type.replace('_', ' ')} ${o.volume.toFixed(2)} @ ${price.toFixed(digits)}`,
          price,
          sl: pick('sl', o.stopLoss),
          tp: pick('tp', o.takeProfit),
        }
      })
  }, [pendingOrders, symbol, digits, dragKey, dragPrice, pending, confirmState])

  // 标记列表：真实持仓叠加"已提交待回执"的乐观值 + 正在拖动的实时值 + 待确认的拖拽值。
  // Markers: real positions overlaid with in-flight optimistic values, the
  // live value of the line being dragged, and pending-confirm dragged values.
  const markers = useMemo<Marker[]>(() => {
    const now = Date.now()
    return symPositions.map((p) => {
      const ticket = p.ticket as number
      const pick = (kind: LineKind, real: number | undefined): number | null => {
        const k = keyOf('pos', ticket, kind)
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

  // 覆盖层根节点。声明提到这里（而不是留在命中判定那一段）是因为 readLegendBox
  // 的闭包要用它——ref 在回调真正被调用时早已初始化，但让声明在使用之前，读的人
  // 不必先去确认这件事。
  // The overlay root. Declared here rather than down in the hit-testing section because
  // readLegendBox closes over it; the ref is initialised long before that callback runs,
  // but declaring it first spares the reader from having to verify that.
  const overlayRef = useRef<HTMLDivElement>(null)

  // 主图指标图例的让位框。每帧现测而不是缓存起来：图例的宽度随指标数值的位数
  // 变（4279.40 → 967.4 就窄一截），高度随开了几个指标换行而变，任何"变了再测"
  // 的写法都得盯住这两件事；而这里一帧只读一个元素的 rect，且是在 canvas 的绘制
  // 回调里——布局此刻已经是干净的，不会触发重排。
  // 元素引用缓存着，只有它从 DOM 上掉了才重新查（关掉全部主图指标时会掉）。
  //
  // Measured per frame rather than cached: the legend's width tracks the digit count of
  // the indicator values and its height tracks how many overlays wrap onto a second row,
  // so any "re-measure when it changes" scheme has to watch both. This reads one
  // element's rect per frame inside the canvas paint callback, where layout is already
  // clean, so it forces no reflow. The element reference is cached and only re-queried
  // once it leaves the DOM (which happens when every main overlay is switched off).
  const legendElRef = useRef<HTMLElement | null>(null)
  const readLegendBox = useCallback((): LabelBox | null => {
    const host = overlayRef.current
    if (!host) return null
    let el = legendElRef.current
    if (!el || !el.isConnected) {
      el = (host.parentElement?.querySelector('.term-legend.main') as HTMLElement | null) ?? null
      legendElRef.current = el
    }
    if (!el) return null
    const hr = host.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return null
    // 四周留 4px：标签紧贴着图例也一样难读。/ 4px of air; touching is as bad as overlapping.
    return { x: r.left - hr.left - 4, w: r.width + 8, top: r.top - hr.top - 4, bottom: r.bottom - hr.top + 4 }
  }, [])

  // primitive 每帧读这份快照 / the primitive reads this snapshot each frame
  const modelRef = useRef<RenderModel>({ markers, pending: symPending, digits, hovered, dragging: dragKey, legendBox: readLegendBox })
  modelRef.current = { markers, pending: symPending, digits, hovered, dragging: dragKey, legendBox: readLegendBox }

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
  }, [markers, symPending, digits, hovered, dragKey])

  // ──── 命中判定 / hit testing ────
  const markersRef = useRef<Marker[]>(markers)
  markersRef.current = markers
  const pendingRef = useRef<PendingMarker[]>(symPending)
  pendingRef.current = symPending

  // y 像素 → 命中的可拖线。持仓只有止损/止盈可拖（开仓价是既成事实）；挂单三条
  // 都可拖——触发价还没成交，本来就是可以改的。
  // y pixel → the draggable line under it. A position exposes SL/TP only (its entry
  // already happened); a pending order exposes all three, its trigger included.
  const hitLine = useCallback((y: number): LineHit | null => {
    let best: LineHit | null = null
    const consider = (scope: LineScope, ticket: number, kind: LineKind, price: number | null) => {
      if (price == null) return
      const ly = series.priceToCoordinate(price) as number | null
      if (ly == null) return
      const dist = Math.abs(y - ly)
      if (dist <= TOL && (!best || dist < best.dist)) {
        best = { key: keyOf(scope, ticket, kind), scope, ticket, kind, dist }
      }
    }
    for (const m of markersRef.current) {
      consider('pos', m.ticket, 'sl', m.sl)
      consider('pos', m.ticket, 'tp', m.tp)
    }
    for (const q of pendingRef.current) {
      consider('ord', q.ticket, 'price', q.price)
      consider('ord', q.ticket, 'sl', q.sl)
      consider('ord', q.ticket, 'tp', q.tp)
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
    // 命中判定按帧合并：这是个常驻的捕获期全局监听，鼠标一动就要遍历全部持仓做
    // priceToCoordinate + setState。指针事件在高刷屏 / 高回报率鼠标上一帧能来好
    // 几个，逐个算是纯浪费（同一帧内画面只会呈现最后一次的结果）。
    // Coalesce hit-testing per frame: this is an always-on capture-phase global
    // listener that walks every position and calls setState. Pointer events can
    // arrive several times per frame on a high-refresh display, and only the last
    // one can possibly be painted.
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
        return
      }
      const h = hitLine(y)
      el.style.pointerEvents = h ? 'auto' : 'none'
      setHovered(h ? h.key : null)
    }
    const onHover = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY }
      // 拖拽中要立刻放行指针事件，不能等到下一帧才把 pointerEvents 切成 auto。
      // Mid-drag the overlay must claim pointer events immediately, not next frame.
      if (dragRef.current) { el.style.pointerEvents = 'auto'; return }
      if (frame === 0) frame = window.requestAnimationFrame(evaluate)
    }
    window.addEventListener('pointermove', onHover, true)
    return () => {
      window.removeEventListener('pointermove', onHover, true)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
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

  const submitModifyPending = useCallback(async (q: PendingMarker, kind: LineKind, price: number) => {
    try {
      // 只发拖动的那一项，另外两项留空 = 保留券商上的现值。
      //
      // 这里不需要像持仓那条路那样"重读另一条腿":MODIFY 要求两条腿一起发,所以那边
      // 必须现取另一条、否则会拿旧值覆盖新值;而 MODIFY_PENDING 从协议到网关都是
      // 「没传的不碰」,少发一项就是少改一项,压根没有覆盖的机会。
      //
      // Only the dragged field goes out; the other two are omitted and therefore kept.
      // Unlike the position path there is no "re-read the other leg": a MODIFY carries
      // both legs, so it must, while MODIFY_PENDING leaves out what it does not send —
      // there is nothing to accidentally overwrite.
      await orderApi.modifyPending({
        clientOrderId: clientOrderId(),
        ticket: q.ticket,
        symbol: q.order.symbol,
        mt5Login: q.order.login ?? null,
        price: kind === 'price' ? price : undefined,
        stopLoss: kind === 'sl' ? price : undefined,
        takeProfit: kind === 'tp' ? price : undefined,
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
    dragRef.current = { key: h.key, scope: h.scope, ticket: h.ticket, kind: h.kind, price }
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

    // 按品种精度取整：拖出来的价格是任意小数，直接发过去 MT5 也会自己截断，
    // 不如前端先规整，让线的落点和提示里的数字一致。
    // **但精度必须是券商上报的真值**（exactDigits）。以前这里用的是展示位数，而
    // 展示位数在拿不到报价时退回 2 位——对 5 位品种按 2 位取整，等于把用户拖出来
    // 的止损挪走最多约 50 个点，而这个数是**真发给 MT5** 的。拿不到真精度时干脆
    // 不取整，原样发过去让券商自己截断。
    // Round to the symbol's precision so the line and the toast agree — but only
    // with the broker's real precision. This used to use the display digits,
    // which fall back to 2, so a 5-digit symbol's dragged stop was rounded to
    // 0.01 (up to ~50 points off) and that rounded value was what MT5 received.
    // With no authoritative precision, send the raw price and let the broker
    // truncate it.
    const factor = exactDigits != null ? Math.pow(10, exactDigits) : null
    const next = factor != null ? Math.round(drag.price * factor) / factor : drag.price
    // "没有实质性变动"的判据跟着取整精度走；不取整时用一个极小的价格容差。
    // The "no meaningful change" epsilon follows the rounding precision; with no
    // rounding it falls back to a tiny price tolerance.
    const eps = factor != null ? 1 / factor / 2 : 1e-9
    if (next <= 0) return

    // ── 挂单：三条线都能拖，松手发 MODIFY_PENDING ──
    if (drag.scope === 'ord') {
      const q = pendingRef.current.find((x) => x.ticket === drag.ticket)
      if (!q) return
      // 比的是**券商上报的原值**，不是 q 上那个已经被拖拽覆盖过的值——理由与持仓
      // 那条一字不差，见下面的长注释。
      // Compared against the broker-reported values, not q's drag-overridden ones —
      // same reasoning as the position path below.
      const o = q.order
      const rawSl = o.stopLoss && o.stopLoss > 0 ? o.stopLoss : null
      const rawTp = o.takeProfit && o.takeProfit > 0 ? o.takeProfit : null
      const orig = drag.kind === 'price' ? o.price : drag.kind === 'sl' ? rawSl : rawTp
      if (orig != null && Math.abs(next - orig) < eps) return

      const isBuy = o.side === 'BUY'
      // 挂单的参照价是它自己的触发价，不是现价——止损止盈是相对"将来会在哪进场"
      // 而言的。拖触发价时用新的那个价去比另外两条腿。
      // A pending order's reference is its own trigger, not the market: its stops are
      // relative to where it will enter. Dragging the trigger re-checks both legs
      // against the new one.
      const entry = drag.kind === 'price' ? next : o.price
      const nextSl = drag.kind === 'sl' ? next : rawSl
      const nextTp = drag.kind === 'tp' ? next : rawTp
      const { slInvalid, tpInvalid } = checkSlTp(isBuy, nextSl, nextTp, entry)
      if (drag.kind === 'price' ? (slInvalid || tpInvalid) : drag.kind === 'sl' ? slInvalid : tpInvalid) {
        onToast(String(t('charts.dock.slTpWrong')), 'error')
        return
      }

      // 触发价还要在市价正确的一侧：买入限价必须低于现价、买入止损必须高于，反之
      // 亦然。拿不到参考价就跳过——网关会用真实买卖价再判一次，那是权威的一层。
      // The trigger must also sit on the right side of the market. With no reference
      // price this is skipped; the gateway re-checks against the real bid/ask.
      if (drag.kind === 'price') {
        const err = checkPendingPrice(
          o.type.endsWith('LIMIT') ? 'LIMIT' : 'STOP', isBuy, next,
          refPrice ?? null, refPrice ?? null,
        )
        if (err) {
          onToast(String(t(err, { price: refPrice != null ? refPrice.toFixed(digits) : '—' })), 'error')
          return
        }
      }

      setConfirmState({ key: drag.key, scope: 'ord', ticket: drag.ticket, kind: drag.kind, newPrice: next, order: q })
      return
    }

    const m = markersRef.current.find((x) => x.ticket === drag.ticket)
    if (!m) return
    // 对比原始持仓的止损/止盈（而非标记覆盖后的值——拖拽过程中 pick() 已经把
    // 标记值换成了拖拽位置，拿 m.sl/m.tp 比 next 永远是同一个价，会被当成
    // "没有实质性变动"而静默跳过，于是线弹回去、确认框不弹）。
    // Compare against the position's raw SL/TP (NOT the marker value — during a
    // drag, pick() overrides the marker with the dragged price, so comparing
    // m.sl/m.tp against next always sees the same price and silently skips the
    // confirm dialog as "no meaningful change", snapping the line back).
    const rawSl = m.pos.stopLoss
    const rawTp = m.pos.takeProfit
    const slNow = rawSl && rawSl > 0 ? rawSl : null
    const tpNow = rawTp && rawTp > 0 ? rawTp : null
    const orig = drag.kind === 'sl' ? slNow : tpNow
    if (orig != null && Math.abs(next - orig) < eps) return

    // 方向校验统一走下单表单那份 checkSlTp：除了「买单止损须低于现价」这条，它还
    // 带上了「两条腿都在时不许互穿」（买单 SL < TP），而且那条**不依赖现价**。
    // 以前这里整段包在 `if (ref != null && ref > 0)` 里，桥接旧版 / 刚接入还没推
    // 过价的仓位上，拖到错误一侧的止损会被原样提交。
    // Route the direction check through the order form's checkSlTp: besides the
    // "a BUY's SL must sit below the current price" rule it also enforces that the
    // two legs don't cross, which needs no reference price. This used to be wholly
    // wrapped in `if (ref != null && ref > 0)`, so a position with no reported
    // price (older bridge, freshly connected) accepted a wrong-side stop as-is.
    const ref = m.pos.currentPrice
    const isBuy = m.pos.side === 'BUY'
    const nextSl = drag.kind === 'sl' ? next : slNow
    const nextTp = drag.kind === 'tp' ? next : tpNow
    const { slInvalid, tpInvalid } = checkSlTp(isBuy, nextSl, nextTp, ref != null && ref > 0 ? ref : null)
    if (drag.kind === 'sl' ? slInvalid : tpInvalid) {
      onToast(String(t('charts.dock.slTpWrong')), 'error')
      return
    }

    // 弹出确认框而非直接发送 —— 避免误拖 / show confirm dialog instead of sending immediately
    setConfirmState({ key: drag.key, scope: 'pos', ticket: drag.ticket, kind: drag.kind, newPrice: next, marker: m })
  }, [chart, exactDigits, refPrice, digits, onToast, t])

  // 用户确认改单 / user confirms the modify
  const handleConfirm = useCallback(async () => {
    const cs = confirmState
    if (!cs) return
    if (cs.scope === 'ord') {
      setPending((prev) => ({ ...prev, [cs.key]: { price: cs.newPrice, at: Date.now() } }))
      setConfirmState(null)
      const okPending = await submitModifyPending(cs.order, cs.kind, cs.newPrice)
      if (!okPending) {
        setPending((prev) => {
          const rest = { ...prev }
          delete rest[cs.key]
          return rest
        })
      }
      return
    }
    // 另一条腿必须**现取**，不能用拖拽那一刻的 Marker 快照：MODIFY 要求两条腿一起
    // 发，用户可能盯着确认框几十秒，其间桥接推过新的止损止盈（或别处改了单），
    // 按旧快照发回去就是用旧值覆盖新值。fresh 找不到（仓位已平/已消失）时退回快照。
    // Re-read the other leg now rather than trusting the drag-time snapshot: a
    // MODIFY carries both legs, the dialog can sit open for a minute, and the
    // bridge may have reported a new SL/TP meanwhile — sending the snapshot would
    // overwrite the newer value with the older one. Falls back to the snapshot if
    // the position is gone.
    const fresh = symPositions.find((p) => p.ticket === cs.ticket)
    const m = cs.marker
    const liveSl = fresh?.stopLoss
    const liveTp = fresh?.takeProfit
    const otherSl = fresh ? (liveSl && liveSl > 0 ? liveSl : 0) : (m.sl ?? 0)
    const otherTp = fresh ? (liveTp && liveTp > 0 ? liveTp : 0) : (m.tp ?? 0)
    const sl = cs.kind === 'sl' ? cs.newPrice : otherSl
    const tp = cs.kind === 'tp' ? cs.newPrice : otherTp
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
  }, [confirmState, submitModify, submitModifyPending, symPositions])

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

  // 确认框的文案。持仓与挂单两支各自取自己的字段，在这里一次算好，JSX 里只管渲染。
  // 挂单那支多一个「触发价」维度，而且用 MT5 的类型名（BUY LIMIT…）代替买/卖——
  // 它已经把方向说在里面了，再加一个「买」只会让人以为那是两件事。
  // The dialog's copy, resolved here so the JSX just renders. The pending branch adds a
  // "trigger" dimension and names the MT5 type instead of buy/sell — the type already
  // states the direction, and showing both reads as two separate facts.
  const confirmCopy = useMemo(() => {
    if (!confirmState) return null
    const kindLabel = (k: LineKind) =>
      k === 'sl' ? String(t('charts.ticket.sl'))
        : k === 'tp' ? String(t('charts.ticket.tp'))
          : String(t('charts.ticket.triggerPrice'))
    if (confirmState.scope === 'ord') {
      const o = confirmState.order.order
      const from = confirmState.kind === 'price' ? o.price
        : confirmState.kind === 'sl' ? o.stopLoss
          : o.takeProfit
      return {
        title: String(t('charts.posmark.confirmModifyPendingTitle')),
        message: String(t('charts.posmark.confirmModifyPendingMsg', {
          symbol: baseSymbol(o.symbol),
          type: String(t(`order.pending.type.${o.type}`)),
          ticket: String(confirmState.ticket),
          kind: kindLabel(confirmState.kind),
          from: from != null && from > 0 ? from.toFixed(digits) : '—',
          to: confirmState.newPrice.toFixed(digits),
        })),
      }
    }
    const m = confirmState.marker
    const from = confirmState.kind === 'sl' ? m.sl : m.tp
    return {
      title: String(t('charts.posmark.confirmModifyTitle')),
      message: String(t('charts.posmark.confirmModifyMsg', {
        symbol: baseSymbol(m.pos.symbol),
        side: m.pos.side === 'BUY' ? String(t('charts.dock.buy')) : String(t('charts.dock.sell')),
        ticket: String(confirmState.ticket),
        kind: kindLabel(confirmState.kind),
        from: from != null ? from.toFixed(digits) : '—',
        to: confirmState.newPrice.toFixed(digits),
      })),
    }
  }, [confirmState, digits, t])

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
      {confirmState && confirmCopy && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-transparent">
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            className="pointer-events-auto rounded-xl border border-white/10 bg-ink-900/95 p-4 shadow-prism backdrop-blur-md"
            style={{ minWidth: 280 }}
            onKeyDown={(e) => { if (e.key === 'Escape') handleCancelConfirm() }}
          >
            <p className="mb-1 text-xs font-medium text-neutral-300">{confirmCopy.title}</p>
            <p className="mb-3 text-sm text-neutral-200">{confirmCopy.message}</p>
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
