"""注册来源 → 仍待报名的比赛（设计 §3.3）。

经比赛推广链接注册的人，换了设备或清了本地报名意图，也要能被带回那场比赛：
由 users.invite_code → invite_links.competition_id → 比赛 推出。只在还报得了名时
给：比赛 upcoming/running（草稿不算）、报名制、报名窗口没关、本人还没报名（被取消
资格也算报过）。没有 invite_code 的用户零查询，否则最多三次带索引的点查——够
便宜，可以搭 /auth/me 与登录/注册响应的车。放在 services 而不是 invite 路由里：
auth 与 account 两个路由都要用（理由同 services/agents.py）。

Signup source → the competition still waiting for this user's entry. People who
came through a competition promo link must be led back to it even on another
device or after the local intent was cleared: invite_code → link.competition_id
→ competition, offered only while still enterable (upcoming/running, signup
enrollment, registration not closed, not yet entered — disqualified rows count
as entered). Zero queries without an invite_code, else at most three indexed
point lookups. Lives in services because both auth and account routers use it.
"""
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import Competition, CompetitionParticipant, InviteLink, User


def pending_competition(db: Session, user: User, now: datetime | None = None) -> dict | None:
    if not user.invite_code:
        return None
    row = db.query(InviteLink.competition_id).filter(InviteLink.code == user.invite_code).first()
    if row is None or not row[0]:
        return None
    comp = db.get(Competition, row[0])
    if comp is None or comp.status not in ("upcoming", "running") or comp.enrollment != "signup":
        return None
    closes = comp.reg_closes_at
    if closes is not None:
        # SQLite 读回来是 naive（按 UTC 存）/ SQLite returns naive UTC datetimes
        if closes.tzinfo is None:
            closes = closes.replace(tzinfo=timezone.utc)
        if (now or datetime.now(timezone.utc)) >= closes:
            return None
    entered = (
        db.query(CompetitionParticipant.id)
        .filter(CompetitionParticipant.competition_id == comp.id, CompetitionParticipant.user_id == user.id)
        .first()
    )
    if entered is not None:
        return None
    return {"id": comp.id, "name": comp.name}
