"""安全审计 D 组：代理降级的付费保护（叠加续费）与 /status 轮询入账的陈旧 User。

Security audit group D:
- invite.py:agent-downgrade-paid-guard-ignores-stacked-renewals
- payments.py:status-poll-credit-stale-user-identity-map
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.models import AdminAuditLog, Payment
from app.routers.invite import agent_set_plan, agent_tree_set_plan
from app.routers.payments import _sync_payment_status
from tests.test_agent_plan_guards import _finished_payment, _plan, _setup
from tests.test_payment_state_machine import _mk_payment, _np
from tests.test_payment_state_machine import _mk_user as _mk_pay_user


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _downgrade_calls(db, agent, link):
    body = _plan(email="t@x.io", action="downgrade")
    return (
        lambda: agent_set_plan(db, agent, link.id, body),
        lambda: agent_tree_set_plan(db, agent, body),
    )


# ---------- 叠加续费的付费窗口 / stacked paid terms ----------


@pytest.mark.parametrize("via", [0, 1])
def test_stacked_yearly_renewals_block_downgrade(db_session, via):
    """两笔年付相隔 10 天：第二笔叠在第一笔后面，到期在 350 天后，仍是付费期。"""
    now = _now()
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=350), "plan_is_trial": False}
    )
    _finished_payment(db_session, target, plan="pro_yearly", finished_days_ago=380)
    _finished_payment(db_session, target, plan="pro_yearly", finished_days_ago=370)

    with pytest.raises(HTTPException) as exc:
        _downgrade_calls(db_session, agent, link)[via]()
    assert exc.value.status_code == 409
    db_session.refresh(target)
    assert target.plan == "PRO" and target.plan_expires_at is not None


@pytest.mark.parametrize("via", [0, 1])
def test_payment_stacked_on_agent_time_blocks_downgrade(db_session, via):
    """代理先加了时长，客户再付月费：付的 30 天叠在代理时长后面。入账 41 天后
    finished_at + 30 早过了，但入账写下的到期时间还没到——不许降级。
    Agent time first, then a monthly payment stacked after it; 41 days later the
    naive finished_at + 30 window has passed but the credited expiry hasn't."""
    now = _now()
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=50), "plan_is_trial": False}
    )
    pay = _mk_payment(db_session, target, np_id="np-stacked")
    _sync_payment_status(db_session, pay, "finished", _np())
    db_session.refresh(target)
    credited = target.plan_expires_at
    assert credited - now > timedelta(days=79)  # 50 + 30，叠加生效

    # 时间往前推 41 天：付款与它的入账审计行一起回拨（到期时间本身不动）
    # Travel 41 days: move the payment and its credit audit row back together.
    shift = timedelta(days=41)
    pay.finished_at = pay.finished_at - shift
    for row in db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "plan:payment").all():
        row.created_at = row.created_at - shift
    db_session.commit()

    with pytest.raises(HTTPException) as exc:
        _downgrade_calls(db_session, agent, link)[via]()
    assert exc.value.status_code == 409
    db_session.refresh(target)
    assert target.plan == "PRO" and target.plan_expires_at == credited


def test_refunded_payment_audit_does_not_protect(db_session):
    """退款了的那笔（不再是 FINISHED）即使留着入账审计行也不算付费期。"""
    now = _now()
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=50), "plan_is_trial": False}
    )
    pay = _mk_payment(db_session, target, np_id="np-refunded")
    _sync_payment_status(db_session, pay, "finished", _np())
    pay.status = "REFUNDED"
    db_session.commit()

    agent_set_plan(db_session, agent, link.id, _plan(email="t@x.io", action="downgrade"))
    db_session.refresh(target)
    assert target.plan == "FREE"


# ---------- /status 轮询入账不能用陈旧 User / poll credit must not use a stale User ----------


def _other(db_session):
    return sessionmaker(bind=db_session.get_bind(), autoflush=False)()


def _row(db_session, uid):
    return db_session.execute(
        text("SELECT plan, plan_expires_at, plan_is_trial FROM users WHERE id = :i"), {"i": uid}
    ).one()


def _as_dt(v):
    return v if isinstance(v, datetime) else datetime.fromisoformat(str(v))


def test_concurrent_credit_is_not_lost(db_session):
    user = _mk_pay_user(db_session)
    a = _mk_payment(db_session, user, np_id="np-a")
    b = _mk_payment(db_session, user, np_id="np-b")
    assert user.plan == "FREE"  # 载入身份映射，同 get_current_user / loaded like get_current_user

    other = _other(db_session)
    try:
        _sync_payment_status(other, other.query(Payment).filter(Payment.id == a.id).one(), "finished", _np())
    finally:
        other.close()

    _sync_payment_status(db_session, b, "finished", _np())
    plan, exp, _trial = _row(db_session, user.id)
    assert plan == "PRO"
    assert _as_dt(exp) - _now() > timedelta(days=59)


def test_concurrent_downgrade_does_not_leave_free_with_expiry(db_session):
    user = _mk_pay_user(db_session, plan="PRO", plan_expires_at=_now() + timedelta(days=5))
    b = _mk_payment(db_session, user, np_id="np-b")
    assert user.plan == "PRO"

    other = _other(db_session)
    try:
        other.execute(text("UPDATE users SET plan='FREE', plan_expires_at=NULL WHERE id=:i"), {"i": user.id})
        other.commit()
    finally:
        other.close()

    _sync_payment_status(db_session, b, "finished", _np())
    plan, exp, _trial = _row(db_session, user.id)
    assert plan == "PRO"
    assert timedelta(days=29) < _as_dt(exp) - _now() < timedelta(days=31)


def test_concurrent_trial_claim_does_not_stick_to_paid_plan(db_session):
    user = _mk_pay_user(db_session)
    b = _mk_payment(db_session, user, np_id="np-b")
    assert user.plan == "FREE"

    other = _other(db_session)
    try:
        other.execute(
            text("UPDATE users SET plan='PRO', plan_is_trial=1, plan_expires_at=:e, trial_used_at=:n WHERE id=:i"),
            {"i": user.id, "e": (_now() + timedelta(days=3)).isoformat(" "), "n": _now().isoformat(" ")},
        )
        other.commit()
    finally:
        other.close()

    _sync_payment_status(db_session, b, "finished", _np())
    plan, exp, trial = _row(db_session, user.id)
    assert plan == "PRO" and not trial
    # 试用转正从现在起算，不叠加试用剩余 / trial conversion starts from now
    assert timedelta(days=29) < _as_dt(exp) - _now() < timedelta(days=31)
