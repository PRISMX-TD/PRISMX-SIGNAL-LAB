"""代理改客户会员的三道新边界（审计 F-01）。

① 每客户滚动 30 天累计延长上限——单次 60 天在 30/分钟 的限流下等于每分钟 1800 天，
   真正封住"无限开 PRO"的是累计额度；
② 有仍在有效期内的 FINISHED 付款时不许降级——代理一点就能抹掉用户花钱买的权益；
③ 任何写操作都给管理员留一条站内通知——此前唯一的痕迹是没人会定期翻的审计表。

照 test_invite_agents.py 的惯例走 service 级测试，用 conftest 的 db_session 内存库。
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import AdminAuditLog, InviteLink, Payment, User, UserNotification
from app.routers.invite import (
    AGENT_EXTEND_WINDOW_DAYS,
    AGENT_MAX_EXTEND_DAYS,
    AGENT_MAX_EXTEND_DAYS_PER_WINDOW,
    agent_set_plan,
    assign_agent,
)
from app.schemas import AgentPlanUpdate
from app.services.notification_feed import KIND_AGENT_PLAN_CHANGE


def _mk_link(db, code="abcd2345", label="测试渠道"):
    link = InviteLink(code=code, label=label, is_active=True)
    db.add(link)
    db.commit()
    return link


def _mk_user(db, email="u@example.com", **kw):
    user = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(user)
    db.commit()
    return user


def _setup(db, target_kw=None):
    """管理员 + 代理 + 一条指派给他的链接 + 一个经该链接注册的客户。"""
    admin = _mk_user(db, "a@x.io", role="admin")
    agent = _mk_user(db, "agent@x.io")
    link = _mk_link(db)
    assign_agent(db, admin, link, agent)
    target = _mk_user(db, "t@x.io", invite_code=link.code, **(target_kw or {}))
    return admin, agent, link, target


def _plan(**kw):
    return AgentPlanUpdate(**kw)


def _extend(db, agent, link, days, email="t@x.io"):
    return agent_set_plan(db, agent, link.id, _plan(email=email, action="extend", days=days))


# ---------- ① 累计额度 / rolling quota ----------


def test_cumulative_extension_is_capped_per_window(db_session):
    """滚动窗口内累计到上限就拒绝，单次上限之内也不行。"""
    _admin, agent, link, target = _setup(db_session)

    # 60 + 30 = 90，正好用满额度
    _extend(db_session, agent, link, AGENT_MAX_EXTEND_DAYS)          # 60
    _extend(db_session, agent, link, AGENT_MAX_EXTEND_DAYS_PER_WINDOW - AGENT_MAX_EXTEND_DAYS)  # 30
    db_session.refresh(target)
    reached = target.plan_expires_at

    with pytest.raises(HTTPException) as exc:
        _extend(db_session, agent, link, 1)
    assert exc.value.status_code == 429
    # 被拒的那次一天都没加上 / the rejected call adds nothing
    db_session.refresh(target)
    assert target.plan_expires_at == reached


def test_quota_is_per_customer_not_per_agent(db_session):
    """额度挂在客户身上：同一个代理给另一个客户加天数不受影响。"""
    _admin, agent, link, first = _setup(db_session)
    second = _mk_user(db_session, "t2@x.io", invite_code=link.code)

    _extend(db_session, agent, link, AGENT_MAX_EXTEND_DAYS_PER_WINDOW - 30)
    _extend(db_session, agent, link, 30)
    with pytest.raises(HTTPException):
        _extend(db_session, agent, link, 1)

    # 另一个客户的额度是干净的
    _extend(db_session, agent, link, AGENT_MAX_EXTEND_DAYS, email="t2@x.io")
    db_session.refresh(second)
    assert second.plan == "PRO"
    assert first.id != second.id


def test_quota_only_counts_the_rolling_window(db_session):
    """窗口之外的旧记录不占额度——否则额度会变成"这辈子只能加 90 天"。"""
    _admin, agent, link, target = _setup(db_session)
    _extend(db_session, agent, link, AGENT_MAX_EXTEND_DAYS)
    _extend(db_session, agent, link, AGENT_MAX_EXTEND_DAYS_PER_WINDOW - AGENT_MAX_EXTEND_DAYS)

    # 把那批账本行的时间推到窗口之外
    old = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        days=AGENT_EXTEND_WINDOW_DAYS + 1
    )
    for row in db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field.like("agent:%:extend_days")
    ):
        row.created_at = old
    db_session.commit()

    _extend(db_session, agent, link, AGENT_MAX_EXTEND_DAYS)  # 额度已归零，放行
    db_session.refresh(target)
    assert target.plan == "PRO"


def test_downgrade_does_not_consume_quota(db_session):
    """降级不写账本行：额度是"发出去多少天"，不是"操作了几次"。"""
    _admin, agent, link, _target = _setup(db_session)
    agent_set_plan(db_session, agent, link.id, _plan(email="t@x.io", action="downgrade"))
    ledger = (
        db_session.query(AdminAuditLog)
        .filter(AdminAuditLog.field.like("agent:%:extend_days"))
        .count()
    )
    assert ledger == 0


# ---------- ② 付费保护 / paid-customer guard ----------


def _finished_payment(db, user, plan="pro_monthly", finished_days_ago=0):
    p = Payment(
        user_id=user.id,
        nowpayments_payment_id=f"np-{user.id}-{finished_days_ago}",
        plan=plan,
        amount_usd=19.0,
        pay_currency="usdttrc20",
        pay_amount=19.0,
        status="FINISHED",
        finished_at=datetime.now(timezone.utc).replace(tzinfo=None)
        - timedelta(days=finished_days_ago),
    )
    db.add(p)
    db.commit()
    return p


def test_downgrade_blocked_while_a_paid_term_is_live(db_session):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=20)}
    )
    _finished_payment(db_session, target, finished_days_ago=10)  # 30 天套餐，还剩 20 天

    with pytest.raises(HTTPException) as exc:
        agent_set_plan(db_session, agent, link.id, _plan(email="t@x.io", action="downgrade"))
    assert exc.value.status_code == 409
    db_session.refresh(target)
    assert target.plan == "PRO" and target.plan_expires_at is not None


def test_downgrade_allowed_once_the_paid_term_has_lapsed(db_session):
    """付费窗口过完就不再保护——否则付过一次钱的人永远降不回去。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=5)}
    )
    _finished_payment(db_session, target, finished_days_ago=40)  # 30 天套餐，早过了

    agent_set_plan(db_session, agent, link.id, _plan(email="t@x.io", action="downgrade"))
    db_session.refresh(target)
    assert target.plan == "FREE" and target.plan_expires_at is None


def test_unfinished_payment_does_not_protect(db_session):
    """只有 FINISHED 才算付过钱：PROCESSING 的钱还没到账。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    _admin, agent, link, target = _setup(
        db_session, {"plan": "PRO", "plan_expires_at": now + timedelta(days=20)}
    )
    p = _finished_payment(db_session, target, finished_days_ago=1)
    p.status = "PROCESSING"
    db_session.commit()

    agent_set_plan(db_session, agent, link.id, _plan(email="t@x.io", action="downgrade"))
    db_session.refresh(target)
    assert target.plan == "FREE"


def test_paid_guard_reads_payments_not_the_plan_column(db_session):
    """判据是 payments 表，不是 users.plan —— plan 会被这次操作自己盖掉。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    # 用户当前已经是 FREE（比如到期自愈跑过了），但付费窗口还没走完
    _admin, agent, link, target = _setup(db_session, {"plan": "FREE"})
    _finished_payment(db_session, target, plan="pro_yearly", finished_days_ago=1)

    with pytest.raises(HTTPException) as exc:
        agent_set_plan(db_session, agent, link.id, _plan(email="t@x.io", action="downgrade"))
    assert exc.value.status_code == 409
    assert now is not None


# ---------- ③ 管理员通知 / admin notification ----------


def test_every_agent_write_notifies_every_admin(db_session):
    admin, agent, link, target = _setup(db_session)
    other_admin = _mk_user(db_session, "a2@x.io", role="admin")

    _extend(db_session, agent, link, 7)
    rows = (
        db_session.query(UserNotification)
        .filter(UserNotification.kind == KIND_AGENT_PLAN_CHANGE)
        .all()
    )
    assert {r.user_id for r in rows} == {admin.id, other_admin.id}
    assert all(r.ref_id == target.id for r in rows)
    # 正文要认得出是谁改了谁 / the body has to name both sides
    assert all(agent.email in (r.text or "") and target.email in (r.text or "") for r in rows)


def test_downgrade_notifies_too(db_session):
    admin, agent, link, _target = _setup(db_session)
    agent_set_plan(db_session, agent, link.id, _plan(email="t@x.io", action="downgrade"))
    row = (
        db_session.query(UserNotification)
        .filter(UserNotification.kind == KIND_AGENT_PLAN_CHANGE)
        .one()
    )
    assert row.user_id == admin.id
    assert "FREE" in (row.text or "")


def test_a_rejected_write_notifies_nobody(db_session):
    """被拒的请求不该在铃铛里留下痕迹——那会把"有人试过"变成"有人改过"。"""
    _admin, agent, link, target = _setup(db_session, {"plan": "PRO", "plan_expires_at": None})
    with pytest.raises(HTTPException):
        _extend(db_session, agent, link, 7)
    assert (
        db_session.query(UserNotification)
        .filter(UserNotification.kind == KIND_AGENT_PLAN_CHANGE)
        .count()
        == 0
    )
    assert target.plan == "PRO"
