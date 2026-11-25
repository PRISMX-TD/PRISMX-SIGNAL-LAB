// 主图上的附加价格线（设置 → 坐标与线）：买价 / 卖价线、可见区最高 / 最低价、昨收。
// 都是主序列上的 price line，带价格轴标签；不画任何 DOM。
// · 买 / 卖价：跟着全站报价（只订阅当前品种一条），颜色同 TradingView（买蓝卖红）。
// · 最高 / 最低：当前可见范围内图上 K 线的最高最低，拖动 / 缩放时更新（每帧最多一次）。
// · 昨收：上一个券商交易日的最后收盘（日线及以上 = 上一根的收盘）。
// Extra price lines on the main pane (Settings → Scales & lines): bid / ask, visible high /
// low and previous close. All are price lines on the main series with axis labels; no DOM.
// · Bid / ask follow the site-wide quote for this symbol only; TradingView colours.
// · High / low: of the bars in the visible range, updated on scroll / zoom (once per frame).
// · Previous close: the last close of the previous broker trading day (daily+ = previous bar).
import { useEffect, useRef } from 'react'
import { LineStyle, type IChartApi, type IPriceLine } from 'lightweight-charts'
import type { Candle } from '../../api/types'
import type { MainSeriesApi } from './useChartEngine'
import type { ChartPalette } from './chartTheme'
import { brokerOffsetSec, intervalKind } from './intervals'
import { useGlobalQuote } from '../../store/live'
import type { MainBar } from './mainSeries'

const DAY = 86400

export function prevSessionClose(bars: readonly Candle[], interval: string, now = Date.now() / 1000): number | null {
  if (bars.length < 2) return null
  if (intervalKind(interval) !== 'intraday') return bars[bars.length - 2].c
  const off = brokerOffsetSec(now)
  const b = now + off
  const dayStart = b - (((b % DAY) + DAY) % DAY) - off
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].t < dayStart) return bars[i].c
  return null
}

interface Props {
  chart: IChartApi
  series: MainSeriesApi
  symbol: string
  interval: string
  candlesRef: { current: Candle[] }
  palette: ChartPalette
  bidAsk: boolean
  highLow: boolean
  prevClose: boolean
  labels: { bid: string; ask: string; high: string; low: string; prev: string }
}

function useLine(series: MainSeriesApi, on: boolean, color: string, title: string, style: LineStyle) {
  const ref = useRef<IPriceLine | null>(null)
  useEffect(() => {
    if (!on) return
    const pl = series.createPriceLine({ price: 0, color, lineWidth: 1, lineStyle: style, axisLabelVisible: false, title, lineVisible: false })
    ref.current = pl
    return () => { try { series.removePriceLine(pl) } catch { /* 图表已销毁 / chart gone */ } ref.current = null }
  }, [series, on, color, title, style])
  return ref
}

function setLine(ref: { current: IPriceLine | null }, price: number | null) {
  const pl = ref.current
  if (!pl) return
  if (price == null || !Number.isFinite(price)) pl.applyOptions({ lineVisible: false, axisLabelVisible: false })
  else pl.applyOptions({ price, lineVisible: true, axisLabelVisible: true })
}

export default function ChartPriceLines({ chart, series, symbol, interval, candlesRef, palette, bidAsk, highLow, prevClose, labels }: Props) {
  const q = useGlobalQuote(bidAsk ? symbol : '')
  const bidRef = useLine(series, bidAsk, palette.bid, labels.bid, LineStyle.Dotted)
  const askRef = useLine(series, bidAsk, palette.ask, labels.ask, LineStyle.Dotted)
  const hiRef = useLine(series, highLow, palette.muted, labels.high, LineStyle.Dashed)
  const loRef = useLine(series, highLow, palette.muted, labels.low, LineStyle.Dashed)
  const pcRef = useLine(series, prevClose, palette.muted, labels.prev, LineStyle.LargeDashed)

  useEffect(() => {
    if (!bidAsk) return
    setLine(bidRef, q?.bid ?? null)
    setLine(askRef, q?.ask ?? null)
  }, [bidAsk, q?.bid, q?.ask, bidRef, askRef])

  // 可见区最高 / 最低 / visible high / low
  useEffect(() => {
    if (!highLow) return
    let raf = 0
    const run = () => {
      raf = 0
      const r = chart.timeScale().getVisibleLogicalRange()
      const data = series.data() as readonly (MainBar | { time: unknown })[]
      if (!r || data.length === 0) { setLine(hiRef, null); setLine(loRef, null); return }
      const from = Math.max(0, Math.floor(r.from))
      const to = Math.min(data.length - 1, Math.ceil(r.to))
      let hi = -Infinity
      let lo = Infinity
      for (let i = from; i <= to; i++) {
        const b = data[i] as MainBar
        if (b.high == null) continue
        if (b.high > hi) hi = b.high
        if (b.low < lo) lo = b.low
      }
      setLine(hiRef, hi === -Infinity ? null : hi)
      setLine(loRef, lo === Infinity ? null : lo)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(run) }
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule)
    // 新 K 线 / 跳价也可能刷新最高最低：低频兜底 / ticks can move them too: low-rate fallback
    const id = window.setInterval(schedule, 1500)
    schedule()
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule)
      window.clearInterval(id)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [chart, series, highLow, hiRef, loRef, symbol, interval])

  // 昨收 / previous close
  useEffect(() => {
    if (!prevClose) return
    const run = () => setLine(pcRef, prevSessionClose(candlesRef.current, interval))
    run()
    const id = window.setInterval(run, 5000)
    return () => window.clearInterval(id)
  }, [prevClose, pcRef, candlesRef, interval, symbol])

  return null
}
