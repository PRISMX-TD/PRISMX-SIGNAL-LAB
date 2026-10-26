"""审计 B 组：每人每场条目上限在并发报名下也要守住。

register_participant 先数条目、再释放连接去网关读实时资金（最长 8 秒），读完才插参赛行。
两个并发请求各报一个不同账户时，都在对方提交前数到 0，都能提交——上限形同虚设。
这里把「另一个请求在网关读的空档里提交了」直接演出来：桩掉的 read_live_funds 里替同一个
用户插一条参赛行并提交，然后要求这次报名被拒。

Audit group B: the per-user entry cap must hold under concurrent registrations. The
stubbed live-funds read commits a competing entry for the same user, as a concurrent
request would during the gateway read; the registration must then be refused.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import app.services.gamification.competitions as comp_mod
from app.models import Competition, CompetitionParticipant, MT5Account, PeriodBaseline, User
from app.services.gamification.competitions import comp_period_key, register_participant

UTC = timezone.utc
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)
REG_OPENS = T0 - timedelta(days=3)
IN_WINDOW = REG_OPENS + timedelta(days=1)


def _setup(db, track, logins):
    u = User(email=f"race-{track}@t.co", api_token=f"tok-race-{track}")
    db.add(u); db.commit()
    for lg in logins:
        db.add(MT5Account(user_id=u.id, login=lg, server="s", balance=1000.0, equity=1000.0,
                          trade_mode=0 if track == "demo" else 2, source="gateway"))
    c = Competition(name="Race", metric="return_pct", enrollment="signup", status="upcoming",
                    starts_at=T0, ends_at=ENDS, track=track, reg_opens_at=REG_OPENS,
                    reg_closes_at=T0 - timedelta(hours=1))
    db.add(c); db.commit()
    return u, c


def _racing_funds(db, comp, user, rival_logins):
    """读资金的空档里，「另一个请求」替同一个用户报上了别的账户。"""
    def fake(acct):
        for lg in rival_logins:
            db.add(CompetitionParticipant(competition_id=comp.id, user_id=user.id, mt5_login=lg,
                                          scoring_from=T0))
            db.add(PeriodBaseline(user_id=user.id, mt5_login=lg,
                                  period_key=comp_period_key(comp.id), baseline=1000.0,
                                  taken_at=IN_WINDOW))
        db.commit()
        return 1000.0, 1000.0
    return fake


def test_demo_cap_rechecked_after_live_funds_read(db_session, monkeypatch):
    u, comp = _setup(db_session, "demo", ["D1", "D2"])
    monkeypatch.setattr(comp_mod, "read_live_funds", _racing_funds(db_session, comp, u, ["D2"]))
    with pytest.raises(HTTPException) as e:
        register_participant(db_session, comp, u, "D1", IN_WINDOW)
    assert e.value.status_code == 400
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id, user_id=u.id).count() == 1
    assert db_session.query(PeriodBaseline).filter_by(
        period_key=comp_period_key(comp.id), user_id=u.id, mt5_login="D1").count() == 0


def test_real_cap_rechecked_after_live_funds_read(db_session, monkeypatch):
    u, comp = _setup(db_session, "real", ["R1", "R2", "R3", "R4"])
    monkeypatch.setattr(comp_mod, "read_live_funds",
                        _racing_funds(db_session, comp, u, ["R2", "R3", "R4"]))
    with pytest.raises(HTTPException) as e:
        register_participant(db_session, comp, u, "R1", IN_WINDOW)
    assert e.value.status_code == 400
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id, user_id=u.id).count() == 3


def test_under_cap_still_registers(db_session, monkeypatch):
    u, comp = _setup(db_session, "real", ["R1", "R2"])
    monkeypatch.setattr(comp_mod, "read_live_funds", _racing_funds(db_session, comp, u, ["R2"]))
    p = register_participant(db_session, comp, u, "R1", IN_WINDOW)
    assert p is not None and p.mt5_login == "R1"
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id, user_id=u.id).count() == 2
