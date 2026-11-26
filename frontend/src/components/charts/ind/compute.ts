// 指标计算管线：按实例列表逐个算，处理数据源（价格或另一个指标）、多周期（把图上 K 线
// 合成更大周期再算，结果按桶映射回来）、平移，以及可见性规则。纯函数，不碰图表库。
// Indicator compute pipeline: runs each instance, resolving sources (price or another
// indicator), multi-timeframe (aggregate the chart's bars to the higher timeframe, compute,
// map back per bucket), shifts and visibility rules. Pure; never touches the chart library.
import type { Candle } from '../../../api/types'
import { parseInterval } from '../intervals'
import { tfKeyFn } from './periods'
import { defOf, priceSource } from './registry'
import type { IndDef, IndExtras, IndInstance, IndOutput, VisKind } from './types'

export { tfKeyFn }

export interface InstResult {
  uid: string
  def: IndDef
  // 未平移的原始输出（长度 = K 线根数）/ unshifted outputs (length = bar count)
  out: IndOutput
  // 每条 plot 往右平移几根 / per-plot shift to the right, in bars
  offsets: Record<string, number>
  extras: IndExtras
  // 实际用的周期（null = 图表周期）/ timeframe actually used (null = the chart's)
  tf: string | null
}

// 周期 → 约略秒数，只用来比大小 / interval → rough seconds, for ordering only
export function approxSeconds(code: string): number {
  const p = parseInterval(code)
  if (!p) return 0
  if (p.unit === 'min') return p.n * 60
  if (p.unit === 'D') return p.n * 86400
  if (p.unit === 'W') return p.n * 604800
  return p.n * 2592000
}

// 该实例在这个周期下按「可见性」页的规则是否显示 / visibility-tab rule for this interval
export function visibleOnInterval(inst: IndInstance, interval: string): boolean {
  const vis = inst.vis
  if (!vis) return true
  const p = parseInterval(interval)
  if (!p) return true
  let kind: VisKind
  let n = p.n
  if (p.unit === 'min') {
    if (p.n < 60 || p.n % 60 !== 0) kind = 'min'
    else { kind = 'hour'; n = p.n / 60 }
  } else kind = p.unit === 'D' ? 'day' : p.unit === 'W' ? 'week' : 'month'
  const r = vis[kind]
  if (!r) return true
  return r.on && n >= r.from && n <= r.to
}

// 实例的有效周期：比图表周期大、指标支持、非价格类图表时才生效。
// The instance's effective timeframe: only when higher than the chart's, supported and not on price-based charts.
export function effectiveTf(inst: IndInstance, def: IndDef, interval: string, priceBased: boolean): string | null {
  if (!inst.tf || def.noTf || priceBased) return null
  return approxSeconds(inst.tf) > approxSeconds(interval) ? inst.tf : null
}

interface Agg { bars: Candle[]; idx: Int32Array; last: Int32Array }
function aggregate(bars: Candle[], key: (t: number) => number): Agg {
  const out: Candle[] = []
  const idx = new Int32Array(bars.length)
  const lastIdx: number[] = []
  let cur = NaN
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const k = key(b.t)
    if (k !== cur) {
      cur = k
      out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 })
      lastIdx.push(i)
    } else {
      const a = out[out.length - 1]
      if (b.h > a.h) a.h = b.h
      if (b.l < a.l) a.l = b.l
      a.c = b.c
      a.v += b.v ?? 0
      lastIdx[lastIdx.length - 1] = i
    }
    idx[i] = out.length - 1
  }
  return { bars: out, idx, last: Int32Array.from(lastIdx) }
}

export interface CalcInput {
  list: IndInstance[]
  bars: Candle[]
  interval: string
  digits: number
  priceBased: boolean
  symbol?: string
  other?: (symbol: string, interval: string) => Candle[] | null
  intrabar?: (code: string, t0: number, key: string) => Candle[] | null
}

export function computeAll({ list, bars, interval, digits, priceBased, symbol, other, intrabar }: CalcInput): Map<string, InstResult> {
  const byUid = new Map(list.map((i) => [i.uid, i]))
  const results = new Map<string, InstResult>()
  const busy = new Set<string>()
  const priceCache = new Map<string, number[]>()
  const price = (kind: string) => {
    let a = priceCache.get(kind)
    if (!a) { a = priceSource(bars, kind); priceCache.set(kind, a) }
    return a
  }

  const run = (inst: IndInstance): InstResult | null => {
    const hit = results.get(inst.uid)
    if (hit) return hit
    const def = defOf(inst.type)
    if (!def || busy.has(inst.uid)) return null
    busy.add(inst.uid)
    // 数据源：价格，或 'ind:<uid>:<plot>'（先算被引用的那个；循环引用退回收盘价）
    // Source: a price, or 'ind:<uid>:<plot>' (computed first; a cycle falls back to close)
    const chartSrc = (key: string): (number | null)[] => {
      const v = String(inst.inputs[key] ?? 'close')
      if (v.startsWith('ind:')) {
        const [, ref, plot] = v.split(':')
        const dep = byUid.get(ref)
        const r = dep ? run(dep) : null
        const arr = r?.out[plot]
        if (arr && arr.length === bars.length) return arr
        return price('close')
      }
      return price(v)
    }
    const tf = effectiveTf(inst, def, interval, priceBased)
    let out: IndOutput = {}
    let extras: IndExtras = {}
    try {
      if (!tf) {
        const raw = def.compute({ bars, interval, digits, symbol, other, intrabar }, inst.inputs, chartSrc)
        extras = (raw.__x as IndExtras | undefined) ?? {}
        delete raw.__x
        out = raw as IndOutput
      } else {
        const agg = aggregate(bars, tfKeyFn(tf)!)
        const htfSrc = (key: string) => {
          const v = String(inst.inputs[key] ?? 'close')
          if (v.startsWith('ind:')) {
            const a = chartSrc(key)
            return Array.from(agg.last, (i) => a[i])
          }
          return priceSource(agg.bars, v)
        }
        const h = def.compute({ bars: agg.bars, interval: tf, digits, symbol, other }, inst.inputs, htfSrc)
        const wait = inst.tfWait === true
        out = {}
        for (const k of Object.keys(h)) {
          if (k === '__x') continue
          const src = h[k] as (number | null)[]
          const dst = new Array<number | null>(bars.length)
          for (let i = 0; i < bars.length; i++) {
            const j = agg.idx[i] - (wait ? 1 : 0)
            dst[i] = j >= 0 ? src[j] ?? null : null
          }
          out[k] = dst
        }
      }
    } catch {
      out = {}
      extras = {}
    }
    const base = def.offsetInput ? Number(inst.inputs[def.offsetInput] ?? 0) || 0 : 0
    const per = def.plotOffsets ? def.plotOffsets(inst.inputs) : {}
    const offsets: Record<string, number> = {}
    for (const p of def.plots) offsets[p.key] = base + (per[p.key] ?? 0)
    const res: InstResult = { uid: inst.uid, def, out, offsets, extras, tf }
    results.set(inst.uid, res)
    busy.delete(inst.uid)
    return res
  }
  for (const inst of list) run(inst)
  return results
}

// 往右平移最多的根数（要在最新 K 线右边补未来时间）/ the largest shift right (future times needed)
export function maxFuture(results: Map<string, InstResult>): number {
  let m = 0
  results.forEach((r) => { for (const k of Object.keys(r.offsets)) if (r.offsets[k] > m) m = r.offsets[k] })
  return Math.min(m, 500)
}

// 最近一根有值的数（图例在不悬停时显示）/ value at the latest bar, accounting for the shift
export function latestValue(r: InstResult, key: string, n: number): number | null {
  const arr = r.out[key]
  if (!arr) return null
  const off = r.offsets[key] ?? 0
  const i = n - 1 - off
  return i >= 0 && i < arr.length ? arr[i] ?? null : null
}
