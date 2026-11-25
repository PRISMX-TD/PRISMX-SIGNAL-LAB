// 成交标记：开仓、平仓的箭头画在对应那根 K 线上（买入绿色朝上、在价位下方；卖出红色朝下、
// 在价位上方），同一根 K 线同方向的合并成一个，旁边写手数（合并的写「合计手数 · N 笔」，K 线够宽时）。数据：已平仓明细
// （开平两头都有时间和价格）+ 本页订单里还没平的开仓成交。价格类图表（砖形等）横轴不是时间，不画。
// Execution markers: open / close arrows on their bars (buys green, pointing up, below the
// price; sells red, pointing down, above it), merged per bar and direction, with the volume
// beside them when bars are wide enough. Data: closed trades (both ends carry time and price)
// plus the still-open fills from this page's orders. Price-based chart types have no time
// axis and get none.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { AutoscaleInfo, IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, Logical, Time } from 'lightweight-charts'
import type { ClosedTrade, Order, Position } from '../../../api/types'
import { orderApi } from '../../../api/client'
import { baseSymbol } from '../../../api/utils'
import type { MainSeriesApi } from '../useChartEngine'
import { isChartAlive } from '../chartLifecycle'
import { DOWN_COLOR, UP_COLOR } from '../canvasColors'
import { groupExecutions, type ExecGroup, type Execution } from './tradeMath'

const ts = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const n = Date.parse(iso)
  return Number.isFinite(n) ? Math.floor(n / 1000) : null
}

/** 已平仓明细 + 开仓成交 → 成交列表（只取本品种）/ closed trades + open fills → executions for the symbol */
export function executionsFrom(symbol: string, closed: readonly ClosedTrade[], orders: readonly Order[], positions: readonly Position[]): Execution[] {
  const base = baseSymbol(symbol)
  const out: Execution[] = []
  const seenOpen = new Set<number>()
  for (const c of closed) {
    if (baseSymbol(c.symbol) !== base) continue
    const tc = ts(c.closedAt)
    // 平仓成交的方向与仓位相反（平买单 = 卖出）/ closing deals go the other way
    if (tc != null && c.closePrice) out.push({ t: tc, price: c.closePrice, side: c.side === 'BUY' ? 'SELL' : 'BUY', kind: 'close', volume: c.closeVolume, profit: c.profit })
    const to = ts(c.openTime)
    // 同一仓位分几次平会有几条平仓腿，开仓那头只画一次 / a position closed in parts opens only once
    if (to != null && c.openPrice && !seenOpen.has(c.positionTicket)) {
      seenOpen.add(c.positionTicket)
      out.push({ t: to, price: c.openPrice, side: c.side, kind: 'open', volume: c.closeVolume })
    }
  }
  // 还开着的仓位：开仓时间取本页订单里那张成交的开仓单 / open positions: time from this page's filled order
  const open = new Set(positions.filter((p) => baseSymbol(p.symbol) === base && p.ticket != null).map((p) => p.ticket as number))
  for (const o of orders) {
    if (o.status !== 'FILLED' || (o.action ?? 'ORDER') !== 'ORDER' || baseSymbol(o.symbol) !== base || o.filledPrice == null) continue
    const tk = o.mt5Ticket ?? o.ticket ?? null
    if (tk == null || !open.has(tk) || seenOpen.has(tk)) continue
    const t = ts(o.updatedAt) ?? ts(o.createdAt)
    if (t == null) continue
    seenOpen.add(tk)
    out.push({ t, price: o.filledPrice, side: o.side, kind: 'open', volume: o.volume })
  }
  return out
}

export class ExecPrimitive {
  private _series: MainSeriesApi | null = null
  private _chart: IChartApi | null = null
  private _ru: (() => void) | null = null
  groups: ExecGroup[] = []
  /** 「N 笔」的本地化写法 / localized "N fills" */
  fills: (n: number) => string = (n) => String(n)
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
    if (!s || !c || this.groups.length === 0) return
    const ts_ = c.timeScale()
    const spacing = ts_.options().barSpacing
    const size = Math.max(4, Math.min(7, spacing * 0.45))
    ctx.save()
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'center'
    for (const g of this.groups) {
      const x = ts_.timeToCoordinate(g.bar as Time)
      const y = s.priceToCoordinate(g.price) as number | null
      if (x == null || y == null || x < -10 || x > w + 10 || y < -20 || y > h + 20) continue
      const up = g.side === 'BUY'
      const col = up ? UP_COLOR : DOWN_COLOR
      // 箭头尖端指着成交价，箭身在价位外侧 / the tip touches the fill price, the body sits outside
      const tip = up ? y + 2 : y - 2
      const base = up ? tip + size * 1.6 : tip - size * 1.6
      ctx.fillStyle = col
      ctx.strokeStyle = 'rgba(9,9,11,0.85)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, tip)
      ctx.lineTo(x - size, base)
      ctx.lineTo(x + size, base)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      // 平仓箭头中间挖空，和开仓一眼分开 / close arrows are hollowed so they read apart from opens
      if (!g.kinds.has('open')) {
        ctx.fillStyle = 'rgba(9,9,11,0.9)'
        ctx.beginPath()
        const m = (base - tip) * 0.45
        ctx.moveTo(x, tip + m * 0.9)
        ctx.lineTo(x - size * 0.45, base - m * 0.25)
        ctx.lineTo(x + size * 0.45, base - m * 0.25)
        ctx.closePath()
        ctx.fill()
      }
      if (spacing >= 7) {
        ctx.fillStyle = col
        ctx.textBaseline = up ? 'top' : 'bottom'
        // 合并组写「合计手数 · N 笔」：原来的「0.1×2」常被读成 0.2 手。
        // Merged groups read "total lots · N fills": the old "0.1×2" was read as 0.2 lots.
        const label = g.count > 1 ? `${g.volume} · ${this.fills(g.count)}` : String(g.volume)
        ctx.fillText(label, x, up ? base + 2 : base - 2)
      }
    }
    ctx.restore()
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
  const { t } = useTranslation()
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

  const execs = useMemo(() => executionsFrom(symbol, closed, orders, positions), [symbol, closed, orders, positions])

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
    prim.groups = groupExecutions(execs, barTimes())
    prim.fills = (n) => t('charts.trade.execFills', { n })
    prim.requestUpdate()
  }, [execs, barTimes, dataKey, visible, t])

  return null
}
