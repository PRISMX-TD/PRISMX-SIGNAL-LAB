"""交易人格与月度报告的数据源：把一个用户在某段时间里**已平仓的实盘仓位**整理成一条条记录。

口径（方案第 4 节，2026-11-22 定）：
- 只算实盘（orders.trade_mode = 2）、只算本平台下的单、只算整仓平完的仓位；一笔分几次平仓合并成一笔。
- 仓位落在哪段时间按**平仓时刻**（最后一条平仓腿）判断。
- 盈亏是 MT5 算好的净盈亏（含手续费、隔夜费），各平仓腿加总。
- 开仓时刻用平台记录的下单时间（orders.created_at，UTC），平仓时刻用平仓腿的 closed_at（UTC）。
- 改单只认成功的 MODIFY 指令；client_order_id 以 auto_ 开头的是智能风控改的，单独标出来。

Data source for personas and monthly reports: a user's *closed real-account positions* in a window.
Real accounts only, platform orders only, whole positions only (partial closes merged). A position
belongs to the window of its final close. Profit is MT5's net profit summed over the legs. Open time
is the platform's order time, close time the leg's closed_at (both UTC). Only successful MODIFY
commands count as edits; client ids starting with auto_ are smart-risk edits and are flagged.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.models import AutoManagedPosition, Order
from app.services.gamification.stats import (
    REAL, _filled_orders, _legs_by_position, _resolve, lot_weight,
)
from app.services.order_payload import is_reverse_order
from app.services.trade_performance import position_id_of
from app.utils.timeutil import aware

# 智能风控改单的 client_order_id 前缀（与 services/auto_manage.AUTO_PREFIX 相同；不直接 import，
# 那个模块会把行情、推送一整串依赖带进来）。
# Smart-risk modify id prefix, same as services/auto_manage.AUTO_PREFIX (not imported: that module
# drags in quotes, push and more).
AUTO_PREFIX = "auto_"

# 平仓腿 reason 里表示「被强制平仓」的取值（两条通道转好的名字都是 SO）。
# The close-leg reason for a stop-out (both channels map it to SO).
STOP_OUT_REASONS = frozenset({"SO"})
# 平仓腿 reason 里表示「到了止损 / 止盈」的取值；其余（CLIENT / WEB / MOBILE / EXPERT …）当手动平。
# Reasons for a stop-loss / take-profit hit; anything else counts as a manual close.
SL_REASONS = frozenset({"SL"})
TP_REASONS = frozenset({"TP"})

# 仓位最长能持多久还被算进窗口：开仓早于「窗口起点 − 这么多天」的单不读，免得把一个人的全部历史读进来。
# Positions opened more than this before the window start aren't read (keeps the query bounded).
OPEN_LOOKBACK_DAYS = 60


@dataclass
class Edit:
    at: datetime
    sl: float | None
    tp: float | None
    prev_sl: float | None
    prev_tp: float | None
    auto: bool


@dataclass
class Position:
    login: str
    ticket: int
    symbol: str
    side: str                      # BUY / SELL
    volume: float                  # 手数（原始）/ raw lots
    weighted_volume: float         # 按品种折算后的手数 / lots weighted per symbol
    open_at: datetime
    close_at: datetime
    profit: float
    source: str                    # signal / reverse / strategy / chart
    open_price: float | None = None
    close_price: float | None = None
    sl_at_open: float | None = None
    tp_at_open: float | None = None
    sl_at_close: float | None = None
    tp_at_close: float | None = None
    close_reason: str | None = None
    stopped_out: bool = False
    auto_managed: bool = False
    edits: list[Edit] = field(default_factory=list)
    # 月底存档时还没平的浮亏单（方案第 4 节）：profit 是当时的浮动盈亏，close_at 是存档时刻。
    # A still-open losing position counted at month-end archive: profit is the floating P&L then.
    unrealized: bool = False

    @property
    def hold_seconds(self) -> float:
        return max(0.0, (self.close_at - self.open_at).total_seconds())

    @property
    def is_win(self) -> bool:
        return self.profit > 0

    @property
    def from_signal(self) -> bool:
        """判断主轴的「跟信号」：反着信号做的单算自主（方案 5.1）。/ Reverse copies count as own."""
        return self.source == "signal"

    @property
    def manual_close(self) -> bool:
        return not self.unrealized and not self.stopped_out and (self.close_reason or "").upper() not in SL_REASONS | TP_REASONS


def _source_of(o: Order) -> str:
    if getattr(o, "signal_id", None):
        return "reverse" if is_reverse_order(o) else "signal"
    if getattr(o, "source", None) == "STRATEGY":
        return "strategy"
    return "chart"


def _utc(dt: datetime | None) -> datetime | None:
    return aware(dt) if dt is not None else None


def load_positions(db, user_id: str, since: datetime, until: datetime) -> list[Position]:
    """[since, until) 里平完的实盘仓位，按开仓时间排序。since / until 带时区（UTC）。
    Closed real positions whose final close falls in [since, until), sorted by open time."""
    orders = _filled_orders(db, user_id, cutoff=(since - timedelta(days=OPEN_LOOKBACK_DAYS)).replace(tzinfo=None),
                            modes=[REAL], before=until.replace(tzinfo=None))
    if not orders:
        return []
    keys = {(o.mt5_login, position_id_of(o)) for o in orders if position_id_of(o)}
    legs_map = _legs_by_position(db, user_id, keys)
    resolved = _resolve(orders, legs_map)
    if not resolved:
        return []
    picked: list[tuple[Order, float, list]] = []
    for o, profit in resolved:
        legs = sorted(legs_map.get((o.mt5_login, position_id_of(o)), []), key=lambda l: _utc(l.closed_at))
        close_at = _utc(legs[-1].closed_at)
        if close_at is None or not (since <= close_at < until) or o.created_at is None:
            continue
        picked.append((o, profit, legs))
    if not picked:
        return []
    tickets = [position_id_of(o) for o, _, _ in picked]
    edits = _edits_by_ticket(db, user_id, tickets, since)
    managed = _auto_managed(db, user_id, tickets)
    out: list[Position] = []
    for o, profit, legs in picked:
        pid = position_id_of(o)
        vol = sum(l.close_volume or 0 for l in legs) or (o.volume or 0)
        close_px = (sum((l.close_price or 0) * (l.close_volume or 0) for l in legs) / vol) if vol else legs[-1].close_price
        last = legs[-1]
        out.append(Position(
            login=o.mt5_login or "",
            ticket=int(pid),
            symbol=(o.symbol or "").split(".")[0].upper(),
            side=(o.side or "").upper(),
            volume=float(o.volume or 0),
            weighted_volume=float(o.volume or 0) * lot_weight(o.symbol),
            open_at=_utc(o.created_at),
            close_at=_utc(last.closed_at),
            profit=float(profit or 0),
            source=_source_of(o),
            open_price=o.filled_price or legs[0].open_price,
            close_price=close_px,
            sl_at_open=o.sl,
            tp_at_open=o.tp,
            sl_at_close=last.sl,
            tp_at_close=last.tp,
            close_reason=(last.reason or None),
            stopped_out=any((l.reason or "").upper() in STOP_OUT_REASONS for l in legs),
            auto_managed=(o.mt5_login, int(pid)) in managed or int(pid) in managed,
            edits=edits.get((o.mt5_login, int(pid)), []),
        ))
    out.sort(key=lambda p: p.open_at)
    return out


def _edits_by_ticket(db, user_id: str, tickets: list[int], since: datetime) -> dict:
    """成功的改止损止盈指令，按 (账号, 仓位号) 分组、按时间排序。
    Successful SL/TP modify commands grouped by (login, position ticket), oldest first."""
    if not tickets:
        return {}
    rows = (db.query(Order)
              .filter(Order.user_id == user_id, Order.action == "MODIFY", Order.status == "FILLED",
                      Order.ticket.in_(tickets),
                      Order.created_at >= (since - timedelta(days=OPEN_LOOKBACK_DAYS)).replace(tzinfo=None))
              .all())
    out: dict = defaultdict(list)
    for r in rows:
        out[(r.mt5_login, int(r.ticket))].append(Edit(
            at=_utc(r.created_at), sl=r.sl, tp=r.tp, prev_sl=r.prev_sl, prev_tp=r.prev_tp,
            auto=(r.client_order_id or "").startswith(AUTO_PREFIX),
        ))
    for v in out.values():
        v.sort(key=lambda e: e.at)
    return out


def _auto_managed(db, user_id: str, tickets: list[int]) -> set:
    """被智能风控接管过的仓位。/ Positions smart risk management picked up."""
    if not tickets:
        return set()
    rows = (db.query(AutoManagedPosition.mt5_login, AutoManagedPosition.position_ticket)
              .filter(AutoManagedPosition.user_id == user_id, AutoManagedPosition.position_ticket.in_(tickets))
              .all())
    out: set = set()
    for login, ticket in rows:
        out.add((login, int(ticket)) if login else int(ticket))
    return out


def open_losing_positions(db, user_id: str, rows: list[dict], now: datetime) -> list[Position]:
    """月底存档用：把持仓快照里浮亏的实盘仓位变成「按亏损计」的记录（方案第 4 节）。
    rows 是 connection_manager 的持仓快照行（ticket / login / profit / symbol / side / volume）。
    只认本平台开的实盘单；持有时间算到 now。
    Month-end archive: turn floating-loss real positions from the positions snapshot into losing
    records held until `now`. Only real-account positions this platform opened are used."""
    losing = []
    for r in rows or []:
        try:
            profit = float(r.get("profit") or 0)
            ticket = int(r.get("ticket") or 0)
        except (TypeError, ValueError):
            continue
        if profit >= 0 or not ticket:
            continue
        losing.append((str(r.get("login") or ""), ticket, profit))
    if not losing:
        return []
    tickets = [t for _, t, _ in losing]
    orders = (db.query(Order)
                .filter(Order.user_id == user_id, Order.action.in_(["ORDER", "PENDING"]), Order.trade_mode == REAL,
                        (Order.mt5_position.in_(tickets)) | (Order.mt5_ticket.in_(tickets)))
                .all())
    by_key = {}
    for o in orders:
        pid = position_id_of(o)
        if pid:
            by_key[(o.mt5_login or "", int(pid))] = o
    out = []
    for login, ticket, profit in losing:
        o = by_key.get((login, ticket))
        if o is None or o.created_at is None:
            continue
        out.append(Position(
            login=login, ticket=ticket, symbol=(o.symbol or "").split(".")[0].upper(), side=(o.side or "").upper(),
            volume=float(o.volume or 0), weighted_volume=float(o.volume or 0) * lot_weight(o.symbol),
            open_at=_utc(o.created_at), close_at=now, profit=profit, source=_source_of(o),
            open_price=o.filled_price, sl_at_open=o.sl, tp_at_open=o.tp, unrealized=True,
        ))
    return out


def has_real_orders(db, user_id: str) -> bool:
    """这个人有没有在实盘账户上下过单（决定未解锁时显示「开通实盘」还是「再交易几笔」）。
    Whether the user ever placed a real-account order (picks the locked-state hint)."""
    from app.services.order_payload import OPENED_POSITION
    return db.query(Order.id).filter(Order.user_id == user_id, OPENED_POSITION, Order.trade_mode == REAL).first() is not None


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
