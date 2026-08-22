"""品种别名：同一个金融品种在两侧被叫成不同名字时的对照表。

**为什么需要这个文件**（2026-08-22，起因是一次持续 38 天的静默失效）：

胜负判定是拿行情推送的 symbol 去精确匹配信号的 symbol
（`Signal.symbol == symbol`），两侧对不上就一条也判不出来，**而且不报任何错**。
偏偏"两侧对不上"是被产品决定批准过的：

- 比特币：MT5 实际品种名是 `BTCUSD`（下单、报价、持仓靠它精确匹配），而用户
  更熟悉 `BTCUSDT`，TradingView 的警报也一直发这个名字。见《产品需求文档》
  6.15 节——那条决定明确写着"报价/趋势字典查找键全部继续用原始 BTCUSD"，
  却没人注意到判定也走同一条精确匹配。
- 原油：券商叫 `USOIL`/`XTIUSD`/`CL` 不等，平台规范名是 `WTI`。这个当初两侧
  一起改了，所以没出事——恰好说明问题不在"有别名"，而在"只改了一侧"。

后果：2026-07-15 EA 侧把比特币规范成 `BTCUSD` 之后，TradingView 仍发
`BTCUSDT`，该品种 4400 条信号里 4081 条（93%）从此再没被判定逻辑看过一眼，
持续 38 天。它还是平台信号量最大的品种，占全平台两成。

**为什么修在这里而不是 EA 或 TradingView**：`g_symbols` 同时是报价、趋势、
K 线的字典键，改 EA 会波及下单路径与既有 K 线数据——6.15 节那条决定专门警告
过"绝不把展示名回传进任何逻辑路径"。判定层加一次别名归一，影响面最小，而且
以后两侧命名再漂移也不会静默失效。

Symbol aliases: the lookup table for when one instrument is called different
names on the two sides of the system.

Win/loss resolution matches a price push's symbol against a signal's symbol
exactly, and a mismatch resolves nothing while raising no error. That mismatch
was itself an approved product decision: MT5 calls Bitcoin `BTCUSD` (orders,
quotes and positions all match on that string) while users and the TradingView
alerts know it as `BTCUSDT` — see section 6.15 of the PRD, which specified that
quote and trend dictionary keys keep the raw `BTCUSD`, without anyone noticing
that resolution keys off the same exact match.

The result: after the EA normalised Bitcoin to `BTCUSD` on 2026-07-15, 4081 of
that symbol's 4400 signals (93%) went untouched by resolution for 38 days — on
the platform's highest-volume symbol, a fifth of all signals.

Fixed here rather than in the EA because `g_symbols` doubles as the dictionary
key for quotes, trends and candles: changing it would reach into order routing
and existing candle data, which is exactly what 6.15 warned against. Normalising
once at the resolution layer has the smallest blast radius and makes any future
naming drift harmless.
"""
from __future__ import annotations

# 每组是"同一个品种的所有已知写法"。组内顺序无意义——匹配是集合语义。
# 与 EA 的 GetAliasCandidates（ea/PRISMX_MarketFeed.mq5）覆盖同一组品种，但两边
# 各自维护：EA 那份解决的是"券商把它叫什么"（用于 SymbolSelect），这份解决的是
# "信号与行情两侧可能各用哪个名字"（用于判定匹配）。职责不同，不要合并。
#
# Each group lists every known spelling of one instrument; order is irrelevant
# since matching is set semantics. This covers the same instruments as the EA's
# GetAliasCandidates but is maintained separately: the EA's table answers "what
# does this broker call it" (for SymbolSelect), this one answers "which of the
# two names might each side be using" (for resolution matching). Different jobs,
# deliberately not merged.
_ALIAS_GROUPS: tuple[frozenset[str], ...] = (
    frozenset({"BTCUSD", "BTCUSDT"}),
    frozenset({"WTI", "USOIL", "XTIUSD", "WTICOUSD"}),
)

# 展开成 名字 -> 该名字所在的整组，查表 O(1)。
# Flattened to name -> its whole group for O(1) lookup.
_BY_NAME: dict[str, frozenset[str]] = {
    name: group for group in _ALIAS_GROUPS for name in group
}


def symbol_match_set(symbol: str) -> tuple[str, ...]:
    """某个品种名在判定时应当匹配的全部写法（含它自己）。

    没有别名的品种返回单元素元组，调用方无需分支——`IN (:one)` 与 `= :one` 在
    Postgres 与 SQLite 上都走同一个索引，不存在退化。

    Every spelling that should match this symbol during resolution, including
    itself. Symbols without aliases return a one-element tuple so callers need no
    branch: `IN (:one)` and `= :one` use the same index on both Postgres and
    SQLite, so nothing degrades.
    """
    group = _BY_NAME.get(symbol.strip().upper())
    return tuple(sorted(group)) if group else (symbol,)
