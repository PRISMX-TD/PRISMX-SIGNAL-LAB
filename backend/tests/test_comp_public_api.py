from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.core import rate_limit
from app.models import Competition, CompetitionParticipant, LeaderboardSnapshot, MT5Account, User
from app.routers.account import get_account
from app.routers.competitions import (
    _check_competitions_visible, get_competition, list_competitions,
    register_for_competition,
)
from app.schemas import CompetitionRegisterIn
from app.services.gamification.competitions import comp_period_key
from app.services.settings_store import invalidate_gamification_cache, save_gamification_settings


@pytest.fixture(autouse=True)
def _disable_rate_limiter(monkeypatch):
    """`register_for_competition` 挂了 `@limiter.limit`，直接函数调用（本文件的
    direct-function-call 约定）传 `request=None`——同 test_gateway_binding_revoke.py
    的先例，绕开 slowapi 对 `request` 类型的校验，不测限流本身（限流值本身没有
    业务逻辑好测，装饰器接的是现成的 settings.RATE_LIMIT_COMPETITION）。"""
    monkeypatch.setattr(rate_limit.limiter, "enabled", False)

UTC = timezone.utc
T0 = datetime(2026, 9, 1, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)
REG_OPENS = T0 - timedelta(days=3)
REG_CLOSES = T0 - timedelta(hours=1)
IN_WINDOW = REG_OPENS + timedelta(days=1)


def _user(db, email, role="user"):
    u = User(email=email, api_token="tok_" + email, role=role)
    db.add(u); db.commit(); return u


def _acct(db, u, login, balance=2000.0, tm=2):
    a = MT5Account(user_id=u.id, login=login, server="s", balance=balance, trade_mode=tm)
    db.add(a); db.commit(); return a


def _comp(db, enrollment="signup", status="upcoming", starts_at=T0, ends_at=ENDS,
          reg_opens_at=REG_OPENS, reg_closes_at=REG_CLOSES, metric="return_pct",
          name="Comp A"):
    c = Competition(name=name, metric=metric, enrollment=enrollment, status=status,
                     starts_at=starts_at, ends_at=ends_at,
                     reg_opens_at=reg_opens_at, reg_closes_at=reg_closes_at)
    db.add(c); db.commit(); return c


def _make_visible(db):
    save_gamification_settings(db, {"competitions_visible": True})
    db.commit(); invalidate_gamification_cache()


# ---- gate / admin bypass / switch flip --------------------------------------

def test_gate_and_admin_bypass_and_switch_flip(db_session):
    invalidate_gamification_cache()
    u = _user(db_session, "g1@t.co")
    with pytest.raises(HTTPException) as exc:
        _check_competitions_visible(db_session, u)
    assert exc.value.status_code == 403
    assert exc.value.detail == "比赛内测中，暂未开放 / Competitions in beta, not yet available"

    admin = _user(db_session, "ga@t.co", role="admin")
    _check_competitions_visible(db_session, admin)  # 不抛

    save_gamification_settings(db_session, {"competitions_visible": True})
    db_session.commit(); invalidate_gamification_cache()
    _check_competitions_visible(db_session, u)       # 开关开了，普通用户也不抛
    invalidate_gamification_cache()


# ---- GET "" -------------------------------------------------------------------

def test_list_groups_by_status_excludes_draft_and_orders_correctly(db_session):
    _make_visible(db_session)
    u = _user(db_session, "list1@t.co")
    _comp(db_session, status="draft", name="Draft")
    up_near = _comp(db_session, status="upcoming", starts_at=T0 + timedelta(days=1), name="UpNear")
    up_far = _comp(db_session, status="upcoming", starts_at=T0 + timedelta(days=5), name="UpFar")
    run_old = _comp(db_session, status="running", starts_at=T0 - timedelta(days=10), name="RunOld")
    run_new = _comp(db_session, status="running", starts_at=T0 - timedelta(days=1), name="RunNew")
    ended_old = _comp(db_session, status="ended", starts_at=T0 - timedelta(days=30), name="EndedOld")
    settled_new = _comp(db_session, status="settled", starts_at=T0 - timedelta(days=20), name="SettledNew")

    out = list_competitions(db=db_session, user=u)

    assert [c["name"] for c in out["upcoming"]] == ["UpNear", "UpFar"]
    assert [c["name"] for c in out["running"]] == ["RunNew", "RunOld"]
    assert [c["name"] for c in out["finished"]] == ["SettledNew", "EndedOld"]
    all_ids = {c["id"] for group in out.values() for c in group}
    assert all("Draft" != c["name"] for group in out.values() for c in group)
    row = out["upcoming"][0]
    assert set(["id", "name", "description", "metric", "enrollment", "status",
                "regOpensAt", "regClosesAt", "startsAt", "endsAt", "prizeNote"]).issubset(row.keys())
    assert "participantCount" not in row


# 门禁本身只在 `require_competitions_visible` 里发生——直接调用端点函数（本文件
# 的 direct-function-call 约定）绕过了 FastAPI 的 Depends 解析，`user=` 参数是
# 直接塞进去的，所以「传一个开关关闭状态下的普通用户」不会触发 403。门禁行为
# 由上面 test_gate_and_admin_bypass_and_switch_flip 覆盖（同 leaderboard 先例：
# 见 test_leaderboard_api.test_gate_and_admin_bypass）。


# ---- GET "/{id}" ----------------------------------------------------------------

def test_detail_404_for_missing_and_draft(db_session):
    _make_visible(db_session)
    u = _user(db_session, "det1@t.co")
    with pytest.raises(HTTPException) as exc:
        get_competition("nope", db=db_session, user=u)
    assert exc.value.status_code == 404
    assert exc.value.detail == "比赛不存在 / Competition not found"

    draft = _comp(db_session, status="draft")
    with pytest.raises(HTTPException) as exc2:
        get_competition(draft.id, db=db_session, user=u)
    assert exc2.value.status_code == 404


def test_detail_board_rows_no_user_id_and_isself(db_session):
    _make_visible(db_session)
    comp = _comp(db_session, status="running")
    viewer = _user(db_session, "det2@t.co")
    other = _user(db_session, "det3@t.co")
    db_session.add(LeaderboardSnapshot(board=comp.metric, period_key=comp_period_key(comp.id),
                                       user_id=viewer.id, mt5_login="A", rank=1,
                                       score=0.2, sample=10))
    db_session.add(LeaderboardSnapshot(board=comp.metric, period_key=comp_period_key(comp.id),
                                       user_id=other.id, mt5_login="B", rank=2,
                                       score=0.1, sample=10))
    db_session.commit()

    out = get_competition(comp.id, db=db_session, user=viewer)

    assert out["board"]["board"] == comp.metric
    assert out["board"]["periodKey"] == comp_period_key(comp.id)
    rows = out["board"]["rows"]
    assert len(rows) == 2
    assert all("userId" not in r for r in rows)
    by_login = {r["login"]: r for r in rows}
    assert by_login["A"]["isSelf"] is True
    assert by_login["B"]["isSelf"] is False
    assert out["board"]["me"]["rank"] == 1


def test_detail_upcoming_has_empty_board_rows(db_session):
    """upcoming 比赛还没有任何快照——榜必须能正常返回空行，而不是报错。"""
    _make_visible(db_session)
    comp = _comp(db_session, status="upcoming")
    u = _user(db_session, "det4@t.co")

    out = get_competition(comp.id, db=db_session, user=u)

    assert out["board"]["rows"] == []
    assert out["board"]["me"] is None
    assert out["myEntries"] == []
    assert out["pendingSettle"] is False


def test_detail_myentries_shape_and_pending_settle(db_session):
    comp_ended = _comp(db_session, status="ended", name="EndedOne")
    _make_visible(db_session)
    u = _user(db_session, "det5@t.co")
    p = CompetitionParticipant(competition_id=comp_ended.id, user_id=u.id, mt5_login="A",
                               scoring_from=T0, final_rank=2, final_score=0.15,
                               disqualified=False)
    db_session.add(p); db_session.commit(); db_session.refresh(p)

    out = get_competition(comp_ended.id, db=db_session, user=u)

    assert out["pendingSettle"] is True
    assert out["myEntries"] == [{
        "login": "A", "scoringFrom": p.scoring_from.isoformat(), "finalRank": 2,
        "finalScore": 0.15, "disqualified": False,
    }]


def test_detail_settled_board_matches_final_ranks(db_session):
    """settled 后榜（快照）即终榜——快照本身在终审时就已经是最终名次的来源，
    这里验证详情接口读到的仍是那份快照，未被重新计算或篡改。"""
    _make_visible(db_session)
    comp = _comp(db_session, status="settled", name="SettledOne")
    u = _user(db_session, "det6@t.co")
    db_session.add(LeaderboardSnapshot(board=comp.metric, period_key=comp_period_key(comp.id),
                                       user_id=u.id, mt5_login="A", rank=1,
                                       score=0.3, sample=12))
    db_session.commit()

    out = get_competition(comp.id, db=db_session, user=u)

    assert out["pendingSettle"] is False
    assert out["board"]["rows"][0]["rank"] == 1
    assert out["board"]["rows"][0]["login"] == "A"


# ---- POST "/{id}/register" -----------------------------------------------------

def test_register_through_and_idempotent(db_session):
    """路由内部用真实 `datetime.now(UTC)` 喂给 `register_participant`（同该服务
    函数在 admin 端 auto_enroll 触发路径上的用法），报名窗口得围着真实当下开，
    不能沿用模块级的历史 T0 常量。"""
    _make_visible(db_session)
    now = datetime.now(UTC)
    comp = _comp(db_session, status="upcoming", starts_at=now - timedelta(days=1),
                 ends_at=now + timedelta(days=7),
                 reg_opens_at=now - timedelta(hours=1), reg_closes_at=now + timedelta(hours=1))
    u = _user(db_session, "reg1@t.co")
    _acct(db_session, u, "1001", balance=1500.0)

    out1 = register_for_competition(
        request=None, comp_id=comp.id, body=CompetitionRegisterIn(mt5Login="1001"),
        db=db_session, user=u)
    assert out1["login"] == "1001"
    assert out1["scoringFrom"] is not None
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id, mt5_login="1001").count() == 1

    # 幂等：重复报名回退到已有条目，不会二次插入
    out2 = register_for_competition(
        request=None, comp_id=comp.id, body=CompetitionRegisterIn(mt5Login="1001"),
        db=db_session, user=u)
    assert out2["login"] == "1001"
    assert out2["scoringFrom"] == out1["scoringFrom"]
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id, mt5_login="1001").count() == 1


def test_register_404_for_missing_and_draft(db_session):
    _make_visible(db_session)
    u = _user(db_session, "reg2@t.co")
    with pytest.raises(HTTPException) as exc:
        register_for_competition(
            request=None, comp_id="nope", body=CompetitionRegisterIn(mt5Login="1001"),
            db=db_session, user=u)
    assert exc.value.status_code == 404

    draft = _comp(db_session, status="draft")
    with pytest.raises(HTTPException) as exc2:
        register_for_competition(
            request=None, comp_id=draft.id, body=CompetitionRegisterIn(mt5Login="1001"),
            db=db_session, user=u)
    assert exc2.value.status_code == 404


def test_register_propagates_service_validation_error(db_session):
    """报名窗口以外的时间发起 —— 直接看到 `register_participant` 的 400，路由
    层不吞、不改写这条错误。"""
    _make_visible(db_session)
    comp = _comp(db_session, status="draft", reg_opens_at=None, reg_closes_at=None)
    comp.status = "upcoming"
    db_session.commit()
    u = _user(db_session, "reg3@t.co")
    _acct(db_session, u, "1001")
    with pytest.raises(HTTPException) as exc:
        register_for_competition(
            request=None, comp_id=comp.id, body=CompetitionRegisterIn(mt5Login="1001"),
            db=db_session, user=u)
    assert exc.value.status_code == 400
    assert "报名窗口" in exc.value.detail


# ---- /auth/me competitionsVisible ------------------------------------------------

def test_account_me_exposes_competitions_visible(db_session):
    invalidate_gamification_cache()
    u = _user(db_session, "acct1@t.co")
    out = get_account(db=db_session, current_user=u)
    assert out.competitionsVisible is False

    save_gamification_settings(db_session, {"competitions_visible": True})
    db_session.commit(); invalidate_gamification_cache()
    out2 = get_account(db=db_session, current_user=u)
    assert out2.competitionsVisible is True

    admin = _user(db_session, "acct2@t.co", role="admin")
    invalidate_gamification_cache()
    save_gamification_settings(db_session, {"competitions_visible": False})
    db_session.commit(); invalidate_gamification_cache()
    out3 = get_account(db=db_session, current_user=admin)
    assert out3.competitionsVisible is True
    invalidate_gamification_cache()
