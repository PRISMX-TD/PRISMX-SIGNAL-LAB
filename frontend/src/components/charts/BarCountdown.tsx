// K 线收线倒计时：贴在价格轴最新价标签正下方的一小块（如 08:42），和 TradingView 一样。
// 每 250ms 直接改 DOM（不走 React 状态）：既要跟秒走，又要跟着价格轴缩放、拖动时最新价
// 标签的位置走，而这些都不会触发 React 渲染。每个值都先和上次写进去的比，变了才写：
// 文字一秒才变一次，位置只在缩放 / 拖动 / 跳价时变，大多数 tick 一个值都不写。纵向
// 位置用 transform: translateY 而不是 top：top 每写一次都要重排，transform 只需合成。
// 时间用服务器校准过的时钟（utils/serverClock），手机时间不准也不会跳。
// 数据延迟（休市 / 断流）时不显示——那时「还有几秒收线」是假的。
// Bar-close countdown: a small tag right under the last-price label on the price
// axis (e.g. 08:42), like TradingView. Updated every 250ms by writing to the DOM
// directly: it must follow both the clock and the label's position as the price
// scale zooms or pans, none of which re-render React. Every value is compared with
// the last one written and written only when it changed: the text changes once a
// second and the position only on zoom / pan / a price move, so most ticks write
// nothing. The vertical position is transform: translateY rather than top, because
// top forces layout on every write while a transform only composites. Uses the
// server-calibrated clock (utils/serverClock). Hidden while the feed is stale
// (closed market / outage).
import { useEffect, useRef } from 'react'
import type { IChartApi } from 'lightweight-charts'
import type { MainSeriesApi } from './useChartEngine'
import type { Candle } from '../../api/types'
import { serverNowMs } from '../../utils/serverClock'
import { barCloseCountdownSec, fmtCountdown, type CandleColors } from './chartConfig'
import { isChartAlive } from './chartLifecycle'

const TICK_MS = 250
// 最新价标签大约 18px 高、以价格为中心；倒计时紧贴在它下面。
// The last-price label is ~18px tall, centred on the price; sit right below it.
const LABEL_HALF_PX = 9

interface Props {
  chart: IChartApi
  series: MainSeriesApi
  interval: string
  candlesRef: { current: Candle[] }
  colors: CandleColors
  stale: boolean
}

export default function BarCountdown({ chart, series, interval, candlesRef, colors, stale }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 上一次写进 DOM 的值，相同就跳过。effect 重跑（换周期 / 换配色 / 数据恢复）时清零，第一次一定写。
    // Values last written to the DOM; equal writes are skipped. Reset whenever the effect
    // re-runs (interval, colours, feed recovery), so the first tick always writes.
    let lastText = ''
    let lastTop = NaN
    let lastWidth = NaN
    let lastBg = ''
    let shown = el.style.display !== 'none'
    const hide = () => {
      if (!shown) return
      el.style.display = 'none'
      shown = false
    }
    if (stale) { hide(); return }
    const tick = () => {
      if (!isChartAlive(chart)) return hide()
      const bars = candlesRef.current
      const last = bars[bars.length - 1]
      if (!last) return hide()
      const sec = barCloseCountdownSec(interval, last.t, serverNowMs())
      const y = series.priceToCoordinate(last.c)
      const paneH = chart.panes()[0]?.getHeight() ?? 0
      const scaleW = chart.priceScale('right').width()
      if (sec == null || y == null || scaleW <= 0 || y < 0 || y + LABEL_HALF_PX + 14 > paneH) return hide()
      const text = fmtCountdown(sec)
      if (text !== lastText) { el.textContent = text; lastText = text }
      const top = Math.round(y + LABEL_HALF_PX)
      if (top !== lastTop) { el.style.transform = `translateY(${top}px)`; lastTop = top }
      if (scaleW !== lastWidth) { el.style.width = `${scaleW}px`; lastWidth = scaleW }
      const bg = last.c >= last.o ? colors.up : colors.down
      if (bg !== lastBg) { el.style.background = bg; lastBg = bg }
      if (!shown) { el.style.display = 'block'; shown = true }
    }
    tick()
    const id = window.setInterval(tick, TICK_MS)
    return () => window.clearInterval(id)
  }, [chart, series, interval, candlesRef, colors, stale])

  return <div ref={ref} className="term-countdown" aria-hidden="true" style={{ display: 'none' }} />
}
