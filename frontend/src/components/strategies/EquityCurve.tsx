// 净值曲线：纯 SVG，不引图表库。一条折线加一条本金基准虚线就够了，为此拉起
// lightweight-charts 的一个实例（含 canvas 与 ResizeObserver）不划算——回测面板
// 里已经有一个真正需要它的 K 线图。
// 由 StrategiesPage.tsx 内的同名页内函数搬出，实现未改，只是成为可复用组件。
//
// Equity curve as plain SVG, no charting library. A single polyline plus a
// dashed capital baseline doesn't justify spinning up a lightweight-charts
// instance (canvas + ResizeObserver); the backtest panel already has one
// candlestick chart that genuinely needs it. Lifted verbatim from the page-local
// function of the same name in StrategiesPage.tsx.
import { useTranslation } from 'react-i18next'

const CURVE_W = 600
const CURVE_H = 180

export interface EquityCurveProps {
  // 只用到 equity 字段，故不要求传完整的 points 元素类型——回测响应的 points
  // 带 t，样本内外分段的调用方可能只有净值。
  // Only `equity` is read, so the full points element type isn't required: the
  // backtest response's points carry `t`, while other callers may hold equity
  // values alone.
  points: Array<{ equity: number }>
  capital: number
}

export default function EquityCurve({ points, capital }: EquityCurveProps) {
  const { t } = useTranslation()
  if (points.length < 2) return null
  const values = [...points.map((p) => p.equity), capital]
  const lo = Math.min(...values) * 0.98
  const hi = Math.max(...values) * 1.02
  const span = hi - lo || 1
  const y = (v: number) => CURVE_H - ((v - lo) / span) * CURVE_H
  const x = (i: number) => (i * CURVE_W) / (points.length - 1)
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ')
  const last = points[points.length - 1].equity
  const toneClass = last >= capital ? 'text-up' : 'text-down'
  const baselineY = y(capital)
  return (
    <div className={toneClass}>
      {/* 图形本身传达的信息（终值高于/低于本金）不能只靠颜色：给 role="img" 配一句
          文字描述，读屏与色觉障碍用户都能拿到结论。
          The message the shape carries (final equity above/below capital) must not
          rely on color alone: role="img" gets a text description so screen-reader
          and color-blind users get the conclusion too. */}
      <svg
        viewBox={`0 0 ${CURVE_W} ${CURVE_H}`}
        className="w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={t('simulator.equityCurve')}
      >
        <line x1="0" y1={baselineY} x2={CURVE_W} y2={baselineY} stroke="currentColor" strokeOpacity="0.25" strokeWidth="1" strokeDasharray="4 4" className="text-slate-400" />
        <polyline fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={line} vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="mt-1 text-[11px] text-slate-500">
        {t('simulator.baseline')} {capital.toLocaleString('en-US')} · {t('simulator.finalEquity')}{' '}
        {last.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
    </div>
  )
}
