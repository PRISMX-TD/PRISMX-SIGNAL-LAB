// 指标目录：14 个指标各自的元数据（分组 / 主图还是副图 / 缩写）、参数表单描述、
// 图上要画哪几条 series、怎么算、图例怎么读、参考线画在哪。引擎（useChartEngine）、
// 图例（IndicatorLegends）、面板（IndicatorSettingsModal，含实时预览）三处都只
// 认这一份描述，加一个指标只改这个文件 + indicators.ts 的数学 + i18n 文案。
// The indicator catalog: for each of the 14 indicators, its metadata (group,
// main vs sub pane, abbreviation), parameter schema, which series to draw, how
// to compute them, how the legend reads them, and where reference lines go.
// The engine, the legends and the panel (including its live preview) all
// consume this single description; adding an indicator touches this file, the
// math in utils/indicators.ts and the i18n strings, nothing else.
import type { Candle } from '../../api/types'
import {
  atr, bollinger, cci, closes, donchianHigh, donchianLow, ema, kdj, macd, obv, parabolicSar, rsi, sma, superTrend, vwap, williamsR,
} from '../../utils/indicators'
import type { IndicatorSettings, LineStyleCfg, PaneSize } from './indicatorSettings'

export type IndicatorId = keyof IndicatorSettings
export type IndicatorGroup = 'trend' | 'momentum' | 'volatility' | 'volume'

// 目录顺序 = 面板里的展示顺序；副图的创建顺序也按这里（上到下）。
// Catalog order = display order in the panel; sub-panes are created in this order too.
export const INDICATOR_IDS: IndicatorId[] = ['ma', 'ema', 'boll', 'donch', 'vwap', 'st', 'sar', 'rsi', 'macd', 'kdj', 'cci', 'wr', 'atr', 'volume', 'obv']
export const GROUPS: IndicatorGroup[] = ['trend', 'momentum', 'volatility', 'volume']

export interface IndicatorMeta {
  abbr: string
  group: IndicatorGroup
  pane: 'main' | 'sub'
}
export const INDICATOR_META: Record<IndicatorId, IndicatorMeta> = {
  ma: { abbr: 'MA', group: 'trend', pane: 'main' },
  ema: { abbr: 'EMA', group: 'trend', pane: 'main' },
  boll: { abbr: 'BOLL', group: 'trend', pane: 'main' },
  donch: { abbr: 'DC', group: 'trend', pane: 'main' },
  vwap: { abbr: 'VWAP', group: 'trend', pane: 'main' },
  st: { abbr: 'ST', group: 'trend', pane: 'main' },
  sar: { abbr: 'SAR', group: 'trend', pane: 'main' },
  rsi: { abbr: 'RSI', group: 'momentum', pane: 'sub' },
  macd: { abbr: 'MACD', group: 'momentum', pane: 'sub' },
  kdj: { abbr: 'KDJ', group: 'momentum', pane: 'sub' },
  cci: { abbr: 'CCI', group: 'momentum', pane: 'sub' },
  wr: { abbr: 'W%R', group: 'momentum', pane: 'sub' },
  atr: { abbr: 'ATR', group: 'volatility', pane: 'sub' },
  volume: { abbr: 'VOL', group: 'volume', pane: 'sub' },
  obv: { abbr: 'OBV', group: 'volume', pane: 'sub' },
}
export const MAIN_IDS = INDICATOR_IDS.filter((id) => INDICATOR_META[id].pane === 'main')
export const SUB_IDS = INDICATOR_IDS.filter((id) => INDICATOR_META[id].pane === 'sub')

// 组合模板：一键换一套开关。/ Templates: one tap swaps the whole set of toggles.
export const TEMPLATES: { id: string; ids: IndicatorId[] }[] = [
  { id: 'ma', ids: ['ma', 'volume'] },
  { id: 'trend', ids: ['ema', 'st', 'atr'] },
  { id: 'osc', ids: ['boll', 'rsi', 'kdj'] },
  { id: 'vol', ids: ['vwap', 'volume', 'obv'] },
]

// 副图高度档的权重 / sub-pane height weights
export const PANE_SIZE_WEIGHT: Record<PaneSize, number> = { sm: 1, md: 1.5, lg: 2.1 }

// ── 参数表单描述 / parameter schema for the panel ──
export type ParamField =
  | { kind: 'num'; key: string; label: string; min: number; max: number; isFloat?: boolean; step?: number }
  | { kind: 'color'; key: string; label: string }
  | { kind: 'lines' }
export interface IndicatorForm {
  params: ParamField[]
  // 有线的指标才有线宽线型；SAR 是点、VOL 是柱 / only line-drawing indicators get width/dash
  lineStyle: boolean
}
const P = (key: string, label: string, min: number, max: number, extra: Partial<Extract<ParamField, { kind: 'num' }>> = {}): ParamField =>
  ({ kind: 'num', key, label, min, max, ...extra })
const C = (key: string, label: string): ParamField => ({ kind: 'color', key, label })
export const INDICATOR_FORM: Record<IndicatorId, IndicatorForm> = {
  ma: { params: [{ kind: 'lines' }], lineStyle: true },
  ema: { params: [{ kind: 'lines' }], lineStyle: true },
  boll: { params: [P('period', 'period', 2, 500), P('mult', 'multiplier', 0.5, 5, { isFloat: true }), C('color', 'color')], lineStyle: true },
  donch: { params: [P('period', 'period', 2, 500), C('color', 'color')], lineStyle: true },
  vwap: { params: [C('color', 'color')], lineStyle: true },
  st: { params: [P('period', 'period', 2, 200), P('mult', 'multiplier', 0.5, 10, { isFloat: true }), C('upColor', 'upColor'), C('downColor', 'downColor')], lineStyle: true },
  sar: { params: [P('step', 'step', 0.001, 0.2, { isFloat: true }), P('max', 'maxStep', 0.05, 1, { isFloat: true }), C('color', 'color')], lineStyle: false },
  rsi: { params: [P('period', 'period', 2, 200), P('overbought', 'overbought', 50, 99), P('oversold', 'oversold', 1, 50), C('color', 'color')], lineStyle: true },
  macd: { params: [P('fast', 'fast', 2, 200), P('slow', 'slow', 2, 400), P('signal', 'signal', 1, 100), C('macdColor', 'macdLine'), C('signalColor', 'signal')], lineStyle: true },
  kdj: { params: [P('period', 'period', 2, 200), P('kSmooth', 'kSmooth', 1, 20), P('dSmooth', 'dSmooth', 1, 20), C('kColor', 'kLine'), C('dColor', 'dLine'), C('jColor', 'jLine')], lineStyle: true },
  cci: { params: [P('period', 'period', 2, 200), C('color', 'color')], lineStyle: true },
  wr: { params: [P('period', 'period', 2, 200), C('color', 'color')], lineStyle: true },
  atr: { params: [P('period', 'period', 2, 200), C('color', 'color')], lineStyle: true },
  volume: { params: [C('upColor', 'upColor'), C('downColor', 'downColor')], lineStyle: false },
  obv: { params: [C('color', 'color')], lineStyle: true },
}

// ── 图上的 series 描述 / series drawn on the chart ──
export interface SeriesSpec {
  key: string
  kind: 'line' | 'hist' | 'points'
  color: string
  // 覆盖指标级的线型（布林带上下轨永远虚线）/ overrides the indicator-level dash
  dashed?: boolean
  // 柱的着色：按符号（MACD 柱）或按 K 线涨跌（成交量）/ histogram coloring rule
  histColor?: 'sign' | 'candle'
  // 图例里的短标签；空字符串表示只显示指标缩写 / short legend label ('' = abbreviation only)
  label: string
}
export interface RefLine {
  value: number
  label: string
}

function style(s: LineStyleCfg): Pick<LineStyleCfg, 'width' | 'dash'> {
  return { width: s.width, dash: s.dash }
}
export function lineStyleOf(id: IndicatorId, s: IndicatorSettings): Pick<LineStyleCfg, 'width' | 'dash'> {
  const cfg = s[id] as Partial<LineStyleCfg>
  return cfg.width ? style(cfg as LineStyleCfg) : { width: 1, dash: 'solid' }
}

export function seriesSpecs(id: IndicatorId, s: IndicatorSettings): SeriesSpec[] {
  switch (id) {
    case 'ma': return s.ma.periods.map((p, i) => ({ key: String(i), kind: 'line', color: s.ma.colors[i], label: String(p) }))
    case 'ema': return s.ema.periods.map((p, i) => ({ key: String(i), kind: 'line', color: s.ema.colors[i], label: String(p) }))
    case 'boll': return [
      { key: 'mid', kind: 'line', color: s.boll.color, label: 'M' },
      { key: 'upper', kind: 'line', color: s.boll.color, dashed: true, label: 'U' },
      { key: 'lower', kind: 'line', color: s.boll.color, dashed: true, label: 'L' },
    ]
    case 'donch': return [
      { key: 'upper', kind: 'line', color: s.donch.color, label: 'U' },
      { key: 'lower', kind: 'line', color: s.donch.color, label: 'L' },
    ]
    case 'vwap': return [{ key: 'v', kind: 'line', color: s.vwap.color, label: '' }]
    case 'st': return [
      { key: 'bull', kind: 'line', color: s.st.upColor, label: '' },
      { key: 'bear', kind: 'line', color: s.st.downColor, label: '' },
    ]
    case 'sar': return [{ key: 'v', kind: 'points', color: s.sar.color, label: '' }]
    case 'rsi': return [{ key: 'v', kind: 'line', color: s.rsi.color, label: String(s.rsi.period) }]
    case 'macd': return [
      { key: 'hist', kind: 'hist', color: '#000', histColor: 'sign', label: 'Hist' },
      { key: 'macd', kind: 'line', color: s.macd.macdColor, label: 'MACD' },
      { key: 'signal', kind: 'line', color: s.macd.signalColor, label: 'Sig' },
    ]
    case 'kdj': return [
      { key: 'k', kind: 'line', color: s.kdj.kColor, label: 'K' },
      { key: 'd', kind: 'line', color: s.kdj.dColor, label: 'D' },
      { key: 'j', kind: 'line', color: s.kdj.jColor, label: 'J' },
    ]
    case 'cci': return [{ key: 'v', kind: 'line', color: s.cci.color, label: String(s.cci.period) }]
    case 'wr': return [{ key: 'v', kind: 'line', color: s.wr.color, label: String(s.wr.period) }]
    case 'atr': return [{ key: 'v', kind: 'line', color: s.atr.color, label: String(s.atr.period) }]
    case 'volume': return [{ key: 'v', kind: 'hist', color: s.volume.upColor, histColor: 'candle', label: '' }]
    case 'obv': return [{ key: 'v', kind: 'line', color: s.obv.color, label: '' }]
  }
}

// 副图参考线（超买超卖 / 零轴）/ sub-pane reference lines
export function refLines(id: IndicatorId, s: IndicatorSettings): RefLine[] {
  switch (id) {
    case 'rsi': return [{ value: s.rsi.overbought, label: String(s.rsi.overbought) }, { value: s.rsi.oversold, label: String(s.rsi.oversold) }]
    case 'kdj': return [{ value: 80, label: '80' }, { value: 20, label: '20' }]
    case 'cci': return [{ value: 100, label: '100' }, { value: -100, label: '-100' }]
    case 'wr': return [{ value: -20, label: '-20' }, { value: -80, label: '-80' }]
    default: return []
  }
}

// ── 计算 / compute ──
export type IndicatorOutput = Record<string, (number | null)[]>
export function computeIndicator(id: IndicatorId, bars: Candle[], s: IndicatorSettings): IndicatorOutput {
  const cl = closes(bars)
  switch (id) {
    case 'ma': return Object.fromEntries(s.ma.periods.map((p, i) => [String(i), sma(cl, p)]))
    case 'ema': return Object.fromEntries(s.ema.periods.map((p, i) => [String(i), ema(cl, p)]))
    case 'boll': { const b = bollinger(cl, s.boll.period, s.boll.mult); return { mid: b.mid, upper: b.upper, lower: b.lower } }
    case 'donch': return { upper: donchianHigh(bars.map((b) => b.h), s.donch.period), lower: donchianLow(bars.map((b) => b.l), s.donch.period) }
    case 'vwap': return { v: vwap(bars) }
    case 'st': { const r = superTrend(bars, s.st.period, s.st.mult); return { bull: r.bull, bear: r.bear } }
    case 'sar': return { v: parabolicSar(bars, s.sar.step, s.sar.max) }
    case 'rsi': return { v: rsi(cl, s.rsi.period) }
    case 'macd': { const m = macd(cl, s.macd.fast, s.macd.slow, s.macd.signal); return { macd: m.macd, signal: m.signal, hist: m.hist } }
    case 'kdj': { const r = kdj(bars, s.kdj.period, s.kdj.kSmooth, s.kdj.dSmooth); return { k: r.k, d: r.d, j: r.j } }
    case 'cci': return { v: cci(bars, s.cci.period) }
    case 'wr': return { v: williamsR(bars, s.wr.period) }
    case 'atr': return { v: atr(bars, s.atr.period) }
    case 'volume': return { v: bars.map((b) => b.v) }
    case 'obv': return { v: obv(bars) }
  }
}

// 面板行头的参数摘要 / one-line parameter summary for the panel rows
export function summaryOf(id: IndicatorId, s: IndicatorSettings): string {
  switch (id) {
    case 'ma': return s.ma.periods.join(' · ')
    case 'ema': return s.ema.periods.join(' · ')
    case 'boll': return `${s.boll.period} × ${s.boll.mult}σ`
    case 'donch': return String(s.donch.period)
    case 'vwap': return ''
    case 'st': return `${s.st.period} × ${s.st.mult}`
    case 'sar': return `${s.sar.step} / ${s.sar.max}`
    case 'rsi': return `${s.rsi.period} · ${s.rsi.overbought} / ${s.rsi.oversold}`
    case 'macd': return `${s.macd.fast} · ${s.macd.slow} · ${s.macd.signal}`
    case 'kdj': return `${s.kdj.period} · ${s.kdj.kSmooth} · ${s.kdj.dSmooth}`
    case 'cci': return String(s.cci.period)
    case 'wr': return String(s.wr.period)
    case 'atr': return String(s.atr.period)
    case 'volume': return ''
    case 'obv': return ''
  }
}

// 副图的数值精度：价格类跟品种小数位，比率类固定 / value precision for sub-pane legends
export function legendDigits(id: IndicatorId, priceDigits: number): number {
  switch (id) {
    case 'rsi': case 'kdj': case 'cci': case 'wr': return 2
    case 'macd': case 'atr': return Math.min(priceDigits, 5)
    case 'volume': case 'obv': return 0
    default: return priceDigits
  }
}
