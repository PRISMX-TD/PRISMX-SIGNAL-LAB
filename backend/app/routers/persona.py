"""交易报告 + 交易人格的用户端接口（2026-11-22）。

- GET  /persona/me            自己的状态（demo / locked / unlocked）+ 可看月份 + 当月报告
- GET  /persona/me/report     某个月的报告（?period=YYYY-MM）
- POST /persona/client        推荐官看**直属**客户的报告（管理员给了 can_view_reports 才行；按邮箱定位，
                              与推荐官名单一样不暴露用户 id）

- PUT  /persona/me/goal       设本月目标 + 目标人格（开关 persona_goals）
- PUT  /persona/me/alert      设每日亏损提醒（金额 + 开关）
- GET  /persona/me/annual     某一年的年度报告（?year=YYYY；管理员可以预览今年到目前为止的）
- GET  /persona/clients       推荐官的客户看板（开关 persona_agent_board + can_view_reports）

总开关 persona_visible 关着时只有管理员能用（管理员不受开关限制）。三个功能开关
（persona_demo_preview / persona_goals / persona_agent_board）同样对管理员不设限。

Trading report + persona, user-facing. The persona_visible switch gates everyone but admins.
Ambassadors with the admin-granted can_view_reports may read their *direct* customers' reports,
addressed by e-mail like the ambassador customer list (user ids stay withheld).
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.rate_limit import limiter
from app.models import User
from app.services import shared_cache
from app.services.agent_tree import node_of
from app.services.deps import get_current_user, get_db
from app.services.persona import alerts, annual, engine, extras, service
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


def _open_rows(user_id: str):
    """此刻的持仓快照，给当月报告算「未计入的浮亏」和人格走向用；读不到就当没有。
    The live positions snapshot for the live month's floating loss and outlook; None when unavailable."""
    try:
        from app.services.connection_manager import manager
        return manager.get_positions_shared(user_id)
    except Exception:  # noqa: BLE001 —— 快照读不到，报告照出 / optional; the report still renders
        return None


def _features(db: Session, user: User) -> dict:
    """三个功能开关对这个人是否生效（管理员总是生效）。/ The three feature switches as this user sees them."""
    gs = get_gamification_settings(db)
    admin = user.role == "admin"
    return {
        "demoPreview": admin or bool(gs.get("persona_demo_preview")),
        "goals": admin or bool(gs.get("persona_goals")),
        "agentBoard": admin or bool(gs.get("persona_agent_board")),
    }


def _flag(feats: dict) -> str:
    return f"{int(bool(feats.get('demoPreview')))}{int(bool(feats.get('goals')))}"


def _drop_caches(user_id: str) -> None:
    """用户改了目标之后，把他那几份 60 秒缓存清掉，下一次打开就是新的。
    Clear the user's 60-second caches after a goal change."""
    period = service.period_of(service.utcnow())
    keys = []
    for flag in ("00", "01", "10", "11"):
        keys += [f"persona:me:{user_id}:{flag}", f"persona:rep:{user_id}:{period}:{flag[1]}"]
    shared_cache.delete(*keys)


def _overview(db: Session, user_id: str, feats: dict) -> dict:
    goals = bool(feats.get("goals"))

    def compute():
        st = service.status(db, user_id, preview=bool(feats.get("demoPreview")))
        if st["status"] != "unlocked":
            return st
        now = service.utcnow()
        return {**st, "months": service.months(db, user_id, now),
                "annuals": annual.years(db, user_id),
                "peers": extras.peers(db, st["persona"]["code"]),
                "report": service.report_for(db, user_id, service.period_of(now), now,
                                             open_rows=_open_rows(user_id), goals=goals)}
    return shared_cache.cached_json(f"persona:me:{user_id}:{_flag(feats)}", _CACHE_SECONDS, compute)


def _report(db: Session, user_id: str, period: str, feats: dict) -> dict:
    if not service.valid_period(period):
        raise HTTPException(400, _MSG_BAD_PERIOD)
    st = service.status(db, user_id)
    if st["status"] != "unlocked":
        raise HTTPException(404, "报告还没解锁 / Report not unlocked yet")
    goals = bool(feats.get("goals"))

    def compute():
        now = service.utcnow()
        rows = _open_rows(user_id) if period == service.period_of(now) else None
        rep = service.report_for(db, user_id, period, now, open_rows=rows, goals=goals)
        if rep is not None and not goals:
            rep.pop("goal", None)        # 开关关着：存档里存过的目标结果也不给 / switch off hides archived results too
        return rep
    rep = shared_cache.cached_json(f"persona:rep:{user_id}:{period}:{int(goals)}", _CACHE_SECONDS, compute)
    if rep is None:
        raise HTTPException(404, "这个月没有报告 / No report for this month")
    return rep


def _goal_menu() -> dict:
    return {k: {"dir": d, "min": lo, "max": hi} for k, (d, lo, hi) in engine.GOAL_METRICS.items()}


@router.get("/me")
@limiter.limit("30/minute")
def persona_me(request: Request, db: Session = Depends(get_db), user: User = Depends(require_persona_visible)):
    feats = _features(db, user)
    out = dict(_overview(db, user.id, feats))
    out["features"] = {**feats, "goalMenu": _goal_menu() if feats["goals"] else None,
                       "goalsMax": engine.GOALS_MAX}
    # 每日亏损提醒是用户随时会改的设置，不进 60 秒缓存 / the alert setting changes on demand; never cached
    out["alert"] = alerts.alert_out(extras.pref_row(db, user.id), service.utcnow())
    return out


@router.get("/me/report")
@limiter.limit("30/minute")
def persona_me_report(request: Request, period: str, db: Session = Depends(get_db),
                      user: User = Depends(require_persona_visible)):
    return _report(db, user.id, period, _features(db, user))


class GoalItemIn(BaseModel):
    key: str = Field(max_length=32)
    target: float = Field(allow_inf_nan=False)


class GoalIn(BaseModel):
    goals: list[GoalItemIn] = Field(default_factory=list, max_length=8)
    targetCode: str | None = Field(default=None, max_length=8)


@router.put("/me/goal")
@limiter.limit("20/minute")
def persona_set_goal(request: Request, body: GoalIn, db: Session = Depends(get_db),
                     user: User = Depends(require_persona_visible)):
    """设（或清空）本月目标和目标人格。设了一直沿用，随时能改。
    Set or clear the standing monthly goals and the target persona."""
    if not _features(db, user)["goals"]:
        raise HTTPException(403, _MSG_OFF)
    if service.status(db, user.id)["status"] != "unlocked":
        raise HTTPException(404, "报告还没解锁 / Report not unlocked yet")
    if body.targetCode is not None and body.targetCode not in engine.CODES:
        raise HTTPException(400, "没有这个人格代号 / Unknown persona code")
    try:
        goals = extras.clean_goals([g.model_dump() for g in body.goals])
    except ValueError:
        raise HTTPException(400, "目标不在可选范围内 / Goal outside the allowed menu or range") from None
    extras.save_goals(db, user.id, goals, body.targetCode, service.utcnow())
    db.commit()
    _drop_caches(user.id)
    return {"ok": True}


class AlertIn(BaseModel):
    limit: float | None = Field(default=None, allow_inf_nan=False)
    enabled: bool = False


@router.put("/me/alert")
@limiter.limit("20/minute")
def persona_set_alert(request: Request, body: AlertIn, db: Session = Depends(get_db),
                      user: User = Depends(require_persona_visible)):
    """设每日亏损提醒：金额（账户货币，正数）和开关。只提醒，不拦单。
    Set the daily loss alert: the limit (account currency) and the switch. It only notifies."""
    try:
        row = alerts.save_alert(db, user.id, body.limit, body.enabled)
    except ValueError:
        raise HTTPException(400, f"金额需在 {alerts.LIMIT_MIN:g}–{alerts.LIMIT_MAX:g} 之间 / "
                                 f"Limit must be between {alerts.LIMIT_MIN:g} and {alerts.LIMIT_MAX:g}") from None
    db.commit()
    return alerts.alert_out(row, service.utcnow())


@router.get("/me/annual")
@limiter.limit("30/minute")
def persona_me_annual(request: Request, year: int, db: Session = Depends(get_db),
                      user: User = Depends(require_persona_visible)):
    """年度报告。存好的谁都能看自己的；管理员还能预览今年到目前为止的那份。
    The annual report; admins may also preview the running year."""
    if not annual.valid_year(year):
        raise HTTPException(400, "年份不对 / Bad year")
    admin = user.role == "admin"

    def compute():
        return annual.annual_for(db, user.id, year, service.utcnow(), allow_live=admin)
    rep = shared_cache.cached_json(f"persona:annual:{user.id}:{year}:{int(admin)}", _CACHE_SECONDS, compute)
    if rep is None:
        raise HTTPException(404, "这一年没有年度报告 / No annual report for this year")
    return rep


@router.get("/clients")
@limiter.limit("20/minute")
def persona_clients(request: Request, db: Session = Depends(get_db),
                    user: User = Depends(require_persona_visible)):
    """推荐官的客户看板：直属客户的人格分布、谁没交易了、谁的评分掉得厉害。
    The ambassador customer board over direct customers."""
    if not _features(db, user)["agentBoard"]:
        raise HTTPException(403, _MSG_OFF)
    node = node_of(db, user.id)
    if node is None or not node.can_view_reports:
        raise HTTPException(403, "没有查看客户报告的权限 / Not allowed to view customer reports")
    return shared_cache.cached_json(f"persona:board:{user.id}", 300,
                                    lambda: extras.agent_board(db, user.id, service.utcnow()))


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
    # 看客户的报告不带模拟盘预览（那是给本人看的钩子）/ no demo preview when reading a customer
    feats = {**_features(db, user), "demoPreview": False}
    if body.period:
        return {"client": client, "report": _report(db, target.id, body.period, feats)}
    return {"client": client, **_overview(db, target.id, feats)}
