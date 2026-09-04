"""等级/勋章用户端 + 管理端（设计 §6、§11 发布策略）。"""
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

import re
from datetime import datetime, timedelta, timezone

from app.core.config import settings
from app.core.rate_limit import limiter
from app.models import LeaderboardSnapshot, PeriodBaseline, User, UserBadge, UserTask
from app.schemas import GamificationSettingsPatchIn, VisibilityPatchIn
from app.services.deps import get_current_user, get_db
from app.services.gamification import (
    BADGES, GROUPS, LEVEL_TITLES, compute_comprehensive_stats, condition_states,
    judge_and_award_badges, judge_and_record_conditions, level_of, equipped_list,
)
from app.services.gamification import identity, periods
from app.services.gamification.boards import _resolved_in_period, board_gates
from app.services.gamification.conditions import WINRATE_CONDITIONS
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
    """榜单页负载（设计 §4.3）：board/period 校验后转交 `build_board_rows_payload`。

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
    return build_board_rows_payload(db, viewer, board, period_key)


def build_board_rows_payload(db: Session, viewer: User, board: str, period_key: str) -> dict:
    """行构造（设计 §4.3）：打码、isSelf、me 块——不做 board/period 格式校验。

    从 `build_leaderboard_payload` 中抽出，供两类调用方共用：一是该函数自己
    （已经校验过 board 白名单与 period 格式），二是 Phase 3 比赛管理端的实时榜
    预览（`competitions.py` 的 `/admin/competitions/{id}/board`）——比赛的
    period_key 是 `comp:<id>`，不是 `_PERIOD_KEY_RE` 能匹配的自然周/月格式，
    所以它绕过 `build_leaderboard_payload` 直接调这个函数，board 用
    `comp.metric`（已在创建/编辑时校验过白名单）。

    负载里带的 `gates` 是当前生效的入榜门槛（来自 `boards.board_gates`），
    供前端渲染榜规文案/未上榜提示用的活数字，不再由前端写死 5/20/500——
    比赛详情页复用的也是这份 gates（比赛与常设榜共用同一套门槛规则）。
    A live snapshot of the current entry gates (via `boards.board_gates`),
    for the frontend to render its rules copy / not-ranked hint from instead
    of hardcoding 5/20/500 — the competition detail page reuses this same
    key (competitions share the standing boards' gate rules).
    """
    gates = board_gates(get_gamification_settings(db))
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
        me = {"rank": best.rank, "score": best.score, "sample": best.sample,
              "login": best.mt5_login}

    # 周期边界/封存时间：只对能被 `period_bounds` 解析的自然周/月 key 求值——
    # 比赛详情页复用的 period_key 是 `comp:<id>`，解析不了，此时三个字段全部
    # 省略（前端按 optional 处理），而不是让整个 payload 构造抛错。
    # Period bounds / seal time: only computed for keys `period_bounds` can
    # parse (natural week/month). The competition detail page reuses this
    # function with a `comp:<id>` key, which it can't parse — the three
    # fields are simply omitted then (the frontend treats them as optional)
    # rather than the whole payload build throwing.
    period_start = period_end = seal_at = None
    if _PERIOD_KEY_RE.match(period_key):
        period_start, period_end = periods.period_bounds(period_key)
        seal_at = period_end + timedelta(hours=periods.RECOMPUTE_GRACE_HOURS)

    # snapshotAt——「上次刷新」：快照行本身没有单独的 created_at/updated_at
    # 字段，`computed_at` 就是它（每次 `snapshot_boards` 重算都先删后插，
    # 所以 computed_at 天然等于"这批快照最后一次写入的时间"）。没有行时
    # （空榜）没有时间可取，留 None，前端按 optional 处理。
    # snapshotAt ("last refreshed"): the snapshot rows carry no separate
    # created_at/updated_at column — `computed_at` fills that role (each
    # `snapshot_boards` recompute deletes-then-inserts, so computed_at is
    # already "when this batch of snapshot rows was last written"). With no
    # rows (an empty board) there is nothing to take a time from; left None,
    # the frontend treats it as optional.
    snapshot_at = max((r.computed_at for r in all_rows if r.computed_at), default=None)

    # 上期冠军：只在本榜当前为空（`not rows`）时才算——前端只在空榜态渲染这个
    # 字段，非空榜时没有展示位，算了也是白算。同时只对能解析出边界的自然周/月
    # key 算：comp:<id> 没有"上一期"概念，previous_period_key 对它返回 None，
    # 天然跳过。这两条判据都收在下面 `if period_start is not None:` 的 payload
    # 组装里——comp 榜整段不带 previousWinner 键（同 periodStart 一样，不是
    # "键在但是 null"），自然周/月榜哪怕非空也带这个键（值是 None），
    # 让 types.ts 的 optional 字段保持"缺席=不适用该榜、null=适用但没有"两种
    # 语义分开，不混在一起。
    # Previous winner: only computed when this board is currently empty
    # (`not rows`) — the frontend only has a slot for it in the empty state,
    # so computing it otherwise would be wasted work. Also only for a
    # natural week/month key whose bounds we could parse: a comp:<id> key
    # has no "previous period" concept and previous_period_key returns None
    # for it, which naturally skips this. Both conditions are folded into
    # the `if period_start is not None:` payload assembly below — a
    # competition board carries no previousWinner key at all (not "present
    # but null", like periodStart), while a natural week/month board always
    # carries the key (value None when not applicable), keeping "absent =
    # doesn't apply to this board" and "null = applies but nothing there"
    # as two distinct, non-conflated signals for types.ts's optional field.
    previous_winner = None
    if period_start is not None and not rows:
        prev_key = periods.previous_period_key(period_key)
        if prev_key:
            prev_row = (db.query(LeaderboardSnapshot)
                          .filter(LeaderboardSnapshot.board == board,
                                  LeaderboardSnapshot.period_key == prev_key,
                                  LeaderboardSnapshot.rank == 1)
                          .first())
            if prev_row:
                pu = db.query(User).filter(User.id == prev_row.user_id).first()
                previous_winner = {
                    "displayName": identity.display_name(
                        pu.nickname if pu else None, pu.email if pu else None,
                        bool(pu.nickname_public) if pu else False),
                    "score": prev_row.score,
                }

    # progress：观众本期未上榜（me is None）但在本期至少拍过一个账户的基线——
    # 只对能解析出 period_start/period_end 的自然周/月 key 算（同上面的
    # guard 理由，comp:<id> 传不进 `_resolved_in_period` 的 bounds 参数）。
    # 多账户取"本期已判定整仓数最多"的那个，与榜单计算同一个
    # `_resolved_in_period`，口径不会分叉。
    #
    # 退榜用户（leaderboard_opt_out）额外拦一道：`compute_board_rows` 计算
    # 快照时本就把退榜用户整段跳过（设计 §4.1「下轮快照即消失」），一个退榜
    # 用户不管拍没拍基线、笔数多少，这期永远不会真的上榜——如果这里照样算出
    # 一个 progress，前端会显示"本期已完成 s / N 笔"这种误导文案，暗示"再等等
    # 就能上榜"，而事实是永远不会。退榜状态与「是否上榜」是同一个判定源，
    # 这里必须跟 compute_board_rows 保持同一立场。
    # progress: the viewer is unranked this period (me is None) but has
    # taken at least one account baseline this period — only computed for a
    # natural week/month key whose bounds we could parse (same guard reason
    # as above; a comp:<id> key has no bounds to hand `_resolved_in_period`).
    # With multiple accounts, picks the one with the most resolved positions
    # this period, using the same `_resolved_in_period` the board itself
    # uses so the two never diverge.
    #
    # An extra gate for opted-out users: `compute_board_rows` already
    # excludes them wholesale when computing snapshots (§4.1, "gone by the
    # next snapshot") — an opted-out user will never actually rank this
    # period no matter how many trades they close. Computing a `progress`
    # for them anyway would show a misleading "completed s / N this period"
    # that implies they're about to rank, when they never will be. Opt-out
    # status and "does this viewer rank" share the same source of truth；
    # this must agree with compute_board_rows rather than diverge from it.
    progress = None
    if me is None and period_start is not None and not viewer.leaderboard_opt_out:
        baseline_rows = (db.query(PeriodBaseline)
                            .filter(PeriodBaseline.user_id == viewer.id,
                                    PeriodBaseline.period_key == period_key)
                            .all())
        if baseline_rows:
            logins = {b.mt5_login for b in baseline_rows}
            taken_at_by_login = {b.mt5_login: b.taken_at for b in baseline_rows}
            profits_by_login = _resolved_in_period(
                db, viewer.id, logins, period_key, taken_at_by_login,
                bounds=(period_start, period_end))
            best = max(baseline_rows,
                       key=lambda b: len(profits_by_login.get(b.mt5_login, [])))
            progress = {
                "login": best.mt5_login,
                "sample": len(profits_by_login.get(best.mt5_login, [])),
                "baselineUsd": best.baseline + best.adjust,
                "minTrades": (gates["min_trades_return"] if board == "return_pct"
                              else gates["min_trades_winrate"]),
                "minBaselineUsd": gates["min_baseline_usd"],
            }

    payload = {
        "board": board, "periodKey": period_key, "rows": rows, "me": me,
        "progress": progress,
        "gates": {
            "minTradesReturn": gates["min_trades_return"],
            "minTradesWinrate": gates["min_trades_winrate"],
            "minBaselineUsd": gates["min_baseline_usd"],
        },
    }
    if period_start is not None:
        payload["periodStart"] = period_start.isoformat()
        payload["periodEnd"] = period_end.isoformat()
        payload["sealAt"] = seal_at.isoformat()
        payload["previousWinner"] = previous_winner
    if snapshot_at is not None:
        payload["snapshotAt"] = (snapshot_at if snapshot_at.tzinfo
                                  else snapshot_at.replace(tzinfo=timezone.utc)).isoformat()
    return payload


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
    # 详情层「全站拥有 N 人」——一次分组计数覆盖全部 17 枚，不逐枚各查一次。
    # 未出现在结果里的勋章（尚无人拥有）在下方用 .get(bid, 0) 补零，不需要
    # LEFT JOIN 到勋章注册表（那是个 dict，不是表）。population 同理只查一次。
    # Detail-layer "N holders sitewide": one grouped count covers all 17
    # badges instead of a per-badge query. A badge absent from the result
    # (nobody owns it yet) is zero-filled below via .get(bid, 0) — no need to
    # LEFT JOIN the badge registry (it's a dict, not a table). population is
    # likewise a single query.
    owners_by_badge = dict(
        db.query(UserBadge.badge_id, func.count(UserBadge.id.distinct()))
        .group_by(UserBadge.badge_id)
        .all()
    )
    population = db.query(func.count(User.id)).scalar() or 0
    equipped = equipped_list(user)
    equipped_set = set(equipped)
    return {
        "level": level,
        "title": LEVEL_TITLES[level - 1],
        "groups": condition_states(db, user.id, stats),
        "badges": [{
            "id": bid, "rarity": meta["rarity"], "category": meta["category"],
            "earned": bid in owned,
            "awardedAt": owned.get(bid).isoformat() if bid in owned else None,
            "equipped": bid in equipped_set,
            "owners": owners_by_badge.get(bid, 0),
        } for bid, meta in BADGES.items()],
        "winRate": {
            "value": stats["win_rate"], "windowDays": stats["window_days"],
            "perLogin": [{"login": lg, **d} for lg, d in stats["per_login"].items()],
        },
        "nickname": user.nickname, "nicknamePublic": user.nickname_public,
        "leaderboardOptOut": user.leaderboard_opt_out,
        "equippedBadge": user.equipped_badge,
        "equippedBadges": equipped,
        "population": population,
    }


# 仪表盘胜率卡摘要（设计 §2.4/§7）：独立缓存，与 /me 的 60 秒判定节流是两回事——
# 这里从不触发 judge_and_record_conditions/judge_and_award_badges（那是重的一
# 半在“判定”，不在“统计”），只读 compute_comprehensive_stats + 已落库的
# UserTask。但 compute_comprehensive_stats 本身仍是 365 天整仓聚合，仪表盘卡
# 45 秒轮询一次，所以照样按用户缓存 60 秒——避免每次轮询都把这条查询打一遍。
# 进程内 dict，理由同 _last_judged（本部署单进程）；按用户数封顶，永不清空，
# 与 _last_judged 同一设计——量级上可接受，不做淘汰。
# Dashboard win-rate-card summary (§2.4/§7): a separate cache from /me's 60s
# judging throttle — this endpoint never triggers judge_and_record_conditions/
# judge_and_award_badges (the expensive half is "judging", not "reading
# stats"), it only reads compute_comprehensive_stats + already-persisted
# UserTask rows. But compute_comprehensive_stats is itself a 365-day
# full-position aggregation, and the dashboard card polls it every 45s, so it
# still gets a 60s per-user cache to avoid re-running that query on every
# poll. In-process dict for the same reason as _last_judged (single-process
# deployment); bounded by user count and never evicted, by design, same as
# _last_judged — acceptable at this scale.
_SUMMARY_CACHE_SECONDS = 60
_summary_cache: dict[str, tuple[float, dict]] = {}


def build_winrate_summary_payload(db: Session, user: User) -> dict:
    now = time.monotonic()
    cached = _summary_cache.get(user.id)
    if cached is not None and now - cached[0] < _SUMMARY_CACHE_SECONDS:
        return cached[1]

    stats = compute_comprehensive_stats(db, user.id)
    done = {t.task_id for t in db.query(UserTask).filter(UserTask.user_id == user.id)}
    level = level_of(done)
    win_rate = stats["win_rate"]

    # 下一级的毕业线：GROUPS 里第一个尚未全部完成的组——与 level_of 走的是同一条
    # 判定路径，所以这里找到的组恰好是「用户正在闯的下一关」。isMaxLevel（没有
    # 下一关）与 remainingToNext（下一关里还没做完的条件数，含非胜率条件——跟
    # AchievementsPage.tsx 的 nextGroup/remaining 是同一份算法）给前端，不再靠
    # `level >= 6` 硬编码判满级，也不再对"下一关不是胜率关"（如一级 qicheng）
    # 什么都不显示。next_target 仅在该组含胜率条件时才有值。
    # The next level's graduation bar: the first group in GROUPS not yet fully
    # done — the same walk level_of does, so the group found here is exactly
    # "the level the user is working toward next". isMaxLevel (no next group)
    # and remainingToNext (undone conditions in that next group, including
    # non-win-rate ones — the same algorithm as AchievementsPage.tsx's
    # nextGroup/remaining) go to the frontend so it stops hardcoding
    # `level >= 6` for max level and stops showing nothing when the next group
    # isn't a win-rate group (e.g. level 1's qicheng). next_target is only set
    # when that group actually has a win-rate condition.
    next_target: float | None = None
    remaining_to_next: int | None = None
    is_max_level = True
    for _gid, conds in GROUPS:
        if all(c in done for c in conds):
            continue
        is_max_level = False
        remaining_to_next = sum(1 for c in conds if c not in done)
        for c in conds:
            if c in WINRATE_CONDITIONS:
                next_target = WINRATE_CONDITIONS[c]
        break

    # metNext/gapPct 必须跟 conditions.py 的严判口径（wr > target，严格大于）
    # 一致：卡在 == target 上时不能说"已达标"（那样用户会纳闷为什么条件迟迟不
    # 完成），而是如实报"还差 0.0%"——数字是 0 但没过线，跟严判的判定结果对得上。
    # metNext/gapPct must agree with conditions.py's strict judging (wr >
    # target, strictly greater): sitting exactly at == target must not read as
    # "met" (the user would be puzzled why the condition never completes) —
    # instead it truthfully reports "still 0.0% short", a zero that hasn't
    # actually cleared the bar, matching the judging outcome.
    met_next: bool | None = None
    gap_pct: float | None = None
    if next_target is not None and win_rate is not None:
        met_next = win_rate > next_target
        gap_pct = 0.0 if met_next else round(max(next_target - win_rate, 0.0) * 100, 1)

    payload = {
        "winRate": win_rate,
        "windowDays": stats["window_days"],
        "trades": stats["trades"],
        "level": level,
        "title": LEVEL_TITLES[level - 1],
        "nextWinRateTarget": next_target,
        "metNext": met_next,
        "gapPct": gap_pct,
        "remainingToNext": remaining_to_next,
        "isMaxLevel": is_max_level,
    }
    _summary_cache[user.id] = (now, payload)
    return payload


@router.get("/winrate-summary")
@limiter.limit(settings.RATE_LIMIT_GAMIFICATION)
def gamification_winrate_summary(request: Request, db: Session = Depends(get_db),
                                  user: User = Depends(require_gamification_visible)):
    return build_winrate_summary_payload(db, user)


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


# snake_case 存储键 ↔ camelCase API 字段——两处写死在一起，改字段时两侧一起改。
# snake_case store keys <-> camelCase API fields, kept side by side so a
# field rename touches both at once.
_SETTINGS_KEY_MAP = {
    "user_visible": "userVisible",
    "leaderboard_visible": "leaderboardVisible",
    "competitions_visible": "competitionsVisible",
    "min_baseline_usd": "minBaselineUsd",
    "min_trades_return": "minTradesReturn",
    "min_trades_winrate": "minTradesWinrate",
}


def _settings_to_camel(data: dict) -> dict:
    return {camel: data[snake] for snake, camel in _SETTINGS_KEY_MAP.items()}


@admin_router.get("/settings")
def admin_get_settings(db: Session = Depends(get_db)):
    return _settings_to_camel(get_gamification_settings(db))


@admin_router.patch("/settings")
def admin_patch_settings(body: GamificationSettingsPatchIn, db: Session = Depends(get_db)):
    """设置组局部更新：全字段可选，只改 model_fields_set 里出现过的那些——
    与 `/visibility` PATCH 共用同一份 settings_store 记录，靠
    `save_gamification_settings` 的读-合并-写语义组合，互不清空对方的键。

    Partial update for the settings group: only fields present in
    model_fields_set are touched. Shares the same settings_store record with
    the `/visibility` PATCH; composed via `save_gamification_settings`'s
    read-merge-write semantics so neither endpoint clobbers the other's keys.
    """
    sent = body.model_fields_set
    patch: dict = {}
    if "userVisible" in sent:
        patch["user_visible"] = bool(body.userVisible)
    if "leaderboardVisible" in sent:
        patch["leaderboard_visible"] = bool(body.leaderboardVisible)
    if "competitionsVisible" in sent:
        patch["competitions_visible"] = bool(body.competitionsVisible)
    if "minBaselineUsd" in sent:
        if body.minBaselineUsd is None or body.minBaselineUsd <= 0:
            raise HTTPException(400, "最低本金需大于 0 / Minimum baseline must be > 0")
        patch["min_baseline_usd"] = float(body.minBaselineUsd)
    if "minTradesReturn" in sent:
        if body.minTradesReturn is None or body.minTradesReturn < 1:
            raise HTTPException(400, "入榜笔数门槛需至少为 1 / Trade-count gate must be at least 1")
        patch["min_trades_return"] = int(body.minTradesReturn)
    if "minTradesWinrate" in sent:
        if body.minTradesWinrate is None or body.minTradesWinrate < 1:
            raise HTTPException(400, "入榜笔数门槛需至少为 1 / Trade-count gate must be at least 1")
        patch["min_trades_winrate"] = int(body.minTradesWinrate)
    if patch:
        save_gamification_settings(db, patch)
        db.commit()
        invalidate_gamification_cache()
    return _settings_to_camel(get_gamification_settings(db))


@admin_router.get("/leaderboard")
def admin_leaderboard(board: str, period: str, db: Session = Depends(get_db),
                       admin: User = Depends(get_current_user)):
    """管理端榜单预览：以请求管理员为 viewer，不受用户端 leaderboard_visible
    开关限制（该开关只挡用户端 /gamification/leaderboard）。
    Admin leaderboard preview: the requesting admin is the viewer, and this
    is not gated by leaderboard_visible (that gate only guards the
    user-facing /gamification/leaderboard)."""
    return build_leaderboard_payload(db, admin, board, period)
