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

from app.models import AdminAuditLog, Payment, User, UserNotification
from app.routers.payments import (
    NOTIFY_KIND_PLAN_REFUND,
    STATUS_FINISHED_MISMATCH,
    STATUS_REFUNDED,
    _sync_payment_status,
    claim_trial,
    create_payment_order,
    get_plans,
)
from app.services.plans import (
    REFUND_SKIP_NOT_PAID,
    REFUND_SKIP_PERMANENT,
    REFUND_SKIP_TRIAL,
    refund_revocation,
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


# ---------- DO-02 退款自动收回权益 / refund revokes the entitlement ----------
#
# 这一组的判据只有一条：**扣的必须正好是这笔钱买的那一段**。
# 误扣一个正常付费用户的权益，比晚几天收回一个退款用户的权益严重得多——所以
# 「不该误伤」的那几种（后面又付了一笔、之前就有有效期、不限期 PRO）比「该扣」的
# 那几种测得更细。


def _audit(db, field):
    return db.query(AdminAuditLog).filter(AdminAuditLog.field == field).all()


def _same_day(a, b, tol_seconds: int = 120) -> bool:
    """比较两个到期时间。库里存的是 naive UTC，允许几分钟误差（now 各算各的）。"""
    if a is None or b is None:
        return a is b
    a = a.replace(tzinfo=None) if a.tzinfo else a
    b = b.replace(tzinfo=None) if b.tzinfo else b
    return abs((a - b).total_seconds()) <= tol_seconds


def _refund(db, rec):
    _sync_payment_status(db, rec, "refunded", _np(status="refunded"))


def test_refund_after_finished_revokes_only_this_payments_days(db_session):
    """用户此前就有有效期（续费叠加）：只扣掉这笔加的那 30 天，之前的 25 天不动。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    # 5 天前买过一笔月付（还剩 25 天），刚才又买了一笔月付叠上去 → 到期 now+55
    user = _mk_user(db_session, plan="PRO", plan_expires_at=now + timedelta(days=55))
    _mk_payment(
        db_session, user, status="FINISHED", np_id="np-old",
        finished_at=now - timedelta(days=5),
    )
    rec = _mk_payment(db_session, user, status="FINISHED", np_id="np-new", finished_at=now)

    _refund(db_session, rec)
    db_session.refresh(user)
    db_session.refresh(rec)

    assert rec.status == STATUS_REFUNDED
    assert user.plan == "PRO", "前一笔付费买到的窗口不许被这次退款吃掉"
    assert _same_day(user.plan_expires_at, now + timedelta(days=25))


def test_refund_of_the_only_payment_drops_the_user_to_free(db_session):
    """这笔是唯一的权益来源：收回之后没有任何东西兜底 → 落回 FREE。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(db_session, plan="PRO", plan_expires_at=now + timedelta(days=25))
    rec = _mk_payment(
        db_session, user, status="FINISHED", finished_at=now - timedelta(days=5)
    )

    _refund(db_session, rec)
    db_session.refresh(user)

    assert user.plan == "FREE"
    # 到期时间一并清空，理由同 plan_expiry.downgrade_if_expired（留着过去的时间戳，
    # 管理员将来重新升级却忘了改到期时间的人会当场再次过期）。
    assert user.plan_expires_at is None


def test_refund_never_touches_a_later_payment_after_a_lapse(db_session):
    """会员断档过、后来又付了一笔：那一笔是从付款时刻重新起算的，
    当前到期时间里根本没有被退款那笔的天数——一天都不许扣。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(db_session, plan="PRO", plan_expires_at=now + timedelta(days=28))
    old = _mk_payment(
        db_session, user, status="FINISHED", np_id="np-lapsed",
        finished_at=now - timedelta(days=100),
    )
    _mk_payment(
        db_session, user, status="FINISHED", np_id="np-fresh",
        finished_at=now - timedelta(days=2),
    )

    _refund(db_session, old)
    db_session.refresh(user)
    db_session.refresh(old)

    assert old.status == STATUS_REFUNDED
    assert user.plan == "PRO"
    assert _same_day(user.plan_expires_at, now + timedelta(days=28)), "新付的那笔必须原封不动"
    # 权益没变就不该留一条「变了」的审计行，也不该去打扰用户
    assert _audit(db_session, "plan:refund") == []
    assert db_session.query(UserNotification).count() == 0


def test_refund_preserves_a_later_stacked_payment(db_session):
    """用户此后又付了一笔（叠加在旧窗口上）：那笔的权益必须保住。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    # 10 天前月付（到期 now+20），1 天前年付叠上去（到期 now+385）
    user = _mk_user(db_session, plan="PRO", plan_expires_at=now + timedelta(days=385))
    monthly = _mk_payment(
        db_session, user, status="FINISHED", np_id="np-m",
        finished_at=now - timedelta(days=10),
    )
    _mk_payment(
        db_session, user, status="FINISHED", np_id="np-y", plan="pro_yearly",
        amount_usd=199.0, pay_amount=199.0, finished_at=now - timedelta(days=1),
    )

    _refund(db_session, monthly)
    db_session.refresh(user)

    assert user.plan == "PRO"
    # 年付单独就保证到 now+364，扣完月付的 30 天（now+355）比它还早 → 以它为下限
    assert _same_day(user.plan_expires_at, now + timedelta(days=364))


def test_refund_leaves_permanent_pro_completely_alone(db_session):
    """不限期 PRO：这笔钱当初什么都没给出（入账走的是 pass 分支），
    退款自然没有东西可收回；NULL 也没法减天数。留给人工看。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(db_session, plan="PRO", plan_expires_at=None)
    rec = _mk_payment(db_session, user, status="FINISHED", finished_at=now)

    _refund(db_session, rec)
    db_session.refresh(user)
    db_session.refresh(rec)

    assert user.plan == "PRO" and user.plan_expires_at is None
    assert rec.status == STATUS_REFUNDED          # 订单本身仍落终态
    assert _audit(db_session, "plan:refund") == []
    skipped = _audit(db_session, "plan:refund_skipped")
    assert len(skipped) == 1 and skipped[0].new_value == REFUND_SKIP_PERMANENT


def test_refund_does_not_touch_a_current_trial_plan(db_session):
    """当前 PRO 带着试用标记：付费入账会把它清成 False，所以这是别处赋予的权益，
    不知道从哪来就不动。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(
        db_session, plan="PRO", plan_expires_at=now + timedelta(days=5), plan_is_trial=True
    )
    rec = _mk_payment(db_session, user, status="FINISHED", finished_at=now)

    _refund(db_session, rec)
    db_session.refresh(user)

    assert user.plan == "PRO" and _same_day(user.plan_expires_at, now + timedelta(days=5))
    skipped = _audit(db_session, "plan:refund_skipped")
    assert len(skipped) == 1 and skipped[0].new_value == REFUND_SKIP_TRIAL


def test_refund_of_an_already_free_user_changes_nothing(db_session):
    """管理员先降过 / 到期扫描已经收走了：没有可收回的权益。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(db_session)
    rec = _mk_payment(db_session, user, status="FINISHED", finished_at=now)

    _refund(db_session, rec)
    db_session.refresh(user)

    assert user.plan == "FREE" and user.plan_expires_at is None
    skipped = _audit(db_session, "plan:refund_skipped")
    assert len(skipped) == 1 and skipped[0].new_value == REFUND_SKIP_NOT_PAID


def test_trial_converted_to_paid_falls_back_to_free_on_refund(db_session):
    """试用期内付费转正后退款：付费时试用剩余天数被**刻意丢弃**（不叠加），
    库里已经没有原来的试用到期时间了，所以收回这笔之后只能回到 FREE。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(
        db_session,
        plan="PRO",
        plan_expires_at=now + timedelta(days=20),   # 10 天前付的月付
        plan_is_trial=False,
        trial_used_at=now - timedelta(days=15),
    )
    rec = _mk_payment(
        db_session, user, status="FINISHED", finished_at=now - timedelta(days=10)
    )

    _refund(db_session, rec)
    db_session.refresh(user)

    assert user.plan == "FREE" and user.plan_expires_at is None
    assert user.plan_is_trial is False
    assert user.trial_used_at is not None, "试用是终身一次的凭据，退款不该把它还回去"


def test_refund_writes_both_audit_rows_with_the_old_values(db_session):
    """支付层 + 权益层各一条，旧值必须记下来（否则事后无法复原扣了多少）。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(db_session, plan="PRO", plan_expires_at=now + timedelta(days=25))
    rec = _mk_payment(
        db_session, user, status="FINISHED", finished_at=now - timedelta(days=5)
    )

    _refund(db_session, rec)

    pay_rows = _audit(db_session, "payment:refund_after_finished")
    assert len(pay_rows) == 1
    assert pay_rows[0].old_value == "FINISHED" and pay_rows[0].new_value == STATUS_REFUNDED

    plan_rows = _audit(db_session, "plan:refund")
    assert len(plan_rows) == 1
    assert plan_rows[0].target_user_id == user.id
    assert plan_rows[0].old_value.startswith("PRO(")
    assert "FREE" in plan_rows[0].new_value


def test_refund_notifies_the_user_in_app(db_session):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(db_session, plan="PRO", plan_expires_at=now + timedelta(days=25))
    rec = _mk_payment(
        db_session, user, status="FINISHED", finished_at=now - timedelta(days=5)
    )

    _refund(db_session, rec)

    rows = db_session.query(UserNotification).all()
    assert len(rows) == 1
    assert rows[0].user_id == user.id
    assert rows[0].kind == NOTIFY_KIND_PLAN_REFUND
    assert rows[0].ref_id == rec.id and rows[0].text


def test_refunded_is_terminal_and_never_revokes_twice(db_session):
    """重复的 refunded 回调不能扣第二次；迟到的 waiting 也拉不回 PROCESSING。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    user = _mk_user(db_session, plan="PRO", plan_expires_at=now + timedelta(days=55))
    rec = _mk_payment(db_session, user, status="FINISHED", finished_at=now)

    _refund(db_session, rec)
    db_session.refresh(user)
    first = user.plan_expires_at

    _refund(db_session, rec)          # 同一条回调又来一次
    _sync_payment_status(db_session, rec, "waiting", _np(status="waiting"))
    db_session.refresh(user)
    db_session.refresh(rec)

    assert rec.status == STATUS_REFUNDED
    assert user.plan_expires_at == first, "第二次退款回调不许再扣一次"
    assert len(_audit(db_session, "plan:refund")) == 1


def test_refunded_payment_no_longer_counts_as_a_live_paid_plan(db_session):
    """代理降级前的付费保护按 status == FINISHED 判定：退掉的钱不该继续替用户挡着。"""
    from app.routers.invite import _has_live_paid_plan

    now = datetime.now(timezone.utc)
    naive = now.replace(tzinfo=None)
    user = _mk_user(db_session, plan="PRO", plan_expires_at=naive + timedelta(days=25))
    rec = _mk_payment(
        db_session, user, status="FINISHED", finished_at=naive - timedelta(days=5)
    )
    assert _has_live_paid_plan(db_session, user.id, now) is True

    _refund(db_session, rec)
    assert _has_live_paid_plan(db_session, user.id, now) is False


# ---------- 纯判定的边角 / pure-predicate corners ----------


def test_refund_revocation_never_extends_the_expiry():
    """下限比现有到期还晚时不顺势延长：退款是收回，任何情况下都不该变成赠送。"""
    now = datetime.now(timezone.utc)
    skip, plan, expiry = refund_revocation(
        plan="PRO",
        plan_expires_at=now + timedelta(days=10),
        plan_is_trial=False,
        days=30,
        entitlement_floor=now + timedelta(days=300),
        now=now,
    )
    assert skip is None and plan == "PRO"
    assert expiry == now + timedelta(days=10)


def test_refund_revocation_accepts_naive_timestamps():
    """库里取出来的是 naive UTC（SQLite/旧行），不能因此算错一整个时区的天数。"""
    now = datetime.now(timezone.utc)
    skip, plan, expiry = refund_revocation(
        plan="PRO",
        plan_expires_at=(now + timedelta(days=40)).replace(tzinfo=None),
        plan_is_trial=False,
        days=30,
        now=now,
    )
    assert skip is None and plan == "PRO"
    assert abs((expiry - (now + timedelta(days=10))).total_seconds()) < 1
