"""管理后台群发邮件。

钉住的都是「写错了不报错、只会悄悄出事」的那一类：
- 停用的、退订了的人收到推广邮件（合规与送达率一起出事）；
- 同一封群发给同一个人发两次（领导权切换、进程重启、连点）；
- 发信商拒绝的是我们的配置，却把整张名单一个个标成失败；
- 退订链接能被伪造，或被安全网关的预抓取误触发；
- 管理员写的正文里混进可执行的 HTML。

照仓库惯例走 service 级测试：直接调函数，Depends 当普通参数传。
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, HTTPException
from starlette.requests import Request

from app.core import rate_limit
from app.core.config import settings
from app.models import AdminAuditLog, EmailCampaign, EmailDelivery, EmailOptOut, User
from app.routers import emails as emails_router
from app.schemas import EmailAudienceIn, EmailCampaignIn, EmailContentIn
from app.services import email_broadcast as eb
from app.services import mailer
from app.services.deps import require_admin


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _user(db, email, **kw) -> User:
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


def _content(**kw) -> EmailContentIn:
    base = {"subjectZh": "新功能上线", "bodyZh": "你好\n\n看看 https://prismxsignallab.com 吧。"}
    base.update(kw)
    return EmailContentIn(**base)


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(settings, "RESEND_API_KEY", "re_test")
    monkeypatch.setattr(settings, "BROADCAST_EMAIL_DAILY_CAP", 0)
    monkeypatch.setattr(rate_limit.limiter, "enabled", False)


def _campaign(db, admin, audience=None, **content_kw):
    body = EmailCampaignIn(content=_content(**content_kw), audience=audience or EmailAudienceIn())
    return emails_router.create_campaign(body, db=db, admin=admin)


# ---------- 守卫 / guard ----------

def test_admin_router_guards_itself():
    app = FastAPI()
    app.include_router(emails_router.admin_router)   # 刻意不传 dependencies
    routes = [r for r in app.routes if getattr(r, "dependant", None) is not None]
    assert routes
    for r in routes:
        assert require_admin in {d.call for d in r.dependant.dependencies}, r.path


# ---------- 渲染 / rendering ----------

def test_body_html_is_escaped_and_only_http_links_become_anchors():
    html = eb.render_body_html('<script>alert(1)</script> [点我](javascript:alert(1)) **重点**')
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert 'href="javascript' not in html
    assert "<strong>重点</strong>" in html


def test_links_and_trailing_punctuation():
    html = eb.render_body_html("看这里：https://a.com/x。还有 [文档](https://b.com/doc?a=1&b=2)")
    assert 'href="https://a.com/x"' in html      # 句号不算进链接
    assert 'href="https://b.com/doc?a=1&amp;b=2"' in html
    assert ">文档</a>" in html
    text = eb.render_body_text("还有 [文档](https://b.com/doc) **粗**")
    assert "文档 (https://b.com/doc)" in text and "**" not in text


def test_bilingual_message_and_unsubscribe_headers():
    content = eb.Content("marketing", "中文标题", "中文正文", "English", "English body")
    msg = eb.build_message(content, "https://api.example.com/api/email/unsubscribe?t=abc")
    assert msg.subject == "中文标题 / English"
    assert msg.html.index("中文正文") < msg.html.index("English body")
    assert msg.headers["List-Unsubscribe"] == "<https://api.example.com/api/email/unsubscribe?t=abc>"
    assert msg.headers["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
    assert "退订" in msg.html and "Unsubscribe" in msg.html


def test_notice_has_no_unsubscribe():
    msg = eb.build_message(eb.Content("notice", "维护通知", "今晚维护", "", ""), None)
    assert msg.headers == {}
    assert "服务通知" in msg.html and "Unsubscribe" not in msg.html


def test_content_validation():
    with pytest.raises(ValueError):
        EmailContentIn(subjectZh="", bodyZh="")
    with pytest.raises(ValueError):        # 英文填了一半
        EmailContentIn(subjectZh="a", bodyZh="b", subjectEn="only subject")
    c = EmailContentIn(subjectZh="换\n行", bodyZh="b")
    assert c.subjectZh == "换 行"          # 标题里的换行是邮件头注入


# ---------- 退订令牌 / unsubscribe tokens ----------

def test_unsubscribe_token_roundtrip_and_tamper():
    tok = eb.make_unsubscribe_token("user-123")
    assert eb.read_unsubscribe_token(tok) == "user-123"
    uid, _, sig = tok.partition(".")
    forged = eb.make_unsubscribe_token("someone-else").partition(".")[0] + "." + sig
    assert eb.read_unsubscribe_token(forged) is None
    assert eb.read_unsubscribe_token(uid + "." + "0" * 32) is None
    assert eb.read_unsubscribe_token("garbage") is None
    assert eb.read_unsubscribe_token(None) is None


# ---------- 收件人 / audience ----------

def test_marketing_excludes_disabled_and_opted_out_notice_ignores_opt_out(db_session):
    _user(db_session, "ok@t.co")
    _user(db_session, "banned@t.co", disabled_at=_now())
    out = _user(db_session, "out@t.co")
    db_session.add(EmailOptOut(user_id=out.id))
    db_session.commit()

    s = eb.audience_summary(db_session, "marketing", EmailAudienceIn())
    assert s["count"] == 1 and s["excludedDisabled"] == 1 and s["excludedOptedOut"] == 1
    assert s["sample"] == ["ok@t.co"]

    s = eb.audience_summary(db_session, "notice", EmailAudienceIn())
    assert s["count"] == 2 and s["excludedOptedOut"] == 0     # 通知不看退订，但仍不发给停用的人


def test_plan_and_activity_filters(db_session):
    _user(db_session, "free@t.co", plan="FREE", last_active_at=_now())
    _user(db_session, "trial@t.co", plan="PRO", plan_is_trial=True, last_active_at=_now() - timedelta(days=60))
    _user(db_session, "paid@t.co", plan="PRO", plan_is_trial=False)   # 从没活跃过

    def emails(**kw):
        q = eb.eligible_query(db_session, "marketing", EmailAudienceIn(**kw))
        return sorted(u.email for u in q)

    assert emails(plan="TRIAL") == ["trial@t.co"]
    assert emails(plan="PAID") == ["paid@t.co"]
    assert emails(activeWithinDays=7) == ["free@t.co"]
    # 「超过 30 天没活跃」要把从没活跃过的人算进去
    assert emails(inactiveForDays=30) == ["paid@t.co", "trial@t.co"]


def test_list_mode_matches_registered_users_only(db_session):
    a = _user(db_session, "a@t.co")
    _user(db_session, "b@t.co")
    s = eb.audience_summary(
        db_session, "marketing",
        EmailAudienceIn(mode="list", userIds=[a.id], emails=["B@t.co ", "stranger@x.com"]),
    )
    assert s["count"] == 2 and s["unmatchedEmails"] == 1


# ---------- 发起 / create ----------

def test_create_enqueues_audits_and_blocks_double_submit(db_session, configured):
    admin = _user(db_session, "admin@t.co", role="admin")
    _user(db_session, "u1@t.co")
    out = _campaign(db_session, admin)
    assert out.total == 2 and out.pending == 2 and out.status == "sending"
    assert db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "email:send").count() == 1
    with pytest.raises(HTTPException) as err:
        _campaign(db_session, admin)
    assert err.value.status_code == 409


def test_create_refuses_when_nobody_matches_or_not_configured(db_session, configured, monkeypatch):
    admin = _user(db_session, "admin@t.co", role="admin")
    with pytest.raises(HTTPException) as err:
        _campaign(db_session, admin, audience=EmailAudienceIn(plan="PAID"))
    assert err.value.status_code == 400
    assert db_session.query(EmailCampaign).count() == 0      # 没人可发就不留空壳

    monkeypatch.setattr(settings, "RESEND_API_KEY", "")
    with pytest.raises(HTTPException):
        _campaign(db_session, admin)


# ---------- 发送 / sending ----------

def test_claim_skips_people_who_opted_out_after_enqueue(db_session, configured):
    admin = _user(db_session, "admin@t.co", role="admin")
    u = _user(db_session, "u@t.co")
    _campaign(db_session, admin)
    db_session.add(EmailOptOut(user_id=u.id))
    db_session.commit()

    job = eb.claim_next(db_session)
    assert job.email == "admin@t.co"
    assert "unsubscribe?t=" in job.message.headers["List-Unsubscribe"]
    eb.record_result(db_session, job, mailer.SendResult(ok=True, status=200))

    assert eb.claim_next(db_session) == eb.IDLE
    rows = {r.user_id: (r.status, r.error) for r in db_session.query(EmailDelivery)}
    assert rows[u.id] == ("skipped", "opted_out")
    assert db_session.query(EmailCampaign).one().status == "done"


def test_a_claimed_row_cannot_be_claimed_again(db_session, configured):
    admin = _user(db_session, "admin@t.co", role="admin")
    _campaign(db_session, admin)
    first = eb.claim_next(db_session)
    assert isinstance(first, eb.Job)
    # 结果还没落：另一个进程此刻来认领，拿不到同一行
    assert eb.claim_next(db_session) == eb.IDLE


def test_stale_claims_are_failed_not_resent(db_session, configured):
    admin = _user(db_session, "admin@t.co", role="admin")
    _campaign(db_session, admin)
    job = eb.claim_next(db_session)
    row = db_session.get(EmailDelivery, job.delivery_id)
    row.claimed_at = _now() - timedelta(minutes=eb.STALE_CLAIM_MINUTES + 1)
    db_session.commit()

    assert eb.claim_next(db_session) == eb.IDLE
    db_session.refresh(row)
    assert (row.status, row.error) == ("failed", "interrupted")


def test_retryable_failures_retry_then_give_up(db_session, configured):
    admin = _user(db_session, "admin@t.co", role="admin")
    _campaign(db_session, admin)
    for attempt in range(1, eb.MAX_ATTEMPTS + 1):
        job = eb.claim_next(db_session)
        assert isinstance(job, eb.Job), attempt
        eb.record_result(db_session, job, mailer.SendResult(ok=False, status=503, retryable=True))
    row = db_session.query(EmailDelivery).one()
    assert (row.status, row.attempts, row.error) == ("failed", eb.MAX_ATTEMPTS, "http_503")


def test_config_error_pauses_the_campaign_without_failing_recipients(db_session, configured):
    admin = _user(db_session, "admin@t.co", role="admin")
    _user(db_session, "u@t.co")
    _campaign(db_session, admin)
    job = eb.claim_next(db_session)
    eb.record_result(db_session, job, mailer.SendResult(ok=False, status=403, config_error=True))

    c = db_session.query(EmailCampaign).one()
    assert c.status == "paused" and c.last_error == "provider_rejected_403"
    assert {r.status for r in db_session.query(EmailDelivery)} == {"pending"}
    assert db_session.get(EmailDelivery, job.delivery_id).attempts == 0
    assert eb.claim_next(db_session) == eb.IDLE           # 暂停中不发

    emails_router.resume_campaign(c.id, db=db_session, admin=admin)
    assert isinstance(eb.claim_next(db_session), eb.Job)


def test_daily_cap(db_session, configured, monkeypatch):
    admin = _user(db_session, "admin@t.co", role="admin")
    _user(db_session, "u@t.co")
    _campaign(db_session, admin)
    monkeypatch.setattr(settings, "BROADCAST_EMAIL_DAILY_CAP", 1)
    job = eb.claim_next(db_session)
    eb.record_result(db_session, job, mailer.SendResult(ok=True, status=200))
    assert eb.claim_next(db_session) == eb.CAP_REACHED


def test_cancel_skips_the_rest(db_session, configured):
    admin = _user(db_session, "admin@t.co", role="admin")
    _user(db_session, "u@t.co")
    out = _campaign(db_session, admin)
    job = eb.claim_next(db_session)                        # 一封在发的途中
    res = emails_router.cancel_campaign(out.id, db=db_session, admin=admin)
    assert res.status == "cancelled" and res.skipped == 1
    # 在发的那封失败了也不再排队
    eb.record_result(db_session, job, mailer.SendResult(ok=False, status=500, retryable=True))
    assert db_session.get(EmailDelivery, job.delivery_id).status == "skipped"
    assert eb.claim_next(db_session) == eb.IDLE


def test_nothing_is_sent_when_mail_is_not_configured(db_session, configured, monkeypatch):
    admin = _user(db_session, "admin@t.co", role="admin")
    _campaign(db_session, admin)
    monkeypatch.setattr(settings, "RESEND_API_KEY", "")
    assert eb.claim_next(db_session) == eb.IDLE
    assert db_session.query(EmailDelivery).one().status == "pending"


def test_drain_once_sends_and_records(db_session, configured, monkeypatch):
    admin = _user(db_session, "admin@t.co", role="admin")
    _campaign(db_session, admin)
    sent = []
    async def inline(fn, *a, **k):     # 内存库按线程隔离，测试里不换线程 / in-memory DB is per-thread
        return fn(*a, **k)

    monkeypatch.setattr(eb, "run_in_threadpool", inline)
    monkeypatch.setattr(eb, "_claim_sync", lambda: eb.claim_next(db_session))
    monkeypatch.setattr(eb, "_record_sync", lambda job, r: eb.record_result(db_session, job, r))
    monkeypatch.setattr(mailer, "deliver", lambda to, *a, **k: sent.append(to) or mailer.SendResult(ok=True, status=200))
    monkeypatch.setattr(settings, "BROADCAST_EMAIL_INTERVAL_SECONDS", 0)
    assert asyncio.run(eb.drain_once()) == eb.IDLE_SECONDS
    assert sent == ["admin@t.co"]
    assert db_session.query(EmailDelivery).one().status == "sent"


# ---------- 退订页 / unsubscribe page ----------

def _request(method="POST", body=b"", qs=""):
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {
        "type": "http", "method": method, "path": "/email/unsubscribe", "query_string": qs.encode(),
        "headers": [(b"content-type", b"application/x-www-form-urlencoded")],
        "client": ("127.0.0.1", 1), "server": ("test", 80), "scheme": "https",
    }
    return Request(scope, receive)


def test_get_only_shows_a_button_post_unsubscribes(db_session, configured):
    u = _user(db_session, "u@t.co")
    tok = eb.make_unsubscribe_token(u.id)
    page = emails_router.unsubscribe_page(_request("GET"), t=tok)
    assert page.status_code == 200 and b'method="post"' in page.body
    assert db_session.get(EmailOptOut, u.id) is None       # 预抓取不能退订

    res = asyncio.run(emails_router.unsubscribe(_request(body=f"t={tok}".encode()), db=db_session))
    assert res.status_code == 200 and b"resubscribe" in res.body
    assert db_session.get(EmailOptOut, u.id) is not None

    asyncio.run(emails_router.resubscribe(_request(body=f"t={tok}".encode()), db=db_session))
    assert db_session.get(EmailOptOut, u.id) is None


def test_one_click_post_with_token_in_query(db_session, configured):
    u = _user(db_session, "u@t.co")
    tok = eb.make_unsubscribe_token(u.id)
    res = asyncio.run(emails_router.unsubscribe(
        _request(body=b"List-Unsubscribe=One-Click", qs=f"t={tok}"), db=db_session,
    ))
    assert res.status_code == 200
    assert db_session.get(EmailOptOut, u.id) is not None


def test_forged_token_is_rejected(db_session, configured):
    u = _user(db_session, "u@t.co")
    res = asyncio.run(emails_router.unsubscribe(_request(body=f"t={u.id}.deadbeef".encode()), db=db_session))
    assert res.status_code == 400
    assert db_session.get(EmailOptOut, u.id) is None
