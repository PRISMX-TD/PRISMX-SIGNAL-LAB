"""游客预览（2026-10-09）：开关、公开快照的价位抹除、漏斗计数。

最要紧的一条是「活跃信号的真实价位绝不出服务器」——所以既断言字段为 None，也断言
整个响应文本里找不到那几个价位数字（防止哪天有人在别的字段里又把它带出去）。

Guest preview: the switch, price stripping in the public snapshot, funnel counters. The
one that matters most is "live prices never leave the server", so besides asserting the
fields are None we also assert the raw digits appear nowhere in the response text.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.models import GuestPreviewFunnelDaily, Signal, User
from app.routers import public_preview
from app.routers.admin import get_guest_preview, put_guest_preview
from app.routers.site import get_site_config
from app.schemas import AdminGuestPreviewIn
from app.services.deps import get_db
from app.services.guest_preview import mask_signal, record_event
from app.services.settings_store import invalidate_guest_preview_cache

UTC = timezone.utc
PAYLOAD_KEYS = {"symbols", "quotes", "trends", "sentiment", "active", "recent", "recentStats"}


@pytest.fixture(autouse=True)
def _clean_cache():
    invalidate_guest_preview_cache()
    yield
    invalidate_guest_preview_cache()


def _admin(db):
    u = User(email="admin@x.com", api_token="tok_admin", role="admin")
    db.add(u); db.commit(); return u


def _switch(db, on: bool):
    admin = db.query(User).filter(User.role == "admin").first() or _admin(db)
    put_guest_preview(AdminGuestPreviewIn(enabled=on), db, admin)


def _client(db):
    db.connection()
    app = FastAPI()
    app.state.limiter = public_preview.limiter
    app.include_router(public_preview.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app, raise_server_exceptions=False)


def _signal(db, **kw):
    now = datetime.now(UTC)
    fields = dict(symbol="XAUUSD", side="BUY", entry=4185.07, stop_loss=4181.73, take_profit=4191.75,
                  indicator="AIFT", status="ACTIVE", created_at=now - timedelta(minutes=2),
                  expire_at=now + timedelta(minutes=8), result="PENDING")
    fields.update(kw)
    s = Signal(**fields); db.add(s); db.commit(); return s


def test_off_by_default_everything_404_and_config_false(db_session):
    """全新部署：开关默认关，首页照旧是落地页，快照一个字也不吐。"""
    assert get_site_config(db_session) == {"guestPreview": False}
    c = _client(db_session)
    assert c.get("/api/public/preview").status_code == 404
    assert c.get("/api/public/preview/analysis").status_code == 404


def test_switch_round_trip_through_admin(db_session):
    admin = _admin(db_session)
    out = put_guest_preview(AdminGuestPreviewIn(enabled=True), db_session, admin)
    assert out.enabled is True
    assert get_site_config(db_session) == {"guestPreview": True}
    assert get_guest_preview(db_session, admin).enabled is True
    put_guest_preview(AdminGuestPreviewIn(enabled=False), db_session, admin)
    assert get_site_config(db_session) == {"guestPreview": False}


def test_live_prices_never_leave_the_server(db_session):
    _switch(db_session, True)
    _signal(db_session)
    res = _client(db_session).get("/api/public/preview")
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == PAYLOAD_KEYS
    [sig] = body["active"]
    assert sig["entry"] is None and sig["stopLoss"] is None and sig["takeProfit"] is None
    assert sig["locked"] == {"rr": 2.0, "riskFrac": 0.333}
    assert sig["symbol"] == "XAUUSD" and sig["side"] == "BUY"
    for digits in ("4185.07", "4181.73", "4191.75"):
        assert digits not in res.text


def test_expired_signals_come_through_in_full_and_count_in_stats(db_session):
    _switch(db_session, True)
    now = datetime.now(UTC)
    _signal(db_session, status="EXPIRED", result="HIT_TP", created_at=now - timedelta(hours=2),
            expire_at=now - timedelta(hours=1, minutes=50), resolved_at=now - timedelta(hours=1))
    _signal(db_session, symbol="EURUSD", side="SELL", entry=1.1195, stop_loss=1.1205, take_profit=1.1175,
            status="EXPIRED", result="HIT_SL", created_at=now - timedelta(hours=3),
            expire_at=now - timedelta(hours=2, minutes=50))
    _signal(db_session, status="EXPIRED", result="HIT_TP", created_at=now - timedelta(hours=30),
            expire_at=now - timedelta(hours=29, minutes=50))
    body = _client(db_session).get("/api/public/preview").json()
    assert body["active"] == []
    assert body["recent"][0]["entry"] == 4185.07 and body["recent"][0]["result"] == "HIT_TP"
    assert "locked" not in body["recent"][0]
    assert body["recentStats"] == {"hours": 24, "issued": 2, "hitTp": 1, "hitSl": 1}


def test_active_but_past_expiry_is_not_served_as_live(db_session):
    """过期扫描每 5 秒一次：状态还是 ACTIVE、但时间已过的那条，不能当「进行中」给出去。"""
    _switch(db_session, True)
    now = datetime.now(UTC)
    _signal(db_session, created_at=now - timedelta(minutes=11), expire_at=now - timedelta(seconds=30))
    body = _client(db_session).get("/api/public/preview").json()
    assert body["active"] == []


def test_switch_off_takes_effect_despite_the_cache(db_session):
    """快照有 3 秒缓存，但开关在缓存外判：关掉的下一次请求就是 404。"""
    _switch(db_session, True)
    c = _client(db_session)
    assert c.get("/api/public/preview").status_code == 200
    _switch(db_session, False)
    assert c.get("/api/public/preview").status_code == 404


def test_analysis_endpoint_serves_the_published_strategy_payload(db_session):
    _switch(db_session, True)
    res = _client(db_session).get("/api/public/preview/analysis")
    assert res.status_code == 200, res.text
    assert {"days", "sessions", "overall", "strategies"} <= set(res.json())


def test_mask_signal_matches_the_frontend_rule():
    out = mask_signal({"entry": 100.0, "stopLoss": 99.0, "takeProfit": 130.0})
    # 盈亏比 30；风险占比 1/31 ≈ 3%，夹到 8%（与前端 riskFraction 一致）
    assert out["locked"] == {"rr": 30.0, "riskFrac": 0.08}
    assert mask_signal({"entry": 1.0, "stopLoss": 1.0, "takeProfit": 2.0})["locked"]["rr"] is None
    assert mask_signal({"entry": None, "stopLoss": 1.0, "takeProfit": 2.0})["locked"] == {"rr": None, "riskFrac": None}


def test_events_are_allow_listed_and_always_204(db_session):
    _admin(db_session)
    c = _client(db_session)
    for body in ({"mode": "evil", "step": "view"}, {"mode": "preview", "step": "drop table"}):
        assert c.post("/api/public/preview/event", json=body).status_code == 204
    # 唯一一次真写库放最后：commit 会把钉住的测试连接还回池子（同比赛页的打点用例）。
    # The only real write goes last: its commit returns the pinned test connection.
    res = c.post("/api/public/preview/event", json={"mode": "preview", "step": "view"})
    assert res.status_code == 204 and res.content == b""
    assert record_event(db_session, "preview", "view") is True
    assert record_event(db_session, "landing", "signup") is True
    assert record_event(db_session, "landing", "nope") is False
    rows = {(r.mode, r.step): r.count for r in db_session.query(GuestPreviewFunnelDaily).all()}
    assert rows == {("preview", "view"): 2, ("landing", "signup"): 1}


def test_admin_sees_funnel_rows(db_session):
    admin = _admin(db_session)
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    old = (datetime.now(UTC) - timedelta(days=40)).strftime("%Y-%m-%d")
    record_event(db_session, "preview", "gate")
    record_event(db_session, "preview", "gate", day=old)
    out = get_guest_preview(db_session, admin)
    assert [(r.day, r.mode, r.step, r.count) for r in out.funnel] == [(today, "preview", "gate", 1)]
