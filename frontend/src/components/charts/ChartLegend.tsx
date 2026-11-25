// 主图状态行（TradingView 的 status line）：品种 · 周期 · 图表类型，后面是十字线所在那根
// （没悬停时是最新一根）的 开 高 低 收、涨跌额 / 涨跌幅、成交量。数值自己订阅 ohlcStore，
// 十字线拖动只重渲染这一行。各段显隐来自设置 → 状态行。
// Main status line (TradingView's): symbol · interval · chart type, then O H L C, change /
// change % and volume of the hovered bar (the latest one otherwise). Subscribes to
// ohlcStore itself, so crosshair drags re-render only this line. Each part's visibility
// comes from Settings → Status line.
import { memo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChartPrefs, ChartType } from './chartPrefs'
import { intervalLabel } from './intervals'
import { useOhlc, type OhlcStore } from './ohlcStore'

function fmtVol(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}K`
  return String(Math.round(v))
}

function ChartLegend({ store, symbol, interval, chartType, decimals, legend, colors }: {
  store: OhlcStore
  symbol: string
  interval: string
  chartType: ChartType
  decimals: number
  legend: ChartPrefs['legend']
  colors: { up: string; down: string }
}) {
  const { t } = useTranslation()
  const row = useOhlc(store)
  // 状态行窄屏会换成两三行：把实际高度写到 .term-chart 的 --status-h，主图指标图例跟着往下排。
  // On narrow screens the line wraps to two or three rows: its real height goes into
  // .term-chart's --status-h so the main-pane indicator legend sits below it.
  const ref = useRef<HTMLDivElement>(null)
  const shown = legend.title || legend.ohlc || legend.change || legend.volume
  useEffect(() => {
    const el = ref.current
    const host = el?.parentElement
    if (!el || !host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => host.style.setProperty('--status-h', `${el.offsetHeight}px`))
    ro.observe(el)
    return () => { ro.disconnect(); host.style.removeProperty('--status-h') }
  }, [shown])
  if (!shown) return null
  const f = (v: number) => v.toFixed(decimals)
  const base = row ? (row.prev ?? row.o) : null
  const chg = row && base != null ? row.c - base : null
  const pct = chg != null && base ? (chg / base) * 100 : null
  const col = chg == null ? undefined : chg >= 0 ? colors.up : colors.down
  return (
    <div ref={ref} className="term-status" aria-live="off">
      {legend.title && (
        <span className="term-status-ttl">
          <b>{symbol}</b>
          <i>·</i>{intervalLabel(interval)}
          {chartType !== 'candles' && <><i>·</i>{t(`charts.type.${chartType}`)}</>}
        </span>
      )}
      {row && legend.ohlc && (
        <span className="term-status-ohlc" style={{ color: col }}>
          <em>{t('charts.legend.o')}</em>{f(row.o)}
          <em>{t('charts.legend.h')}</em>{f(row.h)}
          <em>{t('charts.legend.l')}</em>{f(row.l)}
          <em>{t('charts.legend.c')}</em>{f(row.c)}
        </span>
      )}
      {row && legend.change && chg != null && (
        <span style={{ color: col }}>
          {chg >= 0 ? '+' : '−'}{f(Math.abs(chg))} ({pct != null ? `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%` : '—'})
        </span>
      )}
      {row && legend.volume && (
        <span><em>{t('charts.legend.vol')}</em>{fmtVol(row.v)}</span>
      )}
    </div>
  )
}

export default memo(ChartLegend)
