"""安全审计 run-1 的纵深加固（2026-10-26 跟进）。

1. /bridge/positions 的行有了类型：数值字段（盈亏、手数、价格、SL/TP）必须是有限数，NaN /
   ±Infinity / 字符串一律 422；ticket / login 仍收 int 或数字字符串；未知键照常放行（新旧桥接都
   不能被挡）；下游（推送、对账、自动仓管）拿到的仍是与上报完全一致的普通 dict。
2. 桥接 Token 鉴权失败：不认识的 Token 进一个有界的否定缓存（~60 秒），同一个错 Token 反复来
   只查一次库；按 IP 计失败次数，超了 429。有效 Token 不受影响：命中正向缓存的请求不看失败桶，
   新建 / 重置 Token 会换共享版本号，否定条目随之作废。
3. 比赛接口：库里已经存着的非有限分数（修复前写进去的 NaN / ±Inf）不能让 JSON 输出 500——
   finalScore 返回 null；榜单行（score 非空、前端按数字用）整行不出，与计算时「分数非有限 =
   不上榜」同一口径。

Defence-in-depth follow-ups to the 2026-10-26 audit: typed bridge position rows with
finite numbers, a negative cache plus per-IP failure limit for bridge token auth, and
non-finite stored competition scores sanitised on the way out.
"""
import json
import math

import pytest
from pydantic import BaseModel, Field
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.responses import JSONResponse

from app.core import rate_limit
from app.core.database import get_db
from app.core.security import hash_api_token
from app.models import Competition, CompetitionParticipant, LeaderboardSnapshot, User
from app.routers import bridge
from app.routers import competitions as comp_router
from app.services.gamification.competitions import comp_period_key

RAW = "valid-raw-token-followup"


@pytest.fixture()
def db_session():
    """覆盖 conftest 的同名 fixture：TestClient 在另一条线程里跑端点，内存库必须用
    StaticPool 共享同一条连接，否则那边看到的是一个空库。
    Shadows conftest's fixture: TestClient runs endpoints on another thread, so the
    in-memory DB needs StaticPool to share one connection."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.core.database import Base

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autocommit=False, autoflush=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(autouse=True)
def _clean_auth_caches():
    def clear():
        with bridge._auth_cache_lock:
            bridge._auth_cache.clear()
            bridge._auth_negative_cache.clear()
        bridge._auth_version.reset_local()
    clear()
    rate_limit.limiter.reset()
    yield
    clear()
    rate_limit.limiter.reset()


def _user(db, email="hard@t.co", raw=RAW):
    u = User(email=email, password_hash="x", plan="PRO", api_token=hash_api_token(raw))
    db.add(u)
    db.commit()
    return u


@pytest.fixture()
def captured(monkeypatch):
    """把 /bridge/positions 的三个下游桩掉，记下它们收到了什么。
    Stub the three downstream consumers of /bridge/positions and record their input."""
    seen: dict[str, list] = {"push": [], "pending": [], "seen": [], "eval": []}

    async def push_positions(uid, rows, source="bridge"):
        seen["push"].append(rows)

    async def push_pending(uid, rows, source="bridge"):
        seen["pending"].append(rows)

    monkeypatch.setattr(bridge.manager, "push_positions", push_positions)
    monkeypatch.setattr(bridge.manager, "push_pending_orders", push_pending)
    monkeypatch.setattr(bridge, "mark_positions_seen", lambda db, uid, rows: seen["seen"].append(rows))
    monkeypatch.setattr(bridge, "evaluate_positions",
                        lambda db, uid, rows, source="bridge": seen["eval"].append(rows) or 0)
    return seen


@pytest.fixture()
def client(db_session):
    app = FastAPI()
    app.include_router(bridge.router)
    app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(app)


def _post_raw(client, body: str, token=RAW):
    # json.dumps 默认允许 NaN / Infinity，正好模拟一个写出裸 NaN 的客户端。
    # json.dumps allows NaN / Infinity by default — exactly a client emitting bare NaN.
    return client.post("/bridge/positions", content=body,
                       headers={"X-API-Token": token, "Content-Type": "application/json"})


def _real_position(**over):
    """与 bridge/mt5_worker._positions_payload 同形状的一行 / same shape as the bridge."""
    row = {
        "ticket": 123456789, "symbol": "XAUUSD", "side": "BUY", "volume": 0.1,
        "profit": -12.5, "entryPrice": 2650.25, "currentPrice": 2648.0,
        "stopLoss": 2640.0, "takeProfit": 0.0, "login": "800001",
    }
    row.update(over)
    return row


def _real_pending(**over):
    """与 bridge/mt5_worker._pending_orders_payload 同形状 / same shape as the bridge."""
    row = {
        "ticket": 987654321, "symbol": "EURUSD", "type": "BUY_LIMIT", "side": "BUY",
        "volume": 0.2, "price": 1.0712, "stopLoss": 0.0, "takeProfit": 1.08, "login": "800001",
    }
    row.update(over)
    return row


# ---------------------------------------------------------------------------
# 1. 持仓行类型 / typed position rows
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("field", ["profit", "volume", "entryPrice", "currentPrice", "stopLoss", "takeProfit"])
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), "12.5", True])
def test_non_finite_or_non_numeric_position_numbers_are_422(db_session, client, captured, field, bad):
    _user(db_session)
    r = _post_raw(client, json.dumps({"data": [_real_position(**{field: bad})]}))
    assert r.status_code == 422, (field, bad, r.text)
    assert captured["push"] == [] and captured["eval"] == []


@pytest.mark.parametrize("field", ["volume", "price", "stopLoss", "takeProfit"])
def test_non_finite_pending_order_numbers_are_422(db_session, client, captured, field):
    _user(db_session)
    body = json.dumps({"data": [], "pendingOrders": [_real_pending(**{field: float("nan")})]})
    assert _post_raw(client, body).status_code == 422


def test_realistic_payload_with_extra_keys_reaches_downstream_as_identical_dicts(db_session, client, captured):
    _user(db_session)
    rows = [
        _real_position(),
        # 未来桥接多带的键、整数形式的数值、数字字符串的 ticket、空 login 都照收。
        # Extra keys from a newer bridge, integer-valued numbers, a numeric-string
        # ticket and a null login are all accepted.
        _real_position(ticket="555", login=None, volume=1, profit=0, swap=-1.25,
                       comment="PRISMX", magic=20240901),
        {"ticket": 42, "symbol": "BTCUSD", "profit": 3.5},
    ]
    pending = [_real_pending(), _real_pending(ticket="777", expiration=None)]
    r = _post_raw(client, json.dumps({"data": rows, "pendingOrders": pending}))
    assert r.status_code == 200, r.text
    for got in (captured["push"][0], captured["seen"][0], captured["eval"][0]):
        assert got == rows
        assert all(type(row) is dict for row in got)
        # 没上报的字段不能被补成 None（下游按「键在不在」区分）。
        # Unsent fields must not appear as None — downstream checks key presence.
        assert "side" not in got[2]
        # int 仍是 int，不被转成 float / ints stay ints
        assert type(got[1]["volume"]) is int and got[1]["ticket"] == "555"
    assert captured["pending"][0] == pending
    assert all(type(row) is dict for row in captured["pending"][0])


def test_absent_pending_orders_still_means_no_push(db_session, client, captured):
    _user(db_session)
    assert _post_raw(client, json.dumps({"data": [_real_position()]})).status_code == 200
    assert captured["pending"] == []


@pytest.mark.parametrize("over", [{"ticket": "12a"}, {"ticket": True}, {"ticket": 1.5},
                                  {"login": "abc"}, {"login": 1.5}])
def test_ticket_and_login_keep_int_or_numeric_string(db_session, client, captured, over):
    _user(db_session)
    assert _post_raw(client, json.dumps({"data": [_real_position(**over)]})).status_code == 422


def test_ticket_and_login_accept_ints_and_numeric_strings(db_session, client, captured):
    _user(db_session)
    body = json.dumps({"data": [_real_position(ticket=1, login=800001),
                                _real_position(ticket="2", login="800002")]})
    assert _post_raw(client, body).status_code == 200


def test_position_row_count_is_capped(db_session, client, captured):
    _user(db_session)
    rows = [_real_position(ticket=i) for i in range(bridge.MAX_POSITIONS_PER_REPORT + 1)]
    assert _post_raw(client, json.dumps({"data": rows})).status_code == 422
    rows = rows[:bridge.MAX_POSITIONS_PER_REPORT]
    assert _post_raw(client, json.dumps({"data": rows})).status_code == 200


def test_non_object_rows_are_422(db_session, client, captured):
    _user(db_session)
    assert _post_raw(client, json.dumps({"data": ["junk", 7]})).status_code == 422


def test_unknown_keys_may_not_smuggle_nan(db_session, client, captured):
    _user(db_session)
    body = json.dumps({"data": [_real_position(swap=float("nan"))]})
    assert _post_raw(client, body).status_code == 422
    body = json.dumps({"data": [_real_position(meta={"x": [1.0, float("inf")]})]})
    assert _post_raw(client, body).status_code == 422


# ---------------------------------------------------------------------------
# 2. 鉴权：否定缓存与失败限流 / negative auth cache and failure limit
# ---------------------------------------------------------------------------

@pytest.fixture()
def db_calls(monkeypatch):
    calls: list[str] = []
    real = bridge.authenticate_api_token

    def counting(db, token):
        calls.append(token)
        return real(db, token)

    monkeypatch.setattr(bridge, "authenticate_api_token", counting)
    return calls


def test_unknown_token_hits_db_once_within_ttl(db_session, db_calls):
    for _ in range(5):
        assert bridge._authenticate_cached(db_session, "nobody-has-this") is None
    assert db_calls == ["nobody-has-this"]
    # 过期后再查一次库 / once expired, the DB is consulted again
    key = hash_api_token("nobody-has-this")
    exp, ver = bridge._auth_negative_cache[key]
    bridge._auth_negative_cache[key] = (0.0, ver)
    assert bridge._authenticate_cached(db_session, "nobody-has-this") is None
    assert len(db_calls) == 2


def test_negative_entry_is_dropped_when_tokens_rotate(db_session, db_calls):
    """新 Token 落库（重置 / 改密）都会调 invalidate_auth_cache_for_hash 换版本号——
    之前被记成「不认识」的同一个 Token 立刻按真值重新鉴权，不用等 TTL。
    Token creation paths bump the shared version, which voids negative entries."""
    assert bridge._authenticate_cached(db_session, RAW) is None
    u = _user(db_session)
    bridge.invalidate_auth_cache_for_hash("some-old-hash")
    got = bridge._authenticate_cached(db_session, RAW)
    assert got is not None and got.id == u.id
    assert hash_api_token(RAW) not in bridge._auth_negative_cache


def test_negative_entry_expires_within_ttl_even_without_a_bump(db_session):
    assert bridge._authenticate_cached(db_session, RAW) is None
    _user(db_session)
    key = hash_api_token(RAW)
    exp, ver = bridge._auth_negative_cache[key]
    assert exp - bridge.time.monotonic() <= bridge._AUTH_NEGATIVE_TTL
    bridge._auth_negative_cache[key] = (0.0, ver)
    assert bridge._authenticate_cached(db_session, RAW) is not None


def test_valid_token_never_enters_negative_cache_and_keeps_tuple_shape(db_session, db_calls):
    u = _user(db_session)
    assert bridge._authenticate_cached(db_session, RAW).id == u.id
    assert not bridge._auth_negative_cache
    entry = bridge._auth_cache[hash_api_token(RAW)]
    # admission.py 读这个三元组 / admission.py reads this exact shape
    assert len(entry) == 3 and isinstance(entry[0], float) and entry[1].id == u.id


def test_negative_cache_is_bounded_and_evicts_oldest(db_session, monkeypatch):
    monkeypatch.setattr(bridge, "_AUTH_NEGATIVE_MAX", 5)
    for i in range(8):
        bridge._authenticate_cached(db_session, f"junk-{i}")
    assert len(bridge._auth_negative_cache) == 5
    assert hash_api_token("junk-0") not in bridge._auth_negative_cache
    assert hash_api_token("junk-7") in bridge._auth_negative_cache


@pytest.fixture()
def limited(monkeypatch):
    monkeypatch.setattr(rate_limit.limiter, "enabled", True)
    monkeypatch.setattr(bridge, "BRIDGE_AUTH_FAIL_RATE", "5/minute")


def test_failed_auth_is_rate_limited_per_ip(db_session, client, captured, limited):
    codes = [_post_raw(client, json.dumps({"data": []}), token=f"bad-{i}").status_code
             for i in range(8)]
    assert codes[:5] == [401] * 5
    assert set(codes[5:]) == {429}


def test_missing_token_counts_as_failure(db_session, client, captured, limited):
    codes = [client.post("/bridge/positions", json={"data": []}).status_code for _ in range(7)]
    assert codes[:5] == [401] * 5
    assert set(codes[5:]) == {429}


def test_cached_valid_token_is_unaffected_by_the_failure_limit(db_session, client, captured, limited):
    _user(db_session)
    assert _post_raw(client, json.dumps({"data": []})).status_code == 200      # 进正向缓存
    for i in range(10):
        _post_raw(client, json.dumps({"data": []}), token=f"bad-{i}")
    for _ in range(5):
        assert _post_raw(client, json.dumps({"data": []})).status_code == 200


def test_valid_token_does_not_spend_the_failure_budget(db_session, client, captured, limited):
    _user(db_session)
    for _ in range(10):
        with bridge._auth_cache_lock:
            bridge._auth_cache.clear()      # 每次都走数据库 / force the DB path every time
        assert _post_raw(client, json.dumps({"data": []})).status_code == 200
    assert _post_raw(client, json.dumps({"data": []}), token="bad").status_code == 401


# ---------------------------------------------------------------------------
# 3. 比赛分数 / stored competition scores
# ---------------------------------------------------------------------------

def _render(payload):
    """与线上同一个 JSONResponse（allow_nan=False）/ the same renderer production uses."""
    body = JSONResponse(payload).body
    return json.loads(body)


def _ended_comp(db):
    from datetime import datetime, timedelta, timezone
    t0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
    c = Competition(name="NaN Cup", metric="return_pct", enrollment="signup", status="ended",
                    starts_at=t0, ends_at=t0 + timedelta(days=7),
                    reg_opens_at=t0 - timedelta(days=3), reg_closes_at=t0 - timedelta(hours=1))
    db.add(c)
    db.commit()
    return c


def test_stock_starlette_refuses_nan():
    """前提：不清洗的话 Starlette 直接抛错（线上就是 500）。
    Premise: unsanitised, Starlette raises (a 500 in production)."""
    with pytest.raises(ValueError):
        JSONResponse({"finalScore": float("nan")})


def test_non_finite_scores_serialize_as_valid_json(db_session, monkeypatch):
    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    from app.services.settings_store import invalidate_gamification_cache, save_gamification_settings
    save_gamification_settings(db_session, {"competitions_visible": True})
    db_session.commit()
    invalidate_gamification_cache()

    comp = _ended_comp(db_session)
    good = _user(db_session, "good@t.co", raw="t-good")
    bad = _user(db_session, "bad@t.co", raw="t-bad")
    key = comp_period_key(comp.id)
    # SQLite 把 NaN 存成 NULL，所以 NaN 在内存里改（不 flush）；+Inf 能真存进去。
    # SQLite stores NaN as NULL, so NaN is set in memory (unflushed); +Inf persists.
    good_snap = LeaderboardSnapshot(board=comp.metric, period_key=key, user_id=good.id,
                                    mt5_login="800001", rank=1, score=0.2, sample=10)
    bad_snap = LeaderboardSnapshot(board=comp.metric, period_key=key, user_id=bad.id,
                                   mt5_login="800002", rank=2, score=float("inf"), sample=10)
    db_session.add_all([good_snap, bad_snap])
    p_good = CompetitionParticipant(competition_id=comp.id, user_id=good.id, mt5_login="800001",
                                    final_score=0.2, final_rank=1)
    p_bad = CompetitionParticipant(competition_id=comp.id, user_id=bad.id, mt5_login="800002",
                                   final_score=0.1, final_rank=2)
    db_session.add_all([p_good, p_bad])
    db_session.commit()
    p_bad.final_score = float("nan")

    # 详情页（看自己的条目 + 实时榜）/ detail page (own entry + live board)
    out = _render(comp_router.get_competition(request=None, comp_id=comp.id, db=db_session, user=bad))
    assert out["myEntries"][0]["finalScore"] is None
    assert [r["rank"] for r in out["board"]["rows"]] == [1]
    assert out["board"]["me"] is None
    out = _render(comp_router.get_competition(request=None, comp_id=comp.id, db=db_session, user=good))
    assert out["myEntries"][0]["finalScore"] == 0.2
    assert out["board"]["me"]["rank"] == 1

    # 列表页的前三名 / the list page's top three
    listing = _render(comp_router.list_competitions(request=None, db=db_session, user=good))
    tops = [t["score"] for c in listing["finished"] for t in c["top"]]
    assert tops == [0.2]

    # 管理端：参赛名单、实时榜、公开页预览 / admin: entrants, live board, public preview
    admin = _user(db_session, "adm@t.co", raw="t-adm")
    admin.role = "admin"
    db_session.commit()
    entrants = _render(comp_router.admin_list_participants(comp_id=comp.id, db=db_session))
    assert {e["login"]: e["finalScore"] for e in entrants} == {"800001": 0.2, "800002": None}
    board = _render(comp_router.admin_competition_board(comp_id=comp.id, db=db_session, admin=admin))
    assert [r["login"] for r in board["rows"]] == ["800001"]
    preview = _render(comp_router.admin_public_preview(comp_id=comp.id, db=db_session))
    assert [r["rank"] for r in preview["rows"]] == [1]
    assert all(math.isfinite(r["score"]) for r in preview["rows"])


def test_participant_out_nulls_non_finite_values():
    """不经过库（SQLite 会把 NaN 存成 NULL）直接喂 NaN：finalScore 与明细里的非有限值都成 null。
    Feed NaN directly (SQLite would store it as NULL): finalScore and detail values go null."""
    p = CompetitionParticipant(competition_id="c", user_id="u", mt5_login="1",
                               final_score=float("nan"), final_rank=3)
    out = _render(comp_router._participant_out(p, "e@t.co", details={"floating": float("-inf"), "ok": 1.5}))
    assert out["finalScore"] is None and out["finalRank"] == 3
    assert out["floating"] is None and out["ok"] == 1.5


def test_finite_board_does_not_mutate_its_input():
    payload = {"rows": [{"rank": 1, "score": float("nan")}, {"rank": 2, "score": 0.1}],
               "me": {"rank": 1, "score": float("nan")}}
    out = _render(comp_router._finite_board(payload))
    assert out["rows"] == [{"rank": 2, "score": 0.1}] and out["me"] is None
    assert len(payload["rows"]) == 2 and payload["me"] is not None


# ---------------------------------------------------------------------------
# 4. 全局 422：NaN / Inf 输入是 422，不是 500 / global 422 handler
# ---------------------------------------------------------------------------

def _app_with_main_handler(*routers):
    from fastapi.exceptions import RequestValidationError
    from app import main

    app = FastAPI()
    app.add_exception_handler(RequestValidationError, main.app.exception_handlers[RequestValidationError])
    for r in routers:
        app.include_router(r)
    return app


def test_main_registers_a_json_safe_validation_handler():
    from fastapi.exceptions import RequestValidationError
    from fastapi.exception_handlers import request_validation_exception_handler
    from app import main

    handler = main.app.exception_handlers.get(RequestValidationError)
    assert handler is not None and handler is not request_validation_exception_handler


class _NanBody(BaseModel):
    price: float = Field(allow_inf_nan=False)
    n: int


def test_nan_input_is_a_422_with_the_usual_shape():
    from fastapi import APIRouter
    r = APIRouter()

    @r.post("/t")
    def t(body: _NanBody):
        return {"ok": True}

    c = TestClient(_app_with_main_handler(r))
    echoes = {"NaN": "nan", "Infinity": "inf", "-Infinity": "-inf"}
    for bad, echo in echoes.items():
        resp = c.post("/t", content='{"price": ' + bad + ', "n": "x"}',
                      headers={"Content-Type": "application/json"})
        assert resp.status_code == 422, resp.text
        detail = resp.json()["detail"]
        assert {tuple(d["loc"]) for d in detail} == {("body", "price"), ("body", "n")}
        assert all({"loc", "msg", "type"} <= set(d) for d in detail)
        # 非有限的原值改成字符串回显，其余原值照旧 / non-finite echoes become strings
        by_loc = {d["loc"][-1]: d for d in detail}
        assert by_loc["price"]["input"] == echo
        assert by_loc["n"]["input"] == "x"
    # 正常值不受影响 / valid input untouched
    assert c.post("/t", json={"price": 1.5, "n": 2}).json() == {"ok": True}


def test_bridge_poll_nan_balance_is_422_not_500(db_session):
    _user(db_session)
    app = _app_with_main_handler(bridge.router)
    app.dependency_overrides[get_db] = lambda: db_session
    c = TestClient(app)
    body = '{"accounts": [{"login": "800001", "balance": NaN}]}'
    resp = c.post("/bridge/poll", content=body,
                  headers={"X-API-Token": RAW, "Content-Type": "application/json"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"][0]["loc"][-1] == "balance"


# ---------------------------------------------------------------------------
# 5. 桥接其余浮点字段拒 NaN / Inf / other bridge float fields
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("field", ["bid", "ask", "contractSize", "tickSize", "tickValue"])
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_bridge_quote_rejects_non_finite(field, bad):
    from pydantic import ValidationError
    q = {"symbol": "XAUUSD", "login": "800001", "bid": 2650.1, "ask": 2650.4}
    q[field] = bad
    with pytest.raises(ValidationError):
        bridge.BridgeQuote(**q)
    bridge.BridgeQuote(symbol="XAUUSD", login="800001", bid=2650.1, ask=2650.4,
                       contractSize=100.0, tickSize=0.01, tickValue=1.0)


@pytest.mark.parametrize("field", ["filledPrice", "volume"])
@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_bridge_result_rejects_non_finite(field, bad):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        bridge.BridgeResultRequest(clientOrderId="co_1", success=True, **{field: bad})
    bridge.BridgeResultRequest(clientOrderId="co_1", success=True, filledPrice=2650.1, volume=0.1)


# ---------------------------------------------------------------------------
# 6. 公开页与常设榜 / public /c page and standing boards
# ---------------------------------------------------------------------------

def test_shared_helpers_live_in_the_gamification_service():
    from app.services.gamification import finite
    assert finite.finite_or_none(float("nan")) is None and finite.finite_or_none(1.5) == 1.5
    payload = {"rows": [{"score": float("inf")}, {"score": 1}], "previousWinner": {"score": float("nan")}}
    out = finite.finite_board(payload)
    assert out == {"rows": [{"score": 1}], "previousWinner": None}
    assert len(payload["rows"]) == 2


def _public_comp(db):
    from datetime import datetime, timedelta, timezone
    from app.services.settings_store import invalidate_gamification_cache, save_gamification_settings
    save_gamification_settings(db, {"competitions_visible": True, "competitions_public_enabled": True})
    db.commit()
    invalidate_gamification_cache()
    t0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
    c = Competition(name="Public NaN", metric="return_pct", enrollment="signup", status="ended",
                    track="demo", public_view=True, open_account_url="https://example.com/open",
                    starts_at=t0, ends_at=t0 + timedelta(days=7),
                    reg_opens_at=t0 - timedelta(days=3), reg_closes_at=t0 - timedelta(hours=1))
    db.add(c)
    db.commit()
    return c


def test_public_competition_page_drops_non_finite_rows_and_caches_clean(db_session, monkeypatch):
    from app.routers import public_competitions as pub
    from app.services import shared_cache
    from app.services.gamification.public_board import public_cache_key

    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    comp = _public_comp(db_session)
    a = _user(db_session, "pa@t.co", raw="t-pa")
    b = _user(db_session, "pb@t.co", raw="t-pb")
    key = comp_period_key(comp.id)
    db_session.add_all([
        LeaderboardSnapshot(board=comp.metric, period_key=key, user_id=a.id, mt5_login="800001",
                            rank=1, score=float("inf"), sample=10),
        LeaderboardSnapshot(board=comp.metric, period_key=key, user_id=b.id, mt5_login="800002",
                            rank=2, score=0.05, sample=10),
    ])
    db_session.commit()
    for _ in range(2):      # 第二次走缓存 / the second call is served from the cache
        out = _render(pub.get_public_competition(request=None, comp_id=comp.id, db=db_session))
        assert [r["rank"] for r in out["rows"]] == [2]
    cached = shared_cache.get_json(public_cache_key(comp.id))
    assert all(math.isfinite(r["score"]) for r in cached["rows"])


def test_standing_leaderboard_drops_non_finite_rows_without_touching_the_cache(db_session):
    from datetime import datetime, timezone
    from app.routers import gamification as gam
    from app.services import shared_cache
    from app.services.gamification import periods
    from app.services.gamification.boards import leaderboard_cache_key

    key = periods.week_key(datetime.now(timezone.utc))
    viewer = _user(db_session, "lv@t.co", raw="t-lv")
    other = _user(db_session, "lo@t.co", raw="t-lo")
    db_session.add_all([
        LeaderboardSnapshot(board="return_pct", period_key=key, user_id=viewer.id, mt5_login="800001",
                            rank=1, score=float("inf"), sample=10),
        LeaderboardSnapshot(board="return_pct", period_key=key, user_id=other.id, mt5_login="800002",
                            rank=2, score=0.05, sample=10),
    ])
    db_session.commit()
    for _ in range(2):      # 第二次读 shared_cache 里的 base / second call reads the cached base
        out = _render(gam.build_leaderboard_payload(db_session, viewer, "return_pct", "week"))
        assert [r["rank"] for r in out["rows"]] == [2]
        assert out["me"] is None
    # 缓存里的原件没被改动（清洗只发生在出口）/ the cached base itself is untouched
    base = shared_cache.get_json(leaderboard_cache_key("return_pct", key))
    assert len(base["rows"]) == 2
    admin = _render(gam.admin_leaderboard(board="return_pct", period="week", db=db_session, admin=viewer))
    assert [r["rank"] for r in admin["rows"]] == [2]


def test_profile_drops_non_finite_board_entries_and_nulls_final_score(db_session):
    from datetime import datetime, timedelta, timezone
    from app.routers import gamification as gam
    from app.services.gamification import periods

    target = _user(db_session, "pt@t.co", raw="t-pt")
    target.public_id = "pub-target"
    viewer = _user(db_session, "pv@t.co", raw="t-pv")
    db_session.commit()
    key = periods.week_key(datetime.now(timezone.utc))
    db_session.add(LeaderboardSnapshot(board="return_pct", period_key=key, user_id=target.id,
                                       mt5_login="800001", rank=1, score=float("-inf"), sample=10))
    t0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
    c = Competition(name="Done", metric="return_pct", enrollment="signup", status="settled",
                    starts_at=t0, ends_at=t0 + timedelta(days=7))
    db_session.add(c)
    db_session.commit()
    p = CompetitionParticipant(competition_id=c.id, user_id=target.id, mt5_login="800001",
                               final_rank=1, final_score=0.3, disqualified=False)
    db_session.add(p)
    db_session.commit()
    p.final_score = float("nan")    # SQLite 存不了 NaN，在内存里改 / set in memory
    out = _render(gam.build_profile_payload(db_session, viewer, "pub-target"))
    week = [b for b in out["boards"] if b["board"] == "return_pct" and b["period"] == "week"][0]
    assert week["entries"] == []
    assert out["competitions"][0]["finalScore"] is None and out["competitions"][0]["finalRank"] == 1
