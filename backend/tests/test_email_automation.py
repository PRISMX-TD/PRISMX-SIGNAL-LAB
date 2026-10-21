"""自动邮件（rev 44）。

钉住的都是「写错了不报错、只会悄悄出事」的那一类：
- 一打开规则就给所有老用户补发（「新注册」欢迎信发给几千个老用户）；
- 同一件事给同一个人发两次（扫描重跑、领导权切换）；
- 一个人同一天收到好几封自动邮件；
- 条件已经不成立了还照发（绑上了 MT5 还在催他绑、续了费还在提醒到期）；
- 试用到期和付费到期分不清；复活旧账号被当成「第一次绑定」；
- 额度用完后一封封地撞墙；
- 用户昵称里夹带的标记混进信里变成链接。

照仓库惯例走 service 级测试：直接调函数，Depends 当普通参数传。
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError

from app.core import rate_limit
from app.core.config import settings
from app.models import (
    ActivityEvent,
    AdminAuditLog,
    EmailAutomation,
    EmailAutomationSend,
    EmailCampaign,
    EmailDelivery,
    EmailOptOut,
    MT5Account,
    Payment,
    User,
)
from app.routers import email_automations as router
from app.schemas import EmailAutomationConditionIn, EmailAutomationIn, EmailContentIn
from app.services import email_automation as ea
from app.services import email_broadcast as eb
from app.services import mailer
from app.services.deps import require_admin


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _user(db, email, **kw) -> User:
    kw.setdefault("created_at", _now() - timedelta(days=400))
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


def _rule(db, admin, trigger="signup", delay=0, activated_at=None, **kw) -> EmailAutomation:
    r = EmailAutomation(
        name=kw.pop("name", trigger),
        trigger=trigger,
        delay_minutes=delay,
        kind=kw.pop("kind", "marketing"),
        subject_zh=kw.pop("subject_zh", "你好 {昵称}"),
        body_zh=kw.pop("body_zh", "欢迎 {昵称}。到期 {到期日期}，还剩 {剩余天数} 天。{网站链接}"),
        enabled=kw.pop("enabled", True),
        activated_at=activated_at or _now() - timedelta(days=30),
        created_by=admin.id,
        **kw,
    )
    db.add(r)
    db.commit()
    return r


def _sends(db, rule=None):
    q = db.query(EmailAutomationSend)
    if rule is not None:
        q = q.filter(EmailAutomationSend.rule_id == rule.id)
    return q.order_by(EmailAutomationSend.created_at, EmailAutomationSend.id).all()


@pytest.fixture
def admin(db_session):
    return _user(db_session, "admin@t.co", role="admin", nickname="管理员")


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(settings, "RESEND_API_KEY", "re_test")
    monkeypatch.setattr(settings, "BROADCAST_EMAIL_DAILY_CAP", 0)
    monkeypatch.setattr(rate_limit.limiter, "enabled", False)


def _content(**kw) -> EmailContentIn:
    base = {"subjectZh": "欢迎 {昵称}", "bodyZh": "你好 {昵称}，欢迎加入。"}
    base.update(kw)
    return EmailContentIn(**base)


def _body(trigger="signup", delay=0, **kw) -> EmailAutomationIn:
    return EmailAutomationIn(
        name=kw.pop("name", "欢迎信"),
        condition=EmailAutomationConditionIn(trigger=trigger, delayMinutes=delay, **kw),
        content=_content(),
    )


# ---------- 守卫 / guard ----------

def test_admin_router_guards_itself():
    app = FastAPI()
    app.include_router(router.admin_router)   # 刻意不传 dependencies
    routes = [r for r in app.routes if getattr(r, "dependant", None) is not None]
    assert routes
    for r in routes:
        assert require_admin in {d.call for d in r.dependant.dependencies}, r.path


# ---------- 扫描 / scanning ----------

def test_signup_never_backfills_users_from_before_activation(db_session, admin):
    now = _now()
    activated = now - timedelta(hours=2)
    _user(db_session, "old@t.co", created_at=activated - timedelta(minutes=1))
    new = _user(db_session, "new@t.co", created_at=activated + timedelta(minutes=5))
    rule = _rule(db_session, admin, activated_at=activated)
    assert ea.scan_once(db_session, now) == 1
    assert [s.user_id for s in _sends(db_session, rule)] == [new.id]


def test_delay_holds_until_it_has_passed(db_session, admin):
    now = _now()
    rule = _rule(db_session, admin, delay=24 * 60, activated_at=now - timedelta(days=3))
    early = _user(db_session, "early@t.co", created_at=now - timedelta(hours=25))
    _user(db_session, "late@t.co", created_at=now - timedelta(hours=2))
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, rule)] == [early.id]


def test_rescanning_does_not_queue_twice(db_session, admin):
    now = _now()
    rule = _rule(db_session, admin, activated_at=now - timedelta(hours=1))
    _user(db_session, "a@t.co", created_at=now - timedelta(minutes=30))
    assert ea.scan_once(db_session, now) == 1
    assert ea.scan_once(db_session, now + timedelta(minutes=5)) == 0
    assert len(_sends(db_session, rule)) == 1


def test_disabled_deleted_and_opted_out_are_not_queued(db_session, admin):
    now = _now()
    rule = _rule(db_session, admin, activated_at=now - timedelta(hours=1))
    _user(db_session, "off@t.co", created_at=now - timedelta(minutes=9), disabled_at=now)
    out = _user(db_session, "out@t.co", created_at=now - timedelta(minutes=9))
    db_session.add(EmailOptOut(user_id=out.id))
    db_session.commit()
    _rule(db_session, admin, name="关着的", enabled=False, activated_at=now - timedelta(hours=1))
    assert ea.scan_once(db_session, now) == 0
    # 服务通知不看退订 / a notice ignores the opt-out
    rule.kind = "notice"
    db_session.commit()
    assert ea.scan_once(db_session, now) == 1


def test_unverified_and_no_mt5(db_session, admin):
    now = _now()
    act = now - timedelta(days=10)
    unv = _rule(db_session, admin, trigger="unverified", delay=3 * 1440, activated_at=act)
    nomt5 = _rule(db_session, admin, trigger="no_mt5", delay=3 * 1440, activated_at=act)
    a = _user(db_session, "a@t.co", created_at=now - timedelta(days=4))
    b = _user(db_session, "b@t.co", created_at=now - timedelta(days=4), email_verified_at=now - timedelta(days=4))
    db_session.add(MT5Account(user_id=b.id, login="1001"))
    db_session.commit()
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, unv)] == [a.id]
    assert [s.user_id for s in _sends(db_session, nomt5)] == [a.id]


def test_plan_filter(db_session, admin):
    now = _now()
    rule = _rule(db_session, admin, plan_filter="FREE", activated_at=now - timedelta(hours=1))
    free = _user(db_session, "f@t.co", created_at=now - timedelta(minutes=5))
    _user(db_session, "p@t.co", created_at=now - timedelta(minutes=5), plan="PRO")
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, rule)] == [free.id]


def _bind_event(db, user, account, at, revived=False):
    db.add(ActivityEvent(
        created_at=at, kind="mt5.bind", actor_type="user", actor_id=user.id, user_id=user.id,
        mt5_login=account.login, ref_id=account.id, data=f'{{"ch":"gateway","revived":{"true" if revived else "false"}}}',
    ))
    db.commit()


def test_first_bind_skips_revived_accounts_and_users_with_other_accounts(db_session, admin):
    now = _now()
    rule = _rule(db_session, admin, trigger="mt5_first_bind", activated_at=now - timedelta(hours=3))
    first = _user(db_session, "first@t.co")
    acc = MT5Account(user_id=first.id, login="2001")
    db_session.add(acc)
    revived = _user(db_session, "rev@t.co")
    acc2 = MT5Account(user_id=revived.id, login="2002")
    veteran = _user(db_session, "vet@t.co")
    old_acc = MT5Account(user_id=veteran.id, login="2003", revoked_at=now - timedelta(days=90))
    acc3 = MT5Account(user_id=veteran.id, login="2004")
    db_session.add_all([acc2, old_acc, acc3])
    db_session.commit()
    _bind_event(db_session, first, acc, now - timedelta(hours=1))
    _bind_event(db_session, revived, acc2, now - timedelta(hours=1), revived=True)
    _bind_event(db_session, veteran, acc3, now - timedelta(hours=1))
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, rule)] == [first.id]


def test_expiring_reminds_once_per_expiry_and_separates_trial_from_paid(db_session, admin):
    now = _now()
    act = now - timedelta(days=30)
    trial_rule = _rule(db_session, admin, trigger="trial_expiring", delay=3 * 1440, activated_at=act)
    paid_rule = _rule(db_session, admin, trigger="plan_expiring", delay=3 * 1440, activated_at=act)
    t = _user(db_session, "t@t.co", plan="PRO", plan_is_trial=True, plan_expires_at=now + timedelta(days=2))
    p = _user(db_session, "p@t.co", plan="PRO", plan_is_trial=False, plan_expires_at=now + timedelta(days=1))
    _user(db_session, "far@t.co", plan="PRO", plan_expires_at=now + timedelta(days=20))
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, trial_rule)] == [t.id]
    assert [s.user_id for s in _sends(db_session, paid_rule)] == [p.id]
    # 续费：新的到期时间是新的一次 / a renewal is a new occurrence
    p.plan_expires_at = now + timedelta(days=32)
    db_session.commit()
    later = now + timedelta(days=30)
    ea.scan_once(db_session, later)
    assert len(_sends(db_session, paid_rule)) == 2


def test_expired_uses_the_audit_row_and_tells_trial_from_paid(db_session, admin):
    now = _now()
    act = now - timedelta(days=5)
    trial_rule = _rule(db_session, admin, trigger="trial_expired", activated_at=act)
    paid_rule = _rule(db_session, admin, trigger="plan_expired", activated_at=act)
    t = _user(db_session, "t@t.co", trial_used_at=now - timedelta(days=10))
    p = _user(db_session, "p@t.co", trial_used_at=now - timedelta(days=90))
    db_session.add(Payment(user_id=p.id, nowpayments_payment_id="np1", plan="pro_monthly", amount_usd=10,
                           pay_currency="usdttrc20", status="FINISHED", finished_at=now - timedelta(days=40)))
    renewed = _user(db_session, "r@t.co", trial_used_at=now - timedelta(days=10), plan="PRO")
    for u in (t, p, renewed):
        db_session.add(AdminAuditLog(admin_user_id=u.id, target_user_id=u.id, field="plan:auto_expire",
                                     old_value="PRO", new_value="FREE", created_at=now - timedelta(hours=1)))
    db_session.commit()
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, trial_rule)] == [t.id]
    assert [s.user_id for s in _sends(db_session, paid_rule)] == [p.id]


def test_first_payment(db_session, admin):
    now = _now()
    rule = _rule(db_session, admin, trigger="first_payment", activated_at=now - timedelta(days=1))
    new = _user(db_session, "n@t.co")
    old = _user(db_session, "o@t.co")
    for uid, at, pid in ((new.id, now - timedelta(hours=1), "a"), (old.id, now - timedelta(days=60), "b"),
                         (old.id, now - timedelta(hours=1), "c")):
        db_session.add(Payment(user_id=uid, nowpayments_payment_id=pid, plan="pro_monthly", amount_usd=10,
                               pay_currency="usdttrc20", status="FINISHED", finished_at=at))
    db_session.commit()
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, rule)] == [new.id]


def test_inactive_recall_respects_max_times(db_session, admin):
    now = _now()
    rule = _rule(db_session, admin, trigger="inactive", delay=7 * 1440, max_times=1, activated_at=now - timedelta(days=30))
    u = _user(db_session, "z@t.co", last_active_at=now - timedelta(days=8))
    ea.scan_once(db_session, now)
    (s,) = _sends(db_session, rule)
    s.status = "sent"
    s.sent_at = now
    db_session.commit()
    # 回来活跃了一下又沉下去：新的一次，但已经召回过一次了 / dormant again, but the cap is reached
    u.last_active_at = now + timedelta(days=1)
    db_session.commit()
    ea.scan_once(db_session, now + timedelta(days=9))
    assert len(_sends(db_session, rule)) == 1


# ---------- 每轮上限 / the per-pass cap ----------
# 每轮最多取 MAX_CANDIDATES_PER_RULE 人。已经排过队的、或者条件不符的人不能一直占着名额，
# 否则规则累计命中超过上限之后，新来的人永远排不上。这里把上限调成 2 来复现。
# A pass takes at most MAX_CANDIDATES_PER_RULE people; already-queued or non-matching rows
# must not keep those slots, or once a rule has matched more than the cap nobody new is
# ever queued. The cap is set to 2 here to reproduce that.


def test_signup_keeps_queueing_after_the_cap_is_reached(db_session, admin, monkeypatch):
    monkeypatch.setattr(ea, "MAX_CANDIDATES_PER_RULE", 2)
    now = _now()
    rule = _rule(db_session, admin, activated_at=now - timedelta(days=1))
    for i in range(2):
        _user(db_session, f"a{i}@t.co", created_at=now - timedelta(hours=20 - i))
    assert ea.scan_once(db_session, now) == 2
    for i in range(2):
        _user(db_session, f"b{i}@t.co", created_at=now - timedelta(minutes=10 - i))
    assert ea.scan_once(db_session, now + timedelta(minutes=5)) == 2
    assert len(_sends(db_session, rule)) == 4


def test_inactive_keeps_queueing_after_the_cap_is_reached(db_session, admin, monkeypatch):
    monkeypatch.setattr(ea, "MAX_CANDIDATES_PER_RULE", 2)
    now = _now()
    rule = _rule(db_session, admin, trigger="inactive", delay=7 * 1440, activated_at=now - timedelta(days=30))
    for i in range(2):
        _user(db_session, f"z{i}@t.co", last_active_at=now - timedelta(days=9, hours=i))
    assert ea.scan_once(db_session, now) == 2
    late = _user(db_session, "late@t.co", last_active_at=now - timedelta(days=7, minutes=30))
    assert ea.scan_once(db_session, now + timedelta(minutes=5)) == 1
    assert late.id in {s.user_id for s in _sends(db_session, rule)}


def test_inactive_cap_reached_users_do_not_hold_slots(db_session, admin, monkeypatch):
    monkeypatch.setattr(ea, "MAX_CANDIDATES_PER_RULE", 2)
    now = _now()
    rule = _rule(db_session, admin, trigger="inactive", delay=7 * 1440, max_times=1, activated_at=now - timedelta(days=60))
    done = [_user(db_session, f"d{i}@t.co", last_active_at=now - timedelta(days=20, hours=i)) for i in range(2)]
    for u in done:
        db_session.add(EmailAutomationSend(rule_id=rule.id, user_id=u.id, occurrence="old", status="sent",
                                           created_at=now - timedelta(days=30), sent_at=now - timedelta(days=30)))
    db_session.commit()
    fresh = _user(db_session, "f@t.co", last_active_at=now - timedelta(days=8))
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, rule) if s.status == "pending"] == [fresh.id]


def test_paid_expiry_is_not_crowded_out_by_trial_expiries(db_session, admin, monkeypatch):
    monkeypatch.setattr(ea, "MAX_CANDIDATES_PER_RULE", 2)
    now = _now()
    rule = _rule(db_session, admin, trigger="plan_expired", activated_at=now - timedelta(days=5))
    trials = [_user(db_session, f"t{i}@t.co", trial_used_at=now - timedelta(days=10)) for i in range(3)]
    paid = _user(db_session, "p@t.co")
    for i, u in enumerate(trials + [paid]):
        db_session.add(AdminAuditLog(admin_user_id=u.id, target_user_id=u.id, field="plan:auto_expire",
                                     old_value="PRO", new_value="FREE", created_at=now - timedelta(hours=4 - i)))
    db_session.commit()
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, rule)] == [paid.id]


def test_first_bind_is_not_crowded_out_by_revived_accounts(db_session, admin, monkeypatch):
    monkeypatch.setattr(ea, "MAX_CANDIDATES_PER_RULE", 2)
    now = _now()
    rule = _rule(db_session, admin, trigger="mt5_first_bind", activated_at=now - timedelta(hours=5))
    for i in range(3):
        u = _user(db_session, f"rev{i}@t.co")
        acc = MT5Account(user_id=u.id, login=f"30{i}")
        db_session.add(acc)
        db_session.commit()
        _bind_event(db_session, u, acc, now - timedelta(hours=4 - i), revived=True)
    first = _user(db_session, "first@t.co")
    acc = MT5Account(user_id=first.id, login="3100")
    db_session.add(acc)
    db_session.commit()
    _bind_event(db_session, first, acc, now - timedelta(minutes=30))
    ea.scan_once(db_session, now)
    assert [s.user_id for s in _sends(db_session, rule)] == [first.id]


def test_queued_users_still_pass_the_send_time_recheck(db_session, admin):
    # 「排除已排队的人」只用于扫描；发送前复核同一个人时不能把他自己排除掉
    # The already-queued exclusion is for scanning only; the send-time recheck must still match
    now = _now()
    rule = _rule(db_session, admin, activated_at=now - timedelta(hours=1))
    u = _user(db_session, "q@t.co", created_at=now - timedelta(minutes=30))
    ea.scan_once(db_session, now)
    assert [c.user_id for c in ea.candidates(db_session, rule, now, None, u.id)] == [u.id]


# ---------- 发送 / sending ----------

def test_claim_fills_variables_and_records(db_session, admin, configured):
    now = _now()
    rule = _rule(db_session, admin, activated_at=now - timedelta(hours=1))
    _user(db_session, "n@t.co", nickname="小明**[x](https://evil.com)**", created_at=now - timedelta(minutes=5))
    ea.scan_once(db_session, now)
    job = ea.claim_next(db_session, now)
    assert isinstance(job, ea.AutoJob) and job.email == "n@t.co"
    assert "小明" in job.message.subject and "{昵称}" not in job.message.html
    assert 'href="https://evil.com' not in job.message.html      # 昵称里的标记不会变成链接
    assert "prismxsignallab.com" in job.message.html
    assert "List-Unsubscribe" in job.message.headers
    ea.record_result(db_session, job, mailer.SendResult(ok=True, status=200), now)
    (s,) = _sends(db_session, rule)
    assert s.status == "sent" and s.sent_at is not None
    assert ea.claim_next(db_session, now) == eb.IDLE


def test_one_automated_email_per_person_per_day_lowest_priority_first(db_session, admin, configured):
    now = _now()
    act = now - timedelta(hours=2)
    later = _rule(db_session, admin, name="B", priority=50, trigger="unverified", delay=60, activated_at=act)
    first = _rule(db_session, admin, name="A", priority=10, activated_at=act)
    _user(db_session, "n@t.co", created_at=now - timedelta(minutes=61))
    ea.scan_once(db_session, now)
    job = ea.claim_next(db_session, now)
    assert job.rule_id == first.id
    ea.record_result(db_session, job, mailer.SendResult(ok=True, status=200), now)
    assert ea.claim_next(db_session, now) == eb.IDLE
    (deferred,) = _sends(db_session, later)
    assert deferred.status == "pending" and deferred.attempts == 0
    assert deferred.due_at >= now + timedelta(hours=23)
    # 满 24 小时后照发 / goes out once the day has passed
    job = ea.claim_next(db_session, now + timedelta(hours=25))
    assert isinstance(job, ea.AutoJob) and job.rule_id == later.id


def test_send_time_recheck_skips_when_condition_is_gone(db_session, admin, configured):
    now = _now()
    rule = _rule(db_session, admin, trigger="no_mt5", delay=60, activated_at=now - timedelta(days=1))
    u = _user(db_session, "n@t.co", created_at=now - timedelta(hours=2))
    ea.scan_once(db_session, now)
    db_session.add(MT5Account(user_id=u.id, login="3001"))
    db_session.commit()
    assert ea.claim_next(db_session, now) == eb.IDLE
    (s,) = _sends(db_session, rule)
    assert (s.status, s.error) == ("skipped", "condition_gone")


def test_opt_out_while_queued_is_honoured(db_session, admin, configured):
    now = _now()
    rule = _rule(db_session, admin, activated_at=now - timedelta(hours=1))
    u = _user(db_session, "n@t.co", created_at=now - timedelta(minutes=5))
    ea.scan_once(db_session, now)
    db_session.add(EmailOptOut(user_id=u.id))
    db_session.commit()
    assert ea.claim_next(db_session, now) == eb.IDLE
    assert _sends(db_session, rule)[0].error == "opted_out"


def test_quota_pauses_automation_and_refunds_the_attempt(db_session, admin, configured):
    now = _now()
    rule = _rule(db_session, admin, activated_at=now - timedelta(hours=1))
    _user(db_session, "n@t.co", created_at=now - timedelta(minutes=5))
    ea.scan_once(db_session, now)
    job = ea.claim_next(db_session, now)
    ea.record_result(db_session, job, mailer.SendResult(ok=False, status=429, quota="daily"), now)
    (s,) = _sends(db_session, rule)
    assert (s.status, s.attempts) == ("pending", 0)
    pause = ea.pause_state(db_session, now)
    assert pause["reason"] == "quota_daily" and pause["until"].date() > now.date()
    assert ea.claim_next(db_session, now) == eb.IDLE
    # 过了 UTC 零点自动恢复 / resumes after UTC midnight
    assert isinstance(ea.claim_next(db_session, pause["until"] + timedelta(minutes=1)), ea.AutoJob)


def test_daily_cap_counts_broadcasts_and_automation_together(db_session, admin, configured, monkeypatch):
    now = _now()
    camp = EmailCampaign(created_by=admin.id, kind="marketing", subject_zh="x", body_zh="y", status="done")
    db_session.add(camp)
    db_session.flush()
    db_session.add(EmailDelivery(campaign_id=camp.id, user_id=admin.id, status="sent", sent_at=now))
    rule = _rule(db_session, admin, activated_at=now - timedelta(hours=1))
    db_session.add(EmailAutomationSend(rule_id=rule.id, user_id=admin.id, occurrence="x", status="sent", sent_at=now))
    db_session.commit()
    assert eb.sent_today(db_session) == 2
    monkeypatch.setattr(settings, "BROADCAST_EMAIL_DAILY_CAP", 2)
    _user(db_session, "n@t.co", created_at=now - timedelta(minutes=5))
    ea.scan_once(db_session, now)
    assert ea.claim_next(db_session, now) == eb.CAP_REACHED


def test_send_loop_takes_automated_email_before_broadcasts(db_session, admin, configured, monkeypatch):
    now = _now()
    camp = EmailCampaign(created_by=admin.id, kind="marketing", subject_zh="群发", body_zh="正文", status="sending")
    db_session.add(camp)
    db_session.flush()
    db_session.add(EmailDelivery(campaign_id=camp.id, user_id=admin.id, status="pending"))
    db_session.commit()
    _rule(db_session, admin, activated_at=now - timedelta(hours=1))
    _user(db_session, "n@t.co", created_at=now - timedelta(minutes=5))
    ea.scan_once(db_session, now)
    monkeypatch.setattr(eb, "SessionLocal", lambda: db_session)
    job = eb._claim_sync()
    assert isinstance(job, ea.AutoJob)
    eb._record_sync(job, mailer.SendResult(ok=True, status=200))
    assert isinstance(eb._claim_sync(), eb.Job)


# ---------- 管理端 / admin endpoints ----------

def test_rules_start_disabled_and_enabling_starts_the_clock(db_session, admin, configured):
    out = router.create_rule(_body(), db=db_session, admin=admin)
    assert out.enabled is False and out.activatedAt is None
    out = router.enable_rule(out.id, db=db_session, admin=admin)
    assert out.enabled and out.activatedAt is not None
    assert db_session.query(AdminAuditLog).filter(AdminAuditLog.field.like("email_auto:%")).count() == 2


def test_disable_and_condition_change_skip_the_queue(db_session, admin, configured):
    now = _now()
    out = router.create_rule(_body(), db=db_session, admin=admin)
    router.enable_rule(out.id, db=db_session, admin=admin)
    rule = db_session.get(EmailAutomation, out.id)
    rule.activated_at = now - timedelta(hours=1)
    db_session.commit()
    _user(db_session, "a@t.co", created_at=now - timedelta(minutes=5))
    ea.scan_once(db_session, now)

    # 只改文字：排队中的不动 / wording only: queue untouched
    body = _body()
    body.content = _content(bodyZh="新的正文 {昵称}")
    router.update_rule(body, out.id, db=db_session, admin=admin)
    assert _sends(db_session, rule)[0].status == "pending"

    # 改了延迟：按新条件从现在算 / the delay changed: start over
    router.update_rule(_body(delay=30), out.id, db=db_session, admin=admin)
    db_session.refresh(rule)
    assert _sends(db_session, rule)[0].error == "rule_changed"
    assert rule.activated_at > now

    _user(db_session, "b@t.co", created_at=_now() - timedelta(minutes=40))
    rule.activated_at = _now() - timedelta(hours=2)
    db_session.commit()
    ea.scan_once(db_session, _now())
    router.disable_rule(out.id, db=db_session, admin=admin)
    assert {s.error for s in _sends(db_session, rule)} == {"rule_changed", "rule_disabled"}


def test_delete_hides_the_rule_but_keeps_its_history(db_session, admin, configured):
    out = router.create_rule(_body(), db=db_session, admin=admin)
    router.delete_rule(out.id, db=db_session, admin=admin)
    assert router.list_rules(db=db_session).rules == []
    assert router.list_sends(out.id, status=None, limit=50, offset=0, db=db_session).total == 0
    with pytest.raises(HTTPException):
        router.enable_rule(out.id, db=db_session, admin=admin)


def test_enabling_needs_a_configured_mailer(db_session, admin, monkeypatch):
    monkeypatch.setattr(settings, "RESEND_API_KEY", "")
    out = router.create_rule(_body(), db=db_session, admin=admin)
    with pytest.raises(HTTPException) as e:
        router.enable_rule(out.id, db=db_session, admin=admin)
    assert e.value.status_code == 400


def test_condition_validation():
    with pytest.raises(ValidationError):
        EmailAutomationConditionIn(trigger="inactive", delayMinutes=60)       # 不到一天
    with pytest.raises(ValidationError):
        EmailAutomationConditionIn(trigger="plan_expiring", delayMinutes=0)   # 到期前 0 分钟
    assert EmailAutomationConditionIn(trigger="signup", maxTimes=3).maxTimes is None


def test_estimate_counts_the_last_week_without_queueing(db_session, admin):
    now = _now()
    _user(db_session, "a@t.co", created_at=now - timedelta(days=2))
    _user(db_session, "b@t.co", created_at=now - timedelta(days=20))
    res = router.estimate_rule(EmailAutomationConditionIn(trigger="signup"), db=db_session)
    assert (res.count, res.days, res.sample) == (1, 7, ["a@t.co"])
    assert _sends(db_session) == []


def test_preview_uses_the_admins_own_details(db_session, admin):
    from app.schemas import EmailAutomationPreviewIn

    res = router.preview_rule(
        EmailAutomationPreviewIn(trigger="plan_expiring", content=_content(bodyZh="{昵称} 还剩 {剩余天数} 天，{到期日期} 到期")),
        db=db_session, admin=admin,
    )
    assert "管理员 还剩 3 天" in res.text
