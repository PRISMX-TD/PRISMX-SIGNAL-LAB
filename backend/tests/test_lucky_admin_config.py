"""期的建改结束、作废、奖项整套保存、显示开关、守卫。"""
from datetime import timedelta

import pytest
from fastapi import FastAPI, HTTPException

from app.models import AdminAuditLog, LuckyPrize, LuckyRound, LuckyTicket, User
from app.routers import lucky_wheel as router
from app.schemas import LuckyPrizeIn, LuckyRoundIn, LuckyRoundPatch, LuckyVisibleIn
from app.services.deps import require_admin
from app.services.lucky import common, prizes, rounds


def _user(db, email, **kw):
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


@pytest.fixture
def admin(db_session):
    return _user(db_session, "admin@t.co", role="admin")


def P(**kw):
    base = dict(name="谢谢参与", kind="none", probPct=50.0)
    base.update(kw)
    return LuckyPrizeIn(**base)


def test_admin_router_guards_itself():
    app = FastAPI()
    app.include_router(router.admin_router)
    routes = [r for r in app.routes if getattr(r, "dependant", None) is not None]
    assert routes
    for r in routes:
        assert require_admin in {d.call for d in r.dependant.dependencies}, r.path


def test_create_round_and_only_one_unended(db_session, admin):
    now = common.utcnow()
    r = router.admin_create_round(LuckyRoundIn(startsAt=now, endsAt=now + timedelta(days=3)), db_session, admin)
    assert r["phase"] == "active"
    with pytest.raises(HTTPException) as e:
        router.admin_create_round(LuckyRoundIn(startsAt=now, endsAt=now + timedelta(days=5)), db_session, admin)
    assert e.value.status_code == 409


def test_round_rejects_bad_window(db_session, admin):
    now = common.utcnow()
    with pytest.raises(HTTPException):
        router.admin_create_round(LuckyRoundIn(startsAt=now, endsAt=now - timedelta(hours=1)), db_session, admin)


def test_moving_end_into_past_ends_and_voids(db_session, admin):
    now = common.utcnow()
    router.admin_create_round(LuckyRoundIn(startsAt=now - timedelta(days=1), endsAt=now + timedelta(days=1)),
                              db_session, admin)
    r = rounds.current_round(db_session)
    u = _user(db_session, "u@t.co")
    db_session.add_all([LuckyTicket(user_id=u.id, round_id=r.id, source="manual"),
                        LuckyTicket(user_id=u.id, round_id=r.id, source="manual", status="used")])
    db_session.commit()
    out = router.admin_update_round(LuckyRoundPatch(endsAt=now - timedelta(minutes=1)), db_session, admin)
    assert out["phase"] == "ended" and out["voided"] == 1
    assert rounds.current_round(db_session) is None
    assert sorted(t.status for t in db_session.query(LuckyTicket)) == ["used", "voided"]


def test_extending_end_keeps_round_open(db_session, admin):
    now = common.utcnow()
    router.admin_create_round(LuckyRoundIn(startsAt=now, endsAt=now + timedelta(days=1)), db_session, admin)
    out = router.admin_update_round(LuckyRoundPatch(endsAt=now + timedelta(days=9)), db_session, admin)
    assert out["phase"] == "active"


def test_start_cannot_change_once_active(db_session, admin):
    now = common.utcnow()
    router.admin_create_round(LuckyRoundIn(startsAt=now - timedelta(hours=1), endsAt=now + timedelta(days=1)),
                              db_session, admin)
    with pytest.raises(HTTPException):
        router.admin_update_round(LuckyRoundPatch(startsAt=now + timedelta(hours=2)), db_session, admin)


def test_end_now(db_session, admin):
    now = common.utcnow()
    router.admin_create_round(LuckyRoundIn(startsAt=now, endsAt=now + timedelta(days=1)), db_session, admin)
    out = router.admin_end_round(db_session, admin)
    assert out["phase"] == "ended"


def test_save_prizes_validates_and_audits(db_session, admin):
    with pytest.raises(HTTPException) as e:
        router.admin_save_prizes([P(probPct=40)], db_session, admin)
    assert e.value.status_code == 422
    out = router.admin_save_prizes(
        [P(name="7 天 PRO", kind="pro_days", proDays=7, probPct=10.5, stock=3), P(probPct=89.5)],
        db_session, admin)
    assert [p["probBp"] for p in out["prizes"]] == [1050, 8950]
    assert db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "lucky:prizes").count() == 1


def test_save_prizes_archives_missing_and_keeps_ids(db_session, admin):
    out = router.admin_save_prizes([P(name="A", probPct=50), P(name="B", probPct=50)], db_session, admin)
    a_id = out["prizes"][0]["id"]
    out2 = router.admin_save_prizes([P(id=a_id, name="A2", probPct=100), P(name="C", probPct=0)], db_session, admin)
    assert out2["prizes"][0]["id"] == a_id and out2["prizes"][0]["name"] == "A2"
    assert db_session.query(LuckyPrize).filter(LuckyPrize.archived.is_(True)).count() == 1


def test_stock_cannot_drop_below_used(db_session, admin):
    out = router.admin_save_prizes([P(name="A", kind="retry", probPct=50, stock=5), P(probPct=50)],
                                   db_session, admin)
    p = db_session.get(LuckyPrize, out["prizes"][0]["id"])
    p.stock_used = 4
    db_session.commit()
    with pytest.raises(HTTPException):
        router.admin_save_prizes([P(id=p.id, name="A", kind="retry", probPct=50, stock=3), P(probPct=50)],
                                 db_session, admin)


def test_visible_toggle(db_session, admin):
    router.admin_set_visible(LuckyVisibleIn(visible=True), db_session, admin, background_tasks=None)
    assert common.is_visible(db_session) is True


def _audits(db):
    import json
    return [json.loads(a.new_value) for a in
            db.query(AdminAuditLog).filter(AdminAuditLog.field == "lucky:prizes").order_by(AdminAuditLog.created_at)]


def test_prize_save_audit_records_money_fields_before_and_after(db_session, admin):
    """最终评审 I3：保存奖项的审计要带上会动钱的字段（天数、库存、每人上限、抽完规则、领取方式……）
    和改动前 / 后，以及被下架的格子。
    Final review I3: the prize-save audit carries the money-moving fields with before / after, plus archives."""
    out = router.admin_save_prizes(
        [P(name="A", kind="pro_days", proDays=7, probPct=50, stock=3), P(name="B", probPct=50)], db_session, admin)
    a_id, b_id = (p["id"] for p in out["prizes"])
    first = _audits(db_session)[-1]
    assert [c["before"] for c in first["changes"]] == [None, None]          # 新建 / created
    assert first["prizes"][0]["proDays"] == 7 and first["prizes"][0]["stock"] == 3

    router.admin_save_prizes(
        [P(id=a_id, name="A", kind="pro_days", proDays=30, probPct=50, stock=3, perUserLimit=2,
           onSoldOut="redistribute"), P(id=b_id, name="B", probPct=50)], db_session, admin)
    payload = [x for x in _audits(db_session) if x["changes"] and x["changes"][0]["before"] is not None][-1]
    assert [c["id"] for c in payload["changes"]] == [a_id]                  # B 没动不记 / unchanged B is skipped
    ch = payload["changes"][0]
    assert ch["before"]["proDays"] == 7 and ch["after"]["proDays"] == 30
    assert ch["before"]["perUserLimit"] is None and ch["after"]["perUserLimit"] == 2
    assert ch["after"]["onSoldOut"] == "redistribute"
    assert {"imageUrl", "claimMode", "sortOrder", "active"} <= set(ch["after"])
    assert payload["archived"] == []

    router.admin_save_prizes([P(id=a_id, name="A", kind="pro_days", proDays=30, probPct=100, stock=3, perUserLimit=2,
                                onSoldOut="redistribute"), P(name="C", probPct=0)], db_session, admin)
    last = [x for x in _audits(db_session) if x["archived"]][-1]
    assert [x["id"] for x in last["archived"]] == [b_id]
