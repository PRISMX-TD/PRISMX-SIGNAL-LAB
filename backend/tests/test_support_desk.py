"""客服台（rev 41，设计 docs/superpowers/specs/2026-10-17-support-desk-design.md §11）。

覆盖：权限（/support/*、/admin/tickets/* 的 user 403 / support / admin；/admin/* 其他接口 support 仍 403）、
三种视角的脱敏快照、外包查看电话计数与 429、可见范围（未分配看不到、收回后立即看不到）、内部备注不出现
在用户侧、转化自动识别 / 幂等 / 归属 / 改派后归属不变、补偿天数阈值与审批、重置试用终身一次、
降级 / 停用客服后跟进退回与工单解除指派、提醒 / 过期扫描。

Support desk (rev 41) tests per design §11.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.core.security import create_access_token
from app.models import (
    ActivityEvent,
    AdminAuditLog,
    Conversion,
    EmailOptOut,
    FollowUp,
    MT5Account,
    SupportRequest,
    Ticket,
    TicketReply,
    User,
    UserNotification,
)
from app.routers import support, tickets
from app.services import conversions, support_desk
from app.services.settings_store import invalidate_settings_cache, invalidate_support_cache


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    invalidate_support_cache()
    invalidate_settings_cache()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()
        invalidate_support_cache()
        invalidate_settings_cache()


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    """不发真推送、不发 WS、不发信 / no real push, WS or mail."""
    import app.routers.support as sp
    import app.routers.tickets as tk
    import app.services.notification_feed as nf
    import app.services.push_dispatch as pd
    import app.services.email_verification as ev

    monkeypatch.setattr(pd, "dispatch_ticket_reply", lambda *a, **k: None)
    monkeypatch.setattr(pd, "dispatch_event_push", lambda *a, **k: None)
    monkeypatch.setattr(tk, "notify_ws", lambda *a, **k: None)
    monkeypatch.setattr(sp, "notify_ws", lambda *a, **k: None)
    monkeypatch.setattr(nf, "notify_ws", lambda *a, **k: None)
    monkeypatch.setattr(support_desk, "notify_ws", lambda *a, **k: None)
    monkeypatch.setattr(ev, "send_verification_email", lambda *a, **k: None)
    monkeypatch.setattr(ev, "too_many_recent_sends", lambda *a, **k: False)


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _user(db, email, role="user", **kw) -> User:
    kw.setdefault("last_active_at", _now())
    u = User(email=email, api_token="tok_" + email, role=role, **kw)
    db.add(u)
    db.commit()
    return u


def _auth(u: User) -> dict:
    return {"Authorization": "Bearer " + create_access_token(u.id, u.token_version or 0)}


@pytest.fixture()
def client(db):
    from app import main as app_main

    app_main.app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app_main.app)
    finally:
        app_main.app.dependency_overrides.pop(get_db, None)


@pytest.fixture()
def people(db):
    admin = _user(db, "boss@x.com", role="admin", nickname="Boss")
    internal = _user(db, "in@x.com", role="support", support_tier="internal", nickname="Inn")
    outsourced = _user(db, "out@x.com", role="support", support_tier="outsourced", nickname="Outy")
    customer = _user(
        db, "rexlee@gmail.com", phone="+8613812345678", nickname="Rex", plan="FREE",
        email_verified_at=_now(),
    )
    db.add(MT5Account(user_id=customer.id, login="12345678", server="MakeCapital-Live", source="bridge",
                      trade_mode=2, trade_mode_source="server_rule", balance=7200.0, equity=7100.0,
                      company="Make Capital"))
    db.commit()
    return {"admin": admin, "internal": internal, "outsourced": outsourced, "customer": customer}


def _assign(db, admin, staff, user, goal="open_mt5", **kw) -> FollowUp:
    fu = FollowUp(user_id=user.id, assignee_id=staff.id, assigned_by=admin.id, goal=goal,
                  status="pending", expires_at=_now() + timedelta(days=30), **kw)
    db.add(fu)
    db.commit()
    return fu


# ─────────────────────────────────────────────────────────────────────────────
# 权限 / permissions
# ─────────────────────────────────────────────────────────────────────────────
def _calls(router):
    """router 上每条路由 → (method, 填好占位符的路径)。/ every route with placeholders filled."""
    app = FastAPI()
    app.include_router(router, prefix="/api")
    out = []
    for r in app.routes:
        if not isinstance(r, APIRoute):
            continue
        path = r.path
        for name in r.param_convertors:
            path = path.replace("{" + name + "}", "nope")
        for m in r.methods:
            out.append((m, path))
    return out


STAFF_CALLS = _calls(support.router) + _calls(tickets.admin_router)
ADMIN_SUPPORT_CALLS = _calls(support.admin_router)


@pytest.mark.parametrize("method,path", STAFF_CALLS)
def test_staff_endpoints_user_403_support_and_admin_allowed(client, people, method, path):
    for who, allowed in (("customer", False), ("internal", True), ("outsourced", True), ("admin", True)):
        r = client.request(method, path, headers=_auth(people[who]), json={})
        if allowed:
            assert r.status_code != 403 or "客服权限" not in r.text, (who, method, path, r.text)
            assert r.status_code not in (401, 500), (who, method, path, r.text)
        else:
            assert r.status_code == 403, (who, method, path, r.status_code)


@pytest.mark.parametrize("method,path", ADMIN_SUPPORT_CALLS + [
    ("GET", "/api/admin/users"), ("PATCH", "/api/admin/users/nope"), ("GET", "/api/admin/settings"),
    ("GET", "/api/admin/activity"),
])
def test_other_admin_endpoints_still_403_for_support(client, people, method, path):
    for who in ("internal", "outsourced", "customer"):
        r = client.request(method, path, headers=_auth(people[who]), json={})
        assert r.status_code == 403, (who, method, path, r.status_code)
    r = client.request(method, path, headers=_auth(people["admin"]), json={})
    assert r.status_code != 403


# ─────────────────────────────────────────────────────────────────────────────
# 脱敏 / masking
# ─────────────────────────────────────────────────────────────────────────────
def test_three_views_of_the_same_customer(client, db, people):
    c = people["customer"]
    for who in ("internal", "outsourced"):
        _assign(db, people["admin"], people[who], c) if who == "internal" else None
    # 外包另起一条不行（同一用户只能一条进行中）——让工单关联给外包可见
    # Only one active follow-up per user, so the outsourced agent sees the card via a ticket.
    db.add(Ticket(user_id=c.id, title="t", category="account"))
    db.commit()

    cards = {}
    for who in ("admin", "internal", "outsourced"):
        r = client.get(f"/api/support/users/{c.id}", headers=_auth(people[who]))
        assert r.status_code == 200, r.text
        cards[who] = r.json()["customer"]

    a, i, o = cards["admin"], cards["internal"], cards["outsourced"]
    assert a["email"] == i["email"] == "rexlee@gmail.com"
    assert o["email"] == "re***@gmail.com" and o["emailMasked"] is True
    assert a["phone"] == i["phone"] == "+86 13812345678"
    assert o["phone"] == "+86 138****5678" and o["phoneMasked"] is True
    acc_a, acc_i, acc_o = a["mt5Accounts"][0], i["mt5Accounts"][0], o["mt5Accounts"][0]
    assert acc_a["login"] == "12345678" and acc_a["balance"] == 7200.0
    assert acc_i["login"] == "****5678" and acc_i["balanceRange"] == "5k-20k" and "balance" not in acc_i
    assert "login" not in acc_o and "balance" not in acc_o and "balanceRange" not in acc_o
    assert acc_o == {"id": acc_a["id"], "bound": True, "real": True, "broker": "Make Capital",
                     "channel": "bridge", "online": False}
    assert "paidTotalUsd" in a and "paidTotalUsd" not in i and "paidTotalUsd" not in o
    for card in cards.values():
        assert card["nickname"] == "Rex" and card["region"] == "+86" and card["emailVerified"] is True
        for k in ("api_token", "apiToken", "password_hash", "passwordHash", "token_version"):
            assert k not in card
    # 每次查看都记日志 / every view is logged
    assert db.query(ActivityEvent).filter(ActivityEvent.kind == "support.view_customer").count() == 3


def test_outsourced_reveal_counts_and_429(client, db, people):
    c = people["customer"]
    db.add(Ticket(user_id=c.id, title="t", category="account"))
    people["outsourced"].support_reveal_limit = 2
    db.commit()
    h = _auth(people["outsourced"])
    for n in (1, 2):
        r = client.post(f"/api/support/users/{c.id}/reveal-phone", headers=h)
        assert r.status_code == 200 and r.json()["phone"] == "+86 13812345678"
        assert r.json()["revealsToday"] == n and r.json()["revealLimit"] == 2
    r = client.post(f"/api/support/users/{c.id}/reveal-phone", headers=h)
    assert r.status_code == 429
    # 内部客服不计数 / internal staff are uncapped
    for _ in range(3):
        assert client.post(f"/api/support/users/{c.id}/reveal-phone", headers=_auth(people["internal"])).status_code == 200
    assert db.query(ActivityEvent).filter(ActivityEvent.kind == "support.reveal_phone").count() == 5
    me = client.get("/api/support/me", headers=h).json()
    assert me["revealsToday"] == 2 and me["revealLimit"] == 2 and me["watermark"].startswith("Outy · ")


def test_reveal_anomaly_alerts_admin_once(client, db, people):
    c = people["customer"]
    db.add(Ticket(user_id=c.id, title="t", category="account"))
    db.commit()
    from app.services.settings_store import save_support_settings
    save_support_settings(db, {"support_alert_reveal_per_hour": 2})
    db.commit()
    invalidate_support_cache()
    for _ in range(5):
        client.post(f"/api/support/users/{c.id}/reveal-phone", headers=_auth(people["internal"]))
    alerts = db.query(UserNotification).filter(UserNotification.kind == "support_alert",
                                               UserNotification.user_id == people["admin"].id).all()
    assert len(alerts) == 1


# ─────────────────────────────────────────────────────────────────────────────
# 可见范围 / visibility
# ─────────────────────────────────────────────────────────────────────────────
def test_support_cannot_see_unassigned_user_and_loses_view_after_revoke(client, db, people):
    c, staff = people["customer"], people["internal"]
    h = _auth(staff)
    assert client.get(f"/api/support/users/{c.id}", headers=h).status_code == 404
    assert client.get("/api/support/search", params={"q": c.email}, headers=h).json()["results"] == []
    fu = _assign(db, people["admin"], staff, c)
    assert client.get(f"/api/support/users/{c.id}", headers=h).status_code == 200
    assert client.get(f"/api/support/follow-ups/{fu.id}", headers=h).status_code == 200
    assert [x["id"] for x in client.get("/api/support/follow-ups", headers=h).json()["items"]] == [fu.id]
    r = client.post("/api/admin/support/follow-ups/revoke", json={"ids": [fu.id]}, headers=_auth(people["admin"]))
    assert r.json() == {"updated": 1}
    assert client.get(f"/api/support/users/{c.id}", headers=h).status_code == 404
    assert client.get(f"/api/support/follow-ups/{fu.id}", headers=h).status_code == 404
    assert client.get("/api/support/follow-ups", headers=h).json()["items"] == []


def test_ticket_submitter_is_visible_and_searchable_by_ticket_id(client, db, people):
    c = people["customer"]
    t = Ticket(user_id=c.id, title="help", category="account")
    db.add(t)
    db.commit()
    h = _auth(people["outsourced"])
    res = client.get("/api/support/search", params={"q": t.id}, headers=h).json()["results"]
    assert [x["id"] for x in res] == [c.id] and res[0]["email"] == "re***@gmail.com"
    assert client.get(f"/api/support/users/{c.id}", headers=h).status_code == 200
    assert db.query(ActivityEvent).filter(ActivityEvent.kind == "support.search").count() == 1


def test_reassign_moves_the_view(client, db, people):
    c = people["customer"]
    fu = _assign(db, people["admin"], people["internal"], c)
    r = client.post("/api/admin/support/follow-ups/reassign",
                    json={"ids": [fu.id], "assigneeId": people["outsourced"].id}, headers=_auth(people["admin"]))
    assert r.json() == {"updated": 1}
    assert client.get(f"/api/support/users/{c.id}", headers=_auth(people["internal"])).status_code == 404
    assert client.get(f"/api/support/users/{c.id}", headers=_auth(people["outsourced"])).status_code == 200


# ─────────────────────────────────────────────────────────────────────────────
# 工单 / tickets
# ─────────────────────────────────────────────────────────────────────────────
def test_internal_notes_never_reach_user_endpoints(client, db, people):
    c = people["customer"]
    t = Ticket(user_id=c.id, title="help", category="account")
    db.add(t)
    db.commit()
    db.add(TicketReply(ticket_id=t.id, author_id=c.id, body="hi", author_role="user"))
    db.commit()
    hs = _auth(people["internal"])
    r = client.post(f"/api/admin/tickets/{t.id}/reply", json={"body": "SECRET NOTE", "internal": True}, headers=hs)
    assert r.status_code == 200 and any(x["internal"] for x in r.json()["replies"])
    r = client.post(f"/api/admin/tickets/{t.id}/reply", json={"body": "公开回复"}, headers=hs)
    assert r.status_code == 200
    hu = _auth(c)
    detail = client.get(f"/api/tickets/{t.id}", headers=hu).json()
    assert "SECRET NOTE" not in str(detail)
    staff_reply = [x for x in detail["replies"] if x["authorRole"] == "support"]
    assert staff_reply and staff_reply[0]["authorEmail"] == "" and staff_reply[0]["authorName"] == "Inn"
    assert detail["assigneeId"] is None
    lst = client.get("/api/tickets", headers=hu).json()
    assert "SECRET NOTE" not in str(lst) and lst[0]["latestReply"]["body"] == "公开回复"
    rr = client.post(f"/api/tickets/{t.id}/reply", json={"body": "thanks"}, headers=hu)
    assert rr.status_code == 200 and "SECRET NOTE" not in rr.text
    # 内部备注不给用户发通知：只有那条公开回复发了 / only the public reply notified the user
    assert db.query(UserNotification).filter(UserNotification.user_id == c.id).count() == 1


def test_ticket_assign_rules_and_filters(client, db, people):
    c = people["customer"]
    t = Ticket(user_id=c.id, title="help", category="account")
    db.add(t)
    db.commit()
    hi, ho, ha = _auth(people["internal"]), _auth(people["outsourced"]), _auth(people["admin"])
    assert client.post(f"/api/admin/tickets/{t.id}/assign", json={"assigneeId": people["outsourced"].id},
                       headers=hi).status_code == 403
    r = client.post(f"/api/admin/tickets/{t.id}/assign", json={"assigneeId": people["internal"].id}, headers=hi)
    assert r.status_code == 200 and r.json()["assigneeId"] == people["internal"].id
    assert client.post(f"/api/admin/tickets/{t.id}/assign", json={"assigneeId": None}, headers=ho).status_code == 403
    assert [x["id"] for x in client.get("/api/admin/tickets", params={"assignee": "me"}, headers=hi).json()] == [t.id]
    assert client.get("/api/admin/tickets", params={"assignee": "none"}, headers=hi).json() == []
    r = client.post(f"/api/admin/tickets/{t.id}/assign", json={"assigneeId": people["outsourced"].id}, headers=ha)
    assert r.json()["assigneeId"] == people["outsourced"].id
    # 外包看工单列表时提交人邮箱脱敏 / outsourced see the submitter's email masked
    assert client.get("/api/admin/tickets", headers=ho).json()[0]["userEmail"] == "re***@gmail.com"
    # 新回复只通知指派人 + admin / a reply on an assigned ticket notifies assignee + admins only
    db.query(UserNotification).delete()
    db.commit()
    client.post(f"/api/tickets/{t.id}/reply", json={"body": "more"}, headers=_auth(c))
    got = {n.user_id for n in db.query(UserNotification).all()}
    assert got == {people["outsourced"].id, people["admin"].id}


def test_first_reply_claims_unassigned_ticket(client, db, people):
    c = people["customer"]
    t = Ticket(user_id=c.id, title="help", category="account")
    db.add(t)
    db.commit()
    hi, ho = _auth(people["internal"]), _auth(people["outsourced"])
    # 内部备注不认领 / an internal note does not claim
    r = client.post(f"/api/admin/tickets/{t.id}/reply", json={"body": "note", "internal": True}, headers=hi)
    assert r.status_code == 200 and r.json()["assigneeId"] is None
    # 首次回复用户 → 归回复人 / first user-facing reply claims it
    r = client.post(f"/api/admin/tickets/{t.id}/reply", json={"body": "hi"}, headers=hi)
    assert r.json()["assigneeId"] == people["internal"].id
    # 别人再回复不抢走 / a later reply by someone else keeps the owner
    r = client.post(f"/api/admin/tickets/{t.id}/reply", json={"body": "me too"}, headers=ho)
    assert r.json()["assigneeId"] == people["internal"].id


def test_new_ticket_notifies_admins_and_on_duty_support(client, db, people):
    from app.routers import tickets as tk
    tk.user_limiter.enabled = False
    try:
        r = client.post("/api/tickets", json={"title": "x", "category": "account", "body": "b"},
                        headers=_auth(people["customer"]))
    finally:
        tk.user_limiter.enabled = True
    assert r.status_code == 201
    got = {n.user_id for n in db.query(UserNotification).filter(UserNotification.kind == "ticket_new")}
    assert got == {people["admin"].id, people["internal"].id, people["outsourced"].id}


# ─────────────────────────────────────────────────────────────────────────────
# 转化 / conversions
# ─────────────────────────────────────────────────────────────────────────────
def _acc(db, user, login, **kw):
    kw.setdefault("source", "bridge")
    a = MT5Account(user_id=user.id, login=login, **kw)
    db.add(a)
    db.commit()
    return a


@pytest.mark.parametrize("kw,expected", [
    ({"source": "gateway", "server": "", "trade_mode": 2, "trade_mode_source": "group"}, "confirmed"),
    ({"server": "MakeCapital-Live", "trade_mode": 2, "trade_mode_source": "server_rule"}, "confirmed"),
    ({"server": "MakeCapital-Live", "trade_mode": 2, "trade_mode_source": "self"}, "pending_review"),
    ({"server": "MakeCapital-Demo", "trade_mode": 0, "trade_mode_source": "self"}, None),
    ({"server": "OtherBroker-Live", "trade_mode": 2, "trade_mode_source": "server_rule"}, None),
])
def test_mt5_auto_detection_branches(db, kw, expected):
    u = _user(db, "c@x.com")
    acc = _acc(db, u, "777", **kw)
    conv = conversions.record_mt5_bind(db, u.id, acc)
    db.commit()
    if expected is None:
        assert conv is None and db.query(Conversion).count() == 0
    else:
        assert conv.status == expected and conv.kind == "mt5_real"


def test_record_is_idempotent_and_credits_active_follow_up(db, people):
    c, staff = people["customer"], people["internal"]
    fu = _assign(db, people["admin"], staff, c, goal="open_mt5")
    acc = _acc(db, c, "999", server="MakeCapital-Live", trade_mode=2, trade_mode_source="login_rule")
    first = conversions.record_mt5_bind(db, c.id, acc)
    again = conversions.record_mt5_bind(db, c.id, acc)
    db.commit()
    assert first is not None and again is None
    assert db.query(Conversion).filter(Conversion.kind == "mt5_real").count() == 1
    assert first.credited_to == staff.id and first.follow_up_id == fu.id
    db.refresh(fu)
    assert fu.status == "converted" and fu.closed_at is not None


def test_goal_mismatch_credits_but_does_not_convert(db, people):
    c, staff = people["customer"], people["internal"]
    fu = _assign(db, people["admin"], staff, c, goal="renew")
    conv = conversions.record(db, c.id, conversions.KIND_VERIFIED)
    db.commit()
    assert conv.credited_to == staff.id
    db.refresh(fu)
    assert fu.status == "pending"


def test_reassign_does_not_change_recorded_credit(client, db, people):
    c = people["customer"]
    fu = _assign(db, people["admin"], people["internal"], c, goal="renew")
    conv = conversions.record(db, c.id, conversions.KIND_VERIFIED)
    db.commit()
    client.post("/api/admin/support/follow-ups/reassign",
                json={"ids": [fu.id], "assigneeId": people["outsourced"].id}, headers=_auth(people["admin"]))
    db.refresh(conv)
    assert conv.credited_to == people["internal"].id
    later = conversions.record(db, c.id, conversions.KIND_PAID)
    db.commit()
    assert later.credited_to == people["outsourced"].id
    db.refresh(fu)
    assert fu.status == "converted"


def test_verify_hook_records_conversion(db):
    from app.services.email_verification import mark_verified
    u = _user(db, "v@x.com")
    mark_verified(db, u)
    mark_verified(db, u)
    db.commit()
    assert db.query(Conversion).filter(Conversion.user_id == u.id, Conversion.kind == "signallab_verified").count() == 1


def test_pending_review_conversion_approval_converts_follow_up(client, db, people):
    c, staff = people["customer"], people["internal"]
    fu = _assign(db, people["admin"], staff, c, goal="open_mt5")
    acc = _acc(db, c, "4242", server="MakeCapital-Live", trade_mode=2, trade_mode_source="self")
    conv = conversions.record_mt5_bind(db, c.id, acc)
    db.commit()
    db.refresh(fu)
    assert conv.status == "pending_review" and fu.status == "pending"
    r = client.post(f"/api/admin/support/conversions/{conv.id}/review", json={"approve": True},
                    headers=_auth(people["admin"]))
    assert r.status_code == 200 and r.json()["conversion"]["status"] == "confirmed"
    db.refresh(fu)
    assert fu.status == "converted"


def test_manual_conversion_request_flow(client, db, people):
    c, staff = people["customer"], people["internal"]
    _assign(db, people["admin"], staff, c, goal="open_mt5")
    r = client.post(f"/api/support/users/{c.id}/conversion-request",
                    json={"server": "MakeCapital-Live", "login": "55555"}, headers=_auth(staff))
    req_id = r.json()["request"]["id"]
    r = client.post(f"/api/admin/support/requests/{req_id}/approve", json={}, headers=_auth(people["admin"]))
    assert r.status_code == 200
    conv = db.get(Conversion, r.json()["result"]["conversionId"])
    assert conv.source == "manual" and conv.credited_to == staff.id and conv.status == "confirmed"


def test_backfill_is_idempotent(db, people):
    from app.services.conversions import backfill_conversions
    engine = db.get_bind()
    first = backfill_conversions(engine)
    second = backfill_conversions(engine)
    assert first["signallab_register"] == 4 and first["mt5_real"] == 1 and first["signallab_verified"] == 1
    assert sum(second.values()) == 0


# ─────────────────────────────────────────────────────────────────────────────
# 受限操作 / restricted actions
# ─────────────────────────────────────────────────────────────────────────────
def test_comp_days_threshold_and_approval(client, db, people):
    c, staff = people["customer"], people["internal"]
    _assign(db, people["admin"], staff, c)
    h = _auth(staff)
    r = client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 7, "reason": "宕机补偿"}, headers=h)
    assert r.status_code == 200 and r.json()["applied"] is True
    db.refresh(c)
    assert c.plan == "PRO" and c.plan_expires_at is not None
    first_exp = c.plan_expires_at
    audit = db.query(AdminAuditLog).filter(AdminAuditLog.target_user_id == c.id).all()
    assert {a.field for a in audit} >= {"plan", "plan_expires_at"} and all(a.admin_user_id == staff.id for a in audit)

    r = client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 8, "reason": "多补"}, headers=h)
    body = r.json()
    assert body["applied"] is False and body["request"]["status"] == "pending"
    db.refresh(c)
    assert c.plan_expires_at == first_exp
    r = client.post(f"/api/admin/support/requests/{body['request']['id']}/approve", json={}, headers=_auth(people["admin"]))
    assert r.status_code == 200
    db.refresh(c)
    assert (c.plan_expires_at - first_exp).days == 8
    # 二次审批 409 / second approval conflicts
    assert client.post(f"/api/admin/support/requests/{body['request']['id']}/approve", json={},
                       headers=_auth(people["admin"])).status_code == 409
    # admin 不受上限 / admins are uncapped
    r = client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 30, "reason": "x"}, headers=_auth(people["admin"]))
    assert r.json()["applied"] is True


def test_reset_trial_once_for_support_unlimited_for_admin(client, db, people):
    c = people["customer"]
    _assign(db, people["admin"], people["internal"], c)
    c.trial_used_at = _now()
    db.commit()
    h = _auth(people["internal"])
    assert client.post(f"/api/support/users/{c.id}/reset-trial", json={}, headers=h).status_code == 200
    db.refresh(c)
    assert c.trial_used_at is None
    c.trial_used_at = _now()
    db.commit()
    assert client.post(f"/api/support/users/{c.id}/reset-trial", json={}, headers=h).status_code == 409
    ha = _auth(people["admin"])
    for _ in range(2):
        assert client.post(f"/api/support/users/{c.id}/reset-trial", json={}, headers=ha).status_code == 200
        c.trial_used_at = _now()
        db.commit()


def test_unbind_requires_reason_and_logs(client, db, people):
    c, staff = people["customer"], people["internal"]
    _assign(db, people["admin"], staff, c)
    acc = db.query(MT5Account).filter(MT5Account.user_id == c.id).one()
    h = _auth(staff)
    assert client.post(f"/api/support/users/{c.id}/mt5/{acc.id}/unbind", json={}, headers=h).status_code == 422
    r = client.post(f"/api/support/users/{c.id}/mt5/{acc.id}/unbind", json={"reason": "换券商"}, headers=h)
    assert r.status_code == 200
    db.refresh(acc)
    assert acc.revoked_reason is not None
    kinds = {e.kind: e for e in db.query(ActivityEvent).all()}
    assert "mt5.unbind" in kinds and kinds["support.action"].actor_type == "support"


def test_resend_verification(client, db, people):
    c = people["customer"]
    c.email_verified_at = None
    db.add(Ticket(user_id=c.id, title="收不到验证信", category="account"))
    db.commit()
    r = client.post(f"/api/support/users/{c.id}/resend-verification", headers=_auth(people["outsourced"]))
    assert r.status_code == 200 and r.json() == {"ok": True, "alreadyVerified": False}


def test_do_not_contact_closes_and_blocks_assignment(client, db, people):
    c, staff = people["customer"], people["internal"]
    fu = _assign(db, people["admin"], staff, c)
    assert client.post(f"/api/support/users/{c.id}/do-not-contact", headers=_auth(staff)).status_code == 200
    db.refresh(fu)
    assert fu.status == "no_interest"
    other = _user(db, "o@x.com")
    db.add(EmailOptOut(user_id=other.id))
    db.commit()
    r = client.post("/api/admin/support/follow-ups", headers=_auth(people["admin"]), json={
        "userIds": [c.id, other.id], "assigneeId": staff.id, "goal": "open_mt5"})
    assert r.json()["created"] == []
    assert {s["reason"] for s in r.json()["skipped"]} == {"do_not_contact", "opted_out"}
    r = client.post("/api/admin/support/follow-ups", headers=_auth(people["admin"]), json={
        "userIds": [other.id], "assigneeId": staff.id, "goal": "open_mt5", "includeOptedOut": True})
    assert len(r.json()["created"]) == 1
    r = client.post("/api/admin/support/follow-ups", headers=_auth(people["admin"]), json={
        "userIds": [other.id], "assigneeId": staff.id, "goal": "open_mt5", "includeOptedOut": True})
    assert r.json()["skipped"] == [{"userId": other.id, "reason": "active_follow_up"}]


def test_message_creates_follow_up_ticket(client, db, people):
    c, staff = people["customer"], people["outsourced"]
    _assign(db, people["admin"], staff, c)
    r = client.post(f"/api/support/users/{c.id}/message", json={"title": "开户指引", "body": "您好"},
                    headers=_auth(staff))
    assert r.status_code == 200
    t = db.get(Ticket, r.json()["ticket"]["id"])
    assert t.category == "follow_up" and t.assignee_id == staff.id and t.user_id == c.id
    mine = client.get("/api/tickets", headers=_auth(c)).json()
    assert mine[0]["category"] == "follow_up" and mine[0]["latestReply"]["authorEmail"] == ""


def test_follow_up_notes_and_status(client, db, people):
    c, staff = people["customer"], people["internal"]
    fu = _assign(db, people["admin"], staff, c)
    h = _auth(staff)
    r = client.post(f"/api/support/follow-ups/{fu.id}/notes", json={"channel": "phone", "content": "打过电话"}, headers=h)
    assert r.status_code == 200 and r.json()["followUp"]["status"] == "contacted"
    r = client.patch(f"/api/support/follow-ups/{fu.id}", json={"status": "interested",
                     "nextContactAt": (_now() + timedelta(days=1)).isoformat()}, headers=h)
    assert r.json()["followUp"]["status"] == "interested"
    stats = client.get("/api/admin/support/stats", headers=_auth(people["admin"])).json()
    row = next(x for x in stats["items"] if x["staffId"] == staff.id)
    assert row["assigned"] == 1 and row["contacted"] == 1 and row["interested"] == 1
    assert row["avgFirstContactHours"] is not None


# ─────────────────────────────────────────────────────────────────────────────
# 降级 / 停用 / demotion and disable
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("how", ["demote", "disable"])
def test_removing_support_releases_follow_ups_and_tickets(client, db, people, how):
    c, staff = people["customer"], people["internal"]
    fu = _assign(db, people["admin"], staff, c)
    t = Ticket(user_id=c.id, title="t", category="account", assignee_id=staff.id)
    db.add(t)
    db.commit()
    ha = _auth(people["admin"])
    if how == "demote":
        r = client.patch(f"/api/admin/users/{staff.id}", json={"role": "user"}, headers=ha)
    else:
        r = client.post(f"/api/admin/users/{staff.id}/disable", json={"reason": "离职"}, headers=ha)
    assert r.status_code == 200, r.text
    db.refresh(fu)
    db.refresh(t)
    assert fu.status == "revoked" and t.assignee_id is None
    # 用户回到待分配池：可以再分配给别人 / the user is assignable again
    r = client.post("/api/admin/support/follow-ups", headers=ha, json={
        "userIds": [c.id], "assigneeId": people["outsourced"].id, "goal": "revisit"})
    assert len(r.json()["created"]) == 1


def test_admin_patch_sets_support_role_and_tier(client, db, people):
    u = _user(db, "new@x.com")
    r = client.patch(f"/api/admin/users/{u.id}", json={"role": "support", "supportTier": "internal"},
                     headers=_auth(people["admin"]))
    assert r.status_code == 200 and r.json()["role"] == "support" and r.json()["supportTier"] == "internal"
    fields = {a.field for a in db.query(AdminAuditLog).filter(AdminAuditLog.target_user_id == u.id)}
    assert {"role", "support_tier"} <= fields
    members = client.get("/api/admin/support/members", headers=_auth(people["admin"])).json()["items"]
    assert u.id in {m["id"] for m in members}


def test_null_tier_is_treated_as_outsourced(client, db, people):
    s = _user(db, "notier@x.com", role="support")
    c = people["customer"]
    db.add(Ticket(user_id=c.id, title="t", category="account"))
    db.commit()
    card = client.get(f"/api/support/users/{c.id}", headers=_auth(s)).json()["customer"]
    assert card["emailMasked"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 提醒 / 过期扫描 / reminder and expiry sweep
# ─────────────────────────────────────────────────────────────────────────────
def test_sweep_reminders_are_deduped_and_expiry_notifies(db, people):
    c, staff = people["customer"], people["internal"]
    other = _user(db, "o2@x.com")
    due = _assign(db, people["admin"], staff, c, next_contact_at=_now() - timedelta(minutes=1))
    old = FollowUp(user_id=other.id, assignee_id=staff.id, assigned_by=people["admin"].id, goal="revisit",
                   status="contacted", expires_at=_now() - timedelta(minutes=1))
    db.add(old)
    db.commit()
    first = support_desk.sweep_follow_ups(db=db)
    assert first == {"expired": 1, "assigned": 1, "due": 1, "expiring": 0}
    second = support_desk.sweep_follow_ups(db=db)
    assert second == {"expired": 0, "assigned": 0, "due": 0, "expiring": 0}
    db.refresh(old)
    assert old.status == "expired"
    admin_alerts = db.query(UserNotification).filter(UserNotification.user_id == people["admin"].id,
                                                     UserNotification.kind == "support_alert").count()
    assert admin_alerts == 1
    # 延期后「即将过期」重新提醒 / extending re-arms the expiring reminder
    due.expires_at = _now() + timedelta(days=2)
    db.commit()
    assert support_desk.sweep_follow_ups(db=db)["expiring"] == 1


def test_templates_admin_crud_and_staff_read(client, db, people):
    ha = _auth(people["admin"])
    t = client.post("/api/admin/support/templates", json={"title": "问候", "body": "您好", "lang": "zh"}, headers=ha).json()
    assert client.get("/api/support/templates", headers=_auth(people["outsourced"])).json()["items"][0]["id"] == t["template"]["id"]
    assert client.post("/api/admin/support/templates", json={"title": "x", "body": "y"},
                       headers=_auth(people["internal"])).status_code == 403


def test_settings_roundtrip(client, db, people):
    ha = _auth(people["admin"])
    r = client.put("/api/admin/support/settings", json={"support_comp_days_max": 3}, headers=ha)
    assert r.json()["support_comp_days_max"] == 3
    assert client.get("/api/admin/support/settings", headers=ha).json()["support_comp_days_max"] == 3
    assert db.query(AdminAuditLog).filter(AdminAuditLog.field == "setting:support:support_comp_days_max").count() == 1


def test_follow_up_request_approval_creates_follow_up(client, db, people):
    c = people["customer"]
    db.add(Ticket(user_id=c.id, title="想开户", category="account"))
    db.commit()
    r = client.post(f"/api/support/users/{c.id}/follow-up-request", json={"goal": "open_mt5"},
                    headers=_auth(people["outsourced"]))
    req_id = r.json()["request"]["id"]
    pending = client.get("/api/admin/support/requests", headers=_auth(people["admin"])).json()["items"]
    assert [p["id"] for p in pending] == [req_id]
    r = client.post(f"/api/admin/support/requests/{req_id}/approve", json={}, headers=_auth(people["admin"]))
    fu = db.get(FollowUp, r.json()["result"]["followUpId"])
    assert fu.assignee_id == people["outsourced"].id and fu.goal == "open_mt5"
    assert db.get(SupportRequest, req_id).status == "approved"


def test_picker_agent_filter(client, db, people):
    from app.models import InviteLink, InviteLinkAgent
    agent = people["internal"]
    link = InviteLink(code="AGT1", label="agent link")
    db.add(link)
    db.flush()
    db.add(InviteLinkAgent(link_id=link.id, user_id=agent.id))
    via = _user(db, "via@x.com", invite_code="AGT1")
    db.commit()
    ha = _auth(people["admin"])
    assert [a["id"] for a in client.get("/api/admin/emails/agents", headers=ha).json()["agents"]] == [agent.id]
    got = {u["id"] for u in client.get("/api/admin/emails/users", params={"agent": agent.id}, headers=ha).json()["users"]}
    assert got == {via.id}
    none = {u["id"] for u in client.get("/api/admin/emails/users", params={"agent": "none", "limit": 100}, headers=ha).json()["users"]}
    assert via.id not in none and people["customer"].id in none


def test_unreachable_stays_active(client, db, people):
    fu = _assign(db, people["admin"], people["internal"], people["customer"])
    r = client.patch(f"/api/support/follow-ups/{fu.id}", json={"status": "unreachable"}, headers=_auth(people["internal"]))
    assert r.status_code == 200 and r.json()["followUp"]["active"] is True
    r = client.patch(f"/api/support/follow-ups/{fu.id}", json={"status": "contacted"}, headers=_auth(people["internal"]))
    assert r.status_code == 200
