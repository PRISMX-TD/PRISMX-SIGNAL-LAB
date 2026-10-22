"""到期作废只动 unused、每期各自结束；提醒按期各一次、只发给本期有未用券的人、关着显示的期不发、
文案带期名、WS 整批一次。
Due rounds end one by one, voiding only unused tickets; reminders go once per round, to holders only,
never for a hidden round, name the round, and use one WS batch."""
from datetime import timedelta

import pytest

from app.models import LuckyRound, LuckyTicket, User, UserNotification
from app.services.lucky import common, sweep


@pytest.fixture(autouse=True)
def _no_push_ws(monkeypatch):
    """推送 / WS 不碰外部：测试只关心库里的结果，顺带记下调用。/ keep push and WS out; record the calls."""
    calls = {"ws": [], "push": []}
    monkeypatch.setattr(sweep, "notify_ws_many", lambda uids: calls["ws"].append(list(uids)))
    monkeypatch.setattr("app.services.push_dispatch.dispatch_users_push",
                        lambda uids, ev, title, body, url, tag: calls["push"].append((list(uids), body)) or 0)
    return calls


def _people(db):
    admin = User(email="a@t.co", password_hash="x", api_token="t-a", role="admin")
    u = User(email="u@t.co", password_hash="x", api_token="t-u")
    v = User(email="v@t.co", password_hash="x", api_token="t-v")
    db.add_all([admin, u, v])
    db.commit()
    return admin, u, v


def _round(db, admin, name, ends_in, visible=True):
    now = common.utcnow()
    r = LuckyRound(name=name, visible=visible, starts_at=now - timedelta(days=1), ends_at=now + ends_in,
                   created_by=admin.id)
    db.add(r)
    db.commit()
    return r


def _setup(db, ends_in, visible=True):
    admin, u, v = _people(db)
    r = _round(db, admin, "第一期", ends_in, visible)
    db.add_all([LuckyTicket(user_id=u.id, round_id=r.id, source="manual"),
                LuckyTicket(user_id=v.id, round_id=r.id, source="manual", status="used")])
    db.commit()
    return r, u, v, common.utcnow()


def test_due_round_ends_and_voids(db_session):
    r, _u, _v, now = _setup(db_session, timedelta(seconds=-5))
    out = sweep.sweep_once(db_session, now)
    assert out["ended"] == 1 and out["voided"] == 1
    db_session.refresh(r)
    assert r.ended_at is not None
    assert sorted(t.status for t in db_session.query(LuckyTicket)) == ["used", "voided"]
    assert sweep.sweep_once(db_session, now)["ended"] == 0


def test_each_round_ends_on_its_own(db_session):
    admin, u, _v = _people(db_session)
    due = _round(db_session, admin, "到点", timedelta(seconds=-5))
    later = _round(db_session, admin, "还早", timedelta(days=3))
    db_session.add_all([LuckyTicket(user_id=u.id, round_id=due.id, source="manual"),
                        LuckyTicket(user_id=u.id, round_id=later.id, source="manual")])
    db_session.commit()
    out = sweep.sweep_once(db_session, common.utcnow())
    assert out["ended"] == 1 and out["voided"] == 1
    db_session.refresh(later)
    assert later.ended_at is None
    assert {t.round_id: t.status for t in db_session.query(LuckyTicket)} == {due.id: "voided", later.id: "unused"}


def test_reminder_once_only_holders_and_named(db_session, _no_push_ws):
    r, u, _v, now = _setup(db_session, timedelta(hours=20))
    assert sweep.sweep_once(db_session, now)["reminded"] == 1
    assert sweep.sweep_once(db_session, now)["reminded"] == 0
    n = db_session.query(UserNotification).one()
    assert n.user_id == u.id and n.kind == "lucky_ticket_expiring" and n.ref_id == r.id
    assert n.text == f"第一期 · ×1 · {r.ends_at:%Y-%m-%d %H:%M} UTC"
    assert _no_push_ws["ws"] == [[u.id]]
    assert _no_push_ws["push"] == [([u.id], "你在「第一期」还有未使用的抽奖券，结束后自动作废")]


def test_no_reminder_when_hidden_or_far(db_session):
    r, _u, _v, now = _setup(db_session, timedelta(hours=20), visible=False)
    assert sweep.sweep_once(db_session, now)["reminded"] == 0          # 关着显示 / hidden
    r.visible = True
    db_session.commit()
    assert sweep.sweep_once(db_session, now - timedelta(days=2))["reminded"] == 0   # 还早 / too early


def test_reminders_for_several_rounds_one_ws_batch(db_session, _no_push_ws):
    admin, u, v = _people(db_session)
    a = _round(db_session, admin, "甲", timedelta(hours=10))
    b = _round(db_session, admin, "乙", timedelta(hours=20))
    hidden = _round(db_session, admin, "丙", timedelta(hours=5), visible=False)
    far = _round(db_session, admin, "丁", timedelta(days=5))
    for r, who in ((a, u), (a, u), (b, v), (b, u), (hidden, u), (far, v)):
        db_session.add(LuckyTicket(user_id=who.id, round_id=r.id, source="manual"))
    db_session.commit()
    out = sweep.sweep_once(db_session, common.utcnow())
    assert out["reminded"] == 3
    texts = sorted(n.text.split(" · ")[0] + "/" + n.text.split(" · ")[1]
                   for n in db_session.query(UserNotification))
    assert texts == ["乙/×1", "乙/×1", "甲/×2"]
    assert len(_no_push_ws["ws"]) == 1 and sorted(_no_push_ws["ws"][0]) == sorted([u.id, v.id, u.id])
    assert len(_no_push_ws["push"]) == 2
    for r in (a, b):
        db_session.refresh(r)
        assert r.reminder_sent_at is not None
    for r in (hidden, far):
        db_session.refresh(r)
        assert r.reminder_sent_at is None


def test_auto_end_writes_a_system_audit_row(db_session):
    """最终评审 M2：到点自动结束也要留一条「已结束、作废 N 张」的审计，且不挂在某个管理员名下。
    Final review M2: the sweeper's auto end leaves a round_end audit ("ended, N voided"), not attributed to an admin."""
    import json

    from app.models import AdminAuditLog
    from app.services import activity_feed as feed

    r, _u, _v, now = _setup(db_session, timedelta(seconds=-5))
    sweep.sweep_once(db_session, now)
    row, = db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "lucky:round_end").all()
    assert json.loads(row.new_value) == {"id": r.id, "name": "第一期", "voided": 1, "auto": True}
    sweep.sweep_once(db_session, now)
    assert db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "lucky:round_end").count() == 1
    item, = [i for i in feed.list_activity(db_session)["items"] if i["kind"] != "user.register"]
    assert item["kind"] == "admin.lucky" and item["actor"]["type"] == "system"
    assert item["params"]["action"] == "round_end" and item["params"]["voided"] == 1
    assert item["params"]["name"] == "第一期"
