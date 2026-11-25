// 图表交易的纯计算：拖动读数（价格 / 点数 / 金额 / 占余额）、挂单类型自动判断、
// 部分平仓手数、拖出止盈止损的默认位置、保本可行性、成交标记合并。与 React 无关。
// Pure maths for chart trading: drag readouts (price / points / money / % of balance),
// automatic pending type, partial-close lots, the default spot for a dragged-out
// SL/TP, breakeven feasibility and execution-marker grouping. No React here.
import type { OrderEntryType } from '../../../api/types'
import { lotStep, minLot, roundLots } from '../../../api/utils'
import { previewRisk, type SymbolSpec } from '../../order/orderMath'

export type Side = 'BUY' | 'SELL'

/** 一个「点」= 最小报价单位（5 位报价的 0.00001）。/ One point = the smallest price unit. */
export function pointSize(digits: number): number {
  return Math.pow(10, -Math.max(0, Math.min(10, digits)))
}

export interface MoveReadout {
  /** 相对入场价的点数，按仓位方向带符号（盈利为正）/ points from entry, signed by side (profit > 0) */
  points: number
  /** 账户货币金额，带符号；算不出（缺规格且不在估算表里）为 null / signed money, null when unknown */
  money: number | null
  /** 金额占余额的百分比，带符号；没有余额为 null / signed % of balance, null without one */
  pct: number | null
}

/**
 * 把一条线从入场价挪到 price 时的盈亏读数。方向按仓位：买单价位高于入场为正，
 * 卖单反之。金额复用下单表单的 previewRisk（同一套券商规格 / 估算表）。
 * The P/L reading for a line at `price` against `entry`, signed by side. Money reuses
 * the order form's previewRisk, so it agrees with the ticket's numbers.
 */
export function moveReadout(o: {
  symbol: string; side: Side; volume: number; entry: number; price: number
  digits: number; spec?: SymbolSpec; balance?: number | null
}): MoveReadout {
  const diff = o.side === 'BUY' ? o.price - o.entry : o.entry - o.price
  const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0
  const points = Math.round(diff / pointSize(o.digits))
  const prev = previewRisk(o.symbol, String(o.volume), o.entry, o.price, null, o.spec)
  const abs = prev?.riskUsd ?? null
  const money = abs == null ? null : sign * abs
  const pct = money != null && o.balance && o.balance > 0 ? (money / o.balance) * 100 : null
  return { points, money, pct }
}

/**
 * 挂在 price 上的单该是限价还是止损：买单低于卖价是限价（等回落），高于是止损（等突破）；
 * 卖单高于买价是限价，低于是止损。价格恰好等于现价时按限价——那一刻没有方向，限价更保守。
 * Limit or stop for an order resting at `price`: a buy below the ask is a limit, above it
 * a stop; a sell above the bid is a limit, below it a stop. Exactly at the market counts as
 * a limit, the more conservative of the two.
 */
export function autoEntryType(side: Side, price: number, bid: number | null, ask: number | null): Exclude<OrderEntryType, 'MARKET'> {
  const ref = side === 'BUY' ? (ask ?? bid) : (bid ?? ask)
  if (ref == null || !(ref > 0)) return 'LIMIT'
  if (side === 'BUY') return price > ref ? 'STOP' : 'LIMIT'
  return price < ref ? 'STOP' : 'LIMIT'
}

/**
 * 部分平仓手数：按比例取、向下吸附到品种步长。结果不到最小手数返回 null（平不出来）；
 * 达到或超过整仓、或剩下的不够最小手数，就是全平（返回整仓手数）。
 * Partial-close lots: ratio of the position, floored onto the symbol's step. Below the
 * minimum lot → null (can't be done); at or above the whole position, or leaving less
 * than a minimum lot behind → the full volume.
 */
export function partialVolume(volume: number, ratio: number, symbol: string): number | null {
  if (!(volume > 0) || !(ratio > 0)) return null
  if (ratio >= 1) return roundLots(volume)
  const step = lotStep(symbol)
  const v = roundLots(Math.floor((volume * ratio) / step + 1e-6) * step)
  if (v < minLot(symbol) - 1e-9) return null
  if (volume - v < minLot(symbol) - 1e-9) return roundLots(volume)
  return v
}

/**
 * 从标签上拖出（或在手机上点出）止盈 / 止损时，线先出现在哪：离入场价一段合理的距离，
 * 并且一定在现价正确的一侧（买单止损在现价下方、止盈在上方），否则用户一松手就是非法价。
 * 从入场价与现价里靠外的那个再往外挪一段：价格的 0.2%，或入场到现价距离的一半，取大者。
 * Where a dragged-out (or tapped-out on phones) SL/TP first appears: a sensible distance
 * from entry, always on the valid side of the market (a buy's SL below it, TP above),
 * so releasing it right away is never an invalid price. It starts from whichever of
 * entry and market is further out, and moves out by 0.2% of the price or half the
 * entry→market distance, whichever is larger.
 */
export function stagedLegPrice(side: Side, kind: 'sl' | 'tp', entry: number, current: number | null): number {
  const cur = current != null && current > 0 ? current : entry
  const d = Math.max(Math.abs(entry) * 0.002, Math.abs(cur - entry) * 0.5)
  // 买单止盈、卖单止损在上方 / a buy's TP and a sell's SL sit above
  const up = (side === 'BUY') === (kind === 'tp')
  return up ? Math.max(entry, cur) + d : Math.min(entry, cur) - d
}

/** 保本（止损挪到入场价）只在仓位浮盈时成立：买单要现价高于入场，卖单反之。
 *  Breakeven (SL to entry) only works in profit: a buy needs the market above entry. */
export function canBreakeven(side: Side, entry: number, current: number | null | undefined): boolean {
  if (current == null || !(current > 0)) return false
  return side === 'BUY' ? current > entry : current < entry
}

/** 一笔交易（或分批平仓的一腿）：开仓点 → 平仓点；还开着的仓位只有开仓点。
 *  One trade (or one leg of a partial close): entry → exit; open positions have the entry only. */
export interface TradeLeg {
  /** 仓位方向 / position side */
  side: Side
  /** 开仓时间（秒）与价位 / entry time (s) and price */
  t1: number
  p1: number
  /** 平仓时间与价位，还没平为 null / exit time and price, null while open */
  t2: number | null
  p2: number | null
  profit: number | null
}

/** 落到 K 线上的交易：时间换成所在那根 K 线；比已加载的 K 线还早的一头为 null。
 *  A trade placed on bars: times become their bars; an end older than the loaded bars is null. */
export interface PlacedLeg {
  side: Side
  b1: number | null
  p1: number
  b2: number | null
  p2: number | null
  profit: number | null
}

/** 二分找 t 所在的那根 K 线（最后一根 ≤ t 的）；比第一根还早返回 null。
 *  Binary search for the bar containing t (the last bar ≤ t); null when before the first. */
export function barOf(times: readonly number[], t: number): number | null {
  if (times.length === 0 || t < times[0]) return null
  let lo = 0, hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= t) lo = mid; else hi = mid - 1
  }
  return times[lo]
}

/** 交易落到 K 线上；价位无效、两头都落不到的丢掉。/ Place trades on bars; drop invalid or entirely unplaceable ones. */
export function placeLegs(legs: readonly TradeLeg[], times: readonly number[]): PlacedLeg[] {
  const out: PlacedLeg[] = []
  for (const l of legs) {
    if (!(l.p1 > 0)) continue
    const closed = l.t2 != null && l.p2 != null && l.p2 > 0
    const b1 = barOf(times, l.t1)
    const b2 = closed ? barOf(times, l.t2 as number) : null
    if (b1 == null && b2 == null) continue
    out.push({ side: l.side, b1, p1: l.p1, b2, p2: closed ? l.p2 : null, profit: l.profit })
  }
  return out
}

/** 金额显示：带正负号、两位小数。/ Signed money with two decimals. */
export function fmtSigned(n: number, digits = 2): string {
  const s = Math.abs(n).toFixed(digits)
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s
}
