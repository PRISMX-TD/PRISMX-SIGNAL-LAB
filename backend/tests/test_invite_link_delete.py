"""删除邀请链接：没人经它注册 → 硬删（行与代理行都没了）；有人注册 → 软删（deleted_at、
停用、代理移除，用户归因与备注不动，默认列表不出现、includeDeleted 才给，点击不计、
pick_ref 不选、码永不被重新生成）。再删一次 404。

照 test_invite_links 的惯例走 service 级测试（路由函数直接调用，Depends 默认值显式传）。
Deleting invite links: hard delete when nobody registered through the link, soft
delete otherwise. Service-level tests, route functions called directly.
"""
import json

import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, InviteLink, InviteLinkAgent, User
from app.routers.invite import (
    _active_link,
    agent_links,
    assign_agent,
    assign_invite_agent,
    delete_invite_link,
    list_invite_links,
    new_unique_code,
    offer_days,
    pick_ref,
    record_click,
    update_invite_link,
)
from app.schemas import InviteLinkAssignAgent, InviteLinkUpdate


def _mk_user(db, email, **kw):
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


def _admin(db):
    return db.query(User).filter(User.email == "admin@x.io").first() or _mk_user(db, "admin@x.io", role="admin")


def _mk_link(db, code, label=None):
    link = InviteLink(code=code, label=label or "L-" + code, is_active=True, grants_trial=False)
    db.add(link)
    db.commit()
    return link


def _list(db, include_deleted=False):
    res = list_invite_links(
        kind=None, competitionId=None, channel=None, includeDeleted=include_deleted,
        db=db, _admin=_admin(db),
    )
    return {l["code"]: l for l in res["links"]}


def _audit(db, code):
    return (
        db.query(AdminAuditLog)
        .filter(AdminAuditLog.field == f"invite:{code}")
        .order_by(AdminAuditLog.created_at.desc())
        .all()
    )


# ---------- 硬删 / hard delete ----------

def test_hard_delete_when_no_registrations(db_session):
    db = db_session
    link = _mk_link(db, "hard2345")
    agent = _mk_user(db, "agent@x.io")
    assign_agent(db, _admin(db), link, agent)
    link_id = link.id

    out = delete_invite_link(link_id, db=db, admin=_admin(db))

    assert out == {"mode": "hard"}
    db.expire_all()
    assert db.get(InviteLink, link_id) is None
    assert db.query(InviteLinkAgent).filter(InviteLinkAgent.link_id == link_id).count() == 0
    rows = _audit(db, "hard2345")
    assert any(r.new_value and json.loads(r.new_value) == {"deleted": "hard"} for r in rows)
    assert agent_links(db, agent) == []


def test_hard_deleted_code_can_be_generated_again(db_session, monkeypatch):
    db = db_session
    link = _mk_link(db, "reuse234")
    delete_invite_link(link.id, db=db, admin=_admin(db))
    monkeypatch.setattr("app.routers.invite.generate_code", lambda: "reuse234")
    assert new_unique_code(db) == "reuse234"


# ---------- 软删 / soft delete ----------

@pytest.fixture()
def soft_deleted(db_session):
    db = db_session
    link = _mk_link(db, "soft2345", label="合作方A")
    agent = _mk_user(db, "agent@x.io")
    assign_agent(db, _admin(db), link, agent)
    user = _mk_user(db, "u@x.io", invite_code="soft2345", plan_note="合作方A")
    out = delete_invite_link(link.id, db=db, admin=_admin(db))
    db.expire_all()
    return out, db.get(InviteLink, link.id), agent, user


def test_soft_delete_when_registrations(db_session, soft_deleted):
    db = db_session
    out, link, agent, user = soft_deleted
    assert out == {"mode": "soft"}
    assert link is not None
    assert link.deleted_at is not None
    assert link.is_active is False
    assert db.query(InviteLinkAgent).filter(InviteLinkAgent.link_id == link.id).count() == 0
    assert agent_links(db, agent) == []
    db.refresh(user)
    assert user.invite_code == "soft2345"
    assert user.plan_note == "合作方A"
    rows = _audit(db, "soft2345")
    assert any(r.new_value and json.loads(r.new_value) == {"deleted": "soft"} for r in rows)


def test_soft_deleted_excluded_from_default_list_included_on_request(db_session, soft_deleted):
    db = db_session
    _mk_link(db, "live2345")
    default = _list(db)
    assert "soft2345" not in default
    assert default["live2345"]["deletedAt"] is None
    full = _list(db, include_deleted=True)
    assert full["soft2345"]["deletedAt"] is not None
    assert full["soft2345"]["label"] == "合作方A"
    assert full["soft2345"]["registrations"] == 1
    assert full["live2345"]["deletedAt"] is None


def test_soft_deleted_click_not_counted(db_session, soft_deleted):
    db = db_session
    _, link, _, _ = soft_deleted
    record_click(db, "soft2345")
    db.refresh(link)
    assert link.clicks == 0


def test_soft_deleted_is_not_an_active_link(db_session, soft_deleted):
    db = db_session
    _, link, _, _ = soft_deleted
    # 就算有人把 is_active 改回真，deleted_at 仍让它失效 / deleted_at wins even if is_active flips back
    link.is_active = True
    db.commit()
    assert _active_link(db, "soft2345") is None
    assert offer_days(db, "soft2345") is None
    assert pick_ref(db, ["soft2345"]) is None
    _mk_link(db, "live2345")
    assert pick_ref(db, ["soft2345", "live2345"]) == "live2345"
    record_click(db, "soft2345")
    db.refresh(link)
    assert link.clicks == 0


def test_new_unique_code_never_returns_soft_deleted_code(db_session, soft_deleted, monkeypatch):
    db = db_session
    seq = iter(["soft2345", "fresh234"])
    monkeypatch.setattr("app.routers.invite.generate_code", lambda: next(seq))
    assert new_unique_code(db) == "fresh234"


def test_soft_deleted_rejects_patch_and_assign(db_session, soft_deleted):
    db = db_session
    _, link, _, _ = soft_deleted
    other = _mk_user(db, "other@x.io")
    with pytest.raises(HTTPException) as exc:
        update_invite_link(link.id, InviteLinkUpdate(label="x"), db=db, admin=_admin(db))
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        assign_invite_agent(link.id, InviteLinkAssignAgent(userId=other.id), db=db, admin=_admin(db))
    assert exc.value.status_code == 404


def test_second_delete_is_404(db_session, soft_deleted):
    db = db_session
    _, link, _, _ = soft_deleted
    with pytest.raises(HTTPException) as exc:
        delete_invite_link(link.id, db=db, admin=_admin(db))
    assert exc.value.status_code == 404


def test_delete_unknown_and_hard_deleted_is_404(db_session):
    db = db_session
    with pytest.raises(HTTPException) as exc:
        delete_invite_link("nope", db=db, admin=_admin(db))
    assert exc.value.status_code == 404
    link = _mk_link(db, "gone2345")
    delete_invite_link(link.id, db=db, admin=_admin(db))
    with pytest.raises(HTTPException) as exc:
        delete_invite_link(link.id, db=db, admin=_admin(db))
    assert exc.value.status_code == 404


def test_delete_route_requires_admin_on_endpoint():
    from app.routers.invite import admin_router
    from app.services.deps import require_admin

    route = next(r for r in admin_router.routes if r.path.endswith("/{link_id}") and "DELETE" in r.methods)
    assert any(d.call is require_admin for d in route.dependant.dependencies)
