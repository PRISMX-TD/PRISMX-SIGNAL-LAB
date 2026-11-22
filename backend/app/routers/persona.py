"""交易报告 + 交易人格的用户端接口（2026-11-22）。

- GET  /persona/me            自己的状态（demo / locked / unlocked）+ 可看月份 + 当月报告
- GET  /persona/me/report     某个月的报告（?period=YYYY-MM）
- POST /persona/client        推荐官看**直属**客户的报告（管理员给了 can_view_reports 才行；按邮箱定位，
                              与推荐官名单一样不暴露用户 id）

总开关 persona_visible 关着时只有管理员能用（管理员不受开关限制）。

Trading report + persona, user-facing. The persona_visible switch gates everyone but admins.
Ambassadors with the admin-granted can_view_reports may read their *direct* customers' reports,
addressed by e-mail like the ambassador customer list (user ids stay withheld).
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.rate_limit import limiter
from app.models import User
from app.services import shared_cache
from app.services.agent_tree import node_of
from app.services.deps import get_current_user, get_db
from app.services.persona import service
from app.services.settings_store import get_gamification_settings

router = APIRouter(prefix="/persona", tags=["persona"])

# 当月报告是现算的（读 90 天的单），同一个人 60 秒内重复打开直接给缓存。
# The live month is computed from 90 days of orders; repeat views within 60 s hit the cache.
_CACHE_SECONDS = 60

_MSG_OFF = "功能内测中，暂未开放 / Feature in beta, not yet available"
_MSG_BAD_PERIOD = "月份格式应为 YYYY-MM / Period must be YYYY-MM"


def _check_visible(db: Session, user: User) -> None:
    if user.role == "admin":
        return
    if not get_gamification_settings(db).get("persona_visible"):
        raise HTTPException(403, _MSG_OFF)


def require_persona_visible(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> User:
    _check_visible(db, user)
    return user


def _overview(db: Session, user_id: str) -> dict:
    def compute():
        st = service.status(db, user_id)
        if st["status"] != "unlocked":
            return st
        now = service.utcnow()
        return {**st, "months": service.months(db, user_id, now),
                "report": service.report_for(db, user_id, service.period_of(now), now)}
    return shared_cache.cached_json(f"persona:me:{user_id}", _CACHE_SECONDS, compute)


def _report(db: Session, user_id: str, period: str) -> dict:
    if not service.valid_period(period):
        raise HTTPException(400, _MSG_BAD_PERIOD)
    st = service.status(db, user_id)
    if st["status"] != "unlocked":
        raise HTTPException(404, "报告还没解锁 / Report not unlocked yet")

    def compute():
        return service.report_for(db, user_id, period)
    rep = shared_cache.cached_json(f"persona:rep:{user_id}:{period}", _CACHE_SECONDS, compute)
    if rep is None:
        raise HTTPException(404, "这个月没有报告 / No report for this month")
    return rep


@router.get("/me")
@limiter.limit("30/minute")
def persona_me(request: Request, db: Session = Depends(get_db), user: User = Depends(require_persona_visible)):
    return _overview(db, user.id)


@router.get("/me/report")
@limiter.limit("30/minute")
def persona_me_report(request: Request, period: str, db: Session = Depends(get_db),
                      user: User = Depends(require_persona_visible)):
    return _report(db, user.id, period)


class ClientReportIn(BaseModel):
    email: EmailStr
    period: str | None = None


@router.post("/client")
@limiter.limit("30/minute")
def persona_client(request: Request, body: ClientReportIn, db: Session = Depends(get_db),
                   user: User = Depends(require_persona_visible)):
    """推荐官看直属客户的报告。不是直属客户、或没被授权，一律 404，不说明是哪种。
    An ambassador reads a direct customer's report; anything else is a plain 404."""
    node = node_of(db, user.id)
    if node is None or not node.can_view_reports:
        raise HTTPException(403, "没有查看客户报告的权限 / Not allowed to view customer reports")
    target = (db.query(User)
                .filter(func.lower(User.email) == str(body.email).strip().lower(),
                        User.agent_user_id == user.id)
                .first())
    if target is None:
        raise HTTPException(404, "不是你的直属客户 / Not one of your direct customers")
    client = {"email": target.email, "nickname": target.nickname}
    if body.period:
        return {"client": client, "report": _report(db, target.id, body.period)}
    return {"client": client, **_overview(db, target.id)}
