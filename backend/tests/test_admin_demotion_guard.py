"""管理员降权的两道闸：不能降自己、不能降掉最后一个在用的管理员。

停用那一侧「不能停用管理员」只有在降权本身守得住时才算数：否则「先降权、再停用」
两步就能把最后一个管理员（包括自己）关在门外，而后台之外没有恢复入口。降其他管理员
仍然允许，审计照写 role 一行。

Demotion guards: no self-demotion, never demote the last active admin. Demoting other
admins stays allowed and is audited.
"""
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, User
from app.routers.admin import bulk_update_users, disable_user, update_user
from app.schemas import AdminBulkUserUpdate, AdminUserDisableIn, AdminUserUpdate


def _mk_user(db, email, role="user", **kw) -> User:
    user = User(email=email, password_hash="x", api_token=f"tok-{email}", role=role, **kw)
    db.add(user)
    db.commit()
    return user


def test_an_admin_cannot_demote_themselves(db_session):
    admin = _mk_user(db_session, "a1@example.com", role="admin")
    _mk_user(db_session, "a2@example.com", role="admin")      # 还有别的管理员也不行
    with pytest.raises(HTTPException) as err:
        update_user(admin.id, AdminUserUpdate(role="user"), db=db_session, admin=admin)
    assert err.value.status_code == 400
    db_session.refresh(admin)
    assert admin.role == "admin"


def test_self_demotion_then_disable_path_is_closed(db_session):
    """原来的绕法：自己降权（或被降）后就能被停用。降自己这一步现在就被拦下。"""
    admin = _mk_user(db_session, "a1@example.com", role="admin")
    with pytest.raises(HTTPException):
        update_user(admin.id, AdminUserUpdate(role="user"), db=db_session, admin=admin)
    with pytest.raises(HTTPException):
        disable_user(admin.id, AdminUserDisableIn(reason="r"), db=db_session, admin=admin)
    db_session.refresh(admin)
    assert admin.role == "admin" and admin.disabled_at is None


def test_demoting_another_admin_is_allowed_and_audited(db_session):
    admin = _mk_user(db_session, "a1@example.com", role="admin")
    other = _mk_user(db_session, "a2@example.com", role="admin")
    update_user(other.id, AdminUserUpdate(role="user"), db=db_session, admin=admin)
    db_session.refresh(other)
    assert other.role == "user"
    row = db_session.query(AdminAuditLog).filter(AdminAuditLog.target_user_id == other.id).one()
    assert (row.field, row.old_value, row.new_value) == ("role", "admin", "user")


def test_cannot_demote_the_last_active_admin(db_session):
    """在用的管理员只剩对方一个时（发起人本身是被停用的旧会话之类的极端情形），拒绝。
    The acting admin isn't counted when disabled, so the target is the last active one."""
    actor = _mk_user(db_session, "a1@example.com", role="admin",
                     disabled_at=datetime.now(timezone.utc).replace(tzinfo=None))
    last = _mk_user(db_session, "a2@example.com", role="admin")
    with pytest.raises(HTTPException) as err:
        update_user(last.id, AdminUserUpdate(role="user"), db=db_session, admin=actor)
    assert err.value.status_code == 400
    db_session.refresh(last)
    assert last.role == "admin"


def test_bulk_demotion_cannot_include_yourself_and_changes_nothing(db_session):
    admin = _mk_user(db_session, "a1@example.com", role="admin")
    other = _mk_user(db_session, "a2@example.com", role="admin")
    with pytest.raises(HTTPException) as err:
        bulk_update_users(AdminBulkUserUpdate(userIds=[other.id, admin.id], role="user"),
                          db=db_session, admin=admin)
    assert err.value.status_code == 400
    db_session.refresh(other)
    assert other.role == "admin"                               # 整批不动，不留半截


def test_bulk_demotion_of_other_admins_still_works(db_session):
    admin = _mk_user(db_session, "a1@example.com", role="admin")
    a2 = _mk_user(db_session, "a2@example.com", role="admin")
    a3 = _mk_user(db_session, "a3@example.com", role="admin")
    out = bulk_update_users(AdminBulkUserUpdate(userIds=[a2.id, a3.id], role="user"),
                            db=db_session, admin=admin)
    assert out == {"updated": 2}
    db_session.refresh(a2)
    db_session.refresh(a3)
    assert a2.role == a3.role == "user"


def test_promoting_and_non_role_edits_are_unaffected(db_session):
    admin = _mk_user(db_session, "a1@example.com", role="admin")
    u = _mk_user(db_session, "u@example.com")
    update_user(admin.id, AdminUserUpdate(planNote="自己改备注"), db=db_session, admin=admin)
    update_user(u.id, AdminUserUpdate(role="admin"), db=db_session, admin=admin)
    update_user(admin.id, AdminUserUpdate(role="admin"), db=db_session, admin=admin)  # 原样提交不算降权
    db_session.refresh(u)
    assert u.role == "admin"
