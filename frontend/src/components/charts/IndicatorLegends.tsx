// 指标图例：主图叠加（所有开启的主图指标）一条 + 各副图各一条，副图图例定位在各自
// pane 顶部（偏移量来自 useChartEngine.applyPaneHeights）。内容按 indicatorCatalog 的
// series 描述渲染：缩写 + 线标签 + 当前值，颜色与线同色。
// Indicator legends: one line for every enabled main-pane overlay plus one per
// sub-pane, positioned at each pane's top (offsets from applyPaneHeights). Driven
// by the catalog's series specs: abbreviation + line label + value, in line color.
import { memo } from 'react'
import type { IndicatorSettings } from './indicatorSettings'
import { INDICATOR_META, MAIN_IDS, SUB_IDS, legendDigits, seriesSpecs, type IndicatorId } from './indicatorCatalog'
import { fmtLegendNum, type IndicatorFlags } from './chartConfig'
import { useLegend, type LegendStore } from './legendStore'

function IndicatorLegends({ indicators, indicatorSettings, legendStore, paneOffsets, decimals }: {
  indicators: IndicatorFlags
  indicatorSettings: IndicatorSettings
  legendStore: LegendStore
  paneOffsets: Partial<Record<IndicatorId, number>>
  decimals: number
}) {
  // 图例数值自己订阅（见 legendStore.ts）：十字线拖动只重渲染这里，不牵动图表页。
  // Subscribes to the legend values itself (see legendStore.ts): crosshair drags
  // re-render only this component, not the charts page.
  const legend = useLegend(legendStore)
  const items = (id: IndicatorId) => {
    const digits = legendDigits(id, decimals)
    const row = legend[id] ?? {}
    return seriesSpecs(id, indicatorSettings)
      .filter((sp) => !sp.gaps)
      // 超级趋势两条线互斥，只显示当前有值的那条 / SuperTrend: show whichever segment has a value
      .filter((sp) => !(id === 'st' && row[sp.key] == null && Object.values(row).some((v) => v != null)))
      .map((sp) => {
        const v = row[sp.key]
        const text = digits === 0 && v != null ? Math.round(v).toLocaleString() : fmtLegendNum(v, digits)
        return (
          // key 必须带指标 id 前缀：主图那条图例把所有开启的主图指标平铺在同一个
          // 父节点下，而 sp.key 只在单个指标内唯一——VWAP 与 SAR 都是 'v'，MA 与
          // EMA 都是 '0'/'1'/'2'，BOLL 与 DONCH 都有 'upper'/'lower'。同时开这些
          // 组合就会出现重复 key，React 可能复用错节点（值串到别的指标上）。
          // Prefix the key with the indicator id: the main legend flattens every
          // enabled overlay into one parent, and sp.key is only unique within a
          // single indicator (VWAP and SAR both use 'v', MA and EMA both use
          // '0'/'1'/'2', BOLL and DONCH both have 'upper'/'lower').
          <span key={`${id}:${sp.key}`} style={{ color: sp.kind === 'hist' && sp.histColor === 'sign' ? (v != null && v >= 0 ? 'var(--up)' : 'var(--down)') : sp.color }}>
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

// memo：父级（ChartsPage）因别的原因重渲染时，指标开关 / 设置 / pane 偏移都没变就不重画。
// memo: when ChartsPage re-renders for other reasons, unchanged flags / settings / offsets skip this.
export default memo(IndicatorLegends)
