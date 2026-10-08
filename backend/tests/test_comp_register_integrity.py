"""报名完整性（设计 2026-10-08 §1.11–§1.13）：只收本人直连、未撤销、未软删的账户；
同 login 还挂着桥接行不收；撞号 409；报名时经网关实时核资（A4）。"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import Competition, CompetitionParticipant, MT5Account, PeriodBaseline, User
from app.services.gamification import competitions as comp_mod
from app.services.gamification.competitions import comp_period_key, register_participant
from app.services.gateway_binding import REASON_PASSWORD_CHANGED, REASON_USER_REMOVED

UTC = timezone.utc
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)
REG_OPENS = T0 - timedelta(days=3)
REG_CLOSES = T0 - timedelta(hours=1)
IN_WINDOW = REG_OPENS + timedelta(days=1)


@pytest.fixture(autouse=True)
def live_funds(monkeypatch):
    """实时资金桩：默认 = 库里的余额 / 净值；用例往返回的 dict 里按 login 塞值即可覆盖，
    塞一个异常实例则抛出它。raising=False：A3 时 read_live_funds 还不存在。
    Live-funds stub: defaults to the stored balance/equity; tests override per login."""
    state: dict = {}

    def fake(acct):
        v = state.get(acct.login)
        if isinstance(v, Exception):
            raise v
        if v is not None:
            return v
        return (float(acct.balance),
                float(acct.equity if acct.equity is not None else acct.balance))

    monkeypatch.setattr(comp_mod, "read_live_funds", fake, raising=False)
    return state


def _user(db, email):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


def _acct(db, u, login, source="gateway", balance=2000.0, tm=2, **kw):
    a = MT5Account(user_id=u.id, login=login, server="" if source == "gateway" else "s",
                   source=source, balance=balance, trade_mode=tm, **kw)
    db.add(a); db.commit(); return a


def _comp(db, track="real"):
    c = Competition(name="C", metric="return_pct", enrollment="signup", status="upcoming",
                    track=track, starts_at=T0, ends_at=ENDS,
                    reg_opens_at=REG_OPENS, reg_closes_at=REG_CLOSES)
    db.add(c); db.commit(); return c


def test_bridge_only_account_is_rejected(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "br@t.co"); _acct(db_session, u, "A", source="bridge")
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "直连" in exc.value.detail
    assert db_session.query(CompetitionParticipant).count() == 0


def test_gateway_plus_live_bridge_row_same_login_is_rejected(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "dup@t.co")
    _acct(db_session, u, "A", source="gateway")
    _acct(db_session, u, "A", source="bridge")
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "桥接" in exc.value.detail


def test_removed_bridge_row_does_not_block(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "rm@t.co")
    _acct(db_session, u, "A", source="gateway")
    _acct(db_session, u, "A", source="bridge", revoked_at=T0, revoked_reason=REASON_USER_REMOVED)
    assert register_participant(db_session, comp, u, "A", IN_WINDOW).mt5_login == "A"


def test_revoked_gateway_binding_is_rejected(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "rv@t.co")
    _acct(db_session, u, "A", revoked_at=T0, revoked_reason=REASON_PASSWORD_CHANGED)
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "重新验证" in exc.value.detail


def test_removed_gateway_binding_counts_as_not_owned(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "rmg@t.co")
    _acct(db_session, u, "A", revoked_at=T0, revoked_reason=REASON_USER_REMOVED)
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "实盘账户" in exc.value.detail


def test_login_entered_by_another_user_is_409(db_session):
    comp = _comp(db_session)
    a = _user(db_session, "a@t.co"); _acct(db_session, a, "X")
    b = _user(db_session, "b@t.co"); _acct(db_session, b, "X")
    register_participant(db_session, comp, a, "X", IN_WINDOW)
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, b, "X", IN_WINDOW)
    assert exc.value.status_code == 409
    assert "其他用户" in exc.value.detail
    rows = db_session.query(CompetitionParticipant).filter_by(competition_id=comp.id).all()
    assert [r.user_id for r in rows] == [a.id]


def test_same_user_reentry_returns_existing(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "re@t.co"); _acct(db_session, u, "A", balance=1500.0)
    p1 = register_participant(db_session, comp, u, "A", IN_WINDOW)
    p2 = register_participant(db_session, comp, u, "A", IN_WINDOW + timedelta(hours=1))
    assert p1.id == p2.id
    b = db_session.query(PeriodBaseline).filter_by(
        period_key=comp_period_key(comp.id), user_id=u.id, mt5_login="A").one()
    assert b.baseline == 1500.0
