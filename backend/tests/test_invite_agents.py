"""邀请链接「代理」指派：派生身份、归属校验、只读名单、审计行。

照 test_invite_links.py 的惯例走 service 级测试，用 conftest 的 db_session 内存库。
"""
import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, InviteLink, InviteLinkAgent, User
from app.routers.invite import (
    agent_link_users,
    agent_links,
    assign_agent,
    is_agent,
    unassign_agent,
)


def _mk_link(db, code="abcd2345", label="测试渠道", active=True):
    link = InviteLink(code=code, label=label, is_active=active)
    db.add(link)
    db.commit()
    return link


def _mk_user(db, email="u@example.com", **kw):
    user = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(user)
    db.commit()
    return user


def test_agent_is_derived_not_a_role(db_session):
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)

    assert is_agent(db_session, agent.id) is False
    assign_agent(db_session, admin, link, agent)
    assert is_agent(db_session, agent.id) is True
    # 权益轴与权力轴都不动 / neither axis moves
    db_session.refresh(agent)
    assert agent.role == "user"
    assert agent.plan == "FREE"

    unassign_agent(db_session, admin, link, agent.id)
    assert is_agent(db_session, agent.id) is False


def test_duplicate_assignment_is_409(db_session):
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    with pytest.raises(HTTPException) as exc:
        assign_agent(db_session, admin, link, agent)
    assert exc.value.status_code == 409
    assert db_session.query(InviteLinkAgent).count() == 1


def test_unassign_missing_is_404(db_session):
    admin = _mk_user(db_session, "a@x.io", role="admin")
    link = _mk_link(db_session)
    with pytest.raises(HTTPException) as exc:
        unassign_agent(db_session, admin, link, "nobody")
    assert exc.value.status_code == 404


def test_agent_sees_only_own_links_with_counts(db_session):
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    mine = _mk_link(db_session, code="mine2345", label="我的")
    other = _mk_link(db_session, code="othr2345", label="别人的")
    mine.clicks = 7
    db_session.commit()
    _mk_user(db_session, "r1@x.io", invite_code="mine2345")
    _mk_user(db_session, "r2@x.io", invite_code="mine2345")
    _mk_user(db_session, "r3@x.io", invite_code="othr2345")
    assign_agent(db_session, admin, mine, agent)

    out = agent_links(db_session, agent)
    assert [l.code for l in out] == ["mine2345"]
    assert out[0].clicks == 7
    assert out[0].registrations == 2
    assert out[0].isActive is True
    # 代理视图不含 grantsTrial / no grantsTrial on the agent view
    assert "grantsTrial" not in out[0].model_dump()
    assert other.id not in {l.id for l in out}


def test_disabled_link_still_listed_for_agent(db_session):
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session, active=False)
    assign_agent(db_session, admin, link, agent)
    out = agent_links(db_session, agent)
    assert len(out) == 1 and out[0].isActive is False


def test_user_list_is_read_only_and_masked(db_session):
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    _mk_user(db_session, "registered@example.com", invite_code=link.code,
             nickname="小王", phone="+60123456789", plan="PRO")

    page = agent_link_users(db_session, agent, link.id)
    assert page.total == 1
    row = page.users[0].model_dump()
    assert row["nickname"] == "小王"
    # 邮箱给完整值（2026-09-15 产品决定）；手机号与 id 仍然不出网。
    # The email is the real one (product decision, 2026-09-15); phone and id stay in.
    assert row["email"] == "registered@example.com"
    assert row["plan"] == "PRO"
    for forbidden in ("phone", "id", "userId"):
        assert forbidden not in row


def test_user_list_of_unowned_link_is_404(db_session):
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    stranger = _mk_user(db_session, "stranger@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)

    with pytest.raises(HTTPException) as exc:
        agent_link_users(db_session, stranger, link.id)
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc2:
        agent_link_users(db_session, agent, "no-such-link")
    assert exc2.value.status_code == 404


def test_user_list_pagination(db_session):
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    for i in range(5):
        _mk_user(db_session, f"r{i}@x.io", invite_code=link.code)
    page = agent_link_users(db_session, agent, link.id, limit=2, offset=2)
    assert page.total == 5
    assert len(page.users) == 2
    assert page.limit == 2 and page.offset == 2


def test_assignment_writes_audit_with_real_target(db_session):
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    unassign_agent(db_session, admin, link, agent.id)

    rows = db_session.query(AdminAuditLog).order_by(AdminAuditLog.created_at).all()
    assert len(rows) == 2
    assert all(r.admin_user_id == admin.id for r in rows)
    assert all(r.target_user_id == agent.id for r in rows)
    assert all(r.field == f"invite:{link.code}:agent" for r in rows)
    assert (rows[0].old_value or "") == "" and rows[0].new_value == "assigned"
    assert rows[1].old_value == "assigned" and (rows[1].new_value or "") == ""
