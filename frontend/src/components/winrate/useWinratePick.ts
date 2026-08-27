// 「我关心哪一路」——策略 + 品种的选择，仪表盘那张卡与「策略分析」页首屏**共用同
// 一份**。
//
// 共用不是为了省代码，是因为它们问的是同一个问题：卡片右上角「查看详情 ›」直接
// 链到分析页，两处显示不同的选中值会让人以为点错了地方。
//
// 存在 `usePrefs` 的 `winrate` 命名空间，不是 localStorage：那是**云端按用户落库、
// 并经 WS 推到该用户其它设备**的偏好。localStorage 只认浏览器不认人——同一台电脑
// 换个账号登录，上一个人选的策略会原样出现在新用户面前，而那可能是个他根本看不
// 到的策略。
//
// The "which line do I care about" pick — strategy plus symbol — shared by the
// dashboard card and the analysis page's first screen.
//
// Shared not to save code but because they ask the same question: the card's
// "view detail" link goes straight to that page, and two different selections
// would read as having landed somewhere unintended.
//
// Stored in usePrefs' `winrate` namespace rather than localStorage: that is a
// cloud-persisted, per-user preference pushed to the user's other devices over
// WS. localStorage knows browsers, not people — signing in as someone else on
// the same machine would surface the previous person's chosen strategy, possibly
// one this user cannot even see.
import { useCallback } from 'react'
import { usePrefs } from '../../store/prefs'
import type { AdminStrategyWinRate, StrategyWinRate, SymbolWinRate } from '../../api/types'

export type WinratePick = { strategy: string; symbol: string }

/** 没有存过选择时默认落在哪个品种上。
 *
 *  黄金是平台信号量最大、也是用户开口就问的品种，因而也是各种分片下最不容易空的
 *  一档（钟点格尤其明显）。该策略在窗口内没有黄金信号时退回它的第一个品种。
 *
 *  Which symbol an unset pick lands on. Gold carries the most signals and is the
 *  symbol users ask about first, which also makes it the slice least likely to
 *  come up empty (the hour grid especially). Falls back to the strategy's first
 *  symbol when it traded no gold inside the window. */
const DEFAULT_SYMBOL = 'XAUUSD'

/** 把（可能过时的）选择落到当前数据上，返回的组合一定存在于 data 里。
 *
 *  存下来的选择随时会失效：策略被管理员取消公开、某个品种整个窗口一条信号都没发。
 *  回退顺序是「存的 → 黄金 → 第一个」，每一级都在**当前策略的**品种里找——换策略
 *  时沿用上次选的品种是对的（同一个品种在另一个策略下照样有意义），但那个品种在
 *  新策略里不存在时必须让位，否则下游 `.find()` 会拿到 undefined。
 *
 *  Resolve a (possibly stale) pick against the current data; the result always
 *  exists. Stored picks go stale easily — a strategy gets un-published, a symbol
 *  goes a whole window without firing. The fallback runs saved -> gold -> first,
 *  each looked up **within the chosen strategy's** symbols: carrying the previous
 *  symbol across a strategy switch is right, but it has to yield where absent or
 *  the downstream `.find()` returns undefined. */
export function resolveWinratePick(
  data: AdminStrategyWinRate,
  saved: Partial<WinratePick> | null,
): WinratePick | null {
  if (data.strategies.length === 0) return null
  const row = data.strategies.find((s) => s.strategy === saved?.strategy) ?? data.strategies[0]
  const symbol =
    row.symbols.find((s) => s.symbol === saved?.symbol)?.symbol
    ?? row.symbols.find((s) => s.symbol === DEFAULT_SYMBOL)?.symbol
    ?? row.symbols[0]?.symbol
  return symbol ? { strategy: row.strategy, symbol } : null
}

export interface WinratePickState {
  /** 落到当前数据上的有效选择；没有任何可选组合时为 null。
   *  The pick resolved against current data; null when nothing is selectable. */
  pick: WinratePick | null
  /** 选中策略那一行（含它的 symbols 列表，喂品种选择器）。
   *  The chosen strategy's row, whose symbols feed the symbol picker. */
  row: StrategyWinRate | undefined
  /** 选中的「策略 × 品种」那一格，钟点序列从这里取。
   *  The chosen strategy-by-symbol cell; the hour series comes from here. */
  symbolRow: SymbolWinRate | undefined
  /** 换策略：品种会重新落一次（上次选的品种在新策略里可能不存在）。
   *  Switch strategy; the symbol re-resolves, since the previous one may be
   *  absent under the new strategy. */
  chooseStrategy: (strategy: string) => void
  chooseSymbol: (symbol: string) => void
}

export function useWinratePick(data: AdminStrategyWinRate | null): WinratePickState {
  const { getPref, setPref } = usePrefs()
  const saved = getPref<Partial<WinratePick> | null>('winrate', 'pick', null)

  const pick = data ? resolveWinratePick(data, saved) : null
  const row = data && pick ? data.strategies.find((s) => s.strategy === pick.strategy) : undefined
  const symbolRow = row && pick ? row.symbols.find((s) => s.symbol === pick.symbol) : undefined

  const chooseStrategy = useCallback((strategy: string) => {
    if (!data) return
    // 走一遍 resolveWinratePick 而不是直接存：上次选的品种在新策略里可能不存在，
    // 直接沿用会指向一个空的品种行。
    // Re-resolve rather than store as-is: the previous symbol may not exist under
    // the new strategy, and carrying it over blindly would point at an absent row.
    const next = resolveWinratePick(data, { strategy, symbol: pick?.symbol })
    if (next) setPref('winrate', 'pick', next)
  }, [data, pick?.symbol, setPref])

  const chooseSymbol = useCallback((symbol: string) => {
    if (!pick) return
    setPref('winrate', 'pick', { strategy: pick.strategy, symbol })
  }, [pick, setPref])

  return { pick, row, symbolRow, chooseStrategy, chooseSymbol }
}
