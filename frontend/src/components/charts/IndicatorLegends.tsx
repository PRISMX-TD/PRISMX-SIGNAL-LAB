// 指标图例：主图叠加（所有开启的主图指标）一条 + 各副图各一条，副图图例定位在各自
// pane 顶部（偏移量来自 useChartEngine.applyPaneHeights）。内容按 indicatorCatalog 的
// series 描述渲染：缩写 + 线标签 + 当前值，颜色与线同色。
// Indicator legends: one line for every enabled main-pane overlay plus one per
// sub-pane, positioned at each pane's top (offsets from applyPaneHeights). Driven
// by the catalog's series specs: abbreviation + line label + value, in line color.
import type { IndicatorSettings } from './indicatorSettings'
import { INDICATOR_META, MAIN_IDS, SUB_IDS, legendDigits, seriesSpecs, type IndicatorId } from './indicatorCatalog'
import { fmtLegendNum, type IndicatorFlags, type LegendValues } from './chartConfig'

export default function IndicatorLegends({ indicators, indicatorSettings, legend, paneOffsets, decimals }: {
  indicators: IndicatorFlags
  indicatorSettings: IndicatorSettings
  legend: LegendValues
  paneOffsets: Partial<Record<IndicatorId, number>>
  decimals: number
}) {
  const items = (id: IndicatorId) => {
    const digits = legendDigits(id, decimals)
    const row = legend[id] ?? {}
    return seriesSpecs(id, indicatorSettings)
      // 超级趋势两条线互斥，只显示当前有值的那条 / SuperTrend: show whichever segment has a value
      .filter((sp) => !(id === 'st' && row[sp.key] == null && Object.values(row).some((v) => v != null)))
      .map((sp) => {
        const v = row[sp.key]
        const text = digits === 0 && v != null ? Math.round(v).toLocaleString() : fmtLegendNum(v, digits)
        return (
          <span key={sp.key} style={{ color: sp.kind === 'hist' && sp.histColor === 'sign' ? (v != null && v >= 0 ? 'var(--up)' : 'var(--down)') : sp.color }}>
            {INDICATOR_META[id].abbr}{sp.label ? ` ${sp.label}` : ''} {text}
          </span>
        )
      })
  }
  const mainOn = MAIN_IDS.filter((id) => indicators[id])
  return (
    <>
      {mainOn.length > 0 && (
        <div className="term-legend main">{mainOn.map((id) => items(id))}</div>
      )}
      {SUB_IDS.map((id) => {
        const top = paneOffsets[id]
        if (!indicators[id] || top == null) return null
        return (
          <div key={id} className="term-legend" style={{ left: 12, top: top + 6 }}>{items(id)}</div>
        )
      })}
    </>
  )
}
