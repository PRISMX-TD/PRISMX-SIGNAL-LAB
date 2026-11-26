// 数据窗口（对标 TradingView 的 Data Window）：十字线所在那根（没悬停时是最新一根）的
//   品种 · 周期、日期时间、开 高 低 收、涨跌额 / 涨跌幅（对上一根收盘）、tick 成交量；
//   对比品种各一行；再往下每个指标一节：名字 + 参数，各条线的值用线色。
// 自己订阅 ohlcStore / legendStore（引擎里两个外部 store，十字线拖动只重渲染这个面板）。
// 输入都是普通 props，页面把当前活动窗格的 store 和指标列表传进来即可；专业版右侧面板（≥240px）
// 和手机底部抽屉都能放。
// Data window (TradingView's): for the crosshair bar (the latest one otherwise) the symbol ·
// interval, date / time, O H L C, change and change % vs the previous close, tick volume; one row
// per compare symbol; then a section per indicator: name + arguments and each plot's value in the
// plot colour. Subscribes to ohlcStore / legendStore itself (the engine's external stores), so
// crosshair drags re-render only this panel. Plain props: the page feeds the active pane's stores
// and indicator list. Fits the pro right panel (≥240px) and the phone sheet.
import { memo, useMemo } from 'react'
import type { UTCTimestamp } from 'lightweight-charts'
import { useTranslation } from 'react-i18next'
import { dirColorsOf, type CandleColors } from '../chartConfig'
import { makeTimeFormatters } from '../chartTime'
import { intervalKind, intervalLabel } from '../intervals'
import { useLegend, type LegendStore } from '../legendStore'
import { useOhlc, type OhlcStore } from '../ohlcStore'
import { fmtVol } from '../ChartLegend'
import { fmtVal } from '../ind/PaneLegends'
import { defOf } from '../ind/registry'
import { instArgs } from '../ind/style'
import type { IndInstance } from '../ind/types'
import SymbolLogo from '../pro/SymbolLogo'
import { EMPTY } from '../../../utils/format'
import { barChange, indicatorRows } from './dataWindowRows'
import '../../../styles/chart-datawin.css'

export interface DataWindowCompare {
  symbol: string
  color: string
  /** 十字线那一刻的值（没有为 null）/ value at the crosshair time (null when none) */
  value: number | null
  decimals?: number
}

export interface DataWindowProps {
  ohlcStore: OhlcStore
  legendStore: LegendStore
  /** 实际画在图上的指标实例（会员过滤后，同 PaneLegends 的 list）/ instances actually drawn (same list PaneLegends gets) */
  list: IndInstance[]
  symbol: string
  interval: string
  decimals: number
  /** 图表时区（ChartPrefs.timezone）/ the chart's timezone pref */
  timezone: string
  /** K 线颜色：指标 'up' / 'down' 色与涨跌提示色从这里来 / candle colours: indicator up/down colours and the change cue */
  candle: CandleColors
  compare?: DataWindowCompare[]
  className?: string
}

function DataWindow({ ohlcStore, legendStore, list, symbol, interval, decimals, timezone, candle, compare, className = '' }: DataWindowProps) {
  const { t, i18n } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const row = useOhlc(ohlcStore)
  const legend = useLegend(legendStore)
  const fmt = useMemo(() => makeTimeFormatters(timezone, intervalKind(interval), i18n.language), [timezone, interval, i18n.language])
  const dir = dirColorsOf(candle)
  const ch = barChange(row)
  const chCol = ch == null ? undefined : ch.chg >= 0 ? dir.up : dir.down
  const f = (v: number) => v.toFixed(decimals)
  const inds = useMemo(() => indicatorRows(list, legend, candle, defOf), [list, legend, candle])
  const srcName = (v: string) => {
    if (!v.startsWith('ind:')) return tt(`charts.ind.src.${v}`)
    const ref = list.find((i) => i.uid === v.split(':')[1])
    return ref ? defOf(ref.type)?.abbr ?? '' : ''
  }

  return (
    <section className={`dw ${className}`} aria-label={tt('charts.datawin.title')}>
      <header className="dw-hd">
        <SymbolLogo symbol={symbol} size={18} />
        <b>{symbol || EMPTY}</b>
        <span>{intervalLabel(interval)}</span>
        {row?.hovering === false && <em>{tt('charts.datawin.latest')}</em>}
      </header>
      <dl className="dw-tbl">
        <div><dt>{tt('charts.datawin.time')}</dt><dd className="dw-t">{row ? fmt.crosshair(row.t as UTCTimestamp) : EMPTY}</dd></div>
        <div><dt>{tt('charts.datawin.open')}</dt><dd>{row ? f(row.o) : EMPTY}</dd></div>
        <div><dt>{tt('charts.datawin.high')}</dt><dd>{row ? f(row.h) : EMPTY}</dd></div>
        <div><dt>{tt('charts.datawin.low')}</dt><dd>{row ? f(row.l) : EMPTY}</dd></div>
        <div><dt>{tt('charts.datawin.close')}</dt><dd style={{ color: chCol }}>{row ? f(row.c) : EMPTY}</dd></div>
        <div>
          <dt>{tt('charts.datawin.change')}</dt>
          <dd style={{ color: chCol }}>
            {ch == null ? EMPTY : `${ch.chg >= 0 ? '+' : '−'}${f(Math.abs(ch.chg))}`}
            {ch?.pct != null && <small> ({ch.pct >= 0 ? '+' : '−'}{Math.abs(ch.pct).toFixed(2)}%)</small>}
          </dd>
        </div>
        <div><dt>{tt('charts.datawin.volume')}</dt><dd>{row ? fmtVol(row.v) : EMPTY}</dd></div>
      </dl>
      {compare && compare.length > 0 && (
        <div className="dw-sec">
          <h3>{tt('charts.datawin.compare')}</h3>
          <dl className="dw-tbl">
            {compare.map((c) => (
              <div key={c.symbol}>
                <dt><i className="dw-sw" style={{ background: c.color }} />{c.symbol}</dt>
                <dd style={{ color: c.color }}>{c.value == null || !Number.isFinite(c.value) ? EMPTY : c.value.toFixed(c.decimals ?? decimals)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {inds.map((r) => {
        const args = instArgs(r.def, r.inst, srcName)
        return (
          <div key={r.uid} className={`dw-sec ${r.hidden ? 'off' : ''}`}>
            <h3 title={tt(`charts.ind.name.${r.def.id}`, { defaultValue: r.def.abbr })}>
              {r.def.abbr}{args && <span> {args}</span>}{r.inst.tf ? <span> · {r.inst.tf}</span> : null}
              {r.hidden && <em>{tt('charts.datawin.hidden')}</em>}
            </h3>
            {r.plots.length > 0 && (
              <dl className="dw-tbl">
                {r.plots.map((p) => (
                  <div key={p.key}>
                    <dt><i className="dw-sw" style={{ background: p.color }} />{tt(`charts.ind.plot.${p.label}`, { defaultValue: p.label })}</dt>
                    <dd style={{ color: p.color }}>{fmtVal(p.value, r.def, r.inst, decimals)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )
      })}
      {list.length === 0 && <p className="dw-empty">{tt('charts.datawin.noInd')}</p>}
    </section>
  )
}

export default memo(DataWindow)
