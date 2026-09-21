"""后台批量指派「注册归因」：写入、校验、清除、筛选、审计。

归因（users.invite_code）决定一个用户算在哪条邀请链接名下，也就是哪个代理能在
/agent 页看到他。这个字段此前只有注册流程写得了，管理后台连读都读不到，改一批
存量用户只能上生产库跑 SQL。这组用例钉住新开的这条后台通路。

最要紧的是 test_bulk_rejects_unknown_code：写进一个不存在的码不会报任何错，只会
让这批人从此不属于任何代理，而代理页只表现为"人数莫名其妙少了"。

Backend path for bulk-assigning signup attribution (users.invite_code), which
decides whose /agent page a user shows up on. Until now only registration could
write it and the admin console could not even read it.
"""
import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, InviteLink, User
from app.routers.admin import (
    NO_INVITE,
    _user_out,
    bulk_update_users,
    list_users,
    update_user,
)
from app.schemas import AdminBulkUserUpdate, AdminUserUpdate


def _link(db, code, label="渠道"):
    link = InviteLink(code=code, label=label)
    db.add(link); db.commit(); return link


def _user(db, email, **kw):
    u = User(email=email, api_token="tok_" + email, **kw)
    db.add(u); db.commit(); return u


def _admin(db):
    return _user(db, "admin@t.co", role="admin")


def _list(db, admin, **kw):
    """list_users 的直调壳：Query(...) 默认值直调时拿不到，所以全部显式传。"""
    params = dict(q=None, plan=None, role=None, invite_code=None, limit=50, offset=0)
    params.update(kw)
    return list_users(db=db, _admin=admin, **params)


# ---------- 读：列表里看得见归因 ----------


def test_user_out_carries_invite_code():
    """载荷里漏了这个字段不会报错，只是前端永远显示"未归因"——而管理员正是靠
    这一列核对批量指派改对了没有。"""
    u = User(id="u1", email="a@b.com", role="user", plan="FREE", invite_code="abcd2345")
    assert _user_out(u, 0).inviteCode == "abcd2345"


def test_list_filters_by_code(db_session):
    admin = _admin(db_session)
    _link(db_session, "abcd2345")
    _user(db_session, "in@t.co", invite_code="abcd2345")
    _user(db_session, "out@t.co", invite_code="zzzz9876")
    _user(db_session, "none@t.co")

    res = _list(db_session, admin, invite_code="abcd2345")
    assert [u["email"] for u in res["users"]] == ["in@t.co"]
    assert res["total"] == 1


def test_list_filters_unattributed(db_session):
    """「未归因」要能单独筛出来：批量指派的起手式就是先把这批人找出来。"""
    admin = _admin(db_session)
    _user(db_session, "has@t.co", invite_code="abcd2345")
    _user(db_session, "none@t.co")

    res = _list(db_session, admin, invite_code=NO_INVITE)
    # 管理员自己也没有归因，一并被筛出来是对的；这里只断言有归因的那个不在
    emails = [u["email"] for u in res["users"]]
    assert "none@t.co" in emails
    assert "has@t.co" not in emails


# ---------- 写：批量指派 ----------


def test_bulk_assigns_and_audits(db_session):
    admin = _admin(db_session)
    _link(db_session, "abcd2345", "时空节拍")
    a = _user(db_session, "a@t.co")
    b = _user(db_session, "b@t.co", invite_code="zzzz9876")

    body = AdminBulkUserUpdate(userIds=[a.id, b.id], inviteCode="abcd2345")
    assert bulk_update_users(body=body, db=db_session, admin=admin) == {"updated": 2}

    db_session.refresh(a); db_session.refresh(b)
    assert a.invite_code == "abcd2345"
    assert b.invite_code == "abcd2345"

    rows = db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "invite_code").all()
    assert len(rows) == 2
    # 旧值必须留下来——审计行存在的唯一理由就是回答"改之前挂在谁名下"。
    # 空值在这张表里一律记成空串（见 services/audit.py 的 log_change）。
    assert {r.old_value for r in rows} == {"", "zzzz9876"}
    assert {r.new_value for r in rows} == {"abcd2345"}


def test_bulk_rejects_unknown_code(db_session):
    """码不存在必须 400，且整批一个都不许动。

    写进一个不存在的码不会报错，只会让这批人从此不属于任何代理——而这在界面上
    看不出来，代理页只是人数少了。校验也必须在进循环**之前**做完，否则会留下
    "前两个改了、后面没改"的半截状态。
    """
    admin = _admin(db_session)
    a = _user(db_session, "a@t.co", invite_code="zzzz9876")

    with pytest.raises(HTTPException) as e:
        bulk_update_users(
            body=AdminBulkUserUpdate(userIds=[a.id], inviteCode="notacode"),
            db=db_session,
            admin=admin,
        )
    assert e.value.status_code == 400

    db_session.rollback()
    db_session.refresh(a)
    assert a.invite_code == "zzzz9876"
    assert db_session.query(AdminAuditLog).count() == 0


def test_bulk_normalizes_case_and_space(db_session):
    """从后台复制粘贴出来的码常带空格或大小写；invite_links.code 全小写。"""
    admin = _admin(db_session)
    _link(db_session, "abcd2345")
    a = _user(db_session, "a@t.co")

    bulk_update_users(
        body=AdminBulkUserUpdate(userIds=[a.id], inviteCode="  ABCD2345 "),
        db=db_session,
        admin=admin,
    )
    db_session.refresh(a)
    assert a.invite_code == "abcd2345"


def test_bulk_leaves_plan_note_alone(db_session):
    """归因与备注是两件事：备注常是手写的，指派不该顺手把它覆盖掉。"""
    admin = _admin(db_session)
    _link(db_session, "abcd2345", "时空节拍")
    a = _user(db_session, "a@t.co", plan_note="手写的备注")

    bulk_update_users(
        body=AdminBulkUserUpdate(userIds=[a.id], inviteCode="abcd2345"),
        db=db_session,
        admin=admin,
    )
    db_session.refresh(a)
    assert a.plan_note == "手写的备注"


def test_bulk_without_invite_code_does_not_clear_it(db_session):
    """不传这个字段 = 不动它。批量改等级时顺手把全场归因清空是不可接受的。"""
    admin = _admin(db_session)
    a = _user(db_session, "a@t.co", invite_code="abcd2345")

    bulk_update_users(
        body=AdminBulkUserUpdate(userIds=[a.id], plan="PRO"),
        db=db_session,
        admin=admin,
    )
    db_session.refresh(a)
    assert a.invite_code == "abcd2345"
    assert a.plan == "PRO"


def test_bulk_explicit_null_clears(db_session):
    """显式传 null = 清除归因，指派错了要能撤回。"""
    admin = _admin(db_session)
    a = _user(db_session, "a@t.co", invite_code="abcd2345")

    bulk_update_users(
        body=AdminBulkUserUpdate(userIds=[a.id], inviteCode=None),
        db=db_session,
        admin=admin,
    )
    db_session.refresh(a)
    assert a.invite_code is None
    row = db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "invite_code").one()
    assert (row.old_value, row.new_value) == ("abcd2345", "")


# ---------- 写：单用户 PATCH 走同一条路径 ----------


def test_single_patch_assigns(db_session):
    """单用户与批量共用 _apply_user_fields；两边行为必须一致。"""
    admin = _admin(db_session)
    _link(db_session, "abcd2345")
    a = _user(db_session, "a@t.co")

    out = update_user(
        user_id=a.id,
        body=AdminUserUpdate(inviteCode="abcd2345"),
        db=db_session,
        admin=admin,
    )
    assert out.inviteCode == "abcd2345"


def test_single_patch_rejects_unknown_code(db_session):
    admin = _admin(db_session)
    a = _user(db_session, "a@t.co")
    with pytest.raises(HTTPException) as e:
        update_user(
            user_id=a.id,
            body=AdminUserUpdate(inviteCode="notacode"),
            db=db_session,
            admin=admin,
        )
    assert e.value.status_code == 400
