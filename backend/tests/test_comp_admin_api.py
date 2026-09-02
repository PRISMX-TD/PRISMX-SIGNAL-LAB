from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, Competition, CompetitionParticipant, MT5Account, User
from app.routers.competitions import (
    admin_competition_board, admin_create_competition, admin_list_competitions,
    admin_list_participants, admin_patch_competition, admin_patch_participant,
    admin_settle_competition,
)
from app.schemas import (
    CompetitionCreateIn, CompetitionParticipantPatchIn, CompetitionPatchIn,
)
from app.services.gamification.competitions import comp_period_key

UTC = timezone.utc
T0 = datetime(2026, 9, 1, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)
REG_OPENS = T0 - timedelta(days=3)
REG_CLOSES = T0 - timedelta(hours=1)


def _admin(db, email="admin@t.co"):
    a = User(email=email, api_token="tok_" + email, role="admin")
    db.add(a); db.commit(); return a


def _user(db, email):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


def _acct(db, u, login, balance=2000.0, tm=2):
    a = MT5Account(user_id=u.id, login=login, server="s", balance=balance, trade_mode=tm)
    db.add(a); db.commit(); return a


def _comp(db, enrollment="signup", status="draft", starts_at=T0, ends_at=ENDS,
          reg_opens_at=REG_OPENS, reg_closes_at=REG_CLOSES, metric="return_pct",
          name="Comp A", created_at=None):
    c = Competition(name=name, metric=metric, enrollment=enrollment, status=status,
                     starts_at=starts_at, ends_at=ends_at,
                     reg_opens_at=reg_opens_at, reg_closes_at=reg_closes_at)
    if created_at is not None:
        c.created_at = created_at
    db.add(c); db.commit(); return c


def _participant(db, comp, u, login, disqualified=False):
    p = CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login,
                               disqualified=disqualified)
    db.add(p); db.commit(); return p


def _create_body(**overrides):
    defaults = dict(name="New Comp", description=None, metric="return_pct",
                     enrollment="signup", regOpensAt=REG_OPENS, regClosesAt=REG_CLOSES,
                     startsAt=T0, endsAt=ENDS, prizeNote=None)
    defaults.update(overrides)
    return CompetitionCreateIn(**defaults)


# ---- GET "" -----------------------------------------------------------------

def test_list_returns_all_statuses_newest_first_with_participant_count(db_session):
    # created_at 是 Python 侧 default（models._now），显式给两个不同的值而不是
    # 靠 time.sleep 制造时间差——后者在快机器上可能因为分辨率不够而两次
    # created_at 相同，排序断言变得脆弱。
    c1 = _comp(db_session, status="draft", name="Older", created_at=T0 - timedelta(hours=1))
    c2 = _comp(db_session, status="running", name="Newer", created_at=T0)
    u = _user(db_session, "p1@t.co")
    _participant(db_session, c2, u, "A")

    rows = admin_list_competitions(db=db_session)

    assert [r["id"] for r in rows] == [c2.id, c1.id]
    by_id = {r["id"]: r for r in rows}
    assert by_id[c2.id]["participantCount"] == 1
    assert by_id[c1.id]["participantCount"] == 0
    assert by_id[c1.id]["status"] == "draft"
    row = by_id[c2.id]
    assert set(["id", "name", "description", "metric", "enrollment", "status", "track",
                "regOpensAt", "regClosesAt", "startsAt", "endsAt", "prizeNote",
                "createdAt", "participantCount"]).issubset(row.keys())


# ---- POST "" ------------------------------------------------------------------

def test_create_success_defaults_to_draft(db_session):
    out = admin_create_competition(_create_body(), db=db_session)
    assert out["status"] == "draft"
    assert out["name"] == "New Comp"
    assert out["participantCount"] == 0


def test_create_rejects_unknown_metric(db_session):
    with pytest.raises(HTTPException) as exc:
        admin_create_competition(_create_body(metric="bogus"), db=db_session)
    assert exc.value.status_code == 400


def test_create_rejects_unknown_enrollment(db_session):
    with pytest.raises(HTTPException) as exc:
        admin_create_competition(_create_body(enrollment="bogus"), db=db_session)
    assert exc.value.status_code == 400


def test_create_rejects_start_after_end(db_session):
    with pytest.raises(HTTPException) as exc:
        admin_create_competition(_create_body(startsAt=ENDS, endsAt=T0), db=db_session)
    assert exc.value.status_code == 400
    assert "开赛时间需早于结束时间" in exc.value.detail


def test_create_signup_requires_registration_window(db_session):
    with pytest.raises(HTTPException) as exc:
        admin_create_competition(
            _create_body(enrollment="signup", regOpensAt=None, regClosesAt=None), db=db_session)
    assert exc.value.status_code == 400
    assert "报名窗口" in exc.value.detail

    with pytest.raises(HTTPException):
        admin_create_competition(
            _create_body(enrollment="signup", regOpensAt=REG_CLOSES, regClosesAt=REG_OPENS),
            db=db_session)


def test_create_auto_enrollment_does_not_require_window(db_session):
    out = admin_create_competition(
        _create_body(enrollment="auto", regOpensAt=None, regClosesAt=None), db=db_session)
    assert out["enrollment"] == "auto"


# ---- PATCH "/{id}" — draft field edits ---------------------------------------

def test_patch_draft_can_edit_all_fields(db_session):
    comp = _comp(db_session, status="draft")
    out = admin_patch_competition(
        comp.id, CompetitionPatchIn(name="Renamed", metric="win_rate"), db=db_session)
    assert out["name"] == "Renamed"
    assert out["metric"] == "win_rate"


def test_patch_draft_reruns_creation_style_validation(db_session):
    comp = _comp(db_session, status="draft")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(comp.id, CompetitionPatchIn(metric="bogus"), db=db_session)
    assert exc.value.status_code == 400


def test_patch_draft_signup_window_violation_rejected(db_session):
    comp = _comp(db_session, status="draft", enrollment="signup")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(
            comp.id, CompetitionPatchIn(regOpensAt=None, regClosesAt=None), db=db_session)
    assert exc.value.status_code == 400
    assert "报名窗口" in exc.value.detail


# ---- PATCH "/{id}" — non-draft field restriction -----------------------------

def test_patch_non_draft_allows_copy_and_window_fields(db_session):
    comp = _comp(db_session, status="upcoming")
    out = admin_patch_competition(
        comp.id, CompetitionPatchIn(description="new desc", prizeNote="$100"), db=db_session)
    assert out["description"] == "new desc"
    assert out["prizeNote"] == "$100"


def test_patch_non_draft_rejects_metric_change(db_session):
    comp = _comp(db_session, status="upcoming")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(comp.id, CompetitionPatchIn(metric="win_rate"), db=db_session)
    assert exc.value.status_code == 400
    assert "仅可修改文案与报名窗口" in exc.value.detail


def test_patch_non_draft_window_invalid_order_rejected(db_session):
    """报名窗口字段本身在非 draft 状态可改，但改出的结果仍要 opens<closes——
    「文案与报名窗口可改」不等于「怎么改都行」。"""
    comp = _comp(db_session, status="upcoming", enrollment="signup")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(
            comp.id, CompetitionPatchIn(regOpensAt=REG_CLOSES, regClosesAt=REG_OPENS),
            db=db_session)
    assert exc.value.status_code == 400
    assert "报名窗口" in exc.value.detail


def test_patch_non_draft_rejects_starts_ends_change(db_session):
    comp = _comp(db_session, status="running")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(
            comp.id, CompetitionPatchIn(startsAt=T0 + timedelta(days=1)), db=db_session)
    assert exc.value.status_code == 400


# ---- PATCH "/{id}" — status transitions --------------------------------------

def test_patch_status_advances_one_step_at_a_time(db_session):
    comp = _comp(db_session, status="draft")
    out = admin_patch_competition(comp.id, CompetitionPatchIn(status="upcoming"), db=db_session)
    assert out["status"] == "upcoming"
    out = admin_patch_competition(comp.id, CompetitionPatchIn(status="running"), db=db_session)
    assert out["status"] == "running"
    out = admin_patch_competition(comp.id, CompetitionPatchIn(status="ended"), db=db_session)
    assert out["status"] == "ended"


def test_patch_status_rejects_skip(db_session):
    comp = _comp(db_session, status="draft")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(comp.id, CompetitionPatchIn(status="running"), db=db_session)
    assert exc.value.status_code == 400
    assert "状态只能按顺序推进" in exc.value.detail
    assert comp.status == "draft"


def test_patch_status_rejects_backward(db_session):
    comp = _comp(db_session, status="running")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(comp.id, CompetitionPatchIn(status="upcoming"), db=db_session)
    assert exc.value.status_code == 400


def test_patch_status_rejects_direct_settled(db_session):
    comp = _comp(db_session, status="ended")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(comp.id, CompetitionPatchIn(status="settled"), db=db_session)
    assert exc.value.status_code == 400
    assert comp.status == "ended"


def test_patch_status_rejects_same_status_noop(db_session):
    comp = _comp(db_session, status="draft")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(comp.id, CompetitionPatchIn(status="draft"), db=db_session)
    assert exc.value.status_code == 400


# ---- PATCH "/{id}" — auto_enroll on advance to running -----------------------

def test_patch_advance_to_running_auto_enrollment_triggers_auto_enroll(db_session):
    comp = _comp(db_session, status="upcoming", enrollment="auto")
    u1 = _user(db_session, "ae1@t.co"); _acct(db_session, u1, "A", balance=2000.0)
    u2 = _user(db_session, "ae2@t.co"); _acct(db_session, u2, "B", balance=3000.0)

    out = admin_patch_competition(comp.id, CompetitionPatchIn(status="running"), db=db_session)

    assert out["status"] == "running"
    assert out["autoEnrolled"] == 2
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id).count() == 2


def test_patch_advance_to_running_signup_competition_no_auto_enroll_key(db_session):
    comp = _comp(db_session, status="upcoming", enrollment="signup")
    out = admin_patch_competition(comp.id, CompetitionPatchIn(status="running"), db=db_session)
    assert out["status"] == "running"
    assert "autoEnrolled" not in out


def test_patch_advance_to_running_is_not_refired_on_later_patches(db_session):
    """auto_enroll 只在跨过 draft/upcoming→running 那一步触发一次；running 状态下
    后续的文案 PATCH 不该再次批量拉入参赛。"""
    comp = _comp(db_session, status="upcoming", enrollment="auto")
    u1 = _user(db_session, "ae3@t.co"); _acct(db_session, u1, "A", balance=1000.0)
    admin_patch_competition(comp.id, CompetitionPatchIn(status="running"), db=db_session)
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id).count() == 1

    u2 = _user(db_session, "ae4@t.co"); _acct(db_session, u2, "B", balance=1000.0)
    out = admin_patch_competition(
        comp.id, CompetitionPatchIn(description="tweak"), db=db_session)

    assert "autoEnrolled" not in out
    # 新账户没被本次文案 PATCH 拉入
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id).count() == 1


def test_patch_combined_status_and_allowed_field_both_applied(db_session):
    """upcoming + {status:"running", prizeNote:"x"}：status 推进合法（相邻一步），
    prizeNote 在非 draft 白名单内——两处改动都该生效。"""
    comp = _comp(db_session, status="upcoming", enrollment="signup")
    out = admin_patch_competition(
        comp.id, CompetitionPatchIn(status="running", prizeNote="x"), db=db_session)
    assert out["status"] == "running"
    assert out["prizeNote"] == "x"
    db_session.refresh(comp)
    assert comp.status == "running" and comp.prize_note == "x"


def test_patch_combined_status_and_disallowed_field_rejects_without_mutating(db_session):
    """upcoming + {status:"running", metric:"win_rate"}：metric 不在非 draft
    白名单内——整体 400，且 status 完全没被改动（校验先于任何写入）。"""
    comp = _comp(db_session, status="upcoming", enrollment="signup")
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition(
            comp.id, CompetitionPatchIn(status="running", metric="win_rate"), db=db_session)
    assert exc.value.status_code == 400

    db_session.expire(comp)
    reloaded = db_session.get(Competition, comp.id)
    assert reloaded.status == "upcoming"
    assert reloaded.metric == "return_pct"


def test_patch_404_when_missing(db_session):
    with pytest.raises(HTTPException) as exc:
        admin_patch_competition("nope", CompetitionPatchIn(name="x"), db=db_session)
    assert exc.value.status_code == 404


# ---- GET "/{id}/participants" ------------------------------------------------

def test_list_participants_includes_email(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "part1@t.co")
    _participant(db_session, comp, u, "A")

    rows = admin_list_participants(comp.id, db=db_session)

    assert len(rows) == 1
    assert rows[0]["email"] == "part1@t.co"
    assert rows[0]["login"] == "A"
    assert rows[0]["disqualified"] is False


def test_list_participants_404_when_comp_missing(db_session):
    with pytest.raises(HTTPException) as exc:
        admin_list_participants("nope", db=db_session)
    assert exc.value.status_code == 404


# ---- PATCH "/{id}/participants/{pid}" ----------------------------------------

def test_disqualify_participant_writes_row_and_audit(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "dq1@t.co")
    p = _participant(db_session, comp, u, "A")

    out = admin_patch_participant(
        comp.id, p.id, CompetitionParticipantPatchIn(disqualified=True, disqualifyReason="cheat"),
        db=db_session, admin=admin)

    assert out["disqualified"] is True
    assert out["disqualifyReason"] == "cheat"
    db_session.refresh(p)
    assert p.disqualified is True and p.disqualify_reason == "cheat"

    rows = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == f"competition:participant:{p.id}:disqualified").all()
    assert len(rows) == 1
    assert rows[0].admin_user_id == admin.id
    assert rows[0].target_user_id == u.id


def test_requalify_participant_clears_reason(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "dq2@t.co")
    p = _participant(db_session, comp, u, "A", disqualified=True)
    p.disqualify_reason = "old reason"
    db_session.commit()

    out = admin_patch_participant(
        comp.id, p.id, CompetitionParticipantPatchIn(disqualified=False),
        db=db_session, admin=admin)

    assert out["disqualified"] is False
    assert out["disqualifyReason"] is None


def test_reason_only_change_on_already_disqualified_participant_is_audited(db_session):
    """disqualified 前后都是 True，只有 reason 变了：_log_change 单看
    disqualified 会判定 old==new 而静默跳过——审计行必须仍然写入。"""
    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "dq3@t.co")
    p = _participant(db_session, comp, u, "A", disqualified=True)
    p.disqualify_reason = "old reason"
    db_session.commit()

    out = admin_patch_participant(
        comp.id, p.id, CompetitionParticipantPatchIn(disqualified=True, disqualifyReason="new reason"),
        db=db_session, admin=admin)

    assert out["disqualified"] is True
    assert out["disqualifyReason"] == "new reason"

    rows = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == f"competition:participant:{p.id}:disqualified").all()
    assert len(rows) == 1
    assert "old reason" in rows[0].old_value
    assert "new reason" in rows[0].new_value


def test_patch_participant_rejects_settled_competition(db_session):
    """终审后比赛冻结：参赛状态（取消/恢复资格）不可再改，哪怕参赛条目本身还在。"""
    admin = _admin(db_session)
    comp = _comp(db_session, status="settled")
    u = _user(db_session, "frozen1@t.co")
    p = _participant(db_session, comp, u, "A")

    with pytest.raises(HTTPException) as exc:
        admin_patch_participant(
            comp.id, p.id, CompetitionParticipantPatchIn(disqualified=True, disqualifyReason="x"),
            db=db_session, admin=admin)
    assert exc.value.status_code == 400
    assert "已终审" in exc.value.detail
    db_session.refresh(p)
    assert p.disqualified is False                     # 未被改动


def test_patch_participant_404_when_missing(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session)
    with pytest.raises(HTTPException) as exc:
        admin_patch_participant(
            comp.id, "nope", CompetitionParticipantPatchIn(disqualified=True),
            db=db_session, admin=admin)
    assert exc.value.status_code == 404


# ---- POST "/{id}/settle" -------------------------------------------------------

def test_settle_endpoint_calls_through(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session, status="ended")
    result = admin_settle_competition(comp.id, db=db_session, admin=admin)
    assert result["ranked"] == 0
    db_session.refresh(comp)
    assert comp.status == "settled"


def test_settle_endpoint_404_when_missing(db_session):
    admin = _admin(db_session)
    with pytest.raises(HTTPException) as exc:
        admin_settle_competition("nope", db=db_session, admin=admin)
    assert exc.value.status_code == 404


def test_settle_endpoint_propagates_service_400(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session, status="draft")
    with pytest.raises(HTTPException) as exc:
        admin_settle_competition(comp.id, db=db_session, admin=admin)
    assert exc.value.status_code == 400


# ---- GET "/{id}/board" ----------------------------------------------------------

def test_board_reads_snapshot_rows(db_session):
    from app.models import LeaderboardSnapshot

    admin = _admin(db_session)
    comp = _comp(db_session, status="running")
    u = _user(db_session, "board1@t.co")
    db_session.add(LeaderboardSnapshot(board=comp.metric, period_key=comp_period_key(comp.id),
                                       user_id=u.id, mt5_login="A", rank=1,
                                       score=0.2, sample=10))
    db_session.commit()

    out = admin_competition_board(comp.id, db=db_session, admin=admin)

    assert out["board"] == comp.metric
    assert out["periodKey"] == comp_period_key(comp.id)
    assert len(out["rows"]) == 1
    assert out["rows"][0]["login"] == "A"


def test_board_404_when_comp_missing(db_session):
    admin = _admin(db_session)
    with pytest.raises(HTTPException) as exc:
        admin_competition_board("nope", db=db_session, admin=admin)
    assert exc.value.status_code == 404
