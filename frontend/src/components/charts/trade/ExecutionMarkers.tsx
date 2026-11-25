// 交易历史：每笔交易用一条虚线把开仓点和平仓点连起来，线的颜色看结果（盈利绿、亏损红）。
// 两头各一个小箭头，尖端正指着成交价：开仓箭头实心，平仓箭头挖空；买入成交绿色朝上、画在价位
// 下方，卖出成交红色朝下、画在价位上方（平掉买单是一笔卖出）。还开着的仓位只画开仓箭头，
// 它的现价线由持仓线负责。一个仓位分批平仓时，每次平仓各一条线，都从同一个开仓点出发。
// 数据：已平仓明细（开平两头都有时间和价格）+ 本页订单里还没平的开仓成交。价格类图表
// （砖形等）横轴不是时间，不画。
// 2026-11 改版前是按 K 线合并的箭头加手数文字（「0.1 · 2 笔」），看不出哪进哪出。
// Trade history: each trade is a dashed line from its entry to its exit, coloured by the
// result (green profit, red loss). Each end has a small arrow whose tip sits on the fill:
// solid for the entry, hollowed for the exit; buy fills green pointing up below the price,
// sell fills red pointing down above it (closing a buy is a sell). Open positions get the
// entry arrow only — their live line belongs to the position overlay. A position closed in
// parts draws one line per close, all from the same entry. Data: closed trades (both ends
// carry time and price) plus the still-open fills from this page's orders. Price-based chart
// types have no time axis and get none. Replaced per-bar merged arrows with volume text,
// which never showed which entry went with which exit.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { AutoscaleInfo, IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, Logical, Time } from 'lightweight-charts'
import type { ClosedTrade, Order, Position } from '../../../api/types'
import { orderApi } from '../../../api/client'
import { baseSymbol, parseTime } from '../../../api/utils'
import type { MainSeriesApi } from '../useChartEngine'
import { isChartAlive } from '../chartLifecycle'
import { DOWN_COLOR, UP_COLOR } from '../canvasColors'
import { placeLegs, type PlacedLeg, type Side, type TradeLeg } from './tradeMath'

// 后端时间是不带时区的 UTC 字符串，必须走 parseTime（补 Z）；直接 Date.parse 会按本地时间解析，
// 北京时间下整条线往左偏 8 小时。/ Backend times are naive UTC: parseTime appends Z. Date.parse
// would read them as local time and shift every line by the viewer's UTC offset.
const ts = (iso: string | null | undefined): number | null => {
  const n = parseTime(iso)?.getTime()
  return n != null && Number.isFinite(n) ? Math.floor(n / 1000) : null
}

/** 已平仓明细 + 开仓成交 → 交易列表（只取本品种）/ closed trades + open fills → trades for the symbol */
export function tradeLegsFrom(symbol: string, closed: readonly ClosedTrade[], orders: readonly Order[], positions: readonly Position[]): TradeLeg[] {
  const base = baseSymbol(symbol)
  const out: TradeLeg[] = []
  const seen = new Set<number>()
  for (const c of closed) {
    if (baseSymbol(c.symbol) !== base) continue
    const t1 = ts(c.openTime)
    if (t1 == null || !c.openPrice) continue
    seen.add(c.positionTicket)
    out.push({ side: c.side, t1, p1: c.openPrice, t2: ts(c.closedAt), p2: c.closePrice || null, profit: c.profit ?? null })
  }
  // 还开着的仓位：开仓时间取本页订单里那张成交的开仓单 / open positions: time from this page's filled order
  const open = new Set(positions.filter((p) => baseSymbol(p.symbol) === base && p.ticket != null).map((p) => p.ticket as number))
  for (const o of orders) {
    if (o.status !== 'FILLED' || (o.action ?? 'ORDER') !== 'ORDER' || baseSymbol(o.symbol) !== base || o.filledPrice == null) continue
    const tk = o.mt5Ticket ?? o.ticket ?? null
    if (tk == null || !open.has(tk) || seen.has(tk)) continue
    const t1 = ts(o.updatedAt) ?? ts(o.createdAt)
    if (t1 == null) continue
    seen.add(tk)
    out.push({ side: o.side, t1, p1: o.filledPrice, t2: null, p2: null, profit: null })
  }
  return out
}

const sideColor = (s: Side) => (s === 'BUY' ? UP_COLOR : DOWN_COLOR)

export class ExecPrimitive {
  private _series: MainSeriesApi | null = null
  private _chart: IChartApi | null = null
  private _ru: (() => void) | null = null
  legs: PlacedLeg[] = []
  private _pv: IPrimitivePaneView
  constructor() {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target: CanvasRenderingTarget2D) => target.useMediaCoordinateSpace((s) => this._draw(s.context, s.mediaSize.width, s.mediaSize.height)),
    }
    this._pv = { renderer: () => renderer }
  }
  attached(p: { chart: IChartApi; series: MainSeriesApi; requestUpdate: () => void }) { this._chart = p.chart; this._series = p.series; this._ru = p.requestUpdate }
  detached() { this._chart = null; this._series = null; this._ru = null }
  paneViews() { return [this._pv] }
  updateAllViews() {}
  autoscaleInfo(_s: Logical, _e: Logical): AutoscaleInfo | null { return null }
  requestUpdate() { this._ru?.() }

  private _draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const s = this._series, c = this._chart
    if (!s || !c || this.legs.length === 0) return
    const tsc = c.timeScale()
    const size = Math.max(3.5, Math.min(5, tsc.options().barSpacing * 0.35))
    const xy = (bar: number | null, price: number | null): [number, number] | null => {
      if (bar == null || price == null) return null
      const x = tsc.timeToCoordinate(bar as Time)
      const y = s.priceToCoordinate(price) as number | null
      return x == null || y == null ? null : [x, y]
    }
    const pts = this.legs.map((l) => ({ l, a: xy(l.b1, l.p1), b: xy(l.b2, l.p2) }))
    const onScreen = (p: [number, number] | null) => !!p && p[0] > -12 && p[0] < w + 12 && p[1] > -12 && p[1] < h + 12
    ctx.save()
    // 先画线、再画箭头，箭头盖在线头上 / lines first so the arrows sit on top of their ends
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    for (const { l, a, b } of pts) {
      if (!a || !b) continue
      // 整条线都在屏幕外就跳过 / skip lines entirely off screen
      if ((a[0] < 0 && b[0] < 0) || (a[0] > w && b[0] > w)) continue
      ctx.strokeStyle = l.profit == null ? sideColor(l.side) : l.profit >= 0 ? UP_COLOR : DOWN_COLOR
      ctx.globalAlpha = 0.95
      ctx.beginPath()
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    // 分批平仓的开仓点只画一次 / a partially closed position's entry is drawn once
    const drawn = new Set<string>()
    for (const { l, a, b } of pts) {
      if (onScreen(a)) {
        const k = `${a![0]}:${a![1]}:${l.side}`
        if (!drawn.has(k)) { drawn.add(k); this._arrow(ctx, a![0], a![1], l.side, true, size) }
      }
      // 平仓成交方向与仓位相反 / the closing deal goes the other way
      if (onScreen(b)) this._arrow(ctx, b![0], b![1], l.side === 'BUY' ? 'SELL' : 'BUY', false, size)
    }
    ctx.restore()
  }

  // 箭头尖端指着成交价，箭身在价位外侧 / the tip touches the fill price, the body sits outside
  private _arrow(ctx: CanvasRenderingContext2D, x: number, y: number, side: Side, solid: boolean, size: number) {
    const up = side === 'BUY'
    const tip = up ? y + 1 : y - 1
    const base = up ? tip + size * 1.6 : tip - size * 1.6
    ctx.fillStyle = sideColor(side)
    ctx.strokeStyle = 'rgba(9,9,11,0.85)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, tip)
    ctx.lineTo(x - size, base)
    ctx.lineTo(x + size, base)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    if (solid) return
    // 平仓箭头中间挖空，和开仓一眼分开 / exit arrows are hollowed so they read apart from entries
    ctx.fillStyle = 'rgba(9,9,11,0.9)'
    const m = (base - tip) * 0.45
    ctx.beginPath()
    ctx.moveTo(x, tip + m * 0.9)
    ctx.lineTo(x - size * 0.45, base - m * 0.25)
    ctx.lineTo(x + size * 0.45, base - m * 0.25)
    ctx.closePath()
    ctx.fill()
  }
}

interface Props {
  chart: IChartApi
  series: MainSeriesApi
  symbol: string
  login: string | null
  orders: Order[]
  positions: Position[]
  barTimes: () => number[]
  /** K 线数据变化的信号（新 K 线、换周期）/ changes when the bars change */
  dataKey: string
  visible: boolean
}

export default function ExecutionMarkers({ chart, series, symbol, login, orders, positions, barTimes, dataKey, visible }: Props) {
  const [closed, setClosed] = useState<ClosedTrade[]>([])
  const primRef = useRef<ExecPrimitive | null>(null)

  // 已平仓明细只取最新一页（够覆盖屏幕上看得见的那段）；持仓数变了（有仓位平掉）就再取一次。
  // Only the newest page of closed trades; refetched when the position count changes (a close).
  const openCount = positions.length
  useEffect(() => {
    if (!visible || !login) { setClosed([]); return }
    let alive = true
    const id = window.setTimeout(() => {
      orderApi.closedTrades({ login }).then((r) => { if (alive) setClosed(r.trades) }).catch(() => { /* 标记是锦上添花，失败不提示 / decorative; fail silently */ })
    }, 600)
    return () => { alive = false; window.clearTimeout(id) }
  }, [login, openCount, visible])

  const legs = useMemo(() => tradeLegsFrom(symbol, closed, orders, positions), [symbol, closed, orders, positions])

  useEffect(() => {
    if (!visible) return
    const prim = new ExecPrimitive()
    primRef.current = prim
    series.attachPrimitive(prim as never)
    return () => {
      primRef.current = null
      if (!isChartAlive(chart)) return
      try { series.detachPrimitive(prim as never) } catch { /* already detached */ }
    }
  }, [chart, series, visible])

  useEffect(() => {
    const prim = primRef.current
    if (!prim) return
    prim.legs = placeLegs(legs, barTimes())
    prim.requestUpdate()
  }, [legs, barTimes, dataKey, visible])

  return null
}
