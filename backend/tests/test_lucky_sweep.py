"""到期作废只动 unused；提醒每期一次、只发给有未用券的人、关着不发。
Due rounds void only unused tickets; the reminder is once per round, holders only, never while hidden."""
from datetime import timedelta

import pytest

from app.models import LuckyRound, LuckyTicket, User, UserNotification
from app.services.lucky import common, sweep


@pytest.fixture(autouse=True)
def _no_push_ws(monkeypatch):
    """推送 / WS 不碰外部：测试只关心库里的结果。/ keep push and WS out of the test."""
    monkeypatch.setattr(sweep, "notify_ws", lambda *a, **k: None)
    monkeypatch.setattr("app.services.push_dispatch.dispatch_users_push", lambda *a, **k: 0)


def _setup(db, ends_in):
    admin = User(email="a@t.co", password_hash="x", api_token="t-a", role="admin")
    u = User(email="u@t.co", password_hash="x", api_token="t-u")
    v = User(email="v@t.co", password_hash="x", api_token="t-v")
    db.add_all([admin, u, v])
    db.flush()
    now = common.utcnow()
    r = LuckyRound(starts_at=now - timedelta(days=1), ends_at=now + ends_in, created_by=admin.id)
    db.add(r)
    db.flush()
    db.add_all([LuckyTicket(user_id=u.id, round_id=r.id, source="manual"),
                LuckyTicket(user_id=v.id, round_id=r.id, source="manual", status="used")])
    db.commit()
    return r, u, v, now


def test_due_round_ends_and_voids(db_session):
    r, _u, _v, now = _setup(db_session, timedelta(seconds=-5))
    out = sweep.sweep_once(db_session, now)
    assert out["ended"] == 1 and out["voided"] == 1
    db_session.refresh(r)
    assert r.ended_at is not None
    assert sorted(t.status for t in db_session.query(LuckyTicket)) == ["used", "voided"]
    assert sweep.sweep_once(db_session, now)["ended"] == 0


def test_reminder_once_and_only_holders(db_session):
    _r, u, _v, now = _setup(db_session, timedelta(hours=20))
    common.set_visible(db_session, True)
    db_session.commit()
    assert sweep.sweep_once(db_session, now)["reminded"] == 1
    assert sweep.sweep_once(db_session, now)["reminded"] == 0
    n = db_session.query(UserNotification).one()
    assert n.user_id == u.id and n.kind == "lucky_ticket_expiring"


def test_no_reminder_when_hidden_or_far(db_session):
    _r, _u, _v, now = _setup(db_session, timedelta(hours=20))
    assert sweep.sweep_once(db_session, now)["reminded"] == 0          # 关着 / hidden
    common.set_visible(db_session, True)
    db_session.commit()
    assert sweep.sweep_once(db_session, now - timedelta(days=2))["reminded"] == 0   # 还早 / too early
