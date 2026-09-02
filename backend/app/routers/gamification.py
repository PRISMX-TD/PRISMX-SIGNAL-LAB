"""等级/勋章用户端 + 管理端（设计 §6、§11 发布策略）。"""
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import re
from datetime import datetime, timezone

from app.core.config import settings
from app.core.rate_limit import limiter
from app.models import LeaderboardSnapshot, User, UserBadge, UserTask
from app.schemas import VisibilityPatchIn
from app.services.deps import get_current_user, get_db
from app.services.gamification import (
    BADGES, LEVEL_TITLES, compute_comprehensive_stats, condition_states,
    judge_and_award_badges, judge_and_record_conditions, level_of)
from app.services.gamification import identity, periods
from app.services.settings_store import (
    get_gamification_settings, invalidate_gamification_cache, save_gamification_settings)

LEADERBOARD_BOARDS = ("return_pct", "win_rate")
_PERIOD_KEY_RE = re.compile(r"^\d{4}-W\d{2}$|^\d{4}-\d{2}$")

router = APIRouter(prefix="/gamification", tags=["gamification"])

# 单人判定节流：设计 §6 要求 /me 不能每次请求都跑全量判定（数据库查询代价不小），
# 但又要让用户操作后（如设了昵称、绑了账号）尽快看到新等级/勋章，60 秒是折中。
# 进程内 dict 是有意的——本部署强制单进程（见 rate_limit.py 同款注释），多进程需
# 迁到 Redis。
# Per-user judging throttle: §6 says /me can't re-run the full judging pass on
# every request (the queries aren't cheap), but a user should still see a new
# level/badge shortly after acting (setting a nickname, binding an account) —
# 60s is the compromise. The in-process dict is deliberate: this deployment is
# pinned to a single process (same rationale as rate_limit.py); multi-process
# needs this moved to Redis.
_JUDGE_THROTTLE_SECONDS = 60
_last_judged: dict[str, float] = {}


def _check_visible(db: Session, user: User) -> None:
    if user.role == "admin":
        return
    if not get_gamification_settings(db).get("user_visible"):
        raise HTTPException(403, "功能内测中，暂未开放 / Feature in beta, not yet available")


def require_gamification_visible(db: Session = Depends(get_db),
                                  user: User = Depends(get_current_user)) -> User:
    _check_visible(db, user)
    return user


def _check_leaderboard_visible(db: Session, user: User) -> None:
    if user.role == "admin":
        return
    if not get_gamification_settings(db).get("leaderboard_visible"):
        raise HTTPException(403, "排行榜内测中，暂未开放 / Leaderboard in beta, not yet available")


def require_leaderboard_visible(db: Session = Depends(get_db),
                                 user: User = Depends(get_current_user)) -> User:
    _check_leaderboard_visible(db, user)
    return user


def build_leaderboard_payload(db: Session, viewer: User, board: str, period: str) -> dict:
    """榜单页负载（设计 §4.3）：board/period 校验、打码、isSelf、me 块。

    `period` 既接受 "week"/"month"（解析为以当前 UTC 时间算出的进行中周期
    key），也接受显式 key（校验格式），后者是已封存历史周期唯一的访问方式——
    快照是只读的，不需要额外的可见性判断。
    """
    if board not in LEADERBOARD_BOARDS:
        raise HTTPException(400, "未知榜单 / Unknown board")
    if period == "week":
        period_key = periods.week_key(datetime.now(timezone.utc))
    elif period == "month":
        period_key = periods.month_key(datetime.now(timezone.utc))
    else:
        if not _PERIOD_KEY_RE.match(period or ""):
            raise HTTPException(400, "周期格式错误 / Invalid period")
        period_key = period

    all_rows = (db.query(LeaderboardSnapshot)
                  .filter(LeaderboardSnapshot.board == board,
                          LeaderboardSnapshot.period_key == period_key)
                  .order_by(LeaderboardSnapshot.rank)
                  .all())
    top_rows = all_rows[:50]

    users_by_id = {}
    if top_rows:
        ids = {r.user_id for r in top_rows}
        users_by_id = {u.id: u for u in db.query(User).filter(User.id.in_(ids))}

    rows = []
    for r in top_rows:
        u = users_by_id.get(r.user_id)
        rows.append({
            "rank": r.rank,
            "displayName": identity.display_name(
                u.nickname if u else None, u.email if u else None,
                bool(u.nickname_public) if u else False),
            "login": r.mt5_login,
            "score": r.score,
            "sample": r.sample,
            "isSelf": r.user_id == viewer.id,
            "equippedBadge": u.equipped_badge if u else None,
        })

    me = None
    my_rows = [r for r in all_rows if r.user_id == viewer.id]
    if my_rows:
        best = min(my_rows, key=lambda r: r.rank)
        me = {"rank": best.rank, "score": best.score, "sample": best.sample}

    return {"board": board, "periodKey": period_key, "rows": rows, "me": me}


def build_me_payload(db: Session, user: User, judge: bool) -> dict:
    now = time.monotonic()
    if judge and now - _last_judged.get(user.id, 0.0) >= _JUDGE_THROTTLE_SECONDS:
        _last_judged[user.id] = now
        judge_and_record_conditions(db, user.id)
        judge_and_award_badges(db, user.id)
    stats = compute_comprehensive_stats(db, user.id)
    done = {t.task_id for t in db.query(UserTask).filter(UserTask.user_id == user.id)}
    owned = {b.badge_id: b.awarded_at
             for b in db.query(UserBadge).filter(UserBadge.user_id == user.id)}
    level = level_of(done)
    return {
        "level": level,
        "title": LEVEL_TITLES[level - 1],
        "groups": condition_states(db, user.id, stats),
        "badges": [{
            "id": bid, "rarity": meta["rarity"], "category": meta["category"],
            "earned": bid in owned,
            "awardedAt": owned.get(bid).isoformat() if bid in owned else None,
            "equipped": user.equipped_badge == bid,
        } for bid, meta in BADGES.items()],
        "winRate": {
            "value": stats["win_rate"], "windowDays": stats["window_days"],
            "perLogin": [{"login": lg, **d} for lg, d in stats["per_login"].items()],
        },
        "nickname": user.nickname, "nicknamePublic": user.nickname_public,
        "leaderboardOptOut": user.leaderboard_opt_out,
        "equippedBadge": user.equipped_badge,
    }


@router.get("/me")
@limiter.limit(settings.RATE_LIMIT_GAMIFICATION)
def gamification_me(request: Request, db: Session = Depends(get_db),
                     user: User = Depends(require_gamification_visible)):
    return build_me_payload(db, user, judge=True)


@router.get("/leaderboard")
@limiter.limit(settings.RATE_LIMIT_LEADERBOARD)
def gamification_leaderboard(request: Request, board: str, period: str,
                              db: Session = Depends(get_db),
                              user: User = Depends(require_leaderboard_visible)):
    return build_leaderboard_payload(db, user, board, period)


# ---- 管理员端 / admin endpoints ----
# 权限收口方式同 tickets.admin_router / invite.admin_router 先例：路由本身不带
# require_admin，在 main.py 的 include_router(..., dependencies=[Depends(require_admin)])
# 里统一挂上，避免每个端点各写一遍。
# Auth is gated the same way as tickets.admin_router / invite.admin_router: the
# router itself carries no require_admin dependency — it's attached once in
# main.py's include_router(..., dependencies=[Depends(require_admin)]) instead
# of repeating it on every endpoint.
admin_router = APIRouter(prefix="/admin/gamification", tags=["admin"])


@admin_router.get("/user/{user_id}")
def admin_inspect_user(user_id: str, db: Session = Depends(get_db)):
    """管理端检查器：目标用户的完整游戏化面板，触发一次真实判定（同 60 秒节流）。
    Admin inspector: the target user's full gamification panel, triggering a
    real judging pass (same 60s throttle)."""
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(404, "用户不存在 / User not found")
    payload = build_me_payload(db, target, judge=True)
    payload["email"] = target.email
    return payload


@admin_router.get("/visibility")
def admin_get_visibility(db: Session = Depends(get_db)):
    return {"userVisible": bool(get_gamification_settings(db).get("user_visible"))}


@admin_router.patch("/visibility")
def admin_set_visibility(body: VisibilityPatchIn, db: Session = Depends(get_db)):
    save_gamification_settings(db, {"user_visible": bool(body.userVisible)})
    db.commit()
    invalidate_gamification_cache()
    return {"userVisible": bool(body.userVisible)}
