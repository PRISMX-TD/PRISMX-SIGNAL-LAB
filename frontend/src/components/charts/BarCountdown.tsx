// K 线收线倒计时：贴在价格轴最新价标签正下方的一小块（如 08:42），和 TradingView 一样。
// 每 250ms 直接改 DOM（不走 React 状态）：既要跟秒走，又要跟着价格轴缩放、拖动时最新价
// 标签的位置走，而这些都不会触发 React 渲染；一秒四次写两个样式值的代价可以忽略。
// 时间用服务器校准过的时钟（utils/serverClock），手机时间不准也不会跳。
// 数据延迟（休市 / 断流）时不显示——那时「还有几秒收线」是假的。
// Bar-close countdown: a small tag right under the last-price label on the price
// axis (e.g. 08:42), like TradingView. Updated every 250ms by writing to the DOM
// directly: it must follow both the clock and the label's position as the price
// scale zooms or pans, none of which re-render React. Uses the server-calibrated
// clock (utils/serverClock). Hidden while the feed is stale (closed market / outage).
import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
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
  series: ISeriesApi<'Candlestick'>
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
    const hide = () => { el.style.display = 'none' }
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
      el.textContent = fmtCountdown(sec)
      el.style.top = `${Math.round(y + LABEL_HALF_PX)}px`
      el.style.width = `${scaleW}px`
      el.style.background = last.c >= last.o ? colors.up : colors.down
      el.style.display = 'block'
    }
    tick()
    const id = window.setInterval(tick, TICK_MS)
    return () => window.clearInterval(id)
  }, [chart, series, interval, candlesRef, colors, stale])

  return <div ref={ref} className="term-countdown" aria-hidden="true" style={{ display: 'none' }} />
}
