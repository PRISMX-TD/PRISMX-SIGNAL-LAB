"""策略编辑器的候选品种端点测试。

存在的理由：策略页首屏此前靠不传参的 /strategies/coverage 拿这份名单，那条路径
会对每个 (品种, 周期) 组合各算一行（7 × 6 = 42 行，底层数十万行 K 线），而首屏
真正用到的只是品种名。本端点用一句 DISTINCT 取代它。

Tests for the strategy editor's candidate-symbol endpoint. Why it exists: the
page used to get this list from an argument-less /strategies/coverage, which
computes a row per (symbol, interval) pair — 42 of them over hundreds of
thousands of candle rows — when all the first paint needs is the symbol names.
One DISTINCT replaces it.
"""
from app.models import Candle
from app.services import quotes_store
from app.services.strategy import coverage as cv


def _seed(db, symbol="XAUUSD", interval="15", count=3):
    for i in range(count):
        db.add(Candle(
            symbol=symbol, interval=interval, t=i * 900,
            o=100.0, h=101.0, l=99.0, c=100.5, v=1.0,
        ))
    db.commit()


def test_returns_symbols_with_history_and_active_symbols(client, db, auth_headers, user):
    user.plan = "PRO"
    db.commit()
    cv.invalidate_symbols_cache()
    quotes_store._quotes.clear()
    quotes_store._updated_at.clear()
    _seed(db, symbol="XAUUSD")
    _seed(db, symbol="EURUSD")
    res = client.get("/api/strategies/symbols", headers=auth_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["symbols"] == ["EURUSD", "XAUUSD"]
    assert body["activeSymbols"] == []


def test_active_symbols_is_a_subset_view_not_the_candidate_list(client, db, auth_headers, user):
    """候选集必须能比活跃集更宽，否则置灰永不生效。
    Candidates must be able to exceed actives, or greying never happens."""
    user.plan = "PRO"
    db.commit()
    cv.invalidate_symbols_cache()
    quotes_store._quotes.clear()
    quotes_store._updated_at.clear()
    _seed(db, symbol="XAUUSD")
    _seed(db, symbol="EURUSD")
    quotes_store._quotes["XAUUSD"] = {"symbol": "XAUUSD", "bid": 2400.0, "ask": 2400.5, "digits": 2}
    quotes_store._updated_at["XAUUSD"] = __import__("time").time()
    body = client.get("/api/strategies/symbols", headers=auth_headers).json()
    assert body["symbols"] == ["EURUSD", "XAUUSD"]
    assert body["activeSymbols"] == ["XAUUSD"]
    quotes_store._quotes.clear()
    quotes_store._updated_at.clear()


def test_empty_table_returns_empty_list(client, db, auth_headers, user):
    user.plan = "PRO"
    db.commit()
    cv.invalidate_symbols_cache()
    res = client.get("/api/strategies/symbols", headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["symbols"] == []


def test_requires_auth(client, db):
    assert client.get("/api/strategies/symbols").status_code in (401, 403)
