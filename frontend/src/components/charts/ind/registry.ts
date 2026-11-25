// 指标注册表（阶段 4 第一批，43 种）：每种指标的输入、默认样式、参考线、填充与计算。
// 引擎、图例、添加对话框、设置对话框都只认这一份；加指标 = 这里加一项 + 五种语言的名字与说明。
// 数学在 ./math.ts（TradingView 的公式口径）；四个合作作者的自定义指标沿用 utils/indicators.ts。
// Indicator registry (phase 4 batch 1, 43 kinds): inputs, default styles, reference lines,
// fills and compute for each. The engine, legend, add dialog and settings dialog all read
// only this; adding one = an entry here + its name and description in five languages.
// Math lives in ./math.ts (TradingView formulas); the four partner indicators keep using
// utils/indicators.ts.
import type { Candle } from '../../../api/types'
import { kdj as kdjLegacy, parabolicSar, superTrend, xmaBand, maCandle, shenlong, wallZones } from '../../../utils/indicators'
import { brokerOffsetSec, parseInterval } from '../intervals'
import {
  ac, ao, aroon, atr, bollinger, cci, dmi, donchian, envelope, fractals, ichimoku, keltner, ma, macd, mfi, mom, obv,
  pivots, roc, rsi, stdev, stoch, stochRsi, vwapAnchored, willr, zigzag, type MaType,
} from './math'
import type { FillDef, HlineDef, IndDef, IndExtras, IndMarker, IndOutput, Inputs, InputDef, PlotDef } from './types'

const num = (inp: Inputs, k: string) => Number(inp[k])
const str = (inp: Inputs, k: string) => String(inp[k])
const nulls = (n: number) => new Array<number | null>(n).fill(null)

// 常用输入 / common inputs
const LEN = (def: number, key = 'len', max = 2000): InputDef => ({ key, kind: 'int', def, min: 1, max })
const SRC = (def: 'close' | 'hlc3' | 'hl2' = 'close'): InputDef => ({ key: 'src', kind: 'source', def })
const MULT = (def: number, key = 'mult'): InputDef => ({ key, kind: 'float', def, min: 0.001, max: 50, step: 0.1 })
const OFFSET: InputDef = { key: 'offset', kind: 'int', def: 0, min: -500, max: 500 }
const MA_T = (def: MaType, key = 'maType'): InputDef => ({ key, kind: 'ma', def })

const line = (key: string, color: string, label = key, extra: Partial<PlotDef> = {}): PlotDef => ({ key, kind: 'line', color, label, ...extra })
const hl = (key: string, value: number, label = String(value), color = '#787b86'): HlineDef => ({ key, value, color, dash: 'dashed', label })
const fill = (key: string, a: string, b: string, color: string, opacity: number, label = 'background', colorB?: string): FillDef =>
  ({ key, a, b, color, opacity, label, colorB })

// 券商日期（日序号）/ 周 / 月：枢轴点、VWAP 锚点、多周期都按券商服务器时间切。
// Broker date (day number) / week / month: pivots, VWAP anchors and MTF all split on broker time.
export const brokerDay = (t: number) => Math.floor((t + brokerOffsetSec(t)) / 86400)
export const brokerWeek = (t: number) => Math.floor((brokerDay(t) + 3) / 7)
export function brokerMonth(t: number): number {
  const d = new Date(brokerDay(t) * 86400_000)
  return d.getUTCFullYear() * 12 + d.getUTCMonth()
}
function periodKeyOf(kind: string, interval: string): (t: number) => number {
  let k = kind
  if (k === 'auto') {
    const p = parseInterval(interval)
    k = !p ? 'day' : p.unit === 'min' ? (p.n <= 15 ? 'day' : p.n <= 240 ? 'week' : 'month') : p.unit === 'D' ? 'month' : 'year'
  }
  if (k === 'week') return brokerWeek
  if (k === 'month') return brokerMonth
  if (k === 'year') return (t) => Math.floor(brokerMonth(t) / 12)
  return brokerDay
}

// ── 交易时段（按城市本地时间，自动跟夏令时）/ sessions (city local time, DST-aware) ──
const SESSIONS = [
  { key: 'asia', tz: 'Asia/Tokyo', from: 9, to: 18 },
  { key: 'london', tz: 'Europe/London', from: 8, to: 17 },
  { key: 'ny', tz: 'America/New_York', from: 8, to: 17 },
] as const
const hourFmt = new Map<string, Intl.DateTimeFormat>()
const hourCache = new Map<string, number>()
function localHour(tz: string, t: number): number {
  const hourStart = Math.floor(t / 3600) * 3600
  const ck = `${tz}|${hourStart}`
  const hit = hourCache.get(ck)
  if (hit != null) return hit
  let f = hourFmt.get(tz)
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }); hourFmt.set(tz, f) }
  const h = Number(f.format(new Date(hourStart * 1000))) % 24
  if (hourCache.size > 50_000) hourCache.clear()
  hourCache.set(ck, h)
  return h
}

// ── 均线族 / moving averages ──
function maDef(id: string, abbr: string, type: MaType, len: number, color: string): IndDef {
  return {
    id, abbr, group: 'ma', overlay: true,
    inputs: [LEN(len), SRC(), OFFSET],
    plots: [line('ma', color, 'ma', { width: 2 })],
    digits: 'price',
    offsetInput: 'offset',
    compute: ({ bars }, inp, src) => ({ ma: ma(type, src('src'), num(inp, 'len'), bars.map((b) => b.v)) }),
  }
}

const UPC = 'up'
const DNC = 'down'

const DEFS: IndDef[] = [
  maDef('sma', 'MA', 'sma', 20, '#f5c451'),
  maDef('ema', 'EMA', 'ema', 20, '#38bdf8'),
  maDef('wma', 'WMA', 'wma', 20, '#a78bfa'),
  maDef('vwma', 'VWMA', 'vwma', 20, '#22d3ee'),
  maDef('hma', 'HMA', 'hma', 9, '#f472b6'),
  maDef('dema', 'DEMA', 'dema', 9, '#fb7185'),
  maDef('tema', 'TEMA', 'tema', 9, '#facc15'),
  maDef('smma', 'SMMA', 'rma', 7, '#2ee07e'),

  // ── 趋势 / trend ──
  {
    id: 'envelope', abbr: 'ENV', group: 'trend', overlay: true,
    inputs: [LEN(20), MULT(10, 'pct'), SRC(), MA_T('sma')],
    plots: [line('basis', '#f5a623', 'basis'), line('upper', '#2962ff', 'upper'), line('lower', '#2962ff', 'lower')],
    fills: [fill('bg', 'upper', 'lower', '#2962ff', 8)],
    digits: 'price',
    compute: (_c, inp, src) => envelope(src('src'), num(inp, 'len'), num(inp, 'pct'), str(inp, 'maType') as MaType),
  },
  {
    id: 'ichimoku', abbr: 'Ichimoku', group: 'trend', overlay: true,
    inputs: [LEN(9, 'conv', 500), LEN(26, 'base', 500), LEN(52, 'spanB', 500), LEN(26, 'disp', 500)],
    plots: [
      line('conv', '#2962ff', 'conv'), line('base', '#b71c1c', 'base'), line('lag', '#43a047', 'lag'),
      line('spanA', '#a5d6a7', 'spanA'), line('spanB', '#ef9a9a', 'spanB'),
    ],
    fills: [fill('cloud', 'spanA', 'spanB', '#43a047', 10, 'cloud', '#f44336')],
    digits: 'price', noTf: false,
    plotOffsets: (inp) => ({ lag: -(num(inp, 'disp') - 1), spanA: num(inp, 'disp') - 1, spanB: num(inp, 'disp') - 1 }),
    compute: ({ bars }, inp) => {
      const r = ichimoku(bars, num(inp, 'conv'), num(inp, 'base'), num(inp, 'spanB'))
      return { conv: r.conv, base: r.base, spanA: r.spanA, spanB: r.spanB, lag: bars.map((b) => b.c) }
    },
  },
  {
    id: 'psar', abbr: 'SAR', group: 'trend', overlay: true,
    inputs: [MULT(0.02, 'step'), MULT(0.2, 'max')],
    plots: [{ key: 'sar', kind: 'cross', color: '#2962ff', label: 'sar' }],
    digits: 'price',
    compute: ({ bars }, inp) => ({ sar: parabolicSar(bars, num(inp, 'step'), num(inp, 'max')) }),
  },
  {
    id: 'supertrend', abbr: 'ST', group: 'trend', overlay: true,
    inputs: [LEN(10, 'atrLen'), MULT(3)],
    plots: [line('up', '#2ee07e', 'upTrend', { gaps: true, width: 2 }), line('dn', '#ff4d67', 'downTrend', { gaps: true, width: 2 })],
    digits: 'price',
    compute: ({ bars }, inp) => { const r = superTrend(bars, num(inp, 'atrLen'), num(inp, 'mult')); return { up: r.bull, dn: r.bear } },
  },
  {
    id: 'alligator', abbr: 'Alligator', group: 'trend', overlay: true,
    inputs: [LEN(13, 'jawLen'), LEN(8, 'jawOff', 200), LEN(8, 'teethLen'), LEN(5, 'teethOff', 200), LEN(5, 'lipsLen'), LEN(3, 'lipsOff', 200)],
    plots: [line('jaw', '#2962ff', 'jaw'), line('teeth', '#e91e63', 'teeth'), line('lips', '#66bb6a', 'lips')],
    digits: 'price',
    title: (inp) => `${inp.jawLen} ${inp.teethLen} ${inp.lipsLen}`,
    plotOffsets: (inp) => ({ jaw: num(inp, 'jawOff'), teeth: num(inp, 'teethOff'), lips: num(inp, 'lipsOff') }),
    compute: ({ bars }, inp) => {
      const hl2 = bars.map((b) => (b.h + b.l) / 2)
      return { jaw: ma('rma', hl2, num(inp, 'jawLen')), teeth: ma('rma', hl2, num(inp, 'teethLen')), lips: ma('rma', hl2, num(inp, 'lipsLen')) }
    },
  },
  {
    id: 'zigzag', abbr: 'ZZ', group: 'trend', overlay: true,
    inputs: [MULT(5, 'dev'), LEN(10, 'depth', 500)],
    plots: [line('zz', '#2962ff', 'zigzag', { width: 2 })],
    digits: 'price',
    compute: ({ bars }, inp) => ({ zz: zigzag(bars, num(inp, 'dev'), num(inp, 'depth')) }),
  },
  {
    id: 'fractals', abbr: 'Fractals', group: 'trend', overlay: true, noTf: true,
    inputs: [LEN(2, 'periods', 20)],
    plots: [],
    title: (inp) => String(inp.periods),
    compute: ({ bars }, inp) => {
      const f = fractals(bars, num(inp, 'periods'))
      const markers: IndMarker[] = []
      f.up.forEach((on, i) => { if (on) markers.push({ i, shape: 'arrowDown', position: 'aboveBar', color: '#ff4d67' }) })
      f.down.forEach((on, i) => { if (on) markers.push({ i, shape: 'arrowUp', position: 'belowBar', color: '#2ee07e' }) })
      return { __x: { markers } }
    },
  },
  {
    id: 'dmi', abbr: 'DMI', group: 'trend', overlay: false,
    inputs: [LEN(14, 'diLen', 500), LEN(14, 'adxLen', 500)],
    plots: [line('adx', '#f5a623', 'adx'), line('plus', '#2962ff', 'plusDi'), line('minus', '#ff4d67', 'minusDi')],
    digits: 2,
    compute: ({ bars }, inp) => dmi(bars, num(inp, 'diLen'), num(inp, 'adxLen')),
  },
  {
    id: 'aroon', abbr: 'Aroon', group: 'trend', overlay: false,
    inputs: [LEN(14)],
    plots: [line('up', '#f5a623', 'aroonUp'), line('down', '#2962ff', 'aroonDown')],
    digits: 2,
    compute: ({ bars }, inp) => aroon(bars, num(inp, 'len')),
  },

  // ── 动量 / momentum ──
  {
    id: 'rsi', abbr: 'RSI', group: 'momentum', overlay: false,
    inputs: [LEN(14), SRC()],
    plots: [line('rsi', '#a78bfa', 'rsi')],
    hlines: [hl('ob', 70), hl('mid', 50, '50'), hl('os', 30)],
    fills: [fill('band', 'h:ob', 'h:os', '#7e57c2', 10)],
    digits: 2,
    compute: (_c, inp, src) => ({ rsi: rsi(src('src'), num(inp, 'len')) }),
  },
  {
    id: 'stoch', abbr: 'Stoch', group: 'momentum', overlay: false,
    inputs: [LEN(14, 'kLen'), LEN(1, 'kSmooth', 100), LEN(3, 'dLen', 100)],
    plots: [line('k', '#2962ff', 'k'), line('d', '#ff6d00', 'd')],
    hlines: [hl('ob', 80), hl('mid', 50, '50'), hl('os', 20)],
    fills: [fill('band', 'h:ob', 'h:os', '#2196f3', 8)],
    digits: 2,
    compute: ({ bars }, inp) => stoch(bars, num(inp, 'kLen'), num(inp, 'kSmooth'), num(inp, 'dLen')),
  },
  {
    id: 'stochrsi', abbr: 'Stoch RSI', group: 'momentum', overlay: false,
    inputs: [LEN(3, 'k', 100), LEN(3, 'd', 100), LEN(14, 'rsiLen'), LEN(14, 'stochLen'), SRC()],
    plots: [line('k', '#2962ff', 'k'), line('d', '#ff6d00', 'd')],
    hlines: [hl('ob', 80), hl('mid', 50, '50'), hl('os', 20)],
    fills: [fill('band', 'h:ob', 'h:os', '#2196f3', 8)],
    digits: 2,
    compute: (_c, inp, src) => stochRsi(src('src'), num(inp, 'rsiLen'), num(inp, 'stochLen'), num(inp, 'k'), num(inp, 'd')),
  },
  {
    id: 'macd', abbr: 'MACD', group: 'momentum', overlay: false,
    inputs: [LEN(12, 'fast', 500), LEN(26, 'slow', 500), SRC(), LEN(9, 'signal', 200),
      { key: 'oscMa', kind: 'ma', def: 'ema', options: ['ema', 'sma'] }, { key: 'sigMa', kind: 'ma', def: 'ema', options: ['ema', 'sma'] }],
    plots: [
      { key: 'hist', kind: 'columns', color: '#26a69a', colors: ['#26a69a', '#b2dfdb', '#ffcdd2', '#ff5252'], label: 'hist' },
      line('macd', '#2962ff', 'macd'), line('signal', '#ff6d00', 'signal'),
    ],
    hlines: [hl('zero', 0, '0')],
    digits: 'price',
    title: (inp) => `${inp.fast} ${inp.slow} ${inp.signal}`,
    compute: (_c, inp, src) => {
      const r = macd(src('src'), num(inp, 'fast'), num(inp, 'slow'), num(inp, 'signal'), str(inp, 'oscMa') as 'ema' | 'sma', str(inp, 'sigMa') as 'ema' | 'sma')
      // 四色柱：零上增长 / 零上回落 / 零下回升 / 零下加深 / 4-colour histogram as on TradingView
      const c = r.hist.map((v, i) => {
        if (v == null) return null
        const p = i > 0 ? r.hist[i - 1] : null
        if (v >= 0) return p != null && p > v ? 1 : 0
        return p != null && p < v ? 2 : 3
      })
      return { hist: r.hist, macd: r.macd, signal: r.signal, 'hist#c': c }
    },
  },
  {
    id: 'kdj', abbr: 'KDJ', group: 'momentum', overlay: false,
    inputs: [LEN(9, 'len', 500), LEN(3, 'kSmooth', 50), LEN(3, 'dSmooth', 50)],
    plots: [line('k', '#f5c451', 'k'), line('d', '#38bdf8', 'd'), line('j', '#f472b6', 'j')],
    hlines: [hl('ob', 80), hl('os', 20)],
    digits: 2,
    compute: ({ bars }, inp) => kdjLegacy(bars, num(inp, 'len'), num(inp, 'kSmooth'), num(inp, 'dSmooth')) as unknown as IndOutput,
  },
  {
    id: 'cci', abbr: 'CCI', group: 'momentum', overlay: false,
    inputs: [LEN(20), SRC('hlc3')],
    plots: [line('cci', '#2962ff', 'cci')],
    hlines: [hl('ob', 100), hl('mid', 0, '0'), hl('os', -100)],
    fills: [fill('band', 'h:ob', 'h:os', '#2196f3', 8)],
    digits: 2,
    compute: (_c, inp, src) => ({ cci: cci(src('src'), num(inp, 'len')) }),
  },
  {
    id: 'willr', abbr: '%R', group: 'momentum', overlay: false,
    inputs: [LEN(14)],
    plots: [line('r', '#7e57c2', 'willr')],
    hlines: [hl('ob', -20), hl('mid', -50, '-50'), hl('os', -80)],
    fills: [fill('band', 'h:ob', 'h:os', '#7e57c2', 8)],
    digits: 2,
    compute: ({ bars }, inp) => ({ r: willr(bars, num(inp, 'len')) }),
  },
  {
    id: 'mom', abbr: 'Mom', group: 'momentum', overlay: false,
    inputs: [LEN(10), SRC()],
    plots: [line('mom', '#2962ff', 'mom')],
    hlines: [hl('zero', 0, '0')],
    digits: 'price',
    compute: (_c, inp, src) => ({ mom: mom(src('src'), num(inp, 'len')) }),
  },
  {
    id: 'roc', abbr: 'ROC', group: 'momentum', overlay: false,
    inputs: [LEN(9), SRC()],
    plots: [line('roc', '#2962ff', 'roc')],
    hlines: [hl('zero', 0, '0')],
    digits: 2,
    compute: (_c, inp, src) => ({ roc: roc(src('src'), num(inp, 'len')) }),
  },
  {
    id: 'ao', abbr: 'AO', group: 'momentum', overlay: false,
    inputs: [],
    plots: [{ key: 'ao', kind: 'columns', color: '#26a69a', colors: ['#26a69a', '#ff5252'], label: 'ao' }],
    digits: 'price',
    compute: ({ bars }) => { const v = ao(bars); return { ao: v, 'ao#c': risingIdx(v) } },
  },
  {
    id: 'ac', abbr: 'AC', group: 'momentum', overlay: false,
    inputs: [],
    plots: [{ key: 'ac', kind: 'columns', color: '#26a69a', colors: ['#26a69a', '#ff5252'], label: 'ac' }],
    digits: 'price',
    compute: ({ bars }) => { const v = ac(bars); return { ac: v, 'ac#c': risingIdx(v) } },
  },

  // ── 波动 / volatility ──
  {
    id: 'bb', abbr: 'BB', group: 'volatility', overlay: true,
    inputs: [LEN(20), MA_T('sma'), SRC(), MULT(2), OFFSET],
    plots: [line('basis', '#f5a623', 'basis'), line('upper', '#2962ff', 'upper'), line('lower', '#2962ff', 'lower')],
    fills: [fill('bg', 'upper', 'lower', '#2196f3', 8)],
    digits: 'price',
    offsetInput: 'offset',
    title: (inp) => `${inp.len} ${inp.mult}`,
    compute: (_c, inp, src) => bollinger(src('src'), num(inp, 'len'), num(inp, 'mult'), str(inp, 'maType') as MaType),
  },
  {
    id: 'keltner', abbr: 'KC', group: 'volatility', overlay: true,
    inputs: [LEN(20), MULT(2), SRC(), { key: 'useEma', kind: 'bool', def: true }, LEN(10, 'atrLen', 500)],
    plots: [line('basis', '#2962ff', 'basis'), line('upper', '#2962ff', 'upper'), line('lower', '#2962ff', 'lower')],
    fills: [fill('bg', 'upper', 'lower', '#2196f3', 8)],
    digits: 'price',
    title: (inp) => `${inp.len} ${inp.mult}`,
    compute: ({ bars }, inp, src) => keltner(bars, src('src'), num(inp, 'len'), num(inp, 'mult'), num(inp, 'atrLen'), inp.useEma !== false),
  },
  {
    id: 'dc', abbr: 'DC', group: 'volatility', overlay: true,
    inputs: [LEN(20), OFFSET],
    plots: [line('basis', '#ff6d00', 'basis'), line('upper', '#2962ff', 'upper'), line('lower', '#2962ff', 'lower')],
    fills: [fill('bg', 'upper', 'lower', '#2196f3', 8)],
    digits: 'price',
    offsetInput: 'offset',
    compute: ({ bars }, inp) => donchian(bars, num(inp, 'len')),
  },
  {
    id: 'atr', abbr: 'ATR', group: 'volatility', overlay: false,
    inputs: [LEN(14), { key: 'smoothing', kind: 'ma', def: 'rma', options: ['rma', 'sma', 'ema', 'wma'] }],
    plots: [line('atr', '#b71c1c', 'atr')],
    digits: 'price',
    compute: ({ bars }, inp) => ({ atr: atr(bars, num(inp, 'len'), str(inp, 'smoothing') as 'rma') }),
  },
  {
    id: 'stdev', abbr: 'StdDev', group: 'volatility', overlay: false,
    inputs: [LEN(20), SRC()],
    plots: [line('sd', '#2962ff', 'stdev')],
    digits: 'price',
    compute: (_c, inp, src) => ({ sd: stdev(src('src'), num(inp, 'len')) }),
  },

  // ── 成交量（tick 量）/ volume (tick volume) ──
  {
    id: 'vol', abbr: 'Vol', group: 'volume', overlay: false, noTf: false,
    inputs: [{ key: 'showMa', kind: 'bool', def: false }, LEN(20, 'maLen')],
    plots: [
      { key: 'vol', kind: 'columns', color: UPC, colors: [UPC, DNC], label: 'volume', },
      // gaps：没开均量线时整条为空，图例里不显示「–」/ gaps: when the MA is off the legend shows nothing instead of "–"
      line('ma', '#2962ff', 'ma', { gaps: true }),
    ],
    digits: 'volume',
    title: () => '',
    compute: ({ bars }, inp) => {
      const v = bars.map((b) => b.v)
      return {
        vol: v,
        'vol#c': bars.map((b) => (b.c >= b.o ? 0 : 1)),
        ma: inp.showMa === true ? ma('sma', v, num(inp, 'maLen')) : nulls(bars.length),
      }
    },
  },
  {
    id: 'obv', abbr: 'OBV', group: 'volume', overlay: false,
    inputs: [],
    plots: [line('obv', '#2962ff', 'obv')],
    digits: 0,
    compute: ({ bars }) => ({ obv: obv(bars) }),
  },
  {
    id: 'mfi', abbr: 'MFI', group: 'volume', overlay: false,
    inputs: [LEN(14)],
    plots: [line('mfi', '#7e57c2', 'mfi')],
    hlines: [hl('ob', 80), hl('os', 20)],
    fills: [fill('band', 'h:ob', 'h:os', '#7e57c2', 8)],
    digits: 2,
    compute: ({ bars }, inp) => ({ mfi: mfi(bars, num(inp, 'len')) }),
  },
  {
    id: 'vwap', abbr: 'VWAP', group: 'volume', overlay: true, noTf: true,
    inputs: [{ key: 'anchor', kind: 'select', def: 'session', options: ['session', 'week', 'month'] },
      { key: 'bands', kind: 'bool', def: false }, MULT(1, 'm1'), MULT(2, 'm2')],
    plots: [line('vwap', '#ffa85c', 'vwap', { width: 2 }), line('u1', '#2ee07e', 'upper1'), line('l1', '#2ee07e', 'lower1'),
      line('u2', '#f5c451', 'upper2'), line('l2', '#f5c451', 'lower2')],
    fills: [fill('b1', 'u1', 'l1', '#2ee07e', 6, 'band1'), fill('b2', 'u2', 'l2', '#f5c451', 4, 'band2')],
    digits: 'price',
    title: (inp) => String(inp.anchor),
    compute: ({ bars, interval }, inp) => {
      const key = periodKeyOf(str(inp, 'anchor') === 'session' ? 'day' : str(inp, 'anchor'), interval)
      const on = inp.bands === true
      const r = vwapAnchored(bars, key, on ? [num(inp, 'm1'), num(inp, 'm2')] : [])
      const n = bars.length
      return {
        vwap: r.vwap,
        u1: r.bands[0]?.upper ?? nulls(n), l1: r.bands[0]?.lower ?? nulls(n),
        u2: r.bands[1]?.upper ?? nulls(n), l2: r.bands[1]?.lower ?? nulls(n),
      }
    },
  },

  // ── 价位与时段 / levels & sessions ──
  {
    id: 'pivots', abbr: 'Pivots', group: 'levels', overlay: true, noTf: true,
    inputs: [{ key: 'kind', kind: 'select', def: 'traditional', options: ['traditional', 'fibonacci', 'woodie', 'classic', 'camarilla'] },
      { key: 'period', kind: 'select', def: 'auto', options: ['auto', 'day', 'week', 'month'] }],
    plots: [
      line('p', '#f5a623', 'P', { gaps: true }),
      line('r1', '#ff4d67', 'R1', { gaps: true }), line('r2', '#ff4d67', 'R2', { gaps: true }), line('r3', '#ff4d67', 'R3', { gaps: true }),
      line('s1', '#2ee07e', 'S1', { gaps: true }), line('s2', '#2ee07e', 'S2', { gaps: true }), line('s3', '#2ee07e', 'S3', { gaps: true }),
    ],
    digits: 'price',
    title: (inp) => `${inp.kind} ${inp.period}`,
    compute: ({ bars, interval }, inp) => pivots(bars, periodKeyOf(str(inp, 'period'), interval), str(inp, 'kind') as 'traditional'),
  },
  {
    id: 'sessions', abbr: 'Sessions', group: 'levels', overlay: true, noTf: true,
    inputs: [{ key: 'asia', kind: 'bool', def: true }, { key: 'london', kind: 'bool', def: true }, { key: 'ny', kind: 'bool', def: true }],
    plots: [],
    // 填充色当样式用：f:asia / f:london / f:ny 可在样式页改色 / fills double as the session colours
    fills: [
      fill('asia', '', '', '#38bdf8', 7, 'asia'),
      fill('london', '', '', '#a78bfa', 7, 'london'),
      fill('ny', '', '', '#f5a623', 7, 'ny'),
    ],
    title: () => '',
    compute: ({ bars, interval }, inp) => {
      const p = parseInterval(interval)
      if (!p || p.unit !== 'min' || p.n > 240) return { __x: { bg: [] } }
      // 颜色在引擎里按 f:<key> 样式解析；这里只给时段 key / colours resolve in the engine from f:<key>
      const bg = bars.map((b) => {
        let hit: string | null = null
        for (const s of SESSIONS) {
          if (inp[s.key] === false) continue
          const h = localHour(s.tz, b.t)
          if (h >= s.from && h < s.to) hit = s.key
        }
        return hit
      })
      return { __x: { bg } }
    },
  },

  // ── 合作作者（沿用原公式）/ partner indicators (original formulas) ──
  {
    id: 'xmab', abbr: 'XMA', group: 'custom', overlay: true, noTf: true,
    inputs: [LEN(38, 'period', 200), MULT(1.08, 'p1'), MULT(1.08, 'p2')],
    plots: [
      line('upper', '#38bdf8', 'upper'), line('lower', '#38bdf8', 'lower'),
      line('upperDn', '#2ee07e', 'upperDn', { gaps: true, noLegend: true }), line('lowerDn', '#2ee07e', 'lowerDn', { gaps: true, noLegend: true }),
      line('mid', '#94a3b8', 'mid', { dash: 'dashed' }), line('ob', '#facc15', 'ob', { dash: 'dashed' }), line('os', '#f472b6', 'os', { dash: 'dashed' }),
    ],
    digits: 'price',
    compute: ({ bars }, inp) => ({ ...xmaBand(bars, num(inp, 'period'), num(inp, 'p1'), num(inp, 'p2')) }),
  },
  {
    id: 'macandle', abbr: 'HY', group: 'custom', overlay: true, pro: true, noTf: true,
    inputs: [LEN(20, 'period', 500), { key: 'delay', kind: 'int', def: 1, min: 0, max: 10 }],
    plots: [{ key: 'ma', kind: 'line', color: '#ff4d67', colors: ['#ff4d67', '#2ee07e'], width: 3, label: 'ma' }],
    digits: 'price',
    compute: ({ bars }, inp) => {
      const r = maCandle(bars, num(inp, 'period'), num(inp, 'delay'))
      return { ma: r.ma, 'ma#c': r.segDir.map((d) => (d != null && d < 0 ? 1 : 0)), __x: { markers: sigMarkers(r.sig) } }
    },
  },
  {
    id: 'shenlong', abbr: 'SL', group: 'custom', overlay: true, pro: true, noTf: true,
    inputs: [LEN(25, 'period', 200)],
    plots: [
      line('hi', '#e5e7eb', 'upper'), line('lo', '#e5e7eb', 'lower'),
      line('slSellLine', '#ff4d67', 'slSell', { dash: 'dashed', noLegend: true }), line('slBuyLine', '#2ee07e', 'slBuy', { dash: 'dashed', noLegend: true }),
      line('belt', '#94a3b8', 'belt', { noLegend: true }),
    ],
    fills: [fill('up', '', '', '#b91c1c', 100, 'upChannel'), fill('down', '', '', '#15803d', 100, 'downChannel'), fill('side', '', '', '#6b7280', 100, 'sideChannel')],
    digits: 'price',
    compute: ({ bars }, inp) => {
      const r = shenlong(bars, num(inp, 'period'))
      const strips: NonNullable<IndExtras['strips']> = []
      r.beltTop.forEach((top, i) => { const bot = r.beltBot[i]; if (top != null && bot != null) strips.push({ i, top, bottom: bot, color: '#555555' }) })
      r.chKind.forEach((k, i) => {
        const top = r.chTop[i]; const bot = r.chBot[i]
        if (k == null || top == null || bot == null) return
        strips.push({ i, top, bottom: bot, color: k > 0 ? 'f:up' : k < 0 ? 'f:down' : 'f:side' })
      })
      const markers = sigMarkers(r.sig)
      r.slBuy.forEach((p, i) => { if (p != null) markers.push({ i, shape: 'square', position: 'atPriceMiddle', price: p, color: '#ff4d67', text: 'slBuy' }) })
      r.slSell.forEach((p, i) => { if (p != null) markers.push({ i, shape: 'square', position: 'atPriceMiddle', price: p, color: '#2ee07e', text: 'slSell' }) })
      return { hi: r.hi, lo: r.lo, slSellLine: r.slSellLine, slBuyLine: r.slBuyLine, belt: r.belt, __x: { strips, markers } }
    },
  },
  {
    id: 'kpsq', abbr: 'KP', group: 'custom', overlay: true, pro: true, noTf: true,
    inputs: [LEN(50, 'ma1', 1000), LEN(72, 'ma2', 1000), LEN(180, 'ma3', 1000)],
    plots: [line('ma1', '#f5c451', 'ma1'), line('ma2', '#a78bfa', 'ma2'), line('ma3', '#22d3ee', 'ma3')],
    fills: [fill('res', '', '', '#2ee07e', 100, 'resZone'), fill('sup', '', '', '#ff4d67', 100, 'supZone')],
    digits: 'price',
    compute: ({ bars }, inp) => {
      const cl = bars.map((b) => b.c)
      const zones = wallZones(bars).map((w) => ({ i: w.start, top: w.top, bottom: w.bottom, color: w.kind === 'res' ? 'f:res' : 'f:sup' }))
      return { ma1: ma('sma', cl, num(inp, 'ma1')), ma2: ma('sma', cl, num(inp, 'ma2')), ma3: ma('sma', cl, num(inp, 'ma3')), __x: { zones } }
    },
  },
]

// 涨跌柱的颜色下标：比上一根高 0，否则 1 / rising (0) vs falling (1) column colour index
function risingIdx(v: (number | null)[]): (number | null)[] {
  return v.map((x, i) => (x == null ? null : i > 0 && v[i - 1] != null && x < (v[i - 1] as number) ? 1 : 0))
}

// 合作指标的信号：1 多 / -1 空 / 2 平多 / -2 平空；文字由引擎按语言换 / partner signals; text localized by the engine
function sigMarkers(sig: (number | null)[]): IndMarker[] {
  const out: IndMarker[] = []
  sig.forEach((v, i) => {
    if (v === 1) out.push({ i, shape: 'arrowUp', position: 'belowBar', color: '#facc15', text: 'buy' })
    else if (v === -1) out.push({ i, shape: 'arrowDown', position: 'aboveBar', color: '#f472b6', text: 'sell' })
    else if (v === 2) out.push({ i, shape: 'circle', position: 'aboveBar', color: '#facc15', text: 'closeBuy' })
    else if (v === -2) out.push({ i, shape: 'circle', position: 'belowBar', color: '#facc15', text: 'closeSell' })
  })
  return out
}

export const IND_DEFS: ReadonlyMap<string, IndDef> = new Map(DEFS.map((d) => [d.id, d]))
export const IND_IDS: string[] = DEFS.map((d) => d.id)
export const IND_GROUPS = ['ma', 'trend', 'momentum', 'volatility', 'volume', 'levels', 'custom'] as const

export function defOf(type: string): IndDef | undefined {
  return IND_DEFS.get(type)
}

// 默认输入值 / default inputs
export function defaultInputs(def: IndDef): Inputs {
  return Object.fromEntries(def.inputs.map((i) => [i.key, i.def]))
}

// 价格类数据源 → 数组 / price source → array
export function priceSource(bars: Candle[], kind: string): number[] {
  switch (kind) {
    case 'open': return bars.map((b) => b.o)
    case 'high': return bars.map((b) => b.h)
    case 'low': return bars.map((b) => b.l)
    case 'hl2': return bars.map((b) => (b.h + b.l) / 2)
    case 'hlc3': return bars.map((b) => (b.h + b.l + b.c) / 3)
    case 'ohlc4': return bars.map((b) => (b.o + b.h + b.l + b.c) / 4)
    case 'hlcc4': return bars.map((b) => (b.h + b.l + 2 * b.c) / 4)
    default: return bars.map((b) => b.c)
  }
}
