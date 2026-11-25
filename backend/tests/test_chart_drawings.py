"""图表画线单独成表（rev 55，routers/chart_drawings.py）。
Chart drawings in their own table (rev 55, routers/chart_drawings.py).

接口用例走 TestClient，所以库用 StaticPool 的内存 SQLite（TestClient 在另一个线程里跑，见
test_persona.api_db）。鉴权依赖 get_current_user_id_light 换成「当前是谁」的可变指针，方便测
用户之间的隔离；「未登录 401」那条不覆盖它。
The API cases go through TestClient, hence a StaticPool in-memory SQLite (TestClient runs on another
thread; see test_persona.api_db). The light auth dependency is swapped for a mutable "who is
calling" pointer so isolation between users can be tested; the 401 case leaves it in place.
"""
import json
import re

import pytest
from sqlalchemy import create_engine, event, inspect, text

import app.core.database as db_mod
from app.models import ChartDrawing, User
from app.routers import chart_drawings as cd


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
    """记下所有 WS 推送 / capture every WS push."""
    sent: list[tuple[str, dict]] = []

    async def _push(user_id, message):
        sent.append((user_id, message))

    monkeypatch.setattr(cd.manager, "push_to_client", _push)
    return sent


@pytest.fixture()
def users(api_db):
    a = User(email="a@t.co", api_token="tok_a")
    b = User(email="b@t.co", api_token="tok_b")
    api_db.add_all([a, b])
    api_db.commit()
    return a, b


def _make_client(db, who: dict | None):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.services import deps

    cd.user_limiter.reset()
    app = FastAPI()
    app.state.limiter = cd.user_limiter
    app.include_router(cd.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    if who is not None:
        app.dependency_overrides[deps.get_current_user_id_light] = lambda: who["id"]
    return TestClient(app)


@pytest.fixture()
def client(api_db, users, pushes):
    a, _b = users
    who = {"id": a.id}
    c = _make_client(api_db, who)
    c.who = who
    yield c
    cd.user_limiter.reset()


def _line(i: int = 0) -> dict:
    return {"id": f"d{i}", "type": "trend", "points": [{"t": 1700000000 + i, "p": 2000.5 + i}], "color": "#fff"}


# ---------------------------------------------------------------- 鉴权 / auth

def test_all_endpoints_require_login(api_db):
    c = _make_client(api_db, None)
    assert c.get("/api/chart/drawings?symbol=XAUUSD").status_code == 401
    assert c.get("/api/chart/drawings/symbols").status_code == 401
    assert c.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": []}).status_code == 401
    cd.user_limiter.reset()


# ---------------------------------------------------------------- 读写 / read & write

def test_get_without_row_returns_empty_list(client):
    r = client.get("/api/chart/drawings?symbol=XAUUSD")
    assert r.status_code == 200
    assert r.json() == {"symbol": "XAUUSD", "drawings": [], "updatedAt": None}


def test_put_then_get_roundtrip_and_upsert(client, api_db):
    r = client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line(0)]})
    assert r.status_code == 200
    first = r.json()
    assert first["symbol"] == "XAUUSD" and first["updatedAt"].endswith("Z")

    g = client.get("/api/chart/drawings?symbol=XAUUSD").json()
    assert g == {"symbol": "XAUUSD", "drawings": [_line(0)], "updatedAt": first["updatedAt"]}

    # 再存一次是覆盖同一行，不是新增 / a second save overwrites the same row
    r2 = client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line(1), _line(2)]})
    assert r2.status_code == 200
    g2 = client.get("/api/chart/drawings?symbol=XAUUSD").json()
    assert g2["drawings"] == [_line(1), _line(2)]
    assert g2["updatedAt"] == r2.json()["updatedAt"]
    rows = api_db.query(ChartDrawing).all()
    assert len(rows) == 1 and rows[0].count == 2
    # 紧凑序列化，非 ASCII 原样存 / compact, non-ASCII kept as-is
    assert rows[0].data == json.dumps([_line(1), _line(2)], ensure_ascii=False, separators=(",", ":"))


def test_unicode_text_survives(client):
    d = {"id": "t1", "type": "text", "text": "支撑位 ✓", "points": []}
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [d]})
    assert client.get("/api/chart/drawings?symbol=XAUUSD").json()["drawings"] == [d]


def test_empty_list_deletes_the_row(client, api_db):
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line()]})
    assert api_db.query(ChartDrawing).count() == 1
    r = client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": []})
    assert r.status_code == 200
    assert r.json() == {"symbol": "XAUUSD", "updatedAt": None}
    api_db.expire_all()
    assert api_db.query(ChartDrawing).count() == 0
    assert client.get("/api/chart/drawings?symbol=XAUUSD").json()["drawings"] == []
    # 本来就没有的行再删一次也不报错 / deleting a missing row is fine too
    assert client.put("/api/chart/drawings", json={"symbol": "EURUSD", "drawings": []}).status_code == 200


def test_symbol_is_case_sensitive_and_kept_as_is(client):
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD.m", "drawings": [_line()]})
    assert client.get("/api/chart/drawings?symbol=XAUUSD.m").json()["drawings"] == [_line()]
    assert client.get("/api/chart/drawings?symbol=XAUUSD.M").json()["drawings"] == []


# ---------------------------------------------------------------- 校验与上限 / validation & limits

@pytest.mark.parametrize("sym", ["US30#", "XAUUSD.m", "BTC-USD", "eur_usd", "A" * 64])
def test_valid_symbols(client, sym):
    assert client.put("/api/chart/drawings", json={"symbol": sym, "drawings": [_line()]}).status_code == 200
    assert client.get("/api/chart/drawings", params={"symbol": sym}).status_code == 200


@pytest.mark.parametrize("sym", ["", "XAU USD", "XAU/USD", "../etc", "XAU%", "黄金", "A" * 65, "a;drop"])
def test_invalid_symbols_rejected(client, sym):
    r = client.put("/api/chart/drawings", json={"symbol": sym, "drawings": [_line()]})
    assert r.status_code == 422
    g = client.get("/api/chart/drawings", params={"symbol": sym})
    assert g.status_code == 422


def test_invalid_symbol_message_is_bilingual(client):
    detail = client.get("/api/chart/drawings", params={"symbol": "XAU USD"}).json()["detail"]
    assert "品种名无效" in detail and "invalid symbol" in detail


def test_too_many_drawings_is_422(client, api_db):
    ok = [_line(i) for i in range(cd.DRAWINGS_MAX_COUNT)]
    assert client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": ok}).status_code == 200
    r = client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": ok + [_line(999)]})
    assert r.status_code == 422
    assert "at most" in r.json()["detail"] and "最多" in r.json()["detail"]
    # 被拒的那次没有动已存的 / the rejected save left the stored row alone
    api_db.expire_all()
    assert api_db.query(ChartDrawing.count).scalar() == cd.DRAWINGS_MAX_COUNT


def test_oversized_payload_is_413(client, monkeypatch, api_db):
    # 把上限调小来测，免得真造 512KB 的请求体 / shrink the cap rather than build a 512KB body
    monkeypatch.setattr(cd, "DRAWINGS_MAX_BYTES", 300)
    big = [{"id": "x", "type": "text", "text": "y" * 400}]
    r = client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": big})
    assert r.status_code == 413
    assert "过大" in r.json()["detail"] and "too large" in r.json()["detail"]
    assert api_db.query(ChartDrawing).count() == 0


def test_size_cap_counts_utf8_bytes():
    """上限按 UTF-8 字节算，不是字符数 / the cap is UTF-8 bytes, not characters."""
    n_chars = cd.DRAWINGS_MAX_BYTES // 3          # 每个汉字 3 字节 / 3 bytes per CJK char
    with pytest.raises(Exception) as ei:
        cd.encode_drawings([{"text": "汉" * n_chars}])
    assert getattr(ei.value, "status_code", None) == 413


def test_real_default_cap_accepts_a_large_but_legal_payload(client):
    # 接近默认上限（约 400KB）的合法数据能存 / ~400KB of legal data is accepted under the real cap
    drawings = [{"id": f"d{i}", "type": "text", "text": "z" * 790} for i in range(500)]
    assert client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": drawings}).status_code == 200
    assert len(client.get("/api/chart/drawings?symbol=XAUUSD").json()["drawings"]) == 500


def test_nan_is_rejected():
    with pytest.raises(Exception) as ei:
        cd.encode_drawings([{"p": float("nan")}])
    assert getattr(ei.value, "status_code", None) == 422


def test_drawings_must_be_objects(client):
    r = client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [1, "x"]})
    assert r.status_code == 422


def test_symbol_row_cap(client, monkeypatch, api_db):
    monkeypatch.setattr(cd, "DRAWINGS_MAX_SYMBOLS", 3)
    for s in ("AAA", "BBB", "CCC"):
        assert client.put("/api/chart/drawings", json={"symbol": s, "drawings": [_line()]}).status_code == 200
    r = client.put("/api/chart/drawings", json={"symbol": "DDD", "drawings": [_line()]})
    assert r.status_code == 422
    assert "300" not in r.json()["detail"] and "3" in r.json()["detail"]
    # 覆盖已有品种不受行数上限影响 / overwriting an existing symbol is not capped
    assert client.put("/api/chart/drawings", json={"symbol": "AAA", "drawings": [_line(5)]}).status_code == 200
    # 删一个腾出位置后就能新建 / deleting one frees a slot
    client.put("/api/chart/drawings", json={"symbol": "BBB", "drawings": []})
    assert client.put("/api/chart/drawings", json={"symbol": "DDD", "drawings": [_line()]}).status_code == 200


def test_write_rate_limit(client):
    limit = int(cd.DRAWINGS_WRITE_RATE_LIMIT.split("/")[0])
    codes = [
        client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line(i)]}).status_code
        for i in range(limit + 5)
    ]
    assert codes[0] == 200 and codes[limit - 1] == 200 and 429 in codes[limit:]


# ---------------------------------------------------------------- 品种列表 / symbols list

def test_symbols_list(client):
    assert client.get("/api/chart/drawings/symbols").json() == {"symbols": []}
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line(0), _line(1)]})
    client.put("/api/chart/drawings", json={"symbol": "EURUSD", "drawings": [_line(0)]})
    out = client.get("/api/chart/drawings/symbols").json()["symbols"]
    by = {s["symbol"]: s for s in out}
    assert set(by) == {"XAUUSD", "EURUSD"}
    assert by["XAUUSD"]["count"] == 2 and by["EURUSD"]["count"] == 1
    assert all(s["updatedAt"].endswith("Z") for s in out)
    assert out[0]["updatedAt"] >= out[1]["updatedAt"]          # 新改的在前 / newest first


def _select_list(sql: str) -> str:
    """SELECT 与 FROM 之间的列清单 / the column list between SELECT and FROM."""
    return re.split(r"\sfrom\s", sql, maxsplit=1)[0]


def test_symbols_and_get_select_only_needed_columns(client, api_db):
    """流量：品种列表不读 data 列；读单个品种只选 data 与 updated_at。
    Egress: the symbol list never reads data; a single-symbol read selects data and updated_at only."""
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line()]})
    seen: list[str] = []

    def _hook(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT") and "CHART_DRAWINGS" in statement.upper():
            seen.append(statement.lower())

    event.listen(api_db.get_bind(), "before_cursor_execute", _hook)
    try:
        client.get("/api/chart/drawings/symbols")
        assert len(seen) == 1
        cols = _select_list(seen[0])
        assert "chart_drawings.data" not in cols
        seen.clear()
        client.get("/api/chart/drawings?symbol=XAUUSD")
        assert len(seen) == 1
        cols = _select_list(seen[0])
        assert "chart_drawings.data" in cols and "chart_drawings.updated_at" in cols
        assert "chart_drawings.id" not in cols and "chart_drawings.symbol" not in cols
        # 保存不读旧的 data / a save never reads the old data
        seen.clear()
        client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line(3)]})
        assert seen and all("chart_drawings.data" not in _select_list(s) for s in seen)
    finally:
        event.remove(api_db.get_bind(), "before_cursor_execute", _hook)


# ---------------------------------------------------------------- 用户隔离 / isolation

def test_users_are_isolated(client, users):
    a, b = users
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line(1)]})
    client.who["id"] = b.id
    assert client.get("/api/chart/drawings?symbol=XAUUSD").json()["drawings"] == []
    assert client.get("/api/chart/drawings/symbols").json() == {"symbols": []}
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line(2)]})
    # B 删自己的不影响 A / B deleting its own leaves A's alone
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": []})
    client.who["id"] = a.id
    assert client.get("/api/chart/drawings?symbol=XAUUSD").json()["drawings"] == [_line(1)]


# ---------------------------------------------------------------- WS 推送 / WS push

def test_put_pushes_small_update_event_to_the_same_user(client, users, pushes):
    a, _b = users
    r = client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [_line()]}).json()
    assert pushes == [(a.id, {"type": "CHART_DRAWINGS_UPDATE",
                              "data": {"symbol": "XAUUSD", "updatedAt": r["updatedAt"]}})]
    # 不带画线本身 / no drawings payload
    assert "drawings" not in pushes[0][1]["data"]
    pushes.clear()
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": []})
    assert pushes == [(a.id, {"type": "CHART_DRAWINGS_UPDATE",
                              "data": {"symbol": "XAUUSD", "updatedAt": None}})]


def test_rejected_put_pushes_nothing(client, pushes):
    client.put("/api/chart/drawings", json={"symbol": "XAU USD", "drawings": [_line()]})
    client.put("/api/chart/drawings", json={"symbol": "XAUUSD", "drawings": [1]})
    assert pushes == []


# ---------------------------------------------------------------- save_drawings 直接驱动 / direct

def test_save_drawings_recovers_from_a_concurrent_insert(api_db, users, monkeypatch):
    """两个请求同时新建同一行：后到的撞唯一约束，回滚后改成 UPDATE。
    Two concurrent creates: the later insert hits the unique constraint and becomes an UPDATE."""
    a, _b = users
    api_db.add(ChartDrawing(user_id=a.id, symbol="XAUUSD", data="[]", count=0))
    api_db.commit()
    # 模拟「查 id 时还没有、插入时已经有了」/ simulate "no row when looked up, there on insert"
    real_query = api_db.query
    calls = {"n": 0}

    class _NoRow:
        def filter(self, *a, **k):
            return self

        def scalar(self):
            return None

    def _query(*args, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return _NoRow()
        return real_query(*args, **kw)

    monkeypatch.setattr(api_db, "query", _query)
    enc = cd.encode_drawings([_line()])
    updated = cd.save_drawings(api_db, a.id, "XAUUSD", enc, 1)
    monkeypatch.setattr(api_db, "query", real_query)
    assert updated is not None
    rows = api_db.query(ChartDrawing).filter_by(user_id=a.id).all()
    assert len(rows) == 1 and rows[0].count == 1 and rows[0].data == enc


# ---------------------------------------------------------------- 迁移 / migration (rev 55)

def test_schema_rev_bumped_to_55():
    assert db_mod.CURRENT_SCHEMA_REV >= 55


@pytest.fixture()
def legacy54_engine(monkeypatch, tmp_path):
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401

    url = "sqlite:///" + str(tmp_path / "legacy54.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP TABLE chart_drawings"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    db_mod._write_schema_rev(54)
    yield eng
    eng.dispose()


def test_rev55_init_db_creates_the_table(legacy54_engine):
    assert "chart_drawings" not in inspect(legacy54_engine).get_table_names()
    db_mod.init_db()
    insp = inspect(legacy54_engine)
    assert "chart_drawings" in insp.get_table_names()
    cols = {c["name"] for c in insp.get_columns("chart_drawings")}
    assert {"id", "user_id", "symbol", "data", "count", "created_at", "updated_at"} <= cols
    uniques = [set(u["column_names"]) for u in insp.get_unique_constraints("chart_drawings")]
    assert {"user_id", "symbol"} in uniques
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV
    # 强制重跑幂等 / a forced re-run is idempotent
    db_mod._write_schema_rev(54)
    db_mod.init_db()
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV
