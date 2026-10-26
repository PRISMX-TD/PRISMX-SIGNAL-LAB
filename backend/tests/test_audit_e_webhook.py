"""webhook 两条审计修复（routers/webhook.py）。

1. trend-unbounded-body-and-cardinality-before-auth：/webhook/trend 以前不限长读整段 body，
   每次都在事件循环上逐字符扫一遍（_extract_json_block），然后才校验密钥。修复后：有界读取
   （超过 64KB 直接 413）、整段能解析就不再扫描、trends 映射限条数。
2. tradingview-rate-limit-bucket-shared-with-untrusted-tenants：以前 60/分钟的按 IP 限流在验密钥
   之前就扣，与 TradingView 共用出口 IP 的其他人用错密钥就能把真信号挤成 429。修复后：密钥错的
   请求记在另一个桶里，只消耗「失败」额度；密钥对的请求单独计数。

Two webhook fixes: the trend endpoint reads a bounded body, scans only when needed and caps
the trends map; the TradingView/MT5 signal endpoints charge wrong-secret requests to a
separate per-IP failure bucket so they can no longer starve genuine alerts.
"""
import json
import os
import tempfile
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.routers.webhook as wh
from app.core.database import Base
from app.models import Signal


@pytest.fixture()
def env(monkeypatch):
    path = os.path.join(tempfile.gettempdir(), f"prismx-test-{uuid.uuid4().hex}.db")
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(wh, "SessionLocal", maker)
    monkeypatch.setattr(wh.settings, "EA_TOKEN", "ea-token")
    monkeypatch.setattr(wh.settings, "WEBHOOK_SECRET", "tv-secret")

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(wh, "broadcast_signal_new_realtime", _noop)
    monkeypatch.setattr(wh, "dispatch_push_async", _noop)
    wh.limiter.reset()
    monkeypatch.setattr(wh.limiter, "enabled", True)
    app = FastAPI()
    app.state.limiter = wh.limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(wh.router)
    try:
        yield TestClient(app), maker
    finally:
        wh.limiter.reset()
        engine.dispose()
        try:
            os.unlink(path)
        except OSError:
            pass


def _signal(secret, sid):
    return {"secret": secret, "symbol": "XAUUSD", "side": "buy", "entry": 2650.5,
            "stopLoss": 2640.0, "takeProfit": 2670.0, "id": sid}


# ---------- tradingview: 失败不占真信号的额度 / failures don't spend the producer budget ----------


@pytest.mark.parametrize("path,good", [("/webhook/tradingview", "tv-secret"), ("/webhook/mt5-signal", "ea-token")])
def test_wrong_secret_flood_does_not_starve_genuine_alerts(env, path, good):
    client, maker = env
    for i in range(60):
        r = client.post(path, json=_signal("wrong", f"X-{i}"))
        assert r.status_code == 401, (i, r.status_code)
    r = client.post(path, json=_signal(good, "TV-REAL"))
    assert r.status_code == 200, r.text
    db = maker()
    try:
        assert [s.external_id for s in db.query(Signal).all()] == ["TV-REAL"]
    finally:
        db.close()


def test_wrong_secret_flood_is_itself_limited(env):
    client, _ = env
    codes = [client.post("/webhook/tradingview", json=_signal("wrong", f"X-{i}")).status_code for i in range(70)]
    assert codes[:60] == [401] * 60
    assert set(codes[60:]) == {429}


def test_genuine_alerts_keep_their_own_limit(env):
    client, _ = env
    codes = [client.post("/webhook/tradingview", json=_signal("tv-secret", f"G-{i}")).status_code for i in range(61)]
    assert codes[:60] == [200] * 60
    assert codes[60] == 429


# ---------- trend: 有界读取、按需扫描、条数上限 / bounded read, lazy scan, capped map ----------


@pytest.fixture()
def trend_client(env, monkeypatch):
    client, _ = env
    monkeypatch.setattr(wh.limiter, "enabled", False)
    return client


def test_trend_large_body_is_413_and_never_scanned(trend_client, monkeypatch):
    scans, checks = [], []
    real_scan = wh._extract_json_block
    monkeypatch.setattr(wh, "_extract_json_block", lambda t: scans.append(len(t)) or real_scan(t))
    monkeypatch.setattr(wh, "_valid_trend_secret", lambda s: checks.append(s) or False)
    r = trend_client.post("/webhook/trend", content=b"{" + b"a" * 100_000)
    assert r.status_code == 413
    assert scans == [] and checks == []


def test_trend_valid_json_is_not_rescanned(trend_client, monkeypatch):
    scans = []
    real_scan = wh._extract_json_block
    monkeypatch.setattr(wh, "_extract_json_block", lambda t: scans.append(len(t)) or real_scan(t))
    body = {"secret": "x", "symbol": "XAUUSD", "trends": {"M5": "UP"}}
    r = trend_client.post("/webhook/trend", content=json.dumps(body))
    assert r.status_code == 401
    assert scans == []


def test_trend_text_wrapped_json_still_works(trend_client, monkeypatch):
    """TradingView 把说明文字和 JSON 拼在一起发：仍然要能抠出来（整段解析失败才扫描）。
    TradingView's text-plus-JSON form must still be extracted (scan only on fallback)."""
    body = "Alert fired: " + json.dumps({"secret": "x", "symbol": "XAUUSD", "trends": {"M5": "UP"}})
    r = trend_client.post("/webhook/trend", content=body)
    assert r.status_code == 401          # 解析成功、密钥不对 / parsed, wrong secret


def test_trend_map_cardinality_is_capped():
    big = {f"T{i}": "UP" for i in range(200)}
    with pytest.raises(ValueError):
        wh.TrendSignal.model_validate({"secret": "x", "symbol": "XAUUSD", "trends": big})
    with pytest.raises(ValueError):
        wh.TrendItem.model_validate({"symbol": "XAUUSD", "trends": big})
