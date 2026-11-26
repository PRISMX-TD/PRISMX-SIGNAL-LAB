// 指标系统 v2（阶段 4）的类型：指标定义（注册表里每种一份）与指标实例（用户加到图上的每一个）。
// 同一种指标可以加多次，每个实例有自己的输入、样式、所在窗格、价格轴、时间周期与可见性。
// Indicator system v2 (phase 4) types: definitions (one per kind, in the registry) and
// instances (each one the user adds to the chart). A kind can be added many times; every
// instance has its own inputs, styles, pane, price scale, timeframe and visibility.
import type { Candle } from '../../../api/types'
import type { MaType } from './math'
import type { Profile, Tpo } from './math3'

export type IndGroup = 'ma' | 'trend' | 'momentum' | 'volatility' | 'volume' | 'levels' | 'patterns' | 'stats' | 'custom'

export type SourceKind = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4' | 'hlcc4'
export const SOURCE_KINDS: SourceKind[] = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']
export type InputValue = number | string | boolean
export type Inputs = Record<string, InputValue>

// 输入项。标签统一用 charts.ind.in.<key>（同名输入共用一条文案）。
// An input. Labels come from charts.ind.in.<key> (same-named inputs share one string).
export type InputDef =
  | { key: string; kind: 'int'; def: number; min: number; max: number }
  | { key: string; kind: 'float'; def: number; min: number; max: number; step?: number }
  // 数据源：开高低收等，或「另一个指标」：'ind:<uid>:<plot>' / a price source or another indicator's plot
  | { key: string; kind: 'source'; def: SourceKind }
  | { key: string; kind: 'ma'; def: MaType; options?: MaType[] }
  | { key: string; kind: 'bool'; def: boolean }
  // 选项文案 charts.ind.opt.<option> / option labels charts.ind.opt.<option>
  | { key: string; kind: 'select'; def: string; options: string[] }
  // 另一个品种（相关系数、价差）/ another symbol (correlation, spread)
  | { key: string; kind: 'symbol'; def: string }

export type PlotKind = 'line' | 'step' | 'hist' | 'columns' | 'area' | 'points' | 'cross'
export type LineDash = 'solid' | 'dashed' | 'dotted'

// 颜色写法：'#rrggbb'，或 'up' / 'down' 跟随 K 线涨跌色 / '#rrggbb', or 'up' / 'down' for the candle colours
export interface PlotDef {
  key: string
  kind: PlotKind
  color: string
  // 多色线 / 柱：计算结果里 `${key}#c` 给每个点的颜色下标 / multi-colour: `${key}#c` holds a colour index per point
  colors?: string[]
  width?: number
  dash?: LineDash
  // 样式页里的名字 charts.ind.plot.<label> / name in the style tab
  label: string
  // 只画、不进图例 / drawn but not listed in the legend
  noLegend?: boolean
  // 在中间的空值处断开（枢轴点、分段线）/ break at interior nulls
  gaps?: boolean
  // 只当图形的线样式用（不建序列）：图形颜色写 'p:<key>'，线宽、线型也跟这条的样式
  // Style-only plot for shapes (no series): shapes write 'p:<key>' and take its width and dash too
  shape?: boolean
}

export interface HlineDef {
  key: string
  value: number
  color: string
  dash?: LineDash
  label: string
}

// 两条线之间填色；a / b 是 plot key，或 'h:<key>' 表示水平线。colorB 给 a < b 的段（云图）。
// A fill between two plots; a / b are plot keys or 'h:<key>' for hlines. colorB colours a < b (clouds).
export interface FillDef {
  key: string
  a: string
  b: string
  color: string
  colorB?: string
  opacity: number
  label: string
}

export interface IndCtx {
  bars: Candle[]
  // 当前图表周期代码 / the chart's interval code
  interval: string
  // 品种小数位 / symbol digits
  digits: number
  // 当前品种 / the chart's symbol
  symbol?: string
  // 别的品种 / 周期的 K 线（异步取，没到时 null，到了会触发重算）
  // Bars of another symbol / interval (fetched async; null until they arrive, which triggers a recompute)
  other?: (symbol: string, interval: string) => Candle[] | null
  // 本品种的小周期 K 线 [t0, 最新]（周期代码、起点、去抖键；没到时 null，到了会触发重算）
  // This symbol's lower-timeframe bars from t0 to the newest (code, start, debounce key; null until
  // they arrive, which triggers a recompute)
  intrabar?: (code: string, t0: number, key: string) => Candle[] | null
}

// 计算结果：每条 plot 一列数组；另有可选的特殊输出（标记、区域、竖条、背景色）。
// Compute output: one array per plot, plus optional extras (markers, zones, strips, backgrounds).
export type IndOutput = Record<string, (number | null)[]>

// compute 的返回：plot 数组，外加可选的 __x（特殊输出）/ compute's return: plot arrays plus an optional __x
export type CompOut = Record<string, (number | null)[] | IndExtras>
export type IndMarker = NonNullable<IndExtras['markers']>[number]

export interface IndExtras {
  markers?: { i: number; shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square'; position: 'aboveBar' | 'belowBar' | 'atPriceMiddle'; price?: number; color: string; text?: string }[]
  zones?: { i: number; top: number; bottom: number; color: string }[]
  strips?: { i: number; top: number; bottom: number; color: string }[]
  // 整列背景色（交易时段）/ full-height column backgrounds (sessions)
  bg?: (string | null)[]
  // ── 第三批的图形（由 ind/shapePrimitive 画）。颜色可写 '#hex'、'up' / 'down'，或 'f:<填充 key>'（跟样式页
  // 的填充色与透明度，填充关掉就不画）；文字以 'mk.' 开头的按 charts.ind.mk.* 翻译。K 线下标 i；i2 = -1 表示画到右边缘。
  // ── Batch 3 shapes (drawn by ind/shapePrimitive). Colours: '#hex', 'up' / 'down', or 'f:<fill key>'
  // (the style tab's fill colour and opacity; hidden fill = not drawn); texts starting 'mk.' are
  // translated from charts.ind.mk.*. Bar index i; i2 = -1 means to the right edge.
  // ctr = 左右边在 K 线中心（不是整根的外沿）/ ctr = edges at bar centres rather than the bars' outer edges
  rects?: { i1: number; i2: number; top: number; bottom: number; fill?: string; stroke?: string; dash?: LineDash; back?: boolean; ctr?: boolean }[]
  segs?: { i1: number; p1: number; i2: number; p2: number; color: string; width?: number; dash?: LineDash }[]
  // size = 字号 px；文字可用 \n 换行；cd = 倒计时的结束时间（秒），画的时候每秒现算一行 'HH:MM:SS'
  // size = font px; texts may contain \n; cd = a countdown's end time (s), drawn live as an extra 'HH:MM:SS' line
  labels?: { i: number; p: number; text: string; color: string; bg?: string; align?: 'left' | 'right' | 'center'; pos?: 'above' | 'below' | 'middle'; size?: number; cd?: number }[]
  // 成交量分布：anchor 'left' 从区间左边往右长，'right' 从区间右边往左长；width = 占区间宽度的比例。
  // 可选：mode（上涨/下跌、总量、差值）、VAH / VAL 虚线、POC / VAH / VAL 向右延伸、区间底色。
  // Volume profiles: anchor 'left' grows right from the range start, 'right' grows left from its end; width = share of the range.
  // Optional: mode (up/down, total, delta), dotted VAH / VAL lines, POC / VAH / VAL extended right, a range background.
  profiles?: {
    p: Profile; anchor: 'left' | 'right'; width: number; up: string; dn: string; vaUp: string; vaDn: string; poc: string
    mode?: 'updown' | 'total' | 'delta'; hist?: boolean; vah?: string; val?: string; box?: string
    ext?: { poc?: boolean; vah?: boolean; val?: boolean }
    // 三条线的粗细与线型（颜色写 'p:<key>' 时由引擎从线样式填入）/ the lines' width and dash (filled from the plot style for 'p:<key>' colours)
    lines?: Partial<Record<'poc' | 'vah' | 'val', { width: number; dash: LineDash }>>
  }[]
  // 可见范围成交量分布：画的时候按当前可见的 K 线现算，贴在窗格右边 / visible-range profile, computed at draw time, docked right
  vpVisible?: { rows: number; vaPct: number; width: number; up: string; dn: string; vaUp: string; vaDn: string; poc: string }
  tpos?: { t: Tpo; color: string; vaColor: string; poc: string; ib: string | null; letters: boolean }[]
  table?: { pos: 'tl' | 'tr' | 'bl' | 'br'; rows: { k: string; v: string; color?: string }[] }
  gauge?: { value: number | null; text: string; color: string }
}

export interface IndDef {
  id: string
  abbr: string
  group: IndGroup
  // true = 默认叠在主图；false = 默认独立窗格 / true = main pane by default; false = own pane
  overlay: boolean
  inputs: InputDef[]
  plots: PlotDef[]
  hlines?: HlineDef[]
  fills?: FillDef[]
  // 'price' = 跟品种小数位；'volume' = 成交量格式；数字 = 固定位数 / precision
  digits?: 'price' | 'volume' | number
  pro?: boolean
  // 不支持多周期（依赖逐根时间：交易时段、锚定 VWAP 等）/ no multi-timeframe support
  noTf?: boolean
  // 有这个输入就把全部 plot 按它平移（正数往右）/ shift every plot by this input (positive = right)
  offsetInput?: string
  // 个别 plot 的固定平移（一目均衡）/ fixed per-plot shifts (Ichimoku)
  plotOffsets?: (inp: Inputs) => Record<string, number>
  // 图例标题里显示哪些输入 / which inputs the legend title shows
  title?: (inp: Inputs) => string
  compute: (ctx: IndCtx, inp: Inputs, src: (key: string) => (number | null)[]) => CompOut
}

// ── 实例 / instances ──
export interface PlotStyle {
  visible?: boolean
  color?: string
  colors?: string[]
  // 0–100
  opacity?: number
  width?: number
  dash?: LineDash
  kind?: PlotKind
  // 水平线的值 / hline value
  value?: number
}

export type VisKind = 'min' | 'hour' | 'day' | 'week' | 'month'
export const VIS_KINDS: VisKind[] = ['min', 'hour', 'day', 'week', 'month']
export const VIS_RANGE: Record<VisKind, [number, number]> = { min: [1, 59], hour: [1, 24], day: [1, 366], week: [1, 52], month: [1, 12] }
export type VisRule = Partial<Record<VisKind, { on: boolean; from: number; to: number }>>

export type ScalePin = 'right' | 'left' | 'none'

export interface IndInstance {
  uid: string
  type: string
  inputs: Inputs
  // 覆盖项：plot key、'h:<key>'（水平线）、'f:<key>'（填充）/ overrides by plot key, 'h:<key>', 'f:<key>'
  styles: Record<string, PlotStyle>
  hidden?: boolean
  // 'main' 或窗格 id / 'main' or a pane id
  pane: string
  scale?: ScalePin
  // null / 缺省 = 自动 / null or absent = auto
  precision?: number | null
  // 价格轴数值标签；缺省跟全局设置 / price-axis label; absent = follow the global setting
  labels?: boolean | null
  // 时间周期；缺省 = 跟图表 / timeframe; absent = the chart's
  tf?: string | null
  tfWait?: boolean
  vis?: VisRule
}

export interface IndPane {
  id: string
  // 高度权重（主图另存 mainH）/ height weight (the main pane's is mainH)
  h: number
  collapsed?: boolean
}

export type IndTemplate = { name: string; list: Omit<IndInstance, 'uid'>[]; panes: IndPane[] }

export interface IndLayout {
  v: 1
  list: IndInstance[]
  panes: IndPane[]
  mainH: number
  favs: string[]
  recent: string[]
  tpls: IndTemplate[]
  // 「存为默认」/ "save as default"
  defaults: Record<string, { inputs?: Inputs; styles?: Record<string, PlotStyle> }>
}

export const MAX_INSTANCES = 40
