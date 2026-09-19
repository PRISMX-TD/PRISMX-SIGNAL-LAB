"""邀请链接「代理」指派：派生身份、归属校验、只读名单、审计行。

照 test_invite_links.py 的惯例走 service 级测试，用 conftest 的 db_session 内存库。
"""
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, InviteLink, InviteLinkAgent, MT5Account, PageVisitorDay, User
from app.routers.invite import (
    agent_link_users,
    agent_links,
    assign_agent,
    is_agent,
    unassign_agent,
)
from app.services.account_type import DEMO, REAL
from app.services.gateway_binding import REASON_PASSWORD_CHANGED, REASON_USER_REMOVED
from app.services.stats_time import today as stats_today


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


def _visit(db, user, day, path="/signals"):
    """给用户记一个活跃日（活跃口径就是这张表里有行）。"""
    db.add(PageVisitorDay(path=path, day=day, user_id=user.id))
    db.commit()


def _mk_mt5(db, user, login, **kw):
    acc = MT5Account(user_id=user.id, login=login, **kw)
    db.add(acc)
    db.commit()
    return acc


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


# ---------- 活跃与 MT5（2026-09-19 新增字段）/ activity + MT5 ----------


def test_link_counts_actives_within_window_only(db_session):
    """近 7 日活跃按 page_visitor_days 数人，窗口外的与别人链接下的都不算。"""
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    other = _mk_link(db_session, code="othr2345", label="别人的")
    assign_agent(db_session, admin, link, agent)
    today = stats_today()

    recent = _mk_user(db_session, "recent@x.io", invite_code=link.code)
    stale = _mk_user(db_session, "stale@x.io", invite_code=link.code)
    never = _mk_user(db_session, "never@x.io", invite_code=link.code)
    theirs = _mk_user(db_session, "theirs@x.io", invite_code=other.code)

    # 同一个人两天两页 = 仍然一个人 / same person twice is still one person
    _visit(db_session, recent, today)
    _visit(db_session, recent, today - timedelta(days=6), path="/orders")
    _visit(db_session, stale, today - timedelta(days=7))  # 刚好落在窗口外
    _visit(db_session, theirs, today)
    assert never is not None

    out = agent_links(db_session, agent)
    assert len(out) == 1
    assert out[0].registrations == 3
    assert out[0].activeUsers7d == 1


def test_link_counts_mt5_people_not_bindings(db_session):
    """已连 MT5 数的是人：一人两号仍是 1，只剩撤销绑定的人不算。"""
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)

    two = _mk_user(db_session, "two@x.io", invite_code=link.code)
    _mk_mt5(db_session, two, "10001", server="B-Real 1")
    _mk_mt5(db_session, two, "10002", server="B-Real 2")
    dead = _mk_user(db_session, "dead@x.io", invite_code=link.code)
    _mk_mt5(db_session, dead, "20001", revoked_at=datetime(2026, 9, 1), revoked_reason="password_changed")
    _mk_user(db_session, "none@x.io", invite_code=link.code)

    out = agent_links(db_session, agent)
    assert out[0].mt5Users == 1


def test_user_row_carries_last_active_day_and_masked_mt5(db_session):
    """名单行：最近活跃日（到天）、MT5 打码账号 + 服务器 + 实盘/模拟 + 最近连接。"""
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    today = stats_today()

    u = _mk_user(db_session, "u@x.io", invite_code=link.code, nickname="小王")
    _visit(db_session, u, today - timedelta(days=3))
    _visit(db_session, u, today - timedelta(days=1), path="/orders")
    # 最近连接的排前面；从没心跳过的排最后 / most recent first, never-seen last
    _mk_mt5(db_session, u, "77777777", server="B-Demo", trade_mode=DEMO)
    _mk_mt5(db_session, u, "12345678", server="B-Real 3", trade_mode=REAL,
            last_heartbeat=datetime(2026, 9, 18, 6, 0))

    row = agent_link_users(db_session, agent, link.id).users[0]
    assert row.lastActiveDay == today - timedelta(days=1)
    assert [a.login for a in row.mt5Accounts] == ["123**678", "777**777"]
    first = row.mt5Accounts[0]
    assert first.server == "B-Real 3"
    assert first.accountType == "real"
    assert first.channel == "bridge"
    assert first.lastConnectedAt == datetime(2026, 9, 18, 6, 0)
    assert first.revoked is False
    assert row.mt5Accounts[1].accountType == "demo"
    assert row.mt5Accounts[1].lastConnectedAt is None
    # 资金一概不下发 / no money ever leaves
    for forbidden in ("balance", "equity", "leverage", "margin"):
        assert forbidden not in first.model_dump()


def test_user_row_without_activity_or_mt5_is_empty_not_zero(db_session):
    """从没活跃过 = null（不是某一天），没绑过 = 空数组。"""
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    _mk_user(db_session, "quiet@x.io", invite_code=link.code)

    row = agent_link_users(db_session, agent, link.id).users[0]
    assert row.lastActiveDay is None
    assert row.mt5Accounts == []


def test_revoked_gateway_binding_is_listed_and_flagged(db_session):
    """撤销的直连绑定仍然列出并标「需重连」——代理要看见"绑过但掉了"才会去提醒人。"""
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    u = _mk_user(db_session, "u@x.io", invite_code=link.code)
    _mk_mt5(db_session, u, "601130", source="gateway",
            revoked_at=datetime(2026, 9, 10), revoked_reason=REASON_PASSWORD_CHANGED)

    row = agent_link_users(db_session, agent, link.id).users[0]
    assert len(row.mt5Accounts) == 1
    assert row.mt5Accounts[0].channel == "gateway"
    assert row.mt5Accounts[0].revoked is True
    assert row.mt5Accounts[0].online is False
    # 撤销原因不下发：那是风控内部口径 / the reason stays internal
    assert "revokedReason" not in row.mt5Accounts[0].model_dump()


def test_gateway_binding_never_claims_never_connected(db_session):
    """直连账号不写心跳：lastConnectedAt 恒为 null，在线与否由通道自己说了算。

    首版拿 last_heartbeat 当两条通道通用的「最近连接」，于是每个直连账号都被显示
    成「从未连接」——这条用例就是钉这个回归的。
    """
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    u = _mk_user(db_session, "u@x.io", invite_code=link.code)
    _mk_mt5(db_session, u, "601129", source="gateway", server="B-Real 3", trade_mode=REAL)

    acc = agent_link_users(db_session, agent, link.id).users[0].mt5Accounts[0]
    assert acc.channel == "gateway"
    assert acc.lastConnectedAt is None
    assert acc.revoked is False


def test_user_removed_binding_is_not_listed_at_all(db_session):
    """用户自己解绑的账号（软删）对代理来说等于不存在：既不列出，也不算进已连人数。

    软删与「需重连」共用 revoked_at，照 revoked_at 判会把它标成"需重连"，等于让
    代理去催一个用户主动删掉的账号。
    """
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    u = _mk_user(db_session, "u@x.io", invite_code=link.code)
    _mk_mt5(db_session, u, "80499999", revoked_at=datetime(2026, 9, 10),
            revoked_reason=REASON_USER_REMOVED)

    assert agent_link_users(db_session, agent, link.id).users[0].mt5Accounts == []
    assert agent_links(db_session, agent)[0].mt5Users == 0


def test_bridge_row_is_never_flagged_for_reverification(db_session):
    """桥接行不套「需重连」：那条通道的凭证在用户手里，密码改了就是没有心跳。"""
    admin = _mk_user(db_session, "a@x.io", role="admin")
    agent = _mk_user(db_session, "agent@x.io")
    link = _mk_link(db_session)
    assign_agent(db_session, admin, link, agent)
    u = _mk_user(db_session, "u@x.io", invite_code=link.code)
    _mk_mt5(db_session, u, "80488888", source="bridge",
            revoked_at=datetime(2026, 9, 10), revoked_reason=REASON_PASSWORD_CHANGED)

    acc = agent_link_users(db_session, agent, link.id).users[0].mt5Accounts[0]
    assert acc.channel == "bridge"
    assert acc.revoked is False
