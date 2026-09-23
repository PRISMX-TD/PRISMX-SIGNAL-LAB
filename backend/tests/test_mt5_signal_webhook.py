"""POST /webhook/mt5-signal：MT5 信号 EA 推送交易信号。

鉴权只认 EA_TOKEN（不认 WEBHOOK_SECRET），落库 source="mt5"，
去重与 /tradingview 一致；胜率统计的来源集合必须包含 mt5。

POST /webhook/mt5-signal: trading signals pushed by the MT5 signal EA. Auth
accepts EA_TOKEN only, rows are stored with source="mt5", dedup matches /tradingview, and win-rate stats must include mt5.
"""
import os
import tempfile
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.routers.webhook as wh
from app.core.database import Base
from app.models import EXTERNAL_SIGNAL_SOURCES, Signal


@pytest.fixture()
def env(monkeypatch):
    path = os.path.join(tempfile.gettempdir(), f"prismx-test-{uuid.uuid4().hex}.db")
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(wh, "SessionLocal", maker)
    monkeypatch.setattr(wh.settings, "EA_TOKEN", "ea-token")
    monkeypatch.setattr(wh.settings, "WEBHOOK_SECRET", "tv-secret")
    monkeypatch.setattr(wh.limiter, "enabled", False)
    sent = []

    async def _broadcast(data):
        sent.append(data)

    async def _push(sig):
        return None

    monkeypatch.setattr(wh, "broadcast_signal_new_realtime", _broadcast)
    monkeypatch.setattr(wh, "dispatch_push_async", _push)
    app = FastAPI()
    app.include_router(wh.router)
    try:
        yield TestClient(app), maker, sent
    finally:
        engine.dispose()
        try:
            os.unlink(path)
        except OSError:
            pass


def _body(**kw):
    body = {"secret": "ea-token", "symbol": "XAUUSD", "side": "buy",
            "entry": 2650.5, "stopLoss": 2640.0, "takeProfit": 2670.0,
            "strategy": "AIFT", "id": "MT5-1"}
    body.update(kw)
    return body


def test_stores_mt5_source_and_broadcasts(env):
    client, maker, sent = env
    r = client.post("/webhook/mt5-signal", json=_body())
    assert r.status_code == 200 and r.json()["deduped"] is False
    db = maker()
    try:
        sig = db.query(Signal).one()
        assert (sig.source, sig.symbol, sig.side, sig.indicator) == ("mt5", "XAUUSD", "BUY", "AIFT")
    finally:
        db.close()
    assert len(sent) == 1


def test_default_indicator_is_mt5(env):
    client, maker, _ = env
    client.post("/webhook/mt5-signal", json=_body(strategy=None))
    db = maker()
    try:
        assert db.query(Signal).one().indicator == "MT5"
    finally:
        db.close()


def test_dedup_by_id(env):
    client, maker, sent = env
    first = client.post("/webhook/mt5-signal", json=_body()).json()
    second = client.post("/webhook/mt5-signal", json=_body()).json()
    assert second == {"ok": True, "deduped": True, "id": first["id"]}
    assert len(sent) == 1


def test_rejects_webhook_secret_and_bad_token(env):
    client, maker, _ = env
    assert client.post("/webhook/mt5-signal", json=_body(secret="tv-secret")).status_code == 401
    assert client.post("/webhook/mt5-signal", json=_body(secret="nope")).status_code == 401


def test_rejects_when_ea_token_unset(env, monkeypatch):
    client, _, _ = env
    monkeypatch.setattr(wh.settings, "EA_TOKEN", "")
    assert client.post("/webhook/mt5-signal", json=_body()).status_code == 401


def test_tradingview_still_uses_tradingview_source(env):
    client, maker, _ = env
    r = client.post("/webhook/tradingview", json=_body(secret="tv-secret", id="TV-1"))
    assert r.status_code == 200
    db = maker()
    try:
        sig = db.query(Signal).one()
        assert (sig.source, sig.symbol) == ("tradingview", "XAUUSD")
    finally:
        db.close()


def test_stats_sources_include_mt5():
    assert set(EXTERNAL_SIGNAL_SOURCES) == {"tradingview", "mt5"}
