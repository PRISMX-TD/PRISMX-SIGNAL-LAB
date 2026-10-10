"""/chart/history：只取 6 列元组行 + 短共享缓存；新收盘 bar 落库时首页缓存被删。
/chart/history reads six columns and is cached briefly; the first page is dropped when
a new closed bar lands."""
from sqlalchemy import event
from starlette.requests import Request

from app.models import Candle, User
from app.routers import chart
from app.services import shared_cache


def _request(token: str = "") -> Request:
    headers = [(b"authorization", f"Bearer {token}".encode())] if token else []
    return Request({"type": "http", "method": "GET", "path": "/chart/history", "headers": headers,
                    "client": ("127.0.0.1", 1), "query_string": b"", "server": ("t", 80),
                    "scheme": "http"})


def _add(db, t, sym="BTCUSD", iv="60"):
    db.add(Candle(symbol=sym, interval=iv, t=t, o=1.0, h=2.0, l=0.5, c=1.5, v=10))
    db.commit()


def _user(db):
    u = User(email="c@t.co", api_token="tok_c")
    db.add(u)
    db.commit()
    return u


def _selects(db):
    n = {"n": 0, "sql": []}

    def _hook(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT") and "FROM CANDLES" in statement.upper():
            n["n"] += 1
            n["sql"].append(statement)

    event.listen(db.get_bind(), "before_cursor_execute", _hook)
    return n


def _hist(db, u, **kw):
    kw.setdefault("limit", 50)
    kw.setdefault("before", None)
    return chart.chart_history(_request(), symbol="btcusd", interval="60", db=db, user=u, **kw)


def test_first_page_selects_six_columns_and_is_cached(db_session):
    u = _user(db_session)
    for i in range(5):
        _add(db_session, 3600 * (i + 1))
    n = _selects(db_session)
    out = _hist(db_session, u)
    assert [b["t"] for b in out["bars"]] == [3600 * (i + 1) for i in range(5)]
    assert out["hasMore"] is False and out["symbol"] == "BTCUSD"
    assert out["bars"][0] == {"t": 3600, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10}
    assert n["n"] == 1
    sql = n["sql"][0].lower()
    assert "candles.id" not in sql and "candles.symbol," not in sql.split("from")[0]   # 不取 id/symbol 列
    _add(db_session, 3600 * 6)
    assert _hist(db_session, u) == out and n["n"] == 1           # 缓存窗口内不重查
    shared_cache.delete(chart._history_first_key("BTCUSD", "60"))  # feed 里 new_ts 时做的事
    assert len(_hist(db_session, u)["bars"]) == 6 and n["n"] == 2


def test_before_page_cached_and_other_first_page_limits_not(db_session):
    u = _user(db_session)
    for i in range(10):
        _add(db_session, 3600 * (i + 1))
    n = _selects(db_session)
    p1 = _hist(db_session, u, limit=3, before=3600 * 8)
    assert [b["t"] for b in p1["bars"]] == [3600 * 5, 3600 * 6, 3600 * 7] and p1["hasMore"] is True
    _hist(db_session, u, limit=3, before=3600 * 8)
    assert n["n"] == 1                                            # 翻页命中缓存
    _hist(db_session, u, limit=200)
    _hist(db_session, u, limit=200)
    assert n["n"] == 3                                            # 非首屏档的首页：不缓存


def test_history_still_a_sync_endpoint():
    import inspect
    assert not inspect.iscoroutinefunction(chart.chart_history)


def test_off_grid_before_is_served_but_not_cached(db_session):
    """不在时间网格上的 before 照常返回同样的结果，但不进缓存：逐秒换 before 不能无限造键。
    An off-grid `before` returns the same bars but is never cached (no unbounded keys)."""
    u = _user(db_session)
    for i in range(10):
        _add(db_session, 3600 * (i + 1))
    n = _selects(db_session)
    on = _hist(db_session, u, limit=3, before=3600 * 8)
    off = _hist(db_session, u, limit=3, before=3600 * 7 + 7)       # (7h, 8h) 之间：结果相同
    assert off["bars"] == on["bars"]
    _hist(db_session, u, limit=3, before=3600 * 7 + 7)
    _hist(db_session, u, limit=3, before=3600 * 7 + 8)
    assert n["n"] == 4                                            # 网格上的 1 次 + 不在网格上的 3 次


def test_history_is_rate_limited_per_user(db_session):
    """按用户限流：同一个 token 超过额度返回 429。/ Per-user limit: 429 past the quota."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from slowapi import _rate_limit_exceeded_handler
    from slowapi.errors import RateLimitExceeded
    from app.core.security import create_access_token
    from app.core.strategy_limits import user_limiter
    from app.services import deps

    u = _user(db_session)
    _add(db_session, 3600)
    user_limiter.reset()
    db_session.connection()
    app = FastAPI()
    app.state.limiter = user_limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(chart.router)
    app.dependency_overrides[deps.get_db] = lambda: db_session
    app.dependency_overrides[deps.get_current_user] = lambda: u
    c = TestClient(app)
    token = create_access_token(u.id)
    h = {"Authorization": f"Bearer {token}"}
    codes = [c.get("/chart/history?symbol=BTCUSD&interval=60&limit=7", headers=h).status_code
             for _ in range(130)]                                  # 额度 120/分钟
    assert codes[0] == 200 and 429 in codes
    user_limiter.reset()
