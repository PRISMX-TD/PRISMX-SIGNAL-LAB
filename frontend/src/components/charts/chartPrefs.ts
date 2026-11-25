// 图表偏好 v2：图表类型、主题、时区、坐标轴、图例、画布、价格线、K 线变换参数、模板。
// 全部放在新的云端命名空间 chartv2 / prefs 一个键里，charts.* 旧字段原样保留——旧 App
// 包只认识 charts.*，读到的值不变（踩坑 #220：旧包拿到新周期代码发给后端得 400）。
// 每次读回都过 normalizeChartPrefs：坏值、缺字段一律回落默认，不把脏数据交给图表库。
// Chart prefs v2: chart type, theme, timezone, scales, legend, canvas, price lines, bar
// transform parameters and templates, stored under one key in the new cloud namespace
// chartv2 / prefs. The old charts.* fields stay untouched so old App bundles, which only
// know charts.*, keep reading the same values (pitfall #220). Every read goes through
// normalizeChartPrefs: bad or missing fields fall back to defaults.
import type { ChartThemePref } from './chartTheme'

export type ChartType =
  | 'bars' | 'candles' | 'hollow' | 'volumeCandles'
  | 'line' | 'lineMarkers' | 'step'
  | 'area' | 'hlcArea' | 'baseline'
  | 'columns' | 'highLow'
  | 'heikinAshi' | 'renko' | 'lineBreak' | 'kagi' | 'pnf'

// 图表类型菜单的分组，与 TradingView 的分组顺序一致。
// Chart-type menu groups, in TradingView's order.
export const CHART_TYPE_GROUPS: ChartType[][] = [
  ['bars', 'candles', 'hollow', 'volumeCandles'],
  ['line', 'lineMarkers', 'step'],
  ['area', 'hlcArea', 'baseline'],
  ['columns', 'highLow'],
  ['heikinAshi', 'renko', 'lineBreak', 'kagi', 'pnf'],
]
const ALL_TYPES = new Set<string>(CHART_TYPE_GROUPS.flat())

// 价格类图表（砖形等）不以时间为横轴：派生周期、按时间画的线和指标都只是近似。
// Price-based types aren't time-based on the x axis.
export const PRICE_BASED_TYPES: ReadonlySet<ChartType> = new Set(['renko', 'lineBreak', 'kagi', 'pnf'])

export type ScaleMode = 0 | 1 | 2 | 3 // 普通 / 对数 / 百分比 / 指数化到 100
export type GridMode = 'both' | 'vert' | 'horz' | 'none'
export type CrosshairMode = 'normal' | 'magnet' | 'hidden'
export type LineDash = 'solid' | 'dashed' | 'dotted'

export interface ChartPrefs {
  v: 1
  chartType: ChartType
  // 新周期代码（2m、45m、2H、1W…）存这里；charts.interval 只写旧包也认识的代码。
  // New interval codes live here; charts.interval only ever gets codes old bundles know.
  interval: string | null
  favIntervals: string[]
  theme: ChartThemePref
  // IANA 时区名，或 'UTC' / 'local'（浏览器本地）/ 'broker'（券商服务器时间）
  // IANA zone, or 'UTC' / 'local' (browser) / 'broker' (broker server time)
  timezone: string
  scaleMode: ScaleMode
  invertScale: boolean
  candle: { body: boolean; borders: boolean; wick: boolean }
  lineWidth: number
  lineColor: string
  legend: { title: boolean; ohlc: boolean; change: boolean; volume: boolean; indicators: boolean }
  lines: {
    lastPrice: boolean
    bidAsk: boolean
    highLow: boolean
    prevClose: boolean
    indicatorLabels: boolean
    sessionBreaks: boolean
  }
  canvas: {
    bg: string | null
    grid: GridMode
    crosshair: CrosshairMode
    crossStyle: LineDash
    watermark: boolean
    rightOffset: number
  }
  transform: {
    // 0 = 自动（ATR 14）/ 0 = auto (ATR 14)
    renkoBox: number
    renkoWicks: boolean
    lineBreak: number
    kagiReversal: number
    pnfBox: number
    pnfReversal: number
    pnfSource: 'close' | 'hl'
  }
  templates: { name: string; prefs: Partial<ChartPrefs> }[]
}

export const DEFAULT_FAV_INTERVALS = ['1', '5', '15', '30', '60', '240', 'D', 'M']

export const DEFAULT_CHART_PREFS: ChartPrefs = {
  v: 1,
  chartType: 'candles',
  interval: null,
  favIntervals: DEFAULT_FAV_INTERVALS,
  theme: 'dark',
  timezone: 'Asia/Shanghai',
  scaleMode: 0,
  invertScale: false,
  candle: { body: true, borders: false, wick: true },
  lineWidth: 2,
  lineColor: '#2962FF',
  legend: { title: true, ohlc: true, change: true, volume: false, indicators: true },
  lines: { lastPrice: true, bidAsk: false, highLow: false, prevClose: false, indicatorLabels: false, sessionBreaks: false },
  canvas: { bg: null, grid: 'both', crosshair: 'normal', crossStyle: 'dashed', watermark: false, rightOffset: 8 },
  transform: { renkoBox: 0, renkoWicks: false, lineBreak: 3, kagiReversal: 0, pnfBox: 0, pnfReversal: 3, pnfSource: 'close' },
  templates: [],
}

const HEX = /^#[0-9a-fA-F]{6}$/
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const num = (v: unknown, d: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

// 时区名校验：Intl 认识就收。/ A zone is valid when Intl accepts it.
export function isValidTimezone(tz: string): boolean {
  if (tz === 'UTC' || tz === 'local' || tz === 'broker') return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function normalizeChartPrefs(raw: unknown, isInterval: (c: string) => boolean = () => true): ChartPrefs {
  const r = obj(raw)
  const d = DEFAULT_CHART_PREFS
  const c = obj(r.candle)
  const lg = obj(r.legend)
  const ln = obj(r.lines)
  const cv = obj(r.canvas)
  const tf = obj(r.transform)
  const favs = Array.isArray(r.favIntervals) ? r.favIntervals.filter((x): x is string => typeof x === 'string' && isInterval(x)).slice(0, 24) : d.favIntervals
  const tz = typeof r.timezone === 'string' && isValidTimezone(r.timezone) ? r.timezone : d.timezone
  const templates = Array.isArray(r.templates)
    ? r.templates
        .filter((x): x is { name: string; prefs: Partial<ChartPrefs> } => !!x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string')
        .slice(0, 20)
        .map((x) => ({ name: x.name.slice(0, 40), prefs: obj(x.prefs) as Partial<ChartPrefs> }))
    : []
  return {
    v: 1,
    chartType: typeof r.chartType === 'string' && ALL_TYPES.has(r.chartType) ? (r.chartType as ChartType) : d.chartType,
    interval: typeof r.interval === 'string' && isInterval(r.interval) ? r.interval : null,
    favIntervals: favs.length > 0 ? favs : d.favIntervals,
    theme: pick(r.theme, ['dark', 'light', 'system'] as const, d.theme),
    timezone: tz,
    scaleMode: num(r.scaleMode, 0, 0, 3) as ScaleMode,
    invertScale: bool(r.invertScale, false),
    candle: { body: bool(c.body, true), borders: bool(c.borders, false), wick: bool(c.wick, true) },
    lineWidth: num(r.lineWidth, d.lineWidth, 1, 4),
    lineColor: typeof r.lineColor === 'string' && HEX.test(r.lineColor) ? r.lineColor : d.lineColor,
    legend: {
      title: bool(lg.title, d.legend.title),
      ohlc: bool(lg.ohlc, d.legend.ohlc),
      change: bool(lg.change, d.legend.change),
      volume: bool(lg.volume, d.legend.volume),
      indicators: bool(lg.indicators, d.legend.indicators),
    },
    lines: {
      lastPrice: bool(ln.lastPrice, d.lines.lastPrice),
      bidAsk: bool(ln.bidAsk, d.lines.bidAsk),
      highLow: bool(ln.highLow, d.lines.highLow),
      prevClose: bool(ln.prevClose, d.lines.prevClose),
      indicatorLabels: bool(ln.indicatorLabels, d.lines.indicatorLabels),
      sessionBreaks: bool(ln.sessionBreaks, d.lines.sessionBreaks),
    },
    canvas: {
      bg: typeof cv.bg === 'string' && HEX.test(cv.bg) ? cv.bg : null,
      grid: pick(cv.grid, ['both', 'vert', 'horz', 'none'] as const, d.canvas.grid),
      crosshair: pick(cv.crosshair, ['normal', 'magnet', 'hidden'] as const, d.canvas.crosshair),
      crossStyle: pick(cv.crossStyle, ['solid', 'dashed', 'dotted'] as const, d.canvas.crossStyle),
      watermark: bool(cv.watermark, d.canvas.watermark),
      rightOffset: num(cv.rightOffset, d.canvas.rightOffset, 0, 80),
    },
    transform: {
      renkoBox: num(tf.renkoBox, 0, 0, 1e9),
      renkoWicks: bool(tf.renkoWicks, false),
      lineBreak: num(tf.lineBreak, 3, 1, 10),
      kagiReversal: num(tf.kagiReversal, 0, 0, 1e9),
      pnfBox: num(tf.pnfBox, 0, 0, 1e9),
      pnfReversal: num(tf.pnfReversal, 3, 1, 10),
      pnfSource: pick(tf.pnfSource, ['close', 'hl'] as const, 'close'),
    },
    templates,
  }
}

// 模板只存「外观」部分：不带周期、收藏、时区和模板列表本身。
// Templates hold the look only: no interval, favourites, timezone or the template list itself.
export function templateOf(p: ChartPrefs): Partial<ChartPrefs> {
  const { chartType, theme, scaleMode, invertScale, candle, lineWidth, lineColor, legend, lines, canvas, transform } = p
  return { chartType, theme, scaleMode, invertScale, candle, lineWidth, lineColor, legend, lines, canvas, transform }
}
