"""已平仓明细的 MT5 完整字段：落库补齐、平台订单兜底、回扫判定、两条通道的取值。

运行：cd backend && python -m pytest tests/test_closed_trade_details.py
Closed-trade detail columns: upsert/enrich semantics, platform-order fallback,
backfill detection, and both channels' field extraction.
"""
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.models import ClosedTrade, Order, User
from app.routers.gateway import build_closed_trade_legs, gateway_deal_reason
from app.services.closed_trade_store import logins_needing_backfill, upsert_leg

_BRIDGE_DIR = Path(__file__).resolve().parents[2] / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

import mt5_worker  # noqa: E402

LOGIN = "500123"
NOW = datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.fixture()
def user(db_session):
    u = User(email="d@example.com", api_token="tok-d")
    db_session.add(u)
    db_session.commit()
    db_session.refresh(u)
    return u


def _leg(**over):
    base = dict(
        symbol="XAUUSD", side="BUY", closeVolume=1.0, closePrice=2010.0, profit=95.0,
        positionTicket=777, dealTicket=9001, closedAt=NOW,
    )
    base.update(over)
    return base


# ---------- 落库：插入 / 补空列 / 不覆盖 ----------

def test_duplicate_report_enriches_null_columns_only(db_session, user):
    assert upsert_leg(db_session, user.id, LOGIN, _leg(), True) == "inserted"
    # 旧版桥接的记录：明细列全空 / legacy row: detail columns empty
    row = db_session.query(ClosedTrade).one()
    assert row.open_price is None and row.gross_profit is None

    detailed = _leg(openPrice=2000.0, openTime=NOW - timedelta(hours=1), grossProfit=100.0,
                    commission=-3.0, swap=-2.0, sl=1990.0, tp=2020.0, reason="TP", comment="[tp 2020.00]",
                    profit=123.0)  # 净盈亏故意不同：已有值不得被覆盖 / must not overwrite
    assert upsert_leg(db_session, user.id, LOGIN, detailed, True) == "enriched"
    row = db_session.query(ClosedTrade).one()
    assert (row.open_price, row.gross_profit, row.commission, row.swap) == (2000.0, 100.0, -3.0, -2.0)
    assert (row.sl, row.tp, row.reason, row.comment) == (1990.0, 2020.0, "TP", "[tp 2020.00]")
    assert row.profit == 95.0, "已有列不覆盖 / existing values stay"

    assert upsert_leg(db_session, user.id, LOGIN, detailed, True) == "unchanged"
    assert db_session.query(ClosedTrade).count() == 1


def test_zero_sl_tp_and_blank_comment_count_as_absent(db_session, user):
    upsert_leg(db_session, user.id, LOGIN, _leg(sl=0.0, tp=0.0, comment="  "), True)
    row = db_session.query(ClosedTrade).one()
    assert row.sl is None and row.tp is None and row.comment is None


def test_platform_order_fills_open_facts_and_latest_modify(db_session, user):
    db_session.add(Order(
        user_id=user.id, client_order_id="c-1", action="ORDER", symbol="XAUUSD", side="BUY",
        volume=1.0, status="FILLED", mt5_login=LOGIN, mt5_ticket=1, mt5_position=777,
        filled_price=2001.5, sl=1980.0, tp=2030.0,
    ))
    db_session.add(Order(
        user_id=user.id, client_order_id="c-2", action="MODIFY", symbol="XAUUSD", side="BUY",
        volume=0.0, status="FILLED", mt5_login=LOGIN, ticket=777, sl=1995.0, tp=None,
    ))
    db_session.commit()

    upsert_leg(db_session, user.id, LOGIN, _leg(), True)
    row = db_session.query(ClosedTrade).one()
    assert row.open_price == 2001.5 and row.open_time is not None
    assert row.sl == 1995.0, "改单后的止损优先 / the later MODIFY wins"
    assert row.tp == 2030.0, "改单没动止盈就沿用开仓单 / untouched TP stays"


def test_channel_values_beat_platform_fallback(db_session, user):
    db_session.add(Order(
        user_id=user.id, client_order_id="c-3", action="ORDER", symbol="XAUUSD", side="BUY",
        volume=1.0, status="FILLED", mt5_login=LOGIN, mt5_ticket=2, mt5_position=777,
        filled_price=2001.5, sl=1980.0,
    ))
    db_session.commit()
    upsert_leg(db_session, user.id, LOGIN, _leg(openPrice=2002.0, sl=1985.0), True)
    row = db_session.query(ClosedTrade).one()
    assert (row.open_price, row.sl) == (2002.0, 1985.0)


# ---------- 回扫判定 ----------

def test_backfill_lists_only_accounts_with_legacy_rows(db_session, user):
    upsert_leg(db_session, user.id, LOGIN, _leg(dealTicket=1), True)
    upsert_leg(db_session, user.id, "600000", _leg(dealTicket=2, openTime=NOW, openPrice=1.0), True)
    # 一年多前的旧记录不算 / rows older than a year don't count
    upsert_leg(db_session, user.id, "700000", _leg(dealTicket=3, closedAt=NOW - timedelta(days=400)), True)
    assert logins_needing_backfill(db_session, user.id, [LOGIN, "600000", "700000"]) == [LOGIN]
    assert logins_needing_backfill(db_session, user.id, []) == []


# ---------- 网关通道：成交记录 → 载荷 ----------

@dataclass
class FakeDeal:
    ticket: int
    position_id: int
    symbol: str
    action: int
    entry: int
    volume: float
    price: float
    profit: float
    comment: str
    commission: float = 0.0
    storage: float = 0.0
    time: int = 1_785_936_973
    reason: int = -1
    sl: float = 0.0
    tp: float = 0.0


def test_gateway_legs_carry_open_facts_fees_and_reason():
    deals = [
        FakeDeal(ticket=1, position_id=50, symbol="XAUUSD.s", action=0, entry=0, volume=1.0, price=4000.0,
                 profit=0.0, comment="PRISMX", commission=-4.0, time=1_785_930_000, sl=3990.0, tp=4020.0),
        FakeDeal(ticket=2, position_id=50, symbol="XAUUSD.s", action=1, entry=1, volume=0.4, price=4010.0,
                 profit=400.0, comment="", storage=-1.0, time=1_785_936_000, reason=4, sl=3995.0, tp=4020.0),
        FakeDeal(ticket=3, position_id=50, symbol="XAUUSD.s", action=1, entry=1, volume=0.6, price=4020.0,
                 profit=1200.0, comment="[tp 4020.00]", storage=-1.5, time=1_785_936_973, reason=4),
    ]
    legs = build_closed_trade_legs(deals, "PRISMX", {50}, server_offset_seconds=3 * 3600)
    assert [l["dealTicket"] for l in legs] == [2, 3]
    first, second = legs
    assert first["openPrice"] == 4000.0
    assert first["openTime"] == datetime.fromtimestamp(1_785_930_000 - 3 * 3600, tz=timezone.utc)
    assert first["grossProfit"] == 400.0 and second["grossProfit"] == 1200.0
    # 手续费 -4、隔夜 -2.5 按 0.4 / 0.6 分摊 / fees allocated 0.4 : 0.6
    assert first["commission"] == pytest.approx(-1.6) and second["commission"] == pytest.approx(-2.4)
    assert first["swap"] == pytest.approx(-1.0) and second["swap"] == pytest.approx(-1.5)
    assert first["profit"] == pytest.approx(400.0 - 1.6 - 1.0)
    assert first["sl"] == 3995.0, "平仓腿自带的止损优先 / the closing deal's own SL wins"
    assert second["sl"] == 3990.0, "平仓腿没带就退到开仓腿 / else the opening leg's"
    assert first["tp"] == 4020.0 and second["tp"] == 4020.0
    assert first["reason"] == "TP" and second["comment"] == "[tp 4020.00]"


def test_gateway_legs_without_opening_leg_leave_open_facts_empty():
    deals = [FakeDeal(ticket=9, position_id=51, symbol="EURUSD.s", action=0, entry=1, volume=1.0,
                      price=1.1, profit=-50.0, comment="", reason=3)]
    (leg,) = build_closed_trade_legs(deals, "PRISMX", {51})
    assert leg["openPrice"] is None and leg["openTime"] is None
    assert leg["sl"] is None and leg["reason"] == "SL"


def test_gateway_reason_mapping():
    assert gateway_deal_reason(3) == "SL" and gateway_deal_reason(4) == "TP" and gateway_deal_reason(5) == "SO"
    assert gateway_deal_reason(16) == "MOBILE" and gateway_deal_reason(99) == "OTHER"
    assert gateway_deal_reason(-1) is None and gateway_deal_reason(None) is None


# ---------- 桥接通道：仓位成交 + 订单历史 → 开仓事实 ----------

def _fake_mt5(orders):
    return SimpleNamespace(
        DEAL_ENTRY_IN=0, DEAL_ENTRY_OUT=1, DEAL_ENTRY_INOUT=2,
        DEAL_REASON_CLIENT=0, DEAL_REASON_MOBILE=1, DEAL_REASON_WEB=2, DEAL_REASON_EXPERT=3,
        DEAL_REASON_SL=4, DEAL_REASON_TP=5, DEAL_REASON_SO=6, DEAL_REASON_ROLLOVER=7,
        DEAL_REASON_VMARGIN=8, DEAL_REASON_SPLIT=9,
        history_orders_get=lambda position=None: orders,
    )


def test_bridge_position_facts_and_reason(monkeypatch):
    opening = SimpleNamespace(ticket=11, time_setup=100, sl=1990.0, tp=2020.0, price_open=2000.0)
    closing = SimpleNamespace(ticket=12, time_setup=200, sl=0.0, tp=0.0, price_open=1992.5)
    monkeypatch.setattr(mt5_worker, "mt5", _fake_mt5([closing, opening]))
    monkeypatch.setattr(mt5_worker, "_utc_offset_seconds", lambda login: 0.0)
    deals = [
        SimpleNamespace(entry=0, volume=1.0, price=2000.0, time=1_700_000_000, commission=-5.0, swap=0.0, order=11),
        SimpleNamespace(entry=1, volume=1.0, price=1992.5, time=1_700_003_600, commission=0.0, swap=-1.0, order=12),
    ]
    facts = mt5_worker._position_facts(777, deals, LOGIN)
    assert facts["open_price"] == 2000.0
    assert facts["open_time"] == datetime.fromtimestamp(1_700_000_000, tz=timezone.utc).isoformat()
    assert (facts["commission"], facts["swap"], facts["out_volume"]) == (-5.0, -1.0, 1.0)
    assert (facts["sl"], facts["tp"]) == (1990.0, 2020.0), "开仓单上的初值 / the opening order's values"
    assert facts["orders"][12] is closing

    assert mt5_worker._deal_reason_name(4) == "SL"
    assert mt5_worker._deal_reason_name(5) == "TP"
    assert mt5_worker._deal_reason_name(0) == "CLIENT"
    assert mt5_worker._deal_reason_name(42) == "OTHER"
    assert mt5_worker._deal_reason_name(None) is None
