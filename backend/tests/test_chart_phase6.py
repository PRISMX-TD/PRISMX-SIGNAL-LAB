"""图表阶段 6 的后端接口（2026-11-27）：range / batch / sessions / spec / day-refs（routers/chart_market.py）
与图表布局（rev 57，routers/chart_layouts.py）。
Chart phase-6 backend: range / batch / sessions / spec / day-refs and chart layouts (rev 57).

写法同 test_chart_drawings：StaticPool 内存 SQLite + 只挂这两个 router 的小 app，鉴权依赖换成可变的
「当前是谁」指针；用普通 TestClient（不用 with，不跑 lifespan）。
Same setup as test_chart_drawings: StaticPool in-memory SQLite, a small app mounting just these two
routers, and a mutable "who is calling" auth override; a plain TestClient (no lifespan).
"""
import time

import pytest
from sqlalchemy import create_engine, event, inspect, text

import app.core.database as db_mod
from app.core.config import settings
from app.models import Candle, ChartLayout, MT5Account, User
from app.routers import chart as chart_router
from app.routers import chart_layouts as cl
from app.routers import chart_market as cm
from app.services import chart_store, shared_cache


# ---------------------------------------------------------------- fixtures

@pytest.fixture()
def api_db():
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def pushes(monkeypatch):
    sent: list[tuple[str, dict]] = []

    async def _push(user_id, message):
        sent.append((user_id, message))

    monkeypatch.setattr(cl.manager, "push_to_client", _push)
    return sent


@pytest.fixture()
def users(api_db):
    a = User(email="a@t.co", api_token="tok_a")
    b = User(email="b@t.co", api_token="tok_b")
    api_db.add_all([a, b])
    api_db.commit()
    return a, b


@pytest.fixture()
def no_quotes(monkeypatch):
    """默认没有任何报价、没有活跃品种 / no quotes and no active symbols by default."""
    async def _empty_user_quotes(user_id):
        return []

    async def _empty_all():
        return []

    monkeypatch.setattr(cm.manager, "get_quotes_async", _empty_user_quotes)
    monkeypatch.setattr(cm.quotes_store, "get_all_async", _empty_all)
    monkeypatch.setattr(cm.quotes_store, "get_active_symbols", lambda: [])


@pytest.fixture()
def clean_chart_store():
    chart_store._candles.clear()
    chart_store._updated_at.clear()
    yield
    chart_store._candles.clear()
    chart_store._updated_at.clear()


def _make_client(db, who: dict | None):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.services import deps

    cm.user_limiter.reset()
    app = FastAPI()
    app.state.limiter = cm.user_limiter
    app.include_router(cm.router, prefix="/api")
    app.include_router(cl.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    if who is not None:
        app.dependency_overrides[deps.get_current_user_id_light] = lambda: who["id"]
    return TestClient(app)


@pytest.fixture()
def client(api_db, users, pushes, no_quotes, clean_chart_store):
    a, _b = users
    who = {"id": a.id}
    c = _make_client(api_db, who)
    c.who = who
    yield c
    cm.user_limiter.reset()


BASE_T = 1_700_000_040  # 落在分钟网格上 / on the minute grid


def _candles(db, symbol, interval, ts, price=2000.0):
    for i, t in enumerate(ts):
        p = price + i
        db.add(Candle(symbol=symbol, interval=interval, t=t, o=p, h=p + 1, l=p - 1, c=p + 0.5, v=10 + i))
    db.commit()


# ---------------------------------------------------------------- auth

def test_all_endpoints_require_login(api_db):
    c = _make_client(api_db, None)
    for path in (
        "/api/chart/range?symbol=XAUUSD&interval=1&from=0&to=10",
        "/api/chart/batch?symbols=XAUUSD&interval=1",
        "/api/chart/sessions?symbol=XAUUSD",
        "/api/chart/spec?symbol=XAUUSD",
        "/api/chart/day-refs",
        "/api/chart/layouts",
    ):
        assert c.get(path).status_code == 401, path
    assert c.post("/api/chart/layouts", json={"name": "x", "data": {}}).status_code == 401
    assert c.put("/api/chart/layouts/abc", json={"name": "x"}).status_code == 401
    assert c.delete("/api/chart/layouts/abc").status_code == 401
    cm.user_limiter.reset()


def test_routers_are_mounted_in_main_app():
    from fastapi.routing import APIRoute

    from app import main as app_main

    paths = {(r.path, m) for r in app_main.app.routes if isinstance(r, APIRoute) for m in r.methods}
    for p in ("/api/chart/range", "/api/chart/batch", "/api/chart/sessions", "/api/chart/spec",
              "/api/chart/day-refs", "/api/chart/layouts"):
        assert (p, "GET") in paths, p
    assert ("/api/chart/layouts", "POST") in paths
    assert ("/api/chart/layouts/{layout_id}", "PUT") in paths
    assert ("/api/chart/layouts/{layout_id}", "DELETE") in paths


# ================================================================ /chart/range

def test_range_inclusive_ascending_with_earliest(client, api_db):
    ts = [BASE_T + i * 60 for i in range(10)]
    _candles(api_db, "XAUUSD", "1", ts)
    r = client.get(f"/api/chart/range?symbol=xauusd&interval=1&from={ts[2]}&to={ts[5]}")
    assert r.status_code == 200
    body = r.json()
    assert body["symbol"] == "XAUUSD" and body["interval"] == "1"
    assert [b["t"] for b in body["bars"]] == ts[2:6]
    assert body["truncated"] is False
    assert body["earliest"] == ts[0]
    assert set(body["bars"][0]) == {"t", "o", "h", "l", "c", "v"}
    assert body["bars"][0]["o"] == 2002.0 and body["bars"][0]["v"] == 12


def test_range_truncation_keeps_the_newest(client, api_db):
    ts = [BASE_T + i * 60 for i in range(10)]
    _candles(api_db, "XAUUSD", "1", ts)
    body = client.get(f"/api/chart/range?symbol=XAUUSD&interval=1&from={ts[0]}&to={ts[-1]}&limit=3").json()
    assert [b["t"] for b in body["bars"]] == ts[-3:]
    assert body["truncated"] is True
    # 恰好 limit 根不算截断 / exactly `limit` rows is not truncated
    body = client.get(f"/api/chart/range?symbol=XAUUSD&interval=1&from={ts[0]}&to={ts[-1]}&limit=10").json()
    assert len(body["bars"]) == 10 and body["truncated"] is False


def test_range_other_interval_and_symbol_isolated(client, api_db):
    _candles(api_db, "XAUUSD", "1", [BASE_T])
    _candles(api_db, "XAUUSD", "5", [BASE_T + 300])
    _candles(api_db, "EURUSD", "1", [BASE_T + 60])
    body = client.get(f"/api/chart/range?symbol=XAUUSD&interval=1&from=0&to={BASE_T + 10_000}").json()
    assert [b["t"] for b in body["bars"]] == [BASE_T]


def test_range_empty_and_earliest_null(client):
    body = client.get("/api/chart/range?symbol=XAUUSD&interval=D&from=0&to=100").json()
    assert body == {"symbol": "XAUUSD", "interval": "D", "bars": [], "truncated": False, "earliest": None}


def test_range_earliest_is_cached(client, api_db):
    _candles(api_db, "XAUUSD", "1", [BASE_T])
    q = f"/api/chart/range?symbol=XAUUSD&interval=1&from=0&to={BASE_T}"
    assert client.get(q).json()["earliest"] == BASE_T
    _candles(api_db, "XAUUSD", "1", [BASE_T - 60])
    assert client.get(q).json()["earliest"] == BASE_T          # 5 分钟缓存 / cached
    shared_cache.clear_for_tests()
    assert client.get(q).json()["earliest"] == BASE_T - 60


@pytest.mark.parametrize("qs,code", [
    ("symbol=XAUUSD&interval=2&from=0&to=10", 400),             # bad interval
    ("symbol=XAUUSD&interval=1&from=10&to=5", 400),             # from > to
    (f"symbol=XAUUSD&interval=1&from=0&to={101 * 366 * 86400}", 400),  # span too big
    ("symbol=XAU%20USD&interval=1&from=0&to=10", 400),          # bad symbol
    ("symbol=XAUUSD&interval=1&from=0&to=10&limit=5001", 422),  # limit cap
    ("symbol=XAUUSD&interval=1&from=0&to=10&limit=0", 422),
    ("symbol=XAUUSD&interval=1&from=-1&to=10", 422),
    ("symbol=XAUUSD&interval=1&to=10", 422),                    # from missing
])
def test_range_validation(client, qs, code):
    assert client.get(f"/api/chart/range?{qs}").status_code == code


def test_range_rate_limit(client):
    n = int(cm.RANGE_RATE_LIMIT.split("/")[0])
    codes = [client.get("/api/chart/range?symbol=XAUUSD&interval=1&from=0&to=10").status_code
             for _ in range(n + 3)]
    assert codes[0] == 200 and codes[n - 1] == 200 and 429 in codes[n:]


# ================================================================ /chart/batch

def test_batch_latest_pages_dedup_and_unknown(client, api_db):
    _candles(api_db, "XAUUSD", "15", [BASE_T + i * 900 for i in range(8)])
    _candles(api_db, "EURUSD", "15", [BASE_T + i * 900 for i in range(3)], price=1.1)
    r = client.get("/api/chart/batch?symbols=xauusd,EURUSD,XAUUSD,NOPE&interval=15&limit=5")
    assert r.status_code == 200
    body = r.json()
    assert body["interval"] == "15"
    assert list(body["series"]) == ["XAUUSD", "EURUSD", "NOPE"]
    x = body["series"]["XAUUSD"]
    assert [b["t"] for b in x["bars"]] == [BASE_T + i * 900 for i in range(3, 8)]
    assert x["hasMore"] is True
    e = body["series"]["EURUSD"]
    assert len(e["bars"]) == 3 and e["hasMore"] is False
    assert body["series"]["NOPE"] == {"bars": [], "hasMore": False}


def test_batch_matches_history_semantics(client, api_db):
    ts = [BASE_T + i * 60 for i in range(7)]
    _candles(api_db, "XAUUSD", "1", ts)
    batch = client.get("/api/chart/batch?symbols=XAUUSD&interval=1&limit=4").json()["series"]["XAUUSD"]
    rows = (api_db.query(Candle.t).filter(Candle.symbol == "XAUUSD").order_by(Candle.t.desc()).limit(4).all())
    assert [b["t"] for b in batch["bars"]] == sorted(r[0] for r in rows)


def test_batch_is_one_query_for_many_symbols(client, api_db):
    for s in ("AAA", "BBB", "CCC"):
        _candles(api_db, s, "1", [BASE_T, BASE_T + 60])
    seen: list[str] = []

    def _hook(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT") and "CANDLES" in statement.upper():
            seen.append(statement)

    event.listen(api_db.get_bind(), "before_cursor_execute", _hook)
    try:
        body = client.get("/api/chart/batch?symbols=AAA,BBB,CCC&interval=1&limit=10").json()
    finally:
        event.remove(api_db.get_bind(), "before_cursor_execute", _hook)
    assert len(seen) == 1
    assert all(len(body["series"][s]["bars"]) == 2 for s in ("AAA", "BBB", "CCC"))


def test_batch_first_page_shares_history_cache(client, api_db):
    first = chart_router.CHART_HISTORY_FIRST_PAGE
    _candles(api_db, "XAUUSD", "1", [BASE_T])
    # 已有的历史首页缓存被直接用上 / an existing history first-page entry is served as is
    fake = {"symbol": "EURUSD", "interval": "1", "bars": [{"t": 1, "o": 1, "h": 1, "l": 1, "c": 1, "v": 0}],
            "hasMore": False}
    shared_cache.set_json(chart_router._history_first_key("EURUSD", "1"), fake, 15)
    body = client.get(f"/api/chart/batch?symbols=XAUUSD,EURUSD&interval=1&limit={first}").json()
    assert body["series"]["EURUSD"] == {"bars": fake["bars"], "hasMore": False}
    # 没命中的那个查库后写进同一个键，形状与 /chart/history 一样 / misses fill the same key, history-shaped
    cached = shared_cache.get_json(chart_router._history_first_key("XAUUSD", "1"))
    assert cached == {"symbol": "XAUUSD", "interval": "1", "bars": body["series"]["XAUUSD"]["bars"],
                      "hasMore": False}
    # 其它 limit 不写缓存 / other limits don't write the cache
    shared_cache.clear_for_tests()
    client.get("/api/chart/batch?symbols=XAUUSD&interval=1&limit=7")
    assert shared_cache.get_json(chart_router._history_first_key("XAUUSD", "1")) is None


@pytest.mark.parametrize("qs,code", [
    ("symbols=&interval=1", 400),
    ("symbols=,,&interval=1", 400),
    ("symbols=A,B,C,D,E,F,G,H,I&interval=1", 400),
    ("symbols=XAU USD&interval=1", 400),
    ("symbols=XAUUSD&interval=7", 400),
    ("symbols=XAUUSD&interval=1&limit=1001", 422),
])
def test_batch_validation(client, qs, code):
    assert client.get(f"/api/chart/batch?{qs}").status_code == code


def test_batch_eight_symbols_ok_after_dedup(client):
    syms = ",".join(["A", "B", "C", "D", "E", "F", "G", "H", "a", "b"])
    assert client.get(f"/api/chart/batch?symbols={syms}&interval=1").status_code == 200


# ================================================================ /chart/sessions

_GW_REPLY = {
    "ok": True, "symbol": "XAUUSD.s", "group": "g", "tradeMode": 4, "serverTime": 1, "serverUtcOffsetSec": 7200.0,
    "sessionsKnown": True, "holiday": False, "openNow": True, "nextOpenUtc": 1_764_000_000.0,
    "sessions": [
        {"day": 1, "open": 60, "close": 1440},
        {"day": 1, "open": 0, "close": 30},
        {"day": 7, "open": 0, "close": 100},        # 非法星期 / invalid weekday
        {"day": 2, "open": 500, "close": 400},      # close <= open
        {"day": 3, "open": -5, "close": 2000},      # 夹取 / clamped
    ],
}


@pytest.fixture()
def gw(monkeypatch):
    calls: list[tuple] = []
    state = {"reply": dict(_GW_REPLY), "raise": False}

    async def _sessions(symbol, login=None, timeout=3.0):
        calls.append((symbol, login))
        if state["raise"]:
            raise RuntimeError("boom")
        return state["reply"]

    monkeypatch.setattr(cm.gateway_client, "get_symbol_sessions", _sessions)
    monkeypatch.setattr(settings, "MARKET_HOURS_GATE", True)
    state["calls"] = calls
    return state


def test_sessions_gate_off_is_unknown(client, monkeypatch):
    monkeypatch.setattr(settings, "MARKET_HOURS_GATE", False)
    r = client.get("/api/chart/sessions?symbol=xauusd")
    assert r.status_code == 200
    assert r.json() == {"symbol": "XAUUSD", "known": False, "openNow": None, "holiday": False,
                        "nextOpenAt": None, "serverUtcOffsetSec": None, "sessions": [], "source": "none"}


def test_sessions_from_gateway_normalised_and_cached(client, gw, api_db, users):
    a, _b = users
    api_db.add(MT5Account(user_id=a.id, login="555", server="s", source="gateway"))
    api_db.commit()
    body = client.get("/api/chart/sessions?symbol=XAUUSD").json()
    assert body["known"] is True and body["source"] == "gateway"
    assert body["openNow"] is True and body["holiday"] is False
    assert body["serverUtcOffsetSec"] == 7200
    assert body["nextOpenAt"].startswith("2025-11-24T")
    assert body["sessions"] == [
        {"day": 1, "open": 0, "close": 30},
        {"day": 1, "open": 60, "close": 1440},
        {"day": 3, "open": 0, "close": 1440},
    ]
    # 用的是该用户的网关账号 login，和 /orders/market-status 一样 / the user's gateway login is passed
    assert gw["calls"] == [("XAUUSD", 555)]
    # 60 秒缓存：第二次不再问网关 / cached: the second call doesn't hit the gateway
    assert client.get("/api/chart/sessions?symbol=XAUUSD").json()["sessions"] == body["sessions"]
    assert len(gw["calls"]) == 1


def test_sessions_without_gateway_account_passes_no_login(client, gw, api_db, users):
    a, _b = users
    api_db.add(MT5Account(user_id=a.id, login="777", server="s", source="bridge"))
    api_db.commit()
    client.get("/api/chart/sessions?symbol=BTCUSDT")
    assert gw["calls"] == [("BTCUSD", None)]       # 别名归一 / alias folded


@pytest.mark.parametrize("mode", ["none", "raise", "not_ok"])
def test_sessions_gateway_unreachable_is_unknown_200(client, gw, mode):
    if mode == "none":
        gw["reply"] = None
    elif mode == "raise":
        gw["raise"] = True
    else:
        gw["reply"] = {"ok": False}
    r = client.get("/api/chart/sessions?symbol=XAUUSD")
    assert r.status_code == 200
    body = r.json()
    assert body["known"] is False and body["sessions"] == [] and body["source"] == "none"


def test_sessions_unknown_sessions_flag(client, gw):
    gw["reply"] = {**_GW_REPLY, "sessionsKnown": False, "sessions": [], "nextOpenUtc": 0}
    body = client.get("/api/chart/sessions?symbol=XAUUSD").json()
    assert body["known"] is False and body["openNow"] is None and body["nextOpenAt"] is None
    assert body["source"] == "gateway"


def test_sessions_validation_and_rate_limit(client, gw):
    assert client.get("/api/chart/sessions?symbol=XAU/USD").status_code == 400
    n = int(cm.SESSIONS_RATE_LIMIT.split("/")[0])
    codes = [client.get("/api/chart/sessions?symbol=XAUUSD").status_code for _ in range(n + 3)]
    assert 429 in codes[n - 1:] and codes[0] == 200


# ================================================================ /chart/spec

def test_spec_estimate_without_quotes(client):
    body = client.get("/api/chart/spec?symbol=XAUUSD").json()
    assert body == {
        "symbol": "XAUUSD", "digits": None, "contractSize": 100.0, "tickSize": None, "tickValue": None,
        "volumeMin": 0.01, "volumeMax": None, "volumeStep": 0.01,
        "currencyBase": "XAU", "currencyProfit": "USD", "currencyMargin": None,
        "description": None, "source": "estimate",
    }


def test_spec_fx_and_index(client):
    fx = client.get("/api/chart/spec?symbol=EURUSD").json()
    assert fx["contractSize"] == 100000.0
    assert (fx["currencyBase"], fx["currencyProfit"], fx["currencyMargin"]) == ("EUR", "USD", "EUR")
    idx = client.get("/api/chart/spec?symbol=US30").json()
    assert idx["volumeMin"] == 0.1 and idx["volumeStep"] == 0.1
    assert idx["contractSize"] is None and idx["source"] == "none"
    wti = client.get("/api/chart/spec?symbol=USOIL").json()
    assert wti["volumeStep"] == 0.1 and wti["contractSize"] == 100.0


def test_spec_digits_from_global_quotes(client, monkeypatch):
    async def _all():
        return [{"symbol": "XAUUSD", "bid": 1, "ask": 2, "digits": 2}]

    monkeypatch.setattr(cm.quotes_store, "get_all_async", _all)
    body = client.get("/api/chart/spec?symbol=XAUUSD").json()
    assert body["digits"] == 2 and body["tickValue"] is None


def test_spec_from_users_own_bridge_quotes(client, monkeypatch, users):
    a, b = users
    seen = []

    async def _user_quotes(user_id):
        seen.append(user_id)
        if user_id != a.id:
            return []
        return [
            {"symbol": "EURUSD.s", "login": "1", "bid": 1, "ask": 1, "digits": 5},
            {"symbol": "XAUUSD.s", "login": "1", "bid": 1, "ask": 2, "digits": 2},
            {"symbol": "XAUUSD.s", "login": "2", "bid": 1, "ask": 2, "digits": 2,
             "contractSize": 100, "tickSize": 0.01, "tickValue": 1.0},
        ]

    monkeypatch.setattr(cm.manager, "get_quotes_async", _user_quotes)
    body = client.get("/api/chart/spec?symbol=XAUUSD").json()
    assert body["source"] == "bridge"
    assert (body["digits"], body["contractSize"], body["tickSize"], body["tickValue"]) == (2, 100.0, 0.01, 1.0)
    # B 拿不到 A 的桥接规格 / B doesn't get A's bridge spec
    client.who["id"] = b.id
    other = client.get("/api/chart/spec?symbol=XAUUSD").json()
    assert other["source"] == "estimate" and other["tickValue"] is None
    assert seen == [a.id, b.id]


def test_spec_unknown_symbol_and_validation(client):
    body = client.get("/api/chart/spec", params={"symbol": "#AAPL"}).json()
    assert body["symbol"] == "#AAPL" and body["contractSize"] is None and body["source"] == "none"
    assert client.get("/api/chart/spec", params={"symbol": "XAU USD"}).status_code == 400


def test_build_spec_ignores_bad_numbers():
    spec = cm.build_spec("XAUUSD", [{"symbol": "XAUUSD", "digits": True, "contractSize": float("nan"),
                                     "tickSize": -1, "tickValue": "x"}], [])
    assert spec["digits"] is None and spec["contractSize"] == 100.0 and spec["tickSize"] is None
    assert spec["source"] == "estimate"


# ================================================================ /chart/day-refs

DAY = 86400


def _today() -> int:
    return int(time.time()) // DAY * DAY


def test_day_refs_db_plus_forming_bar(client, api_db, monkeypatch):
    d = _today()
    monkeypatch.setattr(cm.quotes_store, "get_active_symbols", lambda: ["XAUUSD", "EURUSD"])
    _candles(api_db, "XAUUSD", "D", [d - 3 * DAY, d - 2 * DAY, d - DAY], price=2000.0)
    _candles(api_db, "EURUSD", "D", [d - DAY], price=1.1)
    _candles(api_db, "GBPUSD", "D", [d - DAY], price=1.3)          # 不活跃 / not active
    # 今天正在形成的日线只在 chart_store 里 / today's forming bar lives only in chart_store
    chart_store.replace_series("XAUUSD", "D", [{"t": d - DAY, "o": 2002.0, "h": 0, "l": 0, "c": 2002.5, "v": 0},
                                               {"t": d, "o": 2010.0, "h": 0, "l": 0, "c": 2011.0, "v": 0}])
    r = client.get("/api/chart/day-refs")
    assert r.status_code == 200
    items = r.json()["items"]
    assert set(items) == {"XAUUSD", "EURUSD"}
    assert items["XAUUSD"] == {"open": 2010.0, "prevClose": 2002.5, "t": d}
    assert items["EURUSD"] == {"open": 1.1, "prevClose": None, "t": d - DAY}


def test_day_refs_db_only_and_lookback(client, api_db, monkeypatch):
    d = _today()
    monkeypatch.setattr(cm.quotes_store, "get_active_symbols", lambda: ["XAUUSD"])
    _candles(api_db, "XAUUSD", "D", [d - 40 * DAY, d - 2 * DAY, d - DAY], price=2000.0)
    items = client.get("/api/chart/day-refs").json()["items"]
    # 最新 = d-1（第 3 根，open 2002），前一根 = d-2（close 2001.5）
    assert items["XAUUSD"] == {"open": 2002.0, "prevClose": 2001.5, "t": d - DAY}


def test_day_refs_without_active_symbols_uses_all_recent(client, api_db):
    d = _today()
    _candles(api_db, "XAUUSD", "D", [d - DAY], price=2000.0)
    _candles(api_db, "OLD", "D", [d - 60 * DAY], price=5.0)
    items = client.get("/api/chart/day-refs").json()["items"]
    assert set(items) == {"XAUUSD"}


def test_day_refs_cached_60s_and_one_db_query(client, api_db, monkeypatch):
    d = _today()
    monkeypatch.setattr(cm.quotes_store, "get_active_symbols", lambda: ["XAUUSD", "EURUSD", "GBPUSD"])
    for s in ("XAUUSD", "EURUSD", "GBPUSD"):
        _candles(api_db, s, "D", [d - 2 * DAY, d - DAY])
    seen: list[str] = []

    def _hook(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT") and "CANDLES" in statement.upper():
            seen.append(statement)

    event.listen(api_db.get_bind(), "before_cursor_execute", _hook)
    try:
        first = client.get("/api/chart/day-refs").json()
        assert len(seen) == 1
        _candles(api_db, "XAUUSD", "D", [d], price=3000.0)
        assert client.get("/api/chart/day-refs").json() == first     # 缓存 / cached
        assert len(seen) == 1
    finally:
        event.remove(api_db.get_bind(), "before_cursor_execute", _hook)


def test_day_refs_rate_limit(client):
    n = int(cm.DAY_REFS_RATE_LIMIT.split("/")[0])
    codes = [client.get("/api/chart/day-refs").status_code for _ in range(n + 2)]
    assert codes[n - 1] == 200 and 429 in codes[n:]


# ================================================================ /chart/layouts

def test_layout_crud_roundtrip(client, api_db, pushes, users):
    a, _b = users
    assert client.get("/api/chart/layouts").json() == {"layouts": []}
    data = {"grid": "2x2", "cells": [{"symbol": "XAUUSD", "interval": "15"}], "note": "支撑位 ✓"}
    r = client.post("/api/chart/layouts", json={"name": "  My layout ", "data": data})
    assert r.status_code == 200
    lay = r.json()
    assert lay["name"] == "My layout" and lay["data"] == data
    assert lay["createdAt"].endswith("Z") and lay["updatedAt"] == lay["createdAt"]
    assert pushes == [(a.id, {"type": "CHART_LAYOUTS_UPDATE", "data": {"id": lay["id"]}})]

    pushes.clear()
    r2 = client.put(f"/api/chart/layouts/{lay['id']}", json={"name": "Renamed"})
    assert r2.status_code == 200
    up = r2.json()
    assert up["name"] == "Renamed" and up["data"] == data and up["createdAt"] == lay["createdAt"]
    assert pushes == [(a.id, {"type": "CHART_LAYOUTS_UPDATE", "data": {"id": lay["id"]}})]

    r3 = client.put(f"/api/chart/layouts/{lay['id']}", json={"data": [1, 2, 3]})
    assert r3.json()["data"] == [1, 2, 3] and r3.json()["name"] == "Renamed"

    listed = client.get("/api/chart/layouts").json()["layouts"]
    assert listed == [r3.json()]

    pushes.clear()
    assert client.delete(f"/api/chart/layouts/{lay['id']}").json() == {"deleted": True}
    assert pushes == [(a.id, {"type": "CHART_LAYOUTS_UPDATE", "data": {"id": lay["id"]}})]
    api_db.expire_all()
    assert api_db.query(ChartLayout).count() == 0
    # 再删一次：deleted=false，不推送 / again: deleted=false, no push
    pushes.clear()
    assert client.delete(f"/api/chart/layouts/{lay['id']}").json() == {"deleted": False}
    assert pushes == []


def test_layouts_ordered_by_updated_desc(client):
    ids = []
    for n in ("one", "two", "three"):
        ids.append(client.post("/api/chart/layouts", json={"name": n, "data": {}}).json()["id"])
        time.sleep(0.005)
    time.sleep(0.005)
    client.put(f"/api/chart/layouts/{ids[0]}", json={"name": "one*"})
    names = [x["name"] for x in client.get("/api/chart/layouts").json()["layouts"]]
    assert names == ["one*", "three", "two"]


@pytest.mark.parametrize("name,code", [("", 422), ("   ", 422), ("x" * 61, 422), ("x" * 60, 200), (" 中文 ", 200)])
def test_layout_name_rules(client, name, code):
    assert client.post("/api/chart/layouts", json={"name": name, "data": {}}).status_code == code


def test_layout_name_missing_is_422(client):
    assert client.post("/api/chart/layouts", json={"data": {}}).status_code == 422


def test_layout_data_size_cap(client, monkeypatch, api_db):
    monkeypatch.setattr(cl, "LAYOUT_DATA_MAX_BYTES", 200)
    r = client.post("/api/chart/layouts", json={"name": "big", "data": {"x": "y" * 300}})
    assert r.status_code == 413
    assert "过大" in r.json()["detail"] and "too large" in r.json()["detail"]
    assert api_db.query(ChartLayout).count() == 0
    ok = client.post("/api/chart/layouts", json={"name": "small", "data": {"x": 1}}).json()
    r2 = client.put(f"/api/chart/layouts/{ok['id']}", json={"data": {"x": "y" * 300}})
    assert r2.status_code == 413


def test_layout_real_cap_is_64kb():
    assert cl.LAYOUT_DATA_MAX_BYTES == 64 * 1024
    with pytest.raises(Exception) as ei:
        cl.encode_layout_data({"t": "汉" * (cl.LAYOUT_DATA_MAX_BYTES // 3)})
    assert getattr(ei.value, "status_code", None) == 413


def test_layout_nan_rejected():
    with pytest.raises(Exception) as ei:
        cl.encode_layout_data({"p": float("nan")})
    assert getattr(ei.value, "status_code", None) == 422


def test_layout_count_cap(client, monkeypatch):
    monkeypatch.setattr(cl, "LAYOUTS_MAX", 3)
    ids = [client.post("/api/chart/layouts", json={"name": f"L{i}", "data": {}}).json()["id"] for i in range(3)]
    r = client.post("/api/chart/layouts", json={"name": "L3", "data": {}})
    assert r.status_code == 409
    assert "最多" in r.json()["detail"] and "at most 3" in r.json()["detail"]
    client.delete(f"/api/chart/layouts/{ids[0]}")
    assert client.post("/api/chart/layouts", json={"name": "L3", "data": {}}).status_code == 200


def test_layout_put_requires_something(client):
    lay = client.post("/api/chart/layouts", json={"name": "a", "data": {}}).json()
    assert client.put(f"/api/chart/layouts/{lay['id']}", json={}).status_code == 422
    assert client.put(f"/api/chart/layouts/{lay['id']}", json={"name": "  "}).status_code == 422
    # data 显式 null 是合法的替换 / an explicit null data is a valid replacement
    r = client.put(f"/api/chart/layouts/{lay['id']}", json={"data": None})
    assert r.status_code == 200 and r.json()["data"] is None


def test_layouts_isolated_between_users(client, users, api_db, pushes):
    a, b = users
    lay = client.post("/api/chart/layouts", json={"name": "mine", "data": {"k": 1}}).json()
    client.who["id"] = b.id
    assert client.get("/api/chart/layouts").json() == {"layouts": []}
    assert client.put(f"/api/chart/layouts/{lay['id']}", json={"name": "stolen"}).status_code == 404
    pushes.clear()
    assert client.delete(f"/api/chart/layouts/{lay['id']}").json() == {"deleted": False}
    assert pushes == []
    assert client.put("/api/chart/layouts/not a valid id!", json={"name": "x"}).status_code == 404
    client.who["id"] = a.id
    got = client.get("/api/chart/layouts").json()["layouts"]
    assert len(got) == 1 and got[0]["name"] == "mine"


def test_layout_count_cap_is_per_user(client, monkeypatch, users):
    _a, b = users
    monkeypatch.setattr(cl, "LAYOUTS_MAX", 2)
    for i in range(2):
        assert client.post("/api/chart/layouts", json={"name": f"a{i}", "data": {}}).status_code == 200
    client.who["id"] = b.id
    assert client.post("/api/chart/layouts", json={"name": "b0", "data": {}}).status_code == 200


def test_layout_write_rate_limit(client):
    n = int(cl.LAYOUTS_WRITE_RATE_LIMIT.split("/")[0])
    lay = client.post("/api/chart/layouts", json={"name": "a", "data": {}}).json()
    codes = [client.put(f"/api/chart/layouts/{lay['id']}", json={"name": f"n{i}"}).status_code
             for i in range(n + 3)]
    # 创建那次也算一次写 / the create counted as one write too
    assert codes[0] == 200 and codes[n - 2] == 200 and 429 in codes[n - 1:]


def test_failed_writes_push_nothing(client, pushes):
    client.post("/api/chart/layouts", json={"name": "", "data": {}})
    client.put("/api/chart/layouts/missing", json={"name": "x"})
    assert pushes == []


# ---------------------------------------------------------------- migration (rev 57)

def test_schema_rev_bumped_to_57():
    assert db_mod.CURRENT_SCHEMA_REV >= 57


@pytest.fixture()
def legacy56_engine(monkeypatch, tmp_path):
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401

    url = "sqlite:///" + str(tmp_path / "legacy56.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP TABLE chart_layouts"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    db_mod._write_schema_rev(56)
    yield eng
    eng.dispose()


def test_rev57_init_db_creates_the_table(legacy56_engine):
    assert "chart_layouts" not in inspect(legacy56_engine).get_table_names()
    db_mod.init_db()
    insp = inspect(legacy56_engine)
    assert "chart_layouts" in insp.get_table_names()
    cols = {c["name"] for c in insp.get_columns("chart_layouts")}
    assert {"id", "user_id", "name", "data", "created_at", "updated_at"} <= cols
    idx_cols = [i["column_names"] for i in insp.get_indexes("chart_layouts")]
    assert ["user_id"] in idx_cols
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV
