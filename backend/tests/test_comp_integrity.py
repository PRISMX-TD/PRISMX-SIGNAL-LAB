"""比赛完整性报告（设计 2026-10-08 §1.14）：对冲嫌疑配对 + 逐条目标记。"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import (
    Competition, CompetitionParticipant, MT5Account, Order, PeriodBaseline, User,
)
from app.services.gamification.competitions import (
    HEDGE_WINDOW_SECONDS, comp_period_key, competition_integrity,
)
from app.services.gateway_binding import REASON_PASSWORD_CHANGED, REASON_USER_REMOVED

UTC = timezone.utc
T0 = datetime(2026, 9, 1, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)


def _comp(db, status="running"):
    c = Competition(name="Integrity", metric="return_pct", enrollment="signup", status=status,
                    track="real", starts_at=T0, ends_at=ENDS,
                    reg_opens_at=T0 - timedelta(days=3), reg_closes_at=ENDS)
    db.add(c); db.commit(); return c


def _entry(db, comp, email, login, source="gateway", revoked_reason=None,
           scoring_from=T0, disqualified=False, user=None):
    u = user
    if u is None:
        u = User(email=email, api_token="tok_" + email)
        db.add(u); db.commit()
    db.add(MT5Account(user_id=u.id, login=login, server="" if source == "gateway" else "s",
                      source=source, balance=1000.0, trade_mode=2,
                      revoked_at=T0 if revoked_reason else None, revoked_reason=revoked_reason))
    p = CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login,
                               scoring_from=scoring_from, disqualified=disqualified)
    db.add(p); db.commit()
    return u, p


def _order(db, u, login, side, at, symbol="XAUUSD"):
    db.add(Order(user_id=u.id, client_order_id=f"c-{login}-{symbol}-{side}-{int(at.timestamp())}",
                 action="ORDER", status="FILLED", symbol=symbol, side=side, volume=0.1,
                 mt5_login=login, mt5_ticket=int(at.timestamp()) % 1_000_000_000, created_at=at))
    db.commit()


def _kinds(report):
    return {f["login"]: sorted(f["kinds"]) for f in report["flags"]}


def test_opposite_orders_within_window_form_a_pair(db_session):
    comp = _comp(db_session)
    u1, p1 = _entry(db_session, comp, "h1@t.co", "A")
    u2, p2 = _entry(db_session, comp, "h2@t.co", "B")
    u3, _p3 = _entry(db_session, comp, "h3@t.co", "C")
    at = T0 + timedelta(hours=1)
    _order(db_session, u1, "A", "BUY", at)
    _order(db_session, u2, "B", "SELL", at + timedelta(seconds=30))
    # 离 A 超过 60 秒、与 B 同向：都不成对 / >60s from A, same side as B
    _order(db_session, u3, "C", "SELL", at + timedelta(seconds=HEDGE_WINDOW_SECONDS + 1))

    report = competition_integrity(db_session, comp)

    assert len(report["pairs"]) == 1
    pair = report["pairs"][0]
    assert {pair["a"]["login"], pair["b"]["login"]} == {"A", "B"}
    assert pair["symbol"] == "XAUUSD" and pair["count"] == 1 and pair["sameUser"] is False
    assert pair["at"] == at.isoformat()
    assert pair["a"]["displayName"] and pair["b"]["displayName"]
    assert _kinds(report) == {"A": ["hedgePair"], "B": ["hedgePair"]}
    by_login = {f["login"]: f for f in report["flags"]}
    assert by_login["A"]["participantId"] == p1.id and by_login["A"]["detail"]["hedgePairs"] == 1


def test_same_side_or_other_symbol_is_not_a_pair(db_session):
    comp = _comp(db_session)
    u1, _ = _entry(db_session, comp, "s1@t.co", "A")
    u2, _ = _entry(db_session, comp, "s2@t.co", "B")
    at = T0 + timedelta(hours=1)
    _order(db_session, u1, "A", "BUY", at)
    _order(db_session, u2, "B", "BUY", at + timedelta(seconds=5))
    _order(db_session, u2, "B", "SELL", at + timedelta(seconds=10), symbol="EURUSD")

    assert competition_integrity(db_session, comp)["pairs"] == []


def test_orders_before_scoring_from_are_ignored(db_session):
    comp = _comp(db_session)
    u1, _ = _entry(db_session, comp, "b1@t.co", "A")
    u2, _ = _entry(db_session, comp, "b2@t.co", "B", scoring_from=T0 + timedelta(hours=2))
    at = T0 + timedelta(hours=1)                         # B 的计分起点之前
    _order(db_session, u1, "A", "BUY", at)
    _order(db_session, u2, "B", "SELL", at + timedelta(seconds=10))

    assert competition_integrity(db_session, comp)["pairs"] == []


def test_same_user_two_entries_hedging_is_reported(db_session):
    comp = _comp(db_session)
    u, _ = _entry(db_session, comp, "su@t.co", "A")
    _entry(db_session, comp, None, "A2", user=u)
    at = T0 + timedelta(hours=3)
    _order(db_session, u, "A", "SELL", at)
    _order(db_session, u, "A2", "BUY", at + timedelta(seconds=1))

    pairs = competition_integrity(db_session, comp)["pairs"]
    assert len(pairs) == 1 and pairs[0]["sameUser"] is True


def test_entry_flag_kinds(db_session):
    comp = _comp(db_session)
    _entry(db_session, comp, "ok@t.co", "OK")                                  # 干净
    _entry(db_session, comp, "br@t.co", "BR", source="bridge")                 # 非直连
    _entry(db_session, comp, "rv@t.co", "RV", revoked_reason=REASON_PASSWORD_CHANGED)
    _entry(db_session, comp, "rm@t.co", "RM", revoked_reason=REASON_USER_REMOVED)
    u_dup, _ = _entry(db_session, comp, "dup@t.co", "DUP")
    db_session.add(MT5Account(user_id=u_dup.id, login="DUP", server="s", source="bridge"))
    u_cf, _ = _entry(db_session, comp, "cf@t.co", "CF")
    db_session.add(PeriodBaseline(user_id=u_cf.id, mt5_login="CF", period_key=comp_period_key(comp.id),
                                  baseline=1000.0, adjust=100.0, taken_at=T0))
    _entry(db_session, comp, "dq@t.co", "DQ", source="bridge", disqualified=True)  # 不报告
    db_session.commit()

    kinds = _kinds(competition_integrity(db_session, comp))

    assert "OK" not in kinds and "DQ" not in kinds
    assert kinds["BR"] == ["nonGateway"]
    assert kinds["RV"] == ["accountRevoked"]
    assert kinds["RM"] == ["accountRevoked", "nonGateway"]     # 软删行不算数 / removed row ignored
    assert kinds["DUP"] == ["nonGateway"]                       # 同 login 还挂着桥接行
    assert kinds["CF"] == ["cashflowFlagged"]


def test_admin_integrity_endpoint(db_session):
    from app.routers.competitions import admin_competition_integrity

    comp = _comp(db_session)
    _entry(db_session, comp, "e1@t.co", "BR", source="bridge")
    out = admin_competition_integrity(comp.id, db=db_session)
    assert [f["login"] for f in out["flags"]] == ["BR"] and out["pairs"] == []

    with pytest.raises(HTTPException) as exc:
        admin_competition_integrity("nope", db=db_session)
    assert exc.value.status_code == 404
