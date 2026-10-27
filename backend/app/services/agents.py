"""「代理」身份的判定 / the agent-ness predicate.

代理不是角色（users.role 只有 user / admin / support），而是 agent_nodes 里有没有这个人的
节点（rev 50 起，设计 2026-10-27 R1）——与他持有几条链接无关。rev 47–49 曾按
invite_link_agents 判，于是「有链接没节点」「有节点没链接」两种半状态会让入口与权限对不上。

单独放一个模块，是因为它有几个消费方：routers/invite.py（代理页自己）、routers/account.py
（/auth/me 下发 isAgent 让前端露出入口）、邮件的代理筛选。从 router 互相 import 会把它们
绑死（见 services/pagination.py 顶部）。

Agent-ness is not a role but having a node in agent_nodes (rev 50), however
many links the person holds. Shared by the agent router, /auth/me and the email
filters, so it lives in services rather than in a router.
"""
from sqlalchemy.orm import Session

from app.models import AgentNode


def is_agent(db: Session, user_id: str) -> bool:
    """该用户是否是代理。/auth/me 靠它下发 isAgent 给前端露入口。
    Whether the user is an agent; /auth/me ships it as isAgent."""
    return db.query(AgentNode.id).filter(AgentNode.user_id == user_id).first() is not None
