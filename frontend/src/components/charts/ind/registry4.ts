// 指标注册表第四批（2 种，照用户给的 Pine 脚本移植）：
// · PVP-R 周期成交量分布：按日 / 周 / 月（或 1 / 4 小时）切开，每段一个分布；上涨/下跌、总量、差值三种画法；
//   有小周期 K 线时用它把量落到真正成交的价位上（规则同原脚本），旧的、小周期够不着的周期退回图上 K 线。
// · CRP 标准差投影：大周期开盘价 ± k·σ（σ = 前 N 根大周期 (收−开)/开 的标准差 × 本期开盘价），
//   「大周期 K 线」模式在最新 K 线右边画一组投影 K 线并把价位投到上面；「传统线」模式按周期画水平线。
// Indicator registry batch 4 (two kinds, ported from the user's Pine scripts):
// · PVP-R periodic volume profile: one profile per day / week / month (or 1h / 4h) with up/down,
//   total or delta histograms; lower-timeframe bars place the volume where it traded (the script's
//   rule), and older periods the lower timeframe can't reach fall back to chart bars.
// · CRP σ projection: the HTF open ± k·σ (σ = stdev of the previous N HTF bars' (close − open) / open,
//   times this period's open). "HTF candles" mode draws a panel of projected candles right of the
//   newest bar with the levels projected onto it; "legacy lines" draws horizontal lines per period.
import type { Candle } from '../../../api/types'
import { parseInterval } from '../intervals'
import { crpLevels, crpSigma, periodEnd, periodRanges, pvpLtfLadder, pvpProfile, toUnits, type VolMode } from './math4'
import { barSeconds, tfKeyFn } from './periods'
import type { CompOut, FillDef, IndDef, IndExtras, Inputs, InputDef, PlotDef } from './types'

const num = (inp: Inputs, k: string) => Number(inp[k])
const str = (inp: Inputs, k: string) => String(inp[k])
const NONE: CompOut = {}
const fill = (key: string, color: string, opacity: number, label = key): FillDef => ({ key, a: '', b: '', color, opacity, label })
const shapeLine = (key: string, color: string, label: string, width: number, dash: PlotDef['dash']): PlotDef =>
  ({ key, kind: 'line', color, label, width, dash, shape: true, noLegend: true })

// 周期选项 → 周期代码 / period option → interval code
const TF_CODES: Record<string, string> = { h1: '60', h4: '240', d1: 'D', w1: 'W', mn1: 'M' }
const TF_TEXT: Record<string, string> = { h1: '1H', h4: '4H', d1: '1D', w1: '1W', mn1: '1M' }
// 小周期最多取多少根（与画线的成交量分布同一上限：三页 /chart/history）
// Most lower-timeframe bars to load (the same cap as the drawing tools' volume profiles: three /chart/history pages)
const LTF_MAX = 3000
const PERIODS = 60
// 文字字号 / label font sizes
const SIZES: Record<string, number> = { tiny: 9, small: 11, normal: 13, large: 16, huge: 20 }

// ── PVP-R ──
function pvpr(ctx: Parameters<IndDef['compute']>[0], inp: Inputs): CompOut {
  const { bars, interval, digits } = ctx
  const n = bars.length
  if (n === 0) return NONE
  const key = tfKeyFn(TF_CODES[str(inp, 'period')] ?? 'D')
  if (!key) return NONE
  let ranges = periodRanges(bars, key).slice(-PERIODS)
  // 最后一段是还没走完的周期 / the last range is the period still in progress
  if (inp.hideLive === true) ranges = ranges.slice(0, -1)
  if (ranges.length === 0) return NONE
  const chartSec = barSeconds(interval)
  // 小周期：从规则给的那一级起，挑第一级能盖住至少最新一个周期的；起点取它够得着的最早周期开头
  // Lower timeframe: from the rule's level up, the first that covers at least the newest period; start at the earliest period it reaches
  let ltf: Candle[] | null = null
  let ltfFrom = Infinity
  if (ctx.intrabar && ctx.symbol) {
    const now = Date.now() / 1000
    for (const { code, sec } of pvpLtfLadder(chartSec)) {
      const fit = ranges.find(([s]) => (now + chartSec - bars[s].t) / sec <= LTF_MAX)
      if (!fit) continue
      ltfFrom = bars[fit[0]].t
      ltf = ctx.intrabar(code, ltfFrom, `pvpr|${code}|${ltfFrom}`)
      break
    }
  }
  const mode = str(inp, 'volMode') as VolMode
  const opt = { mode, vaPct: num(inp, 'vaPct'), layout: (str(inp, 'rowLayout') === 'ticks' ? 'ticks' : 'rows') as 'rows' | 'ticks', rowSize: num(inp, 'rowSize'), tick: 10 ** -Math.max(0, Math.min(10, digits)) }
  const prev = { c: null as number | null }
  let k = 0
  const profiles: NonNullable<IndExtras['profiles']> = []
  for (const [s, e] of ranges) {
    let hi = -Infinity
    let lo = Infinity
    for (let i = s; i <= e; i++) { if (bars[i].h > hi) hi = bars[i].h; if (bars[i].l < lo) lo = bars[i].l }
    let src: Candle[] = []
    if (ltf && bars[s].t >= ltfFrom) {
      const pk = key(bars[s].t)
      while (k < ltf.length && ltf[k].t < bars[s].t) k++
      for (let j = k; j < ltf.length && key(ltf[j].t) === pk; j++) src.push(ltf[j])
    }
    if (src.length === 0) src = bars.slice(s, e + 1)
    const p = pvpProfile(toUnits(src, prev), hi, lo, { ...opt, i1: s, i2: e })
    profiles.push({
      p, anchor: str(inp, 'placement') === 'right' ? 'right' : 'left', width: num(inp, 'width') / 100,
      up: 'f:up', dn: 'f:dn', vaUp: 'f:vaUp', vaDn: 'f:vaDn', poc: 'f:poc', vah: 'f:vah', val: 'f:val', box: 'f:box',
      mode, hist: inp.showVP !== false,
      ext: { poc: inp.extPoc === true, vah: inp.extVah === true, val: inp.extVal === true },
    })
  }
  return { __x: { profiles } }
}

// ── CRP ──
interface Period { o: number; h: number; l: number; c: number; s: number | null; b: number }

function crp(ctx: Parameters<IndDef['compute']>[0], inp: Inputs): CompOut {
  const { bars, interval, digits, symbol } = ctx
  const n = bars.length
  if (n === 0) return NONE
  const tfOpt = str(inp, 'tf')
  const code = TF_CODES[tfOpt] ?? 'D'
  const key = tfKeyFn(code)
  if (!key || barSeconds(code) < barSeconds(interval)) return NONE
  const pI = parseInterval(interval)
  const pC = parseInterval(code)
  const same = !!pI && !!pC && pI.unit === pC.unit && pI.n === pC.n
  const htf = same ? bars : symbol && ctx.other ? ctx.other(symbol, code) : null
  const sigScale = num(inp, 'sigScale')
  // 大周期每根的开盘价与 σ，按周期键查 / HTF open and σ per bar, looked up by period key
  const htfAt = new Map<number, { o: number; s: number | null }>()
  if (htf) {
    const sig = crpSigma(htf, Math.max(2, num(inp, 'lookback')))
    htf.forEach((b, j) => htfAt.set(key(b.t), { o: b.o, s: sig[j] == null ? null : sig[j]! * sigScale }))
  }
  const ps: Period[] = periodRanges(bars, key).slice(-PERIODS).map(([s, e]) => {
    let h = -Infinity
    let l = Infinity
    for (let i = s; i <= e; i++) { if (bars[i].h > h) h = bars[i].h; if (bars[i].l < l) l = bars[i].l }
    const x = htfAt.get(key(bars[s].t))
    return { o: x?.o ?? bars[s].o, h, l, c: bars[e].c, s: x?.s ?? null, b: s }
  })
  const np = ps.length
  if (np === 0) return NONE
  const lv = crpLevels(Array.from({ length: 9 }, (_, j) => ({ on: inp[`lvOn${j + 1}`] === true, k: num(inp, `lvK${j + 1}`) })), inp.mirror === true)
  const cur = ps[np - 1]
  const pre = code === 'D' ? 'DCRP' : code === 'W' ? 'WCRP' : code === 'M' ? 'MCRP' : `${TF_TEXT[tfOpt] ?? code}CRP`
  const fmtK = (k: number) => String(Number(k.toFixed(4)))
  const dg = Math.max(0, Math.min(8, digits))
  const showMult = inp.showMult === true
  const showPx = inp.showPx === true
  const text = (k: number, p: number) => (showMult ? `${pre} ${fmtK(k)}` : '') + (showPx ? `${showMult ? '  ' : ''}${p.toFixed(dg)}` : '')
  const vis = str(inp, 'visMode')
  const lblSize = SIZES[str(inp, 'lblSize')] ?? 11

  const x: Required<Pick<IndExtras, 'rects' | 'segs' | 'labels'>> = { rects: [], segs: [], labels: [] }
  // 第一次碰到各价位的 K 线（只看本期）/ first bar touching each level (this period only)
  const taps: (number | null)[] = lv.map(({ k }) => {
    if (cur.s == null) return null
    const p = cur.o + k * cur.s
    for (let i = cur.b; i < n; i++) if (bars[i].h >= p && bars[i].l <= p) return i
    return null
  })
  // xStart：开盘那根；xPanel：面板左边；xs：各级第一次触碰（null = 没碰到，只画在面板里）
  // xStart: the opening bar; xPanel: the panel's left edge; xs: first touches (null = untouched, panel only)
  const drawLevels = (o: number, s: number | null, xStart: number, xPanel: number, x2: number, uni: boolean, lbl: boolean, xs: (number | null)[] | null) => {
    if (s == null || lv.length === 0) return
    const starts: number[] = []
    lv.forEach(({ k, j }, i) => {
      const p = o + k * s
      const xa = k === 0 || !xs ? xStart : xs[i] ?? xPanel
      starts.push(xa)
      const c = uni ? 'p:uni' : `p:l${j + 1}`
      if (vis !== 'vFills') x.segs.push({ i1: xa, p1: p, i2: x2, p2: p, color: c })
      if (lbl && (showMult || showPx)) x.labels.push({ i: x2, p, text: text(k, p), color: j === 0 ? 'p:l1' : c, align: 'left', size: lblSize })
    })
    if (vis !== 'vLines') {
      for (let i = 0; i + 1 < lv.length; i++) {
        const bi = Math.min(lv[i].j, lv[i + 1].j, 7)
        const a = o + lv[i].k * s
        const b = o + lv[i + 1].k * s
        x.rects.push({ i1: Math.max(starts[i], starts[i + 1]), i2: x2, top: Math.max(a, b), bottom: Math.min(a, b), fill: `f:b${bi + 1}`, back: true, ctr: true })
      }
    }
  }

  const last = n - 1
  if (str(inp, 'crpMode') === 'legacy') {
    const offBars = Math.round((num(inp, 'offMin') * 60) / barSeconds(interval))
    for (let p = Math.max(0, np - num(inp, 'histModels')); p < np; p++) {
      const x1 = ps[p].b + offBars
      const x2 = p === np - 1 ? last + num(inp, 'pad') : ps[p + 1].b - 1
      drawLevels(ps[p].o, ps[p].s, x1, x1, x2, false, p === np - 1, null)
    }
    return { __x: x }
  }

  // 大周期 K 线面板 / the HTF candle panel
  const cw = Math.max(1, num(inp, 'candleW'))
  const step = 2 * cw + 1 + Math.max(0, num(inp, 'spacing'))
  const base = last + num(inp, 'dist')
  const first = Math.max(0, np - num(inp, 'nCandles'))
  const cnt = np - first
  const uni = str(inp, 'lvlStyle') !== 'perLevel'
  let top = -Infinity
  let bot = Infinity
  for (let i = 0; i < cnt; i++) {
    const p = ps[first + i]
    const cx = base + cw + i * step
    const up = p.c >= p.o
    const hiB = Math.max(p.o, p.c)
    const loB = Math.min(p.o, p.c)
    x.rects.push({ i1: cx - cw, i2: cx + cw, top: hiB, bottom: loB, fill: up ? (inp.hollow === true ? undefined : 'f:bodyUp') : 'f:bodyDn', stroke: up ? 'f:brdUp' : 'f:brdDn', ctr: true })
    x.segs.push({ i1: cx, p1: p.h, i2: cx, p2: hiB, color: up ? 'f:wkUp' : 'f:wkDn' })
    x.segs.push({ i1: cx, p1: loB, i2: cx, p2: p.l, color: up ? 'f:wkUp' : 'f:wkDn' })
    top = Math.max(top, p.h)
    bot = Math.min(bot, p.l)
    if (inp.project === true && str(inp, 'applyTo') === 'all' && first + i < np - 1) drawLevels(p.o, p.s, cx - cw, cx - cw, cx + cw, uni, false, null)
  }
  const lastCx = base + cw + (cnt - 1) * step
  if (inp.project === true) {
    const anchor = str(inp, 'leftAnchor')
    const xPanel = lastCx - cw
    const xStart = anchor === 'panel' ? xPanel : cur.b
    drawLevels(cur.o, cur.s, xStart, xPanel, lastCx + cw + num(inp, 'rExt'), uni, true, anchor === 'tap' ? taps : null)
  }
  if (inp.tfLabel === true) {
    const above = str(inp, 'tlPos') !== 'below'
    x.labels.push({
      i: base + (cnt * step) / 2, p: above ? top : bot, text: TF_TEXT[tfOpt] ?? code, color: 'f:tl', align: 'center', pos: above ? 'above' : 'below',
      size: SIZES[str(inp, 'tlSize')] ?? 16, cd: inp.countdown === true ? periodEnd(code, bars[last].t) ?? undefined : undefined,
    })
  }
  return { __x: x }
}

// CRP 九级的默认值（倍数、启用、颜色、线宽、线型）/ CRP's nine level defaults (multiple, on, colour, width, dash)
const CRP_LV: [number, boolean, string, number, PlotDef['dash']][] = [
  [0, true, '#ff9800', 1, 'solid'], [0.5, true, '#434651', 1, 'dotted'], [1, true, '#434651', 2, 'solid'], [1.5, true, '#434651', 1, 'dotted'],
  [2, true, '#434651', 2, 'solid'], [2.5, false, '#434651', 1, 'dotted'], [3, false, '#434651', 2, 'solid'], [3.5, false, '#434651', 1, 'dotted'],
  [4, false, '#434651', 2, 'solid'],
]
const TF_OPTS = ['h1', 'h4', 'd1', 'w1', 'mn1']

export const DEFS4: IndDef[] = [
  {
    id: 'pvpr', abbr: 'PVP', group: 'volume', overlay: true, noTf: true,
    inputs: [
      { key: 'period', kind: 'select', def: 'd1', options: TF_OPTS },
      { key: 'volMode', kind: 'select', def: 'delta', options: ['updown', 'total', 'delta'] },
      { key: 'vaPct', kind: 'int', def: 70, min: 1, max: 100 },
      { key: 'rowLayout', kind: 'select', def: 'rows', options: ['rows', 'ticks'] },
      { key: 'rowSize', kind: 'int', def: 24, min: 1, max: 400 },
      { key: 'extPoc', kind: 'bool', def: false }, { key: 'extVah', kind: 'bool', def: false }, { key: 'extVal', kind: 'bool', def: false },
      { key: 'hideLive', kind: 'bool', def: false },
      { key: 'showVP', kind: 'bool', def: true },
      { key: 'width', kind: 'int', def: 50, min: 1, max: 100 },
      { key: 'placement', kind: 'select', def: 'left', options: ['left', 'right'] },
    ],
    plots: [],
    fills: [
      fill('up', '#26a69a', 20, 'upVol'), fill('dn', '#ab47bc', 20, 'downVol'),
      fill('vaUp', '#26a69a', 40, 'vaUp'), fill('vaDn', '#ab47bc', 40, 'vaDown'),
      fill('vah', '#787b86', 100, 'vah'), fill('val', '#787b86', 100, 'val'), fill('poc', '#f23645', 100, 'poc'),
      fill('box', '#000000', 0, 'boxBg'),
    ],
    title: (inp) => `${TF_TEXT[str(inp, 'period')] ?? ''} ${inp.rowSize}`,
    compute: pvpr,
  },
  {
    id: 'crp', abbr: 'CRP', group: 'levels', overlay: true, noTf: true,
    inputs: [
      { key: 'crpMode', kind: 'select', def: 'htfCandles', options: ['htfCandles', 'legacy'] },
      { key: 'tf', kind: 'select', def: 'd1', options: TF_OPTS },
      { key: 'lookback', kind: 'int', def: 90, min: 5, max: 500 },
      { key: 'sigScale', kind: 'float', def: 1, min: 0.01, max: 10, step: 0.01 },
      { key: 'histModels', kind: 'int', def: 1, min: 1, max: 20 },
      { key: 'mirror', kind: 'bool', def: true },
      ...CRP_LV.flatMap(([k, on], j): InputDef[] => [
        { key: `lvOn${j + 1}`, kind: 'bool', def: on },
        { key: `lvK${j + 1}`, kind: 'float', def: k, min: -100, max: 100, step: 0.1 },
      ]),
      { key: 'showMult', kind: 'bool', def: true }, { key: 'showPx', kind: 'bool', def: true },
      { key: 'lblSize', kind: 'select', def: 'small', options: ['tiny', 'small', 'normal', 'large'] },
      { key: 'visMode', kind: 'select', def: 'vLines', options: ['vLines', 'vFills', 'vBoth'] },
      { key: 'offMin', kind: 'int', def: 0, min: -10000, max: 10000 },
      { key: 'pad', kind: 'int', def: 1, min: 0, max: 500 },
      { key: 'nCandles', kind: 'int', def: 4, min: 1, max: 10 },
      { key: 'dist', kind: 'int', def: 20, min: 0, max: 500 },
      { key: 'spacing', kind: 'int', def: 1, min: 0, max: 50 },
      { key: 'candleW', kind: 'int', def: 1, min: 1, max: 20 },
      { key: 'hollow', kind: 'bool', def: false },
      { key: 'tfLabel', kind: 'bool', def: true },
      { key: 'tlSize', kind: 'select', def: 'large', options: ['tiny', 'small', 'normal', 'large', 'huge'] },
      { key: 'tlPos', kind: 'select', def: 'above', options: ['above', 'below'] },
      { key: 'countdown', kind: 'bool', def: true },
      { key: 'project', kind: 'bool', def: true },
      { key: 'leftAnchor', kind: 'select', def: 'tap', options: ['tap', 'start', 'panel'] },
      { key: 'applyTo', kind: 'select', def: 'latest', options: ['latest', 'all'] },
      { key: 'rExt', kind: 'int', def: 3, min: 0, max: 200 },
      { key: 'lvlStyle', kind: 'select', def: 'uniform', options: ['uniform', 'perLevel'] },
    ],
    plots: [
      ...CRP_LV.map(([, , c, w, d], j) => shapeLine(`l${j + 1}`, c, `lv${j + 1}`, w, d)),
      shapeLine('uni', '#787b86', 'uniform', 1, 'dotted'),
    ],
    fills: [
      ...Array.from({ length: 8 }, (_, j) => fill(`b${j + 1}`, '#787b86', 15, `lvBand${j + 1}`)),
      fill('bodyUp', '#ffffff', 100, 'bodyUp'), fill('bodyDn', '#000000', 100, 'bodyDn'),
      fill('brdUp', '#ffffff', 100, 'borderUp'), fill('brdDn', '#ffffff', 100, 'borderDn'),
      fill('wkUp', '#ffffff', 100, 'wickUp'), fill('wkDn', '#ffffff', 100, 'wickDn'),
      fill('tl', '#ffffff', 100, 'tfLabel'),
    ],
    title: (inp) => `${TF_TEXT[str(inp, 'tf')] ?? ''} ${inp.lookback}`,
    compute: crp,
  },
]
