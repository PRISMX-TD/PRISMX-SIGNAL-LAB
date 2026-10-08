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


# ---- 实时核资（A4）/ live funds check -----------------------------------------

# 在 autouse 桩替换之前就把真函数绑定到本地名字上（from-import 在模块导入时求值）。
# Bind the real function before the autouse stub replaces the module attribute.
from app.services.gamification.competitions import read_live_funds as _real_read_live_funds  # noqa: E402


def _exact_comp(db, amount=1000.0):
    c = _comp(db)
    c.min_baseline_usd = amount
    c.max_baseline_usd = amount
    db.commit()
    return c


def test_read_live_funds_reads_gateway(monkeypatch):
    from app.services import gateway_client as gw
    from app.services.gateway_client import AccountRsp

    async def fake_get_account(login, timeout=gw.READ_TIMEOUT):
        assert login == 600123
        return AccountRsp(ok=True, login=login, name="N", group="g", leverage=100,
                          balance=1234.5, equity=1230.25, margin=0.0, margin_free=1230.25)

    monkeypatch.setattr(gw, "_main_loop", None)            # 单测里退回 asyncio.run
    monkeypatch.setattr(gw, "get_account", fake_get_account)
    assert _real_read_live_funds(MT5Account(login="600123")) == (1234.5, 1230.25)


@pytest.mark.parametrize("behaviour", ["none", "raise"])
def test_read_live_funds_unreachable_is_503(monkeypatch, behaviour):
    from app.services import gateway_client as gw

    async def fake_get_account(login, timeout=gw.READ_TIMEOUT):
        if behaviour == "raise":
            raise RuntimeError("gateway down")
        return None

    monkeypatch.setattr(gw, "_main_loop", None)
    monkeypatch.setattr(gw, "get_account", fake_get_account)
    with pytest.raises(HTTPException) as exc:
        _real_read_live_funds(MT5Account(login="600123"))
    assert exc.value.status_code == 503
    assert "暂时无法核对账户资金" in exc.value.detail


def test_register_503_when_live_read_fails(db_session, live_funds):
    comp = _comp(db_session)
    u = _user(db_session, "f503@t.co"); _acct(db_session, u, "A")
    live_funds["A"] = HTTPException(503, comp_mod.MSG_FUNDS_UNAVAILABLE)
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 503
    assert db_session.query(CompetitionParticipant).count() == 0
    assert db_session.query(PeriodBaseline).count() == 0


def test_baseline_uses_live_balance_not_stored(db_session, live_funds):
    comp = _comp(db_session)
    u = _user(db_session, "lb@t.co"); _acct(db_session, u, "A", balance=1500.0)
    live_funds["A"] = (1490.0, 1490.0)
    register_participant(db_session, comp, u, "A", IN_WINDOW)
    b = db_session.query(PeriodBaseline).filter_by(
        period_key=comp_period_key(comp.id), user_id=u.id, mt5_login="A").one()
    assert b.baseline == 1490.0


def test_range_gate_uses_live_balance(db_session, live_funds):
    comp = _comp(db_session)
    comp.min_baseline_usd = 1000.0; db_session.commit()
    u = _user(db_session, "rg@t.co"); _acct(db_session, u, "A", balance=1200.0)  # 库里够
    live_funds["A"] = (900.0, 900.0)                                              # 实时不够
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "最低参赛金额" in exc.value.detail


def test_exact_amount_uses_live_balance(db_session, live_funds):
    comp = _exact_comp(db_session)
    u = _user(db_session, "ex@t.co"); _acct(db_session, u, "A", balance=1000.0)   # 库里正好
    live_funds["A"] = (999.0, 999.0)                                              # 实时不对
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert "正好 1000 USD" in exc.value.detail


def test_exact_amount_requires_no_open_positions(db_session, live_funds):
    comp = _exact_comp(db_session)
    u = _user(db_session, "fl@t.co"); _acct(db_session, u, "A", balance=1000.0)
    live_funds["A"] = (1000.0, 1012.3)                    # 有持仓：净值 ≠ 余额
    with pytest.raises(HTTPException) as exc:
        register_participant(db_session, comp, u, "A", IN_WINDOW)
    assert exc.value.status_code == 400
    assert "无持仓" in exc.value.detail

    live_funds["A"] = (1000.004, 1000.0)                  # 容差内 / within tolerance
    assert register_participant(db_session, comp, u, "A", IN_WINDOW).mt5_login == "A"


def test_reentry_does_not_hit_gateway(db_session, live_funds):
    comp = _comp(db_session)
    u = _user(db_session, "rh@t.co"); _acct(db_session, u, "A")
    p1 = register_participant(db_session, comp, u, "A", IN_WINDOW)
    live_funds["A"] = HTTPException(503, "should not be called")
    assert register_participant(db_session, comp, u, "A", IN_WINDOW).id == p1.id


def test_live_read_runs_without_holding_a_db_connection(db_session, monkeypatch):
    """网关读最长 LIVE_FUNDS_TIMEOUT 秒：读之前把事务结束、连接还回池子，读的过程中
    不得再碰会话（否则重新取连接、一直占到读完）。连接池每 worker 只有 8+4。
    The gateway read may take up to LIVE_FUNDS_TIMEOUT: the session must have
    released its connection before it and must not be touched during it."""
    comp = _comp(db_session)
    u = _user(db_session, "conn@t.co"); _acct(db_session, u, "A", balance=2000.0)
    seen = {}

    def fake(acct):
        seen["login"] = acct.login
        seen["in_tx"] = db_session.in_transaction()
        return (2000.0, 2000.0)

    monkeypatch.setattr(comp_mod, "read_live_funds", fake)
    register_participant(db_session, comp, u, "A", IN_WINDOW)

    assert seen == {"login": "A", "in_tx": False}
    assert db_session.query(CompetitionParticipant).filter_by(mt5_login="A").count() == 1
    assert comp_mod.LIVE_FUNDS_TIMEOUT == 8.0
