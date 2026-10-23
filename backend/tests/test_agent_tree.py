"""代理层级（rev 47）：升 / 撤代理、可见范围、只有一级能写、最大层级、管理员侧的保护。

照 test_invite_agents.py 的惯例走 service 级测试，用 conftest 的 db_session 内存库。
树的形状（大多数用例共用）：

    admin ──指派──▶ A（一级，链接 la）
                     ├─ a1（A 的直属客户）
                     └─ B（用 la 注册，被 A 升为二级，链接自动生成）
                          └─ c1（B 的直属客户）
"""
import pytest
from fastapi import HTTPException

from app.models import AgentNode, InviteLink, InviteLinkAgent, User, UserNotification
from app.routers.invite import (
    admin_agent_tree,
    agent_demote,
    agent_promote,
    agent_set_plan,
    agent_team,
    agent_tree_set_plan,
    agent_tree_users,
    assign_agent,
    delete_invite_link,
    is_agent,
    unassign_agent,
)
from app.schemas import AgentPlanUpdate
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


def _mk_link(db, code, grants_trial=False):
    link = InviteLink(code=code, label=code, is_active=True, grants_trial=grants_trial)
    db.add(link)
    db.commit()
    return link


def _link_of(db, user):
    return (
        db.query(InviteLink)
        .join(InviteLinkAgent, InviteLinkAgent.link_id == InviteLink.id)
        .filter(InviteLinkAgent.user_id == user.id)
        .first()
    )


def _tree(db, grants_trial=False):
    admin = _mk_user(db, "admin@x.io", role="admin")
    a = _mk_user(db, "a@x.io")
    la = _mk_link(db, "aaaa2345", grants_trial=grants_trial)
    assign_agent(db, admin, la, a)
    a1 = _mk_user(db, "a1@x.io", invite_code=la.code)
    b = _mk_user(db, "b@x.io", invite_code=la.code, nickname="小B")
    agent_promote(db, a, b.email)
    lb = _link_of(db, b)
    c1 = _mk_user(db, "c1@x.io", invite_code=lb.code)
    return admin, a, la, a1, b, lb, c1


def _emails(page):
    return {u.email for u in page.users}


def test_admin_assignment_makes_a_top_level_node(db_session):
    admin = _mk_user(db_session, "admin@x.io", role="admin")
    a = _mk_user(db_session, "a@x.io")
    la = _mk_link(db_session, "aaaa2345")
    assign_agent(db_session, admin, la, a)
    node = db_session.query(AgentNode).filter_by(user_id=a.id).one()
    assert node.parent_user_id is None and node.depth == 1
    team = agent_team(db_session, a)
    assert team.level == 1 and team.canManage is True and team.maxDepth == 5


def test_a_link_takes_only_one_agent(db_session):
    admin = _mk_user(db_session, "admin@x.io", role="admin")
    a = _mk_user(db_session, "a@x.io")
    other = _mk_user(db_session, "o@x.io")
    la = _mk_link(db_session, "aaaa2345")
    assign_agent(db_session, admin, la, a)
    with pytest.raises(HTTPException) as exc:
        assign_agent(db_session, admin, la, other)
    assert exc.value.status_code == 409


def test_promotion_builds_a_child_with_its_own_link(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session, grants_trial=True)
    node = db_session.query(AgentNode).filter_by(user_id=b.id).one()
    assert node.parent_user_id == a.id and node.depth == 2 and node.created_by == a.id
    assert is_agent(db_session, b.id)
    # 新链接：标记名 = 昵称，送试用跟着他注册的那条链接走，开户网址留空。
    assert lb.label == "小B" and lb.grants_trial is True and lb.open_account_url is None
    assert lb.code != la.code
    kinds = {(n.user_id, n.kind) for n in db_session.query(UserNotification).all()}
    assert (b.id, "agent_promoted") in kinds
    assert (admin.id, "agent_tree_change") in kinds


def test_parent_is_the_signup_link_owner_not_the_promoter(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    # c1 是 B 的客户，由 A 来升：上级是 B，三级。
    row = agent_promote(db_session, a, c1.email)
    assert row.agentLevel == 3 and row.viaEmail == b.email
    node = db_session.query(AgentNode).filter_by(user_id=c1.id).one()
    assert node.parent_user_id == b.id


def test_upper_sees_the_whole_subtree_lower_sees_only_its_own(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)

    a_team = agent_team(db_session, a)
    assert [n.email for n in a_team.nodes] == [a.email, b.email]
    assert a_team.nodes[0].parentEmail is None and a_team.nodes[0].isSelf
    assert a_team.nodes[1].parentEmail == a.email
    # A 直属：a1 + b；整棵树再加上 c1。
    assert a_team.nodes[0].directCustomers == 2 and a_team.nodes[0].teamCustomers == 3
    assert a_team.nodes[1].directCustomers == 1 and a_team.nodes[1].teamCustomers == 1
    assert _emails(agent_tree_users(db_session, a)) == {a1.email, b.email, c1.email}

    b_team = agent_team(db_session, b)
    assert b_team.level == 2 and b_team.canManage is False
    # 下级看不到上级：自己那一行没有 parentEmail，树里也没有 A。
    assert [n.email for n in b_team.nodes] == [b.email]
    assert b_team.nodes[0].parentEmail is None
    assert _emails(agent_tree_users(db_session, b)) == {c1.email}


def test_customer_rows_say_which_agent_they_came_through(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    rows = {u.email: u for u in agent_tree_users(db_session, a).users}
    assert rows[c1.email].viaEmail == b.email and rows[c1.email].viaNickname == "小B"
    assert rows[a1.email].viaEmail == a.email
    assert rows[b.email].agentLevel == 2 and rows[a1.email].agentLevel is None


def test_filter_by_agent_stays_inside_the_scope(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    assert _emails(agent_tree_users(db_session, a, under=b.email)) == {c1.email}
    assert _emails(agent_tree_users(db_session, a, under="A@X.IO")) == {a1.email, b.email}
    # 往上、往外都是同一个 404。
    for who, under in ((b, a.email), (a, "nobody@x.io")):
        with pytest.raises(HTTPException) as exc:
            agent_tree_users(db_session, who, under=under)
        assert exc.value.status_code == 404


def test_non_agent_gets_an_empty_tree(db_session):
    u = _mk_user(db_session, "u@x.io")
    team = agent_team(db_session, u)
    assert team.level is None and team.nodes == [] and team.canManage is False
    assert agent_tree_users(db_session, u).total == 0


def test_only_top_level_can_write(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    extend = AgentPlanUpdate(email=c1.email, action="extend", days=30)
    for call in (
        lambda: agent_tree_set_plan(db_session, b, extend),
        lambda: agent_set_plan(db_session, b, lb.id, extend),
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
    row = agent_tree_set_plan(db_session, a, AgentPlanUpdate(email=c1.email, action="extend", days=30))
    assert row.plan == "PRO" and row.planExpiresAt is not None and row.viaEmail == b.email
    # 也能给下级代理本人加（B 是 A 的直属客户）。
    row = agent_tree_set_plan(db_session, a, AgentPlanUpdate(email=b.email, action="extend", days=10))
    assert row.plan == "PRO"


def test_tree_plan_change_keeps_the_existing_guards(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    outsider = _mk_user(db_session, "out@x.io")
    with pytest.raises(HTTPException) as exc:
        agent_tree_set_plan(db_session, a, AgentPlanUpdate(email=outsider.email, action="extend", days=5))
    assert exc.value.status_code == 404
    # 每个客户 30 天累计 90 天的配额照旧。
    for _ in range(3):
        agent_tree_set_plan(db_session, a, AgentPlanUpdate(email=c1.email, action="extend", days=30))
    with pytest.raises(HTTPException) as exc:
        agent_tree_set_plan(db_session, a, AgentPlanUpdate(email=c1.email, action="extend", days=1))
    assert exc.value.status_code == 429


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


def test_demotion_hands_links_up_and_lifts_the_subtree(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    agent_promote(db_session, a, c1.email)  # c1 → 三级，挂在 B 下
    lc = _link_of(db_session, c1)
    d1 = _mk_user(db_session, "d1@x.io", invite_code=lc.code)

    team = agent_demote(db_session, a, b.email)

    assert not is_agent(db_session, b.id)
    assert db_session.query(AgentNode).filter_by(user_id=b.id).first() is None
    db_session.refresh(lb)
    assert lb.is_active is False
    owners = {r.link_id: r.user_id for r in db_session.query(InviteLinkAgent).all()}
    assert owners[lb.id] == a.id
    # c1 上移一级、改挂到 A 下；B 的客户 c1、c1 的客户 d1 都还在 A 的树上。
    c_node = db_session.query(AgentNode).filter_by(user_id=c1.id).one()
    assert c_node.parent_user_id == a.id and c_node.depth == 2
    assert [n.email for n in team.nodes] == [a.email, c1.email]
    assert _emails(agent_tree_users(db_session, a)) == {a1.email, b.email, c1.email, d1.email}


def test_demotion_scope(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    other_top = _mk_user(db_session, "z@x.io")
    lz = _mk_link(db_session, "zzzz2345")
    assign_agent(db_session, admin, lz, other_top)
    for email in (a.email, other_top.email, a1.email, "ghost@x.io"):
        with pytest.raises(HTTPException) as exc:
            agent_demote(db_session, a, email)
        assert exc.value.status_code == 404


def test_admin_cannot_strand_a_subtree(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    with pytest.raises(HTTPException) as exc:
        unassign_agent(db_session, admin, la, a.id)
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        delete_invite_link(la.id, db=db_session, admin=admin)
    assert exc.value.status_code == 409
    assert is_agent(db_session, a.id)


def test_admin_unassigning_a_sub_agent_works_like_demotion(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    unassign_agent(db_session, admin, lb, b.id)
    assert not is_agent(db_session, b.id)
    db_session.refresh(lb)
    assert lb.is_active is False
    assert _emails(agent_tree_users(db_session, a)) == {a1.email, b.email, c1.email}


def test_admin_unassigning_a_leaf_top_level_agent_drops_the_node(db_session):
    admin = _mk_user(db_session, "admin@x.io", role="admin")
    a = _mk_user(db_session, "a@x.io")
    la = _mk_link(db_session, "aaaa2345")
    assign_agent(db_session, admin, la, a)
    unassign_agent(db_session, admin, la, a.id)
    assert db_session.query(AgentNode).filter_by(user_id=a.id).first() is None
    assert agent_team(db_session, a).level is None


def test_admin_tree_lists_every_agent_with_counts(db_session):
    admin, a, la, a1, b, lb, c1 = _tree(db_session)
    tree = admin_agent_tree(db_session)
    by_id = {n.userId: n for n in tree.nodes}
    assert [n.userId for n in tree.nodes] == [a.id, b.id]
    assert by_id[b.id].parentUserId == a.id and by_id[b.id].level == 2
    assert by_id[a.id].teamCustomers == 3 and by_id[b.id].directCustomers == 1
    assert [l.code for l in by_id[b.id].links] == [lb.code]
