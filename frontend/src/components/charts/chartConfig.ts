// 图表页的常量、类型与纯函数：价格精度表、周期表、轮询/分页参数、指标开关
// 类型、图例类型、K 线 → lightweight-charts 点位换算、行情头日内统计。
// 2026-09-06 从 pages/ChartsPage.tsx 搬出（那文件 2222 行，拆成
// chartConfig / useChartEngine / useChartData / 若干小组件），内容逐行原样。
// Constants, types and pure helpers for the charts page, moved out of
// pages/ChartsPage.tsx on 2026-09-06 verbatim.
import type { UTCTimestamp } from 'lightweight-charts'
import type { Candle } from '../../api/types'
import type { Tool } from './DrawLayer'
import type { DayStats } from './SymbolHeader'

// 图表价格轴的小数位数：贵金属/原油 2~3 位，外汇对按经纪商常见的 5 位报价
// （日元对 3 位），加密货币 2 位。未在表中的品种回退到 2 位。
// Decimal precision for the price scale: metals/oil use 2~3 digits, FX pairs
// use the broker-standard 5-digit quoting (JPY pairs use 3), crypto uses 2.
// Unlisted symbols fall back to 2 digits.
export const SYMBOL_DECIMALS: Record<string, number> = {
  XAUUSD: 2,
  XAGUSD: 3,
  WTI: 2,
  EURUSD: 5,
  GBPUSD: 5,
  USDJPY: 3,
  BTCUSD: 2,
}
export const INTERVALS: { code: string; label: string }[] = [
  { code: '1', label: '1m' },
  { code: '5', label: '5m' },
  { code: '15', label: '15m' },
  { code: '60', label: '1H' },
  { code: '240', label: '4H' },
  { code: 'D', label: '1D' },
]

export const ToolList: Tool[] = ['cursor', 'cross', 'trend', 'hline', 'vline', 'ray', 'crossline', 'rect', 'fib']

// 向后兼容的 localStorage key / backward-compat localStorage keys
export const INTERVAL_KEY = 'prismx.charts.interval'
export const SYMBOL_KEY = 'prismx.charts.symbol'

// 最新价轮询间隔（毫秒）/ latest-price poll interval (ms)
export const POLL_MS = 2000
// 超过这么久没收到喂价更新，视为数据延迟 / no feed update for this long => stale
export const STALE_MS = 30_000
// 客户端保留的最大 K 线根数。以前是 500（对齐后端内存缓存的硬上限），现在
// /chart/history 直接读数据库、可以用 before 游标一直往左翻，这个数决定的是
// "往左能拉多远"——超出就会把最早的裁掉、再往左拉又得重新请求。
// 取 20000：约等于两年的 1 小时线或半年的 15 分钟线，够深；同时每根 bar 在
// 内存里只是几个 number，两万根的量级对浏览器无压力，指标重算也仍在毫秒级。
// max bars kept client-side. This used to be 500 (matching the backend's
// in-memory cache cap); now that /chart/history reads the database and can page
// backwards via the `before` cursor, this number decides how far left the user
// can scroll before the earliest bars get trimmed and have to be re-fetched.
// 20000 ≈ two years of hourly or six months of 15-minute bars — deep enough,
// while each bar is just a few numbers in memory, so this size is no strain on
// the browser and indicator recomputation stays in the millisecond range.
export const MAX_CLIENT_BARS = 20000

// 每页请求多少根，以及还剩多少根就触发下一页。
// 触发阈值取 200：用户拖到距离最左边还有 200 根时就开始预取，等他拖到边缘时
// 数据通常已经到位，不会看到空白。
// Bars per page, and how many remaining bars trigger the next page.
// The 200-bar threshold prefetches while the user is still 200 bars away from
// the left edge, so data is usually in place by the time they reach it and no
// blank gap shows.
//
// 2026-08-06：首屏只取 300 根（够填满典型屏幕宽度，多数用户看不了那么远
// 就会切品种/周期），往左拖时每页取 500。之前是首屏 1000 + 翻页 1000，
// 但用户实际能看到的首屏可能只有 100 根左右，其余是预加载的流量浪费——
// Egress 单月 724 GB，猜测图表历史是主要贡献者之一。这两个数字的取舍：
// ① 首屏 50 刚好够填满屏幕（约 1 小时线两天、15 分钟线半天），不影响
// 体验又最大化节省流量（相比之前 300 降低 83%）；② 翻页 500 保证拖动
// 顺滑（预取触发点 200 + 页大小 500 = 拖到边缘时有 300 根缓冲，不会
// 穿帮）；③ 后端上限已改为 1000（chart.py），远超一页所需，纯属安全
// 上限。可视深度无影响——MAX_CLIENT_BARS 仍是 20000，只是不再预先
// 浪费流量拉那些可能永远不会被看的历史。
// Was 1000 for both; now 50 first page + 500 per scroll-triggered page.
// Most users see ~100 bars on first load; the rest was wasted egress
// (724 GB/mo; chart history suspected as a major source). Trade-offs:
// ① 50 bars just fills the screen (≈ 2 days hourly / half-day 15m) —
// smooth UX with 83% less first-page egress vs. old 300; ② 500 per
// page still smooth (200 prefetch + 500 page = 300-bar buffer at edge,
// no blank gaps); ③ backend cap now 1000 (chart.py), comfortably above
// one page. Viewable depth (MAX_CLIENT_BARS=20k) unchanged — just no
// longer pre-wastes egress on bars that might never be scrolled to.
export const HISTORY_FIRST_PAGE = 50
export const HISTORY_PAGE_SIZE = 500
export const HISTORY_PREFETCH_BARS = 200

// 涨跌配色（与 SignalView 的 FOCUS_DOT 一致，K 线本身固定用这套，不做客制化）
// up/down colors (match SignalView's FOCUS_DOT; the candles themselves stay
// fixed to this palette — only the sub-indicators are user-customizable)
export const UP_COLOR = '#2ee07e'
export const DOWN_COLOR = '#ff4d67'

// ---------- 指标开关 / indicator toggles ----------
export interface IndicatorFlags {
  ma: boolean
  ema: boolean
  boll: boolean
  volume: boolean
  rsi: boolean
  macd: boolean
}
export const DEFAULT_INDICATORS: IndicatorFlags = {
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
export interface LegendValues {
  ma: (number | null)[]
  ema: (number | null)[]
  boll: { mid: number | null; upper: number | null; lower: number | null }
  volume: number | null
  rsi: number | null
  macd: { macd: number | null; signal: number | null; hist: number | null }
}
export const EMPTY_LEGEND: LegendValues = {
  ma: [],
  ema: [],
  boll: { mid: null, upper: null, lower: null },
  volume: null,
  rsi: null,
  macd: { macd: null, signal: null, hist: null },
}

export function toLwPoint(b: Candle) {
  return { time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }
}

// toLinePoints / fmtChartTime 与回测面板共用：utils/chartSeries.ts。
// toLinePoints / fmtChartTime are shared with the backtest panel: utils/chartSeries.ts.

// MACD 柱状图：同上但带正负配色 / MACD histogram: same, but colored by sign
export function toHistPoints(
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
export function fmtLegendNum(v: number | null | undefined, digits: number): string {
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
export function computeDayStats(bars: { t: number; o: number; h: number; l: number; c: number }[]): DayStats | null {
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

// 时间轴刻度（timeScale.tickMarkFormatter）与十字准线悬停（localization.timeFormatter）
// 必须用同一个格式化函数，否则悬停显示浏览器本地时区、轴上是 UTC+8——那正是当年
// "图表时间还是不对"的根因。函数本体在 utils/chartSeries.ts。
// Axis ticks and crosshair hover must share one formatter or they disagree on
// timezone (the original "chart time is still wrong" bug). See utils/chartSeries.ts.
