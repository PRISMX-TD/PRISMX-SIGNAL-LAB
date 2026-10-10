"""已平仓明细的落库、补齐与回扫判定，桥接与网关两条通道共用。

2026-09-07 起，每条平仓腿除原有 9 个字段外，还存 MT5 历史「仓位」视图里的全部信息：
开仓时间 / 开仓价 / 毛盈亏 / 手续费 / 隔夜利息 / 止损 / 止盈 / 平仓原因 / 注释。

两条通道原本都是"撞去重键就丢"，老记录永远补不上这些列。现在撞键改成**只补空列**
（已有值的列一律不覆盖），所以重复上报仍然幂等，而一次性回扫（桥接：后端在轮询
响应里点名账号；网关：首扫发现有缺列记录就回看一年）能把旧记录补齐。

开仓价 / 开仓时间 / 止损 / 止盈还有一层兜底：平台自己的订单表。网关的回看窗口里
常常没有开仓腿；桥接那侧 MT5 Python 接口的成交记录不带止损止盈，只能从开仓单读
到初值。平台记的是自己下单 / 改单时的值，用户若在 MT5 客户端手动改过止损，这里就
对不上——所以只在通道没给时才用，通道给了以通道为准。

Shared store for closed-trade legs. Detail columns are filled on insert and
back-filled on duplicate reports (null columns only, never overwriting), so
re-reporting stays idempotent while a one-off deep rescan enriches old rows.
Platform order records are the fallback for open price/time and SL/TP.
"""
from __future__ import annotations

import logging
import math
import re
import threading
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Candle, ClosedTrade, Order
from app.services.order_payload import OPENED_POSITION

# 载荷键 → 列名。两条通道的载荷与 POST /bridge/trade-history 同构。
# Payload key → column. Both channels share the /bridge/trade-history shape.
DETAIL_KEYS = {
    "openTime": "open_time",
    "openPrice": "open_price",
    "grossProfit": "gross_profit",
    "commission": "commission",
    "swap": "swap",
    "sl": "sl",
    "tp": "tp",
    "reason": "reason",
    "comment": "comment",
}

# 回扫只管近一年：个人胜率 / 明细页的统计范围就是 365 天，更早的补了也没人看。
# Deep rescans cover one year — the stats window the detail page shows.
BACKFILL_DAYS = 365

# 通道拿不到时才从平台订单表兜底的列 / columns the platform orders table may fill
_FALLBACK_COLS = ("open_price", "open_time", "sl", "tp")

# 费用列：载荷带 feeAlloc=2（只看成交记录的稳定分摊，桥接 v1.3.24 / 网关）且带开仓价
# （说明看到了开仓腿）时允许覆盖已有值，并按 毛盈亏 + 手续费 + 隔夜利息 重算净盈亏。
# 旧分摊随扫描时机变化、分批平仓会算重，重复上报的新值是更准的那个；反过来旧版桥接
# 的上报不带 feeAlloc，只能补空列，不会把新值冲掉。
# Fee columns: a report with feeAlloc=2 (scan-independent allocation) and an
# open price (the opening leg was seen) may overwrite existing values, and the
# net profit is recomputed as gross + commission + swap. Older reports lack
# feeAlloc and can only fill nulls, so they never clobber corrected values.
_FEE_COLS = ("gross_profit", "commission", "swap")
FEE_ALLOC_STABLE = 2


def platform_position_facts(db: Session, user_id: str, login: str, position_ticket: int) -> dict:
    """平台自己记的开仓事实：开仓单的成交价 / 成交时间 / 止损止盈，再叠加之后成功的改单。

    The platform's own record of a position: the filled opening order's price,
    time and SL/TP, overlaid with the latest successful MODIFY for it.
    """
    same_login = or_(Order.mt5_login == login, Order.mt5_login.is_(None))
    pos = int(position_ticket)
    # 仓位号按 trade_performance.position_id_of 的单值规则取：有 mt5_position 就只认
    # 它，没有才回落到 mt5_ticket。以前只比 mt5_position，而桥接的市价单只写
    # mt5_ticket（MT5 里市价单的订单号即仓位号），于是桥接账号的开仓价/时间/止损止盈
    # 永远兜底不上。回落只在 mt5_position 为空时生效：网关单的 mt5_ticket 是订单号或
    # 成交号、与仓位号不同编号，拿它去撞会把别的仓位的事实安到这笔平仓上。
    # Position id per trade_performance.position_id_of's single-value rule:
    # mt5_position when present, else mt5_ticket. Matching mt5_position alone
    # left bridge accounts blank, since bridge market orders only set mt5_ticket
    # (in MT5 a market order's ticket is the position id). The fallback applies
    # only when mt5_position is null: a gateway mt5_ticket is an order/deal number
    # in a different numbering space and would attach another position's facts.
    opening = (
        db.query(Order)
        .filter(
            Order.user_id == user_id,
            OPENED_POSITION,
            or_(
                Order.mt5_position == pos,
                and_(Order.mt5_position.is_(None), Order.mt5_ticket == pos),
            ),
            same_login,
        )
        .order_by(Order.created_at.desc())
        .first()
    )
    if opening is None:
        return {}
    facts = {
        "open_price": opening.filled_price,
        "open_time": opening.updated_at or opening.created_at,
        "sl": opening.sl or None,
        "tp": opening.tp or None,
    }
    modify = (
        db.query(Order)
        .filter(
            Order.user_id == user_id,
            Order.action == "MODIFY",
            Order.status == "FILLED",
            Order.ticket == pos,
            same_login,
        )
        .order_by(Order.created_at.desc())
        .first()
    )
    if modify is not None:
        if modify.sl:
            facts["sl"] = modify.sl
        if modify.tp:
            facts["tp"] = modify.tp
    return facts


def _detail_values(leg: dict) -> dict:
    """载荷 → 列值。0 的止损 / 止盈和空注释按"没有"处理，免得把 0 当成真实值存进去。
    Payload → column values; zero SL/TP and empty comments count as absent."""
    out = {}
    for key, col in DETAIL_KEYS.items():
        val = leg.get(key)
        if col in ("sl", "tp") and not val:
            val = None
        if col == "comment" and isinstance(val, str) and not val.strip():
            val = None
        out[col] = val
    return out


def _find(db: Session, user_id: str, login: str, deal_ticket: int) -> ClosedTrade | None:
    return (
        db.query(ClosedTrade)
        .filter(
            ClosedTrade.user_id == user_id,
            ClosedTrade.mt5_login == login,
            ClosedTrade.deal_ticket == int(deal_ticket),
        )
        .first()
    )


def _finite_or_none(val):
    """非有限浮点（NaN / ±Infinity）一律当"没有"。NaN 落库后任何比较都是 False、求和
    全变 NaN，榜单 / 统计会整页 500 或排序错乱。
    Non-finite floats count as absent: a stored NaN poisons every sum and comparison."""
    if isinstance(val, float) and not math.isfinite(val):
        return None
    return val


def upsert_leg(
    db: Session, user_id: str, login: str, leg: dict, verified: bool | None,
    *, trusted: bool = False,
) -> str:
    """插入一条平仓腿；去重键已存在则只补空列。返回 'inserted' / 'enriched' / 'unchanged'。

    `verified` 只在插入时写入，补列不会改变已有记录的核验结论。
    `trusted`：数据是否来自服务端自己读券商（网关通道）。桥接（用户侧程序）是不可信
    通道：对已入库且 verified 的腿，它的重发（含 feeAlloc=2）只能补空列，不能改毛盈亏 /
    净盈亏——否则先报一条真腿拿到 verified，再重发一次把盈利改大，就绕过了归属核验。
    Insert a leg, or back-fill null columns on an existing one. `verified` is
    written on insert only; enrichment never changes an existing verdict.
    `trusted` marks the server's own broker read (gateway). An untrusted (bridge)
    re-send may only fill nulls on a stored verified leg — never rewrite its
    gross / net P&L, or a verified real leg could be re-sent with a bigger profit.
    """
    # 非有限的盈亏不落库（schema 已在入口拦，这里是给网关通道 / 内部调用兜底）。
    # Non-finite P&L is never stored (the bridge schema rejects it; this backs up other callers).
    if not isinstance(leg.get("profit"), (int, float)) or not math.isfinite(leg["profit"]):
        return "unchanged"
    details = {col: _finite_or_none(val) for col, val in _detail_values(leg).items()}
    if any(details[c] is None for c in _FALLBACK_COLS):
        facts = platform_position_facts(db, user_id, login, leg["positionTicket"])
        for c in _FALLBACK_COLS:
            if details[c] is None and facts.get(c) is not None:
                details[c] = facts[c]

    existing = _find(db, user_id, login, leg["dealTicket"])
    if existing is None:
        db.add(ClosedTrade(
            user_id=user_id,
            mt5_login=login,
            symbol=leg["symbol"],
            side=leg["side"],
            close_volume=leg["closeVolume"],
            close_price=leg["closePrice"],
            profit=leg["profit"],
            position_ticket=leg["positionTicket"],
            deal_ticket=leg["dealTicket"],
            closed_at=leg["closedAt"],
            verified=verified,
            **details,
        ))
        try:
            db.commit()
            return "inserted"
        except IntegrityError:
            # 并发上报撞在一起（桥接重试 / 快慢两拍）：回退后走补列路径
            # Concurrent duplicate (bridge retry / fast+slow gateway ticks): fall through to enrich
            db.rollback()
            existing = _find(db, user_id, login, leg["dealTicket"])
            if existing is None:
                return "unchanged"

    authoritative = (
        (trusted or existing.verified is not True)
        and leg.get("feeAlloc") == FEE_ALLOC_STABLE
        and leg.get("openPrice") is not None
        and all(details[c] is not None for c in _FEE_COLS)
    )
    changed = False
    for col, val in details.items():
        if val is None:
            continue
        cur = getattr(existing, col)
        overwrite = authoritative and col in _FEE_COLS and cur is not None and abs(cur - val) > 0.005
        if cur is None or overwrite:
            setattr(existing, col, val)
            changed = True
    if authoritative:
        net = details["gross_profit"] + details["commission"] + details["swap"]
        if existing.profit is None or abs(existing.profit - net) > 0.005:
            existing.profit = net
            changed = True
    if changed:
        db.commit()
        return "enriched"
    return "unchanged"


def logins_needing_backfill(db: Session, user_id: str, logins: list[str] | set[str]) -> list[str]:
    """近一年内还有缺开仓时间的平仓记录的账号——需要通道做一次性回扫补齐。

    Accounts with closed legs from the last year still missing open_time,
    i.e. rows written before the detail columns existed.
    """
    logins = [str(x) for x in logins if x]
    if not logins:
        return []
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=BACKFILL_DAYS)
    rows = (
        db.query(ClosedTrade.mt5_login)
        .filter(
            ClosedTrade.user_id == user_id,
            ClosedTrade.mt5_login.in_(logins),
            ClosedTrade.open_time.is_(None),
            ClosedTrade.closed_at >= since,
        )
        .distinct()
        .all()
    )
    return sorted({r[0] for r in rows})


# ─────────────────────────────────────────────────────────────────────────────
# 桥接平仓腿的盈亏合理性核对（2026-10-10 产品决定：桥接用户留在公开榜单上，但服务端
# 要拿自己的行情数据核一遍）。
#
# 桥接是用户自己电脑上的程序，上报的 profit 理论上可以随便填。归属核验（仓位号对得上
# 本平台订单）只证明"这笔仓位是我们开的"，证明不了"它赚了这么多"。这里用 Candle 表里
# [开仓, 平仓] 区间的最高 / 最低价，算出这条腿**物理上最多**能赚 / 亏多少：
#     (区间最高 - 区间最低) × 平仓手数 × 合约规模 × 换算到美元 × 账户币种倍数
# 再给 1.5 倍 + 手续费 / 隔夜利息 / 少量绝对余量。超出的腿照常入库，但标 verified=False，
# 所有公开统计（榜单 / 勋章 / 公开主页胜率）只认 verified=True，于是它不计分。
#
# 拿不到行情或合约规格时不拦：退回按账户余额 / 净值的宽松上限，再拿不到就放行。
# 网关通道不走这里——那是服务端自己从券商读的。
#
# Bridge-leg plausibility (product decision 2026-10-10: bridge users stay on public
# boards, but the server checks the reported P&L against its own market data). The
# candle high/low over [open, close] bounds what the leg could physically make; legs
# beyond 1.5x that (plus fees / small margin) are stored with verified=False, which
# every public statistic already excludes. No candles or no contract spec -> fall back
# to a loose cap relative to the account's balance/equity, else accept.
# ─────────────────────────────────────────────────────────────────────────────

logger = logging.getLogger("prismx.closed_trades")

# 每手合约规模的服务端兜底表，与前端 api/utils.ts 的 CONTRACT_SIZE 一致（按合作券商品种表
# 填）。**不用**桥接按账户上报的 contractSize：那和 profit 出自同一个不可信程序，伪造盈利的
# 人同样会把它改大。表外的非外汇品种（指数等）合约规模未知 → 走余额兜底。
# Server-side contract sizes mirroring the frontend fallback table. The bridge's own
# contractSize is deliberately not used: it comes from the same untrusted program.
_CONTRACT_SIZE: dict[str, float] = {
    "XAUUSD": 100.0,
    "XAGUSD": 5000.0,
    "BTCUSD": 1.0,
    "ETHUSD": 10.0,
    "WTI": 100.0,
}
_FX_CONTRACT_SIZE = 100000.0
_FX_CCYS = frozenset({
    "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SGD", "HKD", "CNH",
    "SEK", "NOK", "DKK", "ZAR", "MXN", "TRY", "PLN",
})
# 账户币种 → 美元金额换成账户金额的倍数上限。美分账户（USC）同一笔盈利数字大 100 倍。
# 币值不低于 1 美元的按 1（金额数字只会更小，界更宽）；其它币种换算不了 → 走兜底。
# Account currency -> multiplier from USD to account units. Cent accounts are 100x;
# currencies worth >= 1 USD use 1 (looser); anything else falls back.
_ACCOUNT_CCY_MULT: dict[str, float] = {
    "": 1.0, "USD": 1.0, "USDT": 1.0, "EUR": 1.0, "GBP": 1.0, "CHF": 1.0,
    "USC": 100.0, "USX": 100.0,
}

PLAUSIBILITY_RANGE_SLACK = 1.5          # 区间理论最大值的倍数 / multiple of the theoretical max
PLAUSIBILITY_ABS_MARGIN_USD = 20.0      # 绝对余量（美元）/ absolute margin in USD
PLAUSIBILITY_FEE_PER_LOT_USD = 50.0     # 每手手续费余量 / commission allowance per lot
PLAUSIBILITY_SWAP_PER_DAY = 0.002       # 每持仓日按名义价值 0.2% 给隔夜利息余量 / swap allowance
FALLBACK_BALANCE_MULT = 10.0            # 兜底：单腿盈利不超过余额 / 净值的倍数 / fallback cap
FALLBACK_ABS_MARGIN_USD = 100.0

# M1 只在短持仓上用（区间最贴近真实）；更长的、或 M1 已过保留期的用 H1 / 日线。
# M1 only for short holds; longer ones (or M1 past retention) use H1 / daily bars.
_M1_MAX_SPAN = 24 * 3600
_H1_MAX_SPAN = 60 * 86400
_INTERVAL_SECONDS = {"1": 60, "60": 3600, "D": 86400}

_RANGE_CACHE_MAX = 4096
_range_cache: "OrderedDict[tuple, tuple[float, float, int] | None]" = OrderedDict()
_range_lock = threading.Lock()


def _is_fx(sym: str) -> bool:
    return len(sym) == 6 and sym[:3] in _FX_CCYS and sym[3:] in _FX_CCYS and sym[:3] != sym[3:]


def _base_symbol(symbol: str, suffix: str | None = None) -> str:
    """券商品种名 → 平台基础名：去掉账户后缀与 '.', '#', '_', '-' 之后的部分，再归一别名。
    Broker symbol -> platform base name (strip the account suffix and anything after
    '.', '#', '_' or '-'; then normalise aliases)."""
    from app.services.symbol_aliases import broker_symbol

    s = (symbol or "").strip()
    suf = (suffix or "").strip()
    if suf and len(s) > len(suf) and s.endswith(suf):
        s = s[: -len(suf)]
    s = re.split(r"[.#_\-]", s, maxsplit=1)[0].upper()
    s = broker_symbol(s)
    if s not in _CONTRACT_SIZE and not _is_fx(s) and len(s) > 6:
        head = broker_symbol(s[:6])
        if head in _CONTRACT_SIZE or _is_fx(head):
            s = head          # 'XAUUSDm' 这类无分隔符的后缀 / suffix glued on without a separator
    return s


def _usd_factor(sym: str, low: float) -> float | None:
    """价格变动 × 合约规模 → 美元的换算系数上界；未知品种 None。
    Upper bound on the factor turning (price move x contract) into USD."""
    if sym in _CONTRACT_SIZE or sym.endswith("USD"):
        return 1.0
    if not _is_fx(sym):
        return None
    if sym.startswith("USD"):
        # 计价货币金额 ÷ 现价；取区间最低价 → 系数最大，界最宽。
        # Quote-currency amount / price; the window low gives the loosest bound.
        return 1.0 / low if low > 0 else None
    # 交叉盘：计价货币对美元汇率的宽松上界。JPY 计价：USDJPY 现代史上从未低于 75 → 取 1/50；
    # 其余计价货币（GBP/EUR/CHF/CAD/AUD/NZD…）都不到 2 美元。
    # Crosses: a loose bound on the quote currency's USD value.
    return 0.02 if sym.endswith("JPY") else 2.0


def _price_range(db: Session, sym: str, t0: int, t1: int) -> tuple[float, float, int] | None:
    """区间 [t0, t1] 内 Candle 的 (最高, 最低, 根数)；没数据 None。短持仓先 M1，没有再退
    H1 / 日线。按 (品种, 周期, 取整后的区间) 进程内缓存——已收盘的 K 线不会再变。
    (high, low, bars) over [t0, t1], or None. M1 for short holds, then H1 / daily.
    Cached per (symbol, interval, rounded window): closed bars never change."""
    from app.services.symbol_aliases import symbol_match_set

    names = tuple(sorted(set(symbol_match_set(sym)) | {sym}))
    span = max(0, t1 - t0)
    intervals = ["1"] if span <= _M1_MAX_SPAN else []
    intervals.append("60" if span <= _H1_MAX_SPAN else "D")
    for interval in intervals:
        step = _INTERVAL_SECONDS[interval]
        # 往前多带一根：开仓那一刻所在的那根 K 线开盘时间早于 t0。
        # One extra bar back: the bar containing t0 opens before it.
        lo_t = (t0 // step) * step - step
        hi_t = -(-t1 // step) * step
        key = (names, interval, lo_t, hi_t)
        with _range_lock:
            hit = key in _range_cache
            if hit:
                _range_cache.move_to_end(key)
                got = _range_cache[key]
        if not hit:
            row = (
                db.query(func.max(Candle.h), func.min(Candle.l), func.count(Candle.t))
                .filter(
                    Candle.symbol.in_(names),
                    Candle.interval == interval,
                    Candle.t >= lo_t,
                    Candle.t <= hi_t,
                )
                .one()
            )
            got = None
            if row is not None and row[2] and row[0] is not None and row[1] is not None:
                h, low = float(row[0]), float(row[1])
                if math.isfinite(h) and math.isfinite(low) and h >= low > 0:
                    got = (h, low, int(row[2]))
            with _range_lock:
                _range_cache[key] = got
                while len(_range_cache) > _RANGE_CACHE_MAX:
                    _range_cache.popitem(last=False)
        if got is not None:
            return got
    return None


def _epoch(dt: datetime | None) -> int | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def max_plausible_profit(
    db: Session,
    leg: dict,
    *,
    account_currency: str | None = None,
    symbol_suffix: str | None = None,
) -> float | None:
    """这条腿按服务端行情最多可能的 |盈亏|（账户币种）；行情 / 规格 / 币种任一缺失返回 None。
    The largest |P&L| this leg could physically have (account currency), or None when
    candles, contract spec or currency conversion are unavailable."""
    mult = _ACCOUNT_CCY_MULT.get((account_currency or "").strip().upper())
    if mult is None:
        return None
    sym = _base_symbol(leg.get("symbol") or "", symbol_suffix)
    contract = _CONTRACT_SIZE.get(sym) or (_FX_CONTRACT_SIZE if _is_fx(sym) else None)
    if contract is None:
        return None
    t1 = _epoch(leg.get("closedAt"))
    t0 = _epoch(leg.get("openTime"))
    if t1 is None or t0 is None or t0 > t1:
        return None
    rng = _price_range(db, sym, t0, t1)
    if rng is None:
        return None
    high, low, _n = rng
    conv = _usd_factor(sym, low)
    if conv is None:
        return None
    volume = abs(float(leg.get("closeVolume") or 0.0))
    move_usd = (high - low) * volume * contract * conv
    notional_usd = high * volume * contract * conv
    days = (t1 - t0) / 86400.0 + 1.0
    allowance = (
        PLAUSIBILITY_ABS_MARGIN_USD
        + volume * PLAUSIBILITY_FEE_PER_LOT_USD
        + notional_usd * PLAUSIBILITY_SWAP_PER_DAY * days
    )
    return (PLAUSIBILITY_RANGE_SLACK * move_usd + allowance) * mult


def leg_profit_plausible(
    db: Session,
    leg: dict,
    *,
    account_currency: str | None = None,
    symbol_suffix: str | None = None,
    balance: float | None = None,
    equity: float | None = None,
) -> tuple[bool, str]:
    """桥接平仓腿的盈亏是否可信。返回 (是否可信, 依据)：'range'（行情区间）/ 'balance'
    （余额兜底）/ 'none'（无从核对，放行）。
    Whether a bridge leg's P&L is plausible: (ok, basis) with basis 'range' (candle
    bound), 'balance' (fallback cap) or 'none' (nothing to check against -> accepted)."""
    profit = leg.get("profit")
    if not isinstance(profit, (int, float)) or not math.isfinite(profit):
        return False, "range"
    try:
        bound = max_plausible_profit(
            db, leg, account_currency=account_currency, symbol_suffix=symbol_suffix
        )
    except Exception:  # noqa: BLE001 — 核对是附加闸门，查询出错不能把整批上报打成 500
        logger.exception("平仓腿合理性核对失败，按无数据处理 / plausibility check failed")
        bound = None
    if bound is not None:
        return abs(profit) <= bound, "range"
    # 兜底：只拦盈利（伪造的方向），亏损可以超过爆仓后的余额。余额 / 净值也是自报的，
    # 所以这只是个宽松的粗筛。
    # Fallback: only gains are capped (the forging direction); a loss can exceed the
    # post-blow-up balance. Balance is self-reported too, so this is a loose screen.
    base = max(
        (v for v in (balance, equity) if isinstance(v, (int, float)) and math.isfinite(v)),
        default=None,
    )
    if base is not None and base > 0:
        mult = _ACCOUNT_CCY_MULT.get((account_currency or "").strip().upper(), 1.0)
        cap = FALLBACK_BALANCE_MULT * base + FALLBACK_ABS_MARGIN_USD * mult
        return profit <= cap, "balance"
    return True, "none"


def reset_plausibility_cache_for_tests() -> None:
    with _range_lock:
        _range_cache.clear()
