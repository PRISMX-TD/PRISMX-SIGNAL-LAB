"""/api/bootstrap：各段与单独接口逐字相同；一段失败只置空该段并列入 failed。
Each section equals its standalone endpoint; a failing section is null and listed."""
import asyncio

import pytest

from app.models import MT5Account, Signal, User
from app.routers import bootstrap as bs
from app.routers import bridge, signals, trends


@pytest.fixture(autouse=True)
def _inline_threadpool(monkeypatch):
    async def _inline(fn, *a, **k):        # 内存 SQLite 不能跨线程 / in-memory SQLite is per-thread
        return fn(*a, **k)
    monkeypatch.setattr(bs, "run_in_threadpool", _inline)


def _seed(db):
    u = User(email="bs@t.co", api_token="tok_bs", plan="pro")
    db.add(u)
    db.commit()
    db.add(MT5Account(user_id=u.id, login="1001", server="s", balance=100.0))
    db.commit()
    return u


def _quotes_async(monkeypatch, quotes, symbols):
    async def _q():
        return quotes

    async def _s():
        return symbols

    monkeypatch.setattr(bs.quotes_store, "get_all_async", _q)
    monkeypatch.setattr(bs.quotes_store, "get_active_symbols_async", _s)


def test_bootstrap_sections_match_standalone_endpoints(db_session, monkeypatch):
    u = _seed(db_session)
    _quotes_async(monkeypatch, [{"symbol": "XAUUSD"}], ["XAUUSD"])
    out = asyncio.run(bs.get_bootstrap(user=u, db=db_session))
    assert out["failed"] == []
    assert out["signals"] == signals.list_signals(user=u, db=db_session)
    assert out["accounts"] == bridge.list_accounts(user=u, db=db_session)
    assert out["accounts"]["accounts"][0]["login"] == "1001"
    assert out["trends"] == trends.list_trends(user=u, db=db_session)
    assert out["quotes"] == {"quotes": [{"symbol": "XAUUSD"}]}
    assert out["symbols"] == {"symbols": ["XAUUSD"]}


def test_bootstrap_partial_failure_nulls_only_that_section(db_session, monkeypatch):
    u = _seed(db_session)
    _quotes_async(monkeypatch, [], [])

    def _boom(**kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(bs.trends_router, "list_trends", _boom)
    out = asyncio.run(bs.get_bootstrap(user=u, db=db_session))
    assert out["trends"] is None and out["failed"] == ["trends"]
    assert out["accounts"]["accounts"] and out["signals"] == {"signals": []}
