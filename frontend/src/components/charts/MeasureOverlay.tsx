// 测量（同 TradingView：Shift+单击图表，或工具条的尺子按钮后单击）：从起点拉到十字线处，
// 显示价差、涨跌幅、根数与时长；再点一下定住，第三下 / Esc 清掉。锚点存「逻辑下标 + 价格」，
// 平移缩放时跟着图走。
// Measure (as in TradingView: Shift+click the chart, or the ruler button then a click): from
// the start to the crosshair, showing price change, %, bar count and duration; a second click
// freezes it, a third / Escape clears it. Anchors are stored as logical index + price, so they
// follow the chart while panning and zooming.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IChartApi, Logical, MouseEventParams, Time } from 'lightweight-charts'
import type { MainSeriesApi } from './useChartEngine'

interface Pt { l: number; p: number }

function fmtDur(sec: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const a = Math.abs(sec)
  if (a < 3600) return t('charts.measure.min', { n: Math.round(a / 60) })
  if (a < 86400 * 2) return t('charts.measure.hour', { n: +(a / 3600).toFixed(1) })
  return t('charts.measure.day', { n: +(a / 86400).toFixed(1) })
}

export default function MeasureOverlay({ chart, series, host, armed, onDone, decimals, barTimes, colors }: {
  chart: IChartApi
  series: MainSeriesApi
  host: HTMLElement
  armed: boolean
  onDone: () => void
  decimals: number
  barTimes: () => number[]
  colors: { up: string; down: string }
}) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const [a, setA] = useState<Pt | null>(null)
  const [b, setB] = useState<Pt | null>(null)
  const [frozen, setFrozen] = useState(false)
  const [, bump] = useState(0)
  const st = useRef({ a, b, frozen, armed })
  st.current = { a, b, frozen, armed }

  const ptAt = (x: number, y: number): Pt | null => {
    const l = chart.timeScale().coordinateToLogical(x)
    const p = series.coordinateToPrice(y)
    return l == null || p == null ? null : { l: Math.round(l), p }
  }

  // 起点 / 定住 / 清除：捕获阶段截 pointerdown，免得同一下被图表当成拖动。
  // Start / freeze / clear: pointerdown in the capture phase so the chart doesn't also pan.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const s = st.current
      if (e.button !== 0) return
      if (!s.a && !(e.shiftKey || s.armed)) return
      const r = host.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      if (x > chart.timeScale().width()) return // 价格轴上不算 / not on the price axis
      // 只在主图里起量：副图（成交量、指标）的纵坐标不是价格。
      // Only start in the main pane: sub-panes (volume, indicators) are not on the price scale.
      if (!s.a && y > (chart.panes()[0]?.getHeight() ?? Infinity)) return
      e.preventDefault(); e.stopPropagation()
      if (!s.a || s.frozen) {
        if (s.frozen) { setA(null); setB(null); setFrozen(false); onDone(); return }
        const p = ptAt(x, y)
        if (p) { setA(p); setB(p) }
      } else {
        setFrozen(true)
      }
    }
    host.addEventListener('pointerdown', onDown, true)
    return () => host.removeEventListener('pointerdown', onDown, true)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reads live state from st
  }, [host, chart, series, onDone])

  // 终点跟十字线 / the end follows the crosshair
  useEffect(() => {
    const onMove = (p: MouseEventParams<Time>) => {
      const s = st.current
      if (!s.a || s.frozen || !p.point) return
      const pt = ptAt(p.point.x, p.point.y)
      if (pt) setB(pt)
    }
    chart.subscribeCrosshairMove(onMove)
    const onRange = () => bump((v) => v + 1)
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    return () => { chart.unsubscribeCrosshairMove(onMove); chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- ptAt only closes over chart / series
  }, [chart, series])

  useEffect(() => {
    if (!a) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setA(null); setB(null); setFrozen(false); onDone() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [a, onDone])

  // 切走 / 关掉尺子时清掉 / clear when the ruler is disarmed without a measurement
  useEffect(() => { if (!armed && !a) setFrozen(false) }, [armed, a])

  if (!a || !b) return null
  const ts = chart.timeScale()
  const x1 = ts.logicalToCoordinate(a.l as Logical)
  const x2 = ts.logicalToCoordinate(b.l as Logical)
  const y1 = series.priceToCoordinate(a.p)
  const y2 = series.priceToCoordinate(b.p)
  if (x1 == null || x2 == null || y1 == null || y2 == null) return null
  const d = b.p - a.p
  const pct = a.p ? (d / a.p) * 100 : 0
  const bars = b.l - a.l
  const times = barTimes()
  const tA = times[Math.max(0, Math.min(times.length - 1, a.l))]
  const tB = times[Math.max(0, Math.min(times.length - 1, b.l))]
  const col = d >= 0 ? colors.up : colors.down
  const left = Math.min(x1, x2)
  const top = Math.min(y1, y2)
  return (
    <div className="chart-measure" aria-live="polite">
      <div className="chart-measure-box" style={{ left, top, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), borderColor: col, background: `${col}22` }} />
      <div className="chart-measure-tag" style={{ left: (x1 + x2) / 2, top: d >= 0 ? top - 6 : top + Math.abs(y2 - y1) + 6, transform: d >= 0 ? 'translate(-50%, -100%)' : 'translate(-50%, 0)', background: col }}>
        <span>{d >= 0 ? '+' : '−'}{Math.abs(d).toFixed(decimals)} ({pct >= 0 ? '+' : '−'}{Math.abs(pct).toFixed(2)}%)</span>
        <span>{tt('charts.measure.bars', { n: bars })}{tA != null && tB != null ? `, ${fmtDur(tB - tA, tt)}` : ''}</span>
      </div>
    </div>
  )
}
