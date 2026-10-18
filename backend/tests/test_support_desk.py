"""客服台（rev 41，设计 docs/superpowers/specs/2026-10-17-support-desk-design.md §11）。

覆盖：权限（/support/*、/admin/tickets/* 的 user 403 / support / admin；/admin/* 其他接口 support 仍 403）、
三种视角的脱敏快照、外包查看电话计数与 429、可见范围（未分配看不到、收回后立即看不到）、内部备注不出现
在用户侧、转化自动识别 / 幂等 / 归属 / 改派后归属不变、补偿天数阈值与审批、重置试用终身一次、
降级 / 停用客服后跟进退回与工单解除指派、提醒 / 过期扫描。

Support desk (rev 41) tests per design §11.
"""
import json
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
    FollowUpNote,
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


# 删工单只有管理员能做，从「客服也能用」的清单里拿出来，放进只给管理员的那组
# deleting a ticket is admin-only, so it moves from the staff list to the admin-only one
ADMIN_ONLY_TICKET_CALLS = [("DELETE", "/api/admin/tickets/nope")]
STAFF_CALLS = [c for c in _calls(support.router) + _calls(tickets.admin_router) if c not in ADMIN_ONLY_TICKET_CALLS]
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


@pytest.mark.parametrize("method,path", ADMIN_SUPPORT_CALLS + ADMIN_ONLY_TICKET_CALLS + [
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
    assert fu.status == "converted" and fu.closed_at is None  # 标签，不结束 / label, stays open


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
    assert fu.status == "revoked"
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
    for st in ("no_interest", "converted", "contacted"):
        r = client.patch(f"/api/support/follow-ups/{fu.id}", json={"status": st}, headers=_auth(people["internal"]))
        assert r.status_code == 200 and r.json()["followUp"]["active"] is True


def test_awaiting_reply_tab_skips_closed(client, db, people):
    c = people["customer"]
    open_t = Ticket(user_id=c.id, title="open", category="account")
    closed_t = Ticket(user_id=c.id, title="closed", category="account", status="closed")
    db.add_all([open_t, closed_t])
    db.commit()
    got = [x["id"] for x in client.get("/api/admin/tickets", params={"assignee": "none", "status": "active"},
                                       headers=_auth(people["internal"])).json()]
    assert got == [open_t.id]


# ─────────────────────────────────────────────────────────────────────────────
# admin：跟进进度与完整记录 / admin: follow-up progress and records
# ─────────────────────────────────────────────────────────────────────────────
def _note(db, fu, author, at, content="记录", channel="phone") -> FollowUpNote:
    n = FollowUpNote(follow_up_id=fu.id, author_id=author.id, channel=channel, content=content, created_at=at)
    db.add(n)
    db.commit()
    return n


def test_admin_follow_up_list_activity_sort_and_note_fields(client, db, people):
    admin, staff = people["admin"], people["internal"]
    c2, c3, c4 = _user(db, "c2@x.com"), _user(db, "c3@x.com"), _user(db, "c4@x.com")
    now = _now()
    old = _assign(db, admin, staff, people["customer"], created_at=now - timedelta(days=5))
    new = _assign(db, admin, staff, c2, created_at=now - timedelta(days=1))
    idle = _assign(db, admin, staff, c3, created_at=now - timedelta(days=4))
    closed = _assign(db, admin, staff, c4, created_at=now - timedelta(days=10))
    closed.status, closed.closed_at = "revoked", now
    db.commit()
    _note(db, old, staff, now - timedelta(days=2), content="first")
    _note(db, old, staff, now - timedelta(hours=1), content="x" * 300, channel="email")
    ha = _auth(admin)

    by_created = client.get("/api/admin/support/follow-ups", headers=ha).json()
    assert [x["id"] for x in by_created["items"]] == [new.id, idle.id, old.id, closed.id]
    # 有新记录的旧跟进排到最前 / an old follow-up with a fresh note ranks first
    by_activity = client.get("/api/admin/support/follow-ups", params={"sort": "activity"}, headers=ha).json()
    assert [x["id"] for x in by_activity["items"]] == [old.id, new.id, idle.id, closed.id]
    assert by_activity["total"] == 4 and by_activity["distribution"] == {"pending": 3, "revoked": 1}

    items = {x["id"]: x for x in by_activity["items"]}
    o = items[old.id]
    assert o["notesCount"] == 2 and o["stale"] is False and o["lastNoteAt"] is not None
    assert o["lastNote"] == {"content": "x" * 160, "channel": "email", "authorName": "Inn"}
    assert o["email"] == "rexlee@gmail.com" and o["assigneeName"] == "Inn"
    n = items[new.id]
    assert n["notesCount"] == 0 and n["lastNote"] is None and n["lastNoteAt"] is None and n["stale"] is False
    # 4 天没有任何记录 → 停滞；已结束的永远不算 / 4 days untouched is stale; closed never is
    assert items[idle.id]["stale"] is True
    assert items[closed.id]["stale"] is False
    # 旧参数照常 / existing params unchanged
    act = client.get("/api/admin/support/follow-ups", params={"status": "active", "sort": "activity"}, headers=ha).json()
    assert [x["id"] for x in act["items"]] == [old.id, new.id, idle.id]
    # stale=true 只留停滞的（管理员「停滞」指标点开的列表）；已结束的不算；分布不受它影响
    # stale=true keeps only stale rows (the admin "stale" KPI list); closed never qualify; distribution ignores it
    for params in ({"stale": "true"}, {"stale": "true", "status": "active", "sort": "activity"}):
        st = client.get("/api/admin/support/follow-ups", params=params, headers=ha).json()
        assert [x["id"] for x in st["items"]] == [idle.id] and st["total"] == 1, params
        assert st["items"][0]["stale"] is True
        assert st["distribution"] == {"pending": 3, "revoked": 1}
    st = client.get("/api/admin/support/follow-ups", params={"stale": "true", "status": "closed"}, headers=ha).json()
    assert st["total"] == 0 and st["items"] == []
    assert client.get("/api/admin/support/follow-ups", params={"stale": "false"}, headers=ha).json()["total"] == 4


def test_admin_follow_up_list_q_filter_and_distribution(client, db, people):
    admin, staff = people["admin"], people["internal"]
    by_nick = _user(db, "z1@x.com", nickname="ZedKing")
    by_mail = _user(db, "hellozed@x.com")
    fu_nick = _assign(db, admin, staff, by_nick)
    fu_nick.status, fu_nick.closed_at = "revoked", _now()
    db.commit()
    fu_mail = _assign(db, admin, staff, by_mail)
    _assign(db, admin, staff, people["customer"])
    ha = _auth(admin)
    url = "/api/admin/support/follow-ups"

    r = client.get(url, params={"q": "  ZED "}, headers=ha).json()
    assert r["total"] == 2 and {x["id"] for x in r["items"]} == {fu_nick.id, fu_mail.id}
    assert r["distribution"] == {"pending": 1, "revoked": 1}
    # 分布受 q 约束、不受 status 约束 / distribution honours q but not status
    r = client.get(url, params={"q": "zed", "status": "active"}, headers=ha).json()
    assert [x["id"] for x in r["items"]] == [fu_mail.id] and r["total"] == 1
    assert r["distribution"] == {"pending": 1, "revoked": 1}
    # 通配符按字面匹配 / wildcards match literally
    r = client.get(url, params={"q": "%"}, headers=ha).json()
    assert r["total"] == 0 and r["items"] == [] and r["distribution"] == {}
    # 空白 q 不筛选 / a blank q does not filter
    assert client.get(url, params={"q": "   "}, headers=ha).json()["total"] == 3
    assert client.get(url, params={"sort": "bogus"}, headers=ha).status_code == 422


def test_admin_support_progress_summary(client, db, people):
    admin, inn, outy = people["admin"], people["internal"], people["outsourced"]
    old_agent = _user(db, "old@x.com", role="support", support_tier="internal", nickname="Old", disabled_at=_now())
    gone = _user(db, "gone@x.com", role="support", nickname="Gone", disabled_at=_now())
    cs = [_user(db, f"p{i}@x.com") for i in range(4)]
    now = _now()
    fu1 = _assign(db, admin, inn, people["customer"], created_at=now - timedelta(days=10))
    fu2 = _assign(db, admin, inn, cs[0], created_at=now - timedelta(days=8))
    fu3 = _assign(db, admin, outy, cs[1], created_at=now - timedelta(days=20))
    fu4 = _assign(db, admin, admin, cs[2], created_at=now - timedelta(hours=1))
    _assign(db, admin, old_agent, cs[3])
    fu1.status = "interested"
    fu3.status, fu3.closed_at = "revoked", now - timedelta(days=1)
    fu4.status = "contacted"
    db.commit()
    inn_last = now - timedelta(days=1)
    _note(db, fu1, inn, inn_last)                       # 旧跟进有新记录 → 不停滞 / fresh note: not stale
    _note(db, fu2, inn, now - timedelta(days=6))        # 6 天前 → 停滞 / 6 days old: stale
    _note(db, fu3, outy, now - timedelta(days=2))       # 已结束的跟进 / on a closed follow-up
    _note(db, fu3, outy, now - timedelta(days=10))      # 7 天外 / outside the 7-day window

    r = client.get("/api/admin/support/progress", headers=_auth(admin))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["staleDays"] == support.STALE_DAYS == 3
    assert body["totals"] == {"active": 4, "stale": 1, "notes7d": 3, "pending": 2}
    # 停用排最后；没有工作的停用客服不出现；名下有跟进的管理员出现
    # disabled last; an idle disabled agent is omitted; an admin assignee appears
    assert [x["staffId"] for x in body["items"]] == [inn.id, admin.id, outy.id, old_agent.id]
    assert gone.id not in {x["staffId"] for x in body["items"]}
    rows = {x["staffId"]: x for x in body["items"]}
    i = rows[inn.id]
    assert (i["active"], i["distribution"], i["stale"], i["notes7d"]) == (2, {"interested": 1, "pending": 1}, 1, 2)
    assert i["role"] == "support" and i["tier"] == "internal" and i["disabled"] is False
    assert datetime.fromisoformat(i["lastNoteAt"]) == inn_last
    a = rows[admin.id]
    assert a["role"] == "admin" and a["tier"] == "internal" and a["nickname"] == "Boss"
    assert (a["active"], a["distribution"], a["stale"], a["notes7d"], a["lastNoteAt"]) == (1, {"contacted": 1}, 0, 0, None)
    o = rows[outy.id]
    assert (o["active"], o["distribution"], o["stale"], o["notes7d"]) == (0, {}, 0, 1)
    assert o["tier"] == "outsourced" and o["lastNoteAt"] is not None and o["email"] == "out@x.com"
    d = rows[old_agent.id]
    assert d["disabled"] is True and d["active"] == 1 and d["distribution"] == {"pending": 1}


def test_admin_follow_up_detail_timeline(client, db, people):
    admin, inn, outy, c = people["admin"], people["internal"], people["outsourced"], people["customer"]
    ha, hi, ho = _auth(admin), _auth(inn), _auth(outy)
    r = client.post("/api/admin/support/follow-ups", headers=ha,
                    json={"userIds": [c.id], "assigneeId": inn.id, "goal": "open_mt5"})
    fu_id = r.json()["created"][0]["id"]
    # 另一个用户的跟进与日志不应混进来 / another user's follow-up and rows stay out
    other = _user(db, "other@x.com")
    client.post("/api/admin/support/follow-ups", headers=ha,
                json={"userIds": [other.id], "assigneeId": inn.id, "goal": "revisit"})
    assert client.post(f"/api/support/follow-ups/{fu_id}/notes", json={"channel": "phone", "content": "第一次电话"},
                       headers=hi).status_code == 200
    assert client.patch(f"/api/support/follow-ups/{fu_id}", json={"status": "interested"}, headers=hi).status_code == 200
    r = client.post(f"/api/support/users/{c.id}/message", json={"title": "开户指引", "body": "您好"}, headers=hi)
    ticket_id = r.json()["ticket"]["id"]
    r = client.post("/api/admin/support/follow-ups/reassign", json={"ids": [fu_id], "assigneeId": outy.id}, headers=ha)
    assert r.json() == {"updated": 1}
    assert client.post(f"/api/support/follow-ups/{fu_id}/notes", json={"channel": "email", "content": "已发邮件"},
                       headers=ho).status_code == 200
    # 第一条记录挪早一点，「新→旧」顺序不依赖时钟精度 / pin the first note earlier so order is clock-independent
    first = db.query(FollowUpNote).filter(FollowUpNote.content == "第一次电话").one()
    first.created_at = _now() - timedelta(hours=2)
    db.add(Conversion(user_id=c.id, kind="mt5_real", dedupe_key="999@MC-Live", follow_up_id=fu_id,
                      credited_to=outy.id, status="confirmed"))
    db.commit()
    assert client.post(f"/api/support/users/{c.id}/do-not-contact", headers=ho).status_code == 200

    r = client.get(f"/api/admin/support/follow-ups/{fu_id}", headers=ha)
    assert r.status_code == 200, r.text
    body = r.json()
    fu = body["followUp"]
    assert fu["id"] == fu_id and fu["status"] == "revoked" and fu["active"] is False and fu["stale"] is False
    assert fu["assigneeName"] == "Outy" and fu["assignedByName"] == "Boss" and fu["email"] == c.email
    assert fu["notesCount"] == 2 and fu["lastNoteAt"] is not None
    u = body["user"]
    assert u["id"] == c.id and u["email"] == c.email and u["nickname"] == "Rex" and u["plan"] == "FREE"
    assert u["doNotContact"] is True and "phone" not in u
    assert [n["content"] for n in body["notes"]] == ["已发邮件", "第一次电话"]
    assert body["notes"][0]["authorName"] == "Outy"

    events = body["events"]
    actions = [e["action"] for e in events]
    assert sorted(actions) == sorted(["assign", "update", "message", "reassign", "do_not_contact"])
    assert "note" not in actions
    ats = [datetime.fromisoformat(e["at"]) for e in events]
    assert ats == sorted(ats, reverse=True)
    ev = {e["action"]: e for e in events}
    assert ev["assign"]["actorName"] == "Boss" and ev["assign"]["actorType"] == "admin"
    assert ev["assign"]["data"]["to"] == inn.id
    assert ev["update"]["data"] == {"action": "update", "status": "interested", "from": "contacted"}
    assert ev["update"]["actorName"] == "Inn" and ev["update"]["actorType"] == "support"
    assert ev["reassign"]["data"]["from"] == inn.id and ev["reassign"]["data"]["to"] == outy.id
    # 站内来信的 ref_id 是工单号，靠 data.fu 归到这条跟进 / the letter matches through data.fu
    assert ev["message"]["data"]["fu"] == fu_id and ev["message"]["actorId"] == inn.id
    assert ev["do_not_contact"]["actorName"] == "Outy"
    names = body["names"]
    assert names[admin.id] == "Boss" and names[inn.id] == "Inn" and names[outy.id] == "Outy"
    assert "contacted" not in names and "interested" not in names and other.id not in names
    assert ticket_id not in names

    convs = body["conversions"]
    assert len(convs) == 1 and convs[0]["kind"] == "mt5_real" and convs[0]["creditedTo"] == outy.id
    assert convs[0]["followUpId"] == fu_id

    nf = client.get("/api/admin/support/follow-ups/nope", headers=ha)
    assert nf.status_code == 404 and "Follow-up not found" in nf.json()["detail"]


def test_admin_follow_up_detail_keeps_follow_ups_of_one_user_apart(client, db, people):
    """同一个客户先后两条跟进：各自的时间线只含自己的事件（按 ref_id / data.fu 归属），勿扰只算进
    它关掉的那条；names 里的人可以只来自事件 data（改派的 from）。
    Two successive follow-ups of one customer: each timeline holds only its own
    events (by ref_id / data.fu), do-not-contact only lands on the one it closed,
    and names resolve people who only appear inside event data (reassign's from)."""
    admin, inn, outy, c = people["admin"], people["internal"], people["outsourced"], people["customer"]
    ha, hi = _auth(admin), _auth(inn)
    url = "/api/admin/support/follow-ups"
    a_id = client.post(url, headers=ha, json={"userIds": [c.id], "assigneeId": inn.id, "goal": "open_mt5"}).json()["created"][0]["id"]
    assert client.post(f"/api/support/follow-ups/{a_id}/notes", json={"channel": "phone", "content": "A 记录"},
                       headers=hi).status_code == 200
    assert client.post(f"{url}/revoke", json={"ids": [a_id]}, headers=ha).json() == {"updated": 1}
    a = db.get(FollowUp, a_id)
    a.created_at, a.closed_at = _now() - timedelta(days=2), _now() - timedelta(days=1)
    db.commit()

    b_id = client.post(url, headers=ha, json={"userIds": [c.id], "assigneeId": outy.id, "goal": "other"}).json()["created"][0]["id"]
    assert client.post(f"/api/support/users/{c.id}/message", json={"title": "续费", "body": "您好"}, headers=ha).status_code == 200
    assert client.post(f"{url}/reassign", json={"ids": [b_id], "assigneeId": inn.id}, headers=ha).json() == {"updated": 1}
    assert client.post(f"/api/support/users/{c.id}/do-not-contact", headers=hi).status_code == 200

    ra = client.get(f"{url}/{a_id}", headers=ha).json()
    assert sorted(e["action"] for e in ra["events"]) == ["assign", "revoke"]
    assert {e["data"].get("to") for e in ra["events"] if e["action"] == "assign"} == {inn.id}
    assert [n["content"] for n in ra["notes"]] == ["A 记录"]
    assert outy.id not in ra["names"]

    rb = client.get(f"{url}/{b_id}", headers=ha).json()
    assert sorted(e["action"] for e in rb["events"]) == ["assign", "do_not_contact", "message", "reassign"]
    assert rb["notes"] == [] and rb["followUp"]["status"] == "revoked" and rb["followUp"]["assigneeName"] == "Inn"
    ev = {e["action"]: e for e in rb["events"]}
    assert ev["message"]["data"]["fu"] == b_id and ev["message"]["actorType"] == "admin"
    # Outy 只出现在 assign.to / reassign.from 里 / Outy only appears inside assign.to / reassign.from
    assert rb["names"][outy.id] == "Outy" and ev["reassign"]["data"]["from"] == outy.id


def test_admin_progress_endpoints_forbidden_for_support_and_post_routes_intact(client, db, people):
    fu = _assign(db, people["admin"], people["internal"], people["customer"])
    for who in ("internal", "outsourced"):
        h = _auth(people[who])
        for path in ("/api/admin/support/follow-ups", "/api/admin/support/progress",
                     f"/api/admin/support/follow-ups/{fu.id}"):
            assert client.get(path, headers=h).status_code == 403, (who, path)
    # 新 GET /follow-ups/{id} 不吃掉同前缀的 POST 路由 / the new GET route doesn't shadow the POSTs
    ha = _auth(people["admin"])
    r = client.post("/api/admin/support/follow-ups/check", json={"userIds": [people["customer"].id]}, headers=ha)
    assert r.status_code == 200 and r.json()["items"][0]["activeFollowUp"] is True
    r = client.post("/api/admin/support/follow-ups/extend", json={"ids": [fu.id], "days": 3}, headers=ha)
    assert r.json() == {"updated": 1}
    r = client.post("/api/admin/support/follow-ups/reassign",
                    json={"ids": [fu.id], "assigneeId": people["outsourced"].id}, headers=ha)
    assert r.json() == {"updated": 1}
    r = client.post("/api/admin/support/follow-ups/revoke", json={"ids": [fu.id]}, headers=ha)
    assert r.json() == {"updated": 1}
    assert client.get(f"/api/admin/support/follow-ups/{fu.id}", headers=ha).json()["followUp"]["status"] == "revoked"
    # 参数化的 403 用例已自动覆盖新路由 / the parametrized 403 test already walks the new routes
    assert ("GET", "/api/admin/support/follow-ups/nope") in ADMIN_SUPPORT_CALLS
    assert ("GET", "/api/admin/support/progress") in ADMIN_SUPPORT_CALLS


def test_do_not_contact_right_after_a_revoke_stays_on_the_follow_up_it_closed(client, db, people):
    """收回 A 后马上给同一客户分配 B，半分钟内 B 的客服点「不再联系」：只记在 B 上，不会因为
    时间挨着 A 的结束时间就挂到 A 的记录里。老的勿扰记录（没有 data.fu）仍按结束时间认领。
    A revoked, B assigned right after, and B's agent marks do-not-contact within half a
    minute: it lands on B only, not on A just because it sits next to A's close time. Old
    do-not-contact rows (no data.fu) are still matched by close time."""
    admin, inn, c = people["admin"], people["internal"], people["customer"]
    ha, hi = _auth(admin), _auth(inn)
    url = "/api/admin/support/follow-ups"
    a_id = client.post(url, headers=ha, json={"userIds": [c.id], "assigneeId": inn.id, "goal": "open_mt5"}).json()["created"][0]["id"]
    assert client.post(f"{url}/revoke", json={"ids": [a_id]}, headers=ha).json() == {"updated": 1}
    b_id = client.post(url, headers=ha, json={"userIds": [c.id], "assigneeId": inn.id, "goal": "other"}).json()["created"][0]["id"]
    assert client.post(f"/api/support/users/{c.id}/do-not-contact", headers=hi).status_code == 200

    dnc = db.query(ActivityEvent).filter(ActivityEvent.kind == "support.action").one()
    assert json.loads(dnc.data)["fu"] == [b_id]
    actions = lambda fid: sorted(e["action"] for e in client.get(f"{url}/{fid}", headers=ha).json()["events"])  # noqa: E731
    assert actions(a_id) == ["assign", "revoke"]
    assert actions(b_id) == ["assign", "do_not_contact"]

    # 老记录：没有 data.fu，只认紧贴结束时间的 / legacy row without data.fu: matched by close time only
    dnc.data = json.dumps({"action": "do_not_contact"})
    db.commit()
    assert "do_not_contact" in actions(b_id)
    b = db.get(FollowUp, b_id)
    b.closed_at = b.closed_at - timedelta(minutes=5)
    db.commit()
    assert "do_not_contact" not in actions(b_id)


def test_extend_by_days_leaves_follow_ups_without_a_deadline_alone(client, db, people):
    """按天数延期只动有截止时间的跟进；没有截止时间的保持不限期（不然到期会被自动结束）。
    给定具体时间的延期两种都改。
    Extending by days only touches follow-ups that have a deadline; ones without stay
    unlimited (otherwise the sweep would expire them). An explicit date sets both."""
    admin, inn = people["admin"], people["internal"]
    ha = _auth(admin)
    dated = _assign(db, admin, inn, people["customer"])
    open_ended = _assign(db, admin, inn, _user(db, "nodeadline@x.com"))
    open_ended.expires_at = None
    db.commit()
    before = dated.expires_at

    r = client.post("/api/admin/support/follow-ups/extend", json={"ids": [dated.id, open_ended.id], "days": 7}, headers=ha)
    assert r.json() == {"updated": 1}
    db.refresh(dated)
    db.refresh(open_ended)
    assert open_ended.expires_at is None
    assert dated.expires_at > before
    assert db.query(ActivityEvent).filter(ActivityEvent.ref_id == open_ended.id,
                                          ActivityEvent.kind == "support.follow_up").count() == 0

    when = (_now() + timedelta(days=60)).isoformat()
    r = client.post("/api/admin/support/follow-ups/extend", json={"ids": [dated.id, open_ended.id], "expiresAt": when}, headers=ha)
    assert r.json() == {"updated": 2}
    db.refresh(open_ended)
    assert open_ended.expires_at is not None


def test_admin_deletes_ticket_with_replies_notifications_and_audit(client, db, people, monkeypatch):
    """管理员删工单：工单、全部回复（含内部备注）、指向它的工单通知一起没；别的通知不动；
    审计留一行 ticket:<id>:delete（值是标题）；附图交给后台删，别的工单也引用的图不删。
    客服删不了。
    An admin deleting a ticket removes it, every reply (internal notes included) and the
    ticket notifications pointing at it; other notifications stay; one audit row
    ticket:<id>:delete holds the title; images go to background deletion except ones
    another ticket also references. Support agents cannot delete."""
    from app.routers import tickets as tk

    deleted_keys: list[list[str]] = []
    monkeypatch.setattr(tk, "delete_private_images", lambda keys: deleted_keys.append(list(keys)))
    c, admin, inn = people["customer"], people["admin"], people["internal"]
    t = Ticket(user_id=c.id, title="入金没到账", category="payment")
    other = Ticket(user_id=c.id, title="别的工单", category="account")
    db.add_all([t, other])
    db.commit()
    own, shared = f"{c.id}/aa11.png#w=10&h=10", f"{c.id}/bb22.jpg"
    db.add_all([
        TicketReply(ticket_id=t.id, author_id=c.id, body="截图", images=json.dumps([own, shared])),
        TicketReply(ticket_id=t.id, author_id=inn.id, body="内部", internal=True, author_role="support"),
        TicketReply(ticket_id=other.id, author_id=c.id, body="同一张图", images=json.dumps([shared])),
        UserNotification(user_id=admin.id, kind="ticket_new", ref_id=t.id, text=t.title, link="/admin"),
        UserNotification(user_id=c.id, kind="ticket_reply", ref_id=t.id, text=t.title, link="/support"),
        UserNotification(user_id=c.id, kind="ticket_reply", ref_id=other.id, text=other.title, link="/support"),
    ])
    db.commit()
    tid = t.id

    assert client.delete(f"/api/admin/tickets/{tid}", headers=_auth(inn)).status_code == 403
    assert db.get(Ticket, tid) is not None

    r = client.delete(f"/api/admin/tickets/{tid}", headers=_auth(admin))
    assert r.status_code == 200 and r.json() == {"deleted": True}
    db.expire_all()
    assert db.get(Ticket, tid) is None
    assert db.query(TicketReply).filter(TicketReply.ticket_id == tid).count() == 0
    assert db.query(TicketReply).filter(TicketReply.ticket_id == other.id).count() == 1
    assert [n.ref_id for n in db.query(UserNotification).all()] == [other.id]
    audit = db.query(AdminAuditLog).filter(AdminAuditLog.field == f"ticket:{tid}:delete").one()
    assert audit.admin_user_id == admin.id and audit.target_user_id == c.id and audit.new_value == "入金没到账"
    assert deleted_keys == [[own]]
    assert client.get(f"/api/admin/tickets/{tid}", headers=_auth(admin)).status_code == 404
    assert client.delete(f"/api/admin/tickets/{tid}", headers=_auth(admin)).status_code == 404


def test_deleting_an_untitled_ticket_still_leaves_an_audit_row(client, db, people, monkeypatch):
    """标题为空（旧数据 / 客服发信 strip 后为空）的工单删掉也要留痕：log_change 遇到空值会当「没变」
    跳过，所以值用工单号顶上。
    Deleting a ticket with an empty title still writes the audit row (log_change skips
    empty values as unchanged), using the ticket number instead."""
    from app.routers import tickets as tk

    monkeypatch.setattr(tk, "delete_private_images", lambda keys: None)
    c, admin = people["customer"], people["admin"]
    t = Ticket(user_id=c.id, title="  ", category="account")
    db.add(t)
    db.commit()
    tid = t.id
    assert client.delete(f"/api/admin/tickets/{tid}", headers=_auth(admin)).status_code == 200
    audit = db.query(AdminAuditLog).filter(AdminAuditLog.field == f"ticket:{tid}:delete").one()
    assert audit.new_value == f"#{tid[:8]}"


def test_renew_goal_is_no_longer_offered(client, people):
    """2026-10-18 起跟进目标不再提供「续费」，新分配传 renew 被拒（旧记录里的 renew 照常显示）。
    renew is no longer an offered goal: assigning with it is rejected."""
    c, admin, inn = people["customer"], people["admin"], people["internal"]
    url = "/api/admin/support/follow-ups"
    assert client.post(url, headers=_auth(admin), json={"userIds": [c.id], "assigneeId": inn.id, "goal": "renew"}).status_code == 422
    r = client.post(url, headers=_auth(admin), json={"userIds": [c.id], "assigneeId": inn.id, "goal": "other"})
    assert r.status_code == 200 and r.json()["created"][0]["goal"] == "other"
