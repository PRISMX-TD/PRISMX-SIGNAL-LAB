// 图表警报（阶段 5）的前端模型：条件清单、画线 → 警报几何、支持警报的指标、默认消息。
// 求值在服务端（backend/app/services/chart_alerts），这里只负责把用户在图上点选的东西翻成
// 服务端认的 spec，以及把 spec 翻回人话。
// Chart alerts (phase 5) client model: condition lists, drawing → alert geometry, which
// indicators support alerts, default messages. Evaluation runs on the server
// (backend/app/services/chart_alerts); this only turns what the user picked into the spec the
// server accepts, and specs back into words.
import type { ChartAlert, ChartAlertCond, ChartAlertIn, ChartAlertKind, ChartAlertTrigger } from '../../../api/types'
import type { Drawing, Point } from '../draw/model'
import { levelsOf } from '../draw/model'
import { minuteSource, parseInterval } from '../intervals'
import type { IndInstance } from '../ind/types'

type T = (k: string, o?: Record<string, unknown>) => unknown

// 服务端存 K 线的周期（指标 / 收盘类警报只能挂在这些上）/ intervals the server keeps bars for
export const SERVER_INTERVALS = ['1', '5', '15', '60', '240', 'D'] as const
export type ServerInterval = typeof SERVER_INTERVALS[number]
// 图表周期 → 最接近的服务端周期（30 分钟 → 15，2 小时 → 60，日以上 → 日）
// The chart interval → the nearest server interval (30m → 15, 2h → 60, daily and above → D)
export function serverIntervalOf(chartInterval: string): ServerInterval {
  const p = parseInterval(chartInterval)
  if (!p) return '15'
  if (p.unit !== 'min') return 'D'
  return String(minuteSource(p.n)) as ServerInterval
}

export const CONDS_LINE: ChartAlertCond[] = ['cross', 'crossUp', 'crossDown', 'gt', 'lt']
export const CONDS_BAND: ChartAlertCond[] = ['enter', 'exit', 'inside', 'outside']
export const CONDS_MOVE: ChartAlertCond[] = ['moveUp', 'moveDown', 'moveUpPct', 'moveDownPct']
export const isMove = (c: ChartAlertCond) => CONDS_MOVE.includes(c)
export const isBand = (c: ChartAlertCond) => CONDS_BAND.includes(c)
export const isLine = (c: ChartAlertCond) => CONDS_LINE.includes(c)

// 收盘才算的：指标警报、按幅度移动、或用户选了「每次收盘」/ evaluated at bar close
export const closeBased = (kind: ChartAlertKind, cond: ChartAlertCond) => kind === 'indicator' || isMove(cond)
export function triggersFor(kind: ChartAlertKind, cond: ChartAlertCond): ChartAlertTrigger[] {
  return closeBased(kind, cond) ? ['once', 'close'] : ['once', 'bar', 'close']
}
// 每个用户最多多少条（与后端 ALERTS_MAX 一致）/ per-user cap (same as the backend's ALERTS_MAX)
export const ALERTS_MAX = 300

// ───────── 指标 / indicators ─────────
// 与 backend/app/services/chart_alerts/ind.py 的 DEFS 一致：类型 → 线
// Mirrors DEFS in backend/app/services/chart_alerts/ind.py: kind → plots
export const ALERT_INDS: Record<string, string[]> = {
  sma: ['ma'], ema: ['ma'], wma: ['ma'], vwma: ['ma'], hma: ['ma'], dema: ['ma'], tema: ['ma'], smma: ['ma'], lsma: ['ma'],
  rsi: ['rsi'], stoch: ['k', 'd'], macd: ['macd', 'signal', 'hist'], bb: ['basis', 'upper', 'lower'], dc: ['basis', 'upper', 'lower'],
  atr: ['atr'], cci: ['cci'], willr: ['r'], mom: ['mom'], roc: ['roc'],
}
// 叠在主图、和价格同一个量纲的（可以拿来跟价格比）/ overlays on the price scale (comparable with price)
export const PRICE_SCALE_INDS = new Set(['sma', 'ema', 'wma', 'vwma', 'hma', 'dema', 'tema', 'smma', 'lsma', 'bb', 'dc'])
export const alertableInd = (i: IndInstance) => i.type in ALERT_INDS && !Object.values(i.inputs).some((v) => typeof v === 'string' && v.startsWith('ind:'))

// 服务端只认它那几种输入；多出来的（颜色之类）不送 / send only the inputs the server knows
const IND_INPUT_KEYS: Record<string, string[]> = {
  ma: ['len', 'src', 'offset'],
  rsi: ['len', 'src'], stoch: ['kLen', 'kSmooth', 'dLen'], macd: ['fast', 'slow', 'src', 'signal', 'oscMa', 'sigMa'],
  bb: ['len', 'maType', 'src', 'mult', 'offset'], dc: ['len', 'offset'], atr: ['len', 'smoothing'], cci: ['len', 'src'],
  willr: ['len'], mom: ['len', 'src'], roc: ['len', 'src'],
}
export function serverInputs(type: string, inputs: Record<string, unknown>): Record<string, unknown> {
  const keys = IND_INPUT_KEYS[ALERT_INDS[type]?.[0] === 'ma' ? 'ma' : type] ?? []
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in inputs) out[k] = inputs[k]
  return out
}

// ───────── 画线 / drawings ─────────
export interface AlertLine { t1: number; p1: number; t2: number; p2: number; extL: boolean; extR: boolean }
export interface DrawTarget {
  // 画线上的哪一部分（存进 spec.part，画线挪动后按它重算）/ which piece (spec.part; re-derived after moves)
  part: string
  // 文案键与参数 / label key and params
  label: string
  labelArgs?: Record<string, unknown>
  lines: AlertLine[]
  band: boolean
  win?: [number, number]
}

function lineExt(d: Drawing): [boolean, boolean] {
  if (d.type === 'ray') return [!!d.extendLeft, true]
  if (d.type === 'extended') return [true, true]
  return [!!d.extendLeft, !!d.extendRight]
}
// 两点 → 警报线；按时间排好，延长方向跟着点走 / two points → an alert line in time order
export function seg(a: Point, b: Point, extA: boolean, extB: boolean): AlertLine {
  return a.t <= b.t
    ? { t1: a.t, p1: a.p, t2: b.t, p2: b.p, extL: extA, extR: extB }
    : { t1: b.t, p1: b.p, t2: a.t, p2: a.p, extL: extB, extR: extA }
}
const flat = (t: number, p: number, extL = true, extR = true): AlertLine => ({ t1: t, p1: p, t2: t, p2: p, extL, extR })

const SINGLE_LINE = new Set(['trend', 'ray', 'extended', 'arrow', 'info', 'angle'])
export const ALERT_DRAW_TYPES = new Set([...SINGLE_LINE, 'hline', 'hray', 'priceLabel', 'channel', 'rect', 'priceRange', 'datePriceRange', 'fib', 'fibExt', 'long', 'short'])
export const drawingAlertable = (d: Drawing) => ALERT_DRAW_TYPES.has(d.type) && d.pts.length >= 1

// 一条画线能挂警报的各个部分 / the alertable pieces of one drawing
export function drawTargets(d: Drawing): DrawTarget[] {
  const P = d.pts
  if (!drawingAlertable(d)) return []
  if (SINGLE_LINE.has(d.type) && P.length >= 2) {
    const [l, r] = lineExt(d)
    return [{ part: 'line', label: 'charts.alert.part.line', lines: [seg(P[0], P[1], l, r)], band: false }]
  }
  switch (d.type) {
    case 'hline': case 'priceLabel':
      return [{ part: 'line', label: 'charts.alert.part.line', lines: [flat(P[0].t, P[0].p)], band: false }]
    case 'hray':
      return [{ part: 'line', label: 'charts.alert.part.line', lines: [flat(P[0].t, P[0].p, false, true)], band: false }]
    case 'channel': {
      if (P.length < 3) return []
      const dp = P[2].p - P[0].p
      const [l, r] = lineExt(d)
      const base = seg(P[0], P[1], l, r)
      const par = seg({ t: P[0].t, p: P[0].p + dp }, { t: P[1].t, p: P[1].p + dp }, l, r)
      const mid = seg({ t: P[0].t, p: P[0].p + dp / 2 }, { t: P[1].t, p: P[1].p + dp / 2 }, l, r)
      const [upper, lower] = dp >= 0 ? [par, base] : [base, par]
      return [
        { part: 'band', label: 'charts.alert.part.channel', lines: [upper, lower], band: true },
        { part: 'upper', label: 'charts.alert.part.upper', lines: [upper], band: false },
        { part: 'lower', label: 'charts.alert.part.lower', lines: [lower], band: false },
        { part: 'mid', label: 'charts.alert.part.mid', lines: [mid], band: false },
      ]
    }
    case 'rect': case 'priceRange': case 'datePriceRange': {
      if (P.length < 2) return []
      const t1 = Math.min(P[0].t, P[1].t), t2 = Math.max(P[0].t, P[1].t)
      const hi = Math.max(P[0].p, P[1].p), lo = Math.min(P[0].p, P[1].p)
      const l = !!d.extendLeft, r = !!d.extendRight
      const top: AlertLine = { t1, p1: hi, t2, p2: hi, extL: l, extR: r }
      const bot: AlertLine = { t1, p1: lo, t2, p2: lo, extL: l, extR: r }
      return [
        { part: 'band', label: 'charts.alert.part.box', lines: [top, bot], band: true },
        { part: 'upper', label: 'charts.alert.part.top', lines: [top], band: false },
        { part: 'lower', label: 'charts.alert.part.bottom', lines: [bot], band: false },
      ]
    }
    case 'fib': case 'fibExt': {
      const ext = d.type === 'fibExt'
      if (P.length < (ext ? 3 : 2)) return []
      const base = ext ? P[2].p : P[1].p
      const span = ext ? P[1].p - P[0].p : P[0].p - P[1].p
      const t0 = P[0].t
      return levelsOf(d).filter((lv) => lv.on).sort((a, b) => a.v - b.v).map((lv) => ({
        part: `lv:${lv.v}`, label: 'charts.alert.part.level', labelArgs: { v: lv.v }, lines: [flat(t0, base + span * lv.v)], band: false,
      }))
    }
    case 'long': case 'short':
      if (P.length < 3) return []
      return [
        { part: 'target', label: 'charts.alert.part.target', lines: [flat(P[1].t, P[1].p)], band: false },
        { part: 'stop', label: 'charts.alert.part.stop', lines: [flat(P[2].t, P[2].p)], band: false },
        { part: 'entry', label: 'charts.alert.part.entry', lines: [flat(P[0].t, P[0].p)], band: false },
      ]
  }
  return []
}

// 画线上的某部分 → 警报 spec 里的几何 / one piece → the spec's geometry
export function drawSpec(tg: DrawTarget): Record<string, unknown> {
  const s: Record<string, unknown> = { lines: tg.lines, part: tg.part }
  if (tg.win) s.win = tg.win
  return s
}
const round = (v: number) => Math.round(v * 1e8) / 1e8
export function sameGeometry(a: unknown, b: unknown): boolean {
  const norm = (x: unknown) => JSON.stringify(Array.isArray(x) ? x.map((l: AlertLine) => [round(l.t1), round(l.p1), round(l.t2), round(l.p2), !!l.extL, !!l.extR]) : null)
  return norm(a) === norm(b)
}

// ───────── 文案 / words ─────────
export function fmtNum(v: unknown, digits: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—'
}

// 指标名：「RSI 14」/ indicator name: "RSI 14"
export function indName(type: string, inputs: Record<string, unknown>): string {
  const abbr = type === 'smma' ? 'SMMA' : type === 'willr' ? '%R' : type === 'bb' ? 'BB' : type === 'dc' ? 'DC' : type.toUpperCase()
  const args = type === 'macd' ? [inputs.fast, inputs.slow, inputs.signal]
    : type === 'stoch' ? [inputs.kLen, inputs.kSmooth, inputs.dLen]
    : type === 'bb' ? [inputs.len, inputs.mult]
    : [inputs.len]
  return `${abbr} ${args.filter((x) => x != null).join(' ')}`.trim()
}

// 条件一句话（不带品种）：「上穿 2650.00」「RSI 14 上穿 70」/ the condition as one phrase, no symbol
export function describe(a: Pick<ChartAlertIn, 'kind' | 'cond' | 'spec'>, digits: number, t: T): string {
  const s = a.spec as Record<string, unknown>
  // 百分比移动的条件名去掉「%」，数值里已经带了 / pct moves drop the "%" from the name; the value carries it
  const condKey = a.cond === 'moveUpPct' ? 'moveUp' : a.cond === 'moveDownPct' ? 'moveDown' : a.cond
  const cond = String(t(`charts.alert.cond.${condKey}`))
  const subject = a.kind === 'indicator' && s.ind && typeof s.ind === 'object'
    ? (() => { const i = s.ind as { type: string; inputs: Record<string, unknown>; plot: string }; const pl = ALERT_INDS[i.type]?.length > 1 ? ` ${t(`charts.alert.plot.${i.plot}`, { defaultValue: i.plot })}` : ''; return `${indName(i.type, i.inputs)}${pl}` })()
    : ''
  let obj = ''
  if (isMove(a.cond)) {
    const pct = a.cond === 'moveUpPct' || a.cond === 'moveDownPct'
    obj = String(t('charts.alert.moveIn', { v: pct ? `${s.value}%` : fmtNum(s.value, digits), n: s.bars }))
  } else if (a.kind === 'price') {
    obj = isBand(a.cond) ? `${fmtNum(s.lo, digits)} – ${fmtNum(s.hi, digits)}` : fmtNum(s.level, digits)
  } else if (a.kind === 'drawing') {
    obj = String(t(typeof s.label === 'string' && s.label ? 'charts.alert.drawingNamed' : 'charts.alert.drawing', { name: s.label }))
  } else {
    const tg = s.target as { kind: string; v?: number; lo?: number; hi?: number; plot?: string } | undefined
    if (tg?.kind === 'value') obj = String(tg.v)
    else if (tg?.kind === 'band') obj = `${tg.lo} – ${tg.hi}`
    else if (tg?.kind === 'plot') obj = String(t(`charts.alert.plot.${tg.plot}`, { defaultValue: tg.plot }))
    else if (tg?.kind === 'price') obj = String(t('charts.alert.price'))
  }
  return [subject, cond, obj].filter(Boolean).join(' ')
}

export function defaultMessage(a: Pick<ChartAlertIn, 'symbol' | 'kind' | 'cond' | 'spec'>, digits: number, t: T): string {
  return `${a.symbol} ${describe(a, digits, t)}`.slice(0, 200)
}

// 已存的警报 → 再次提交用的请求体 / a stored alert → a request body to send again
export function toIn(a: ChartAlert, patch: Partial<ChartAlertIn> = {}): ChartAlertIn {
  return {
    symbol: a.symbol, kind: a.kind, cond: a.cond, spec: a.spec, trigger: a.trigger, interval: a.interval,
    message: a.message, push: a.push, email: a.email, expiresAt: a.expiresAt, drawingId: a.drawingId,
    active: a.status === 'active', ...patch,
  }
}

// 图上能画成价格线的（价格类：单价位或上下沿）/ alerts that draw as price lines (price kind: a level or a band)
export function priceLevels(a: ChartAlert): { key: 'level' | 'lo' | 'hi'; price: number }[] {
  if (a.kind !== 'price' || isMove(a.cond)) return []
  const s = a.spec as Record<string, unknown>
  if (isBand(a.cond)) {
    return (['lo', 'hi'] as const).filter((k) => typeof s[k] === 'number').map((k) => ({ key: k, price: s[k] as number }))
  }
  return typeof s.level === 'number' ? [{ key: 'level', price: s.level }] : []
}
