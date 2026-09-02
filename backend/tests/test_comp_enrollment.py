from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import (
    User, MT5Account, Competition, CompetitionParticipant, PeriodBaseline,
)
from app.services.gamification.competitions import (
    comp_period_key, register_participant, auto_enroll,
)
from app.services.gamification.boards import _aware

UTC = timezone.utc
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)
REG_OPENS = T0 - timedelta(days=3)
REG_CLOSES = T0 - timedelta(hours=1)
IN_WINDOW = REG_OPENS + timedelta(days=1)


def _user(db, email, opt_out=False):
    u = User(email=email, api_token="tok_" + email, leaderboard_opt_out=opt_out)
    db.add(u); db.commit(); return u


def _acct(db, u, login, balance=2000.0, tm=2, server="s"):
    a = MT5Account(user_id=u.id, login=login, server=server, balance=balance, trade_mode=tm)
    db.add(a); db.commit(); return a


def _comp(db, enrollment="signup", status="upcoming", starts_at=T0, ends_at=ENDS,
          reg_opens_at=REG_OPENS, reg_closes_at=REG_CLOSES, metric="return_pct",
          name="Comp A"):
    c = Competition(name=name, metric=metric, enrollment=enrollment, status=status,
                     starts_at=starts_at, ends_at=ends_at,
                     reg_opens_at=reg_opens_at, reg_closes_at=reg_closes_at)
    db.add(c); db.commit(); return c


# ---- register_participant ----------------------------------------------

def test_register_rejects_auto_enroll_competition(db_session):
    comp = _comp(db_session, enrollment="auto")
    u = _user(db_session, "auto1@t.co"); _acct(db_session, u, "A")
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "自动参赛" in exc.value.detail


def test_register_rejects_outside_window(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "win1@t.co"); _acct(db_session, u, "A")
    # 报名窗口已过（reg_closes_at 早于开赛）
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", REG_CLOSES + timedelta(minutes=1))
    assert exc.value.status_code == 400
    assert "报名窗口" in exc.value.detail

    with pytest.raises(HTTPException):
        register_participant(db_session, comp, u, "A", REG_OPENS - timedelta(minutes=1))


def test_register_rejects_missing_window_bounds(db_session):
    """报名窗口字段任一边缺失（None）：一律视为窗口未开放——不是「一直开放」。"""
    comp = _comp(db_session, reg_opens_at=None, reg_closes_at=None)
    u = _user(db_session, "win2@t.co"); _acct(db_session, u, "A")
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "报名窗口" in exc.value.detail

    comp2 = _comp(db_session, reg_opens_at=REG_OPENS, reg_closes_at=None, name="Comp B")
    with pytest.raises(HTTPException):
        register_participant(db_session, comp2, u, "A", IN_WINDOW)


def test_register_rejects_demo_account(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "demo1@t.co"); _acct(db_session, u, "A", tm=0)
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "实盘账户" in exc.value.detail


def test_register_rejects_other_users_account(db_session):
    comp = _comp(db_session)
    owner = _user(db_session, "owner1@t.co"); _acct(db_session, owner, "A")
    intruder = _user(db_session, "intruder1@t.co")
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, intruder, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "实盘账户" in exc.value.detail


def test_register_rejects_unsynced_balance(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "nobal1@t.co"); _acct(db_session, u, "A", balance=None)
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "余额未同步" in exc.value.detail


def test_register_success_writes_participant_and_baseline_scoring_from_start(db_session):
    """开赛前报名：scoring_from = comp.starts_at（max(starts_at, now) = starts_at）。"""
    comp = _comp(db_session)
    u = _user(db_session, "reg1@t.co"); _acct(db_session, u, "A", balance=1500.0)
    p = register_participant(db_session, comp, u, "A", IN_WINDOW)

    assert isinstance(p, CompetitionParticipant)
    assert p.competition_id == comp.id and p.mt5_login == "A" and p.user_id == u.id
    assert _aware(p.scoring_from) == _aware(comp.starts_at)

    baseline = db_session.query(PeriodBaseline).filter_by(
        period_key=comp_period_key(comp.id), user_id=u.id, mt5_login="A").first()
    assert baseline is not None
    assert baseline.baseline == 1500.0
    assert _aware(baseline.taken_at) == IN_WINDOW


def test_register_after_start_scoring_from_is_now(db_session):
    """报名窗口延伸到开赛之后：开赛后报名 → scoring_from = now（晚于 starts_at）。"""
    late_close = ENDS
    comp = _comp(db_session, status="running", reg_opens_at=REG_OPENS, reg_closes_at=late_close)
    u = _user(db_session, "reg2@t.co"); _acct(db_session, u, "A", balance=1500.0)
    after_start = _aware(comp.starts_at) + timedelta(hours=3)

    p = register_participant(db_session, comp, u, "A", after_start)
    assert _aware(p.scoring_from) == after_start


def test_register_duplicate_is_idempotent_returns_existing(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "dup1@t.co"); _acct(db_session, u, "A", balance=1500.0)

    p1 = register_participant(db_session, comp, u, "A", IN_WINDOW)
    p2 = register_participant(db_session, comp, u, "A", IN_WINDOW + timedelta(hours=1))

    assert p1.id == p2.id
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id, mt5_login="A").count() == 1
    assert db_session.query(PeriodBaseline).filter_by(
        period_key=comp_period_key(comp.id), user_id=u.id, mt5_login="A").count() == 1


# ---- auto_enroll ----------------------------------------------------------

def test_auto_enroll_enrolls_all_eligible_real_accounts(db_session):
    comp = _comp(db_session, enrollment="auto", status="running")
    u1 = _user(db_session, "ae1@t.co"); _acct(db_session, u1, "A", balance=2000.0)
    u2 = _user(db_session, "ae2@t.co"); _acct(db_session, u2, "B", balance=3000.0)

    count = auto_enroll(db_session, comp, T0)
    assert count == 2

    parts = {p.mt5_login: p for p in db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id)}
    assert set(parts) == {"A", "B"}
    for login, p in parts.items():
        assert _aware(p.scoring_from) == _aware(comp.starts_at)

    baselines = {b.mt5_login: b for b in db_session.query(PeriodBaseline).filter_by(
        period_key=comp_period_key(comp.id))}
    assert baselines["A"].baseline == 2000.0
    assert baselines["B"].baseline == 3000.0
    assert _aware(baselines["A"].taken_at) == T0


def test_auto_enroll_excludes_demo_and_unsynced_and_optout(db_session):
    comp = _comp(db_session, enrollment="auto", status="running")
    u_demo = _user(db_session, "demo2@t.co"); _acct(db_session, u_demo, "D", tm=0)
    u_nobal = _user(db_session, "nobal2@t.co"); _acct(db_session, u_nobal, "N", balance=None)
    u_optout = _user(db_session, "optout1@t.co", opt_out=True)
    _acct(db_session, u_optout, "O", balance=1000.0)
    u_ok = _user(db_session, "aeok@t.co"); _acct(db_session, u_ok, "K", balance=1000.0)

    count = auto_enroll(db_session, comp, T0)
    assert count == 1
    logins = {p.mt5_login for p in db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id)}
    assert logins == {"K"}


def test_auto_enroll_is_idempotent(db_session):
    comp = _comp(db_session, enrollment="auto", status="running")
    u = _user(db_session, "ae3@t.co"); _acct(db_session, u, "A", balance=2000.0)

    first = auto_enroll(db_session, comp, T0)
    second = auto_enroll(db_session, comp, T0 + timedelta(hours=1))

    assert first == 1
    assert second == 0
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id).count() == 1
    assert db_session.query(PeriodBaseline).filter_by(
        period_key=comp_period_key(comp.id)).count() == 1
