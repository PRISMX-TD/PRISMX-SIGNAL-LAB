"""用户档案抽屉 / 最近动态 / 客服可改工单分类标题与快捷回复（2026-10-28）。

User drawer overview, the recent-activity timeline, and support agents editing ticket
category / title and canned replies (2026-10-28).
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.core.security import create_access_token
from app.models import (
    ActivityEvent,
    AdminAuditLog,
    Competition,
    CompetitionParticipant,
    FollowUp,
    LeaderboardSnapshot,
    LuckyDraw,
    MT5Account,
    Payment,
    Ticket,
    User,
    UserIp,
)
from app.services.deps import staff_ctx_for
from app.services.settings_store import invalidate_settings_cache, invalidate_support_cache
from app.services.user_activity import recent_activity


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


@pytest.fixture()
def client(db):
    from app import main as app_main

    app_main.app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app_main.app)
    finally:
        app_main.app.dependency_overrides.pop(get_db, None)


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
def people(db):
    admin = _user(db, "boss@x.com", role="admin", nickname="Boss")
    internal = _user(db, "in@x.com", role="support", support_tier="internal", nickname="Inn")
    outsourced = _user(db, "out@x.com", role="support", support_tier="outsourced", nickname="Outy")
    customer = _user(db, "rex@gmail.com", phone="+8613812345678", nickname="Rex",
                     created_at=_now() - timedelta(days=90))
    db.add(MT5Account(user_id=customer.id, login="100609", server="MC-Demo", source="gateway",
                      balance=1000.0, equity=1000.0))
    db.commit()
    return {"admin": admin, "internal": internal, "outsourced": outsourced, "customer": customer}


def _seed_activity(db, people):
    c = people["customer"]
    t0 = _now() - timedelta(days=10)
    running = Competition(name="10月模拟大赛", starts_at=t0, ends_at=_now() + timedelta(days=5),
                          status="running", track="demo")
    settled = Competition(name="9月赛", starts_at=t0 - timedelta(days=40), ends_at=t0 - timedelta(days=10),
                          status="settled", track="demo")
    db.add_all([running, settled])
    db.commit()
    db.add_all([
        CompetitionParticipant(competition_id=running.id, user_id=c.id, mt5_login="100609",
                               registered_at=t0 + timedelta(days=1)),
        CompetitionParticipant(competition_id=settled.id, user_id=c.id, mt5_login="100609",
                               registered_at=t0 - timedelta(days=39), final_rank=2, final_score=0.5),
        LeaderboardSnapshot(board="return_pct", period_key=f"comp:{running.id}", user_id=c.id,
                            mt5_login="100609", rank=1, score=27.178, sample=377),
        LeaderboardSnapshot(board="return_pct", period_key=f"comp:{running.id}", user_id=people["admin"].id,
                            mt5_login="999", rank=2, score=1.0, sample=3),
        Payment(user_id=c.id, nowpayments_payment_id="np1", plan="pro_monthly", amount_usd=29.0,
                pay_currency="usdttrc20", status="FINISHED", created_at=t0, finished_at=t0),
        AdminAuditLog(admin_user_id=people["admin"].id, target_user_id=c.id, field="plan",
                      old_value="FREE", new_value="PRO", created_at=t0 + timedelta(hours=1)),
        Ticket(user_id=c.id, title="10月模拟大赛冠军", category="claim", created_at=t0 + timedelta(days=2)),
        ActivityEvent(kind="user.login", actor_type="user", user_id=c.id, created_at=t0 + timedelta(days=3)),
        ActivityEvent(kind="auto.settings", actor_type="user", user_id=c.id, created_at=t0 + timedelta(days=3)),
    ])
    # SQLite 不强制外键，转盘的轮次 / 奖项 / 券行省掉 / SQLite skips FKs, so no round / prize / ticket rows
    db.add(LuckyDraw(user_id=c.id, round_id="rnd", ticket_id="tk", prize_id="pz",
                     prize_snapshot=json.dumps({"name": "PRO 7 天", "kind": "pro_days"}, ensure_ascii=False),
                     request_id="r1", fulfillment_status="auto_done", created_at=t0 + timedelta(days=4)))
    db.commit()
    return running, settled


def test_recent_activity_merges_sources_newest_first(db, people):
    try:
        running, settled = _seed_activity(db, people)
    except TypeError as e:  # 模型必填列变了就让人知道 / surface model drift
        pytest.fail(f"seed failed: {e}")
    items = recent_activity(db, people["customer"], staff_ctx_for(people["admin"]))
    kinds = [i["kind"] for i in items]
    assert set(kinds) >= {"signup", "comp", "lucky", "payment", "plan", "ticket", "event"}
    ats = [i["at"] for i in items]
    assert ats == sorted(ats, reverse=True)
    assert kinds[-1] == "signup"
    comps = {i["name"]: i for i in items if i["kind"] == "comp"}
    # 进行中读快照名次，已终审读 final_rank / live reads the snapshot, settled reads final_rank
    assert comps["10月模拟大赛"]["rank"] == 1 and comps["10月模拟大赛"]["total"] == 2
    assert comps["10月模拟大赛"]["login"] == "100609"
    assert comps["9月赛"]["rank"] == 2 and comps["9月赛"]["score"] == 0.5
    events = [i for i in items if i["kind"] == "event"]
    assert [e["event"] for e in events] == ["user.login"]  # auto.settings 不上时间线 / not on the timeline
    plan = next(i for i in items if i["kind"] == "plan")
    assert plan["by"] == "Boss" and plan["new"] == "PRO"
    lucky = next(i for i in items if i["kind"] == "lucky")
    assert lucky["prize"] == "PRO 7 天"


def test_recent_activity_is_trimmed_per_tier(db, people):
    _seed_activity(db, people)
    c = people["customer"]
    internal = recent_activity(db, c, staff_ctx_for(people["internal"]))
    outsourced = recent_activity(db, c, staff_ctx_for(people["outsourced"]))
    for items in (internal, outsourced):
        assert not any(i["kind"] == "payment" for i in items)
    assert next(i for i in internal if i["kind"] == "comp")["login"] == "****0609"
    assert next(i for i in outsourced if i["kind"] == "comp")["login"] is None
    assert next(i for i in outsourced if i["kind"] == "plan")["by"] is None


def test_admin_overview_endpoint(client, db, people):
    _seed_activity(db, people)
    c = people["customer"]
    other = _user(db, "alt@x.com")
    db.add_all([
        UserIp(user_id=c.id, ip="1.2.3.4", country="马来西亚", first_seen_at=_now(), last_seen_at=_now()),
        UserIp(user_id=other.id, ip="1.2.3.4", first_seen_at=_now(), last_seen_at=_now()),
    ])
    db.commit()
    r = client.get(f"/api/admin/users/{c.id}/overview", headers=_auth(people["admin"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["email"] == "rex@gmail.com" and body["user"]["phone"] == "+8613812345678"
    assert body["customer"]["mt5Accounts"][0]["login"] == "100609"
    assert body["ips"][0]["ip"] == "1.2.3.4" and body["ips"][0]["place"] == "马来西亚"
    assert body["sameIpUsers"] == 1
    assert any(i["kind"] == "comp" for i in body["activity"])
    for who in ("internal", "outsourced"):
        assert client.get(f"/api/admin/users/{c.id}/overview", headers=_auth(people[who])).status_code == 403
    assert client.get("/api/admin/users/nope/overview", headers=_auth(people["admin"])).status_code == 404


def test_support_card_carries_activity(client, db, people):
    _seed_activity(db, people)
    c = people["customer"]
    db.add(FollowUp(user_id=c.id, assignee_id=people["internal"].id, assigned_by=people["admin"].id,
                    goal="open_mt5", status="pending", expires_at=_now() + timedelta(days=30)))
    db.commit()
    r = client.get(f"/api/support/users/{c.id}", headers=_auth(people["internal"]))
    assert r.status_code == 200, r.text
    kinds = {i["kind"] for i in r.json()["activity"]}
    assert "comp" in kinds and "payment" not in kinds


def test_support_can_change_ticket_category_and_title(client, db, people, monkeypatch):
    c = people["customer"]
    t = Ticket(user_id=c.id, title="你好", category="account")
    db.add(t)
    db.commit()
    for who in ("internal", "outsourced"):
        r = client.patch(f"/api/admin/tickets/{t.id}", json={"category": "claim", "title": f"申领 {who}"},
                         headers=_auth(people[who]))
        assert r.status_code == 200, r.text
        assert r.json()["category"] == "claim" and r.json()["title"] == f"申领 {who}"
    fields = {row.field for row in db.query(AdminAuditLog).all()}
    assert f"ticket:{t.id}:category" in fields and f"ticket:{t.id}:title" in fields
    bad = client.patch(f"/api/admin/tickets/{t.id}", json={"category": "nope"}, headers=_auth(people["internal"]))
    assert bad.status_code == 422


def test_internal_support_writes_templates_outsourced_cannot(client, db, people):
    hi = _auth(people["internal"])
    r = client.post("/api/support/templates", json={"title": "发奖", "body": "您好 {nickname}"}, headers=hi)
    assert r.status_code == 200, r.text
    tid = r.json()["template"]["id"]
    r = client.patch(f"/api/support/templates/{tid}", json={"body": "已发放"}, headers=hi)
    assert r.status_code == 200 and r.json()["template"]["body"] == "已发放"
    ho = _auth(people["outsourced"])
    assert client.post("/api/support/templates", json={"title": "x", "body": "y"}, headers=ho).status_code == 403
    assert client.patch(f"/api/support/templates/{tid}", json={"body": "z"}, headers=ho).status_code == 403
    # 删除仍只有管理员 / delete stays admin-only
    assert client.delete(f"/api/admin/support/templates/{tid}", headers=hi).status_code == 403
