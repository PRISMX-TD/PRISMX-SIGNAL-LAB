"""代理层级树的数据操作：找节点、取子树、范围内的客户、链接、改挂、撤销。

规则（rev 50，设计 docs/superpowers/specs/2026-10-27-agent-invite-redesign.md §3）：
- 谁是代理、上级是谁，只看 agent_nodes；
- 客户归谁只看 users.agent_user_id；来源 users.invite_code 只给广告统计用；
- 代理本人在树上的位置只看他自己的节点，他的 agent_user_id / invite_code 不参与范围判断；
- 一个代理的范围 = 归属在他与全部下级名下的普通客户 + 全部下级代理本人；
- 链接主人（invite_links.owner_user_id）只决定以后经它注册的人归谁。

这里只放「树本身怎么走、怎么改」，谁有权限、返回什么形状在 routers/invite.py——services
不反向依赖 router。

Agent-tree data operations. Since rev 50: the tree (agent_nodes) alone says who
is an agent and who their parent is; users.agent_user_id alone says which agent
owns a customer; invite_code is the ad source only. An agent's scope is the
customers owned by them or any descendant plus the descendant agents. Who may
do what lives in routers/invite.py.
"""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import and_, exists, or_
from sqlalchemy.orm import Session

from app.models import AgentNode, InviteLink, User
from app.services.audit import log_change


def node_of(db: Session, user_id: str) -> AgentNode | None:
    return db.query(AgentNode).filter(AgentNode.user_id == user_id).first()


def add_node(db: Session, user_id: str, parent: AgentNode | None, created_by: str | None) -> AgentNode:
    """建一个节点挂在 parent 下（None = 一级）。层级上限由调用方先查。不提交。
    Create a node under parent (None = top level); callers check the depth cap."""
    node = AgentNode(
        user_id=user_id,
        parent_user_id=parent.user_id if parent is not None else None,
        depth=(parent.depth or 1) + 1 if parent is not None else 1,
        created_by=created_by,
    )
    db.add(node)
    db.flush()
    return node


def descendants(db: Session, root_user_id: str) -> list[AgentNode]:
    """root 以下的全部节点（不含 root），按层广度优先。

    每层一条 IN 查询：层数被 agent_max_depth 封顶（默认 5），代理总数是几百的量级，
    比写一条跨库的递归 CTE 简单，也一样快。seen 集合防的是脏数据里的环——正常写入
    路径造不出环，但这张表也可能被人工 SQL 改过，不能因此死循环。

    Every node below root (root excluded), breadth-first, one IN query per
    level — depth is capped by agent_max_depth and agents number in the
    hundreds. The seen set guards against a cycle introduced by hand-written SQL.
    """
    out: list[AgentNode] = []
    seen = {root_user_id}
    frontier = [root_user_id]
    while frontier:
        kids = [
            k
            for k in db.query(AgentNode).filter(AgentNode.parent_user_id.in_(frontier)).all()
            if k.user_id not in seen
        ]
        kids.sort(key=lambda k: (k.created_at is None, k.created_at))
        seen.update(k.user_id for k in kids)
        out.extend(kids)
        frontier = [k.user_id for k in kids]
    return out


def is_customer():
    """「普通客户」= 不是代理的人。/ A customer is anyone without a node."""
    return ~exists().where(AgentNode.user_id == User.id)


def scope_filter(owner_ids: list[str], agent_ids: list[str]):
    """范围内的人：归属在 owner_ids 名下的普通客户，或 agent_ids 里的代理本人。
    In scope: customers owned by owner_ids, or the agents in agent_ids."""
    clauses = [and_(User.agent_user_id.in_(owner_ids), is_customer())] if owner_ids else []
    if agent_ids:
        clauses.append(User.id.in_(agent_ids))
    return or_(*clauses) if clauses else User.id.is_(None)


def links_by_code(db: Session, owner_ids: list[str]) -> dict[str, tuple[str, InviteLink]]:
    """这批代理持有的未删除链接：{code: (主人 user_id, 链接)}。停用的也算。
    Non-deleted links held by these agents, {code: (owner id, link)}; disabled count."""
    if not owner_ids:
        return {}
    rows = (
        db.query(InviteLink)
        .filter(InviteLink.owner_user_id.in_(owner_ids), InviteLink.deleted_at.is_(None))
        .all()
    )
    return {link.code: (link.owner_user_id, link) for link in rows}


def subtree_height(db: Session, node: AgentNode) -> int:
    """这个节点下面最深还有几层（自己算 0）。/ Levels below this node (0 = no sub-agents)."""
    base = node.depth or 1
    return max(((d.depth or 1) - base for d in descendants(db, node.user_id)), default=0)


def move_node(db: Session, node: AgentNode, parent: AgentNode | None) -> None:
    """把一个代理连同他整棵子树改挂到 parent 下面（None = 改成一级）。不提交。

    只改树：他的 parent 与 depth，子树每个节点的 depth 跟着平移同样的差值。客户的归属
    （agent_user_id）一概不动——他的客户本来就归他，于是跟着他一起过去；他自己的来源与
    归属也不动（R5：代理在树上的位置只看节点）。环与最大层级由调用方先检查。

    Re-parent an agent together with their whole subtree (None = top level).
    Only the tree changes; customers stay owned by the same agents and so come
    along. Callers check for cycles and the depth cap first. Does not commit.
    """
    new_depth = (parent.depth or 1) + 1 if parent is not None else 1
    delta = new_depth - (node.depth or 1)
    for d in descendants(db, node.user_id):
        d.depth = (d.depth or 1) + delta
    node.parent_user_id = parent.user_id if parent is not None else None
    node.depth = new_depth
    db.flush()


def set_link_owner(db: Session, link: InviteLink, owner_id: str | None, actor_id: str | None) -> None:
    """换链接主人（None = 平台链接）。只改链接本身；要不要连同客户迁移由调用方决定。不提交。
    Set a link's owner (None = platform); moving customers is the caller's call."""
    link.owner_user_id = owner_id
    link.owner_assigned_by = actor_id if owner_id else None
    link.owner_assigned_at = datetime.now(timezone.utc) if owner_id else None


def remove_node(db: Session, node: AgentNode) -> tuple[list[InviteLink], list[str]]:
    """撤销一个代理，返回 (他被转走的链接, 被转走的客户 id)。不提交。

    - 他名下的客户：转给他的上级；他是一级就变成平台客户（agent_user_id 置空）；
    - 他的链接：有上级 → 停用并转给上级（防止他继续拿着旧链接拉人，而拉来的人归上级）；
      一级 → 只摘掉主人，链接照常可用，变成平台链接；
    - 他本人从此是普通客户，归他原来的上级（一级则没有归属）；
    - 下级整体上移一级：直属下级改挂到他的上级下面，整棵子树 depth 各减 1。
    调用方负责先拦住「一级代理下面还有人」（产品决定：不让撤，先改挂或撤下级）。

    Remove an agent; returns (links handed over, customer ids moved). Customers
    and links go to the parent — at top level customers become platform
    customers and links simply lose their owner, staying active; with a parent
    the links are disabled. The agent becomes an ordinary customer of their old
    parent and the subtree moves up a level. Callers block removing a top-level
    agent who still has children. Does not commit.
    """
    parent_id = node.parent_user_id
    customers = [
        uid for (uid,) in db.query(User.id).filter(User.agent_user_id == node.user_id, is_customer()).all()
    ]
    if customers:
        db.query(User).filter(User.id.in_(customers)).update(
            {User.agent_user_id: parent_id}, synchronize_session=False
        )
    links = db.query(InviteLink).filter(InviteLink.owner_user_id == node.user_id).all()
    for link in links:
        set_link_owner(db, link, parent_id, None)
        if parent_id is not None:
            link.is_active = False
    me = db.get(User, node.user_id)
    if me is not None:
        me.agent_user_id = parent_id
    for d in descendants(db, node.user_id):
        d.depth = max(1, (d.depth or 1) - 1)
        if d.parent_user_id == node.user_id:
            d.parent_user_id = parent_id
    db.delete(node)
    db.flush()
    return links, customers


def check_customer_agent(db: Session, targets: list[User], agent_id: str | None) -> None:
    """管理员改归属前的校验（批量时整批先查，不留半截）：目标里不能有代理本人——代理的位置只看
    节点，请用改挂上级；新归属必须是代理（null = 平台客户）。
    Validate before re-owning customers (the whole batch first): no target may
    be an agent (re-parent them instead), and the new owner must be an agent."""
    ids = [t.id for t in targets]
    if ids and db.query(AgentNode.id).filter(AgentNode.user_id.in_(ids)).first() is not None:
        raise HTTPException(
            status_code=409,
            detail="选中的人里有代理，代理请在代理层级里改挂上级 / Agents are moved in the agent tree, not here",
        )
    if agent_id is not None and node_of(db, agent_id) is None:
        raise HTTPException(status_code=404, detail="该用户不是代理 / This user is not an agent")


def set_customer_agent(db: Session, actor_id: str, target: User, agent_id: str | None) -> None:
    """改一个客户的归属代理（null = 平台客户），写审计 agent_user。不改来源。调用方先 check、负责提交。
    Re-own one customer (null = platform), audited as agent_user; source untouched."""
    if target.agent_user_id == agent_id:
        return
    emails = dict(
        db.query(User.id, User.email).filter(User.id.in_([i for i in (target.agent_user_id, agent_id) if i])).all()
    )
    log_change(db, actor_id, target.id, "agent_user", emails.get(target.agent_user_id or ""), emails.get(agent_id or ""))
    target.agent_user_id = agent_id
