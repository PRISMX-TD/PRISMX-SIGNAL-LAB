"""比赛（设计 §1.7/§1.8/§1.9，Phase 3 Task 5）：管理端 CRUD/状态推进/参赛管理/终审。

用户端 `router`（报名/查看，Task 6 实现）与管理端 `admin_router`（本任务）拆成两个
router 是照 gamification.py 的先例——权限收口方式也一样：admin_router 本身不带
require_admin，在 main.py 的 include_router(..., dependencies=[Depends(require_admin)])
里统一挂上。
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Competition, CompetitionParticipant, User
from app.routers.admin import _log_change
from app.routers.gamification import build_board_rows_payload
from app.schemas import (
    CompetitionCreateIn, CompetitionParticipantPatchIn, CompetitionPatchIn)
from app.services.deps import get_current_user, get_db
from app.services.gamification.boards import _aware
from app.services.gamification.competitions import (
    auto_enroll, comp_period_key, settle_competition)

# ---- 用户端 / user-facing（Task 6 实现，本任务只建 router 对象供 main.py 挂载）----
router = APIRouter(prefix="/competitions", tags=["competitions"])


# ---- 管理员端 / admin endpoints ----
# 权限收口方式同 gamification.admin_router 先例：见模块docstring。
admin_router = APIRouter(prefix="/admin/competitions", tags=["admin"])

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
MSG_NON_DRAFT_FIELDS = "比赛开始后仅可修改文案与报名窗口 / Only copy and registration window are editable after draft"
MSG_STATUS_SEQUENCE = "状态只能按顺序推进 / Status can only advance sequentially"


def _validate_core(name: str, metric: str, enrollment: str,
                    starts_at: datetime | None, ends_at: datetime | None) -> None:
    if metric not in _METRICS:
        raise HTTPException(400, MSG_UNKNOWN_METRIC)
    if enrollment not in _ENROLLMENTS:
        raise HTTPException(400, MSG_UNKNOWN_ENROLLMENT)
    if starts_at is None or ends_at is None or not (_aware(starts_at) < _aware(ends_at)):
        raise HTTPException(400, MSG_START_BEFORE_END)


def _validate_reg_window(enrollment: str, reg_opens_at: datetime | None,
                          reg_closes_at: datetime | None) -> None:
    """signup 赛必须给两端且 opens<closes；报名窗口允许与比赛重叠（开赛后仍可
    补报名——scoring_from 兜住实际计分起点），所以这里不比对 starts_at。"""
    if enrollment != "signup":
        return
    if (reg_opens_at is None or reg_closes_at is None
            or not (_aware(reg_opens_at) < _aware(reg_closes_at))):
        raise HTTPException(400, MSG_SIGNUP_WINDOW)


def _comp_out(comp: Competition, participant_count: int) -> dict:
    return {
        "id": comp.id,
        "name": comp.name,
        "description": comp.description,
        "metric": comp.metric,
        "enrollment": comp.enrollment,
        "status": comp.status,
        "track": comp.track,
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
        raise HTTPException(404, "比赛不存在 / Competition not found")
    return comp


@admin_router.get("")
def admin_list_competitions(db: Session = Depends(get_db)):
    comps = db.query(Competition).order_by(Competition.created_at.desc()).all()
    counts = _participant_counts(db, [c.id for c in comps])
    return [_comp_out(c, counts.get(c.id, 0)) for c in comps]


@admin_router.post("")
def admin_create_competition(body: CompetitionCreateIn, db: Session = Depends(get_db)):
    _validate_core(body.name, body.metric, body.enrollment, body.startsAt, body.endsAt)
    _validate_reg_window(body.enrollment, body.regOpensAt, body.regClosesAt)
    comp = Competition(
        name=body.name, description=body.description, metric=body.metric,
        enrollment=body.enrollment, reg_opens_at=body.regOpensAt,
        reg_closes_at=body.regClosesAt, starts_at=body.startsAt, ends_at=body.endsAt,
        prize_note=body.prizeNote, status="draft",
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
        name = body.name if "name" in sent else comp.name
        metric = body.metric if "metric" in sent else comp.metric
        enrollment = body.enrollment if "enrollment" in sent else comp.enrollment
        starts_at = body.startsAt if "startsAt" in sent else comp.starts_at
        ends_at = body.endsAt if "endsAt" in sent else comp.ends_at
        reg_opens_at = body.regOpensAt if "regOpensAt" in sent else comp.reg_opens_at
        reg_closes_at = body.regClosesAt if "regClosesAt" in sent else comp.reg_closes_at
        _validate_core(name, metric, enrollment, starts_at, ends_at)
        _validate_reg_window(enrollment, reg_opens_at, reg_closes_at)

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
    _get_comp_or_404(db, comp_id)
    participant = (db.query(CompetitionParticipant)
                     .filter(CompetitionParticipant.id == participant_id,
                             CompetitionParticipant.competition_id == comp_id).first())
    if participant is None:
        raise HTTPException(404, "参赛条目不存在 / Participant not found")

    old = participant.disqualified
    participant.disqualified = body.disqualified
    participant.disqualify_reason = body.disqualifyReason if body.disqualified else None
    _log_change(db, admin.id, participant.user_id,
                f"competition:participant:{participant.id}:disqualified",
                old, body.disqualified)
    db.commit()
    db.refresh(participant)
    email = db.query(User.email).filter(User.id == participant.user_id).scalar()
    return _participant_out(participant, email)


@admin_router.post("/{comp_id}/settle")
def admin_settle_competition(comp_id: str, db: Session = Depends(get_db),
                              admin: User = Depends(get_current_user)):
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
    return build_board_rows_payload(db, admin, comp.metric, comp_period_key(comp.id))
