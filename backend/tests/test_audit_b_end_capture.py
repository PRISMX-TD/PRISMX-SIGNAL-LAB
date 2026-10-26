"""审计 B 组：比赛结束持仓快照（capture_end_positions）与比赛分数。

· 一个参赛者缓存里的坏行（非字典、profit 不是数）不能让整轮快照都失败；
· NaN / Infinity 的浮动盈亏不能进快照、更不能变成 NaN 分数；
· 桥接（用户自己电脑上报）的持仓不可核验：只记亏损，浮盈不能加分；网关读到的照常；
· 结束时还开着的平台外持仓（同账户手动对冲腿）要进完整性标记。

Audit group B: end-of-competition position capture and competition scores.
"""
import asyncio
import json
import math
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import (
    ClosedTrade, Competition, CompetitionParticipant, MT5Account, Order, PeriodBaseline, User,
)
from app.services.gamification.competitions import (
    comp_period_key, comp_return_score, competition_integrity, compute_comp_rows,
)

UTC = timezone.utc
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)


@pytest.fixture
def capture_db(monkeypatch):
    import app.core.database as dbmod
    from app.core.database import Base
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(dbmod, "SessionLocal", Session)
    db = Session()
    yield db
    db.close()
    engine.dispose()


@pytest.fixture
def bridge_cache():
    """往进程内持仓缓存里塞桥接行，用完清掉。/ Seed the in-process bridge slice; clean up after."""
    from app.services.connection_manager import manager
    pushed = []

    def push(uid, rows, source="bridge"):
        pushed.append((uid, source))
        asyncio.run(manager.push_positions(uid, rows, source=source))

    yield push
    for uid, source in pushed:
        asyncio.run(manager.push_positions(uid, [], source=source))


def _comp(db, status="ended"):
    c = Competition(name="Cap", metric="return_pct", status=status, starts_at=T0, ends_at=ENDS,
                    min_trades=1)
    db.add(c); db.commit(); return c


def _entry(db, comp, email, login, source="gateway", revoked=False, baseline=1000.0):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit()
    db.add(MT5Account(user_id=u.id, login=login, server="s", balance=baseline, equity=baseline,
                      trade_mode=2, source=source, revoked_at=ENDS if revoked else None))
    db.add(CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login,
                                  scoring_from=T0))
    db.add(PeriodBaseline(user_id=u.id, mt5_login=login, period_key=comp_period_key(comp.id),
                          baseline=baseline, taken_at=T0))
    db.commit()
    return u


def _open_order(db, u, login, ticket, at=None):
    db.add(Order(user_id=u.id, client_order_id=f"o{login}{ticket}", symbol="X", side="BUY",
                 volume=0.1, status="FILLED", action="ORDER", mt5_login=login, mt5_ticket=ticket,
                 trade_mode=2, created_at=at or (T0 + timedelta(hours=1))))
    db.commit()


def _gateway(monkeypatch, by_login):
    from app.services import gateway_client

    async def positions(login, timeout=None):
        return by_login.get(str(login), []), ""

    monkeypatch.setattr(gateway_client, "get_positions", positions)


def _capture():
    from app.services.gamification.competitions import capture_end_positions
    return asyncio.run(capture_end_positions(now=ENDS + timedelta(minutes=1)))


def _snaps(db):
    db.expire_all()
    return {p.mt5_login: (json.loads(p.end_positions) if p.end_positions else None)
            for p in db.query(CompetitionParticipant)}


# ---------- isolation ----------

@pytest.mark.parametrize("poison", [[1], ["x"], [None],
                                    [{"login": "9002", "ticket": 1, "profit": "x"}],
                                    [{"login": "9002", "ticket": {"a": 1}, "profit": 1.0}]])
def test_one_malformed_bridge_row_does_not_block_other_entrants(capture_db, monkeypatch,
                                                                bridge_cache, poison):
    db = capture_db
    comp = _comp(db)
    _entry(db, comp, "honest@t.co", "9001")
    b = _entry(db, comp, "attacker@t.co", "9002", source="bridge")
    _gateway(monkeypatch, {"9001": [SimpleNamespace(ticket=555, profit=12.5)]})
    bridge_cache(b.id, poison)
    _capture()
    snaps = _snaps(db)
    assert snaps["9001"]["pnl"] == {"555": 12.5}
    assert snaps["9002"] is None or snaps["9002"]["pnl"] == {}


def test_malformed_rows_on_last_known_path_are_skipped(capture_db, monkeypatch, bridge_cache):
    db = capture_db
    comp = _comp(db)
    _entry(db, comp, "honest2@t.co", "9001")
    b = _entry(db, comp, "attacker2@t.co", "9002", revoked=True)
    _gateway(monkeypatch, {"9001": [SimpleNamespace(ticket=555, profit=12.5)]})
    bridge_cache(b.id, [1, {"login": "9002", "ticket": 7, "profit": "x"}])
    _capture()
    snaps = _snaps(db)
    assert snaps["9001"]["pnl"] == {"555": 12.5}
    assert snaps["9002"] is not None and snaps["9002"]["pnl"] == {}


def test_one_entry_raising_does_not_discard_the_others(capture_db, monkeypatch):
    db = capture_db
    comp = _comp(db)
    _entry(db, comp, "ok@t.co", "9001")
    _entry(db, comp, "boom@t.co", "9002")
    from app.services import gateway_client

    async def positions(login, timeout=None):
        if str(login) == "9002":
            return [SimpleNamespace(ticket=object(), profit=object())], ""
        return [SimpleNamespace(ticket=555, profit=12.5)], ""

    monkeypatch.setattr(gateway_client, "get_positions", positions)
    _capture()
    assert _snaps(db)["9001"]["pnl"] == {"555": 12.5}


# ---------- non-finite ----------

@pytest.mark.parametrize("bad", ["nan", float("nan"), float("inf"), float("-inf")])
def test_nonfinite_bridge_profit_never_captured(capture_db, monkeypatch, bridge_cache, bad):
    db = capture_db
    comp = _comp(db)
    b = _entry(db, comp, "nan@t.co", "9002", source="bridge")
    _gateway(monkeypatch, {})
    bridge_cache(b.id, [{"login": "9002", "ticket": 777, "profit": bad}])
    _capture()
    snap = _snaps(db)["9002"]
    assert snap is None or "777" not in snap["pnl"]


def test_nan_end_pnl_never_becomes_a_nan_score(db_session):
    comp = _comp(db_session)
    u = _entry(db_session, comp, "nan2@t.co", "A")
    _open_order(db_session, u, "A", 777)
    p = db_session.query(CompetitionParticipant).filter_by(mt5_login="A").one()
    p.end_positions = json.dumps({"at": (ENDS + timedelta(minutes=1)).isoformat(),
                                  "pnl": {"777": float("nan")}})
    db_session.commit()
    for r in compute_comp_rows(db_session, comp):
        assert math.isfinite(r["score"])


def test_comp_return_score_rejects_nonfinite():
    b = SimpleNamespace(baseline=1000.0)
    assert comp_return_score(b, [(T0, ENDS, float("nan"))], 500.0, None) is None
    assert comp_return_score(b, [(T0, ENDS, float("inf"))], 500.0, None) is None
    assert comp_return_score(b, [(T0, ENDS, 10.0)], 500.0, None) == (0.01, 1)


# ---------- provenance ----------

def test_forged_bridge_profit_on_unbound_entry_is_not_credited(capture_db, monkeypatch,
                                                               bridge_cache):
    db = capture_db
    comp = _comp(db)
    u = _entry(db, comp, "forge@t.co", "9101", revoked=True)
    _open_order(db, u, "9101", 77)
    _gateway(monkeypatch, {})
    bridge_cache(u.id, [{"login": "9101", "ticket": 77, "profit": 1_000_000.0}])
    _capture()
    snap = _snaps(db)["9101"]
    assert snap["pnl"].get("77", 0.0) <= 0.0
    rows = {r["login"]: r for r in compute_comp_rows(db, comp)}
    assert "9101" not in rows or rows["9101"]["score"] <= 0.0


def test_forged_bridge_profit_on_readable_gateway_empty_list_not_credited(capture_db, monkeypatch,
                                                                          bridge_cache):
    db = capture_db
    comp = _comp(db)
    u = _entry(db, comp, "forge2@t.co", "9102")
    _open_order(db, u, "9102", 78)
    _gateway(monkeypatch, {})
    from app.services import gateway_client

    async def account(login, timeout=None):
        return SimpleNamespace(balance=1000.0, equity=1050.0)

    monkeypatch.setattr(gateway_client, "get_account", account)
    bridge_cache(u.id, [{"login": "9102", "ticket": 78, "profit": 1_000_000.0}])
    _capture()
    assert _snaps(db)["9102"]["pnl"].get("78", 0.0) <= 0.0


def test_bridge_losses_still_count_and_gateway_slice_is_trusted(capture_db, monkeypatch,
                                                                bridge_cache):
    db = capture_db
    comp = _comp(db)
    u = _entry(db, comp, "loss@t.co", "9103", revoked=True)
    _gateway(monkeypatch, {})
    bridge_cache(u.id, [{"login": "9103", "ticket": 1, "profit": -40.0},
                        {"login": "9103", "ticket": 2, "profit": 25.0}])
    bridge_cache(u.id, [{"login": "9103", "ticket": 3, "profit": 30.0}], source="gateway")
    _capture()
    pnl = _snaps(db)["9103"]["pnl"]
    assert pnl["1"] == -40.0                    # 桥接的浮亏照记 / bridge loss kept
    assert pnl.get("2", 0.0) == 0.0             # 桥接的浮盈不加分 / bridge gain not credited
    assert pnl["3"] == 30.0                     # 网关那一路可信 / gateway slice trusted


# ---------- off-platform exposure ----------

def _hedge_setup(db, end_pnl):
    comp = _comp(db)
    u = _entry(db, comp, "hedge@t.co", "HG")
    _open_order(db, u, "HG", 222)
    db.add(ClosedTrade(user_id=u.id, mt5_login="HG", symbol="X", side="BUY", close_volume=0.1,
                       close_price=1, profit=5000.0, position_ticket=222, deal_ticket=2220,
                       closed_at=T0 + timedelta(hours=2), verified=True))
    p = db.query(CompetitionParticipant).filter_by(mt5_login="HG").one()
    p.end_positions = json.dumps({"at": ENDS.isoformat(), "pnl": end_pnl})
    db.commit()
    return comp


def test_offplatform_leg_open_at_end_is_flagged(db_session):
    comp = _hedge_setup(db_session, {"999": -5000.0})
    flags = {f["login"]: f for f in competition_integrity(db_session, comp)["flags"]}
    assert "HG" in flags and "cashflowFlagged" in flags["HG"]["kinds"]


def test_small_offplatform_exposure_not_flagged(db_session):
    comp = _hedge_setup(db_session, {"999": -10.0})
    assert competition_integrity(db_session, comp)["flags"] == []


def test_platform_positions_in_end_snapshot_are_not_offplatform(db_session):
    comp = _hedge_setup(db_session, {"222": 4000.0})
    assert competition_integrity(db_session, comp)["flags"] == []
