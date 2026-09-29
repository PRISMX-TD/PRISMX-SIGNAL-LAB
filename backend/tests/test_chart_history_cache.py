"""/chart/history：只取 6 列元组行 + 短共享缓存；新收盘 bar 落库时首页缓存被删。
/chart/history reads six columns and is cached briefly; the first page is dropped when
a new closed bar lands."""
from sqlalchemy import event

from app.models import Candle, User
from app.routers import chart
from app.services import shared_cache


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
    return chart.chart_history(symbol="btcusd", interval="60", db=db, user=u, **kw)


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
