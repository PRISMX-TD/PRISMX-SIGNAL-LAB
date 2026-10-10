"""2026-10-10 交易链路安全加固：桥接 / gateway / 平仓明细 / 竞赛 / 分享卡 / WS。

每一条都对应审计里的一个具体攻击或故障，测试按攻击原样复现：
  1. 桥接不带 server 上报，复活已撤销 + 已删除的 gateway 绑定；
  2. 已撤销的 gateway 账号仍被读挂单；
  ……（见各分节）

Security hardening of the trading paths; each block reproduces one audit finding.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.models import Candle, ClosedTrade, MT5Account, Order, PeriodBaseline, User
from app.routers import bridge as bridge_mod
from app.services import closed_trade_store as cts
from app.services.gateway_binding import (
    REASON_PASSWORD_CHANGED, is_removed, is_revoked, mark_removed, revoke,
)


def _user(db, email="sec@t.co", plan="PRO"):
    u = User(email=email, api_token="tok_" + email, plan=plan)
    db.add(u)
    db.commit()
    return u


def _gw_row(db, u, login="601144", **kw):
    row = MT5Account(user_id=u.id, login=login, server="", source="gateway",
                     trade_mode=2, balance=1000.0, pass_change_at=111, **kw)
    db.add(row)
    db.commit()
    return row


@pytest.fixture(autouse=True)
def _broker_lock_off(monkeypatch):
    """合作券商锁默认开（只认 MakeCapital），会把不带 server 的上报先拦掉——攻击要在锁关闭
    时才走得到 upsert，测试按最坏情况关掉它。"""
    monkeypatch.setattr(bridge_mod, "get_broker_settings",
                        lambda db: {"broker_lock_enabled": False, "broker_patterns": []})


def _report(db, user, *accounts):
    req = bridge_mod.BridgePollRequest(accounts=list(accounts), fetchCommands=False)
    return bridge_mod._report_accounts_db_work(db, user, req)


# ---- 1. 桥接不能复活 gateway 绑定 / the bridge can't revive a gateway binding ----------

def test_bridge_report_without_server_cannot_revive_revoked_removed_gateway_row(db_session, monkeypatch):
    """攻击原样：gateway 行先因改密被撤销、再被用户删除；之后桥接上报 {login: X}（不带
    server）。修复前这会命中 (X, None) 键、restore_removed 清掉撤销标记，订单随即直接
    经 gateway 下到券商——全程不需要 MT5 密码。"""
    u = _user(db_session)
    row = _gw_row(db_session, u)
    revoke(db_session, row, REASON_PASSWORD_CHANGED)
    mark_removed(db_session, row)
    revoked_at = row.revoked_at

    for server in (None, ""):
        online, balances, *_rest, gw_logins = _report(
            db_session, u, bridge_mod.BridgeAccount(login="601144", server=server, balance=1e9)
        )
        assert "601144" not in online and "601144" not in balances
        assert gw_logins == {"601144"}          # 桥接仍跳过这个 login 的指令

    rows = db_session.query(MT5Account).filter_by(user_id=u.id, login="601144").all()
    assert len(rows) == 1                       # 没有另建一条同 login 的桥接行
    gw = rows[0]
    assert gw.source == "gateway" and is_removed(gw) and is_revoked(gw)
    assert gw.revoked_at == revoked_at and gw.online is not True and gw.balance == 1000.0

    # 订单不能经 gateway 路由：执行器在调网关之前就拒掉
    from app.services import gateway_execute
    called = []
    monkeypatch.setattr(gateway_execute, "gw_open", lambda *a, **kw: called.append(a))
    order = Order(user_id=u.id, mt5_login="601144", action="ORDER", symbol="EURUSD", side="BUY",
                  volume=0.01, status="PENDING", client_order_id="co_sec_1")
    db_session.add(order)
    db_session.commit()
    payload = gateway_execute.try_gateway_execute(db_session, order)
    assert payload is not None and order.status == "REJECTED" and not called


def test_bridge_report_without_server_does_not_touch_live_gateway_row(db_session):
    """未撤销的 gateway 行也不让桥接刷心跳 / 改资金。"""
    u = _user(db_session, email="sec2@t.co")
    row = _gw_row(db_session, u)
    _report(db_session, u, bridge_mod.BridgeAccount(login="601144", balance=5.0, equity=5.0))
    db_session.refresh(row)
    assert row.balance == 1000.0 and row.last_heartbeat is None


def test_upsert_account_never_matches_gateway_row(db_session):
    """不经调用方查找表的路径同样不匹配 gateway 行；新建的桥接行 server 落 NULL，
    不和 gateway 行（server=""）撞唯一约束。"""
    u = _user(db_session, email="sec3@t.co")
    gw = _gw_row(db_session, u)
    mark_removed(db_session, gw)
    acc = bridge_mod.BridgeAccount(login="601144", server="", balance=5.0)
    row, created = bridge_mod._upsert_account(db_session, u.id, acc, existing_count=0, account_limit=None)
    assert row is not gw and row.source == "bridge" and row.server is None and created
    db_session.commit()                         # 不抛 IntegrityError
    db_session.refresh(gw)
    assert is_removed(gw) and gw.revoked_at is not None


def test_bridge_report_with_server_still_creates_own_row(db_session):
    """正常桥接（带 server）不受影响：建自己的行。"""
    u = _user(db_session, email="sec4@t.co")
    _gw_row(db_session, u)
    online, *_ = _report(db_session, u, bridge_mod.BridgeAccount(login="601144", server="Broker-Live"))
    assert online == {"601144"}
    rows = db_session.query(MT5Account).filter_by(user_id=u.id, login="601144").all()
    assert sorted(r.source for r in rows) == ["bridge", "gateway"]


# ---- 2. 撤销的 gateway 账号不读挂单 / revoked accounts' pending orders aren't read ----

def test_gateway_logins_excludes_revoked(db_session):
    from app.services.pending_orders import gateway_logins
    u = _user(db_session, email="sec5@t.co")
    live = _gw_row(db_session, u, login="1001")
    dead = _gw_row(db_session, u, login="1002")
    removed = _gw_row(db_session, u, login="1003")
    revoke(db_session, dead, REASON_PASSWORD_CHANGED)
    mark_removed(db_session, removed)
    assert gateway_logins(db_session, u.id) == [live.login]


def test_refresh_after_order_skips_revoked_gateway_account(db_session, monkeypatch):
    from app.routers import orders as orders_mod
    u = _user(db_session, email="sec6@t.co")
    dead = _gw_row(db_session, u, login="1002")
    revoke(db_session, dead, REASON_PASSWORD_CHANGED)
    submitted = []
    monkeypatch.setattr(orders_mod, "submit_to_main_loop", lambda coro, what: (coro.close(), submitted.append(what)))
    orders_mod._refresh_pending_after(db_session, Order(user_id=u.id, mt5_login="1002"))
    assert submitted == []


# ---- 3. 桥接平仓明细输入加固 / bridge trade-history hardening ------------------------

T_OPEN = datetime(2026, 10, 5, 10, 0, tzinfo=timezone.utc)
T_CLOSE = T_OPEN + timedelta(minutes=30)


def _leg_payload(**kw):
    base = dict(login="700001", symbol="XAUUSD.s", side="BUY", closeVolume=0.1, closePrice=2008.0,
                profit=80.0, positionTicket=5001, dealTicket=9001, closedAt=T_CLOSE,
                openTime=T_OPEN, openPrice=2001.0)
    base.update(kw)
    return base


@pytest.mark.parametrize("field", ["profit", "closePrice", "grossProfit", "commission", "swap",
                                   "openPrice", "sl", "tp", "closeVolume"])
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_leg_numbers_are_rejected(field, bad):
    with pytest.raises(ValidationError):
        bridge_mod.BridgeClosedTrade(**_leg_payload(**{field: bad}))


@pytest.mark.parametrize("field, bad", [("profit", 2e9), ("profit", -2e9), ("closePrice", 1e9),
                                        ("commission", 5e9)])
def test_leg_numbers_have_absolute_bounds(field, bad):
    with pytest.raises(ValidationError):
        bridge_mod.BridgeClosedTrade(**_leg_payload(**{field: bad}))


def test_account_funds_reject_non_finite():
    with pytest.raises(ValidationError):
        bridge_mod.BridgeAccount(login="1", balance=float("nan"))


def test_upsert_leg_never_stores_non_finite_profit(db_session):
    u = _user(db_session, email="nf@t.co")
    leg = _leg_payload(profit=float("nan"))
    assert cts.upsert_leg(db_session, u.id, "700001", leg, True) == "unchanged"
    assert db_session.query(ClosedTrade).count() == 0


def test_bridge_resend_cannot_rewrite_verified_leg_pnl(db_session):
    """先报一条真腿拿到 verified，再以 feeAlloc=2 重发把毛盈亏 / 净盈亏改大——必须不生效；
    只允许补空着的列。/ A verified leg's P&L can't be rewritten by a bridge re-send."""
    u = _user(db_session, email="rs@t.co")
    first = _leg_payload(grossProfit=None, commission=None, swap=None)
    assert cts.upsert_leg(db_session, u.id, "700001", first, True) == "inserted"
    forged = _leg_payload(profit=50000.0, grossProfit=50010.0, commission=-5.0, swap=-5.0, feeAlloc=2)
    assert cts.upsert_leg(db_session, u.id, "700001", forged, True) == "enriched"   # 只补了空列
    row = db_session.query(ClosedTrade).one()
    assert row.profit == 80.0                               # 净盈亏不动 / net P&L untouched
    assert row.commission == -5.0 and row.swap == -5.0      # 空着的费用列补上 / nulls filled
    again = _leg_payload(profit=90000.0, grossProfit=90010.0, commission=-1.0, swap=-1.0, feeAlloc=2)
    cts.upsert_leg(db_session, u.id, "700001", again, True)
    db_session.refresh(row)
    assert row.profit == 80.0 and row.gross_profit == 50010.0 and row.commission == -5.0


# ---- 3b. 盈亏合理性核对 / P&L plausibility ----------------------------------------

def _candles(db, sym="XAUUSD", lo=2000.0, hi=2010.0):
    t0 = int(T_OPEN.timestamp()) - 60
    for i in range(33):
        db.add(Candle(symbol=sym, interval="1", t=t0 + 60 * i, o=lo + 1, h=hi, l=lo, c=lo + 2, v=1))
    db.commit()


def _bridge_setup(db, email, balance=1000.0, currency="USD"):
    u = _user(db, email=email)
    db.add(MT5Account(user_id=u.id, login="700001", server="MakeCapital-Live", source="bridge",
                      trade_mode=2, balance=balance, equity=balance, account_currency=currency))
    db.add(Order(user_id=u.id, client_order_id="po1", action="ORDER", status="FILLED", symbol="XAUUSD",
                 side="BUY", volume=0.1, mt5_login="700001", mt5_ticket=5001, trade_mode=2))
    db.commit()
    return u


@pytest.fixture(autouse=True)
def _fresh_plausibility_cache():
    cts.reset_plausibility_cache_for_tests()
    yield
    cts.reset_plausibility_cache_for_tests()


def test_realistic_leg_passes_plausibility(db_session):
    u = _bridge_setup(db_session, "pl1@t.co")
    _candles(db_session)
    leg = bridge_mod.BridgeClosedTrade(**_leg_payload(profit=80.0))   # 0.1 手 × 区间 10 = 最多 100 美元
    assert bridge_mod._trade_history_db_work(db_session, u.id, [leg]) == (1, 0, 0)
    assert db_session.query(ClosedTrade).one().verified is True


def test_hundredfold_inflated_profit_is_stored_unverified(db_session):
    from app.services.gamification.stats import _legs_by_position
    u = _bridge_setup(db_session, "pl2@t.co")
    _candles(db_session)
    leg = bridge_mod.BridgeClosedTrade(**_leg_payload(profit=8000.0))  # 100 倍 / 100x
    inserted, unverified, _ = bridge_mod._trade_history_db_work(db_session, u.id, [leg])
    row = db_session.query(ClosedTrade).one()
    assert inserted == 1 and unverified == 1 and row.verified is False and row.profit == 8000.0
    assert not _legs_by_position(db_session, u.id, {("700001", 5001)})   # 不进公开统计


def test_cent_account_bound_scales_by_100(db_session):
    u = _bridge_setup(db_session, "pl3@t.co", currency="USC")
    _candles(db_session)
    leg = bridge_mod.BridgeClosedTrade(**_leg_payload(profit=8000.0))  # 80 美元 = 8000 美分
    bridge_mod._trade_history_db_work(db_session, u.id, [leg])
    assert db_session.query(ClosedTrade).one().verified is True


def test_missing_candles_fall_back_to_balance_cap(db_session):
    u = _bridge_setup(db_session, "pl4@t.co", balance=1000.0)
    ok, basis = cts.leg_profit_plausible(db_session, _leg_payload(profit=8000.0),
                                         account_currency="USD", balance=1000.0, equity=1000.0)
    assert ok and basis == "balance"                                   # 10 × 1000 + 100 之内
    ok, basis = cts.leg_profit_plausible(db_session, _leg_payload(profit=50000.0),
                                         account_currency="USD", balance=1000.0)
    assert not ok and basis == "balance"
    ok, _ = cts.leg_profit_plausible(db_session, _leg_payload(profit=-50000.0),
                                     account_currency="USD", balance=1000.0)
    assert ok                                                          # 亏损不拦 / losses pass
    ok, basis = cts.leg_profit_plausible(db_session, _leg_payload(profit=50000.0))
    assert ok and basis == "none"                                      # 无从核对：放行
    leg = bridge_mod.BridgeClosedTrade(**_leg_payload(profit=500.0))
    bridge_mod._trade_history_db_work(db_session, u.id, [leg])
    assert db_session.query(ClosedTrade).one().verified is True


def test_unknown_symbol_or_currency_falls_back():
    assert cts.max_plausible_profit(None, _leg_payload(symbol="US30.cash")) is None
    assert cts.max_plausible_profit(None, _leg_payload(), account_currency="JPY") is None
    assert cts._base_symbol("XAUUSDm") == "XAUUSD"
    assert cts._base_symbol("EURUSD.s") == "EURUSD"
    assert cts._base_symbol("USOIL") == "WTI"
    assert cts._base_symbol("XAUUSDpro", "pro") == "XAUUSD"


def test_resent_leg_skips_candle_query(db_session, monkeypatch):
    """已入库的腿重发不再核对（结论早已定下），回扫一年的历史不会每条都查一次行情。"""
    u = _bridge_setup(db_session, "pl5@t.co")
    _candles(db_session)
    leg = bridge_mod.BridgeClosedTrade(**_leg_payload(profit=80.0))
    bridge_mod._trade_history_db_work(db_session, u.id, [leg])
    calls = []
    monkeypatch.setattr(bridge_mod, "leg_profit_plausible", lambda *a, **kw: calls.append(1) or (True, "x"))
    bridge_mod._trade_history_db_work(db_session, u.id, [leg])
    assert calls == []


def test_scoring_skips_non_finite_legs_already_in_db(db_session):
    from app.services.gamification.stats import _legs_by_position
    u = _user(db_session, email="nan@t.co")
    # SQLite 把 NaN 存成 NULL，这里用 Infinity 代表库里残留的非有限值（Postgres 两者都存得下）。
    # SQLite stores NaN as NULL, so Infinity stands in for a stale non-finite value.
    for ticket, profit in ((1, float("inf")), (2, 5.0)):
        db_session.add(ClosedTrade(user_id=u.id, mt5_login="1", symbol="X", side="BUY", close_volume=0.1,
                                   close_price=1, profit=profit, position_ticket=ticket, deal_ticket=ticket,
                                   closed_at=T_CLOSE, verified=True))
    db_session.commit()
    assert list(_legs_by_position(db_session, u.id, {("1", 1), ("1", 2)})) == [("1", 2)]


# ---- 4. 对账只扣 verified 腿 / reconciliation subtracts verified legs only -----------

def _baseline_row(db, u, login="1"):
    b = PeriodBaseline(user_id=u.id, mt5_login=login, period_key="2026-10", baseline=1000.0, adjust=0.0,
                       taken_at=T_OPEN - timedelta(days=1))
    db.add(b)
    return b


def test_realized_since_counts_verified_legs_only(db_session):
    """手动在 MT5 下、带平台注释前缀的单（网关收为 verified=False）不能藏进 realized。"""
    from app.services.gamification.boards import _realized_since_bulk
    u = _user(db_session, email="rz@t.co")
    b = _baseline_row(db_session, u)
    for i, (profit, verified) in enumerate([(30.0, True), (500.0, False), (7.0, None)]):
        db_session.add(ClosedTrade(user_id=u.id, mt5_login="1", symbol="X", side="BUY", close_volume=0.1,
                                   close_price=1, profit=profit, position_ticket=10 + i, deal_ticket=10 + i,
                                   closed_at=T_CLOSE, verified=verified))
    db_session.commit()
    assert _realized_since_bulk(db_session, [b], None) == {(u.id, "1"): 30.0}


def test_reconcile_turns_offplatform_profit_into_cashflow(db_session):
    from app.services.gamification.boards import reconcile_deposits
    u = _user(db_session, email="rc@t.co")
    db_session.add(MT5Account(user_id=u.id, login="1", server="", source="gateway", balance=1530.0,
                              trade_mode=2))
    b = _baseline_row(db_session, u)
    for ticket, profit, verified in ((1, 30.0, True), (2, 500.0, False)):    # 第二笔是手动单
        db_session.add(ClosedTrade(user_id=u.id, mt5_login="1", symbol="X", side="BUY", close_volume=0.1,
                                   close_price=1, profit=profit, position_ticket=ticket, deal_ticket=ticket,
                                   closed_at=T_CLOSE, verified=verified))
    db_session.commit()
    reconcile_deposits(db_session, "2026-10", now=T_CLOSE + timedelta(hours=1),
                       bounds=(T_OPEN - timedelta(days=2), T_OPEN + timedelta(days=20)))
    db_session.refresh(b)
    assert abs(b.adjust - 500.0) < 1e-9                              # 平台外盈利记成资金进出


# ---- 5. 比赛结束时账户读不到 / account unreadable at the end of a competition --------

def _comp_capture_env(monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    import app.core.database as dbmod
    from app.core.database import Base

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(dbmod, "SessionLocal", Session)
    return engine, Session()


def _ended_comp_with(db, login, *, source="gateway", revoked=False, balance=1000.0, equity=1000.0):
    from app.models import Competition, CompetitionParticipant
    ends = T_OPEN
    comp = Competition(name="c", status="ended", metric="return_pct", starts_at=ends - timedelta(days=7),
                       ends_at=ends)
    db.add(comp)
    u = _user(db, email=f"cap{login}@t.co")
    db.add(MT5Account(user_id=u.id, login=login, server="", source=source, balance=balance, equity=equity,
                      trade_mode=2, revoked_at=ends if revoked else None))
    db.commit()
    p = CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login)
    db.add(p)
    db.commit()
    return comp, u, p


def test_unreadable_end_capture_uses_last_known_positions(db_session, monkeypatch):
    from app.services.connection_manager import manager
    from app.services.gamification.competitions import capture_end_positions

    engine, db = _comp_capture_env(monkeypatch)
    _comp, u, p = _ended_comp_with(db, "9101", revoked=True)

    async def cached(uid):
        return [{"login": "9101", "ticket": 77, "profit": -150.0}, {"login": "other", "ticket": 1, "profit": 9}]

    monkeypatch.setattr(manager, "get_positions_shared_async", cached)
    asyncio.run(capture_end_positions(now=T_OPEN + timedelta(minutes=1)))
    db.expire_all()
    snap = json.loads(db.get(type(p), p.id).end_positions)
    assert snap["pnl"] == {"77": -150.0} and snap["lastKnown"] is True
    db.close()
    engine.dispose()


def test_unreadable_end_capture_without_cache_records_account_floating_loss(db_session, monkeypatch):
    from app.services.connection_manager import manager
    from app.services.gamification import competitions as comps

    engine, db = _comp_capture_env(monkeypatch)
    comp, u, p = _ended_comp_with(db, "9102", revoked=True, balance=1000.0, equity=760.0)

    async def empty(uid):
        return []

    monkeypatch.setattr(manager, "get_positions_shared_async", empty)
    asyncio.run(comps.capture_end_positions(now=T_OPEN + timedelta(minutes=1)))
    db.expire_all()
    p = db.get(type(p), p.id)
    snap = json.loads(p.end_positions)
    assert snap["pnl"] == {} and snap["acctFloating"] == -240.0
    # 两张没平完的平台单平摊这笔浮亏计入成绩 / two open platform orders share the loss
    for t in (501, 502):
        db.add(Order(user_id=u.id, client_order_id=f"e{t}", symbol="X", side="BUY", volume=0.1,
                     status="FILLED", action="ORDER", mt5_login="9102", mt5_ticket=t, trade_mode=2,
                     created_at=T_OPEN - timedelta(hours=2)))
    db.commit()
    vals = comps._end_valuation(db, db.get(type(comp), comp.id), p, (2,))
    assert sorted(v for _o, _c, v in vals) == [-120.0, -120.0]
    db.close()
    engine.dispose()


def test_gateway_empty_positions_with_unreadable_account_is_not_trusted(db_session, monkeypatch):
    """网关对「组未开放」的账号回 ok + 空持仓、/account 回 404：不能当成「结束时空仓」。"""
    from app.services import gateway_client
    from app.services.connection_manager import manager
    from app.services.gamification.competitions import capture_end_positions

    engine, db = _comp_capture_env(monkeypatch)
    _comp, u, p = _ended_comp_with(db, "9103", balance=1000.0, equity=900.0)

    async def no_positions(login, timeout=None):
        return [], ""

    async def account_404(login, timeout=None):
        return None

    async def cached(uid):
        return [{"login": "9103", "ticket": 88, "profit": -100.0}]

    monkeypatch.setattr(gateway_client, "get_positions", no_positions)
    monkeypatch.setattr(gateway_client, "get_account", account_404)
    monkeypatch.setattr(manager, "get_positions_shared_async", cached)
    asyncio.run(capture_end_positions(now=T_OPEN + timedelta(minutes=1)))
    db.expire_all()
    snap = json.loads(db.get(type(p), p.id).end_positions)
    assert snap["pnl"] == {"88": -100.0} and snap["lastKnown"] is True
    db.close()
    engine.dispose()


def test_gateway_genuinely_flat_account_keeps_empty_snapshot(db_session, monkeypatch):
    from app.services import gateway_client
    from app.services.gamification.competitions import capture_end_positions

    engine, db = _comp_capture_env(monkeypatch)
    _comp, u, p = _ended_comp_with(db, "9104")

    async def no_positions(login, timeout=None):
        return [], ""

    async def flat_account(login, timeout=None):
        return SimpleNamespace(balance=1000.0, equity=1000.0)

    monkeypatch.setattr(gateway_client, "get_positions", no_positions)
    monkeypatch.setattr(gateway_client, "get_account", flat_account)
    asyncio.run(capture_end_positions(now=T_OPEN + timedelta(minutes=1)))
    db.expire_all()
    snap = json.loads(db.get(type(p), p.id).end_positions)
    assert snap == {"at": snap["at"], "pnl": {}}
    db.close()
    engine.dispose()


# ---- 7 / 8. /gateway/verify：锁定按 (用户, 账号)；不再有「组未开放」403 与 retcode -------

def _verify_env(monkeypatch, rsp):
    from app.core import rate_limit
    from app.routers import gateway as gateway_mod
    rate_limit._failures.clear()
    # 打在路由模块实际引用的那个对象上：别的用例可能 reload 过 rate_limit。
    # Patch the object the router actually holds; another test may have reloaded rate_limit.
    monkeypatch.setattr(gateway_mod.limiter, "enabled", False)
    monkeypatch.setattr(gateway_mod, "gw_verify", lambda login, pw: rsp)
    monkeypatch.setattr(gateway_mod, "run_on_main_loop", lambda coro, timeout: coro)
    return gateway_mod


def _call_verify(gateway_mod, db, user, login=601144):
    from starlette.requests import Request
    scope = {"type": "http", "method": "POST", "path": "/api/gateway/verify", "headers": [],
             "client": ("127.0.0.1", 1), "query_string": b"", "server": ("t", 80), "scheme": "http"}
    req = gateway_mod.GatewayVerifyRequest(login=login, password="wrong-pw")
    return gateway_mod.gateway_verify(Request(scope), req, user=user, db=db)


def _wrong_pw():
    return SimpleNamespace(ok=True, valid=False, retcode="MT_RET_USR_INVALID_PASSWORD", login=601144,
                           name="", group="", leverage=0, balance=0.0, equity=0.0, last_pass_change=0,
                           status=200, error="", message="")


def test_strangers_failures_do_not_lock_the_owner_out(db_session, monkeypatch):
    """别人对你的账号连错 5 次，只锁他自己；你照常能验证。"""
    from fastapi import HTTPException
    gw = _verify_env(monkeypatch, _wrong_pw())
    attacker = _user(db_session, email="att@t.co")
    owner = _user(db_session, email="own@t.co")
    for _ in range(5):
        out = _call_verify(gw, db_session, attacker)
        assert out.valid is False and out.retcode == ""          # 不回 retcode / no retcode
    with pytest.raises(HTTPException) as exc:
        _call_verify(gw, db_session, attacker)
    assert exc.value.status_code == 429
    assert _call_verify(gw, db_session, owner).valid is False    # 主人没被锁 / owner not locked


def test_one_user_cannot_sweep_many_logins(db_session, monkeypatch):
    """按用户的总数用自己的策略（mt5_verify_user，20 次 / 15 分钟），不再借 (用户, 账号) 的 5 次。"""
    from fastapi import HTTPException
    from app.core import rate_limit
    assert rate_limit._POLICIES["mt5_verify_user"] == (20, 900)
    gw = _verify_env(monkeypatch, _wrong_pw())
    u = _user(db_session, email="sweep@t.co")
    for login in range(700000, 700019):
        _call_verify(gw, db_session, u, login=login)
    assert _call_verify(gw, db_session, u, login=700019).valid is False   # 第 20 次仍放行 / 20th still allowed
    with pytest.raises(HTTPException) as exc:
        _call_verify(gw, db_session, u, login=700099)            # 换个新账号也被按用户的总数挡住
    assert exc.value.status_code == 429


def test_many_users_against_one_login_hit_the_global_cap(db_session, monkeypatch):
    """按 MT5 账号的全局总数（mt5_verify_login，50 次 / 15 分钟，跨所有用户）：10 个平台账号
    各吃满 5 次之后，第 11 个新用户对这个账号也被挡；对别的账号不受影响。"""
    from fastapi import HTTPException
    from app.core import rate_limit
    assert rate_limit._POLICIES["mt5_verify_login"] == (50, 900)
    gw = _verify_env(monkeypatch, _wrong_pw())
    for i in range(10):
        u = _user(db_session, email=f"ring{i}@t.co")
        for _ in range(5):
            _call_verify(gw, db_session, u)
    fresh = _user(db_session, email="ring-fresh@t.co")
    with pytest.raises(HTTPException) as exc:
        _call_verify(gw, db_session, fresh)
    assert exc.value.status_code == 429
    assert _call_verify(gw, db_session, fresh, login=601145).valid is False   # 别的账号照常 / other logins fine


def test_global_cap_not_reached_below_threshold(db_session, monkeypatch):
    """49 次全局失败还没到线：新用户对同一账号仍能验证。"""
    gw = _verify_env(monkeypatch, _wrong_pw())
    for i in range(10):
        u = _user(db_session, email=f"near{i}@t.co")
        for _ in range(5 if i < 9 else 4):
            _call_verify(gw, db_session, u)
    assert _call_verify(gw, db_session, _user(db_session, email="near-fresh@t.co")).valid is False


@pytest.mark.parametrize("status, error", [(403, "group_not_allowed"), (404, "not_found")])
def test_group_not_enabled_reads_as_invalid_and_counts(db_session, monkeypatch, status, error):
    """「组未开放」只在密码正确时出现：必须与密码错一模一样（valid=False），并计入锁定。"""
    from fastapi import HTTPException
    rsp = SimpleNamespace(ok=False, valid=False, retcode="MT_RET_ERR_NOTFOUND", login=0, name="", group="",
                          leverage=0, balance=0.0, equity=0.0, last_pass_change=0, status=status,
                          error=error, message="")
    gw = _verify_env(monkeypatch, rsp)
    u = _user(db_session, email=f"grp{status}@t.co")
    for _ in range(5):
        out = _call_verify(gw, db_session, u)
        assert out.valid is False and out.retcode == ""
    with pytest.raises(HTTPException) as exc:
        _call_verify(gw, db_session, u)
    assert exc.value.status_code == 429
