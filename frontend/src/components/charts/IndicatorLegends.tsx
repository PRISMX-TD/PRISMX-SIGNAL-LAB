// 指标图例：主图叠加（MA/EMA/BOLL）一条 + 各副图（成交量/RSI/MACD）各一条，
// 副图图例定位在各自 pane 顶部（偏移量来自 useChartEngine.applyPaneHeights）。
// 2026-09-06 从 pages/ChartsPage.tsx 搬出，内容逐行原样。
// Indicator legends, moved out of ChartsPage verbatim on 2026-09-06.
import { useTranslation } from 'react-i18next'
import type { IndicatorSettings } from './indicatorSettings'
import { fmtLegendNum, type IndicatorFlags, type LegendValues } from './chartConfig'

export default function IndicatorLegends({ indicators, indicatorSettings, legend, paneOffsets, decimals }: {
  indicators: IndicatorFlags
  indicatorSettings: IndicatorSettings
  legend: LegendValues
  paneOffsets: { volume: number | null; rsi: number | null; macd: number | null }
  decimals: number
}) {
  const { t } = useTranslation()
  return (
    <>
      {/* 主图指标图例：留出左侧画图工具栏的宽度 / main-pane indicator legend: clears the draw toolbar on the left */}
      {(indicators.ma || indicators.ema || indicators.boll) && (
        <div className="pointer-events-none absolute left-14 top-3 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-ink-900/40 px-2 py-1 font-mono text-[11px] backdrop-blur-sm">
          {indicators.ma &&
            indicatorSettings.ma.periods.map((p, i) => (
              <span key={`ma${i}`} style={{ color: indicatorSettings.ma.colors[i] }}>
                MA{p} {fmtLegendNum(legend.ma[i], decimals)}
              </span>
            ))}
          {indicators.ema &&
            indicatorSettings.ema.periods.map((p, i) => (
              <span key={`ema${i}`} style={{ color: indicatorSettings.ema.colors[i] }}>
                EMA{p} {fmtLegendNum(legend.ema[i], decimals)}
              </span>
            ))}
          {indicators.boll && (
            <span style={{ color: indicatorSettings.boll.color }}>
              BOLL {fmtLegendNum(legend.boll.upper, decimals)}/{fmtLegendNum(legend.boll.mid, decimals)}/{fmtLegendNum(legend.boll.lower, decimals)}
            </span>
          )}
        </div>
      )}

      {/* 副图图例：定位在各自 pane 顶部，偏移量由 applyPaneHeights 算出 */}
      {/* Sub-pane legends: positioned at the top of their own pane; offsets computed by applyPaneHeights */}
      {indicators.volume && paneOffsets.volume != null && (
        <div
          className="pointer-events-none absolute left-3 z-20 rounded-md bg-ink-900/40 px-2 py-0.5 font-mono text-[11px] text-neutral-300 backdrop-blur-sm"
          style={{ top: paneOffsets.volume + 6 }}
        >
          {t('charts.indicators.volume')} {legend.volume != null ? Math.round(legend.volume).toLocaleString() : '—'}
        </div>
      )}
      {indicators.rsi && paneOffsets.rsi != null && (
        <div
          className="pointer-events-none absolute left-3 z-20 rounded-md bg-ink-900/40 px-2 py-0.5 font-mono text-[11px] backdrop-blur-sm"
          style={{ top: paneOffsets.rsi + 6, color: indicatorSettings.rsi.color }}
        >
          RSI({indicatorSettings.rsi.period}) {fmtLegendNum(legend.rsi, 2)}
        </div>
      )}
      {indicators.macd && paneOffsets.macd != null && (
        <div
          className="pointer-events-none absolute left-3 z-20 flex gap-2 rounded-md bg-ink-900/40 px-2 py-0.5 font-mono text-[11px] backdrop-blur-sm"
          style={{ top: paneOffsets.macd + 6 }}
        >
          <span style={{ color: indicatorSettings.macd.macdColor }}>MACD {fmtLegendNum(legend.macd.macd, 4)}</span>
          <span style={{ color: indicatorSettings.macd.signalColor }}>Sig {fmtLegendNum(legend.macd.signal, 4)}</span>
          <span style={{ color: legend.macd.hist != null && legend.macd.hist >= 0 ? 'var(--up)' : 'var(--down)' }}>
            Hist {fmtLegendNum(legend.macd.hist, 4)}
          </span>
        </div>
      )}
    </>
  )
}
