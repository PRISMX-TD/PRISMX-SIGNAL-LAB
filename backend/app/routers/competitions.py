"""比赛（设计 §1.7/§1.8/§1.9，Phase 3 Task 5/6）：管理端 CRUD/状态推进/参赛管理/
终审 + 用户端公开列表/详情/报名。

用户端 `router`（本任务）与管理端 `admin_router`（Task 5）拆成两个 router 是照
gamification.py 的先例——权限收口方式也一样：admin_router 本身不带 require_admin，
在 main.py 的 include_router(..., dependencies=[Depends(require_admin)]) 里统一
挂上；用户端则是每个端点各自挂 `require_competitions_visible`（内测开关，克隆自
gamification.py 的 `require_leaderboard_visible`）。
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.rate_limit import limiter
from app.models import (
    Competition, CompetitionParticipant, LeaderboardSnapshot, PeriodBaseline, User)
from app.services.audit import log_change as _log_change
from app.routers.gamification import build_board_rows_payload
from app.schemas import (
    CompetitionCreateIn, CompetitionParticipantPatchIn, CompetitionPatchIn,
    CompetitionRegisterIn)
from app.services.deps import get_current_user, get_db, require_admin
from app.services.gamification import identity
from app.services.gamification.competitions import (
    TRACKS, auto_enroll, comp_gates, comp_period_key, refresh_comp_board,
    register_participant, settle_competition)
from app.services.settings_store import get_gamification_settings
from app.utils.timeutil import aware as _aware

# ---- 用户端 / user-facing ----
router = APIRouter(prefix="/competitions", tags=["competitions"])

MSG_COMP_NOT_FOUND = "比赛不存在 / Competition not found"


def _check_competitions_visible(db: Session, user: User) -> None:
    if user.role == "admin":
        return
    if not get_gamification_settings(db).get("competitions_visible"):
        raise HTTPException(403, "比赛内测中，暂未开放 / Competitions in beta, not yet available")


def require_competitions_visible(db: Session = Depends(get_db),
                                  user: User = Depends(get_current_user)) -> User:
    _check_competitions_visible(db, user)
    return user


def _summary_out(comp: Competition, top: list[dict] | None = None,
                 participants: int = 0) -> dict:
    top = top or []
    return {
        # 榜首三行（列表头版的跑马灯用）与参赛账户数，由 _leaders / 列表端点一次
        # 查齐；champion 只在已终审时给（荣誉墙用），其余 None。
        # Top three rows (for the list front page's ticker) and the entered-account
        # count, fetched for all rows at once; champion only once settled (hall of
        # champions), None otherwise.
        "top": top,
        "participants": participants,
        "champion": top[0] if comp.status == "settled" and top else None,
        "id": comp.id,
        "name": comp.name,
        "description": comp.description,
        "metric": comp.metric,
        "enrollment": comp.enrollment,
        "status": comp.status,
        # 用户端也要知道赛道：报名时账户选择器按它过滤（实盘赛只列实盘、
        # 模拟赛只列模拟），否则模拟赛的选择器会是空的。
        # The user side needs the track too: the registration selector filters by it
        # (a live competition lists live accounts, a demo one lists demo accounts);
        # without it a demo competition would show an empty selector.
        "track": comp.track,
        "regOpensAt": comp.reg_opens_at.isoformat() if comp.reg_opens_at else None,
        "regClosesAt": comp.reg_closes_at.isoformat() if comp.reg_closes_at else None,
        "startsAt": comp.starts_at.isoformat() if comp.starts_at else None,
        "endsAt": comp.ends_at.isoformat() if comp.ends_at else None,
        "prizeNote": comp.prize_note,
    }


def _leaders(db: Session, comps: list[Competition]) -> dict[str, list[dict]]:
    """各场比赛的前三行 → {comp_id: [{displayName, score, equippedBadge}, ...]}，
    按名次排好。一次 IN 查询取所有 rank<=3 的快照行，再一次取用户，不逐场查；
    昵称按公开设置打码，与榜单行同一个 identity.display_name（用户端永远看不到
    真实身份）。只认 board == comp.metric 的行——同一个 period_key 理论上只有
    一种 board，防御性地过滤一下。
    Top-three snapshot rows per competition → {comp_id: [...]} in rank order. One
    IN query for every rank<=3 row, one for the users, no per-competition lookups;
    names masked per the nickname setting via the same identity.display_name the
    board rows use (the user side never sees a real identity). Only rows whose
    board matches comp.metric count; a period_key should only ever carry one
    board, so this is a defensive filter."""
    by_key = {comp_period_key(c.id): c for c in comps}
    if not by_key:
        return {}
    rows = (db.query(LeaderboardSnapshot)
              .filter(LeaderboardSnapshot.period_key.in_(list(by_key)),
                      LeaderboardSnapshot.rank <= 3)
              .order_by(LeaderboardSnapshot.rank)
              .all())
    users = ({u.id: u for u in db.query(User).filter(User.id.in_({r.user_id for r in rows}))}
             if rows else {})
    out: dict[str, list[dict]] = {}
    for r in rows:
        comp = by_key[r.period_key]
        if r.board != comp.metric:
            continue
        u = users.get(r.user_id)
        out.setdefault(comp.id, []).append({
            "displayName": identity.display_name(
                u.nickname if u else None, u.email if u else None,
                bool(u.nickname_public) if u else False),
            "score": r.score,
            "equippedBadge": u.equipped_badge if u else None,
        })
    return out


def _get_public_comp_or_404(db: Session, comp_id: str) -> Competition:
    """草稿对用户端一律视同不存在——404 不区分「没有这条记录」和「记录还在
    draft」，避免把「有一场比赛正在筹备」这个信息透给未获授权查看的用户。"""
    comp = db.get(Competition, comp_id)
    if comp is None or comp.status == "draft":
        raise HTTPException(404, MSG_COMP_NOT_FOUND)
    return comp


@router.get("")
@limiter.limit(settings.RATE_LIMIT_COMPETITION)
def list_competitions(request: Request, db: Session = Depends(get_db),
                       user: User = Depends(require_competitions_visible)):
    """非 draft 比赛按状态分组；ended/settled 统一归 finished。upcoming 按开赛时间
    正序（最快开始的排前面），running/finished 按开赛时间倒序（最新的排前面）。
    """
    comps = db.query(Competition).filter(Competition.status != "draft").all()
    upcoming = sorted((c for c in comps if c.status == "upcoming"), key=lambda c: c.starts_at)
    running = sorted((c for c in comps if c.status == "running"),
                      key=lambda c: c.starts_at, reverse=True)
    finished = sorted((c for c in comps if c.status in ("ended", "settled")),
                       key=lambda c: c.starts_at, reverse=True)
    leaders = _leaders(db, running + finished)
    # 参赛数复用管理端同一个分组查询（含被取消资格的条目：报了名就是参赛）。
    # The count reuses the admin side's grouped query (disqualified entries
    # included: entered is entered).
    counts = _participant_counts(db, [c.id for c in comps])
    out = lambda c: _summary_out(c, leaders.get(c.id), counts.get(c.id, 0))  # noqa: E731
    return {
        "upcoming": [out(c) for c in upcoming],
        "running": [out(c) for c in running],
        "finished": [out(c) for c in finished],
    }


@router.get("/{comp_id}")
@limiter.limit(settings.RATE_LIMIT_COMPETITION)
def get_competition(request: Request, comp_id: str, db: Session = Depends(get_db),
                     user: User = Depends(require_competitions_visible)):
    """详情 + 实时榜（读快照，行构造复用 `build_board_rows_payload`——对 upcoming
    比赛而言快照还没有任何行，返回空 rows/me=None，函数本身不需要区分状态）+
    当前用户在本场比赛下的参赛条目 + pendingSettle（ended 且未终审）。

    与 `POST /register` 同样挂 `RATE_LIMIT_COMPETITION`（同 gamification.py 的
    `/me`、`/leaderboard` 两个 GET 都挂限流的先例一致）——这里每次调用都会跑一遍
    `build_board_rows_payload`，开关翻开后大概率被前端轮询，不该是唯一不设限的
    公开端点。
    """
    comp = _get_public_comp_or_404(db, comp_id)
    # 读之前先按需刷新：进行中的比赛不必等每小时那趟循环，最多 20 秒陈旧
    # （refresh_comp_board 自带节流，多人同时轮询也只真算一次）。
    # Refresh before reading: a running competition doesn't wait for the hourly pass,
    # so the board is at most ~20s stale (refresh_comp_board throttles itself, so
    # simultaneous pollers still trigger only one real recompute).
    refresh_comp_board(db, comp)
    board = build_board_rows_payload(db, user, comp.metric, comp_period_key(comp.id),
                                      gates_override=_comp_gates(db, comp))
    my_rows = (db.query(CompetitionParticipant)
                 .filter(CompetitionParticipant.competition_id == comp.id,
                         CompetitionParticipant.user_id == user.id)
                 .order_by(CompetitionParticipant.registered_at.asc()).all())
    out = _summary_out(comp)
    out["board"] = board
    out["myEntries"] = [{
        "login": p.mt5_login,
        "scoringFrom": p.scoring_from.isoformat() if p.scoring_from else None,
        "finalRank": p.final_rank,
        "finalScore": p.final_score,
        "disqualified": p.disqualified,
    } for p in my_rows]
    out["pendingSettle"] = comp.status == "ended"
    return out


@router.post("/{comp_id}/register")
@limiter.limit(settings.RATE_LIMIT_COMPETITION)
def register_for_competition(request: Request, comp_id: str, body: CompetitionRegisterIn,
                              db: Session = Depends(get_db),
                              user: User = Depends(require_competitions_visible)):
    comp = _get_public_comp_or_404(db, comp_id)
    participant = register_participant(db, comp, user, body.mt5Login, now=datetime.now(timezone.utc))
    return {
        "login": participant.mt5_login,
        "scoringFrom": participant.scoring_from.isoformat() if participant.scoring_from else None,
    }


# ---- 管理员端 / admin endpoints ----
# 权限收口方式同 gamification.admin_router 先例：见模块docstring。
# 守卫写在 router 自己身上（见 gamification.py 同一处的说明）。
# Guard on the router itself (see the note in gamification.py).
admin_router = APIRouter(prefix="/admin/competitions", tags=["admin"],
                         dependencies=[Depends(require_admin)])

_METRICS = ("return_pct", "win_rate")
_ENROLLMENTS = ("signup", "auto")
# draft→upcoming→running→ended 只进不退一步；settled 只能走 /settle 端点，PATCH
# 一律拒绝（哪怕当前状态是 ended，"相邻"也不包含它——见下方 _advance_status）。
_ADVANCE = {"draft": "upcoming", "upcoming": "running", "running": "ended"}
# 非 draft 状态下 PATCH 仅允许改这些「文案 + 报名窗口」字段；其余出现在
# model_fields_set 里一律 400。
_NON_DRAFT_ALLOWED = {"name", "description", "prizeNote", "regOpensAt", "regClosesAt"}

MSG_START_BEFORE_END = "开赛时间需早于结束时间 / Start must precede end"
MSG_SIGNUP_WINDOW = "报名制比赛需设置报名窗口 / Signup competitions require a registration window"
MSG_UNKNOWN_METRIC = "未知计分指标 / Unknown metric"
MSG_UNKNOWN_ENROLLMENT = "未知参赛方式 / Unknown enrollment mode"
MSG_UNKNOWN_TRACK = "未知参赛账户类型 / Unknown account track"
MSG_BAD_MIN_BASELINE = "最低本金需大于 0 / Minimum baseline must be > 0"
MSG_BAD_MIN_TRADES = "最低笔数需至少为 1 / Minimum trade count must be at least 1"
MSG_NON_DRAFT_FIELDS = "比赛开始后仅可修改文案与报名窗口 / Only copy and registration window are editable after draft"
MSG_STATUS_SEQUENCE = "状态只能按顺序推进 / Status can only advance sequentially"
MSG_SETTLED_FROZEN = "已终审的比赛不可再改参赛状态 / Settled competitions are frozen"


def _validate_core(metric: str, enrollment: str,
                    starts_at: datetime | None, ends_at: datetime | None) -> None:
    if metric not in _METRICS:
        raise HTTPException(400, MSG_UNKNOWN_METRIC)
    if enrollment not in _ENROLLMENTS:
        raise HTTPException(400, MSG_UNKNOWN_ENROLLMENT)
    if starts_at is None or ends_at is None or not (_aware(starts_at) < _aware(ends_at)):
        raise HTTPException(400, MSG_START_BEFORE_END)


def _validate_options(track: str | None, min_baseline: float | None,
                       min_trades: int | None) -> None:
    """赛道白名单 + 两个门槛的下限。三者都允许为 None（跟随默认/全局），只有
    给了值才校验——空值和坏值是两回事，不能一起拒。
    Track whitelist plus the floors for the two gates. All three may be None
    (follow the default / the global settings); only a supplied value is checked,
    since "absent" and "invalid" are different things."""
    if track is not None and track not in TRACKS:
        raise HTTPException(400, MSG_UNKNOWN_TRACK)
    if min_baseline is not None and min_baseline <= 0:
        raise HTTPException(400, MSG_BAD_MIN_BASELINE)
    if min_trades is not None and min_trades < 1:
        raise HTTPException(400, MSG_BAD_MIN_TRADES)


def _validate_reg_window(enrollment: str, reg_opens_at: datetime | None,
                          reg_closes_at: datetime | None) -> None:
    """signup 赛必须给两端且 opens<closes；报名窗口允许与比赛重叠（开赛后仍可
    补报名——scoring_from 兜住实际计分起点），所以这里不比对 starts_at。"""
    if enrollment != "signup":
        return
    if (reg_opens_at is None or reg_closes_at is None
            or not (_aware(reg_opens_at) < _aware(reg_closes_at))):
        raise HTTPException(400, MSG_SIGNUP_WINDOW)


def _comp_gates(db: Session, comp: Competition) -> dict:
    """本场比赛实际生效的门槛（比赛自己的值优先，否则全局），下发给前端回显。
    The gates actually in force for this competition (its own values first,
    otherwise the global ones), sent to the frontend for display."""
    return comp_gates(comp, get_gamification_settings(db))


def _comp_out(comp: Competition, participant_count: int) -> dict:
    return {
        "id": comp.id,
        "name": comp.name,
        "description": comp.description,
        "metric": comp.metric,
        "enrollment": comp.enrollment,
        "status": comp.status,
        "track": comp.track,
        # 两个门槛：null 表示跟随全局设置，前端据此显示"跟随全局"而不是一个假数字。
        # Both gates: null means "follow the global settings", which the frontend shows
        # as such rather than inventing a number.
        "minBaselineUsd": comp.min_baseline_usd,
        "minTrades": comp.min_trades,
        "regOpensAt": comp.reg_opens_at.isoformat() if comp.reg_opens_at else None,
        "regClosesAt": comp.reg_closes_at.isoformat() if comp.reg_closes_at else None,
        "startsAt": comp.starts_at.isoformat() if comp.starts_at else None,
        "endsAt": comp.ends_at.isoformat() if comp.ends_at else None,
        "prizeNote": comp.prize_note,
        "createdAt": comp.created_at.isoformat() if comp.created_at else None,
        "participantCount": participant_count,
    }


def _participant_counts(db: Session, comp_ids: list[str]) -> dict[str, int]:
    """一次分组查询取全部比赛的参赛数，避免逐条比赛各查一次（N+1）。"""
    if not comp_ids:
        return {}
    rows = (db.query(CompetitionParticipant.competition_id, func.count(CompetitionParticipant.id))
              .filter(CompetitionParticipant.competition_id.in_(comp_ids))
              .group_by(CompetitionParticipant.competition_id).all())
    return {cid: cnt for cid, cnt in rows}


def _participant_out(p: CompetitionParticipant, email: str | None) -> dict:
    return {
        "id": p.id,
        "userId": p.user_id,
        "email": email,
        "login": p.mt5_login,
        "registeredAt": p.registered_at.isoformat() if p.registered_at else None,
        "scoringFrom": p.scoring_from.isoformat() if p.scoring_from else None,
        "finalScore": p.final_score,
        "finalRank": p.final_rank,
        "disqualified": p.disqualified,
        "disqualifyReason": p.disqualify_reason,
    }


def _get_comp_or_404(db: Session, comp_id: str) -> Competition:
    comp = db.get(Competition, comp_id)
    if comp is None:
        raise HTTPException(404, MSG_COMP_NOT_FOUND)
    return comp


@admin_router.get("")
def admin_list_competitions(db: Session = Depends(get_db)):
    comps = db.query(Competition).order_by(Competition.created_at.desc()).all()
    counts = _participant_counts(db, [c.id for c in comps])
    return [_comp_out(c, counts.get(c.id, 0)) for c in comps]


@admin_router.post("")
def admin_create_competition(body: CompetitionCreateIn, db: Session = Depends(get_db)):
    _validate_core(body.metric, body.enrollment, body.startsAt, body.endsAt)
    _validate_reg_window(body.enrollment, body.regOpensAt, body.regClosesAt)
    _validate_options(body.track, body.minBaselineUsd, body.minTrades)
    comp = Competition(
        name=body.name, description=body.description, metric=body.metric,
        enrollment=body.enrollment, reg_opens_at=body.regOpensAt,
        reg_closes_at=body.regClosesAt, starts_at=body.startsAt, ends_at=body.endsAt,
        prize_note=body.prizeNote, status="draft",
        track=body.track or "real",
        min_baseline_usd=body.minBaselineUsd, min_trades=body.minTrades,
    )
    db.add(comp)
    db.commit()
    db.refresh(comp)
    return _comp_out(comp, 0)


@admin_router.patch("/{comp_id}")
def admin_patch_competition(comp_id: str, body: CompetitionPatchIn, db: Session = Depends(get_db)):
    comp = _get_comp_or_404(db, comp_id)
    sent = body.model_fields_set
    field_sent = sent - {"status"}

    if comp.status != "draft" and (field_sent - _NON_DRAFT_ALLOWED):
        raise HTTPException(400, MSG_NON_DRAFT_FIELDS)

    if comp.status == "draft":
        metric = body.metric if "metric" in sent else comp.metric
        enrollment = body.enrollment if "enrollment" in sent else comp.enrollment
        starts_at = body.startsAt if "startsAt" in sent else comp.starts_at
        ends_at = body.endsAt if "endsAt" in sent else comp.ends_at
        reg_opens_at = body.regOpensAt if "regOpensAt" in sent else comp.reg_opens_at
        reg_closes_at = body.regClosesAt if "regClosesAt" in sent else comp.reg_closes_at
        _validate_core(metric, enrollment, starts_at, ends_at)
        _validate_reg_window(enrollment, reg_opens_at, reg_closes_at)
        _validate_options(body.track if "track" in sent else None,
                          body.minBaselineUsd if "minBaselineUsd" in sent else None,
                          body.minTrades if "minTrades" in sent else None)

        if "name" in sent:
            comp.name = body.name
        if "description" in sent:
            comp.description = body.description
        if "metric" in sent:
            comp.metric = body.metric
        if "enrollment" in sent:
            comp.enrollment = body.enrollment
        if "regOpensAt" in sent:
            comp.reg_opens_at = body.regOpensAt
        if "regClosesAt" in sent:
            comp.reg_closes_at = body.regClosesAt
        if "startsAt" in sent:
            comp.starts_at = body.startsAt
        if "endsAt" in sent:
            comp.ends_at = body.endsAt
        if "prizeNote" in sent:
            comp.prize_note = body.prizeNote
        if "track" in sent and body.track is not None:
            comp.track = body.track
        # 这两个显式传 null 表示"改回跟随全局"，与没传（不动）语义不同——用
        # model_fields_set 区分，同 ProfilePatchIn 的先例。
        # Sending null for these two means "go back to following the global
        # settings", which differs from omitting them (leave as is) —
        # distinguished via model_fields_set, matching ProfilePatchIn.
        if "minBaselineUsd" in sent:
            comp.min_baseline_usd = body.minBaselineUsd
        if "minTrades" in sent:
            comp.min_trades = body.minTrades
    else:
        if "regOpensAt" in sent or "regClosesAt" in sent:
            reg_opens_at = body.regOpensAt if "regOpensAt" in sent else comp.reg_opens_at
            reg_closes_at = body.regClosesAt if "regClosesAt" in sent else comp.reg_closes_at
            _validate_reg_window(comp.enrollment, reg_opens_at, reg_closes_at)
        if "name" in sent:
            comp.name = body.name
        if "description" in sent:
            comp.description = body.description
        if "prizeNote" in sent:
            comp.prize_note = body.prizeNote
        if "regOpensAt" in sent:
            comp.reg_opens_at = body.regOpensAt
        if "regClosesAt" in sent:
            comp.reg_closes_at = body.regClosesAt

    auto_enrolled = None
    if "status" in sent:
        new_status = body.status
        if _ADVANCE.get(comp.status) != new_status:
            raise HTTPException(400, MSG_STATUS_SEQUENCE)
        comp.status = new_status
        if new_status == "running" and comp.enrollment == "auto":
            auto_enrolled = auto_enroll(db, comp, datetime.now(timezone.utc))

    db.commit()
    db.refresh(comp)
    counts = _participant_counts(db, [comp.id])
    out = _comp_out(comp, counts.get(comp.id, 0))
    if auto_enrolled is not None:
        out["autoEnrolled"] = auto_enrolled
    return out


# 可删除的比赛状态：还没开赛、没有任何成绩与勋章产生的两档。
# 内测期曾放开到任何状态（2026-09-04），上线前收回（2026-09-05）：
#   · running/ended 删掉等于把参赛者正在争的名次抹掉；
#   · settled 删掉之后勋章收不回（user_badges 没有"哪场比赛发的"这一列），且卫冕王
#     看的是相邻两届，少一届会改变后续判定——删了就是一笔说不清的糊涂账。
# Deletable statuses: the two before anything has been scored or awarded. Was
# opened to every status for testing (2026-09-04) and closed again before launch:
# deleting a running/ended competition wipes ranks people are competing for, and
# deleting a settled one cannot revoke badges (no "which competition" column) and
# shifts the back-to-back judgement.
DELETABLE_STATUSES = frozenset({"draft", "upcoming"})
MSG_DELETE_LOCKED = (
    "只有草稿或未开始的比赛可以删除；已开赛的比赛请让它走完流程 / "
    "Only draft or upcoming competitions can be deleted; a started competition must run its course"
)


@admin_router.delete("/{comp_id}")
def admin_delete_competition(comp_id: str, db: Session = Depends(get_db)):
    """删除一场**尚未开赛**的比赛，连同它的参赛行、基线、榜单快照一起清掉。
    running / ended / settled 一律 400（见 DELETABLE_STATUSES 的说明）。
    Deletes a competition that has not started, with its participants, baselines
    and board snapshots. Started or settled competitions are refused (400).
    """
    comp = _get_comp_or_404(db, comp_id)
    if comp.status not in DELETABLE_STATUSES:
        raise HTTPException(400, MSG_DELETE_LOCKED)
    key = comp_period_key(comp.id)
    participants = (db.query(CompetitionParticipant)
                      .filter(CompetitionParticipant.competition_id == comp.id).delete())
    db.query(PeriodBaseline).filter(PeriodBaseline.period_key == key).delete()
    db.query(LeaderboardSnapshot).filter(LeaderboardSnapshot.period_key == key).delete()
    db.delete(comp)
    db.commit()
    return {"deleted": comp_id, "participants": participants}


@admin_router.get("/{comp_id}/participants")
def admin_list_participants(comp_id: str, db: Session = Depends(get_db)):
    _get_comp_or_404(db, comp_id)
    rows = (db.query(CompetitionParticipant, User.email)
              .join(User, User.id == CompetitionParticipant.user_id)
              .filter(CompetitionParticipant.competition_id == comp_id)
              .order_by(CompetitionParticipant.registered_at.asc()).all())
    return [_participant_out(p, email) for p, email in rows]


@admin_router.patch("/{comp_id}/participants/{participant_id}")
def admin_patch_participant(comp_id: str, participant_id: str,
                             body: CompetitionParticipantPatchIn,
                             db: Session = Depends(get_db),
                             admin: User = Depends(get_current_user)):
    comp = _get_comp_or_404(db, comp_id)
    if comp.status == "settled":
        raise HTTPException(400, MSG_SETTLED_FROZEN)
    participant = (db.query(CompetitionParticipant)
                     .filter(CompetitionParticipant.id == participant_id,
                             CompetitionParticipant.competition_id == comp_id).first())
    if participant is None:
        raise HTTPException(404, "参赛条目不存在 / Participant not found")

    # 审计的 old/new 把 disqualified 和 reason 拼进同一个字符串一起比较——
    # `_log_change` 在 old==new 时静默跳过写入，如果只传 disqualified 会漏掉
    # "已取消资格，仅改理由" 这种重新 PATCH（disqualified 前后都是 True，
    # reason 变了）：那种情况理应留痕，不能因为 disqualified 本身没变就被吞掉。
    #
    # The audit old/new packs disqualified and reason into one comparable
    # string. `_log_change` no-ops when old==new; comparing only `disqualified`
    # would silently drop a re-PATCH that only changes the reason on an
    # already-disqualified participant (disqualified stays True, reason
    # changes) — that should still leave an audit trail.
    old_state = f"{participant.disqualified}:{participant.disqualify_reason}"
    new_reason = body.disqualifyReason if body.disqualified else None
    new_state = f"{body.disqualified}:{new_reason}"
    participant.disqualified = body.disqualified
    participant.disqualify_reason = new_reason
    _log_change(db, admin.id, participant.user_id,
                f"competition:participant:{participant.id}:disqualified",
                old_state, new_state)
    db.commit()
    db.refresh(participant)
    email = db.query(User.email).filter(User.id == participant.user_id).scalar()
    return _participant_out(participant, email)


@admin_router.post("/{comp_id}/refresh")
def admin_refresh_competition(comp_id: str, db: Session = Depends(get_db)):
    """立即重算本场比赛的榜单快照，跳过节流。只对进行中的比赛有意义——未开始
    没有行，已结束/已终审的行不该再动，两种情况都返回 refreshed=false。
    Recompute this competition's board snapshot now, bypassing the throttle. Only
    meaningful while running: an upcoming competition has no rows and an
    ended/settled one's rows must not move, so both return refreshed=false."""
    comp = _get_comp_or_404(db, comp_id)
    refreshed = refresh_comp_board(db, comp, force=True)
    return {"refreshed": refreshed, "status": comp.status}


@admin_router.post("/{comp_id}/settle")
def admin_settle_competition(comp_id: str,
                              db: Session = Depends(get_db),
                              admin: User = Depends(get_current_user)):
    """终审。三道闸全部由 settle_competition 把守：状态必须是 ended、必须过了
    §5.3 的 24 小时宽限期、已终审的不能再跑。内测期曾有 `force=true` 跳过全部前置
    （2026-09-04），上线前已移除（2026-09-05）——早于实际结束时间终审会漏掉尚未
    平仓和迟到的单，名次一旦定格就是永久的，没有任何运营场景值得拿这个换。
    Settlement. All three gates live in settle_competition: status must be ended,
    the 24h grace period must have passed, and a settled competition cannot be
    re-run. A `force=true` bypass existed during the closed beta and was removed
    before launch: settling early drops still-open and late closes, and ranks are
    permanent once locked."""
    comp = _get_comp_or_404(db, comp_id)
    return settle_competition(db, comp, admin.id)


@admin_router.get("/{comp_id}/board")
def admin_competition_board(comp_id: str, db: Session = Depends(get_db),
                             admin: User = Depends(get_current_user)):
    """实时榜预览：读 `comp:<id>` 快照（`snapshot_competitions` 后台循环写入），
    行构造复用 `gamification.build_board_rows_payload`——它不做 period 格式
    校验，所以能直接吃 `comp:<id>` 这种不符合 `_PERIOD_KEY_RE` 的 key，用请求
    管理员本人作 viewer（isSelf/me 块对管理员而言没有实际业务意义，但保持
    与用户端榜单同一套负载形状，前端不用为管理端单独写一套渲染）。
    """
    comp = _get_comp_or_404(db, comp_id)
    refresh_comp_board(db, comp)
    return build_board_rows_payload(db, admin, comp.metric, comp_period_key(comp.id),
                                     gates_override=_comp_gates(db, comp))
