"""注册归因：从浏览器上报的最近几个 ref 里挑出「来源」与「归属代理」（rev 50，设计 2026-10-27 §5）。

来源与归属是两件事，各挑各的：
- 来源（users.invite_code）= 最新的一条仍有效的链接，什么类型都算——广告报表按它统计；
- 归属（users.agent_user_id）= 最新的一条仍有效、且有主人的链接的主人——代理按它管客户。

以前只挑一个码（「30 天内代理优先」），同时带了广告链接与代理链接的人，广告就少算一个。
pick_ref 仍保留那个旧口径，只给公开比赛页的「开户」跳转用：那里要的是「这位访客该去哪个
开户地址」，代理链接优先正是想要的行为，漏斗也一直按它记。

放在 services 里，是因为 routers/invite.py（注册）与 services/open_account.py（开户跳转）都要用，
service 不能反过来依赖 router（同 services/agents.py 的说明）。「30 天」只靠前端的 ref TTL 保证，
后端不知道 ref 是什么时候存的。

Signup attribution from the browser's recent refs (newest first). The source
(users.invite_code) is the newest still-usable link of any kind — ad reports
count it; the owner (users.agent_user_id) is the owner of the newest usable
link that has one. They used to be one agent-first pick, so a visitor carrying
both an ad link and an agent link was lost to the ad. pick_ref keeps the old
agent-first rule for the public open-account redirect only. The 30-day window
is enforced by the client's ref TTL alone.
"""
from sqlalchemy.orm import Session

from app.models import InviteLink

# 一次最多看几个 ref，与前端保存的上限一致。/ How many refs we look at; matches the client cap.
MAX_REFS = 5


def normalize_code(code: str) -> str:
    """查库前去空白转小写——码的字符集全小写，所以无损（详见 routers/invite.py 的说明）。
    Trim and lowercase before lookup; lossless since codes are lowercase-only."""
    return code.strip().lower()


def _codes(refs: list[str] | None) -> list[str]:
    out: list[str] = []
    for raw in (refs or [])[:MAX_REFS]:
        code = normalize_code(raw or "")
        if code and code not in out:
            out.append(code)
    return out


def _usable(db: Session, codes: list[str]) -> dict[str, InviteLink]:
    """这些码里仍活跃、未删除的链接（与 routers/invite._active_link 同口径，批量查一次）。
    The still-active, non-deleted links among these codes, in one query."""
    if not codes:
        return {}
    rows = (
        db.query(InviteLink)
        .filter(
            InviteLink.code.in_(codes),
            InviteLink.is_active.is_(True),
            InviteLink.deleted_at.is_(None),
        )
        .all()
    )
    return {l.code: l for l in rows}


def pick_signup(db: Session, refs: list[str] | None) -> tuple[str | None, str | None]:
    """(来源码, 归属代理 user id)。都可能为空。选中谁不回传给客户端——注册接口不能变成
    探测「码是否存活 / 是不是代理链接」的口子（同 /invite/click 一律 204）。
    (source code, owning agent id), either may be None. Never echoed to the client."""
    codes = _codes(refs)
    usable = _usable(db, codes)
    source = next((c for c in codes if c in usable), None)
    owner = next((usable[c].owner_user_id for c in codes if c in usable and usable[c].owner_user_id), None)
    return source, owner


def pick_ref(db: Session, refs: list[str] | None) -> str | None:
    """旧口径：有主人的链接里取最新的，没有就取最新的可用链接。只给开户跳转用（见模块说明）。
    The legacy agent-first pick, used only by the open-account redirect."""
    codes = _codes(refs)
    usable = _usable(db, codes)
    for code in codes:
        if code in usable and usable[code].owner_user_id:
            return code
    return next((c for c in codes if c in usable), None)
