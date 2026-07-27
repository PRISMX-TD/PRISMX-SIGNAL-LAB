// 回测面板：参数 → 覆盖度提示 → 运行 → 含成本/不含成本双套结果 → 样本内外两段
// → 过拟合提示 → 逐单明细 → K 线图与交易标记。
//
// 成本双套并列是 spec 的验收标准之一：只给一个含成本的数字，用户无从判断成本
// 到底吃掉了多少，也就无从判断"回测是否可信"这个原始诉求。
//
// 指标线按策略自己的条件推导（见 conditionOverlays.ts）：条件里写 EMA20 就画
// EMA20，不给一套与触发无关的通用指标面板。之前这里完全不画指标，用户看到一堆
// 标记却没有任何可对照的依据。
//
// The backtest panel: params → coverage notice → run → with/without-cost result
// pairs → in/out-of-sample sections → overfit warning → trade table → candles
// with trade markers.
//
// Showing both cost variants side by side is one of the spec's acceptance
// criteria: a single cost-inclusive number leaves the user unable to see how much
// cost ate, which is the original "can I trust the backtest" complaint.
//
// Indicator lines are derived from the strategy's own conditions (see
// conditionOverlays.ts): a condition on EMA20 draws EMA20, rather than offering a
// general indicator panel unrelated to the triggers. This chart previously drew no
// indicators at all, leaving the user with markers and nothing to check them
// against.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  createChart,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createSeriesMarkers,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { strategyApi } from '../../api/client'
import { bollinger, closes, donchianHigh, donchianLow, ema, macd, rsi, sma } from '../../utils/indicators'
import { deriveOverlays, overlayColor, type DerivedOverlay } from './conditionOverlays'
import { fmtDate, localizeApiError } from '../../api/utils'
import CoverageNotice from './CoverageNotice'
import EquityCurve from './EquityCurve'
import { NumberField } from './NumberField'
import type { ConditionPayload } from './conditionTypes'
import type {
  Candle,
  StopLossMethod,
  StrategyBacktestOpenPosition,
  StrategyBacktestResult,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyCoverage,
  StrategySampleSection,
  TakeProfitMethod,
} from '../../api/types'

const UP_COLOR = '#22c55e'
const DOWN_COLOR = '#ef4444'
const PENDING_COLOR = '#fbbf24'
const TRADE_PAGE_SIZE = 20

// 图上交易连线的数量上限。关闭「一次一单」时交易数无上限，而每条连线是一个独立的
// lightweight-charts series（重量级对象），几千条同步创建会锁死主线程、整页卡死。
// 超过此数只画最近 CHART_TRADE_CAP 笔的连线与标记；统计与逐单明细表仍用全量数据，
// 不受影响——上限只作用于「画在图上」这一步。
// Cap on trade lines drawn on the chart. With one-trade-at-a-time off the trade
// count is unbounded, and each line is a separate lightweight-charts series (a
// heavyweight object); creating thousands synchronously locks the main thread and
// freezes the whole page. Past this count only the most recent CHART_TRADE_CAP
// trades get lines and markers; the summary and the paginated trade table still
// use the full set — the cap applies only to what is drawn on the chart.
const CHART_TRADE_CAP = 500

function fmtMoney(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// 时间轴刻度与十字准线的悬浮时间标签是 lightweight-charts 两套独立的格式化配置，
// 都不设会回退成浏览器本地时区/UTC，与全站其它时间显示（UTC+8）对不上。与
// ChartsPage.tsx 的 fmtChartTime 同一实现。
// Tick-mark labels and the crosshair's hover readout are two separate formatting
// hooks; leaving either unset falls back to the browser's timezone/UTC, which
// disagrees with the rest of the site (UTC+8). Same implementation as
// ChartsPage.tsx's fmtChartTime.
function fmtChartTime(time: UTCTimestamp): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time * 1000))
}

// 把含 null（预热期）的指标序列转成折线点，丢掉 null 而不是补 0——补 0 会在图上
// 画一条假的归零线。与 ChartsPage 的 toLinePoints 同一处理。
// Turn an indicator series containing nulls (warm-up) into line points, dropping
// the nulls rather than substituting 0, which would draw a false line down to
// zero. Same handling as ChartsPage's toLinePoints.
function toLinePoints(times: UTCTimestamp[], values: (number | null)[]) {
  const out: { time: UTCTimestamp; value: number }[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v != null) out.push({ time: times[i], value: v })
  }
  return out
}

interface BacktestChartProps {
  bars: Candle[]
  trades: StrategyBacktestTrade[]
  openPositions: StrategyBacktestOpenPosition[]
  // 已勾选要画的指标叠加层，由策略条件推导而来（见 conditionOverlays.ts）。
  // The checked overlays to draw, derived from the strategy conditions.
  overlays: DerivedOverlay[]
  // 每个叠加层在完整列表里的下标 → 颜色，保证勾选状态变化时同一根线不换色。
  // Overlay id → color, keyed off its index in the full list so a line keeps its
  // color as other checkboxes toggle.
  colorOf: (id: string) => string
}

// 回测 K 线图：真实蜡烛 + 条件推导出的指标线 + 每笔交易的入场/出场标记与连线。
// K 线由 strategyApi.backtestBars 拉取，与回测在后端共用同一个取数函数，所以标记
// 的时间戳必然落在蜡烛范围内。此前用的是 chartApi.history（最近 500 根内存缓存），
// 与回测的 days 窗口不是同一段数据，标记因此对不上蜡烛。
// Backtest candlestick chart: real candles + condition-derived indicator lines +
// entry/exit markers and a joining line per trade. Candles come from
// strategyApi.backtestBars, which shares the backend's single bar-loading function
// with the backtest, so marker timestamps are guaranteed to fall inside the
// charted range. It used to use chartApi.history (the newest 500 cached bars), a
// different slice than the backtest's `days` window — which is why the markers
// didn't line up.
function BacktestChart({ bars, trades, openPositions, overlays, colorOf }: BacktestChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || bars.length === 0) return

    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8', attributionLogo: false },
      grid: { vertLines: { color: 'rgba(139, 70, 255, 0.08)' }, horzLines: { color: 'rgba(139, 70, 255, 0.08)' } },
      rightPriceScale: { borderColor: 'rgba(139, 70, 255, 0.15)' },
      timeScale: {
        borderColor: 'rgba(139, 70, 255, 0.15)', timeVisible: true, secondsVisible: false,
        tickMarkFormatter: fmtChartTime,
      },
      localization: { timeFormatter: fmtChartTime },
      crosshair: { mode: 0 },
      // 故意建成一个明显偏小的占位尺寸：lightweight-charts 在这类环境下，若
      // resize() 的目标尺寸与创建时相同会被当成没变化直接跳过，canvas 位图分辨率
      // 永远刷不到位。留一个必然不同的占位值，下面第一次 resize 才会真正生效。
      // 与 StrategiesPage.tsx 原有实现一致，不是新写的一套。
      // Deliberately created at an obviously-too-small placeholder size: in this
      // environment lightweight-charts treats a resize() whose target matches the
      // creation size as a no-op, so the canvas bitmap resolution never gets
      // refreshed. A guaranteed-different placeholder makes the first resize below
      // actually apply. Same as the original StrategiesPage.tsx implementation.
      width: 2,
      height: 2,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR, borderVisible: false,
    })
    series.setData(bars.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })))

    // 指标叠加：主图类（均线/布林/唐奇安）与价格同刻度直接画在蜡烛上；副图类
    // （RSI/MACD）各占一个 pane——它们的取值范围与价格无关，混进主图会把价格轴
    // 压成一条线。pane 下标用 chart.panes().length 追加，与 ChartsPage 同一做法。
    // Indicator overlays: the price-scale kinds (MAs, Bollinger, Donchian) draw
    // straight onto the candles; the sub-pane kinds (RSI, MACD) each take a pane,
    // since their ranges have nothing to do with price and mixing them in would
    // squash the price axis into a line. Pane indices append via
    // chart.panes().length, the same approach as ChartsPage.
    const times = bars.map((b) => b.t as UTCTimestamp)
    const closeVals = closes(bars)
    const highs = bars.map((b) => b.h)
    const lows = bars.map((b) => b.l)
    const extraSeries: ISeriesApi<'Line' | 'Histogram'>[] = []

    const addLine = (values: (number | null)[], color: string, paneIndex?: number, width: 1 | 2 = 1) => {
      const s = chart.addSeries(
        LineSeries,
        { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false },
        paneIndex
      )
      s.setData(toLinePoints(times, values))
      extraSeries.push(s as ISeriesApi<'Line'>)
      return s
    }

    for (const ov of overlays) {
      const color = colorOf(ov.id)
      if (ov.kind === 'ma') {
        addLine(ov.maType === 'SMA' ? sma(closeVals, ov.period) : ema(closeVals, ov.period), color)
      } else if (ov.kind === 'boll') {
        const b = bollinger(closeVals, ov.period, ov.mult ?? 2)
        // 中轨实线、上下轨同色：三条线是一个整体，各给一个颜色反而读不出是一组。
        // Mid solid with the bands in the same color: the three lines are one
        // object, and three different colors would stop reading as a set.
        addLine(b.mid, color)
        addLine(b.upper, color)
        addLine(b.lower, color)
      } else if (ov.kind === 'donchian') {
        addLine(donchianHigh(highs, ov.period), color)
        addLine(donchianLow(lows, ov.period), color)
      } else if (ov.kind === 'rsi') {
        const paneIndex = chart.panes().length
        addLine(rsi(closeVals, ov.period), color, paneIndex, 2)
        // 超买/超卖两条水平参考线：RSI 的读数只有对着阈值才有意义。
        // The overbought/oversold reference lines: an RSI reading only means
        // something against its thresholds.
        const flat = (level: number) => times.map(() => level)
        addLine(flat(ov.overbought ?? 70), 'rgba(148, 163, 184, 0.35)', paneIndex)
        addLine(flat(ov.oversold ?? 30), 'rgba(148, 163, 184, 0.35)', paneIndex)
      } else if (ov.kind === 'macd') {
        const paneIndex = chart.panes().length
        const m = macd(closeVals, ov.fast ?? 12, ov.slow ?? 26, ov.signal ?? 9)
        const hist = chart.addSeries(
          HistogramSeries,
          { priceLineVisible: false, lastValueVisible: false },
          paneIndex
        )
        hist.setData(
          times.flatMap((time, i) =>
            m.hist[i] == null
              ? []
              : [{ time, value: m.hist[i] as number, color: (m.hist[i] as number) >= 0 ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)' }]
          )
        )
        extraSeries.push(hist as ISeriesApi<'Histogram'>)
        addLine(m.macd, color, paneIndex, 2)
        addLine(m.signal, '#fb7185', paneIndex)
      }
    }

    // 交易数超上限时只画最近 CHART_TRADE_CAP 笔（trades 已按出场先后排序，取末尾即
    // 最近）。连线与标记共用这一份，保证图上"连线"与"箭头/圆点"始终对应同一批交易。
    // When trades exceed the cap, draw only the most recent CHART_TRADE_CAP (trades
    // are ordered by exit, so the tail is the newest). Lines and markers share this
    // slice so the chart's lines and arrows/dots always cover the same trades.
    const drawnTrades = trades.length > CHART_TRADE_CAP ? trades.slice(-CHART_TRADE_CAP) : trades

    // 每笔已出结果的交易两个标记：入场箭头（方向色）+ 出场圆点（赢绿输红）。
    // TIMEOUT 走"非 HIT_TP 即视觉上的非盈利"这一档——超时平仓没有出场价方向信息
    // （见 Task 8 的说明），不假装知道它是赚还是亏。
    // Two markers per resolved trade: a direction-colored entry arrow plus an
    // exit dot (green win / red loss). TIMEOUT falls into the "not HIT_TP" visual
    // bucket — a timeout exit carries no P&L direction (see Task 8), and this
    // doesn't pretend to know whether it made money.
    const markers = drawnTrades.flatMap((tr) => {
      const win = tr.result === 'HIT_TP'
      return [
        {
          time: tr.entryTime as UTCTimestamp,
          position: (tr.side === 'BUY' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
          shape: (tr.side === 'BUY' ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
          color: tr.side === 'BUY' ? UP_COLOR : DOWN_COLOR,
        },
        {
          time: tr.exitTime as UTCTimestamp,
          position: (tr.side === 'BUY' ? 'aboveBar' : 'belowBar') as 'belowBar' | 'aboveBar',
          shape: 'circle' as const,
          color: win ? UP_COLOR : DOWN_COLOR,
        },
      ]
    })
    // 还没等到结果的入场：只标入场箭头，用琥珀色与赢/亏的绿/红区分开，一眼能看出
    // "这笔还没有结果"。/ Entries with no result yet: entry arrow only, in amber to
    // stand apart from the win/loss green/red, reading as "no result yet".
    const pendingMarkers = openPositions.map((p) => ({
      time: p.entryTime as UTCTimestamp,
      position: (p.side === 'BUY' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
      shape: (p.side === 'BUY' ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
      color: PENDING_COLOR,
    }))
    createSeriesMarkers(series, [...markers, ...pendingMarkers])

    // 每笔交易一条两点连线，标出"从哪进、到哪出"
    // One 2-point line series per trade, tracing "entered here, exited there"
    const tradeLines = drawnTrades.map((tr) => {
      const line = chart.addSeries(LineSeries, {
        color: tr.result === 'HIT_TP' ? 'rgba(34, 197, 94, 0.55)' : 'rgba(239, 68, 68, 0.55)',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
      line.setData([
        { time: tr.entryTime as UTCTimestamp, value: tr.entryPrice },
        { time: tr.exitTime as UTCTimestamp, value: tr.exitPrice },
      ])
      return line
    })

    chart.timeScale().fitContent()

    // "打两下"：先 resize 到一个必然不同的临时值，再到真正目标值。占位尺寸的纠正
    // 与后续每一次真实尺寸变化都会撞上"目标与内部记录相同就跳过"这个坑，两次调用
    // 保证第二次一定被判定为真的变化。全程用 chart.resize() 而非 applyOptions()
    // ——后者只改 CSS 尺寸，不刷新 canvas 位图。与 StrategiesPage.tsx 同一实现。
    // A "double kick": resize to a deliberately different transient value first,
    // then to the real target. Both the placeholder correction and every later
    // genuine size change hit the same "target matches internal bookkeeping, skip
    // it" pitfall, and two calls guarantee the second is seen as a real change.
    // Always chart.resize(), never applyOptions() — the latter only updates the
    // CSS size, not the canvas bitmap. Same as StrategiesPage.tsx.
    const forceResize = (width: number, height: number) => {
      chart.resize(width - 1, height, true)
      chart.resize(width, height, true)
    }
    if (el.clientWidth > 0) forceResize(el.clientWidth, 320)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) forceResize(width, height)
    })
    ro.observe(el)
    // 双保险：ResizeObserver 在这类环境下偶尔漏触发，窗口级 resize 事件作为独立的
    // 第二条路径兜底。/ Belt-and-braces: the ResizeObserver occasionally misses a
    // transition here; a window-level resize listener is an independent fallback.
    const onWindowResize = () => {
      if (el.clientWidth > 0) forceResize(el.clientWidth, el.clientHeight || 320)
    }
    window.addEventListener('resize', onWindowResize)
    return () => {
      window.removeEventListener('resize', onWindowResize)
      ro.disconnect()
      tradeLines.forEach((l) => chart.removeSeries(l))
      extraSeries.forEach((s) => chart.removeSeries(s))
      chart.remove()
    }
  }, [bars, trades, openPositions, overlays, colorOf])

  // 副图每多一个就加高一截：RSI 与 MACD 各占一格，固定 320px 会把三格挤到每格
  // 一百来像素，指标线糊成一团反而不如不画。
  // Grow the height per sub-pane: RSI and MACD each take one, and a fixed 320px
  // would squeeze three panes into ~100px each, where the lines blur into
  // uselessness.
  const subPanes = overlays.filter((o) => o.kind === 'rsi' || o.kind === 'macd').length
  return <div ref={containerRef} style={{ height: 320 + subPanes * 110 }} className="w-full" />
}

interface SummaryGridProps {
  summary: StrategyBacktestSummary
  // 对照用的另一套 summary（不含成本）。传入时每张卡片下面多一行灰色对照值，
  // 成本影响就变成"看得见的差额"而不是一个需要用户自己相信的说法。
  // The comparison summary (cost-free). When provided, each card grows a grey
  // second line, turning the cost impact into a visible delta rather than a claim
  // the user has to take on faith.
  compare?: StrategyBacktestSummary
  compareLabel?: string
}

// 六张指标卡：最终净值 / 总收益 / 最大回撤 / 最长连亏 / 胜率 / 平均盈亏比。
// 复用 simulator.* 既有文案键——回放模拟器与策略回测是同一套指标口径，另造一份
// 中英文案只会让两处慢慢漂移。
// Six metric cards: final equity / return / max drawdown / longest losing streak
// / win rate / average R. Reuses the existing simulator.* keys: the replay
// simulator and the strategy backtest report the same metrics, and a second copy
// of the strings would only drift apart.
function SummaryGrid({ summary, compare, compareLabel }: SummaryGridProps) {
  const { t } = useTranslation()
  const sub = (text: string) =>
    compare ? <div className="mt-0.5 text-[10px] text-slate-500">{compareLabel} {text}</div> : null

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
        <div className="text-[11px] text-slate-500">{t('simulator.finalEquity')}</div>
        <div className="num mt-1 text-lg font-bold text-slate-100">${fmtMoney(summary.finalEquity)}</div>
        {compare && sub(`$${fmtMoney(compare.finalEquity)}`)}
      </div>
      <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
        <div className="text-[11px] text-slate-500">{t('simulator.returnPct')}</div>
        <div className={`num mt-1 text-lg font-bold ${summary.returnPct >= 0 ? 'text-up' : 'text-down'}`}>
          {summary.returnPct >= 0 ? '+' : ''}{summary.returnPct.toFixed(2)}%
        </div>
        {compare && sub(`${compare.returnPct >= 0 ? '+' : ''}${compare.returnPct.toFixed(2)}%`)}
      </div>
      <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
        <div className="text-[11px] text-slate-500">{t('simulator.maxDrawdown')}</div>
        <div className="num mt-1 text-lg font-bold text-down">-{summary.maxDrawdownPct.toFixed(2)}%</div>
        {compare && sub(`-${compare.maxDrawdownPct.toFixed(2)}%`)}
      </div>
      <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
        <div className="text-[11px] text-slate-500">{t('simulator.maxLossStreak')}</div>
        <div className="num mt-1 text-lg font-bold text-down">{summary.maxLossStreak}</div>
        {compare && sub(String(compare.maxLossStreak))}
      </div>
      <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
        <div className="text-[11px] text-slate-500">{t('simulator.winRate')}</div>
        <div className="num mt-1 text-lg font-bold text-slate-100">
          {summary.winRate == null ? '-' : `${Math.round(summary.winRate * 100)}%`}
          <span className="ml-1.5 text-xs font-normal text-slate-500">{summary.wins}/{summary.wins + summary.losses}</span>
        </div>
        {compare && sub(compare.winRate == null ? '-' : `${Math.round(compare.winRate * 100)}%`)}
      </div>
      <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
        <div className="text-[11px] text-slate-500">{t('simulator.avgRr')}</div>
        <div className="num mt-1 text-lg font-bold text-slate-100">{summary.avgRr == null ? '-' : `${summary.avgRr.toFixed(2)}R`}</div>
        {compare && sub(compare.avgRr == null ? '-' : `${compare.avgRr.toFixed(2)}R`)}
      </div>
    </div>
  )
}

interface SampleSectionViewProps {
  title: string
  section: StrategySampleSection
}

// 样本内 / 样本外各一小块。切分固定 70/30 且不提供开关——自由度提升后过拟合是
// 主要风险，可关闭的警告等于没有警告。
// One block per in-/out-of-sample section. The 70/30 split is fixed with no
// toggle: overfitting is the dominant risk once the rule space opens up, and a
// warning you can switch off is no warning.
function SampleSectionView({ title, section }: SampleSectionViewProps) {
  const { t } = useTranslation()
  const resolved = section.summary.wins + section.summary.losses
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h5 className="text-xs font-semibold text-slate-200">{title}</h5>
        <span className="text-[11px] text-slate-500">
          {t('strategy.btSampleMeta', { bars: section.barsUsed, trades: resolved })}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px]">
        <div>
          <div className="text-slate-500">{t('simulator.winRate')}</div>
          <div className="mt-0.5 text-slate-100">{section.summary.winRate == null ? '-' : `${Math.round(section.summary.winRate * 100)}%`}</div>
        </div>
        <div>
          <div className="text-slate-500">{t('simulator.returnPct')}</div>
          <div className={`mt-0.5 ${section.summary.returnPct >= 0 ? 'text-up' : 'text-down'}`}>
            {section.summary.returnPct >= 0 ? '+' : ''}{section.summary.returnPct.toFixed(2)}%
          </div>
        </div>
        <div>
          <div className="text-slate-500">{t('simulator.avgRr')}</div>
          <div className="mt-0.5 text-slate-100">{section.summary.avgRr == null ? '-' : `${section.summary.avgRr.toFixed(2)}R`}</div>
        </div>
      </div>
    </div>
  )
}

export interface BacktestPanelProps {
  // 当前编辑中的条件配置。回测直接吃它，不再传 template + params。
  // The condition payload being edited. The backtest consumes it directly; no
  // more template + params.
  rules: ConditionPayload
  // 策略盯的那一个 (品种, 周期)，由页面从草稿传入。面板内不再提供切换器：
  // 一条策略只对应一个组合，改组合是改策略本身，属于上面的基本信息区。
  // The single (symbol, interval) the strategy watches, passed down from the
  // draft. No in-panel picker any more: a strategy is one pair, so changing it
  // means editing the strategy itself, up in the basics section.
  symbol: string
  interval: string
  stopLossMethod: StopLossMethod
  stopLossValue: number
  takeProfitMethod: TakeProfitMethod
  takeProfitValue: number
  oneTradeAtATime: boolean
  exitTimeoutBars: number | null
  // 回测跑完后把结果交给页面：策略卡片要用回测胜率与实盘胜率做对比，而后端不存
  // 回测快照（Task 12 已说明理由），这份数字只能由前端持有并传递。
  // Hands the result up to the page: the strategy card compares the backtest win
  // rate against the live one, and since no backtest snapshot is persisted
  // server-side (see Task 12), the frontend is the only holder of these numbers.
  onResult?: (result: StrategyBacktestResult) => void
}

const DAY_CHOICES = [30, 90, 180, 365]

export default function BacktestPanel({
  rules, symbol, interval,
  stopLossMethod, stopLossValue, takeProfitMethod, takeProfitValue,
  oneTradeAtATime, exitTimeoutBars, onResult,
}: BacktestPanelProps) {
  const { t } = useTranslation()
  const [days, setDays] = useState(90)
  const [riskPct, setRiskPct] = useState(1.0)
  const [capital, setCapital] = useState(10000)
  const [mode, setMode] = useState<'compound' | 'flat'>('compound')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StrategyBacktestResult | null>(null)
  const [showWithoutCosts, setShowWithoutCosts] = useState(true)
  const [tradePage, setTradePage] = useState(0)
  const [coverage, setCoverage] = useState<StrategyCoverage | null>(null)
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [bars, setBars] = useState<Candle[]>([])
  // 可画的指标叠加层，从条件列表推导；勾选状态按 id 存。默认全不勾——图上先只有
  // 蜡烛与标记，需要核对触发依据时再打开对应指标。
  // The drawable overlays, derived from the condition list, with checked state by
  // id. Nothing is checked by default: candles and markers first, switch an
  // indicator on when you want to check what a trigger was reading.
  const availableOverlays = useMemo(() => deriveOverlays(rules.conditions), [rules.conditions])
  const [shownOverlayIds, setShownOverlayIds] = useState<string[]>([])

  // 颜色按"在完整列表里的位置"分配，不按已勾选的顺序：否则取消勾选一个，其余的
  // 线全部换色，用户会以为画的是另外几条指标。
  // Colors are assigned by position in the full list, not by checked order:
  // otherwise un-checking one would recolor the rest, reading as if different
  // indicators were now being drawn.
  const overlayColorOf = useCallback(
    (id: string) => overlayColor(Math.max(0, availableOverlays.findIndex((o) => o.id === id))),
    [availableOverlays]
  )
  const shownOverlays = useMemo(
    () => availableOverlays.filter((o) => shownOverlayIds.includes(o.id)),
    [availableOverlays, shownOverlayIds]
  )
  const toggleOverlay = useCallback((id: string) => {
    setShownOverlayIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  // 条件改了就清空勾选：留着旧 id 会让"策略已经不含这个指标了，图上还画着"这种
  // 状态存在。availableOverlays 变化即意味着条件变了。
  // Clear the selection when the conditions change: keeping stale ids would allow
  // "the strategy no longer uses this indicator, yet it's still drawn". A change
  // in availableOverlays means the conditions changed.
  useEffect(() => {
    setShownOverlayIds((prev) => prev.filter((id) => availableOverlays.some((o) => o.id === id)))
  }, [availableOverlays])

  // 覆盖度在回测之前就拉：这是 spec 验收标准第 4 条「回测前端在执行前显示实际可用
  // 数据范围」。目标组合一变就重拉，用户切品种立刻看到新的可用范围。
  // Coverage is fetched *before* any backtest: spec acceptance criterion 4, "the
  // frontend shows the actual available range before running". Refetched whenever
  // the target pair changes, so switching symbols immediately shows the new range.
  useEffect(() => {
    let alive = true
    setCoverageLoading(true)
    strategyApi
      .coverage([symbol], [interval])
      .then((res) => { if (alive) setCoverage(res.coverage[0] ?? null) })
      .catch(() => { if (alive) setCoverage(null) })
      .finally(() => { if (alive) setCoverageLoading(false) })
    return () => { alive = false }
  }, [symbol, interval])

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      const res = await strategyApi.backtest({
        rules, symbol, interval,
        stopLossMethod, stopLossValue, takeProfitMethod, takeProfitValue,
        oneTradeAtATime, exitTimeoutBars,
        days, riskPct, capital, mode,
      })
      setResult(res)
      setTradePage(0)
      onResult?.(res)
      // 蜡烛图另拉一次：回测响应不回传 bars（5000 根序列化回前端是已核实的性能
      // 问题之一）。必须传同一个 days 并走 backtestBars——它与回测在后端共用取数
      // 函数，取的是同一段。用 chartApi.history 会拿到最近 500 根内存缓存，与回测
      // 窗口不同段，交易标记就会落在蜡烛范围之外（"标记线不准"的根因）。
      // 失败不影响指标展示，只是图空着。
      // Candles are fetched separately: the backtest response doesn't echo bars
      // (serializing 5000 was a verified performance problem). It must pass the
      // same `days` and go through backtestBars, which shares the backend's
      // bar-loading function with the backtest and therefore returns the same
      // slice. chartApi.history would return the newest 500 cached bars — a
      // different window, leaving trade markers outside the charted range (the
      // root cause of "the markers are off"). A failure leaves the chart empty
      // without affecting the metrics.
      if (!res.insufficientData) {
        strategyApi.backtestBars(symbol, interval, days).then((h) => setBars(h.bars)).catch(() => setBars([]))
      }
    } catch (e) {
      setError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
    } finally {
      setRunning(false)
    }
  }, [
    rules, symbol, interval, stopLossMethod, stopLossValue, takeProfitMethod,
    takeProfitValue, oneTradeAtATime, exitTimeoutBars, days, riskPct, capital, mode, onResult,
  ])

  // 逐单明细按新到旧展示；后端按回放顺序（旧到新）返回，这里单独倒一份供表格用，
  // 图表标记仍吃原始正序，互不影响。
  // The trade table shows newest first while the backend returns replay order
  // (oldest first); a separate reversed copy feeds the table, and the chart's
  // markers still consume the original ascending order.
  // 逐单明细固定用含成本那套：它才是"如果真的跟着做会发生什么"。不含成本那套只
  // 作为指标卡上的对照数字出现，不另开一张表——两张几乎一样的表会让人分不清在看
  // 哪一份。
  // The trade table always uses the cost-inclusive set: that's the "what would
  // actually have happened" one. The cost-free set appears only as comparison
  // figures on the metric cards, not as a second table — two nearly identical
  // tables make it impossible to tell which one you're reading.
  const tradesDesc = result && !result.insufficientData ? [...result.trades].reverse() : []
  const totalPages = Math.max(1, Math.ceil(tradesDesc.length / TRADE_PAGE_SIZE))
  const segBtn = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
      active ? 'border-prism-500/50 bg-prism-600/20 text-prism-200' : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-100'
    }`

  return (
    <div>
      <h4 className="mb-3 text-sm font-semibold text-slate-300">{t('strategy.sectionBacktest')}</h4>

      {/* 覆盖度提示在按钮之上、执行之前——先看清有多少数据，再决定跑不跑。
          它的标题句里已经带上品种与周期，所以这里不再另设一行目标回显。
          The coverage notice sits above the button, before any run: see how much
          data exists first, then decide whether to run. Its headline already
          names the symbol and interval, so no separate target readout here. */}
      <div>
        <CoverageNotice coverage={coverage} requestedDays={days} loading={coverageLoading} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500" id="bt-range-label">{t('simulator.range')}</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="bt-range-label">
            {DAY_CHOICES.map((d) => (
              <button key={d} type="button" role="radio" aria-checked={days === d} onClick={() => setDays(d)} className={segBtn(days === d)}>{d}</button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('simulator.risk')} · {riskPct.toFixed(1)}%</span>
          <input type="range" min={0.1} max={3} step={0.1} value={riskPct} onChange={(e) => setRiskPct(parseFloat(e.target.value))} className="w-full accent-prism-500" />
        </label>
        <NumberField label={t('simulator.capital')} value={capital} min={1} max={1e9} isFloat={false} onChange={setCapital} />
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500" id="bt-mode-label">{t('simulator.mode')}</span>
          <div className="flex gap-2" role="radiogroup" aria-labelledby="bt-mode-label">
            <button type="button" role="radio" aria-checked={mode === 'compound'} onClick={() => setMode('compound')} className={segBtn(mode === 'compound')}>{t('simulator.modeCompound')}</button>
            <button type="button" role="radio" aria-checked={mode === 'flat'} onClick={() => setMode('flat')} className={segBtn(mode === 'flat')}>{t('simulator.modeFlat')}</button>
          </div>
        </div>
      </div>

      <button type="button" onClick={run} disabled={running} aria-busy={running} className="btn-primary mt-4 w-full px-5 py-2 text-sm disabled:opacity-40 sm:w-auto">
        {running ? t('strategy.backtesting') : t('strategy.runBacktest')}
      </button>

      {error && <p className="mt-3 text-sm text-down" role="alert">{error}</p>}

      {result?.insufficientData && (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200" role="alert">
          {t('strategy.btInsufficient', { bars: result.barsUsed, requested: result.requestedDays })}
        </p>
      )}

      {/* insufficientData 为 true 时后端只回 barsUsed / requestedDays / coverage /
          cached 四项，summary 等字段缺席，所以整个结果区必须在这一层就被挡住。
          With insufficientData true the backend returns only barsUsed /
          requestedDays / coverage / cached — summary and friends are absent — so
          the whole results block has to be gated right here. */}
      {result && !result.insufficientData && (
        <div className="mt-5 border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-sm font-semibold text-slate-200">{t('strategy.resultsTitle')}</h4>
            <span className="text-[11px] text-slate-500">
              {t('strategy.btScope', { bars: result.barsUsed, requested: result.requestedDays })}
              {result.cached && ` · ${t('strategy.btCached')}`}
            </span>
          </div>

          {/* 成本摘要：扣了多少、以及"不扣会是多少"。两者并列才让成本可见。
              Cost summary: how much was deducted, and what it would have been
              without. Side by side is what makes the cost visible. */}
          <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-slate-300">{t('strategy.btTotalCost', { cost: fmtMoney(result.totalCost) })}</span>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={showWithoutCosts}
                  onChange={(e) => setShowWithoutCosts(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-prism-500"
                />
                {t('strategy.btShowWithoutCosts')}
              </label>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{t('strategy.btCostHint')}</p>
          </div>

          <div className="mt-3">
            <SummaryGrid
              summary={result.summary}
              compare={showWithoutCosts ? result.withoutCosts.summary : undefined}
              compareLabel={showWithoutCosts ? t('strategy.btWithoutCostsShort') : undefined}
            />
          </div>

          {/* 样本内 / 样本外：切分固定 70/30，两段各一套指标
              In/out-of-sample: fixed 70/30 split, a full metric set each */}
          <div className="mt-5 border-t border-white/10 pt-4">
            <h4 className="text-sm font-semibold text-slate-200">{t('strategy.btSampleTitle')}</h4>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">{t('strategy.btSampleHint')}</p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SampleSectionView title={t('strategy.btInSample')} section={result.inSample} />
              <SampleSectionView title={t('strategy.btOutOfSample')} section={result.outOfSample} />
            </div>
            {/* 过拟合三态：命中阈值 / 样本不足未评估 / 未命中。样本不足时必须说
                "未评估"而不是"无风险"——后者是没有依据的安心。
                Three overfit states: flagged / not evaluated for want of sample /
                not flagged. With too small a sample it must read "not evaluated"
                rather than "no risk", which would be unfounded reassurance. */}
            {result.overfitRisk.flagged ? (
              <p className="mt-3 rounded-lg border border-down/30 bg-down/5 p-3 text-xs leading-relaxed text-down" role="alert">
                {result.overfitRisk.reason === 'winRateDrop' ? t('strategy.overfitWinRateDrop') : t('strategy.overfitReturnFlip')}
              </p>
            ) : result.overfitRisk.insufficientSample ? (
              <p className="mt-3 text-xs text-slate-500">{t('strategy.overfitNotEvaluated')}</p>
            ) : (
              <p className="mt-3 text-xs text-slate-500">{t('strategy.overfitClear')}</p>
            )}
          </div>

          {result.openPositions.length > 0 && (
            <div className="mt-5 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
              <p className="text-xs leading-relaxed text-amber-200">{t('strategy.openPositionNotice', { count: result.openPositions.length })}</p>
              <div className="mt-2 flex flex-col gap-1">
                {result.openPositions.map((p, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-amber-100/90">
                    <span className={`tag ${p.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                      {p.side === 'BUY' ? t('common.buy') : t('common.sell')}
                    </span>
                    <span>{t('signals.entry')} {p.entryPrice}</span>
                    <span>{t('signals.stopLoss')} {p.stopLoss}</span>
                    <span>{t('signals.takeProfit')} {p.takeProfit}</span>
                    <span>{fmtDate(new Date(p.entryTime * 1000).toISOString())}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {bars.length > 0 && (
            <div className="mt-5 border-t border-white/10 pt-4">
              <h4 className="text-sm font-semibold text-slate-200">{t('strategy.chartTitle')}</h4>
              <p className="mt-1 text-xs text-slate-500">
                {result.trades.length > CHART_TRADE_CAP
                  ? t('strategy.chartHintCapped', { n: result.trades.length, shown: CHART_TRADE_CAP })
                  : t('strategy.chartHint', { n: result.trades.length })}
              </p>

              {/* 指标开关：只列这条策略的条件用到的指标，参数取自条件本身。默认全关
                  ——图先干净，想核对触发依据再逐个打开。
                  Indicator toggles: only the indicators this strategy's conditions
                  reference, with parameters taken from the conditions themselves.
                  All off by default: a clean chart first, switch them on when you
                  want to check what the triggers were reading. */}
              {availableOverlays.length > 0 && (
                <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.overlayTitle')}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {availableOverlays.map((ov) => {
                      const on = shownOverlayIds.includes(ov.id)
                      return (
                        <button
                          key={ov.id}
                          type="button"
                          onClick={() => toggleOverlay(ov.id)}
                          aria-pressed={on}
                          className={`flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs transition ${
                            on
                              ? 'border-white/20 bg-white/10 text-slate-100'
                              : 'border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: on ? overlayColorOf(ov.id) : 'rgba(148,163,184,0.35)' }}
                          />
                          {ov.label}
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('strategy.overlayHint')}</p>
                </div>
              )}

              <div className="mt-3">
                <BacktestChart
                  bars={bars}
                  trades={result.trades}
                  openPositions={result.openPositions}
                  overlays={shownOverlays}
                  colorOf={overlayColorOf}
                />
              </div>
            </div>
          )}

          <div className="mt-5 border-t border-white/10 pt-4">
            <h4 className="text-sm font-semibold text-slate-200">{t('simulator.equityCurve')}</h4>
            <div className="mt-3">
              <EquityCurve points={result.points} capital={capital} />
            </div>
          </div>

          {result.trades.length > 0 && (
            <div className="mt-5 border-t border-white/10 pt-4">
              <h4 className="text-sm font-semibold text-slate-200">{t('simulator.trades')}</h4>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                      <th scope="col" className="px-3 py-2 font-medium">{t('orders.colTime')}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t('orders.colSide')}</th>
                      <th scope="col" className="px-3 py-2 font-medium">{t('simulator.result')}</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">{t('simulator.tradeRr')}</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">{t('simulator.tradePnl')}</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">{t('simulator.equityAfter')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* 新到旧排列，与订单页既有约定一致
                        Newest first, consistent with the orders page */}
                    {tradesDesc.slice(tradePage * TRADE_PAGE_SIZE, tradePage * TRADE_PAGE_SIZE + TRADE_PAGE_SIZE).map((tr) => (
                      <tr key={tr.id} className="border-b border-white/5">
                        <td className="whitespace-nowrap px-3 py-2 text-slate-400">{fmtDate(tr.createdAt)}</td>
                        <td className="px-3 py-2">
                          <span className={`tag ${tr.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                            {tr.side === 'BUY' ? t('common.buy') : t('common.sell')}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {/* 三态：命中止盈 / 命中止损 / 超时平仓。超时单不能显示成
                              止损——它是按收盘价平的，盈亏方向未知。
                              Three states: TP hit / SL hit / timeout exit. A timeout
                              must not read as a stop-out: it closed at the bar's
                              close and its P&L direction is unknown. */}
                          <span
                            className={`tag ${
                              tr.result === 'HIT_TP'
                                ? 'bg-up/15 text-up'
                                : tr.result === 'TIMEOUT'
                                  ? 'bg-white/5 text-slate-400'
                                  : 'bg-down/15 text-down'
                            }`}
                          >
                            {tr.result === 'HIT_TP'
                              ? t('winrate.hitTp')
                              : tr.result === 'TIMEOUT'
                                ? t('strategy.resultTimeout')
                                : t('winrate.hitSl')}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-300">{tr.rr.toFixed(2)}R</td>
                        <td className={`px-3 py-2 text-right font-mono font-semibold ${tr.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>
                          {tr.pnlPct >= 0 ? '+' : ''}{tr.pnlPct.toFixed(2)}%
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-200">${fmtMoney(tr.equityAfter)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.trades.length > TRADE_PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                  <span>{t('orders.pageInfo', { page: tradePage + 1, totalPages, total: result.trades.length })}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setTradePage((p) => Math.max(0, p - 1))}
                      disabled={tradePage === 0}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t('common.prevPage')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTradePage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={tradePage + 1 >= totalPages}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t('common.nextPage')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
