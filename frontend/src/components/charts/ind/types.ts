// 指标系统 v2（阶段 4）的类型：指标定义（注册表里每种一份）与指标实例（用户加到图上的每一个）。
// 同一种指标可以加多次，每个实例有自己的输入、样式、所在窗格、价格轴、时间周期与可见性。
// Indicator system v2 (phase 4) types: definitions (one per kind, in the registry) and
// instances (each one the user adds to the chart). A kind can be added many times; every
// instance has its own inputs, styles, pane, price scale, timeframe and visibility.
import type { Candle } from '../../../api/types'
import type { MaType } from './math'

export type IndGroup = 'ma' | 'trend' | 'momentum' | 'volatility' | 'volume' | 'levels' | 'custom'

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
