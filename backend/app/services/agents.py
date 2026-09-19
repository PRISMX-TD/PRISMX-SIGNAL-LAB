"""「代理」身份的判定 / the agent-ness predicate.

代理不是角色（users.role 只有 user/admin），而是 invite_link_agents 里有没有这个
人的行——见 InviteLinkAgent 模型与 routers/invite.py 顶部的说明。

单独放一个模块，是因为它有两个消费方：routers/invite.py（代理页自己）和
routers/account.py（/auth/me 下发 isAgent 让前端露出入口）。判定原先定义在
invite.py 里，account.py 便 `from app.routers.invite import is_agent`——router 反向
依赖 router，与 services/pagination.py 顶部写的是同一个问题。

Agent-ness is not a role but the presence of a row in invite_link_agents. It has
two consumers — the agent router itself and /auth/me — and used to force
account.py to import from another router; see services/pagination.py's note.
"""
from sqlalchemy.orm import Session

from app.models import InviteLinkAgent


def is_agent(db: Session, user_id: str) -> bool:
    """该用户是否至少持有一条被指派的链接。/auth/me 靠它下发 isAgent 给前端露入口。
    Whether the user holds at least one assigned link; /auth/me ships it as isAgent."""
    return (
        db.query(InviteLinkAgent.id).filter(InviteLinkAgent.user_id == user_id).first()
        is not None
    )
