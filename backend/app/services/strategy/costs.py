"""交易成本模型：点差、手续费、滑点，以及品种的价格量纲工具。

回测与实盘共用本模块，使「两边成本口径一致」成为结构保证而不是人工约定。
成本量纲：点差与滑点是价格单位；手续费是「一手往返合计、折算到价格单位」。
回测在价格空间结算，不引入合约规模/点值假设——把手续费也放进价格量纲，是
让它能与盈亏进同一个减法的前提，代价是配置时需要管理员按品种折算一次。

Trading-cost model: spread, commission, slippage, plus a symbol's price-unit
helpers. Shared by the backtest and the live evaluator, so "both sides use the
same cost basis" is structural rather than a convention someone has to
remember. Units: spread and slippage are price units; commission is "per lot,
round trip, expressed in price units". The backtest settles in price space and
assumes no contract size or point value — putting commission in price units is
what lets it enter the same subtraction as P&L, at the cost of the admin
converting once per symbol when configuring it.
"""
import hashlib
import json
from dataclasses import dataclass

from app.services import quotes_store
from app.services.settings_store import get_strategy_costs


@dataclass(frozen=True)
class SymbolCosts:
    """某个品种的一套成本参数 / one symbol's cost parameters."""

    spread: float
    commission_per_lot: float
    slippage: float


# 未配置品种的回落值：点差 0.2、滑点 0.05（价格单位），手续费 0。
# 手续费默认 0 而非猜一个数——猜出来的手续费会让回测结果看起来"已计成本"
# 却与用户的真实账户无关，比明确的 0 更有害。
# Fallback for unconfigured symbols: 0.2 spread, 0.05 slippage (price units),
# zero commission. Commission defaults to 0 rather than a guess — a guessed
# commission makes a backtest look "cost-adjusted" while having nothing to do
# with the user's real account, which is worse than an explicit zero.
DEFAULT_COSTS = SymbolCosts(spread=0.2, commission_per_lot=0.0, slippage=0.05)


def symbol_costs(db, symbol: str) -> SymbolCosts:
    """取某品种的成本参数，逐字段回落到默认值。
    A symbol's costs, falling back to the defaults field by field."""
    cfg = get_strategy_costs(db)
    entry = (cfg.get("per_symbol") or {}).get(symbol.upper()) or {}
    return SymbolCosts(
        spread=float(entry.get("spread", cfg["default_spread"])),
        commission_per_lot=float(entry.get("commissionPerLot", cfg["default_commission_per_lot"])),
        slippage=float(entry.get("slippage", cfg["default_slippage"])),
    )


def costs_version(db) -> str:
    """成本配置的短哈希。回测结果缓存 key 的一部分（见 core/strategy_limits.py）——
    管理员改了成本，旧缓存必须自然失效，否则用户会看到按旧成本算出的数字。
    Short hash of the cost config, part of the backtest cache key (see
    core/strategy_limits.py): when an admin edits costs, stale cached results
    must fall out on their own instead of showing numbers from the old basis."""
    blob = json.dumps(get_strategy_costs(db), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def entry_fill(side: str, close: float, c: SymbolCosts) -> float:
    """入场成交价：买在卖价一侧、卖在买价一侧，各自再吃一个滑点。
    Entry fill: buy on the ask side, sell on the bid side, each paying one
    slippage on top."""
    edge = c.spread / 2.0 + c.slippage
    return close + edge if side == "BUY" else close - edge


def exit_fill(side: str, level: float, c: SymbolCosts, is_stop: bool) -> float:
    """出场成交价：触及止损额外吃一个滑点（止损滑价是真实现象），触及止盈不吃。

    止盈不加惩罚不是偏袒，而是方向不同：止盈是限价单，滑价只会更好或不成交，
    按原价成交已是保守；止损是市价单，滑价一律更差。

    Exit fill: a stop takes one extra slippage (stop slippage is real), a
    target takes none. That asymmetry isn't favouritism — a target is a limit
    order whose slippage can only help or not fill at all, so filling at the
    level is already the conservative read; a stop is a market order and its
    slippage is always adverse.
    """
    if not is_stop:
        return level
    return level - c.slippage if side == "BUY" else level + c.slippage


def commission_cost(c: SymbolCosts, lots: float = 1.0) -> float:
    """往返手续费（价格单位）/ round-trip commission in price units."""
    return c.commission_per_lot * lots


def point_size(symbol: str, price: float) -> float:
    """一个"点"(step)对应的实际价格增量。优先用 EA 最近一次上报的该品种小数位数
    （`quotes_store`，真实的最小报价变动单位）；EA 还没推送过该品种报价时，退回
    按价格量级估算——与 round_price 同一套分档。

    The actual price increment one "point" (step) represents. Prefers the EA's
    most recently reported decimal-digit count (`quotes_store`, the real
    minimum increment); falls back to a magnitude-based estimate (same
    bucketing as round_price) when the EA hasn't quoted this symbol yet.
    """
    digits = quotes_store.get_digits(symbol)
    if digits is not None:
        return 10 ** -digits
    if price >= 100:
        return 0.01
    if price >= 1:
        return 0.0001
    return 0.000001


def round_price(value: float) -> float:
    """按价格量级四舍五入到合理小数位，清掉百分比/成本换算残留的浮点误差
    （如 63619.50399999999）。按量级而非逐品种白名单——策略可以跑在任意 EA
    在报的品种上。
    Round to a sane precision by magnitude, clearing float residue left by the
    percent/cost math (e.g. 63619.50399999999). Magnitude-based rather than a
    per-symbol whitelist — strategies run on any symbol the EA feeds."""
    if value >= 100:
        return round(value, 2)
    if value >= 1:
        return round(value, 4)
    return round(value, 6)
