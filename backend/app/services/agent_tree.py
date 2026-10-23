"""代理层级树（rev 47）的数据操作：找节点、取子树、查一棵树持有的链接、撤销节点。

规则（2026-10-24 产品决定，详见 AgentNode 模型注释）：
- 一级代理由管理员任命（指派链接时自动建一级节点）；一级代理可以在自己整棵树里把普通
  用户升为代理，新节点的上级是那人注册所用链接的主人；
- 上级看得到整棵子树，下级看不到上级与同级；
- 只有一级代理能写（改会员、升 / 撤代理），二级及以下只读；
- 层级不超过平台设置 agent_max_depth（默认 5）。

这里只放「树本身怎么走、怎么改」，谁有权限、返回什么形状在 routers/invite.py——与
services/agents.py 同一个分法：services 不反向依赖 router。

Agent-tree (rev 47) data operations: node lookup, subtrees, the links a tree
holds, node removal. Who may do what and the response shapes live in
routers/invite.py, keeping services free of router imports.
"""
from sqlalchemy.orm import Session

from app.models import AgentNode, InviteLink, InviteLinkAgent


def node_of(db: Session, user_id: str) -> AgentNode | None:
    return db.query(AgentNode).filter(AgentNode.user_id == user_id).first()


def ensure_top_node(db: Session, user_id: str, created_by: str | None) -> AgentNode:
    """管理员指派链接时调用：还不是树上的人就给他建一个一级节点；已经是（任何一级）就原样
    返回——给一个二级代理多指派一条链接不会把他提成一级。
    Called on admin assignment: create a top-level node if the user has none;
    an existing node (any level) is returned untouched."""
    node = node_of(db, user_id)
    if node is None:
        node = AgentNode(user_id=user_id, parent_user_id=None, depth=1, created_by=created_by)
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


def links_by_code(db: Session, owner_ids: list[str]) -> dict[str, tuple[str, InviteLink]]:
    """这批代理持有的未删除链接：{code: (主人 user_id, 链接)}。停用的也算——停用后
    名单仍是他的，撤销代理转给上级的链接也是停用状态。
    Non-deleted links held by these agents, {code: (owner id, link)}. Disabled
    ones count: a disabled link's people are still theirs."""
    if not owner_ids:
        return {}
    rows = (
        db.query(InviteLinkAgent.user_id, InviteLink)
        .join(InviteLink, InviteLink.id == InviteLinkAgent.link_id)
        .filter(InviteLinkAgent.user_id.in_(owner_ids), InviteLink.deleted_at.is_(None))
        .all()
    )
    return {link.code: (uid, link) for uid, link in rows}


def owner_of_code(db: Session, code: str | None) -> str | None:
    """持有这个码的代理（链接未删除）；没有返回 None。/ The agent holding this code, if any."""
    if not code:
        return None
    row = (
        db.query(InviteLinkAgent.user_id)
        .join(InviteLink, InviteLink.id == InviteLinkAgent.link_id)
        .filter(InviteLink.code == code, InviteLink.deleted_at.is_(None))
        .first()
    )
    return row[0] if row else None


def remove_node(db: Session, node: AgentNode) -> list[InviteLink]:
    """撤销一个代理，返回他被转走（或摘掉）的链接。不提交。

    - 有上级：他的链接全部停用并转给上级——经这些链接注册的人 invite_code 不变，于是
      还挂在上级的树上；
    - 没有上级（一级）：链接上的代理行直接删掉，与管理员取消指派原来的行为一致。调用方
      负责先拦住「一级代理下面还有人」的情况（产品决定：不让撤，先处理下级）；
    - 下级整体上移一级：直属下级改挂到他的上级下面，整棵子树 depth 各减 1。

    Remove an agent and return the links that left them. With a parent, the
    links are disabled and handed to the parent, so their signups stay in the
    parent's tree; at top level the agent rows are simply deleted (callers block
    removing a top-level agent who still has children). The subtree moves up a
    level. Does not commit.
    """
    parent_id = node.parent_user_id
    rows = db.query(InviteLinkAgent).filter(InviteLinkAgent.user_id == node.user_id).all()
    links: list[InviteLink] = []
    for row in rows:
        link = db.get(InviteLink, row.link_id)
        if link is not None:
            links.append(link)
        if parent_id is not None:
            row.user_id = parent_id
            if link is not None:
                link.is_active = False
        else:
            db.delete(row)
    for d in descendants(db, node.user_id):
        d.depth = max(1, (d.depth or 1) - 1)
        if d.parent_user_id == node.user_id:
            d.parent_user_id = parent_id
    db.delete(node)
    db.flush()
    return links
