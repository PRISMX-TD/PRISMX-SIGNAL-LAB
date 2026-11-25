// 区域放大（TradingView 左栏的放大镜）：打开后在图上横向拖出一段，松手就把时间轴缩放到这段；
// 每放大一次记下之前的可见范围，左栏的「缩小」按钮逐级退回。Esc 或右键取消。
// Zoom-in area (the magnifier on TradingView's left bar): while on, drag across the chart and
// the time axis zooms to that span on release; each zoom remembers the previous visible range
// so the bar's zoom-out button steps back. Escape or a right click cancels.
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { IChartApi, LogicalRange } from 'lightweight-charts'

export function ProZoomBox({ chartRef, hostRef, onZoom, onCancel }: {
  chartRef: RefObject<IChartApi | null>
  // 图表容器（坐标换算以它的左边为 0）/ the chart container (x is measured from its left edge)
  hostRef: RefObject<HTMLElement | null>
  onZoom: (prev: LogicalRange) => void
  onCancel: () => void
}) {
  const [box, setBox] = useState<{ x0: number; x1: number } | null>(null)
  const drag = useRef<{ x0: number; id: number } | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  const localX = (clientX: number) => clientX - (hostRef.current?.getBoundingClientRect().left ?? 0)
  return (
    <div
      className="pt-zoom"
      onContextMenu={(e) => { e.preventDefault(); onCancel() }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        const x = localX(e.clientX)
        drag.current = { x0: x, id: e.pointerId }
        setBox({ x0: x, x1: x })
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        setBox({ x0: d.x0, x1: localX(e.clientX) })
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        setBox(null)
        if (!d || d.id !== e.pointerId) return
        const x1 = localX(e.clientX)
        const c = chartRef.current
        if (!c || Math.abs(x1 - d.x0) < 8) return
        const ts = c.timeScale()
        const prev = ts.getVisibleLogicalRange()
        const a = ts.coordinateToLogical(Math.min(d.x0, x1))
        const b = ts.coordinateToLogical(Math.max(d.x0, x1))
        if (prev == null || a == null || b == null || b - a < 2) return
        ts.setVisibleLogicalRange({ from: a, to: b })
        onZoom(prev)
      }}
      onPointerCancel={() => { drag.current = null; setBox(null) }}
    >
      {box && <i style={{ left: Math.min(box.x0, box.x1), width: Math.abs(box.x1 - box.x0) }} />}
    </div>
  )
}
