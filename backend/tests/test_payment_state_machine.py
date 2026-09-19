"""支付状态机与入账对账（审计 F-02 / F-03 / F-11 / F-13 / F-22）。

这一批的共同点是「钱已经动了之后才发现判断写错了」那一类——出了问题不是报错，
是用户白拿 PRO、或者被一笔早就死掉的订单永久挡在下单之外，而且两种都不会有人
来报。所以判据本身要被测试直接钉住。

service 级测试，用 conftest 的 db_session 内存库；_sync_payment_status 是同步函数，
不需要 TestClient。
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, Payment, User
from app.routers.payments import (
    STATUS_FINISHED_MISMATCH,
    _sync_payment_status,
    claim_trial,
    create_payment_order,
    get_plans,
)


def _mk_user(db, email="p@x.io", **kw):
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


def _mk_payment(db, user, status="PENDING", plan="pro_monthly", **kw):
    p = Payment(
        user_id=user.id,
        nowpayments_payment_id=kw.pop("np_id", "np-1"),
        plan=plan,
        amount_usd=kw.pop("amount_usd", 19.0),
        pay_currency=kw.pop("pay_currency", "usdttrc20"),
        pay_amount=kw.pop("pay_amount", 19.0),
        status=status,
        **kw,
    )
    db.add(p)
    db.commit()
    return p


def _np(status="finished", **over):
    """一份"完全对得上"的 NOWPayments 载荷，用 over 打破其中某一项。"""
    data = {
        "payment_status": status,
        "pay_currency": "usdttrc20",
        "price_amount": 19.0,
        "actually_paid": 19.0,
    }
    data.update(over)
    return data


# ---------- F-02 入账对账 / reconciliation before crediting ----------


def test_matching_payment_credits_the_user(db_session):
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user)
    _sync_payment_status(db_session, rec, "finished", _np())
    db_session.refresh(user)
    db_session.refresh(rec)
    assert rec.status == "FINISHED"
    assert user.plan == "PRO" and user.plan_expires_at is not None


@pytest.mark.parametrize("override, why", [
    ({"pay_currency": "usdterc20"}, "币种对不上"),
    ({"price_amount": 1.0}, "价格对不上"),
    ({"actually_paid": 3.0}, "实付少于应付"),
])
def test_mismatched_payment_is_not_credited(db_session, override, why):
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user)
    _sync_payment_status(db_session, rec, "finished", _np(**override))
    db_session.refresh(user)
    db_session.refresh(rec)
    assert rec.status == STATUS_FINISHED_MISMATCH, why
    assert user.plan == "FREE" and user.plan_expires_at is None
    audit = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == "payment:finished_mismatch"
    ).all()
    assert len(audit) == 1


def test_overpayment_is_not_a_mismatch(db_session):
    """多转一点是链上手续费的正常现象，不该拦。"""
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user)
    _sync_payment_status(db_session, rec, "finished", _np(actually_paid=19.5))
    db_session.refresh(rec)
    assert rec.status == "FINISHED"


def test_absent_fields_are_not_a_mismatch(db_session):
    """回调载荷缺字段不算对不上账——否则所有正常支付都会卡住。"""
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user)
    _sync_payment_status(db_session, rec, "finished", {"payment_status": "finished"})
    db_session.refresh(rec)
    assert rec.status == "FINISHED"


def test_float_noise_is_not_a_mismatch(db_session):
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user, amount_usd=199.0, pay_amount=199.0)
    _sync_payment_status(
        db_session, rec, "finished", _np(price_amount=199.00000000000003, actually_paid=199.0)
    )
    db_session.refresh(rec)
    assert rec.status == "FINISHED"


def test_mismatch_can_still_be_reconciled_later(db_session):
    """FINISHED_MISMATCH 不是死局：后续对上了照样入账。"""
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user)
    _sync_payment_status(db_session, rec, "finished", _np(actually_paid=3.0))
    db_session.refresh(rec)
    assert rec.status == STATUS_FINISHED_MISMATCH

    _sync_payment_status(db_session, rec, "finished", _np())
    db_session.refresh(user)
    db_session.refresh(rec)
    assert rec.status == "FINISHED" and user.plan == "PRO"


def test_paid_upgrade_writes_an_audit_row(db_session):
    """付费是"这个人怎么拿到 PRO 的"链条上原先唯一缺的一段。"""
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user)
    _sync_payment_status(db_session, rec, "finished", _np())
    rows = db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "plan:payment").all()
    assert len(rows) == 1
    assert rows[0].target_user_id == user.id
    assert "FREE" in rows[0].old_value and "PRO" in rows[0].new_value


def test_permanent_pro_is_not_touched_and_not_audited(db_session):
    """不限期 PRO 什么都没变，就不该留下一条"变了"的审计行。"""
    user = _mk_user(db_session, plan="PRO", plan_expires_at=None)
    rec = _mk_payment(db_session, user)
    _sync_payment_status(db_session, rec, "finished", _np())
    db_session.refresh(user)
    assert user.plan == "PRO" and user.plan_expires_at is None
    assert db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == "plan:payment"
    ).count() == 0


# ---------- F-03 状态机 / state machine ----------


@pytest.mark.parametrize("terminal", ["EXPIRED", "FAILED", "FINISHED"])
def test_terminal_states_never_regress(db_session, terminal):
    """迟到的 waiting 回调不能把终态拉回 PROCESSING。

    EXPIRED/FAILED 被拉回 PROCESSING 的后果特别隐蔽：PROCESSING 计入
    MAX_OPEN_PAYMENTS_PER_USER，用户会被一笔在自己页面上显示"已过期"的订单
    永久挡在下单之外。
    """
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user, status=terminal)
    _sync_payment_status(db_session, rec, "waiting", _np(status="waiting"))
    db_session.refresh(rec)
    assert rec.status == terminal


def test_mismatch_state_is_terminal_too(db_session):
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user, status=STATUS_FINISHED_MISMATCH)
    _sync_payment_status(db_session, rec, "waiting", _np(status="waiting"))
    db_session.refresh(rec)
    assert rec.status == STATUS_FINISHED_MISMATCH


def test_non_terminal_states_still_advance(db_session):
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user, status="PENDING")
    _sync_payment_status(db_session, rec, "confirming", _np(status="confirming"))
    db_session.refresh(rec)
    assert rec.status == "PROCESSING"


def test_refund_after_finished_is_logged_but_never_auto_downgrades(db_session):
    """退款后不自动降级（那是产品决策），但必须留下痕迹。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(db_session, plan="PRO", plan_expires_at=now + timedelta(days=25))
    rec = _mk_payment(db_session, user, status="FINISHED", finished_at=now)

    _sync_payment_status(db_session, rec, "refunded", _np(status="refunded"))
    db_session.refresh(user)
    db_session.refresh(rec)
    assert rec.status == "FINISHED"          # 状态不动
    assert user.plan == "PRO"                # 不自动降级
    assert db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == "payment:refund_after_finished"
    ).count() == 1


def test_refund_before_finished_is_just_a_failure(db_session):
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user, status="PROCESSING")
    _sync_payment_status(db_session, rec, "refunded", _np(status="refunded"))
    db_session.refresh(rec)
    assert rec.status == "FAILED"


def test_actually_paid_is_persisted_even_when_the_status_cannot_move(db_session):
    """状态被终态保护挡住时，到账金额仍要落库——否则钱看起来凭空消失。"""
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user, status="EXPIRED")
    _sync_payment_status(db_session, rec, "waiting", _np(status="waiting", actually_paid=5.0))
    db_session.refresh(rec)
    assert rec.status == "EXPIRED" and rec.actually_paid == 5.0


# ---------- F-11 试用天数 / trial day count ----------


def test_claim_trial_refuses_a_non_positive_day_count(db_session, monkeypatch):
    """trial_days 被手改成 0 时不能烧掉用户唯一一次试用。"""
    import app.services.plans as plans

    monkeypatch.setattr(
        plans, "get_trial_settings", lambda db: {"trial_enabled": True, "trial_days": 0},
        raising=False,
    )
    monkeypatch.setattr(
        "app.services.settings_store.get_trial_settings",
        lambda db: {"trial_enabled": True, "trial_days": 0},
    )
    user = _mk_user(db_session)
    with pytest.raises(HTTPException) as exc:
        claim_trial(user=user, db=db_session)
    assert exc.value.status_code == 400
    db_session.refresh(user)
    assert user.trial_used_at is None and user.plan == "FREE"


def test_claim_trial_still_works_with_a_positive_day_count(db_session, monkeypatch):
    monkeypatch.setattr(
        "app.services.settings_store.get_trial_settings",
        lambda db: {"trial_enabled": True, "trial_days": 7},
    )
    user = _mk_user(db_session)
    out = claim_trial(user=user, db=db_session)
    assert out["days"] == 7
    db_session.refresh(user)
    assert user.plan == "PRO" and user.plan_is_trial is True


# ---------- F-13 永久 PRO 不给下单 / permanent PRO cannot order ----------


def test_permanent_pro_cannot_create_an_order(db_session):
    """钱收了什么都不变、页面上还没有提示——只有下单这一步能在收钱前说话。

    剥掉 slowapi 装饰器再 asyncio.run（与本仓库其余异步端点的测法一致）：限流
    与这条判据无关，带着装饰器调用需要一个挂了 limiter 的 app.state。
    """
    import asyncio

    from app.routers.payments import CreatePaymentRequest

    user = _mk_user(db_session, plan="PRO", plan_expires_at=None)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            create_payment_order.__wrapped__(
                body=CreatePaymentRequest(plan="pro_monthly", pay_currency="usdttrc20"),
                request=None,
                _user=user,
                db=db_session,
            )
        )
    assert exc.value.status_code == 409


def test_a_normal_user_gets_past_the_permanent_pro_guard(db_session, monkeypatch):
    """守卫只挡不限期 PRO：有到期日的续费用户照旧走到下一步。

    下一步是调 NOWPayments，这里把它替换成必定抛错的桩（既不出网、也把"走到了
    这一步"这件事变成一个确定的 502），断言的是**没有**在 409 上被拦住。
    """
    import asyncio

    from app.routers.payments import CreatePaymentRequest

    async def _boom(**_kw):
        raise RuntimeError("no network in tests")

    monkeypatch.setattr("app.routers.payments.np_create", _boom)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(db_session, plan="PRO", plan_expires_at=now + timedelta(days=3))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            create_payment_order.__wrapped__(
                body=CreatePaymentRequest(plan="pro_monthly", pay_currency="usdttrc20"),
                request=None,
                _user=user,
                db=db_session,
            )
        )
    assert exc.value.status_code == 502


# ---------- F-22 年付折扣标签 / yearly saving tag ----------


def test_yearly_tag_reflects_the_real_discount(db_session, monkeypatch):
    def _pricing(_db, monthly, yearly):
        return {
            "pro_monthly_price": monthly, "pro_yearly_price": yearly,
            "sale_enabled": False, "sale_percent": 0, "sale_badge": "", "sale_end_at": "",
        }

    monkeypatch.setattr(
        "app.services.settings_store.get_trial_settings",
        lambda db: {"trial_enabled": False, "trial_days": 7},
    )
    # 月付 10 × 12 = 120，年付 90 → 省 25%
    monkeypatch.setattr(
        "app.routers.payments.get_pricing_settings", lambda db: _pricing(db, 10.0, 90.0)
    )
    yearly = next(p for p in get_plans(db_session)["plans"] if p["id"] == "pro_yearly")
    assert yearly["tag"] == "save_25"

    # 年付不便宜就不给标签，而不是继续说"省 20%"
    monkeypatch.setattr(
        "app.routers.payments.get_pricing_settings", lambda db: _pricing(db, 10.0, 130.0)
    )
    yearly = next(p for p in get_plans(db_session)["plans"] if p["id"] == "pro_yearly")
    assert yearly["tag"] is None
