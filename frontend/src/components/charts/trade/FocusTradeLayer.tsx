// 交易报告里点过来的那一单：把它的开平点画在主图上（和成交标记同一种画法：虚线连开平两头，
// 开仓箭头实心、平仓箭头挖空），顶部一条小标签说明这是哪一单，可以关掉。
// 不看「成交标记」开关、也不看账号——这是用户点名要看的一单；价位来自报告本身。
// 旧存档的报告没有成交价：画不了，只留标签并说明原因（定位仍然有效）。
// The trade the user opened from the trading report: drawn on the main series like an execution
// marker (dashed entry→exit line, solid entry arrow, hollow exit arrow) plus a small dismissible
// label saying which trade it is. Independent of the executions switch and of the account — the
// prices come from the report. Reports archived before fill prices were kept can't be drawn: the
// label stays and says so (the jump to the entry time still happened).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IChartApi } from 'lightweight-charts'
import type { MainSeriesApi } from '../useChartEngine'
import { isChartAlive } from '../chartLifecycle'
import { ExecPrimitive } from './ExecutionMarkers'
import { focusLeg, focusPhase, type FocusPhase, type FocusTrade } from './focusTrade'
import { fmtSigned, placeLegs } from './tradeMath'

interface Props {
  chart: IChartApi
  series: MainSeriesApi
  trade: FocusTrade
  barTimes: () => number[]
  /** K 线数据变化的信号（新 K 线、换周期、补历史）/ changes when the bars change */
  dataKey: string
  /** 价格类图表（砖形等）横轴不是时间，不画线 / price-based charts have no time axis: no line */
  drawable: boolean
  fmtTime: (ts: number) => string
  onClose: () => void
  /** 「回放这一单」：从开仓前几根开始一根一根放。回放进行中不给（按钮收起）。
   *  "Replay this trade": bar by bar from just before the entry; absent while a replay runs. */
  onReplay?: () => void
  /** 正在回放这一单：开仓那根还没放到就不画，平仓那根还没放到只画开仓，盈亏也先不说。
   *  Replaying this trade: nothing before the entry bar, entry only before the exit bar, no P&L yet. */
  replaying?: boolean
}

export default function FocusTradeLayer({ chart, series, trade, barTimes, dataKey, drawable, fmtTime, onClose, onReplay, replaying = false }: Props) {
  const { t } = useTranslation()
  const primRef = useRef<ExecPrimitive | null>(null)
  const leg = useMemo(() => focusLeg(trade), [trade])
  const [phase, setPhase] = useState<FocusPhase>('closed')

  useEffect(() => {
    if (!drawable || !leg) return
    const prim = new ExecPrimitive()
    primRef.current = prim
    series.attachPrimitive(prim as never)
    return () => {
      primRef.current = null
      if (!isChartAlive(chart)) return
      try { series.detachPrimitive(prim as never) } catch { /* already detached */ }
    }
  }, [chart, series, drawable, leg])

  // 这一单多半比已加载的 K 线早：跳过去时才往左补历史，补进来之后要重新落位（dataKey 不会因为
  // 补历史而变）。可视范围一变就看一眼 K 线的根数和最早一根，变了才重算。
  // The trade is usually older than the loaded bars: history is paged in during the jump, and the
  // trade must be re-placed once it arrives (dataKey doesn't change for that). On every visible-range
  // change, compare the bar count and the earliest bar and re-place only when they moved.
  useEffect(() => {
    const prim = primRef.current
    if (!prim || !leg) return
    let stamp = ''
    const place = () => {
      const times = barTimes()
      const next = `${times.length}:${times[0] ?? 0}`
      if (next === stamp) return
      stamp = next
      const ph = replaying ? focusPhase(times, leg.t1, leg.t2) : 'closed'
      setPhase(ph)
      prim.legs = ph === 'before' ? [] : placeLegs([ph === 'open' ? { ...leg, t2: null, p2: null, profit: null } : leg], times)
      prim.requestUpdate()
    }
    place()
    const ts = chart.timeScale()
    ts.subscribeVisibleLogicalRangeChange(place)
    return () => {
      if (!isChartAlive(chart)) return
      try { ts.unsubscribeVisibleLogicalRangeChange(place) } catch { /* chart gone */ }
    }
  }, [chart, leg, barTimes, dataKey, drawable, replaying])

  const side = t(trade.side === 'BUY' ? 'persona.side.buy' : 'persona.side.sell')
  const pnl = trade.profit == null || (replaying && phase !== 'closed') ? null : fmtSigned(trade.profit)
  return (
    <div className="chart-focus" role="status">
      <div className="chart-focus-main">
        <span className="chart-focus-ttl">{t('charts.focus.title')}</span>
        <span className="chart-focus-body">
          <b className={trade.side === 'BUY' ? 'is-up' : 'is-down'}>{side}</b>
          <span className="num">{fmtTime(trade.t1)}</span>
          {pnl != null && <b className={`num ${trade.profit! > 0 ? 'is-up' : trade.profit! < 0 ? 'is-down' : ''}`}>{pnl}</b>}
        </span>
        {!leg && <span className="chart-focus-note">{t('charts.focus.noPrice')}</span>}
      </div>
      {onReplay && leg && (
        <button type="button" className="chart-focus-replay" onClick={onReplay} title={String(t('charts.focus.replayHint'))}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>
          {t('charts.focus.replay')}
        </button>
      )}
      <button type="button" onClick={onClose} aria-label={String(t('charts.focus.close'))} title={String(t('charts.focus.close'))}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  )
}
