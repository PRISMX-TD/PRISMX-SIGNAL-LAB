"""2026-10-26 安全审计 A1：桥接上报的数据（server / login / 余额 / 持仓 / 成交）不能被当成核实过的。

每条用例对应 findings.json 里的一条线索，按攻击原样复现，断言修复后的安全行为：
  1. /bridge/result 不能给 gateway 账号的订单写仓位号（冒充平台单进 verified 统计）；
  2. 自报 server / login 命中号段规则时，实盘来源记 self，不记 login_rule；
  3. 桥接账号的实盘转化一律待审，不自动确认、不记到跟进客服名下；
  4. /bridge/poll 每用户账号行有绝对上限（PRO / 试用也一样）；
  5. 分账户报价键每用户封顶；
  6. /bridge/trade-history 单次条数与每用户未核验腿数封顶；
  7. 平仓腿合理性核对不再退回桥接自报的余额，也不能靠不报开仓时间 / 换品种关掉。

Bridge-ingress audit (A1): data the user's own bridge reports is never treated as verified.
"""
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.models import ActivityEvent, Candle, ClosedTrade, Conversion, FollowUp, MT5Account, Order, User
from app.routers import bridge as bridge_mod
from app.routers.bridge import (
    BridgeAccount, BridgeClosedTrade, BridgeClosedTradesRequest, BridgePollRequest, BridgeQuotesRequest,
    BridgeResultRequest, _report_accounts_db_work, _result_db_work, _trade_history_db_work, _upsert_account,
)
from app.services import closed_trade_store as cts
from app.services import connection_manager as cm
from app.services import conversions
from app.services.account_type import REAL, SOURCE_SELF
from app.services.connection_manager import ConnectionManager

T_OPEN = datetime(2026, 10, 5, 10, 0, tzinfo=timezone.utc)
T_CLOSE = T_OPEN + timedelta(minutes=30)


def _user(db, email, plan="PRO", **kw):
    u = User(email=email, api_token="tok_" + email, plan=plan, **kw)
    db.add(u)
    db.commit()
    return u


@pytest.fixture(autouse=True)
def _fresh_caches():
    cts.reset_plausibility_cache_for_tests()
    bridge_mod._status_cache.clear()
    yield
    cts.reset_plausibility_cache_for_tests()
    bridge_mod._status_cache.clear()


# ---- 1. /bridge/result 与 gateway 订单 / result vs gateway-account orders ------------

def test_bridge_result_cannot_attribute_positions_on_gateway_login(db_session):
    from app.routers.gateway import platform_positions

    u = _user(db_session, "a1r@t.co")
    db_session.add(MT5Account(user_id=u.id, login="700001", server="", source="gateway"))
    db_session.add_all([
        Order(user_id=u.id, client_order_id="ph-1", action="PENDING", status="PENDING", delivered=False,
              symbol="XAUUSD", side="BUY", volume=0.1, mt5_login=None),
        Order(user_id=u.id, client_order_id="ph-2", action="PENDING", status="CANCELLED",
              symbol="XAUUSD", side="BUY", volume=0.1, mt5_login=None),
        Order(user_id=u.id, client_order_id="ph-3", action="PENDING", status="FAILED",
              symbol="XAUUSD", side="BUY", volume=0.1, mt5_login="700001"),
    ])
    db_session.commit()
    for i, coid in enumerate(("ph-1", "ph-2", "ph-3")):
        _order, duplicate = _result_db_work(db_session, u.id, BridgeResultRequest(
            clientOrderId=coid, success=True, status="PLACED", mt5Ticket=987654 + i, login="700001"))
        assert duplicate is True                              # 不生效、按重复应答 / no-op
    rows = {o.client_order_id: o for o in db_session.query(Order).filter_by(user_id=u.id)}
    assert all(o.mt5_position is None and o.mt5_ticket is None for o in rows.values())
    assert rows["ph-1"].mt5_login is None and rows["ph-1"].status == "PENDING"
    assert rows["ph-2"].status == "CANCELLED" and rows["ph-3"].status == "FAILED"
    known, _ = platform_positions(db_session, u.id, "700001")
    assert known == set()


def test_bridge_result_still_works_for_bridge_orders(db_session):
    """对照：桥接账号的订单照常回执、补账号。/ Control: bridge orders unaffected."""
    u = _user(db_session, "a1r2@t.co")
    db_session.add(MT5Account(user_id=u.id, login="700001", server="", source="gateway"))
    db_session.add(MT5Account(user_id=u.id, login="500001", server="MakeCapital-Live", source="bridge"))
    db_session.add(Order(user_id=u.id, client_order_id="ok-1", action="PENDING", status="PENDING",
                         symbol="XAUUSD", side="BUY", volume=0.1, mt5_login=None))
    db_session.commit()
    got, duplicate = _result_db_work(db_session, u.id, BridgeResultRequest(
        clientOrderId="ok-1", success=True, status="PLACED", mt5Ticket=42, login="500001"))
    assert duplicate is False
    assert (got.status, got.mt5_position, got.mt5_login) == ("PLACED", 42, "500001")


# ---- 2/3. 实盘来源与转化 / provenance and conversions --------------------------------

def test_self_reported_server_login_never_yields_rule_provenance(db_session):
    from app.services.gamification.loop import backfill_account_trade_modes

    u = _user(db_session, "bp1@t.co")
    row, _ = _upsert_account(db_session, u.id, BridgeAccount(
        login="600123", server="MakeCapital-Live", balance=600.0, tradeMode=2), 0, None)
    db_session.commit()
    assert (row.trade_mode, row.trade_mode_source) == (REAL, SOURCE_SELF)
    assert conversions.classify_mt5(row, ["MakeCapital"]) == conversions.STATUS_PENDING
    # 每小时回填同样不能把来源升级 / the hourly backfill must not upgrade it either
    db_session.add(MT5Account(user_id=u.id, source="bridge", server="MakeCapital-Live", login="600124",
                              trade_mode=2, trade_mode_source=SOURCE_SELF))
    db_session.commit()
    backfill_account_trade_modes(db_session)
    other = db_session.query(MT5Account).filter_by(user_id=u.id, login="600124").one()
    assert other.trade_mode_source == SOURCE_SELF


def test_legacy_rule_sourced_bridge_row_is_not_auto_confirmed(db_session):
    """老库里残留的 login_rule 桥接行也只进待审。/ Legacy rule-labelled bridge rows go to review."""
    u = _user(db_session, "bp2@t.co")
    row = MT5Account(user_id=u.id, source="bridge", server="MakeCapital-Live", login="600125",
                     trade_mode=2, trade_mode_source="login_rule")
    gw = MT5Account(user_id=u.id, source="gateway", server="", login="600126",
                    trade_mode=2, trade_mode_source="group")
    db_session.add_all([row, gw])
    db_session.commit()
    assert conversions.classify_mt5(row, ["MakeCapital"]) == conversions.STATUS_PENDING
    assert conversions.classify_mt5(gw, ["MakeCapital"]) == conversions.STATUS_CONFIRMED


def test_forged_bridge_poll_does_not_credit_support_agent(db_session):
    admin = _user(db_session, "boss1@t.co", role="admin")
    staff = _user(db_session, "agent1@t.co", role="support")
    c = _user(db_session, "cust1@t.co", plan="FREE")
    fu = FollowUp(user_id=c.id, assignee_id=staff.id, assigned_by=admin.id, goal="open_mt5",
                  status="pending", expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=30))
    db_session.add(fu)
    db_session.commit()
    _report_accounts_db_work(db_session, c, BridgePollRequest(
        accounts=[BridgeAccount(login="6000001", server="MakeCapital-Live")], fetchCommands=False))
    row = db_session.query(MT5Account).filter_by(user_id=c.id, login="6000001").one()
    assert (row.trade_mode, row.trade_mode_source) == (REAL, SOURCE_SELF)
    conv = db_session.query(Conversion).filter_by(user_id=c.id, kind="mt5_real").one()
    assert conv.status == conversions.STATUS_PENDING
    db_session.refresh(fu)
    assert fu.status == "pending"


# ---- 4. /bridge/poll 账号行上限 / account row bounds -----------------------------------

def test_poll_rejects_oversized_account_list():
    with pytest.raises(ValidationError):
        BridgePollRequest(accounts=[{"login": str(10000 + i), "server": "X"}
                                    for i in range(bridge_mod.MAX_POLL_ACCOUNTS + 1)])


def test_pro_poll_cannot_create_unbounded_account_rows(db_session):
    u = _user(db_session, "pro1@t.co", plan="PRO")
    for start in (10000, 10050):
        req = BridgePollRequest(fetchCommands=False, accounts=[
            BridgeAccount(login=str(start + i), server="MakeCapital-Live")
            for i in range(bridge_mod.MAX_POLL_ACCOUNTS)])
        _report_accounts_db_work(db_session, u, req)
    rows = db_session.query(MT5Account).filter_by(user_id=u.id).count()
    binds = db_session.query(ActivityEvent).filter_by(user_id=u.id, kind="mt5.bind").count()
    assert rows == bridge_mod.MAX_BRIDGE_ACCOUNTS
    assert binds == bridge_mod.MAX_BRIDGE_ACCOUNTS


def test_soft_removed_rows_count_toward_total_row_cap(db_session, monkeypatch):
    from app.services.gateway_binding import REASON_USER_REMOVED

    monkeypatch.setattr(bridge_mod, "MAX_BRIDGE_ACCOUNT_ROWS", 3)
    u = _user(db_session, "pro2@t.co", plan="PRO")
    for i in range(3):
        db_session.add(MT5Account(user_id=u.id, login=str(20000 + i), server="MakeCapital-Live",
                                  source="bridge", revoked_at=datetime.now(timezone.utc),
                                  revoked_reason=REASON_USER_REMOVED))
    db_session.commit()
    _online, _b, _s, rejected, _br, _gw = _report_accounts_db_work(db_session, u, BridgePollRequest(
        fetchCommands=False, accounts=[BridgeAccount(login="29999", server="MakeCapital-Live"),
                                       BridgeAccount(login="20000", server="MakeCapital-Live")]))
    assert rejected == ["29999"]                          # 新行被拒 / new row refused
    assert db_session.query(MT5Account).filter_by(user_id=u.id).count() == 3
    revived = db_session.query(MT5Account).filter_by(user_id=u.id, login="20000").one()
    assert revived.revoked_reason is None                 # 复活旧行照常 / revival still allowed


# ---- 5. 报价键上限 / quote key cardinality ----------------------------------------------

def _batch(k, n):
    return [{"symbol": f"S{k}_{i}", "login": "1", "bid": 1.0, "ask": 1.1} for i in range(n)]


def test_quote_request_size_is_bounded():
    with pytest.raises(ValidationError):
        BridgeQuotesRequest(data=[{"symbol": f"S{i}", "login": "1", "bid": 1.0, "ask": 1.1}
                                  for i in range(bridge_mod.MAX_QUOTES_PER_REPORT + 1)])


def test_local_quote_keys_are_capped_per_user(monkeypatch):
    from app.services import shared_state

    monkeypatch.setattr(shared_state, "enabled", lambda: False)
    m = ConnectionManager()
    for k in range(3):
        m.update_quotes("u1", _batch(k, 400))
    assert sum(len(v) for v in m._quotes["u1"].values()) == cm.MAX_QUOTE_KEYS_PER_USER
    # 已有键照常更新 / existing keys still update
    changed = m.update_quotes("u1", [{"symbol": "S0_0", "login": "1", "bid": 2.0, "ask": 2.1}])
    assert changed and m._quotes["u1"]["1"]["S0_0"]["bid"] == 2.0


def test_shared_quote_keys_are_capped_per_user(monkeypatch):
    from app.core.config import settings
    from app.services import shared_state
    from tests.fake_redis import FakeRedis

    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    fake = FakeRedis()
    shared_state.reset_for_tests(fake)
    try:
        m = ConnectionManager()
        for k in range(3):
            m.update_quotes("u1", _batch(k, 400))
        key = shared_state._k(cm.QUOTES_KEY.format(user="u1"))
        assert len(fake.hgetall(key)) == cm.MAX_QUOTE_KEYS_PER_USER
    finally:
        shared_state.reset_for_tests()


# ---- 6/7. 平仓腿 / closed-trade legs ----------------------------------------------------

def _leg(**kw):
    base = dict(login="9001", symbol="EURUSD", side="BUY", closeVolume=0.01, closePrice=1.1, profit=0.0,
                positionTicket=1, dealTicket=1, closedAt=T_CLOSE)
    base.update(kw)
    return BridgeClosedTrade(**base)


def test_trade_history_request_size_is_bounded():
    with pytest.raises(ValidationError):
        BridgeClosedTradesRequest(data=[_leg(dealTicket=i + 1).model_dump()
                                        for i in range(bridge_mod.MAX_TRADES_PER_REPORT + 1)])


def test_unverified_legs_are_capped_per_user(db_session, monkeypatch):
    monkeypatch.setattr(bridge_mod, "MAX_UNVERIFIED_LEGS_PER_USER", 600)
    u = _user(db_session, "th1@t.co", plan="FREE")
    db_session.add(MT5Account(user_id=u.id, login="9001", server="X", source="bridge"))
    db_session.commit()
    first = _trade_history_db_work(db_session, u.id, [_leg(dealTicket=i) for i in range(1, 501)])
    second = _trade_history_db_work(db_session, u.id, [_leg(dealTicket=i) for i in range(501, 1001)])
    assert first == (500, 500, 0)
    assert second == (100, 100, 400)
    assert db_session.query(ClosedTrade).filter_by(user_id=u.id).count() == 600
    # 已入库的腿重发（补列）不占名额、不被拒 / re-sends of stored legs are not refused
    again = _trade_history_db_work(db_session, u.id, [_leg(dealTicket=1, openPrice=1.09)])
    assert again[2] == 0


def _attributed_setup(db, email, *, currency="USD", balance=1e6, order_symbol="XAUUSD"):
    u = _user(db, email)
    db.add(MT5Account(user_id=u.id, login="700001", server="S", source="bridge",
                      balance=balance, equity=balance, account_currency=currency))
    db.add(Order(user_id=u.id, client_order_id="po1", action="ORDER", status="FILLED", symbol=order_symbol,
                 side="BUY", volume=1.0, mt5_login="700001", mt5_ticket=5001,
                 created_at=T_OPEN.replace(tzinfo=None), updated_at=T_OPEN.replace(tzinfo=None)))
    db.commit()
    return u


def _forged(**kw):
    base = dict(login="700001", symbol="XAUUSD", side="BUY", closeVolume=1.0, closePrice=2008.0,
                profit=9_990_000.0, positionTicket=5001, dealTicket=777, closedAt=T_CLOSE)
    base.update(kw)
    return BridgeClosedTrade(**base)


def _candles(db, sym="XAUUSD", lo=2000.0, hi=2010.0):
    t0 = int(T_OPEN.timestamp()) - 60
    for i in range(33):
        db.add(Candle(symbol=sym, interval="1", t=t0 + 60 * i, o=lo + 1, h=hi, l=lo, c=lo + 2, v=1))
    db.commit()


@pytest.mark.parametrize("case", ["index_symbol", "no_open_time", "unknown_currency", "no_balance"])
def test_forged_profit_is_not_verified_when_bound_unavailable(db_session, case):
    kw, setup = {}, {}
    if case == "index_symbol":
        kw, setup = {"symbol": "US30", "openTime": T_OPEN}, {"order_symbol": "US30"}
    elif case == "no_open_time":
        kw = {}                                            # 没有 K 线时也不能靠缺省放行
    elif case == "unknown_currency":
        kw, setup = {"openTime": T_OPEN}, {"currency": "JPY"}
    elif case == "no_balance":
        kw, setup = {"symbol": "US30"}, {"order_symbol": "US30", "balance": None}
    u = _attributed_setup(db_session, f"pl-{case}@t.co", **setup)
    _trade_history_db_work(db_session, u.id, [_forged(**kw)])
    row = db_session.query(ClosedTrade).filter_by(user_id=u.id, deal_ticket=777).one()
    assert row.verified is False


def test_missing_open_time_is_filled_from_platform_order(db_session):
    """不报开仓时间也照样按 K 线区间核：伪造的 100 倍盈利标未核验，真实盈利照常核验。"""
    u = _attributed_setup(db_session, "pl-ot@t.co")
    _candles(db_session)
    _trade_history_db_work(db_session, u.id, [_forged(profit=8000.0, closeVolume=0.1, dealTicket=1)])
    _trade_history_db_work(db_session, u.id, [_forged(profit=80.0, closeVolume=0.1, dealTicket=2)])
    got = {r.deal_ticket: r.verified for r in db_session.query(ClosedTrade).filter_by(user_id=u.id)}
    assert got == {1: False, 2: True}


def test_leg_symbol_must_match_platform_order(db_session):
    """不能把黄金单报成 BTC 去借它的大波动把上限撑大。/ No symbol swap to widen the bound."""
    u = _attributed_setup(db_session, "pl-sym@t.co")
    _candles(db_session, sym="BTCUSD", lo=60000.0, hi=62000.0)
    _trade_history_db_work(db_session, u.id, [_forged(symbol="BTCUSD", profit=1500.0, closeVolume=1.0,
                                                      openTime=T_OPEN)])
    assert db_session.query(ClosedTrade).filter_by(user_id=u.id).one().verified is False


def test_fallback_still_accepts_losses_and_small_gains(db_session):
    ok, basis = cts.leg_profit_plausible(db_session, {"symbol": "US30", "profit": -50000.0, "closedAt": T_CLOSE})
    assert ok and basis == "none"
    ok, _ = cts.leg_profit_plausible(db_session, {"symbol": "US30", "profit": 50.0, "closedAt": T_CLOSE})
    assert ok
    ok, _ = cts.leg_profit_plausible(db_session, {"symbol": "US30", "profit": 5000.0, "closedAt": T_CLOSE})
    assert not ok
