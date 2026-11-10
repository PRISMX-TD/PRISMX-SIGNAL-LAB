// 持仓浮盈随实时报价走（2026-11-11 "余额和净值能不能更新得更快"）。
//
// 服务器推来的持仓（POSITIONS）大约 2 秒一帧，浮盈和净值原来就是 2 秒一跳。全站报价
// （GLOBAL_QUOTES）每跳都推，所以在两帧之间用报价把浮盈往前推：
//
//   实时浮盈 = 服务器浮盈 + 方向 × (现在的报价 − 那一帧到达时的报价) × k
//
// - 用"那一帧到达时的报价"做锚点而不是直接拿服务器的现价相减：报价源与券商现价之间
//   可能有一点固定价差，锚点让它抵消掉，只取两帧之间的价格变化。
// - k = 每 1 个价格单位对应多少账户货币。优先从服务器自己的数据反推
//   (浮盈 ÷ 价差)，按单号记住；价差太小反推不准时退回合约表（只认得以 USD 计价 /
//   USD 作基础货币的品种），都没有就不推算，照旧显示服务器的数。
// - 下一帧持仓一到，一切回到服务器的真实数字——推算只填两帧之间那 2 秒。
// 纯展示，不碰后端，不影响任何下单、风控逻辑。
//
// Floating P/L that follows live quotes between positions frames (~2s apart):
//   live = server profit + dir × (quote now − quote when the frame arrived) × k
// The frame-arrival quote is the anchor, cancelling any constant offset between the
// display feed and the broker price. k (account currency per price unit) comes from
// the server's own numbers (profit ÷ price move), remembered per ticket, with the
// contract table as a fallback; without either the server number is shown as is.
// Display only; the next frame always restores the server's figures.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Position, Quote } from '../api/types'
import { baseSymbol, contractSize, usdMarginBasis } from '../api/utils'
import { isAppHidden } from '../utils/appVisibility'
import { useGlobalQuotesPeek } from './live'

export interface QuoteAnchor {
  bid: number
  ask: number
}

// 报价相对锚点挪动超过这个比例就当报价源出错，不推算。/ Treat larger jumps as a bad quote.
const MAX_REL_MOVE = 0.02
// 价差至少这么大（相对现价）才从服务器数据反推 k；太小时浮盈多半是四舍五入噪声。
// Minimum relative price move for inferring k from the server's profit.
const MIN_REL_MOVE_FOR_K = 1e-4
// 刷新节奏：最快 0.3 秒重算一次，跳价再密也不至于整页狂刷。/ At most ~3 recomputes a second.
const TICK_MS = 300

export function livePosKey(p: Position): string {
  return p.ticket != null ? `t${p.ticket}` : `${p.login ?? ''}:${p.symbol}:${p.side}:${p.entryPrice ?? ''}`
}

const dirOf = (p: Position): number => (p.side === 'BUY' ? 1 : -1)
// 平仓价：多单按买价(bid)平，空单按卖价(ask)平。/ Longs close at bid, shorts at ask.
const closeSide = (p: Position, q: QuoteAnchor): number => (p.side === 'BUY' ? q.bid : q.ask)

/** 从服务器的浮盈反推 k；价差太小或符号不对返回 null。/ Infer k from the server's profit. */
export function impliedK(p: Position): number | null {
  const po = p.entryPrice
  const pc = p.currentPrice
  if (po == null || pc == null || !(pc > 0)) return null
  const move = dirOf(p) * (pc - po)
  if (Math.abs(move) / pc < MIN_REL_MOVE_FOR_K) return null
  const k = p.profit / move
  return Number.isFinite(k) && k > 0 ? k : null
}

/** 合约表估算的 k（假定账户货币 USD）；不认识的品种返回 null。/ Table k, USD account assumed. */
export function tableK(p: Position, price: number): number | null {
  const basis = usdMarginBasis(p.symbol)
  if (!basis || !(p.volume > 0)) return null
  const units = p.volume * contractSize(p.symbol)
  if (basis === 'quote') return units
  return price > 0 ? units / price : null
}

/** 一条持仓按报价推算后的样子；推算不了就原样返回。/ One position moved by the quote. */
export function livePosition(
  p: Position,
  quote: Pick<Quote, 'bid' | 'ask' | 'closed'> | undefined,
  anchor: QuoteAnchor | undefined,
  k: number | null,
): Position {
  if (!quote || !anchor || k == null || quote.closed) return p
  const now = closeSide(p, quote)
  const then = closeSide(p, anchor)
  if (!(now > 0) || !(then > 0) || Math.abs(now - then) / then > MAX_REL_MOVE) return p
  const delta = now - then
  if (delta === 0) return p
  const profit = Math.round((p.profit + dirOf(p) * delta * k) * 100) / 100
  const currentPrice = p.currentPrice != null ? p.currentPrice + delta : p.currentPrice
  return { ...p, profit, currentPrice }
}

/**
 * 把持仓表换成"随实时报价走"的版本。每次服务器推来新的一帧，锚点重设、k 重新校准。
 * Returns the positions moved by live quotes; each server frame resets anchors and k.
 */
export function useLivePositions(positions: Position[]): Position[] {
  const peek = useGlobalQuotesPeek()
  const kByTicket = useRef<Map<string, number>>(new Map())
  const anchors = useRef<Map<string, QuoteAnchor>>(new Map())
  const [tick, setTick] = useState(0)

  // 新的一帧：记下此刻的报价当锚点，并用服务器数据校准 k。
  // A new frame: anchor at the current quotes and calibrate k from the server's data.
  const frame = useMemo(() => {
    const quotes = peek()
    const nextAnchors = new Map<string, QuoteAnchor>()
    const nextK = new Map<string, number>()
    for (const p of positions) {
      const sym = baseSymbol(p.symbol)
      const q = quotes[sym] ?? quotes[p.symbol]
      if (q && !nextAnchors.has(sym) && q.bid > 0 && q.ask > 0) nextAnchors.set(sym, { bid: q.bid, ask: q.ask })
      const key = livePosKey(p)
      const k = impliedK(p) ?? kByTicket.current.get(key) ?? tableK(p, p.currentPrice ?? q?.bid ?? 0)
      if (k != null) nextK.set(key, k)
    }
    kByTicket.current = nextK
    anchors.current = nextAnchors
    return positions
  }, [positions, peek])

  // 跳价节拍：只在持仓相关品种的报价变了才重算。/ Recompute only when a held symbol's quote moved.
  useEffect(() => {
    if (frame.length === 0) return
    const syms = Array.from(new Set(frame.map((p) => baseSymbol(p.symbol))))
    let last = ''
    const id = window.setInterval(() => {
      if (isAppHidden()) return
      const quotes = peek()
      const sig = syms.map((s) => {
        const q = quotes[s]
        return q ? `${q.bid}/${q.ask}` : '-'
      }).join('|')
      if (sig !== last) {
        last = sig
        setTick((n) => n + 1)
      }
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [frame, peek])

  return useMemo(() => {
    void tick
    const quotes = peek()
    let changed = false
    const out = frame.map((p) => {
      const sym = baseSymbol(p.symbol)
      const q = quotes[sym] ?? quotes[p.symbol]
      // 帧到达时还没有报价的品种：第一条报价来了就以它为锚（这一刻不挪）。
      // No quote when the frame arrived: anchor at the first one seen (no move yet).
      if (q && !anchors.current.has(sym) && q.bid > 0 && q.ask > 0) {
        anchors.current.set(sym, { bid: q.bid, ask: q.ask })
      }
      const live = livePosition(p, q, anchors.current.get(sym), kByTicket.current.get(livePosKey(p)) ?? null)
      if (live !== p) changed = true
      return live
    })
    return changed ? out : frame
  }, [frame, tick, peek])
}
