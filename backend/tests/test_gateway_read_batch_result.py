"""网关读路径优化批次（2026-09-29）的后端配套测试。

覆盖：
  · 网关读通道全忙回 503 read_busy 时，客户端不再每次 logger.error（限频 warning），
    读失败沿用上一帧的调用方行为不变；
  · 批量读客户端：网关声明 batchSupported 才可用、失败退避、read_busy 不退避、
    逐 login 结果解析；
  · 慢拍的批量预取：命中时不再逐人读、批量不可用/失败/空仓复核时退回逐人读、
    事件触发的成交扫描不吃预取；
  · 超时订单清扫：网关单先问 /trade/result，问到成交/拒绝按真实结果落库，问不到
    才走原来的「结果未知」文案，且不改变非网关单的行为。

Backend companions of the 2026-09-29 gateway read-path batch: read_busy handling,
batch client + loop prefetch with per-login fallback, and stale-order settlement
from the gateway's idempotency record.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

import httpx
import pytest

import app.routers.gateway as gw
import app.services.gateway_client as gc
from app.models import MT5Account, Order, User
from app.services.gateway_client import AccountRsp, DealRsp, PositionRsp

# 复用慢拍测试的整套假依赖 / reuse the slow-tick harness
from test_gateway_loop_isolation import (  # noqa: F401
    FAST_LOGIN, FAST_USER, SLOW_LOGIN, SLOW_USER, _position, _run_loop_for, harness,
)


# ---------------------------------------------------------------------------
# 读通道全忙：503 read_busy
# ---------------------------------------------------------------------------

def _mock_client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture()
def mock_gateway(monkeypatch):
    """把 gateway_client 的连接池换成 MockTransport；yield 一个设置 handler 的函数。"""
    holder = {}

    def use(handler):
        holder["client"] = _mock_client(handler)
        monkeypatch.setattr(gc, "_client", holder["client"])

    monkeypatch.setattr(gc, "_read_busy_last_log", 0.0)
    monkeypatch.setattr(gc, "_read_busy_suppressed", 0)
    yield use


def test_read_busy_is_not_logged_as_error(mock_gateway, caplog):
    def handler(request):
        return httpx.Response(503, json={"ok": False, "error": "read_busy", "message": "busy"})

    mock_gateway(handler)
    with caplog.at_level(logging.DEBUG, logger="prismx.gateway"):
        positions, err = asyncio.run(gc.get_positions(1001))

    # 读失败照旧：空列表 + 错误码，调用方据此沿用上一帧
    assert positions == [] and err == "read_busy"
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert [r for r in caplog.records if r.levelno == logging.WARNING and "read_busy" in r.getMessage()]


def test_read_busy_warning_is_rate_limited(mock_gateway, caplog):
    def handler(request):
        return httpx.Response(503, json={"ok": False, "error": "read_busy"})

    mock_gateway(handler)

    async def hammer():
        for _ in range(20):
            await gc.get_positions(1001)

    with caplog.at_level(logging.DEBUG, logger="prismx.gateway"):
        asyncio.run(hammer())

    warns = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warns) == 1  # 30 秒内只记一条 / one line per 30s
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


def test_other_503_still_logs_error(mock_gateway, caplog):
    """mt5_disconnected 等其它 503 不受影响，照旧 error。"""
    def handler(request):
        return httpx.Response(503, json={"ok": False, "error": "mt5_disconnected"})

    mock_gateway(handler)
    with caplog.at_level(logging.DEBUG, logger="prismx.gateway"):
        _, err = asyncio.run(gc.get_positions(1001))
    assert err == "mt5_disconnected"
    assert [r for r in caplog.records if r.levelno == logging.ERROR]


def test_positions_read_busy_does_not_warn_per_tick(caplog):
    """路由层 _read_positions：read_busy 降为 debug，真正的失败仍是 warning。"""
    async def busy(login, timeout=None):
        return [], "read_busy"

    async def broken(login, timeout=None):
        return [], "MT_RET_ERR_NETWORK"

    orig = gw.gw_get_positions
    try:
        with caplog.at_level(logging.DEBUG, logger=gw.logger.name):
            gw.gw_get_positions = busy
            assert asyncio.run(gw._read_positions("1001")) == ([], False)
            assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
            gw.gw_get_positions = broken
            assert asyncio.run(gw._read_positions("1001")) == ([], False)
            assert [r for r in caplog.records if r.levelno == logging.WARNING]
    finally:
        gw.gw_get_positions = orig


# ---------------------------------------------------------------------------
# 批量读客户端
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _reset_batch_state(monkeypatch):
    monkeypatch.setattr(gc, "_batch_state", {"supported": False, "seen_at": 0.0, "backoff_until": 0.0})


def test_batch_available_needs_fresh_gateway_declaration():
    assert gc.batch_available() is False  # 没有探活 = 不用批量 / no probe, no batch
    gc.note_batch_capability({"ok": True, "batchSupported": True})
    assert gc.batch_available() is True
    # 旧网关：没有字段 / old gateway: field absent
    gc.note_batch_capability({"ok": True})
    assert gc.batch_available() is False
    # 声明过期不再信 / a stale declaration is not trusted
    gc.note_batch_capability({"ok": True, "batchSupported": True}, now=1000.0)
    assert gc.batch_available(now=1000.0 + gc.BATCH_CAPABILITY_MAX_AGE + 1) is False


def test_positions_batch_parses_per_login_results(mock_gateway):
    seen = {}

    def handler(request):
        import json
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "results": [
            {"login": 1001, "ok": True, "positions": [
                {"ticket": 7, "symbol": "XAUUSD.s", "side": "BUY", "volume": 0.1, "priceOpen": 1.0,
                 "priceCurrent": 2.0, "stopLoss": 0.5, "takeProfit": 3.0, "profit": 9.0, "comment": "PRISMX"}]},
            {"login": 1002, "ok": True, "positions": []},
        ]})

    mock_gateway(handler)
    out = asyncio.run(gc.get_positions_batch([1001, 1002]))
    assert seen["body"] == {"logins": "1001,1002"}
    assert out[1001][1] == "" and out[1001][0][0].ticket == 7 and out[1001][0][0].profit == 9.0
    assert out[1002] == ([], "")


def test_batch_chunks_by_fifty(mock_gateway):
    calls = []

    def handler(request):
        import json
        logins = json.loads(request.content)["logins"].split(",")
        calls.append(len(logins))
        return httpx.Response(200, json={"ok": True, "results": [
            {"login": int(x), "ok": True, "positions": []} for x in logins]})

    mock_gateway(handler)
    out = asyncio.run(gc.get_positions_batch(list(range(1, 121))))
    assert calls == [50, 50, 20] and len(out) == 120


def test_accounts_batch_marks_missing_login_none(mock_gateway):
    def handler(request):
        return httpx.Response(200, json={"ok": True, "results": [
            {"ok": True, "login": 1001, "name": "A", "group": "demo\\x", "leverage": 100, "balance": 10.0,
             "equity": 11.0, "margin": 1.0, "marginFree": 9.0, "lastPassChange": 123},
            {"ok": False, "login": 1002, "error": "MT_RET_ERR_NOTFOUND"},
        ]})

    mock_gateway(handler)
    out = asyncio.run(gc.get_accounts_batch([1001, 1002]))
    assert out[1001].balance == 10.0 and out[1001].last_pass_change == 123
    assert out[1002] is None


def test_deals_batch_sends_window_and_parses(mock_gateway):
    seen = {}

    def handler(request):
        import json
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "results": [
            {"login": 1001, "ok": True, "deals": [
                {"ticket": 5, "positionId": 7, "symbol": "X", "action": 1, "entry": 1, "volume": 0.1,
                 "price": 1.0, "profit": 2.0, "commission": 0.0, "storage": 0.0, "time": 99,
                 "comment": "c", "reason": 4, "sl": 0.0, "tp": 1.5}]}]})

    mock_gateway(handler)
    out = asyncio.run(gc.get_deals_batch([1001], 100, 200))
    assert seen["from"] == 100 and seen["to"] == 200
    d = out[1001][0][0]
    assert d.ticket == 5 and d.reason == 4 and d.tp == 1.5


def test_batch_failure_backs_off_but_read_busy_does_not(mock_gateway):
    gc.note_batch_capability({"ok": True, "batchSupported": True})

    def busy(request):
        return httpx.Response(503, json={"ok": False, "error": "read_busy"})

    mock_gateway(busy)
    assert asyncio.run(gc.get_positions_batch([1001])) is None
    assert gc.batch_available() is True  # 限流不退避 / shedding does not back off

    def broken(request):
        return httpx.Response(502, json={"ok": False, "error": "MT_RET_ERR_NETWORK"})

    mock_gateway(broken)
    assert asyncio.run(gc.get_positions_batch([1001])) is None
    assert gc.batch_available() is False  # 真失败退避 / a real failure backs off


def test_batch_old_gateway_404_backs_off(mock_gateway):
    gc.note_batch_capability({"ok": True, "batchSupported": True})

    def handler(request):
        return httpx.Response(404, json={"ok": False, "error": "not_found"})

    mock_gateway(handler)
    assert asyncio.run(gc.get_deals_batch([1001], 1, 2)) is None
    assert gc.batch_available() is False


# ---------------------------------------------------------------------------
# 慢拍批量预取
# ---------------------------------------------------------------------------

def _acc(login):
    return AccountRsp(ok=True, login=int(login), name="n", group="demo\\g", leverage=100,
                      balance=100.0, equity=100.0, margin=0.0, margin_free=100.0, last_pass_change=0)


@pytest.fixture()
def batch(harness, monkeypatch):
    """打开批量预取，并记录批量 / 逐人调用次数。"""
    rec = {"batch_pos": 0, "batch_acc": 0, "batch_deals": [], "single_acc": 0, "single_deals": 0}

    async def batch_pos(logins):
        rec["batch_pos"] += 1
        return {int(x): ([_position(int(x))], "") for x in logins}

    async def batch_acc(logins):
        rec["batch_acc"] += 1
        return {int(x): _acc(x) for x in logins}

    async def batch_deals(logins, from_unix, to_unix):
        rec["batch_deals"].append((sorted(logins), from_unix, to_unix))
        return {int(x): ([], "") for x in logins}

    async def single_acc(login, timeout=None):
        rec["single_acc"] += 1
        return None

    async def single_deals(login, from_unix, to_unix, timeout=None):
        rec["single_deals"] += 1
        return [], ""

    monkeypatch.setattr(gw, "gw_batch_available", lambda: True)
    monkeypatch.setattr(gw, "gw_get_positions_batch", batch_pos)
    monkeypatch.setattr(gw, "gw_get_accounts_batch", batch_acc)
    monkeypatch.setattr(gw, "gw_get_deals_batch", batch_deals)
    monkeypatch.setattr(gw, "gw_get_account", single_acc)
    monkeypatch.setattr(gw, "gw_get_deals", single_deals)
    monkeypatch.setattr(gw, "GATEWAY_DEALS_SCAN_INTERVAL", 0.1)
    monkeypatch.setattr(gw, "GATEWAY_ACCOUNT_REFRESH_INTERVAL", 0.2)
    harness["batch"] = rec
    return harness


def test_prefetch_replaces_per_login_reads(batch):
    _run_loop_for(1.0)

    rec = batch["batch"]
    assert rec["batch_pos"] >= 3
    # 持仓全部来自批量：逐人读一次都没有（预取的持仓非空，不触发空仓复核）
    assert batch["reads"] == {SLOW_LOGIN: 0, FAST_LOGIN: 0}
    assert batch["pushes"][FAST_USER] >= 3 and batch["pushes"][SLOW_USER] >= 3
    # 资金：批量取回，逐人只可能在批量没命中时出现
    assert rec["batch_acc"] >= 1 and rec["single_acc"] == 0
    # 一批只带一次 login 列表（两个用户合并成一次调用）
    assert rec["batch_pos"] >= 1


def test_deals_batch_only_after_first_scan_and_never_for_events(batch):
    _run_loop_for(1.0)

    rec = batch["batch"]
    # 首扫（7 天窗口）必须走逐人接口：每个 login 恰好一次
    assert rec["single_deals"] == 2
    # 之后的常规 15 分钟窗口才进批量
    assert rec["batch_deals"], "常规窗口的成交扫描应走批量"
    for logins, from_unix, to_unix in rec["batch_deals"]:
        window = to_unix - 86400 - from_unix
        assert abs(window - gw.GATEWAY_DEALS_LOOKBACK_SECONDS) <= 5  # 没有把首扫的 7 天窗口带进批量


def test_batch_unavailable_falls_back_to_per_login(batch, monkeypatch):
    monkeypatch.setattr(gw, "gw_batch_available", lambda: False)
    _run_loop_for(0.8)

    assert batch["batch"]["batch_pos"] == 0
    assert batch["reads"][SLOW_LOGIN] >= 3 and batch["reads"][FAST_LOGIN] >= 3
    assert batch["pushes"][FAST_USER] >= 3


def test_batch_failure_falls_back_per_login(batch, monkeypatch):
    async def down(logins, *a):
        return None

    monkeypatch.setattr(gw, "gw_get_positions_batch", down)
    monkeypatch.setattr(gw, "gw_get_accounts_batch", down)
    monkeypatch.setattr(gw, "gw_get_deals_batch", down)
    _run_loop_for(0.8)

    assert batch["reads"][SLOW_LOGIN] >= 3 and batch["reads"][FAST_LOGIN] >= 3
    assert batch["batch"]["single_acc"] >= 1
    assert batch["pushes"][FAST_USER] >= 3


def test_batch_exception_falls_back_per_login(batch, monkeypatch):
    async def boom(logins, *a):
        raise RuntimeError("batch exploded")

    monkeypatch.setattr(gw, "gw_get_positions_batch", boom)
    _run_loop_for(0.8)

    assert batch["reads"][FAST_LOGIN] >= 3
    assert batch["pushes"][FAST_USER] >= 3


def test_empty_batch_result_is_rechecked_per_login(batch, monkeypatch):
    """批量说某账号空仓、而它之前不是已确认空仓：不采信，逐人读复核（防「凭空少了持仓」）。"""
    async def empty(logins):
        return {int(x): ([], "") for x in logins}

    monkeypatch.setattr(gw, "gw_get_positions_batch", empty)
    _run_loop_for(0.6)

    # 逐人读给出真实持仓，用户拿到的是持仓而不是空表
    assert batch["reads"][FAST_LOGIN] >= 2
    assert batch["pushes"][FAST_USER] >= 2


def test_batch_row_mapping_matches_single_read():
    """批量与逐人共用同一份映射：键名、大写 side 与 auto_manage 的约定一致。"""
    p = PositionRsp(ticket=1, symbol="X", side="BUY", volume=0.1, price_open=1.0, price_current=2.0,
                    stop_loss=0.0, take_profit=0.0, profit=3.0, comment="PRISMX")

    async def single(login, timeout=None):
        return [p], ""

    orig = gw.gw_get_positions
    try:
        gw.gw_get_positions = single
        one = asyncio.run(gw._read_positions("1001"))
    finally:
        gw.gw_get_positions = orig
    assert gw._position_rows("1001", [p], "") == one


# ---------------------------------------------------------------------------
# 超时订单：先问网关的幂等记录
# ---------------------------------------------------------------------------

LOGIN = "601144"


def _stale_order(db, coid, action="ORDER", login=LOGIN, uid="us"):
    old = datetime.now(timezone.utc) - timedelta(hours=1)
    o = Order(user_id=uid, mt5_login=login, action=action, symbol="XAUUSD", side="BUY", volume=0.1,
              status="PENDING", client_order_id=coid, created_at=old, ticket=555 if action != "ORDER" else None)
    db.add(o)
    db.commit()
    return o


@pytest.fixture()
def stale_env(db_session, monkeypatch):
    from app.routers import orders as orders_router

    db_session.add(User(id="us", email="s@t.co", api_token="tok_s"))
    db_session.add(MT5Account(user_id="us", login=LOGIN, server="", source="gateway", trade_mode="STANDARD"))
    db_session.add(MT5Account(user_id="us", login="777", server="", source="bridge"))
    db_session.commit()
    calls = []
    answers = {}

    async def fake_result(login, client_order_id, action, timeout=8.0):
        calls.append((login, client_order_id, action))
        ans = answers.get(client_order_id, "none")
        if isinstance(ans, Exception):
            raise ans
        return None if ans == "none" else ans

    monkeypatch.setattr(orders_router, "gw_trade_result", fake_result)
    return orders_router, db_session, calls, answers


def test_stale_gateway_order_settled_as_filled_from_gateway_record(stale_env):
    orders_router, db, calls, answers = stale_env
    o = _stale_order(db, "c-fill")
    answers["c-fill"] = {"ok": True, "status": "done", "action": "open", "tradeOk": True,
                         "retcode": "MT_RET_REQUEST_DONE", "message": "", "deal": 11, "order": 22,
                         "position": 22, "price": 2000.5}

    changed = orders_router._void_stale_orders(db, [o])
    db.commit()

    assert changed == [o]
    assert calls == [(int(LOGIN), "c-fill", "open")]
    assert o.status == "FILLED" and o.mt5_position == 22 and o.filled_price == 2000.5
    assert o.trade_mode == "STANDARD"  # 与下单当时一致地打章 / stamped as a live fill would be
    assert "结果未知" not in (o.message or "")


def test_stale_gateway_order_settled_as_rejected(stale_env):
    orders_router, db, _calls, answers = stale_env
    o = _stale_order(db, "c-rej")
    answers["c-rej"] = {"ok": True, "status": "done", "tradeOk": False,
                        "retcode": "MT_RET_REQUEST_INVALID_VOLUME", "message": "bad volume"}

    orders_router._void_stale_orders(db, [o])
    assert o.status == "REJECTED" and "MT_RET_REQUEST_INVALID_VOLUME" in o.message


def test_stale_gateway_placed_unconfirmed_lands_failed_check_positions(stale_env):
    orders_router, db, _c, answers = stale_env
    o = _stale_order(db, "c-unc")
    answers["c-unc"] = {"ok": True, "status": "done", "tradeOk": False,
                        "retcode": "MT_RET_REQUEST_PLACED_UNCONFIRMED", "message": "gateway was restarted"}
    orders_router._void_stale_orders(db, [o])
    assert o.status == "FAILED"


def test_stale_pending_action_placed_is_not_filled(stale_env):
    orders_router, db, calls, answers = stale_env
    o = _stale_order(db, "c-pend", action="PENDING")
    answers["c-pend"] = {"ok": True, "status": "done", "tradeOk": True, "retcode": "MT_RET_REQUEST_PLACED",
                         "deal": 0, "order": 909, "position": 0, "price": 0.0}
    orders_router._void_stale_orders(db, [o])
    assert calls[0][2] == "pending"
    assert o.status == "PLACED" and o.mt5_ticket == 909


@pytest.mark.parametrize("answer", [
    "none",  # 旧网关 / 连不上 / 超时 → gateway_client 返回 None
    {"ok": True, "status": "not_found"},
    {"ok": True, "status": "in_progress"},
    {"ok": True, "status": "done", "tradeOk": False, "retcode": "exception", "message": "boom"},
    RuntimeError("main loop gone"),
])
def test_stale_gateway_order_without_verdict_keeps_unknown_wording(stale_env, answer):
    from app.services.order_payload import GATEWAY_STALE_ORDER_MESSAGE

    orders_router, db, _c, answers = stale_env
    o = _stale_order(db, "c-x")
    answers["c-x"] = answer
    changed = orders_router._void_stale_orders(db, [o])
    assert changed == [o]
    assert o.status == "FAILED" and o.message == GATEWAY_STALE_ORDER_MESSAGE


def test_stale_bridge_and_modify_orders_are_not_looked_up(stale_env):
    from app.services.order_payload import STALE_ORDER_MESSAGE

    orders_router, db, calls, _answers = stale_env
    ob = _stale_order(db, "c-bridge", login="777")
    om = _stale_order(db, "c-mod", action="MODIFY")
    orders_router._void_stale_orders(db, [ob, om])
    assert calls == []  # 桥接单与没有幂等缓存的改单：不问网关
    assert ob.status == "FAILED" and ob.message == STALE_ORDER_MESSAGE
    assert om.status == "FAILED"


def test_stale_lookup_stops_after_unreachable_and_caps_per_pass(stale_env, monkeypatch):
    orders_router, db, calls, answers = stale_env
    # 网关不可达：只问第一笔，其余直接按未知处理，不把整批拖在网络等待上
    batch = [_stale_order(db, f"c-{i}") for i in range(5)]
    orders_router._void_stale_orders(db, batch)
    assert len(calls) == 1
    assert all(o.status == "FAILED" for o in batch)

    # 网关可达但都没记录：每笔都问，超过额度的留在 PENDING 给下一轮
    calls.clear()
    monkeypatch.setattr(orders_router, "_STALE_LOOKUPS_PER_PASS", 3)
    more = [_stale_order(db, f"d-{i}") for i in range(5)]
    for o in more:
        answers[o.client_order_id] = {"ok": True, "status": "not_found"}
    changed = orders_router._void_stale_orders(db, more)
    assert len(calls) == 3 and len(changed) == 3
    assert [o.status for o in more].count("PENDING") == 2


def test_gateway_client_trade_result_parses_and_degrades(mock_gateway):
    seen = {}

    def handler(request):
        seen["params"] = dict(request.url.params)
        seen["path"] = request.url.path
        return httpx.Response(200, json={"ok": True, "status": "done", "tradeOk": True, "retcode": "X"})

    mock_gateway(handler)
    data = asyncio.run(gc.get_trade_result(601144, "coid-1", "close"))
    assert data["status"] == "done"
    assert seen["path"] == "/trade/result"
    assert seen["params"] == {"login": "601144", "clientOrderId": "coid-1", "action": "close"}

    # 旧网关：未知接口 404 → None，绝不抛
    mock_gateway(lambda request: httpx.Response(404, json={"ok": False, "error": "not_found"}))
    assert asyncio.run(gc.get_trade_result(601144, "coid-1", "close")) is None

    def down(request):
        raise httpx.ConnectError("refused")

    mock_gateway(down)
    assert asyncio.run(gc.get_trade_result(601144, "coid-1", "close")) is None
