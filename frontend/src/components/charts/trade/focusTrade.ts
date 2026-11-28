// 「在图表上看这一单」：交易报告里点一笔单，带着它的品种、开平时间和价格跳到 /charts。
// 数据放在路由 state 里（不进网址），图表页收到后切品种、挑一个合适的周期、把开仓那根 K 线放到
// 屏幕中间，并把这一单的开平点画出来（不看「成交标记」的开关——这是用户点名要看的那一单）。
// "Show this trade on the chart": a trade clicked in the trading report travels to /charts in the
// router state (never the URL). The chart page switches symbol, picks a fitting interval, centres the
// entry bar and draws the trade's entry and exit regardless of the executions switch.
import { baseSymbol, parseTime } from '../../../api/utils'
import type { Side, TradeLeg } from './tradeMath'

export interface FocusTrade {
  /** 每次点击一个新 id，同一单点第二次也会重新定位 / fresh per click, so a repeat click re-centres */
  id: string
  symbol: string
  side: Side
  /** 开仓 / 平仓时间（秒）与价位；旧存档没有价位，还没平的单没有平仓那一头
   *  entry / exit time (s) and price; old archives carry no prices, open trades no exit */
  t1: number
  p1: number | null
  t2: number | null
  p2: number | null
  profit: number | null
}

export interface TradeRefLike {
  symbol: string
  side: string
  openAt: string
  closeAt: string
  openPrice?: number | null
  closePrice?: number | null
  profit: number
  unrealized?: boolean
}

const sec = (iso: string | null | undefined): number | null => {
  const n = parseTime(iso)?.getTime()
  return n != null && Number.isFinite(n) ? Math.floor(n / 1000) : null
}
const price = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

let seq = 0

/** 报告里的一笔单 → 图表要的定位信息；开仓时间读不出来返回 null。
 *  A report trade → what the chart needs; null when the open time can't be read. */
export function focusFromRef(x: TradeRefLike): FocusTrade | null {
  const t1 = sec(x.openAt)
  if (t1 == null || !x.symbol) return null
  const open = !!x.unrealized
  return {
    id: `${t1}-${++seq}`,
    symbol: baseSymbol(x.symbol),
    side: x.side === 'SELL' ? 'SELL' : 'BUY',
    t1,
    p1: price(x.openPrice),
    t2: open ? null : sec(x.closeAt),
    p2: open ? null : price(x.closePrice),
    profit: Number.isFinite(x.profit) ? x.profit : null,
  }
}

// 1 分钟线只保留 30 天（后端 m1_retention_days）；留几天余量，免得跳过去是空的。
// One-minute bars are kept 30 days (backend m1_retention_days); leave a margin so the jump isn't empty.
const M1_SAFE_SECONDS = 25 * 86400

/** 看这一单用哪个周期：持仓越久周期越大，让开平两头落在同一屏里；太早的单不用 1 分钟线。
 *  The interval to view the trade on: longer holds get larger bars so both ends share a screen;
 *  trades too old for stored one-minute bars start at five minutes. */
export function focusInterval(f: Pick<FocusTrade, 't1' | 't2'>, nowSec: number): string {
  const hold = f.t2 != null ? Math.max(0, f.t2 - f.t1) : Math.max(0, nowSec - f.t1)
  if (hold <= 2 * 3600) return nowSec - f.t1 < M1_SAFE_SECONDS ? '1' : '5'
  if (hold <= 12 * 3600) return '5'
  if (hold <= 3 * 86400) return '15'
  if (hold <= 14 * 86400) return '60'
  return '240'
}

/** 画标记用的那一条线；没有开仓价就画不了（旧存档），只定位。
 *  The leg to draw; without an entry price (old archives) there is nothing to draw, only the jump. */
export function focusLeg(f: FocusTrade): TradeLeg | null {
  if (f.p1 == null) return null
  return { side: f.side, t1: f.t1, p1: f.p1, t2: f.t2, p2: f.p2, profit: f.profit }
}

// 「回放这一单」放到哪一步了：还没到开仓 / 持仓中 / 已平仓。回放时图上只有游标之前的 K 线，
// 按最后一根 K 线再加一根的宽度判断——那一根走完之前，落在它里面的开仓 / 平仓就算已经发生。
// How far "replay this trade" got: before the entry, in the trade, or closed. A replay only holds the
// bars up to its cursor; the edge is the last bar plus one bar width, so an entry or exit inside the
// last bar counts as reached.
export type FocusPhase = 'before' | 'open' | 'closed'
export function focusPhase(times: readonly number[], t1: number, t2: number | null): FocusPhase {
  const n = times.length
  if (!n) return 'before'
  const step = n > 1 ? Math.max(1, times[n - 1] - times[n - 2]) : 60
  const edge = times[n - 1] + step
  if (edge <= t1) return 'before'
  return t2 != null && edge <= t2 ? 'open' : 'closed'
}

/** 路由 state 里取出来的东西未必可信（刷新、别处 navigate），逐项验过再用。
 *  Router state can be anything (reloads, other navigations): validate before use. */
export function readFocusState(state: unknown): FocusTrade | null {
  const f = (state as { focusTrade?: Partial<FocusTrade> } | null)?.focusTrade
  if (!f || typeof f !== 'object') return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const t1 = num(f.t1)
  if (t1 == null || typeof f.symbol !== 'string' || !f.symbol || typeof f.id !== 'string') return null
  return {
    id: f.id,
    symbol: baseSymbol(f.symbol),
    side: f.side === 'SELL' ? 'SELL' : 'BUY',
    t1,
    p1: price(num(f.p1)),
    t2: num(f.t2),
    p2: price(num(f.p2)),
    profit: num(f.profit),
  }
}
