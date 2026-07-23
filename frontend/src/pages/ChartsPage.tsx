// 实时行情图表页：自建 Lightweight Charts + 自建中央 MT5 喂价源。
// Live charts page: self-hosted Lightweight Charts + a self-hosted central MT5 feed.
//
// 历史 K 线由后端 /api/chart/history 返回（一次性快照，切品种/周期时拉取），
// 实时更新由 /api/chart/latest 轮询获得。两者都来自我们自己的域名，因此在
// 任何网络环境（含中国大陆）都可访问——不再依赖 TradingView 的脚本与行情
// 数据通道。详见项目根目录 CHART_SELFHOST_PLAN.md。
//
// History candles come from the backend's /api/chart/history (a one-shot
// snapshot fetched on symbol/interval change); live updates are polled from
// /api/chart/latest. Both are served from our own domain, so the page works
// in any network environment (including mainland China) — it no longer
// depends on TradingView's script or data channel. See CHART_SELFHOST_PLAN.md
// at the repo root.
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  createChart,
  ColorType,
  LineStyle,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from 'lightweight-charts'
import { chartApi } from '../api/client'
import type { Candle } from '../api/types'
import { usePrefs } from '../store/prefs'
import { useLive, useQuotes } from '../store/live'
import { useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import { sma, ema, bollinger, rsi, macd, closes } from '../utils/indicators'
import { useBackToClose } from '../utils/useBackToClose'
import {
  DEFAULT_INDICATOR_SETTINGS,
  mergeIndicatorSettings,
  type IndicatorSettings,
} from '../components/charts/indicatorSettings'
import DrawLayer, { type DrawLayerHandle, type Tool } from '../components/charts/DrawLayer'
import ChartOrderModal from '../components/ChartOrderModal'
import IndicatorSettingsModal from '../components/charts/IndicatorSettingsModal'
import SymbolHeader, { type DayStats } from '../components/charts/SymbolHeader'
import WatchlistPanel from '../components/charts/WatchlistPanel'
import AccountSummary from '../components/charts/AccountSummary'
import OrderTicket from '../components/charts/OrderTicket'
import PositionsDock from '../components/charts/PositionsDock'
import { useGlobalQuotes, usePositions } from '../store/live'

// 图表价格轴的小数位数：贵金属/原油 2~3 位，外汇对按经纪商常见的 5 位报价
// （日元对 3 位），加密货币 2 位。未在表中的品种回退到 2 位。
// Decimal precision for the price scale: metals/oil use 2~3 digits, FX pairs
// use the broker-standard 5-digit quoting (JPY pairs use 3), crypto uses 2.
// Unlisted symbols fall back to 2 digits.
const SYMBOL_DECIMALS: Record<string, number> = {
  XAUUSD: 2,
  XAGUSD: 3,
  WTI: 2,
  EURUSD: 5,
  GBPUSD: 5,
  USDJPY: 3,
  BTCUSD: 2,
}
const INTERVALS: { code: string; label: string }[] = [
  { code: '1', label: '1m' },
  { code: '5', label: '5m' },
  { code: '15', label: '15m' },
  { code: '60', label: '1H' },
  { code: '240', label: '4H' },
  { code: 'D', label: '1D' },
]

const ToolList: Tool[] = ['cursor', 'cross', 'trend', 'hline', 'vline', 'ray', 'crossline', 'rect', 'fib']

// 画线工具图标（提取到 ChartsPage 里复用，避免在 DrawLayer 内写死竖排布局）
function DrawToolIcon({ tool }: { tool: Tool }) {
  switch (tool) {
    case 'cursor':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l7 17 2.5-6.5L20 11 4 3z" /></svg>
    case 'cross':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /></svg>
    case 'trend':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20L20 4" /><circle cx="4" cy="20" r="2" /><circle cx="20" cy="4" r="2" /></svg>
    case 'hline':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><circle cx="12" cy="12" r="2" /></svg>
    case 'vline':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><circle cx="12" cy="12" r="2" /></svg>
    case 'ray':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="18" x2="18" y2="6" /><line x1="18" y1="6" x2="22" y2="2" /><circle cx="6" cy="18" r="2" /></svg>
    case 'crossline':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><path d="M12 3v18" /><circle cx="12" cy="12" r="2" /></svg>
    case 'rect':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="6" width="16" height="12" rx="1" /></svg>
    case 'fib':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path d="M4 19L20 5" opacity="0.5" /></svg>
  }
}

// 画线工具整排（图标 + 颜色点 + 删除/清空/连续绘制/显隐）：桌面工具栏与手机端
// 可展开行共用同一份，避免同样ー套按钮抄两遍。wrap=true 时允许换行（手机展开行，
// 铺满宽度更好点），false 时横向滚动（桌面工具栏，节省垂直空间）。
// The full draw-tool row (icons + color dots + delete/clear/stay/hide): shared
// by the desktop toolbar and the mobile expandable row so the same button set
// isn't duplicated. wrap=true allows wrapping (mobile: full-width is available
// and wrapping beats a hidden horizontal scroll); false scrolls horizontally
// (desktop: saves vertical space).
function DrawToolsRow({
  drawLayerRef,
  bumpDraw,
  t,
  wrap = false,
}: {
  drawLayerRef: RefObject<DrawLayerHandle>
  bumpDraw: () => void
  t: (key: string) => unknown
  wrap?: boolean
}) {
  return (
    <div className={`term-toolbar-tools no-sb ${wrap ? 'wrap' : ''}`}>
      {(ToolList as Tool[]).map((toolName) => (
        <button
          key={toolName}
          type="button"
          title={String(t(`charts.draw.${toolName}`))}
          aria-label={String(t(`charts.draw.${toolName}`))}
          onClick={() => { drawLayerRef.current?.setTool(toolName); bumpDraw() }}
          className={`term-tool-btn ${drawLayerRef.current?.tool === toolName ? 'on' : ''}`}
        >
          <DrawToolIcon tool={toolName} />
        </button>
      ))}
      <span className="term-toolbar-divider" />
      {['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451'].map((c) => (
        <button
          key={c}
          type="button"
          title={String(t('charts.draw.color'))}
          aria-label={String(t('charts.draw.color'))}
          onClick={() => { drawLayerRef.current?.applyColor(c); bumpDraw() }}
          className={`term-color-dot ${drawLayerRef.current?.color === c ? 'on' : ''}`}
          style={{ background: c }}
        />
      ))}
      <span className="term-toolbar-divider" />
      <button
        type="button"
        title={String(t('charts.draw.delete'))}
        aria-label={String(t('charts.draw.delete'))}
        onClick={() => { drawLayerRef.current?.deleteSelected(); bumpDraw() }}
        disabled={!drawLayerRef.current?.selectedId}
        className="term-tool-btn"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
      </button>
      <button
        type="button"
        title={String(t('charts.draw.clear'))}
        aria-label={String(t('charts.draw.clear'))}
        onClick={() => { drawLayerRef.current?.clearAll(); bumpDraw() }}
        disabled={(drawLayerRef.current?.drawCount ?? 0) === 0}
        className="term-tool-btn"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 5L5 19M5 5l14 14" /></svg>
      </button>
      <button
        type="button"
        title={String(t('charts.draw.stayInDraw'))}
        aria-label={String(t('charts.draw.stayInDraw'))}
        onClick={() => { drawLayerRef.current?.setStayInDraw(!drawLayerRef.current?.stayInDraw); bumpDraw() }}
        className={`term-tool-btn ${drawLayerRef.current?.stayInDraw ? 'on' : ''}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3l4 4-4 4" /><path d="M3 17l4 4-4 4" /><line x1="21" y1="7" x2="7" y2="21" /><line x1="7" y1="3" x2="21" y2="17" /></svg>
      </button>
      <button
        type="button"
        title={String(drawLayerRef.current?.visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        aria-label={String(drawLayerRef.current?.visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        onClick={() => { drawLayerRef.current?.setVisible(!drawLayerRef.current?.visible); bumpDraw() }}
        className={`term-tool-btn warn ${!drawLayerRef.current?.visible ? 'on' : ''}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{drawLayerRef.current?.visible ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></> : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></>}</svg>
      </button>
    </div>
  )
}

// 向后兼容的 localStorage key / backward-compat localStorage keys
const INTERVAL_KEY = 'prismx.charts.interval'
const SYMBOL_KEY = 'prismx.charts.symbol'

// 最新价轮询间隔（毫秒）/ latest-price poll interval (ms)
const POLL_MS = 2000
// 超过这么久没收到喂价更新，视为数据延迟 / no feed update for this long => stale
const STALE_MS = 30_000
// 客户端保留的最大 K 线根数，与后端 chart_store.MAX_BARS 对齐，避免图表页
// 开着很久时 candlesRef 无限增长。/ max bars kept client-side, matching the
// backend's chart_store.MAX_BARS so candlesRef doesn't grow unbounded over a
// long-lived page session.
const MAX_CLIENT_BARS = 500

// 涨跌配色（与 SignalView 的 FOCUS_DOT 一致，K 线本身固定用这套，不做客制化）
// up/down colors (match SignalView's FOCUS_DOT; the candles themselves stay
// fixed to this palette — only the sub-indicators are user-customizable)
const UP_COLOR = '#2ee07e'
const DOWN_COLOR = '#ff4d67'

// ---------- 指标开关 / indicator toggles ----------
export interface IndicatorFlags {
  ma: boolean
  ema: boolean
  boll: boolean
  volume: boolean
  rsi: boolean
  macd: boolean
}
const DEFAULT_INDICATORS: IndicatorFlags = {
  ma: false,
  ema: false,
  boll: false,
  volume: true, // 默认开：这一整轮 EA/后端改造就是为了喂出 volume，默认可见让效果立刻看得见
  rsi: false,
  macd: false,
}
// 十字准线/触摸拖动悬停时展示的各指标"当前值"；不悬停时回退到最新一根的值
// （见 recomputeIndicators 与 subscribeCrosshairMove 的说明）。
// The indicator values shown while hovering the crosshair or touch-dragging;
// falls back to the latest bar's values when not hovering (see
// recomputeIndicators and the subscribeCrosshairMove wiring below).
interface LegendValues {
  ma: (number | null)[]
  ema: (number | null)[]
  boll: { mid: number | null; upper: number | null; lower: number | null }
  volume: number | null
  rsi: number | null
  macd: { macd: number | null; signal: number | null; hist: number | null }
}
const EMPTY_LEGEND: LegendValues = {
  ma: [],
  ema: [],
  boll: { mid: null, upper: null, lower: null },
  volume: null,
  rsi: null,
  macd: { macd: null, signal: null, hist: null },
}

function toLwPoint(b: Candle) {
  return { time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }
}

// 把一条可能含 null（预热期）的指标序列转成 lightweight-charts 的折线数据点，
// 丢掉 null 位置（而不是传 0，那样会在图上画出一条假的归零线）。
// Convert an indicator series that may contain null (warm-up) entries into
// lightweight-charts line-series points, dropping the null positions (rather
// than sending 0, which would draw a false line down to zero).
function toLinePoints(times: UTCTimestamp[], values: (number | null)[]): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v != null) out.push({ time: times[i], value: v })
  }
  return out
}

// MACD 柱状图：同上但带正负配色 / MACD histogram: same, but colored by sign
function toHistPoints(
  times: UTCTimestamp[],
  values: (number | null)[],
  upColor: string,
  downColor: string
): { time: UTCTimestamp; value: number; color: string }[] {
  const out: { time: UTCTimestamp; value: number; color: string }[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v != null) out.push({ time: times[i], value: v, color: v >= 0 ? upColor : downColor })
  }
  return out
}

// 数字格式化：null 显示为占位符 / format a number for the legend; null renders as a placeholder
function fmtLegendNum(v: number | null | undefined, digits: number): string {
  return v == null ? '—' : v.toFixed(digits)
}

// 从 K 线窗口算行情头的日内高低 + 涨跌幅，按自然日（UTC+8，与图表坐标轴
// 同一时区）取当日 K 线：high/low 为当日极值，涨跌幅以当日首根开盘价为基准
// （(最新收 − 当日开)/当日开）。这样统计口径与所选周期无关，切 1m 还是 1H
// 看到的都是"今天涨跌多少"，而不是"当前窗口首尾涨跌多少"。当日暂无 K 线时
// （如日线周期一天才一根、或数据早于今日）退回整窗口，避免显示空。
// Compute the header's day range + change% from the candle window, scoped to
// the current natural day (UTC+8, same timezone as the chart axis): high/low
// are today's extremes, change% uses today's first open as the reference
// ((latest close − today's open)/today's open). This makes the figures
// interval-independent — 1m or 1H both show "how much today is up/down" rather
// than "first vs last of the current window". Falls back to the whole window
// when there are no bars for today yet (e.g. a daily interval, or data older
// than today), so it never renders empty.
function computeDayStats(bars: { t: number; o: number; h: number; l: number; c: number }[]): DayStats | null {
  if (bars.length === 0) return null
  // UTC+8 无夏令时，当日零点的 epoch 秒 / UTC+8 has no DST; epoch of today's midnight
  const TZ_OFFSET = 8 * 3600
  const nowSec = Date.now() / 1000
  const dayStart = Math.floor((nowSec + TZ_OFFSET) / 86400) * 86400 - TZ_OFFSET
  const today = bars.filter((b) => b.t >= dayStart)
  const use = today.length > 0 ? today : bars
  let high = -Infinity
  let low = Infinity
  for (const b of use) {
    if (b.h > high) high = b.h
    if (b.l < low) low = b.l
  }
  const open = use[0].o
  const close = use[use.length - 1].c
  const changePct = open > 0 ? (close - open) / open : 0
  return { high, low, changePct }
}

// 时间轴刻度和十字准线悬浮时间标签是 lightweight-charts 两套独立的格式化配置
// （timeScale.tickMarkFormatter 只管坐标轴刻度；localization.timeFormatter 才
// 管鼠标悬停时显示的精确时间）。之前只设了前者，鼠标悬停显示的还是浏览器本地
// 时区，跟坐标轴上标的 UTC+8 对不上——这正是"图表时间还是不对"的真正原因。
// 两处统一用同一个格式化函数，确保悬停时间与坐标轴时间口径一致。
// Tick-mark labels and the crosshair's hover time readout are two separate
// lightweight-charts formatting hooks (timeScale.tickMarkFormatter only
// controls the axis ticks; localization.timeFormatter controls the precise
// time shown while hovering). Only the former was set, so hovering still
// showed the browser's local timezone while the axis said UTC+8 — this
// mismatch was the actual "chart time is still wrong" bug. Both now share one
// formatter so the hover time and the axis time always agree.
function fmtChartTime(time: UTCTimestamp): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time * 1000))
}

export default function ChartsPage() {
  const { t } = useTranslation()
  const { getPref, setPref, loaded } = usePrefs()
  const containerRef = useRef<HTMLDivElement>(null)
  const drawLayerRef = useRef<DrawLayerHandle>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  // 已应用到图表的最新一根 K 线时间戳（epoch 秒）。lightweight-charts 的
  // series.update() 只接受 >= 最后一根的时间，喂价时间更早的 bar 会抛错并
  // 中断本次更新，导致最新价看似“不跳动、刷新才动”。用它过滤掉更早的 bar。
  // Timestamp (epoch s) of the newest bar already applied to the chart.
  // series.update() only accepts a time >= the last bar's; an earlier bar
  // throws and aborts the update, making the price look "stuck until refresh".
  // Use this to skip any bar older than what we've already applied.
  const lastTimeRef = useRef<number>(0)
  // 当前品种/周期的全部 K 线时间（升序），供画图层把非本周期锚点的时间插值成
  // 屏幕坐标（画线按品种保存、需跨周期显示）。/ ascending bar times of the current
  // symbol+interval, used by the draw layer to interpolate an anchor's time to
  // an x coordinate across intervals (drawings are saved per symbol).
  const barTimesRef = useRef<number[]>([])
  const getBarTimes = useCallback(() => barTimesRef.current, [])

  // 当前品种/周期的完整 OHLCV 历史（升序），指标计算的唯一数据来源。与主
  // K 线 series 分开维护，因为指标要用到全部历史做窗口计算，而主 series 的
  // update() 只关心增量。/ full ascending OHLCV history for the current
  // symbol+interval — the sole data source for indicator math. Kept separate
  // from the main candlestick series because indicators need the whole
  // window to compute over, while the main series' update() only cares about
  // the incremental tail.
  const candlesRef = useRef<Candle[]>([])

  // 主图叠加指标的 series 句柄：MA/EMA/布林带 —— 这些从建图起就一直存在，
  // 开关只是切换 visible，不做动态增删（同一 pane 内没有下标错位问题，动态
  // 增删反而更复杂）。/ Main-pane overlay series handles: MA/EMA/Bollinger —
  // these exist for the chart's whole lifetime; toggling only flips `visible`
  // rather than adding/removing (no pane-index bookkeeping issue within the
  // same pane, so dynamic add/remove would only add complexity).
  const maSeriesRef = useRef<ISeriesApi<'Line'>[]>([])
  const emaSeriesRef = useRef<ISeriesApi<'Line'>[]>([])
  const bollSeriesRef = useRef<{ mid: ISeriesApi<'Line'>; upper: ISeriesApi<'Line'>; lower: ISeriesApi<'Line'> } | null>(null)

  // 副图指标（成交量/RSI/MACD）的 series 句柄：这三个各自占一个独立 pane，
  // 关闭时整个 series 连同 pane 一起移除（隐藏 series 并不会让 pane 消失，
  // 会留一条空白的轴），开启时重新创建，见下方的开关 effect。RSI 额外持有
  // 30/70（可客制化）参考线的句柄，供设置变化时更新价位而不必重建整条 series。
  // Sub-pane indicators (volume/RSI/MACD): each occupies its own pane, so
  // turning one off removes the series (and its now-empty pane) entirely
  // (merely hiding the series would leave a blank axis gutter behind); turning
  // it on recreates it — see the toggle effect below. RSI additionally holds
  // its (customizable) overbought/oversold reference-line handles, so a
  // settings change can update their price without rebuilding the whole series.
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const rsiSeriesRef = useRef<{ series: ISeriesApi<'Line'>; obLine: IPriceLine; osLine: IPriceLine } | null>(null)
  const macdSeriesRef = useRef<{ macd: ISeriesApi<'Line'>; signal: ISeriesApi<'Line'>; hist: ISeriesApi<'Histogram'> } | null>(null)

  // 图例的"最新值"缓存：不悬停十字准线时用这份兜底（见 recomputeIndicators）。
  // Cached "latest value" snapshot for the legend: used when the crosshair
  // isn't being hovered/dragged (see recomputeIndicators).
  const latestLegendRef = useRef<LegendValues>(EMPTY_LEGEND)
  // 当前是否正悬停/触摸拖动十字准线（由 onCrosshairMove 维护）。真正修复的
  // bug：每 2 秒一次的报价轮询会调用 recomputeIndicators()，若它无条件
  // setLegend(latest)，会把用户正悬停的那个历史值每 2 秒打回"最新值"一次——
  // 实测就是这个问题，而不是十字准线没接住数据（用临时调试钩子直接读了
  // lightweight-charts 在悬停点的原始 seriesData，证实库本身给的值完全正确，
  // 是这里的"轮询无条件覆盖"吃掉了它）。recomputeIndicators 因此只在没有
  // 悬停时才更新图例，悬停时的图例完全交给 onCrosshairMove 自己维护。
  // Whether the crosshair is currently being hovered/touch-dragged
  // (maintained by onCrosshairMove). This ref exists to fix a real bug: the
  // 2-second quote-poll timer calls recomputeIndicators(), and if that
  // unconditionally called setLegend(latest), it would stomp the user's
  // currently-hovered historical value back to "latest" every 2 seconds —
  // confirmed via a temporary debug hook that read lightweight-charts' raw
  // seriesData at the hovered point directly, proving the library itself
  // supplies the correct value and the poll's unconditional overwrite was
  // what erased it. recomputeIndicators now only updates the legend while
  // not hovering; the legend while hovering is owned entirely by
  // onCrosshairMove.
  const hoveringRef = useRef(false)

  // 初始值只是尽力猜测（此刻 activeSymbols 还没从后端加载回来，无法校验是否
  // 真的还活跃）；下面那个 effect 会在 activeSymbols 就绪后校正——若猜的品种
  // 已不在活跃列表里（或还没猜出来，是空字符串），改成活跃列表的第一个。
  // The initial value is only a best-effort guess (activeSymbols hasn't
  // loaded from the backend yet, so we can't verify it's still active); the
  // effect below corrects it once activeSymbols is ready — falls back to the
  // active list's first entry if the guess is no longer active (or empty).
  const [symbol, setSymbol] = useState<string>(
    () => getPref<string>('charts', 'symbol', '') || localStorage.getItem(SYMBOL_KEY) || ''
  )
  const [interval, setIntervalCode] = useState<string>(
    () => getPref<string>('charts', 'interval', '') || localStorage.getItem(INTERVAL_KEY) || '15'
  )
  // 指标开关 + 参数：都跟随用户走，云端同步（见下方持久化 effect），与
  // 品种/周期无关。/ Indicator toggles + settings: follow the user, cloud
  // synced (see the persistence effects below); independent of symbol/interval.
  const [indicators, setIndicatorsState] = useState<IndicatorFlags>(
    () => ({ ...DEFAULT_INDICATORS, ...getPref<Partial<IndicatorFlags>>('charts', 'indicators', {}) })
  )
  const [indicatorSettings, setIndicatorSettingsState] = useState<IndicatorSettings>(() =>
    mergeIndicatorSettings(DEFAULT_INDICATOR_SETTINGS, getPref<Partial<IndicatorSettings>>('charts', 'indicatorSettings', {}))
  )
  // 指标设置弹窗展开态 / indicator settings modal open state
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawVersion, setDrawVersion] = useState(0)
  const bumpDraw = useCallback(() => setDrawVersion((v) => v + 1), [])
  // 图例：随十字准线/触摸拖动更新，初始为空占位 / legend: updates with the crosshair/touch drag; starts as an empty placeholder
  const [legend, setLegend] = useState<LegendValues>(EMPTY_LEGEND)
  // 各已开启副图（成交量/RSI/MACD）pane 的顶部像素偏移，供图例定位；由
  // applyPaneHeights 在每次布局变化时一并算出。/ top pixel offset of each
  // enabled sub-pane (volume/RSI/MACD), for positioning its legend; computed
  // by applyPaneHeights alongside the pane heights themselves whenever the
  // layout changes.
  const [paneOffsets, setPaneOffsets] = useState<{ volume: number | null; rsi: number | null; macd: number | null }>({
    volume: null,
    rsi: null,
    macd: null,
  })

  // 数据状态：加载中 / 有数据 / 空（该品种周期暂无数据）/延迟
  // data status: loading / has data / empty (no data for this symbol+interval) / stale
  const [hasData, setHasData] = useState(false)
  const [stale, setStale] = useState(false)

  // 画图层就绪标记：图表实例建好后再挂载 DrawLayer / mount DrawLayer once the chart is built
  const [drawReady, setDrawReady] = useState(false)
  // 最新收盘价：喂给画图层做重绘侦测，并作为无实时报价时的下单参考价
  // latest close: feeds the draw layer's repaint detection and the order modal's fallback price
  const [lastPrice, setLastPrice] = useState(0)
  // 品种行情头的日内高低 + 涨跌幅：从已加载的 K 线窗口现算（首根开盘为基准），
  // 不需要新后端。切品种时清空，历史/轮询到数据后更新。
  // Symbol-header day range + change%: computed from the loaded candle window
  // (first open as the reference), no new backend. Cleared on symbol change,
  // updated once history/poll data lands.
  const [dayStats, setDayStats] = useState<DayStats | null>(null)
  // 手动下单弹窗：null 表示关闭 / manual order modal: null = closed
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL' | null>(null)

  // 手机端终端视图切换：图表 / 自选 / 交易 / 持仓。桌面（lg+）忽略此状态，
  // 三栏同时展示；手机上用顶部分段控件一次切一个视图。图表容器始终挂载
  // （切走时只用 CSS 隐藏，绝不卸载——否则会丢掉 lightweight-charts 实例与画线）。
  // Mobile terminal view switch: chart / watchlist / trade / positions. Ignored
  // at lg+ (all three columns show at once); on mobile a top segmented control
  // shows one view at a time. The chart container stays mounted always (hidden
  // via CSS when switched away, never unmounted — that would drop the
  // lightweight-charts instance and drawings).
  const [mobileView, setMobileView] = useState<'chart' | 'watchlist' | 'trade' | 'positions'>('chart')
  // 手机端画线工具是否展开：桌面工具栏一直平铺展示全部画线工具，手机端默认
  // 收起（只留周期切换 + 画笔开关 + 添加指标三件套），点画笔才展开完整工具行
  // ——参考 Web3 手机端交易 App（如 Hyperliquid/dYdX）默认界面精简、进阶操作
  // 收进一个入口的做法，避免小屏被十几个小图标塞满。
  // Whether the mobile draw-tool row is expanded: the desktop toolbar always
  // shows every draw tool inline; mobile starts collapsed (interval switch +
  // a draw toggle + add-indicator only) and expands the full row on tap —
  // mirrors how Web3 mobile trading apps (Hyperliquid, dYdX) keep the default
  // screen lean and tuck power-user controls behind one entry point instead of
  // packing a dozen small icons onto a narrow screen.
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)

  // 这两个都是全屏弹窗，手机上划返回应该先关掉弹窗、而不是直接退出图表页
  // （见 useBackToClose 的说明）。/ Both are full-screen modals; on mobile,
  // swiping back should close the modal first rather than exiting the charts
  // page outright (see useBackToClose's comment).
  useBackToClose(settingsOpen, () => setSettingsOpen(false))
  useBackToClose(orderSide != null, () => setOrderSide(null))

  // 手机端全屏模式：图表撑满屏幕，画线工具栏悬浮可拖移
  // Mobile fullscreen: chart fills the entire viewport, drawing toolbar floats & is draggable
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fsToolbarRef = useRef<HTMLDivElement>(null)
  const fsDragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null)
  const [fsToolbarPos, setFsToolbarPos] = useState<{ left: number; top: number } | null>(null)

  // CSS 全屏 + 原生 Fullscreen API（横屏锁定需要后者才能生效）。
  // CSS fullscreen (fixed inset-0 z-60) + native Fullscreen API —
  // screen.orientation.lock('landscape') only works inside a native fullscreen
  // context on mobile browsers (iOS Safari & Android Chrome both require it).
  const enterFullscreen = useCallback(() => {
    setIsFullscreen(true)
    document.body.classList.add('chart-fullscreen')
    // 先请求浏览器原生全屏，再锁定横屏（lock 在原生全屏上下文里才生效）。
    // 目标元素取 containerRef 的直接父节点（即 .term-chart，见 JSX：
    // <div className="term-chart ..."><div ref={containerRef} />...</div>）。
    // 之前用 closest('.glass') 找——无缝框重排时那层的 .glass 类被去掉了，
    // closest 从此永远找不到，导致原生全屏与横屏锁定悄悄失效（只剩纯 CSS
    // 视觉铺满，不是真全屏、不会转横屏），这正是用户反馈"点全屏不转横屏"的
    // 根因。改用直接父节点引用，不再依赖某个可能被样式重构改掉的类名。
    // Request native fullscreen first, then lock landscape (lock only works
    // inside a native fullscreen context). Target element is containerRef's
    // direct parent (.term-chart; see the JSX structure above). This used to
    // look it up via closest('.glass') — the seamless-frame layout rework
    // dropped that class from this element, so the lookup started silently
    // returning null forever, meaning native fullscreen + orientation lock
    // quietly stopped working (only the CSS full-viewport look remained — no
    // real fullscreen, no rotation) — this is the root cause of "tapping
    // fullscreen doesn't rotate to landscape". Using the direct parent ref
    // instead removes the dependency on a class name that styling reworks can
    // change out from under it.
    const el = containerRef.current?.parentElement ?? null
    if (el && document.fullscreenEnabled) {
      el.requestFullscreen().then(() => {
        const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> } | null
        orient?.lock?.('landscape').catch(() => {})
      }).catch(() => {
        // 降级：原生全屏失败仍尝试锁横屏（部分 Android 浏览器不要求先全屏）
        const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> } | null
        orient?.lock?.('landscape').catch(() => {})
      })
    } else {
      const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> } | null
      orient?.lock?.('landscape').catch(() => {})
    }
  }, [])

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false)
    document.body.classList.remove('chart-fullscreen')
    setFsToolbarPos(null)
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
    if (screen.orientation && 'unlock' in screen.orientation) {
      ;(screen.orientation as ScreenOrientation & { unlock: () => void }).unlock()
    }
  }, [])

  useBackToClose(isFullscreen, exitFullscreen)

  // 用户通过系统手势/返回键退出原生全屏时，同步 CSS 全屏状态
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && isFullscreen) {
        exitFullscreen()
      }
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [isFullscreen, exitFullscreen])

  // 全屏画线工具栏拖动：setPointerCapture 必须挂在真正监听事件的元素上
  // （即拖动把手本身，e.currentTarget），否则 pointermove 不会被捕获路由回来，
  // 表现为"很难拖动"。初始位置用 getBoundingClientRect 相对父容器换算，避免从
  // bottom 定位切到 top 定位时的跳变。
  // Drag: setPointerCapture must live on the element that actually listens
  // (the handle, e.currentTarget), otherwise pointermove isn't routed back —
  // which felt like "hard to drag". The start offset is derived from
  // getBoundingClientRect relative to the parent so switching from bottom- to
  // top-anchoring doesn't jump.
  const onFsToolbarPointerDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const el = fsToolbarRef.current
    if (!el) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const parent = el.offsetParent as HTMLElement | null
    const pr = parent?.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    fsDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      left: r.left - (pr?.left ?? 0),
      top: r.top - (pr?.top ?? 0),
    }
  }, [])

  const onFsToolbarPointerMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    if (!fsDragRef.current) return
    const dx = e.clientX - fsDragRef.current.startX
    const dy = e.clientY - fsDragRef.current.startY
    const el = fsToolbarRef.current
    if (!el) return
    const parent = el.offsetParent as HTMLElement | null
    if (!parent) return
    const maxX = parent.clientWidth - el.offsetWidth
    const maxY = parent.clientHeight - el.offsetHeight
    setFsToolbarPos({
      left: Math.max(0, Math.min(fsDragRef.current.left + dx, maxX)),
      top: Math.max(0, Math.min(fsDragRef.current.top + dy, maxY)),
    })
  }, [])

  const onFsToolbarPointerUp = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    fsDragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  const { accounts, activeSymbols, orders } = useLive()
  const accountQuotes = useQuotes()
  const globalQuotes = useGlobalQuotes()
  const positions = usePositions()
  const { toast, placeManualOrder, showToast } = useOrderPlacement()

  // 每个品种的价格轴小数位（与图表 series 精度一致），供自选列表/行情头统一取用。
  // Per-symbol price precision (matches the chart series), shared by the
  // watchlist and symbol header.
  const digitsFor = useCallback((s: string) => SYMBOL_DECIMALS[s] ?? 2, [])

  // 当前品种的全站统一报价（EA 推送，含 bid/ask）；行情头与右栏下单价用它。
  // The active symbol's site-wide quote (EA-pushed, bid/ask); used by the
  // symbol header and the order price on the right rail.
  const activeQuote = symbol ? globalQuotes[symbol] : undefined

  // 右栏账户摘要展示的账户：优先在线账号，否则第一个绑定的。
  // Account shown in the right-rail summary: prefer an online one, else the first bound.
  const primaryAccount = accounts.find((a) => a.online) ?? accounts[0] ?? null

  const handleOrderConfirm = async (
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
    clientOrderId: string,
  ) => {
    if (!orderSide) return
    // 不在这里关弹窗：ChartOrderModal 自己会展示"已提交"回执卡片，再调用
    // onCancel 关闭；立刻关闭会让回执卡片还没渲染出来就被卸载。
    // Don't close the modal here: ChartOrderModal shows its own "submitted"
    // receipt card and calls onCancel itself; closing immediately would
    // unmount it before the receipt card ever gets to render.
    await placeManualOrder(symbol, orderSide, volume, mt5Login, stopLoss, takeProfit, clientOrderId)
  }

  // 云端偏好加载完成后覆盖本地初始值 / override initial values when cloud prefs arrive
  useEffect(() => {
    if (!loaded) return
    const cloudSym = getPref<string>('charts', 'symbol', '')
    if (cloudSym) setSymbol(cloudSym)
    const cloudInt = getPref<string>('charts', 'interval', '')
    if (cloudInt) setIntervalCode(cloudInt)
    const cloudInd = getPref<Partial<IndicatorFlags> | null>('charts', 'indicators', null)
    if (cloudInd) setIndicatorsState({ ...DEFAULT_INDICATORS, ...cloudInd })
    const cloudSettings = getPref<Partial<IndicatorSettings> | null>('charts', 'indicatorSettings', null)
    if (cloudSettings) setIndicatorSettingsState(mergeIndicatorSettings(DEFAULT_INDICATOR_SETTINGS, cloudSettings))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when cloud prefs finish loading
  }, [loaded])

  // 校正当前品种：activeSymbols 首次加载完成前是空数组，此时任何猜测都无法
  // 校验；一旦有了真实列表，若当前品种已不在其中（EA 端删掉了、或还没猜出
  // 值），改用活跃列表的第一个。EA 增删品种时也会顺带把已失效的选择带回来。
  // Correct the current symbol: activeSymbols is empty until it first loads,
  // so nothing can be validated yet. Once the real list is in, if the current
  // symbol isn't in it (removed on the EA side, or never resolved), fall back
  // to the active list's first entry. Also re-corrects if the EA's symbol set
  // changes later and the current selection falls out of it.
  useEffect(() => {
    if (activeSymbols.length === 0) return
    if (!activeSymbols.includes(symbol)) setSymbol(activeSymbols[0])
  }, [activeSymbols, symbol])

  useEffect(() => {
    if (!symbol) return // 尚未校正出有效品种前不写回偏好，避免用空字符串覆盖已保存的选择
                         // don't persist before a valid symbol is resolved, so we never overwrite a saved pref with ''
    setPref('charts', 'symbol', symbol)
  }, [symbol, setPref])

  useEffect(() => {
    setPref('charts', 'interval', interval)
  }, [interval, setPref])

  // 指标开关/参数落库：与 symbol/interval 同一套模式——setState 的更新函数
  // 只做纯粹的状态计算，落库放到单独的 effect 里对状态变化作出反应，绝不在
  // 更新函数内部直接调用 setPref（那是另一个组件 PrefsProvider 的
  // setState）。曾经的实现在更新函数里直接调 setPref，触发过 React 的
  // "Cannot update a component while rendering a different component" 警告，
  // 实测会导致开关状态被异常带乱（点一个开关，另外几个也跟着变了）。
  // Persist indicator toggles/settings the same way symbol/interval already
  // do: the setState updater only computes the next state; persisting
  // happens in its own effect. Never call setPref (another component's —
  // PrefsProvider's — setState) directly inside an updater function — an
  // earlier version of this code did exactly that and triggered React's
  // "Cannot update a component while rendering a different component"
  // warning, observed in testing to scramble the toggle state (clicking one
  // toggle also flipped others).
  useEffect(() => {
    setPref('charts', 'indicators', indicators)
  }, [indicators, setPref])

  useEffect(() => {
    setPref('charts', 'indicatorSettings', indicatorSettings)
  }, [indicatorSettings, setPref])

  const toggleIndicator = useCallback((key: keyof IndicatorFlags) => {
    setIndicatorsState((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const resetIndicatorSettings = useCallback(() => {
    setIndicatorSettingsState(DEFAULT_INDICATOR_SETTINGS)
  }, [])

  // 按当前 candlesRef 重算全部指标并写回各自的 series，同时刷新"最新值"图例
  // 缓存。用 useCallback 空依赖数组保持函数引用稳定（只依赖 ref，不依赖任何
  // state），这样无论从哪个 effect/定时器闭包里调用，读到的都是当时最新的
  // candlesRef/indicatorSettingsRef 内容，不会有陈旧闭包的问题。主图叠加
  // （MA/EMA/BOLL）的 series 从建图起就常驻，因此不论开关与否都照算——代价
  // 可忽略（几百个点的数组运算），换来的是打开开关那一刻数据已经是对的，不
  // 需要额外补一次"刚打开，先算一遍"的逻辑。副图（成交量/RSI/MACD）的
  // series 只在打开时才存在，靠 ref 是否为 null 天然跳过关闭状态的计算。
  // Recompute every indicator from the current candlesRef, write it back to
  // its series, and refresh the "latest value" legend cache. useCallback with
  // an empty dep array keeps this function's identity stable (it only reads
  // refs, no state), so no matter which effect/timer closure calls it, it
  // always sees the latest candlesRef/indicatorSettingsRef contents — no
  // stale-closure risk. Main-pane overlays (MA/EMA/BOLL) always exist once
  // the chart is built, so they're recomputed unconditionally regardless of
  // their toggle (negligible cost for a few-hundred-point array), which means
  // the moment a toggle flips on the data is already correct — no separate
  // "just turned on, backfill now" step needed. Sub-pane indicators
  // (volume/RSI/MACD) only exist while enabled, so a null ref naturally skips
  // the work while off.
  const indicatorSettingsRef = useRef(indicatorSettings)
  useEffect(() => {
    indicatorSettingsRef.current = indicatorSettings
  }, [indicatorSettings])

  const recomputeIndicators = useCallback(() => {
    const bars = candlesRef.current
    if (bars.length === 0) return
    const times = bars.map((b) => b.t as UTCTimestamp)
    const cl = closes(bars)
    const s = indicatorSettingsRef.current
    const next: LegendValues = {
      ma: new Array(s.ma.periods.length).fill(null),
      ema: new Array(s.ema.periods.length).fill(null),
      boll: { mid: null, upper: null, lower: null },
      volume: null,
      rsi: null,
      macd: { macd: null, signal: null, hist: null },
    }

    s.ma.periods.forEach((period, i) => {
      const line = sma(cl, period)
      maSeriesRef.current[i]?.setData(toLinePoints(times, line))
      next.ma[i] = line[line.length - 1] ?? null
    })
    s.ema.periods.forEach((period, i) => {
      const line = ema(cl, period)
      emaSeriesRef.current[i]?.setData(toLinePoints(times, line))
      next.ema[i] = line[line.length - 1] ?? null
    })
    if (bollSeriesRef.current) {
      const { mid, upper, lower } = bollinger(cl, s.boll.period, s.boll.mult)
      bollSeriesRef.current.mid.setData(toLinePoints(times, mid))
      bollSeriesRef.current.upper.setData(toLinePoints(times, upper))
      bollSeriesRef.current.lower.setData(toLinePoints(times, lower))
      next.boll = { mid: mid[mid.length - 1] ?? null, upper: upper[upper.length - 1] ?? null, lower: lower[lower.length - 1] ?? null }
    }
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.setData(
        bars.map((b) => ({ time: b.t as UTCTimestamp, value: b.v, color: b.c >= b.o ? s.volume.upColor : s.volume.downColor }))
      )
      next.volume = bars[bars.length - 1]?.v ?? null
    }
    if (rsiSeriesRef.current) {
      const line = rsi(cl, s.rsi.period)
      rsiSeriesRef.current.series.setData(toLinePoints(times, line))
      next.rsi = line[line.length - 1] ?? null
    }
    if (macdSeriesRef.current) {
      const { macd: macdLine, signal, hist } = macd(cl, s.macd.fast, s.macd.slow, s.macd.signal)
      macdSeriesRef.current.macd.setData(toLinePoints(times, macdLine))
      macdSeriesRef.current.signal.setData(toLinePoints(times, signal))
      macdSeriesRef.current.hist.setData(toHistPoints(times, hist, UP_COLOR, DOWN_COLOR))
      next.macd = {
        macd: macdLine[macdLine.length - 1] ?? null,
        signal: signal[signal.length - 1] ?? null,
        hist: hist[hist.length - 1] ?? null,
      }
    }

    latestLegendRef.current = next
    // 只在没有悬停/触摸拖动时才更新图例；正悬停时图例完全交给
    // onCrosshairMove 维护，避免 2 秒一次的报价轮询把用户正看着的历史值打回
    // "最新值"（见 hoveringRef 的说明）。
    // Only update the legend while not hovering/touch-dragging; while
    // hovering, the legend is owned entirely by onCrosshairMove — otherwise
    // the 2-second quote-poll timer would stomp the user's currently-viewed
    // historical value back to "latest" (see hoveringRef's comment).
    if (!hoveringRef.current) setLegend(next)
  }, [])

  // 按容器高度重新分配各 pane 的高度：主图占大头，副图（成交量/RSI/MACD）
  // 平分剩余空间，每个不低于 70px 以保证波形仍可辨认；同时把每个已开启副图
  // 的顶部像素偏移记下来供图例定位（顺序固定为 成交量→RSI→MACD，与下方开关
  // effect 里创建它们的顺序一致）。resize 与副图开关都会调用它。
  // Redistribute pane heights from the container's height: the main pane gets
  // the lion's share, sub-panes (volume/RSI/MACD) split what's left, each
  // floored at 70px so the waveform stays legible; also records each enabled
  // sub-pane's top pixel offset for positioning its legend (fixed order:
  // volume -> RSI -> MACD, matching the creation order in the toggle effect
  // below). Called on resize and whenever a sub-pane indicator is toggled.
  const applyPaneHeights = useCallback(() => {
    const chart = chartRef.current
    const host = containerRef.current
    if (!chart || !host) return
    const panes = chart.panes()
    const total = host.clientHeight
    if (panes.length <= 1 || total <= 0) {
      setPaneOffsets({ volume: null, rsi: null, macd: null })
      return
    }
    const subCount = panes.length - 1
    const subTotal = Math.max(total * 0.35, subCount * 70)
    const mainHeight = Math.max(total - subTotal, total * 0.4)
    const subHeight = Math.floor((total - mainHeight) / subCount)
    panes[0].setHeight(Math.floor(mainHeight))
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(subHeight)

    let offset = Math.floor(mainHeight)
    const offsets: { volume: number | null; rsi: number | null; macd: number | null } = { volume: null, rsi: null, macd: null }
    if (volumeSeriesRef.current) {
      offsets.volume = offset
      offset += subHeight
    }
    if (rsiSeriesRef.current) {
      offsets.rsi = offset
      offset += subHeight
    }
    if (macdSeriesRef.current) {
      offsets.macd = offset
      offset += subHeight
    }
    setPaneOffsets(offsets)
  }, [])

  // 建图（只建一次），容器尺寸变化时自适配 / build the chart once; auto-sizes with the container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const initSettings = indicatorSettingsRef.current

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'rgba(10, 7, 16, 1)' },
        textColor: '#94a3b8',
        // 关闭库自带的 TradingView 署名 logo；Apache-2.0 许可要求的署名改用
        // 下方免责声明旁边的文字链接满足（见 charts.disclaimer 附近的 <a>）。
        // Disable the library's built-in TradingView attribution logo; the
        // Apache-2.0 license's attribution requirement is satisfied instead
        // via the text link next to the disclaimer below.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(139, 70, 255, 0.08)' },
        horzLines: { color: 'rgba(139, 70, 255, 0.08)' },
      },
      rightPriceScale: { borderColor: 'rgba(139, 70, 255, 0.15)' },
      timeScale: {
        borderColor: 'rgba(139, 70, 255, 0.15)',
        timeVisible: true,
        secondsVisible: false,
        // 坐标轴刻度用的格式化函数，见上方 fmtChartTime 的说明。
        // Axis tick-mark formatter — see fmtChartTime's comment above.
        tickMarkFormatter: fmtChartTime,
      },
      // localization.timeFormatter 管十字准线悬停时显示的精确时间，必须跟
      // tickMarkFormatter 用同一个函数，否则悬停时间会掉回浏览器本地时区。
      // localization.timeFormatter controls the crosshair's hover time
      // readout; must share the same formatter as tickMarkFormatter or the
      // hover time falls back to the browser's local timezone.
      localization: { timeFormatter: fmtChartTime },
      crosshair: { mode: 0 },
      // 移动端纵向滑动穿透到页面滚动，保留横向拖动平移图表
      handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true },
      width: el.clientWidth,
      height: el.clientHeight,
    })
    // v5：series 创建统一走 addSeries(SeriesType, options)，取代 v4 的
    // addCandlestickSeries(options)；坐标换算类 API（DrawLayer 用到的
    // timeToCoordinate/priceToCoordinate 等）在 v4→v5 之间未变。
    // v5: series creation is unified as addSeries(SeriesType, options),
    // replacing v4's addCandlestickSeries(options); the coordinate-conversion
    // APIs (timeToCoordinate/priceToCoordinate etc., used by DrawLayer) are
    // unchanged between v4 and v5.
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      borderVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = series

    // 布林带 series：一次性建好、常驻，初始 visible:false，真正的可见性由下方
    // 按开关同步的 effect 立即接管。crosshairMarkerVisible:false 去掉十字准线
    // 悬停时每条线上出现的圆点——那是 lightweight-charts 的默认行为，用户反馈
    // 这些圆点没有必要、观感上是噪音。MA/EMA 不在这里创建——它们是条数可变的
    // 均线列表（用户可加/删），由各自专门的 effect（见下方）负责创建/重建，
    // 那个 effect 在挂载时也会跑一次，天然完成"初始创建"，不需要在这里重复。
    // Bollinger series: created once, permanent; starts with visible:false —
    // the actual visibility is taken over immediately by the effect below
    // that syncs it to the toggles. crosshairMarkerVisible:false removes the
    // little circle lightweight-charts draws on each line at the crosshair's
    // position by default — user feedback was that these dots are
    // unnecessary visual noise. MA/EMA are NOT created here — they're
    // variable-length line lists (the user can add/remove lines), owned by
    // their own dedicated effects below, which also run once on mount and
    // naturally handle the "initial creation" case, so there's no need to
    // duplicate it here.
    bollSeriesRef.current = {
      mid: chart.addSeries(LineSeries, {
        color: initSettings.boll.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: false,
      }),
      upper: chart.addSeries(LineSeries, {
        color: initSettings.boll.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: false,
      }),
      lower: chart.addSeries(LineSeries, {
        color: initSettings.boll.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: false,
      }),
    }

    setDrawReady(true)

    // 十字准线/触摸拖动 → 图例：param.time 有值表示鼠标悬停或手指拖动落在
    // 数据区内，用 param.seriesData 查该时刻各 series 的值；undefined 表示
    // 鼠标移出图表/未在拖动，回退到 recomputeIndicators 缓存的"最新值"。
    // lightweight-charts 对触摸事件的处理与鼠标共用同一套订阅，移动端手指
    // 拖动天然会触发这个回调，不需要额外适配；v5 默认的 trackingMode
    // （OnNextTap）也已经让触摸场景下十字准线在松手后继续停留，直到下一次点击。
    // Crosshair hover / touch-drag -> legend: param.time is set when the
    // mouse is hovering or a finger is dragging within the data area; look up
    // each series' value at that moment via param.seriesData. undefined means
    // the mouse left the chart / no active drag, so fall back to
    // recomputeIndicators' cached "latest value". lightweight-charts routes
    // touch events through the same subscription as mouse events, so a
    // finger drag on mobile fires this callback with no extra wiring needed;
    // v5's default trackingMode (OnNextTap) already keeps the crosshair
    // in place after lifting the finger, until the next tap elsewhere.
    const onCrosshairMove: Parameters<typeof chart.subscribeCrosshairMove>[0] = (param) => {
      if (param.time == null) {
        hoveringRef.current = false
        setLegend(latestLegendRef.current)
        return
      }
      hoveringRef.current = true
      const readLine = (s: ISeriesApi<'Line'> | undefined): number | null => {
        if (!s) return null
        const d = param.seriesData.get(s) as { value?: number } | undefined
        return d?.value ?? null
      }
      const readHist = (s: ISeriesApi<'Histogram'> | undefined): number | null => {
        if (!s) return null
        const d = param.seriesData.get(s) as { value?: number } | undefined
        return d?.value ?? null
      }
      const next: LegendValues = {
        ma: maSeriesRef.current.map((s) => readLine(s)),
        ema: emaSeriesRef.current.map((s) => readLine(s)),
        boll: {
          mid: readLine(bollSeriesRef.current?.mid),
          upper: readLine(bollSeriesRef.current?.upper),
          lower: readLine(bollSeriesRef.current?.lower),
        },
        volume: readHist(volumeSeriesRef.current ?? undefined),
        rsi: readLine(rsiSeriesRef.current?.series),
        macd: {
          macd: readLine(macdSeriesRef.current?.macd),
          signal: readLine(macdSeriesRef.current?.signal),
          hist: readHist(macdSeriesRef.current?.hist),
        },
      }
      setLegend(next)
    }
    chart.subscribeCrosshairMove(onCrosshairMove)

    // 自适配容器尺寸：手动管理而不是用 lightweight-charts 的 autoSize 选项，
    // 在部分渲染环境下其内部 ResizeObserver 不会触发重绘（canvas 位图分辨率
    // 卡在浏览器默认的 300x150），显式 resize() 更可靠。
    // Track the container size ourselves instead of the library's autoSize
    // option — in some rendering environments its internal ResizeObserver
    // never repaints (the canvas bitmap resolution stays stuck at the
    // browser's default 300x150); an explicit resize() call is more reliable.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      // forceRepaint=true：跳过内部按 requestAnimationFrame 批处理的重绘排期，
      // 立即同步重绘，resize 时不会有一帧尺寸不对的闪烁。
      // forceRepaint=true: skips the internal requestAnimationFrame-batched
      // redraw scheduling and repaints immediately/synchronously, avoiding a
      // one-frame flash of the wrong size on resize.
      if (width > 0 && height > 0) {
        chart.resize(width, height, true)
        applyPaneHeights()
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      maSeriesRef.current = []
      emaSeriesRef.current = []
      bollSeriesRef.current = null
      volumeSeriesRef.current = null
      rsiSeriesRef.current = null
      macdSeriesRef.current = null
      setDrawReady(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- build the chart once; applyPaneHeights is stable (empty deps)
  }, [])

  // MA 均线：条数可变（用户可在设置弹窗里逐条加/删），条数变化时整体拆掉重建
  // （同一 pane 内，不涉及 pane 下标管理，比副图的动态增删简单）；只是编辑
  // 已有条目的周期/颜色或开关时不重建，只更新 visible/color 并重算数值。
  // 这个 effect 在挂载时也会跑一次（此时 maSeriesRef.current 是空数组，长度
  // 必然不等于设置里的条数），天然完成初始创建，不需要在建图 effect 里重复。
  // MA lines: variable count (the user can add/remove lines one at a time in
  // the settings modal); a count change tears down and rebuilds the whole set
  // (simpler than the sub-panes' dynamic add/remove since this stays within
  // the same pane — no pane-index bookkeeping involved). Editing an existing
  // line's period/color, or just toggling on/off, doesn't rebuild — only
  // updates visible/color and recomputes the values. This effect also runs
  // once on mount (maSeriesRef.current starts empty, so its length never
  // matches the settings' line count), naturally handling initial creation
  // without duplicating it in the chart-build effect.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const want = indicatorSettings.ma.periods.length
    if (maSeriesRef.current.length !== want) {
      maSeriesRef.current.forEach((s) => chart.removeSeries(s))
      maSeriesRef.current = indicatorSettings.ma.periods.map((_, i) =>
        chart.addSeries(LineSeries, {
          color: indicatorSettings.ma.colors[i],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          visible: indicators.ma,
        })
      )
    } else {
      maSeriesRef.current.forEach((s, i) => s.applyOptions({ visible: indicators.ma, color: indicatorSettings.ma.colors[i] }))
    }
    recomputeIndicators()
  }, [indicators.ma, indicatorSettings.ma, recomputeIndicators])

  // EMA：与上面 MA 的处理完全一致，只是换一套 ref/设置 / EMA: identical handling to MA above, just a different ref/settings pair
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const want = indicatorSettings.ema.periods.length
    if (emaSeriesRef.current.length !== want) {
      emaSeriesRef.current.forEach((s) => chart.removeSeries(s))
      emaSeriesRef.current = indicatorSettings.ema.periods.map((_, i) =>
        chart.addSeries(LineSeries, {
          color: indicatorSettings.ema.colors[i],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          visible: indicators.ema,
        })
      )
    } else {
      emaSeriesRef.current.forEach((s, i) => s.applyOptions({ visible: indicators.ema, color: indicatorSettings.ema.colors[i] }))
    }
    recomputeIndicators()
  }, [indicators.ema, indicatorSettings.ema, recomputeIndicators])

  // 布林带可见性 + 颜色同步：固定 3 条线（中/上/下轨），形状不像 MA/EMA 那样
  // 可变，不需要重建逻辑。/ Sync Bollinger visibility + color: a fixed shape
  // (mid/upper/lower), unlike MA/EMA it's never variable-length, so no
  // rebuild logic is needed.
  useEffect(() => {
    if (!bollSeriesRef.current) return
    const c = indicatorSettings.boll.color
    bollSeriesRef.current.mid.applyOptions({ visible: indicators.boll, color: c })
    bollSeriesRef.current.upper.applyOptions({ visible: indicators.boll, color: c })
    bollSeriesRef.current.lower.applyOptions({ visible: indicators.boll, color: c })
  }, [indicators.boll, indicatorSettings.boll.color])

  // RSI 参考线价位同步：overbought/oversold 可客制化，改动时更新已存在的两条
  // 价格线，不需要重建整条 series。/ Sync RSI reference-line prices:
  // overbought/oversold are customizable; update the two existing price
  // lines on change without rebuilding the whole series.
  useEffect(() => {
    if (!rsiSeriesRef.current) return
    rsiSeriesRef.current.obLine.applyOptions({ price: indicatorSettings.rsi.overbought, title: String(indicatorSettings.rsi.overbought) })
    rsiSeriesRef.current.osLine.applyOptions({ price: indicatorSettings.rsi.oversold, title: String(indicatorSettings.rsi.oversold) })
    rsiSeriesRef.current.series.applyOptions({ color: indicatorSettings.rsi.color })
  }, [indicatorSettings.rsi.overbought, indicatorSettings.rsi.oversold, indicatorSettings.rsi.color])

  // MACD 线条颜色同步 / sync MACD line colors
  useEffect(() => {
    if (!macdSeriesRef.current) return
    macdSeriesRef.current.macd.applyOptions({ color: indicatorSettings.macd.macdColor })
    macdSeriesRef.current.signal.applyOptions({ color: indicatorSettings.macd.signalColor })
  }, [indicatorSettings.macd.macdColor, indicatorSettings.macd.signalColor])

  // 任何会影响数值本身的参数变化（周期、布林带倍数、成交量涨跌配色等）都要
  // 重新计算——直接依赖整个 indicatorSettings 对象最简单：多算几遍主图叠加
  // 指标的开销可忽略，换来不必逐字段精确列依赖的简单性。
  // Any change that affects the values themselves (periods, Bollinger
  // multiplier, volume up/down colors, etc.) needs a recompute — depending on
  // the whole indicatorSettings object is simplest: the extra cost of
  // recomputing the always-present main-pane overlays a few more times is
  // negligible, in exchange for not having to list every field individually.
  useEffect(() => {
    recomputeIndicators()
  }, [indicatorSettings, recomputeIndicators])

  // 副图指标（成交量/RSI/MACD）开关：先整体拆掉旧的三个副图 series（移除后
  // 空 pane 会被库自动删除），再按当前开关状态依次重建，用
  // chart.panes().length 作为新 pane 的下标即可保证总是追加在最后——不需要
  // 手动维护"谁在第几个 pane"这本账。
  // Sub-pane indicator toggles (volume/RSI/MACD): tear down all three
  // existing sub-pane series first (removing them auto-deletes their
  // now-empty panes), then recreate whichever are enabled, using
  // chart.panes().length as the new pane's index — this always appends as
  // the last pane, so there's no manual "which indicator lives in which pane"
  // bookkeeping to get wrong.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const s = indicatorSettingsRef.current

    if (volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current)
      volumeSeriesRef.current = null
    }
    if (rsiSeriesRef.current) {
      chart.removeSeries(rsiSeriesRef.current.series)
      rsiSeriesRef.current = null
    }
    if (macdSeriesRef.current) {
      chart.removeSeries(macdSeriesRef.current.hist)
      chart.removeSeries(macdSeriesRef.current.signal)
      chart.removeSeries(macdSeriesRef.current.macd)
      macdSeriesRef.current = null
    }

    if (indicators.volume) {
      volumeSeriesRef.current = chart.addSeries(
        HistogramSeries,
        { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
        chart.panes().length
      )
    }
    if (indicators.rsi) {
      const line = chart.addSeries(
        LineSeries,
        { color: s.rsi.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
        chart.panes().length
      )
      // 超买/超卖参考线（价位可客制化，见上方同步 effect）/ overbought/oversold reference lines (customizable price, see the sync effect above)
      const obLine = line.createPriceLine({
        price: s.rsi.overbought,
        color: 'rgba(148,163,184,0.5)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: String(s.rsi.overbought),
      })
      const osLine = line.createPriceLine({
        price: s.rsi.oversold,
        color: 'rgba(148,163,184,0.5)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: String(s.rsi.oversold),
      })
      rsiSeriesRef.current = { series: line, obLine, osLine }
    }
    if (indicators.macd) {
      const paneIndex = chart.panes().length
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex)
      const macdLine = chart.addSeries(
        LineSeries,
        { color: s.macd.macdColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
        paneIndex
      )
      const signal = chart.addSeries(
        LineSeries,
        { color: s.macd.signalColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
        paneIndex
      )
      macdSeriesRef.current = { macd: macdLine, signal, hist }
    }

    applyPaneHeights()
    recomputeIndicators()
  }, [indicators.volume, indicators.rsi, indicators.macd, applyPaneHeights, recomputeIndicators])

  // 切品种/周期：拉历史快照 + 起轮询最新价 / on symbol or interval change: fetch history + poll latest
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !symbol) return // symbol 为空说明 activeSymbols 还没校正出有效值，等下一轮
                                    // empty symbol means activeSymbols hasn't resolved a valid value yet
    let alive = true
    setHasData(false)
    setStale(false)
    setLastPrice(0)
    setDayStats(null)
    lastTimeRef.current = 0
    barTimesRef.current = []
    candlesRef.current = []

    // 把一根 bar 应用到图表：只在其时间 >= 已应用的最新时间时更新，避免
    // lightweight-charts 对更早时间抛错而中断实时刷新。
    // Apply one bar to the chart, but only when its time >= the newest applied
    // time — otherwise lightweight-charts throws on an older time and the live
    // refresh stalls.
    const applyBar = (b: Candle) => {
      if (b.t < lastTimeRef.current) return
      series.update(toLwPoint(b))
      lastTimeRef.current = b.t
    }

    // 把一根 bar 合并进 candlesRef：相同时间戳覆盖（形成中的 bar），新时间戳
    // 追加并按 MAX_CLIENT_BARS 截断——语义上镜像后端 chart_store.merge_bars。
    // Merge one bar into candlesRef: same timestamp overwrites (bar still
    // forming), newer timestamp appends and gets trimmed to
    // MAX_CLIENT_BARS — mirrors the backend's chart_store.merge_bars semantics.
    const mergeCandle = (b: Candle) => {
      const arr = candlesRef.current
      const lastT = arr.length ? arr[arr.length - 1].t : -Infinity
      if (b.t < lastT) return
      if (b.t === lastT) arr[arr.length - 1] = b
      else {
        arr.push(b)
        if (arr.length > MAX_CLIENT_BARS) arr.shift()
      }
    }

    // 按品种设置价格轴小数位数，否则默认按 2 位显示，外汇对（如 EURUSD）
    // 会把 1.08543 截断成 1.09 这种不可用的精度。
    // Set the price-scale precision per symbol; otherwise it defaults to 2
    // digits, truncating FX pairs (e.g. EURUSD) to an unusable 1.08543 -> 1.09.
    const decimals = SYMBOL_DECIMALS[symbol] ?? 2
    series.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: Math.pow(10, -decimals) },
    })

    chartApi.history(symbol, interval).then((r) => {
      if (!alive) return
      if (r.bars.length > 0) {
        series.setData(r.bars.map(toLwPoint))
        lastTimeRef.current = r.bars[r.bars.length - 1].t
        setLastPrice(r.bars[r.bars.length - 1].c)
        barTimesRef.current = r.bars.map((b) => b.t)
        candlesRef.current = r.bars.slice(-MAX_CLIENT_BARS)
        recomputeIndicators()
        setDayStats(computeDayStats(candlesRef.current))
        chartRef.current?.timeScale().fitContent()
        setHasData(true)
      } else {
        setHasData(false)
      }
    }).catch(() => {
      if (alive) setHasData(false)
    })

    const timer = window.setInterval(() => {
      chartApi.latest(symbol, interval).then((r) => {
        if (!alive) return
        for (const b of r.bars) applyBar(b)
        for (const b of r.bars) mergeCandle(b)
        // 追加新出现的 bar 时间，保持 barTimesRef 与图表同步 / keep bar times in sync
        for (const b of r.bars) {
          const arr = barTimesRef.current
          if (arr.length && b.t > arr[arr.length - 1]) arr.push(b.t)
        }
        if (r.bars.length > 0) {
          setHasData(true)
          setLastPrice(r.bars[r.bars.length - 1].c)
          recomputeIndicators()
          setDayStats(computeDayStats(candlesRef.current))
        }
        const fresh = r.updatedAt != null && Date.now() / 1000 - r.updatedAt < STALE_MS / 1000
        setStale(r.updatedAt != null && !fresh)
      }).catch(() => {})
    }, POLL_MS)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [symbol, interval, recomputeIndicators])

  // 手机端切回"图表"视图时强制重绘：容器此前是 display:none（尺寸为 0），
  // 恢复显示后 ResizeObserver 一般会触发，但个别浏览器不稳，这里主动补一次
  // resize，确保图表填满、不残留 300×150 默认位图。桌面（lg+）此状态恒为
  // 'chart'，effect 只在挂载时跑一次，无副作用。
  // Force a repaint when returning to the "chart" view on mobile: the container
  // was display:none (zero size), and while the ResizeObserver usually fires on
  // reveal, some browsers are flaky — so proactively resize once to ensure the
  // chart fills and doesn't keep the 300×150 default bitmap. At lg+ this stays
  // 'chart', so the effect runs once on mount with no side effect.
  useEffect(() => {
    if (mobileView !== 'chart') return
    const el = containerRef.current
    const chart = chartRef.current
    if (!el || !chart) return
    const raf = requestAnimationFrame(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        chart.resize(el.clientWidth, el.clientHeight, true)
        applyPaneHeights()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [mobileView, applyPaneHeights])

  const decimals = SYMBOL_DECIMALS[symbol] ?? 2

  return (
    <div className="term-shell">
      {/* drawVersion 用于外部画线工具栏状态变更时强制 ChartsPage 重渲染 */}
      {void drawVersion}

      {/* 左栏：自选品种列表（桌面常驻；窄屏隐藏，手机端终端在阶段 3 单独做）。
          可见性放在这层普通 wrapper 上，而不是直接给 .term-panel 加 hidden——
          .term-panel 的 display:flex 在样式表里排在 Tailwind .hidden 之后，会盖
          掉它，wrapper 不是 .term-panel 就没有这个冲突。
          Left column: watchlist (desktop only for now). Visibility lives on this
          plain wrapper, not on .term-panel directly — .term-panel's display:flex
          comes after Tailwind's .hidden in the sheet and would override it; the
          wrapper isn't a .term-panel so there's no conflict. */}
      <div className="term-col-left hidden min-h-0 lg:flex lg:flex-col">
        <WatchlistPanel
          className="flex-1"
          symbols={activeSymbols}
          quotes={globalQuotes}
          active={symbol}
          onSelect={setSymbol}
          digitsFor={digitsFor}
        />
      </div>

      {/* 中栏：行情头 + 控制条 + 图表 / center: symbol header + controls + chart */}
      <div className="term-center">
        {/* 手机端视图切换（桌面隐藏；全屏时隐藏）：图表 / 自选 / 交易 / 持仓。
            Mobile view switcher (hidden on desktop & in fullscreen). */}
        {!isFullscreen && (
          <div className="term-mtabs lg:hidden">
            {([
              ['chart', '图表'],
              ['watchlist', '自选'],
              ['trade', '交易'],
              ['positions', '持仓'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={mobileView === key ? 'on' : ''}
                onClick={() => setMobileView(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* 图表视图：桌面恒显示（三栏之一）；手机端仅在"图表"视图显示。
            图表容器无论如何都保持挂载，切走时靠外层 max-lg:hidden 隐藏而非卸载。
            Chart view: always shown on desktop; on mobile only in the chart view.
            The chart stays mounted regardless — hidden via max-lg:hidden, never
            unmounted. */}
        <div className={`term-chartview ${mobileView === 'chart' ? '' : 'max-lg:hidden'}`}>
        {/* 品种行情头（全屏时隐藏）/ symbol header (hidden in fullscreen) */}
        {!isFullscreen && (
          <SymbolHeader
            symbol={symbol}
            bid={activeQuote?.bid ?? null}
            ask={activeQuote?.ask ?? null}
            digits={decimals}
            dayStats={dayStats}
            fallbackPrice={lastPrice}
          />
        )}

      {/* 桌面单条工具栏（全屏时隐藏）：周期钉左 · 画线工具中部横滑 · 添加指标钉右。
          可见性放在这层普通 wrapper 上而不是直接给 .term-toolbar 加 hidden——
          .term-toolbar 自带 display:flex，在样式表里排在 Tailwind .hidden 之后会
          盖掉它（与左栏自选同一个坑，见其注释）。
          Desktop single toolbar (hidden in fullscreen): interval pinned left ·
          draw tools scroll in the middle · add-indicator pinned right.
          Visibility lives on this plain wrapper, not on .term-toolbar directly —
          it has its own display:flex which would override Tailwind's .hidden
          coming earlier in the sheet (same pitfall as the watchlist; see its
          comment). */}
      {!isFullscreen && (
        <div className="hidden lg:block">
          <div className="term-toolbar">
            <div className="term-ivseg">
              {INTERVALS.map((iv) => (
                <button
                  key={iv.code}
                  type="button"
                  onClick={() => setIntervalCode(iv.code)}
                  className={interval === iv.code ? 'on' : ''}
                >
                  {iv.label}
                </button>
              ))}
            </div>
            {drawReady && <DrawToolsRow drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} />}
            <div className="term-toolbar-right">
              {stale && <span className="term-stale">{t('charts.stale')}</span>}
              <button type="button" onClick={() => setSettingsOpen(true)} className="term-tool-indicator">
                {t('charts.indicators.button')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 手机端工具栏（全屏时隐藏）：周期切换 + 画笔开关 + 添加指标三件套，参考
          Web3 手机交易 App 的精简默认界面——画线工具默认收起，点画笔才展开成
          下面的可换行工具行，避免十几个小图标常驻挤在窄屏上。
          Mobile toolbar (hidden in fullscreen): interval switch + a draw toggle +
          add-indicator only, mirroring the lean default screen of Web3 mobile
          trading apps — draw tools start collapsed and expand into the wrapping
          row below on tap, instead of a dozen small icons permanently crowding a
          narrow screen. */}
      {!isFullscreen && (
        <div className="lg:hidden">
          <div className="term-toolbar-m">
            <div className="term-ivseg">
              {INTERVALS.map((iv) => (
                <button
                  key={iv.code}
                  type="button"
                  onClick={() => setIntervalCode(iv.code)}
                  className={interval === iv.code ? 'on' : ''}
                >
                  {iv.label}
                </button>
              ))}
            </div>
            <div className="term-toolbar-m-right">
              {stale && <span className="term-stale">{t('charts.stale')}</span>}
              {drawReady && (
                <button
                  type="button"
                  onClick={() => setMobileToolsOpen((v) => !v)}
                  aria-label={String(t('charts.draw.button'))}
                  className={`term-tool-btn ${mobileToolsOpen ? 'on' : ''}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                </button>
              )}
              <button type="button" onClick={() => setSettingsOpen(true)} className="term-tool-indicator">
                {t('charts.indicators.button')}
              </button>
            </div>
          </div>
          {drawReady && mobileToolsOpen && (
            <div className="term-toolbar-m-expand">
              <DrawToolsRow drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} wrap />
            </div>
          )}
        </div>
      )}

      {/* 手机端·常驻买卖条：紧贴周期/工具栏下方（不再挤在图表下面要滚动才能
          看到），矮一些更省高度。点开走既有的滑动确认下单弹窗（ChartOrderModal）。
          桌面隐藏（右栏已有完整下单面板）。全屏时隐藏。
          Mobile docked buy/sell bar: right under the interval/toolbar row
          (no longer squeezed below the chart, out of easy reach), shorter to
          save height. Opens the existing slide-to-confirm order modal. Hidden
          on desktop (the right rail has the full ticket) and in fullscreen. */}
      {!isFullscreen && (
        <div className="term-mbuysell lg:hidden">
          <button type="button" className="sell" onClick={() => setOrderSide('SELL')}>
            <span className="lab">卖 SELL</span>
            <span className="px num">{activeQuote?.bid != null ? activeQuote.bid.toFixed(decimals) : lastPrice ? lastPrice.toFixed(decimals) : '—'}</span>
          </button>
          <button type="button" className="buy" onClick={() => setOrderSide('BUY')}>
            <span className="lab">买 BUY</span>
            <span className="px num">{activeQuote?.ask != null ? activeQuote.ask.toFixed(decimals) : lastPrice ? lastPrice.toFixed(decimals) : '—'}</span>
          </button>
        </div>
      )}

      {/* 图表容器：无缝（无自身边框/圆角/内边距），窄屏 70vh，桌面填满中栏剩余
          高度（.term-chart 内处理）。/ Chart container: seamless (no own border/
          radius/padding); 70vh on narrow screens, fills the center column on
          desktop (handled in .term-chart). */}
      <div className={`term-chart ${isFullscreen ? 'chart-fullscreen-container' : ''}`}>
        {/* 全屏开关按钮（仅手机端显示）：同一个按钮进出，进入自动横屏，退出恢复竖屏 */}
        <button
          type="button"
          onClick={isFullscreen ? exitFullscreen : enterFullscreen}
          aria-label={isFullscreen ? t('charts.fullscreen.exit') : t('charts.fullscreen.enter')}
          title={isFullscreen ? t('charts.fullscreen.exit') : t('charts.fullscreen.enter')}
          className="lg:hidden absolute top-2 left-2 z-30 flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-ink-900/70 text-slate-300 backdrop-blur-sm transition hover:text-white hover:border-white/20 active:scale-90"
        >
          {isFullscreen ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="10" y1="14" x2="3" y2="21" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>

        {/* 全屏态时间周期切换：右上角横排，紧凑按钮，方便横屏时切周期 */}
        {isFullscreen && (
          <div className="absolute top-2 right-12 z-30 flex items-center gap-0.5 rounded-lg border border-white/10 bg-ink-900/70 backdrop-blur-sm p-0.5">
            {INTERVALS.map((iv) => (
              <button
                key={iv.code}
                onClick={() => setIntervalCode(iv.code)}
                className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
                  interval === iv.code
                    ? 'bg-prism-600/40 text-prism-200'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {iv.label}
              </button>
            ))}
          </div>
        )}

        <div ref={containerRef} className="h-full w-full" />
        {drawReady && chartRef.current && seriesRef.current && containerRef.current && (
          <DrawLayer
            ref={drawLayerRef}
            chart={chartRef.current}
            series={seriesRef.current}
            host={containerRef.current}
            symbol={symbol}
            lastPrice={lastPrice}
            barTimes={getBarTimes}
            digits={decimals}
            hideToolbar
          />
        )}
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-500">
            {t('charts.empty')}
          </div>
        )}

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
            className="pointer-events-none absolute left-3 z-20 rounded-md bg-ink-900/40 px-2 py-0.5 font-mono text-[11px] text-slate-300 backdrop-blur-sm"
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

        {/* 全屏态悬浮画线工具栏（可拖移） */}
        {isFullscreen && drawReady && (
          <div
            ref={fsToolbarRef}
            className="chart-fs-toolbar"
            style={
              fsToolbarPos
                ? { left: fsToolbarPos.left, top: fsToolbarPos.top }
                : { left: 8, bottom: 32 }
            }
          >
            {/* 拖动把手：整条都是热区，配一个明显的抓手图标，方便拖动 */}
            <div
              className="chart-fs-toolbar-handle"
              onPointerDown={onFsToolbarPointerDown}
              onPointerMove={onFsToolbarPointerMove}
              onPointerUp={onFsToolbarPointerUp}
              onPointerCancel={onFsToolbarPointerUp}
            >
              <svg width="26" height="12" viewBox="0 0 26 12" fill="currentColor" opacity="0.5">
                <circle cx="7" cy="4" r="1.4" /><circle cx="13" cy="4" r="1.4" /><circle cx="19" cy="4" r="1.4" />
                <circle cx="7" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /><circle cx="19" cy="8" r="1.4" />
              </svg>
            </div>
            {/* 工具按钮 */}
            <div className="flex items-center gap-1">
              {(ToolList as Tool[]).map((toolName) => (
                <button
                  key={toolName}
                  type="button"
                  title={String(t(`charts.draw.${toolName}`))}
                  aria-label={String(t(`charts.draw.${toolName}`))}
                  onClick={() => { drawLayerRef.current?.setTool(toolName); bumpDraw() }}
                  className={`flex h-6 w-6 items-center justify-center rounded-md border transition ${
                    drawLayerRef.current?.tool === toolName
                      ? 'border-prism-500/60 bg-prism-600/25 text-prism-200'
                      : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'
                  }`}
                >
                  <DrawToolIcon tool={toolName} />
                </button>
              ))}
              <span className="mx-0.5 h-5 w-px bg-white/10" />
              {['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451'].map((c) => (
                <button
                  key={c}
                  type="button"
                  title={t('charts.draw.color')}
                  aria-label={t('charts.draw.color')}
                  onClick={() => { drawLayerRef.current?.applyColor(c); bumpDraw() }}
                  className={`h-3.5 w-3.5 rounded-full border transition ${
                    drawLayerRef.current?.color === c ? 'border-white scale-110' : 'border-white/20'
                  }`}
                  style={{ background: c }}
                />
              ))}
              <span className="mx-0.5 h-5 w-px bg-white/10" />
              <button type="button" title={t('charts.draw.lock')} aria-label={t('charts.draw.lock')} onClick={() => { drawLayerRef.current?.toggleLock(); bumpDraw() }} disabled={!drawLayerRef.current?.selectedId}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 transition hover:text-slate-100 disabled:opacity-30"
              ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg></button>
              <button type="button" title={t('charts.draw.undo')} aria-label={t('charts.draw.undo')} onClick={() => { drawLayerRef.current?.undo(); bumpDraw() }}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 transition hover:text-slate-100"
              ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 102.13-9.36L1 10" /></svg></button>
              <button type="button" title={t('charts.draw.redo')} aria-label={t('charts.draw.redo')} onClick={() => { drawLayerRef.current?.redo(); bumpDraw() }}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 transition hover:text-slate-100"
              ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg></button>
              <span className="mx-0.5 h-5 w-px bg-white/10" />
              <button type="button" title={t('charts.draw.delete')} aria-label={t('charts.draw.delete')}
                onClick={() => { drawLayerRef.current?.deleteSelected(); bumpDraw() }} disabled={!drawLayerRef.current?.selectedId}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 transition hover:text-down disabled:opacity-30 disabled:hover:text-slate-400"
              ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg></button>
              <button type="button" title={t('charts.draw.clear')} aria-label={t('charts.draw.clear')}
                onClick={() => { drawLayerRef.current?.clearAll(); bumpDraw() }} disabled={(drawLayerRef.current?.drawCount ?? 0) === 0}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 transition hover:text-down disabled:opacity-30 disabled:hover:text-slate-400"
              ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 5L5 19M5 5l14 14" /></svg></button>
              <span className="mx-0.5 h-5 w-px bg-white/10" />
              <button type="button" title={t('charts.draw.stayInDraw')} aria-label={t('charts.draw.stayInDraw')} onClick={() => { drawLayerRef.current?.setStayInDraw(!drawLayerRef.current?.stayInDraw); bumpDraw() }}
                className={`flex h-6 w-6 items-center justify-center rounded-md border transition ${drawLayerRef.current?.stayInDraw ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'}`}
              ><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3l4 4-4 4" /><path d="M3 17l4 4-4 4" /><line x1="21" y1="7" x2="7" y2="21" /><line x1="7" y1="3" x2="21" y2="17" /></svg></button>
            </div>
          </div>
        )}
      </div>
      </div>
      {/* /term-chartview */}

      {/* 底部持仓 / 挂单（桌面终端常驻；全屏时隐藏）。固定高度，不抢图表的
          flex 空间。手机端由下方"持仓"视图承载。
          Positions/orders dock (desktop terminal; hidden in fullscreen). Fixed
          height so it doesn't steal the chart's flex space. On mobile the
          "positions" view below carries this instead. */}
      {!isFullscreen && (
        <div className="hidden lg:flex lg:h-[196px] lg:flex-shrink-0 lg:flex-col">
          <PositionsDock
            className="flex-1"
            positions={positions}
            orders={orders}
            digitsFor={digitsFor}
            onToast={showToast}
          />
        </div>
      )}

      {/* 手机端·自选视图：点某品种即切换主图并跳回图表视图 / mobile watchlist
          view: tapping a symbol switches the chart and jumps back to it */}
      {!isFullscreen && (
        <div className={`term-mview lg:hidden ${mobileView === 'watchlist' ? 'flex flex-col' : 'hidden'}`}>
          <WatchlistPanel
            className="flex-1"
            symbols={activeSymbols}
            quotes={globalQuotes}
            active={symbol}
            onSelect={(s) => { setSymbol(s); setMobileView('chart') }}
            digitsFor={digitsFor}
          />
        </div>
      )}

      {/* 手机端·交易视图：完整停靠下单面板 / mobile trade view: full docked ticket */}
      {!isFullscreen && (
        <div className={`term-mview lg:hidden ${mobileView === 'trade' ? 'flex flex-col' : 'hidden'}`}>
          <OrderTicket
            className="flex-1"
            symbol={symbol}
            accounts={accounts}
            quotesByAccount={accountQuotes}
            globalQuote={activeQuote}
            refPrice={lastPrice}
            digits={decimals}
            onPlace={(side, volume, mt5Login, stopLoss, takeProfit, coid) =>
              placeManualOrder(symbol, side, volume, mt5Login, stopLoss, takeProfit, coid)
            }
          />
        </div>
      )}

      {/* 手机端·持仓视图：持仓/挂单 + 账户摘要 / mobile positions view */}
      {!isFullscreen && (
        <div className={`term-mview lg:hidden ${mobileView === 'positions' ? 'flex flex-col gap-2.5' : 'hidden'}`}>
          <PositionsDock
            className="flex-1"
            positions={positions}
            orders={orders}
            digitsFor={digitsFor}
            onToast={showToast}
          />
          <AccountSummary account={primaryAccount} />
        </div>
      )}

      {/* 免责声明：仅手机端图表视图显示 / disclaimer: mobile chart view only */}
      {!isFullscreen && mobileView === 'chart' && (
        <p className="mt-2 text-center text-[11px] text-slate-500 lg:hidden">
          {t('charts.footer')}
        </p>
      )}
      </div>
      {/* /term-center */}

      {/* 右栏：停靠式下单面板 + 账户摘要（桌面常驻；窄屏隐藏，手机端在阶段 3
          单独做）。下单面板占据剩余高度并可内部滚动，账户摘要固定在底部。
          Right column: docked order ticket + account summary (desktop only).
          The ticket takes the remaining height and scrolls internally; the
          account summary stays pinned at the bottom. */}
      <div className="term-col-right term-right hidden min-h-0 flex-col lg:flex">
        <OrderTicket
          className="min-h-0 flex-1"
          symbol={symbol}
          accounts={accounts}
          quotesByAccount={accountQuotes}
          globalQuote={activeQuote}
          refPrice={lastPrice}
          digits={decimals}
          onPlace={(side, volume, mt5Login, stopLoss, takeProfit, coid) =>
            placeManualOrder(symbol, side, volume, mt5Login, stopLoss, takeProfit, coid)
          }
        />
        <AccountSummary account={primaryAccount} />
      </div>

      {settingsOpen && (
        <IndicatorSettingsModal
          indicators={indicators}
          onToggle={toggleIndicator}
          settings={indicatorSettings}
          onChange={setIndicatorSettingsState}
          onReset={resetIndicatorSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {orderSide && (
        <ChartOrderModal
          symbol={symbol}
          side={orderSide}
          accounts={accounts}
          quotesByAccount={accountQuotes}
          refPrice={lastPrice}
          digits={decimals}
          onCancel={() => setOrderSide(null)}
          onConfirm={handleOrderConfirm}
        />
      )}

      {toast && (
        <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastToneClass(toast.kind)}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
