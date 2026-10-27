"""代理层级（rev 47，rev 50 拆分来源与归属）：任命 / 升 / 撤代理、范围、只有一级能写、最大层级、
改挂上级、链接转手与删除不带走客户、管理员改归属。

照 test_invite_agents.py 的惯例走 service 级测试，用 conftest 的 db_session 内存库（新插入的
`User(invite_code=...)` 会按注册规则自动补上归属代理，见 conftest._autofill_signup_owner）。
树的形状（大多数用例共用）：

    admin ──任命──▶ A（一级，链接 la）
                     ├─ a1（A 的客户）
                     └─ B（经 la 注册，被 A 升为二级，链接 lb 自动生成）
                          └─ c1（B 的客户）
"""
import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, AgentNode, InviteLink, User, UserNotification
from app.routers.admin import _apply_user_fields
from app.routers.invite import (
    admin_agent_tree,
    admin_appoint_agent,
    admin_move_agent,
    admin_revoke_agent,
    admin_set_link_owner,
    agent_demote,
    agent_links,
    agent_promote,
    agent_set_plan,
    agent_team,
    agent_tree_set_plan,
    agent_tree_users,
    delete_invite_link,
    is_agent,
    unassign_agent,
)
from app.schemas import AdminAgentAppoint, AdminAgentMove, AdminLinkOwnerUpdate, AgentPlanUpdate
from app.services.agent_tree import check_customer_agent
from app.services.settings_store import invalidate_agent_cache, save_agent_settings


@pytest.fixture(autouse=True)
def _fresh_agent_settings():
    # 设置走进程级缓存：每个用例前后都清掉，免得上一个用例调过的层级漏进来。
    # Settings are cached per process; clear around every test.
    invalidate_agent_cache()
    yield
    invalidate_agent_cache()


def _mk_user(db, email, **kw):
    user = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(user)
    db.commit()
    return user


def _link_of(db, user):
    return (
        db.query(InviteLink)
        .filter(InviteLink.owner_user_id == user.id)
        .order_by(InviteLink.created_at)
        .first()
    )


def _appoint(db, admin, user, parent=None, create_link=True):
    admin_appoint_agent(
        db, admin, AdminAgentAppoint(userId=user.id, parentUserId=parent.id if parent else None, createLink=create_link)
    )
    return _link_of(db, user)


def _tree(db, grants_trial=False):
    admin = _mk_user(db, "admin@x.io", role="admin")
    a = _mk_user(db, "a@x.io")
    la = _appoint(db, admin, a)
    if grants_trial:
        la.grants_trial = True
        db.commit()
    a1 = _mk_user(db, "a1@x.io", invite_code=la.code)
    b = _mk_user(db, "b@x.io", invite_code=la.code, nickname="小B")
    agent_promote(db, a, b.email)
    lb = _link_of(db, b)
    c1 = _mk_user(db, "c1@x.io", invite_code=lb.code)
    return admin, a, la, a1, b, lb, c1


def _emails(page):
    return {u.email for u in page.users}


def _plan(email, days=30):
    return AgentPlanUpdate(email=email, action="extend", days=days)


# ---------- 任命 / appointment ----------

def test_admin_appointment_makes_a_top_level_node_with_a_link(db_session):
    admin = _mk_user(db_session, "admin@x.io", role="admin")
    a = _mk_user(db_session, "a@x.io", nickname="阿A")
    la = _appoint(db_session, admin, a)
    node = db_session.query(AgentNode).filter_by(user_id=a.id).one()
    assert node.parent_user_id is None and node.depth == 1
    assert la is not None and la.label == "阿A" and la.is_active and la.grants_trial is False
    team = agent_team(db_session, a)
    assert team.level == 1 and team.canManage is True and team.maxDepth == 5


def test_an_agent_without_links_is_still_an_agent(db_session):
    admin = _mk_user(db_session, "admin@x.io", role="admin")
    a = _mk_user(db_session, "a@x.io")
    assert _appoint(db_session, admin, a, create_link=False) is None
    assert is_agent(db_session, a.id)
    assert agent_team(db_session, a).isAgent is True


def test_appointment_under_a_parent_and_guards(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    x = _mk_user(db_session, "x@x.io")
    _appoint(db_session, admin, x, parent=b)
    assert db_session.query(AgentNode).filter_by(user_id=x.id).one().depth == 3
    assert {n.email for n in agent_team(db_session, a).nodes} == {a.email, b.email, x.email}
    for body, code in (
        (AdminAgentAppoint(userId=x.id), 409),  # 已是代理 / already an agent
        (AdminAgentAppoint(userId=a1.id, parentUserId=c1.id), 404),  # 上级不是代理 / bad parent
        (AdminAgentAppoint(userId="ghost"), 404),
    ):
        with pytest.raises(HTTPException) as exc:
            admin_appoint_agent(db_session, admin, body)
        assert exc.value.status_code == code
    save_agent_settings(db_session, {"agent_max_depth": 3})
    db_session.commit()
    invalidate_agent_cache()
    with pytest.raises(HTTPException) as exc:
        admin_appoint_agent(db_session, admin, AdminAgentAppoint(userId=a1.id, parentUserId=x.id))
    assert exc.value.status_code == 409


def test_cross_tree_appointment_takes_the_person_out_of_the_old_tree(db_session):
    """问题 3 的回归：A 的客户 a1 被管理员任命为另一棵树的一级代理后，A 既看不到也改不了他。
    Regression: once A's customer is appointed elsewhere, A neither sees nor edits them."""
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    _appoint(db_session, admin, a1)
    assert a1.email not in _emails(agent_tree_users(db_session, a))
    with pytest.raises(HTTPException) as exc:
        agent_tree_set_plan(db_session, a, _plan(a1.email))
    assert exc.value.status_code == 404
    db_session.refresh(a1)
    assert a1.invite_code == la.code  # 来源不动 / the source is untouched


# ---------- 升代理 / promotion ----------

def test_promotion_builds_a_child_with_its_own_link(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session, grants_trial=True)
    node = db_session.query(AgentNode).filter_by(user_id=b.id).one()
    assert node.parent_user_id == a.id and node.depth == 2 and node.created_by == a.id
    assert is_agent(db_session, b.id)
    # 新链接：标记名 = 昵称，送试用跟着他来源那条链接走，开户网址留空。
    assert lb.label == "小B" and lb.grants_trial is True and lb.open_account_url is None
    assert lb.code != la.code
    kinds = {(n.user_id, n.kind) for n in db_session.query(UserNotification).all()}
    assert (b.id, "agent_promoted") in kinds
    assert (admin.id, "agent_tree_change") in kinds


def test_parent_is_the_customers_owner_not_the_promoter(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    # c1 归 B，由 A 来升：上级是 B，三级。
    row = agent_promote(db_session, a, c1.email)
    assert row.agentLevel == 3 and row.viaEmail == b.email
    node = db_session.query(AgentNode).filter_by(user_id=c1.id).one()
    assert node.parent_user_id == b.id


def test_promotion_guards(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    with pytest.raises(HTTPException) as exc:
        agent_promote(db_session, a, b.email)
    assert exc.value.status_code == 409
    outsider = _mk_user(db_session, "out@x.io")
    sneaky_admin = _mk_user(db_session, "boss@x.io", role="admin", invite_code=la.code)
    for email in (outsider.email, sneaky_admin.email):
        with pytest.raises(HTTPException) as exc:
            agent_promote(db_session, a, email)
        assert exc.value.status_code == 404


def test_max_depth_is_enforced_and_adjustable(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    save_agent_settings(db_session, {"agent_max_depth": 2})
    db_session.commit()
    invalidate_agent_cache()
    assert agent_team(db_session, a).maxDepth == 2
    with pytest.raises(HTTPException) as exc:
        agent_promote(db_session, a, c1.email)
    assert exc.value.status_code == 409
    # 调低不影响已有的二级 B。/ Lowering it demotes nobody.
    assert db_session.query(AgentNode).filter_by(user_id=b.id).one().depth == 2
    save_agent_settings(db_session, {"agent_max_depth": 3})
    db_session.commit()
    invalidate_agent_cache()
    assert agent_promote(db_session, a, c1.email).agentLevel == 3


# ---------- 范围 / scope ----------

def test_upper_sees_the_whole_subtree_lower_sees_only_its_own(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)

    a_team = agent_team(db_session, a)
    assert [n.email for n in a_team.nodes] == [a.email, b.email]
    assert a_team.nodes[0].parentEmail is None and a_team.nodes[0].isSelf
    assert a_team.nodes[1].parentEmail == a.email
    # 客户只数普通客户：A 直属 a1，整棵树再加 B 的 c1。B 本人是代理，不算客户。
    assert a_team.nodes[0].directCustomers == 1 and a_team.nodes[0].teamCustomers == 2
    assert a_team.nodes[1].directCustomers == 1 and a_team.nodes[1].teamCustomers == 1
    # 名单里有下级代理本人。/ The list includes the sub-agents themselves.
    assert _emails(agent_tree_users(db_session, a)) == {a1.email, b.email, c1.email}

    b_team = agent_team(db_session, b)
    assert b_team.isAgent and b_team.level is None and b_team.canManage is False
    # 下级看不到上级：自己那一行没有 parentEmail，树里也没有 A。
    assert [n.email for n in b_team.nodes] == [b.email]
    assert b_team.nodes[0].parentEmail is None
    assert _emails(agent_tree_users(db_session, b)) == {c1.email}


def test_customer_rows_say_which_agent_they_hang_under(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    rows = {u.email: u for u in agent_tree_users(db_session, a).users}
    assert rows[c1.email].viaEmail == b.email
    assert rows[a1.email].viaEmail == a.email
    assert rows[b.email].viaEmail == a.email and rows[b.email].viaNickname is None
    assert rows[b.email].agentLevel == 2 and rows[a1.email].agentLevel is None
    assert rows[b.email].isAgent and not rows[a1.email].isAgent


def test_sub_agents_never_see_levels(db_session):
    # 2026-10-24 产品决定：二级起看不到自己（和下级）是第几级，只有一级代理看得到层级。
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    agent_promote(db_session, a, c1.email)  # c1 成为 B 下面的第 3 级

    a_team = agent_team(db_session, a)
    assert [n.level for n in a_team.nodes] == [1, 2, 3]

    b_team = agent_team(db_session, b)
    assert b_team.isAgent and b_team.level is None
    assert [n.email for n in b_team.nodes] == [b.email, c1.email]
    assert all(n.level is None for n in b_team.nodes)
    row = next(u for u in agent_tree_users(db_session, b).users if u.email == c1.email)
    assert row.isAgent and row.agentLevel is None
    row = next(u for u in agent_tree_users(db_session, a).users if u.email == c1.email)
    assert row.isAgent and row.agentLevel == 3


def test_filters_by_agent_and_by_link_stay_inside_the_scope(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    assert _emails(agent_tree_users(db_session, a, under=b.email)) == {c1.email}
    assert _emails(agent_tree_users(db_session, a, under="A@X.IO")) == {a1.email, b.email}
    assert _emails(agent_tree_users(db_session, a, link_id=lb.id)) == {c1.email}
    assert _emails(agent_tree_users(db_session, a, link_id=la.id)) == {a1.email, b.email}
    # 往上、往外都是同一个 404。
    for who, kw in ((b, {"under": a.email}), (a, {"under": "nobody@x.io"}), (b, {"link_id": la.id})):
        with pytest.raises(HTTPException) as exc:
            agent_tree_users(db_session, who, **kw)
        assert exc.value.status_code == 404


def test_non_agent_gets_an_empty_tree(db_session):
    u = _mk_user(db_session, "u@x.io")
    team = agent_team(db_session, u)
    assert team.level is None and team.nodes == [] and team.canManage is False
    assert team.isAgent is False
    assert agent_tree_users(db_session, u).total == 0


# ---------- 写权限 / writes ----------

def test_only_top_level_can_write(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    for call in (
        lambda: agent_tree_set_plan(db_session, b, _plan(c1.email)),
        lambda: agent_set_plan(db_session, b, lb.id, _plan(c1.email)),
        lambda: agent_promote(db_session, b, c1.email),
        lambda: agent_demote(db_session, b, b.email),
    ):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 403
    db_session.refresh(c1)
    assert c1.plan == "FREE"


def test_top_level_extends_anyone_in_the_tree(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    row = agent_tree_set_plan(db_session, a, _plan(c1.email))
    assert row.plan == "PRO" and row.planExpiresAt is not None and row.viaEmail == b.email
    # 也能给下级代理本人加。/ Sub-agents themselves are in scope too.
    row = agent_tree_set_plan(db_session, a, _plan(b.email, 10))
    assert row.plan == "PRO"


def test_tree_plan_change_keeps_the_existing_guards(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    outsider = _mk_user(db_session, "out@x.io")
    with pytest.raises(HTTPException) as exc:
        agent_tree_set_plan(db_session, a, _plan(outsider.email, 5))
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        agent_tree_set_plan(db_session, a, _plan(a.email, 5))
    assert exc.value.status_code == 403
    # 每个客户 30 天累计 90 天的配额照旧。
    for _ in range(3):
        agent_tree_set_plan(db_session, a, _plan(c1.email))
    with pytest.raises(HTTPException) as exc:
        agent_tree_set_plan(db_session, a, _plan(c1.email, 1))
    assert exc.value.status_code == 429


# ---------- 撤销 / revoke ----------

def test_demotion_hands_customers_and_links_up_and_lifts_the_subtree(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    agent_promote(db_session, a, c1.email)  # c1 → 三级，挂在 B 下
    lc = _link_of(db_session, c1)
    d1 = _mk_user(db_session, "d1@x.io", invite_code=lc.code)
    b2 = _mk_user(db_session, "b2@x.io", invite_code=lb.code)  # B 的另一个客户

    team = agent_demote(db_session, a, b.email)

    assert not is_agent(db_session, b.id)
    db_session.refresh(lb)
    assert lb.is_active is False and lb.owner_user_id == a.id
    # c1 上移一级、改挂到 A 下；B 的客户与 B 本人都归 A。
    c_node = db_session.query(AgentNode).filter_by(user_id=c1.id).one()
    assert c_node.parent_user_id == a.id and c_node.depth == 2
    assert [n.email for n in team.nodes] == [a.email, c1.email]
    for u in (b, b2):
        db_session.refresh(u)
        assert u.agent_user_id == a.id
    assert _emails(agent_tree_users(db_session, a)) == {a1.email, b.email, b2.email, c1.email, d1.email}
    fields = {r.field for r in db_session.query(AdminAuditLog).all()}
    assert {"agent_parent", "agent_user", f"link_owner:{lb.code}"} <= fields


def test_demotion_scope(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    other_top = _mk_user(db_session, "z@x.io")
    _appoint(db_session, admin, other_top)
    for email in (a.email, other_top.email, a1.email, "ghost@x.io"):
        with pytest.raises(HTTPException) as exc:
            agent_demote(db_session, a, email)
        assert exc.value.status_code == 404


def test_admin_cannot_strand_a_subtree(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    with pytest.raises(HTTPException) as exc:
        admin_revoke_agent(db_session, admin, a.id)
    assert exc.value.status_code == 409
    assert is_agent(db_session, a.id)


def test_admin_revoking_a_leaf_top_level_agent(db_session):
    admin = _mk_user(db_session, "admin@x.io", role="admin")
    a = _mk_user(db_session, "a@x.io")
    la = _appoint(db_session, admin, a)
    a1 = _mk_user(db_session, "a1@x.io", invite_code=la.code)
    admin_revoke_agent(db_session, admin, a.id)
    assert agent_team(db_session, a).level is None
    # 链接照常可用、变成平台链接；客户变成平台客户。/ Link stays live as a platform link.
    db_session.refresh(la)
    db_session.refresh(a1)
    assert la.owner_user_id is None and la.is_active is True
    assert a1.agent_user_id is None and a1.invite_code == la.code


# ---------- 链接操作不带走客户（R7）/ link operations never move customers ----------

def test_deleting_a_link_keeps_its_customers_in_the_tree(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    delete_invite_link(lb.id, db=db_session, admin=admin)
    assert is_agent(db_session, b.id)
    assert _emails(agent_tree_users(db_session, b)) == {c1.email}
    assert c1.email in _emails(agent_tree_users(db_session, a))


def test_taking_a_link_back_keeps_customers_and_agent(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    unassign_agent(db_session, admin, lb, b.id)
    db_session.refresh(lb)
    assert lb.owner_user_id is None and is_agent(db_session, b.id)
    assert _emails(agent_tree_users(db_session, b)) == {c1.email}
    # 以后经这条链接注册的人不再归 B。/ Future signups through it no longer go to B.
    later = _mk_user(db_session, "later@x.io", invite_code=lb.code)
    assert later.agent_user_id is None


def test_link_transfer_moves_customers_only_when_asked(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    d = _mk_user(db_session, "d@x.io")
    _appoint(db_session, admin, d)
    admin_set_link_owner(db_session, admin, lb, AdminLinkOwnerUpdate(userId=d.id))
    db_session.refresh(c1)
    assert c1.agent_user_id == b.id
    assert lb.code in {l.code for l in agent_links(db_session, d)}
    # 转回 B 后再转给 D，这次勾了迁移：来源是 lb、仍归旧主人 B 的 c1、c2 一起过去；
    # 来源是 lb 但已归别人的不在这批里（这里用 a1 改挂到 lb 来源上验证）。
    # Back to B, then to D with moveCustomers: c1 and c2 (from lb, still owned by
    # B) follow; someone from lb owned by another agent stays.
    admin_set_link_owner(db_session, admin, lb, AdminLinkOwnerUpdate(userId=b.id))
    c2 = _mk_user(db_session, "c2@x.io", invite_code=lb.code)  # 归 B
    stay = _mk_user(db_session, "stay@x.io", invite_code=lb.code, agent_user_id=a.id)
    admin_set_link_owner(db_session, admin, lb, AdminLinkOwnerUpdate(userId=d.id, moveCustomers=True))
    db_session.refresh(stay)
    assert stay.agent_user_id == a.id
    for u in (c1, c2):
        db_session.refresh(u)
        assert u.agent_user_id == d.id
    rows = db_session.query(AdminAuditLog).filter_by(field="agent_user").all()
    assert {r.target_user_id for r in rows} == {c1.id, c2.id}


def test_link_owner_guards(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    for body, code in (
        (AdminLinkOwnerUpdate(userId=a1.id), 404),  # 不是代理 / not an agent
        (AdminLinkOwnerUpdate(userId=b.id), 409),  # 没变 / unchanged
    ):
        with pytest.raises(HTTPException) as exc:
            admin_set_link_owner(db_session, admin, lb, body)
        assert exc.value.status_code == code


# ---------- 管理员改归属 / admin re-owns a customer ----------

def test_admin_reowns_customers_but_not_agents(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    check_customer_agent(db_session, [a1], b.id)
    _apply_user_fields(db_session, admin, a1, {"agentUserId": b.id})
    db_session.commit()
    assert a1.email in _emails(agent_tree_users(db_session, b))
    db_session.refresh(a1)
    assert a1.invite_code == la.code  # 来源不动
    for targets, agent_id, code in (([b], a.id, 409), ([a1], c1.id, 404)):
        with pytest.raises(HTTPException) as exc:
            check_customer_agent(db_session, targets, agent_id)
        assert exc.value.status_code == code


# ---------- 管理后台的树与改挂 / admin tree and moves ----------

def test_admin_tree_lists_every_agent_with_counts(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    tree = admin_agent_tree(db_session)
    by_id = {n.userId: n for n in tree.nodes}
    assert [n.userId for n in tree.nodes] == [a.id, b.id]
    assert by_id[b.id].parentUserId == a.id and by_id[b.id].level == 2
    assert by_id[a.id].teamCustomers == 2 and by_id[b.id].directCustomers == 1
    assert [l.code for l in by_id[b.id].links] == [lb.code]


def _move(db, admin, user, parent):
    return admin_move_agent(db, admin, AdminAgentMove(userId=user.id, parentUserId=parent.id if parent else None))


def test_admin_moves_an_agent_with_their_customers_to_another_tree(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    d = _mk_user(db_session, "d@x.io")
    _appoint(db_session, admin, d)
    tree = _move(db_session, admin, b, d)
    by_id = {n.userId: n for n in tree.nodes}
    assert by_id[b.id].parentUserId == d.id and by_id[b.id].level == 2
    # D 看得到 B 和 B 的客户 c1；A 再也看不到。/ D now sees B and c1; A sees neither.
    assert [n.email for n in agent_team(db_session, d).nodes] == [d.email, b.email]
    assert _emails(agent_tree_users(db_session, d)) == {b.email, c1.email}
    assert [n.email for n in agent_team(db_session, a).nodes] == [a.email]
    assert _emails(agent_tree_users(db_session, a)) == {a1.email}
    # 只改树：B 的来源、链接与 c1 的归属都没动。/ Only the tree changed.
    db_session.refresh(b)
    db_session.refresh(c1)
    assert b.invite_code == la.code and c1.agent_user_id == b.id and _link_of(db_session, b).id == lb.id
    fields = {r.field for r in db_session.query(AdminAuditLog).filter_by(target_user_id=b.id).all()}
    assert "agent_parent" in fields and "invite_code" not in fields


def test_moving_shifts_the_whole_subtree(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    agent_promote(db_session, a, c1.email)  # c1 成为三级 / c1 becomes L3
    tree = _move(db_session, admin, b, None)
    by_id = {n.userId: n for n in tree.nodes}
    assert by_id[b.id].level == 1 and by_id[b.id].parentUserId is None
    assert by_id[c1.id].level == 2 and by_id[c1.id].parentUserId == b.id
    # 改成一级：B 能写了，A 再也碰不到他。/ Now top level: B may write; A can't reach B.
    assert agent_team(db_session, b).canManage is True
    with pytest.raises(HTTPException) as exc:
        agent_tree_set_plan(db_session, a, _plan(b.email))
    assert exc.value.status_code == 404


def test_move_guards(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    agent_promote(db_session, a, c1.email)
    d = _mk_user(db_session, "d@x.io")
    ld = _appoint(db_session, admin, d)
    cases = [
        (a, b, 409),  # 挂到自己的下级下面 / under their own sub-agent
        (a, c1, 409),  # 更深的下级也不行 / any descendant
        (b, b, 409),  # 挂到自己下面 / under themselves
        (b, a, 409),  # 上级没变 / unchanged
        (b, a1, 404),  # 新上级不是代理 / not an agent
        (a1, d, 404),  # 要挪的人不是代理 / not an agent
    ]
    for user, parent, code in cases:
        with pytest.raises(HTTPException) as exc:
            _move(db_session, admin, user, parent)
        assert exc.value.status_code == code, (user.email, parent.email)
    # 最大层级 3：B（下面还有一级）挂到二级 B2 下面会变成 3 + 1 = 4 层。
    # Max depth 3: B (one level below them) under an L2 node would reach level 4.
    b2 = _mk_user(db_session, "b2@x.io", invite_code=ld.code)
    agent_promote(db_session, d, b2.email)
    save_agent_settings(db_session, {"agent_max_depth": 3})
    db_session.commit()
    invalidate_agent_cache()
    with pytest.raises(HTTPException) as exc:
        _move(db_session, admin, b, b2)
    assert exc.value.status_code == 409
    assert db_session.query(AgentNode).filter_by(user_id=b.id).one().parent_user_id == a.id
    # 挂到一级 D 下面正好 3 级，放行。/ Under top-level D it is exactly 3: allowed.
    by_id = {n.userId: n for n in _move(db_session, admin, b, d).nodes}
    assert by_id[c1.id].level == 3
