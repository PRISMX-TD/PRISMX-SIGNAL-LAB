"""管理端比赛的公开推广字段（设计 §1.7/§3.2）：publicView / openAccountUrl 校验、
非 draft 可改、审计、缓存失效、首次公开时通知匿名参赛者、参赛者 nameHidden。"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, Competition, CompetitionParticipant, User, UserNotification
from app.routers import competitions as comp_router
from app.routers.competitions import (
    admin_create_competition, admin_delete_competition, admin_patch_competition,
    admin_patch_participant)
from app.schemas import CompetitionCreateIn, CompetitionParticipantPatchIn, CompetitionPatchIn
from app.services import shared_cache
from app.services.gamification.public_board import public_cache_key
from app.services.notification_feed import KIND_COMP_PUBLIC_NAME

UTC = timezone.utc
T0 = datetime(2026, 11, 1, tzinfo=UTC)
URL = "https://broker.example/open"


@pytest.fixture(autouse=True)
def _no_ws(monkeypatch):
    sent: list[str] = []
    monkeypatch.setattr(comp_router, "notify_ws", sent.append)
    return sent


def _admin(db):
    a = User(email="admin@t.co", api_token="tok_admin", role="admin")
    db.add(a); db.commit(); return a


def _body(**kw):
    d = dict(name="Demo Cup", metric="return_pct", enrollment="signup", track="demo",
             regOpensAt=T0 - timedelta(days=3), regClosesAt=T0 + timedelta(days=3),
             startsAt=T0, endsAt=T0 + timedelta(days=14))
    d.update(kw)
    return CompetitionCreateIn(**d)


def _comp(db, **kw):
    d = dict(name="Demo Cup", metric="return_pct", enrollment="signup", track="demo",
             status="upcoming", starts_at=T0, ends_at=T0 + timedelta(days=14),
             reg_opens_at=T0 - timedelta(days=3), reg_closes_at=T0 + timedelta(days=3))
    d.update(kw)
    c = Competition(**d); db.add(c); db.commit(); return c


def test_create_public_requires_demo_signup_and_https_url(db_session):
    admin = _admin(db_session)
    out = admin_create_competition(_body(publicView=True, openAccountUrl=f"  {URL}  "),
                                   db=db_session, admin=admin)
    assert out["publicView"] is True and out["openAccountUrl"] == URL
    for bad, msg in ((dict(publicView=True, track="real", openAccountUrl=URL), "仅模拟赛且报名制"),
                     (dict(publicView=True, enrollment="auto", regOpensAt=None, regClosesAt=None,
                           openAccountUrl=URL), "仅模拟赛且报名制"),
                     (dict(publicView=True), "需填写本场开户链接"),
                     (dict(openAccountUrl="http://broker.example"), "https")):
        with pytest.raises(HTTPException) as e:
            admin_create_competition(_body(**bad), db=db_session, admin=admin)
        assert e.value.status_code == 400 and msg in e.value.detail, bad
    created = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == f"competition:{out['id']}:create").one()
    assert created.admin_user_id == admin.id and created.new_value == "Demo Cup"


def test_non_draft_can_toggle_public_and_url_with_audit_and_cache_drop(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session, status="running")
    shared_cache.set_json(public_cache_key(comp.id), {"nf": 1}, ttl=60)
    out = admin_patch_competition(comp.id, CompetitionPatchIn(publicView=True, openAccountUrl=URL),
                                  db=db_session, admin=admin)
    assert out["publicView"] is True and out["openAccountUrl"] == URL
    assert shared_cache.get_json(public_cache_key(comp.id)) is None
    fields = {r.field: (r.old_value, r.new_value) for r in db_session.query(AdminAuditLog).all()}
    assert fields[f"competition:{comp.id}:publicView"] == ("False", "True")
    assert fields[f"competition:{comp.id}:openAccountUrl"] == ("", URL)


def test_patch_rejects_making_public_comp_non_compliant(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session, status="draft", public_view=True, open_account_url=URL)
    with pytest.raises(HTTPException) as e:
        admin_patch_competition(comp.id, CompetitionPatchIn(track="real"), db=db_session, admin=admin)
    assert e.value.status_code == 400
    with pytest.raises(HTTPException):
        admin_patch_competition(comp.id, CompetitionPatchIn(openAccountUrl=None),
                                db=db_session, admin=admin)
    db_session.refresh(comp)
    assert comp.track == "demo" and comp.open_account_url == URL


def test_patch_audits_each_changed_field(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session, status="draft")
    admin_patch_competition(comp.id, CompetitionPatchIn(name="Renamed", prizeNote="100U"),
                            db=db_session, admin=admin)
    rows = {r.field: r.new_value for r in db_session.query(AdminAuditLog).all()}
    assert rows == {f"competition:{comp.id}:name": "Renamed",
                    f"competition:{comp.id}:prizeNote": "100U"}


def test_patch_resending_unchanged_public_fields_writes_no_audit(db_session):
    """前端每次 PATCH 都会带 publicView/openAccountUrl；值没变（含首尾空白、NULL 与 False 同义）不留审计。"""
    admin = _admin(db_session)
    comp = _comp(db_session, status="running", public_view=None, open_account_url=URL)
    admin_patch_competition(comp.id, CompetitionPatchIn(publicView=False, openAccountUrl=f" {URL} "),
                            db=db_session, admin=admin)
    plain = _comp(db_session, status="running")      # public_view 默认 False、无链接
    admin_patch_competition(plain.id, CompetitionPatchIn(publicView=False, openAccountUrl="  "),
                            db=db_session, admin=admin)
    assert db_session.query(AdminAuditLog).count() == 0


def test_first_public_flip_notifies_undecided_entrants_once(db_session, _no_ws):
    admin = _admin(db_session)
    comp = _comp(db_session, status="upcoming", open_account_url=URL)
    undecided = User(email="u1@t.co", api_token="tok_u1")
    agreed = User(email="u2@t.co", api_token="tok_u2")
    db_session.add_all([undecided, agreed]); db_session.commit()
    db_session.add_all([
        CompetitionParticipant(competition_id=comp.id, user_id=undecided.id, mt5_login="1"),
        CompetitionParticipant(competition_id=comp.id, user_id=undecided.id, mt5_login="2"),
        CompetitionParticipant(competition_id=comp.id, user_id=agreed.id, mt5_login="3",
                               public_name=True)])
    db_session.commit()

    admin_patch_competition(comp.id, CompetitionPatchIn(publicView=True), db=db_session, admin=admin)
    admin_patch_competition(comp.id, CompetitionPatchIn(publicView=False), db=db_session, admin=admin)
    admin_patch_competition(comp.id, CompetitionPatchIn(publicView=True), db=db_session, admin=admin)

    notes = db_session.query(UserNotification).filter(
        UserNotification.kind == KIND_COMP_PUBLIC_NAME).all()
    assert [(n.user_id, n.ref_id) for n in notes] == [(undecided.id, comp.id)]
    assert notes[0].link == f"/competitions?c={comp.id}"
    assert _no_ws == [undecided.id]


def test_delete_is_audited_and_drops_cache(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session)
    shared_cache.set_json(public_cache_key(comp.id), {"x": 1}, ttl=60)
    admin_delete_competition(comp.id, db=db_session, admin=admin)
    assert shared_cache.get_json(public_cache_key(comp.id)) is None
    row = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == f"competition:{comp.id}:delete").one()
    assert row.old_value == "Demo Cup" and row.new_value == "deleted"


def test_participant_name_hidden_toggle_even_after_settle(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session, status="settled")
    u = User(email="p@t.co", api_token="tok_p"); db_session.add(u); db_session.commit()
    p = CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login="9",
                               public_name=True)
    db_session.add(p); db_session.commit()
    shared_cache.set_json(public_cache_key(comp.id), {"x": 1}, ttl=60)

    out = admin_patch_participant(comp.id, p.id, CompetitionParticipantPatchIn(nameHidden=True),
                                  db=db_session, admin=admin)

    assert out["nameHidden"] is True and out["publicName"] is True
    assert out["disqualified"] is False                       # 没传 disqualified 就不动
    assert shared_cache.get_json(public_cache_key(comp.id)) is None
    assert db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == f"competition:participant:{p.id}:nameHidden").count() == 1
    with pytest.raises(HTTPException):                       # 终审后仍不能改资格
        admin_patch_participant(comp.id, p.id, CompetitionParticipantPatchIn(disqualified=True),
                                db=db_session, admin=admin)


def test_disqualify_and_requalify_drop_public_cache(db_session):
    """取消/恢复资格后公开榜缓存要立刻失效，被取消者不能留在缓存里。"""
    admin = _admin(db_session)
    comp = _comp(db_session, status="running")
    u = User(email="q@t.co", api_token="tok_q"); db_session.add(u); db_session.commit()
    p = CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login="8")
    db_session.add(p); db_session.commit()
    for flag in (True, False):
        shared_cache.set_json(public_cache_key(comp.id), {"x": 1}, ttl=60)
        admin_patch_participant(
            comp.id, p.id,
            CompetitionParticipantPatchIn(disqualified=flag, disqualifyReason="x" if flag else None),
            db=db_session, admin=admin)
        assert shared_cache.get_json(public_cache_key(comp.id)) is None, flag
