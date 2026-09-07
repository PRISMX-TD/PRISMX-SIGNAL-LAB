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

from datetime import datetime, timedelta, timezone

from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import ClosedTrade, Order

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
    opening = (
        db.query(Order)
        .filter(
            Order.user_id == user_id,
            Order.action == "ORDER",
            Order.status == "FILLED",
            Order.mt5_position == int(position_ticket),
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
            Order.ticket == int(position_ticket),
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


def upsert_leg(db: Session, user_id: str, login: str, leg: dict, verified: bool | None) -> str:
    """插入一条平仓腿；去重键已存在则只补空列。返回 'inserted' / 'enriched' / 'unchanged'。

    `verified` 只在插入时写入，补列不会改变已有记录的核验结论。
    Insert a leg, or back-fill null columns on an existing one. `verified` is
    written on insert only; enrichment never changes an existing verdict.
    """
    details = _detail_values(leg)
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
        leg.get("feeAlloc") == FEE_ALLOC_STABLE
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
