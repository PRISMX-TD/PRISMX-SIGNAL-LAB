"""安全审计 run-1 的两条后续：付款入账时记下 credited_until，付费窗口统一由
services/paid_entitlement 计算（代理降级保护 + 退款收回下限共用）。

Security audit run-1 follow-ups: payments record credited_until when credited,
and one shared service computes the paid window for both the agent downgrade
guard and the refund revoke floor.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, Payment
from app.routers.invite import _has_live_paid_plan, agent_set_plan
from app.routers.payments import STATUS_REFUNDED, _sync_payment_status
from tests.test_agent_plan_guards import _plan, _setup
from tests.test_payment_state_machine import _mk_payment, _np
from tests.test_payment_state_machine import _mk_user as _mk_pay_user


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive(v):
    return v.replace(tzinfo=None) if v is not None and v.tzinfo else v


def _close(a, b, tol_seconds=120):
    return abs((_naive(a) - _naive(b)).total_seconds()) <= tol_seconds


def _yearly(db, user, np_id, **kw):
    return _mk_payment(
        db, user, np_id=np_id, plan="pro_yearly", amount_usd=199.0, pay_amount=199.0, **kw
    )


def _np_yearly():
    return _np(price_amount=199.0, actually_paid=199.0)


def _refund(db, rec):
    _sync_payment_status(db, rec, "refunded", _np(status="refunded"))


def _downgrade(db, agent, link):
    return agent_set_plan(db, agent, link.id, _plan(email="t@x.io", action="downgrade"))


# ---------- 入账写 credited_until / crediting records credited_until ----------


def test_credit_records_credited_until(db_session):
    user = _mk_pay_user(db_session, plan="PRO", plan_expires_at=_now() + timedelta(days=50))
    pay = _mk_payment(db_session, user, np_id="np-cu")
    _sync_payment_status(db_session, pay, "finished", _np())
    db_session.refresh(user)
    db_session.refresh(pay)

    assert pay.status == "FINISHED"
    assert pay.credited_until is not None
    assert _close(pay.credited_until, user.plan_expires_at, tol_seconds=1)
    assert _close(pay.credited_until, _now() + timedelta(days=80))


def test_permanent_pro_payment_credits_nothing(db_session):
    """不限期 PRO 入账走 pass 分支，什么都没加：credited_until 留空。"""
    user = _mk_pay_user(db_session, plan="PRO", plan_expires_at=None)
    pay = _mk_payment(db_session, user, np_id="np-perm")
    _sync_payment_status(db_session, pay, "finished", _np())
    db_session.refresh(pay)
    assert pay.status == "FINISHED" and pay.credited_until is None


# ---------- 代理降级保护 / downgrade guard ----------


def test_downgrade_guard_uses_credited_until_without_audit_row(db_session):
    """审计报告里的原样场景：付款叠在代理加的时长后面，且没有可配对的 plan:payment
    审计行。41 天后 finished_at + 30 早过了，但 credited_until 还没到——不许降级。
    The literal case: a payment stacked on agent-granted time with no audit row."""
    now = _now()
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=50), "plan_is_trial": False}
    )
    pay = _mk_payment(db_session, target, np_id="np-stacked")
    _sync_payment_status(db_session, pay, "finished", _np())
    db_session.refresh(target)
    credited = target.plan_expires_at

    shift = timedelta(days=41)
    pay.finished_at = pay.finished_at - shift
    db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "plan:payment").delete()
    db_session.commit()

    assert _has_live_paid_plan(db_session, target.id, datetime.now(timezone.utc)) is True
    with pytest.raises(HTTPException) as exc:
        _downgrade(db_session, agent, link)
    assert exc.value.status_code == 409
    db_session.refresh(target)
    assert target.plan == "PRO" and target.plan_expires_at == credited


def test_legacy_row_without_credited_until_falls_back_to_audit_row(db_session):
    """rev 49 之前的老行（credited_until 为空）照旧靠 plan:payment 审计行。"""
    now = _now()
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=50), "plan_is_trial": False}
    )
    pay = _mk_payment(db_session, target, np_id="np-legacy")
    _sync_payment_status(db_session, pay, "finished", _np())
    shift = timedelta(days=41)
    pay.finished_at = pay.finished_at - shift
    pay.credited_until = None
    for row in db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "plan:payment").all():
        row.created_at = row.created_at - shift
    db_session.commit()

    with pytest.raises(HTTPException) as exc:
        _downgrade(db_session, agent, link)
    assert exc.value.status_code == 409


def test_legacy_rows_without_credited_until_fall_back_to_the_chain(db_session):
    """老行、没有审计行：两笔年付的叠加链仍然算得出来。"""
    now = _now()
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=350), "plan_is_trial": False}
    )
    _yearly(db_session, target, "np-y1", status="FINISHED", finished_at=now - timedelta(days=380))
    _yearly(db_session, target, "np-y2", status="FINISHED", finished_at=now - timedelta(days=370))

    with pytest.raises(HTTPException) as exc:
        _downgrade(db_session, agent, link)
    assert exc.value.status_code == 409


def test_refunded_payment_with_credited_until_never_protects(db_session):
    now = _now()
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=50), "plan_is_trial": False}
    )
    pay = _mk_payment(db_session, target, np_id="np-ref")
    _sync_payment_status(db_session, pay, "finished", _np())
    db_session.refresh(pay)
    assert pay.credited_until is not None
    pay.status = STATUS_REFUNDED
    db_session.commit()

    assert _has_live_paid_plan(db_session, target.id, datetime.now(timezone.utc)) is False
    _downgrade(db_session, agent, link)
    db_session.refresh(target)
    assert target.plan == "FREE"


def test_refunded_days_inside_a_later_credited_until_do_not_protect(db_session):
    """退掉的那笔年付被后一笔月付叠在上面：后一笔的 credited_until 里含着退款那 365 天，
    不能拿它当付费窗口。The refunded year inside a later payment's credited_until
    must not count."""
    now = _now()
    user = _mk_pay_user(db_session)
    y = _yearly(db_session, user, "np-y")
    _sync_payment_status(db_session, y, "finished", _np_yearly())
    m = _mk_payment(db_session, user, np_id="np-m")
    _sync_payment_status(db_session, m, "finished", _np())
    db_session.refresh(m)
    assert _close(m.credited_until, now + timedelta(days=395))

    # 月付的 30 天已经用完（往前推 40 天），年付被退款
    shift = timedelta(days=40)
    for p in (y, m):
        p.finished_at = p.finished_at - shift
        p.credited_until = p.credited_until - shift
    y.status = STATUS_REFUNDED
    db_session.commit()

    # 月付自己的窗口：叠在年付后面 → 去掉年付后只到 finished_at + 30，早已过期
    assert _has_live_paid_plan(db_session, user.id, datetime.now(timezone.utc)) is False


# ---------- 退款收回下限 / refund revoke floor ----------


def test_refund_floor_keeps_other_payments_full_stacked_time(db_session):
    """两笔叠在一起的年付（经真实入账，带 credited_until），再退掉一笔早已断档的旧
    月付：旧月付的天数根本不在当前到期时间里，两笔年付叠出来的整整两年一天都不许扣。
    Two stacked yearly payments; refunding an old lapsed monthly must not cut
    any of the stacked two years."""
    now = _now()
    user = _mk_pay_user(db_session)
    old = _mk_payment(
        db_session, user, np_id="np-old", status="FINISHED", finished_at=now - timedelta(days=400)
    )
    y1 = _yearly(db_session, user, "np-y1")
    _sync_payment_status(db_session, y1, "finished", _np_yearly())
    y2 = _yearly(db_session, user, "np-y2")
    _sync_payment_status(db_session, y2, "finished", _np_yearly())
    db_session.refresh(user)
    before = user.plan_expires_at
    assert _close(before, now + timedelta(days=730))

    _refund(db_session, old)
    db_session.refresh(user)
    db_session.refresh(old)

    assert old.status == STATUS_REFUNDED
    assert user.plan == "PRO"
    assert _close(user.plan_expires_at, before, tol_seconds=1), "两笔年付叠出来的时间被扣了"


def test_refund_of_first_stacked_year_still_takes_its_year_back(db_session):
    """付两笔年付、退第一笔：第二笔的 credited_until 里叠着第一笔的 365 天，下限不能
    拿它原样当保护——否则退一笔还能留着两年。
    Refunding the first of two stacked years still takes that year back."""
    now = _now()
    user = _mk_pay_user(db_session)
    y1 = _yearly(db_session, user, "np-y1")
    _sync_payment_status(db_session, y1, "finished", _np_yearly())
    y2 = _yearly(db_session, user, "np-y2")
    _sync_payment_status(db_session, y2, "finished", _np_yearly())

    _refund(db_session, y1)
    db_session.refresh(user)

    assert user.plan == "PRO"
    assert _close(user.plan_expires_at, now + timedelta(days=365))


def test_refund_floor_ignores_previously_refunded_payments(db_session):
    """之前已退款的那笔不给下限：两笔都退掉之后落回 FREE。"""
    user = _mk_pay_user(db_session)
    a = _mk_payment(db_session, user, np_id="np-a")
    _sync_payment_status(db_session, a, "finished", _np())
    b = _mk_payment(db_session, user, np_id="np-b")
    _sync_payment_status(db_session, b, "finished", _np())

    _refund(db_session, a)
    _refund(db_session, b)
    db_session.refresh(user)
    assert user.plan == "FREE" and user.plan_expires_at is None
    assert {p.status for p in db_session.query(Payment).all()} == {STATUS_REFUNDED}


# ---------- rev 49 迁移 / rev 49 migration ----------


def test_rev49_adds_credited_until_idempotently(monkeypatch, tmp_path):
    """rev 48 的老库：payments 没有 credited_until。迁移补上这一列，老行留 NULL；再跑一次不报错。
    A rev-48 database gains payments.credited_until (NULL for old rows); re-running is a no-op."""
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.orm import sessionmaker

    import app.core.database as db_mod
    import app.models  # noqa: F401  —— 注册模型 / registers the tables

    url = "sqlite:///" + str(tmp_path / "legacy48.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    db_mod.Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("ALTER TABLE payments DROP COLUMN credited_until"))
        # SQLite 默认不查外键，老付款行不需要先建用户 / SQLite skips FK checks by default
        conn.execute(text(
            "INSERT INTO payments (id, user_id, nowpayments_payment_id, plan, amount_usd, pay_currency, status) "
            "VALUES ('p1', 'u1', 'np-old', 'pro_monthly', 19.0, 'usdttrc20', 'FINISHED')"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    db_mod._write_schema_rev(48)

    assert db_mod.CURRENT_SCHEMA_REV >= 49
    db_mod._migrate_columns()
    assert "credited_until" in {c["name"] for c in inspect(eng).get_columns("payments")}
    with eng.connect() as conn:
        assert conn.execute(text("SELECT credited_until FROM payments WHERE id = 'p1'")).scalar() is None

    db_mod._write_schema_rev(48)
    db_mod._migrate_columns()          # 幂等 / idempotent
    eng.dispose()
