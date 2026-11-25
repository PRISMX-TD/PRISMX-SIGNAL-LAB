// 指标注册表第三批（12 种）：成交量分布（可见范围 / 时段）、TPO、K 线形态、自动图表形态、自动斐波那契、
// 多周期 K 线箱体、52 周高低、区间表现、技术评级、相关系数、价差。图形通过 __x 交给 ind/shapePrimitive 画；
// 要别的 K 线（本品种日线、另一个品种）时用 ctx.other，没到之前先画空的，到了引擎自动重算。
// Indicator registry batch 3 (12 kinds): volume profile (visible range / session), TPO, candlestick
// patterns, auto chart patterns, auto Fibonacci, HTF candle boxes, 52-week high/low, performance,
// technical ratings, correlation and spread. Shapes go through __x to ind/shapePrimitive; other bars
// (this symbol's daily, another symbol) come from ctx.other, empty until they arrive, after which
// the engine recomputes.
import type { Candle } from '../../../api/types'
import { parseInterval } from '../intervals'
import { atr } from './math'
import {
  CANDLE_PATTERNS, CHART_PATTERNS, alignCloses, candlePatterns, chartPatterns, correlation, highLow52, htfBoxes, lastSwing, performance, PERF_KEYS, ratingBand,
  sessionProfiles, techRating, tpoProfiles,
} from './math3'
import { barSeconds, brokerDay, brokerYear, periodKeyOf, tfKeyFn } from './periods'
import type { CompOut, FillDef, HlineDef, IndCtx, IndDef, IndExtras, IndMarker, Inputs, PlotDef } from './types'

const num = (inp: Inputs, k: string) => Number(inp[k])
const str = (inp: Inputs, k: string) => String(inp[k])
const nulls = (n: number) => new Array<number | null>(n).fill(null)
// 什么都不画 / draw nothing
const NONE: CompOut = {}
const line = (key: string, color: string, label = key, extra: Partial<PlotDef> = {}): PlotDef => ({ key, kind: 'line', color, label, ...extra })
const hl = (key: string, value: number, label = String(value), color = '#787b86'): HlineDef => ({ key, value, color, dash: 'dashed', label })
const fill = (key: string, color: string, opacity: number, label = key): FillDef => ({ key, a: '', b: '', color, opacity, label })

const BULL = '#2ee07e'
const BEAR = '#ff4d67'
const NEUTRAL = '#94a3b8'
const dirColor = (d: number) => (d > 0 ? BULL : d < 0 ? BEAR : '#5b9cf6')
const fmt = (v: number, digits: number) => v.toFixed(Math.max(0, Math.min(8, digits)))

// 成交量分布的配色（TV：上涨量蓝、下跌量黄，价值区更实，POC 红）
// Volume-profile colours (TV: up volume blue, down volume yellow, stronger inside the value area, red POC)
const VP_FILLS = [
  fill('up', '#2962ff', 28, 'upVol'), fill('dn', '#fbc02d', 28, 'downVol'),
  fill('vaUp', '#2962ff', 55, 'vaUp'), fill('vaDn', '#fbc02d', 55, 'vaDown'),
  fill('poc', '#ff5252', 100, 'poc'),
]
const VP_COLORS = { up: 'f:up', dn: 'f:dn', vaUp: 'f:vaUp', vaDn: 'f:vaDn', poc: 'f:poc' }

// ZigZag 偏离 0 = 自动：按 ATR(14) 的 3 倍占价格的百分比 / deviation 0 = auto: 3 × ATR(14) as a percent of price
function autoDev(bars: Candle[], dev: number): number {
  if (dev > 0) return dev
  const n = bars.length
  if (n === 0) return 1
  const a = atr(bars, 14)[n - 1]
  const c = bars[n - 1].c
  return a != null && c ? Math.max(0.05, ((a * 3) / c) * 100) : 1
}

// 当前图表周期的日线（日线及以下周期才取；日线图直接用图上 K 线）
// Daily bars for this symbol (fetched for intraday charts; a daily chart uses its own bars)
function dailyOf(ctx: IndCtx): Candle[] | null {
  const p = parseInterval(ctx.interval)
  if (p && p.unit === 'D' && p.n === 1) return ctx.bars
  return ctx.symbol && ctx.other ? ctx.other(ctx.symbol, 'D') : null
}

// 另一个品种按时间对齐到图上 K 线 / another symbol aligned to the chart bars
function otherAligned(ctx: IndCtx, sym: string): (number | null)[] {
  const o = sym && ctx.other ? ctx.other(sym, ctx.interval) : null
  if (!o) return nulls(ctx.bars.length)
  const p = parseInterval(ctx.interval)
  const gap = Math.max(barSeconds(ctx.interval) * 3, p && p.unit !== 'min' ? 4 * 86400 : 0)
  return alignCloses(ctx.bars, o, gap)
}

const FIB_LEVELS: [number, string][] = [
  [0, '#787b86'], [0.236, '#f23645'], [0.382, '#ff9800'], [0.5, '#4caf50'], [0.618, '#089981'], [0.786, '#00bcd4'], [1, '#787b86'],
]
const FIB_EXT: [number, string][] = [[1.272, '#9c27b0'], [1.618, '#2962ff'], [2.618, '#f23645']]
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

const RATING_COLORS = ['#f23645', '#f7525f', '#787b86', '#22ab94', '#089981']
const RATING_TEXT = ['tr_strongSell', 'tr_sell', 'tr_neutral', 'tr_buy', 'tr_strongBuy']

// 图上要翻译的全部文字（charts.ind.mk.<key>，图上写作 'mk.<key>'）/ every on-chart text key (charts.ind.mk.<key>, written 'mk.<key>')
export const MK_KEYS: string[] = [
  ...CANDLE_PATTERNS.map((k) => `cp_${k}`), ...CHART_PATTERNS.map((k) => `ch_${k}`), ...PERF_KEYS.map((k) => `perf_${k}`), ...RATING_TEXT,
]

export const DEFS3: IndDef[] = [
  // ── 成交量分布 / volume profiles ──
  {
    id: 'vpvr', abbr: 'VPVR', group: 'volume', overlay: true, noTf: true,
    inputs: [{ key: 'rows', kind: 'int', def: 24, min: 4, max: 200 }, { key: 'vaPct', kind: 'int', def: 70, min: 10, max: 100 },
      { key: 'width', kind: 'int', def: 30, min: 5, max: 100 }],
    plots: [],
    fills: VP_FILLS,
    title: (inp) => `${inp.rows} ${inp.vaPct}%`,
    compute: (_ctx, inp) => ({ __x: { vpVisible: { rows: num(inp, 'rows'), vaPct: num(inp, 'vaPct'), width: num(inp, 'width') / 100, ...VP_COLORS } } }),
  },
  {
    id: 'vpsv', abbr: 'VPSV', group: 'volume', overlay: true, noTf: true,
    inputs: [{ key: 'session', kind: 'select', def: 'auto', options: ['auto', 'day', 'week', 'month'] },
      { key: 'rows', kind: 'int', def: 24, min: 4, max: 200 }, { key: 'vaPct', kind: 'int', def: 70, min: 10, max: 100 },
      { key: 'width', kind: 'int', def: 40, min: 5, max: 100 }],
    plots: [],
    fills: VP_FILLS,
    title: (inp) => `${inp.session} ${inp.rows}`,
    compute: ({ bars, interval }, inp) => {
      const ps = sessionProfiles(bars, periodKeyOf(str(inp, 'session'), interval), num(inp, 'rows'), num(inp, 'vaPct'), 60)
      return { __x: { profiles: ps.map((p) => ({ p, anchor: 'left' as const, width: num(inp, 'width') / 100, ...VP_COLORS })) } }
    },
  },
  {
    id: 'tpo', abbr: 'TPO', group: 'volume', overlay: true, noTf: true,
    inputs: [{ key: 'session', kind: 'select', def: 'day', options: ['day', 'week'] },
      { key: 'period', kind: 'select', def: 'p30', options: ['p30', 'p60', 'p240'] },
      { key: 'rows', kind: 'int', def: 24, min: 4, max: 120 }, { key: 'vaPct', kind: 'int', def: 70, min: 10, max: 100 },
      { key: 'letters', kind: 'bool', def: true }, { key: 'ib', kind: 'bool', def: true }],
    plots: [],
    fills: [fill('tpo', '#8fa3b8', 55, 'tpo'), fill('va', '#5b9cf6', 90, 'tpoVa'), fill('poc', '#ff5252', 100, 'poc'), fill('ibar', '#f5a623', 90, 'ib')],
    title: (inp) => `${inp.session} ${String(inp.period).slice(1)}m`,
    compute: ({ bars, interval }, inp) => {
      const p = parseInterval(interval)
      // 只在分钟图上（TPO 时段不能比 K 线短）/ minute charts only (a TPO period can't be shorter than a bar)
      if (!p || p.unit !== 'min') return NONE
      const periodMin = Math.max(Number(str(inp, 'period').slice(1)) || 30, p.n)
      const ts = tpoProfiles(bars, periodKeyOf(str(inp, 'session'), interval), periodMin * 60, num(inp, 'rows'), num(inp, 'vaPct'), 12)
      return { __x: { tpos: ts.map((t) => ({ t, color: 'f:tpo', vaColor: 'f:va', poc: 'f:poc', ib: inp.ib === true ? 'f:ibar' : null, letters: inp.letters === true })) } }
    },
  },

  // ── 形态 / patterns ──
  {
    id: 'cpatterns', abbr: 'Candles', group: 'patterns', overlay: true, noTf: true,
    inputs: [{ key: 'trend', kind: 'select', def: 'sma50', options: ['sma50', 'none'] },
      { key: 'bull', kind: 'bool', def: true }, { key: 'bear', kind: 'bool', def: true }, { key: 'neutral', kind: 'bool', def: false },
      { key: 'strongOnly', kind: 'bool', def: true }, { key: 'showText', kind: 'bool', def: true }],
    plots: [],
    title: () => '',
    compute: ({ bars }, inp) => {
      const pats = candlePatterns(bars, str(inp, 'trend') === 'none' ? 'none' : 'sma50', { bull: inp.bull === true, bear: inp.bear === true, neutral: inp.neutral === true })
      // 同一根只标最强的一个（多根形态优先）/ one mark per bar, multi-bar patterns first
      const byBar = new Map<number, (typeof pats)[number]>()
      const rank = (k: string) => (['morningStar', 'eveningStar', 'soldiers', 'crows'].includes(k) ? 3 : ['engulfBull', 'engulfBear', 'haramiBull', 'haramiBear', 'piercing', 'darkCloud', 'tweezerTop', 'tweezerBottom'].includes(k) ? 2 : 1)
      const minRank = inp.strongOnly === false ? 1 : 2
      for (const p of pats) {
        if (rank(p.key) < minRank) continue
        const cur = byBar.get(p.i); if (!cur || rank(p.key) > rank(cur.key)) byBar.set(p.i, p)
      }
      const kept = [...byBar.values()].sort((a, b) => a.i - b.i).slice(-400)
      // 名字只写在最近的 15 个上，其余只画箭头，免得满屏字 / names only on the latest 15, arrows elsewhere
      const textFrom = kept.length - 15
      const markers: IndMarker[] = kept.map((p, k) => ({
        i: p.i,
        shape: p.dir > 0 ? 'arrowUp' : p.dir < 0 ? 'arrowDown' : 'circle',
        position: p.dir > 0 ? 'belowBar' : 'aboveBar',
        color: p.dir > 0 ? BULL : p.dir < 0 ? BEAR : NEUTRAL,
        text: inp.showText === true && k >= textFrom ? `mk.cp_${p.key}` : undefined,
      }))
      return { __x: { markers } }
    },
  },
  {
    id: 'autopatterns', abbr: 'Auto Patterns', group: 'patterns', overlay: true, noTf: true,
    inputs: [{ key: 'dev', kind: 'float', def: 0, min: 0, max: 50, step: 0.1 }, { key: 'depth', kind: 'int', def: 10, min: 2, max: 100 },
      { key: 'tol', kind: 'int', def: 15, min: 1, max: 50 }, { key: 'maxCount', kind: 'int', def: 4, min: 1, max: 20 }],
    plots: [],
    title: (inp) => (num(inp, 'dev') > 0 ? `${inp.dev}% ${inp.depth}` : `${inp.depth}`),
    compute: ({ bars }, inp) => {
      const pats = chartPatterns(bars, autoDev(bars, num(inp, 'dev')), num(inp, 'depth'), num(inp, 'tol'), num(inp, 'maxCount'))
      const segs: NonNullable<IndExtras['segs']> = []
      const labels: NonNullable<IndExtras['labels']> = []
      for (const p of pats) {
        const c = dirColor(p.dir)
        for (let k = 0; k + 1 < p.pts.length; k++) segs.push({ i1: p.pts[k].i, p1: p.pts[k].v, i2: p.pts[k + 1].i, p2: p.pts[k + 1].v, color: c, width: 2 })
        for (const l of p.lines) segs.push({ i1: l.i1, p1: l.v1, i2: l.i2, p2: l.v2, color: c, dash: 'dashed' })
        // 看跌标在最高点上方，看涨标在最低点下方 / bearish above the highest point, bullish below the lowest
        const lab = p.dir > 0 ? p.pts.reduce((a, b) => (b.v < a.v ? b : a)) : p.pts.reduce((a, b) => (b.v > a.v ? b : a))
        labels.push({ i: lab.i, p: lab.v, text: `mk.ch_${p.key}`, color: '#ffffff', bg: rgba(c, 0.85), pos: p.dir > 0 ? 'below' : 'above' })
      }
      return { __x: { segs, labels } }
    },
  },
  {
    id: 'autofib', abbr: 'Auto Fib', group: 'patterns', overlay: true, noTf: true,
    inputs: [{ key: 'dev', kind: 'float', def: 0, min: 0, max: 50, step: 0.1 }, { key: 'depth', kind: 'int', def: 10, min: 2, max: 100 },
      { key: 'extend', kind: 'bool', def: true }, { key: 'reverse', kind: 'bool', def: false }, { key: 'ext', kind: 'bool', def: false },
      { key: 'bgFill', kind: 'bool', def: true }],
    plots: [],
    title: (inp) => (num(inp, 'dev') > 0 ? `${inp.dev}% ${inp.depth}` : `${inp.depth}`),
    compute: ({ bars, digits }, inp) => {
      const s = lastSwing(bars, autoDev(bars, num(inp, 'dev')), num(inp, 'depth'))
      if (!s) return NONE
      // 斐波那契回撤：0 在最新拐点、1 在前一个（反转则对调）/ retracement: 0 at the latest pivot, 1 at the one before (reverse swaps)
      const [from, to] = inp.reverse === true ? [s.v2, s.v1] : [s.v1, s.v2]
      const lv = inp.ext === true ? [...FIB_LEVELS, ...FIB_EXT] : FIB_LEVELS
      const right = inp.extend === true ? -1 : bars.length - 1
      const price = (l: number) => to + (from - to) * l
      const x: IndExtras = { segs: [], labels: [], rects: [] }
      x.segs!.push({ i1: s.i1, p1: s.v1, i2: s.i2, p2: s.v2, color: '#787b86', dash: 'dashed' })
      lv.forEach(([l, c], k) => {
        const p = price(l)
        x.segs!.push({ i1: s.i1, p1: p, i2: right, p2: p, color: c })
        x.labels!.push({ i: s.i1, p, text: `${l} (${fmt(p, digits)})`, color: c, align: 'right' })
        if (inp.bgFill === true && k + 1 < lv.length) {
          const q = price(lv[k + 1][0])
          x.rects!.push({ i1: s.i1, i2: right, top: Math.max(p, q), bottom: Math.min(p, q), fill: rgba(lv[k + 1][1], 0.08), back: true })
        }
      })
      return { __x: x }
    },
  },

  // ── 价位 / levels ──
  {
    id: 'mtfbox', abbr: 'HTF Boxes', group: 'levels', overlay: true, noTf: true,
    inputs: [{ key: 'tf', kind: 'select', def: 'auto', options: ['auto', 'h1', 'h4', 'd1', 'w1', 'mn1'] }, { key: 'wick', kind: 'bool', def: true }],
    plots: [],
    fills: [fill('up', 'up', 14, 'boxUp'), fill('dn', 'down', 14, 'boxDown'), fill('border', '#787b86', 60, 'boxBorder')],
    title: (inp) => String(inp.tf),
    compute: ({ bars, interval }, inp) => {
      const p = parseInterval(interval)
      if (!p) return NONE
      const CODES: Record<string, string> = { h1: '60', h4: '240', d1: 'D', w1: 'W', mn1: 'M' }
      let code = CODES[str(inp, 'tf')]
      if (!code) code = p.unit === 'min' ? (p.n <= 5 ? '60' : p.n <= 30 ? '240' : 'D') : p.unit === 'D' ? 'W' : 'M'
      if (barSeconds(code) <= barSeconds(interval)) return NONE
      const key = tfKeyFn(code)
      if (!key) return NONE
      const boxes = htfBoxes(bars, key, 300)
      const rects: NonNullable<IndExtras['rects']> = []
      for (const b of boxes) {
        const up = b.c >= b.o
        if (inp.wick === true) rects.push({ i1: b.i1, i2: b.i2, top: b.h, bottom: b.l, stroke: 'f:border', dash: 'dotted', back: true })
        rects.push({ i1: b.i1, i2: b.i2, top: Math.max(b.o, b.c), bottom: Math.min(b.o, b.c), fill: up ? 'f:up' : 'f:dn', back: true })
      }
      return { __x: { rects } }
    },
  },
  {
    id: 'hl52', abbr: '52W H/L', group: 'levels', overlay: true, noTf: true,
    inputs: [],
    plots: [line('hi', '#089981', 'hi52', { kind: 'step', dash: 'dashed' }), line('lo', '#f23645', 'lo52', { kind: 'step', dash: 'dashed' })],
    digits: 'price',
    title: () => '',
    compute: (ctx) => {
      const p = parseInterval(ctx.interval)
      const daily = p && p.unit === 'D' && p.n === 1 ? null : dailyOf(ctx)
      const r = highLow52(ctx.bars, daily, brokerDay, 365)
      return { hi: r.hi, lo: r.lo }
    },
  },

  // ── 统计与对比 / stats & comparison ──
  {
    id: 'perf', abbr: 'Performance', group: 'stats', overlay: true, noTf: true,
    inputs: [{ key: 'pos', kind: 'select', def: 'tr', options: ['tr', 'br', 'tl', 'bl'] }],
    plots: [],
    title: () => '',
    compute: (ctx, inp) => {
      const n = ctx.bars.length
      if (n === 0) return NONE
      const daily = dailyOf(ctx)
      const pos = str(inp, 'pos') as 'tr'
      if (!daily || daily.length === 0) return { __x: { table: { pos, rows: PERF_KEYS.map((k) => ({ k: `mk.perf_${k}`, v: '…' })) } } }
      const last = ctx.bars[n - 1]
      const r = performance(daily, last.c, last.t, brokerYear)
      return {
        __x: {
          table: {
            pos,
            rows: PERF_KEYS.map((k) => {
              const v = r[k]
              return { k: `mk.perf_${k}`, v: v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`, color: v == null ? undefined : v >= 0 ? 'up' : 'down' }
            }),
          },
        },
      }
    },
  },
  {
    id: 'techrating', abbr: 'Tech Rating', group: 'stats', overlay: false,
    inputs: [{ key: 'basis', kind: 'select', def: 'all', options: ['all', 'maOnly', 'oscOnly'] }, { key: 'gauge', kind: 'bool', def: true }],
    plots: [{ key: 'rating', kind: 'columns', color: '#787b86', colors: RATING_COLORS, label: 'rating' }],
    hlines: [hl('p5', 0.5, '0.5'), hl('z', 0, '0'), hl('n5', -0.5, '-0.5')],
    digits: 2,
    title: (inp) => String(inp.basis),
    compute: ({ bars }, inp) => {
      const r = techRating(bars)
      const v = str(inp, 'basis') === 'maOnly' ? r.ma : str(inp, 'basis') === 'oscOnly' ? r.osc : r.all
      const idx = v.map(ratingBand)
      const last = v.length ? v[v.length - 1] : null
      const band = ratingBand(last)
      return {
        rating: v,
        'rating#c': idx,
        __x: inp.gauge === true ? { gauge: { value: last, text: band == null ? '—' : `mk.${RATING_TEXT[band]}`, color: band == null ? NEUTRAL : RATING_COLORS[band] } } : {},
      }
    },
  },
  {
    id: 'corr', abbr: 'CC', group: 'stats', overlay: false, noTf: true,
    inputs: [{ key: 'sym', kind: 'symbol', def: 'EURUSD' }, { key: 'len', kind: 'int', def: 20, min: 2, max: 500 }],
    plots: [line('corr', '#2962ff', 'corr', { width: 2 })],
    hlines: [hl('p5', 0.5, '0.5'), hl('z', 0, '0'), hl('n5', -0.5, '-0.5')],
    digits: 3,
    compute: (ctx, inp) => ({ corr: correlation(ctx.bars.map((b) => b.c), otherAligned(ctx, str(inp, 'sym')), num(inp, 'len')) }),
  },
  {
    id: 'spread', abbr: 'Spread', group: 'stats', overlay: false, noTf: true,
    inputs: [{ key: 'sym', kind: 'symbol', def: 'EURUSD' }, { key: 'mode', kind: 'select', def: 'ratio', options: ['ratio', 'diff'] },
      { key: 'mult', kind: 'float', def: 1, min: -1000, max: 1000, step: 0.1 }],
    plots: [line('spread', '#e879f9', 'spread', { width: 2 })],
    digits: 4,
    title: (inp) => `${inp.sym} ${inp.mode}`,
    compute: (ctx, inp) => {
      const o = otherAligned(ctx, str(inp, 'sym'))
      const m = num(inp, 'mult')
      const ratio = str(inp, 'mode') === 'ratio'
      return {
        spread: ctx.bars.map((b, i) => {
          const y = o[i]
          if (y == null) return null
          if (ratio) return y !== 0 ? (b.c / y) * m : null
          return b.c - y * m
        }),
      }
    },
  },
]
