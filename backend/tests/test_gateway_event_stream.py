"""2026-11-11 下单架构优化：事件流长轮询、回执新字段、每用户在途开仓上限。

Order-path work of 2026-11-11: the /events long-poll client, the new trade-reply
fields, and the per-user in-flight open cap.
"""
import asyncio
import threading

import app.services.gateway_client as gc
from app.services import gateway_execute as ge


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError("http %d" % self.status_code)

    def json(self):
        return self._payload


class _Client:
    def __init__(self, payload=None, status=200):
        self._payload = payload
        self._status = status
        self.calls = []

    async def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append((url, params))
        return _Resp(self._payload, self._status)


def _poll(monkeypatch, payload=None, status=200, cursor=5, wait=0):
    fake = _Client(payload, status)
    monkeypatch.setattr(gc, "_client", fake)
    monkeypatch.setattr(gc.settings, "GATEWAY_URL", "http://gw.test:8800")
    monkeypatch.setattr(gc, "_events_unsupported_until", 0.0)
    return asyncio.run(gc.poll_events(cursor, wait)), fake


# ---------- /events 解析 / parsing ----------


def test_poll_events_maps_types(monkeypatch):
    polled, fake = _poll(monkeypatch, {
        "ok": True, "instance": "abc", "head": 12, "resync": False,
        "subscribed": True, "dealSubscribed": True,
        "events": [
            {"seq": 6, "type": "position", "login": 1001, "action": "add", "ticket": 9},
            {"seq": 7, "type": "position", "login": 1001, "action": "update", "ticket": 9},
            {"seq": 8, "type": "deal", "login": 1001, "deal": 5},
            {"seq": 9, "type": "deal", "login": 1001, "deal": 6},
            {"seq": 10, "type": "deal", "login": 1002, "deal": 7},
            {"seq": 11, "type": "order", "login": 1001, "action": "add", "ticket": 4},
            {"seq": 12, "type": "trade_resolved", "login": 1001, "kind": "open",
             "clientOrderId": "x", "resolved": "filled"},
        ],
    }, cursor=5, wait=5000)

    assert fake.calls[0][0] == "http://gw.test:8800/events"
    assert fake.calls[0][1]["cursor"] == "5"
    assert fake.calls[0][1]["wait"] == "5000"
    assert polled.instance == "abc" and polled.head == 12 and not polled.resync
    # 只有 add/delete 进持仓事件（与旧 drain 一致）/ only add/delete, as the old drain
    assert [(e.login, e.action, e.ticket) for e in polled.position_events] == [(1001, "add", 9)]
    # 成交按 login 去重 / deals deduped by login
    assert polled.deal_logins == [1001, 1002]
    assert polled.resolved[0]["resolved"] == "filled"
    assert polled.subscribed and polled.deal_subscribed


def test_link_event_forces_resync(monkeypatch):
    polled, _ = _poll(monkeypatch, {
        "ok": True, "instance": "abc", "head": 3, "resync": False,
        "events": [{"seq": 3, "type": "link", "login": 0, "state": "up"}],
    })
    assert polled.resync is True


def test_404_marks_stream_unsupported(monkeypatch):
    polled, _ = _poll(monkeypatch, {"ok": False}, status=404)
    assert polled is None
    assert gc.events_stream_available() is False


def test_failure_returns_none_without_marking(monkeypatch):
    polled, _ = _poll(monkeypatch, {"ok": False}, status=500)
    assert polled is None
    assert gc.events_stream_available() is True


# ---------- 回执新字段 / new reply fields ----------


def test_trade_rsp_carries_resolved_and_not_sent():
    rsp = gc._trade_rsp({"ok": False, "retcode": "MT_RET_ERR_BUSY", "notSent": True})
    assert rsp.not_sent is True and rsp.resolved == ""

    rsp = gc._trade_rsp({"ok": True, "retcode": "MT_RET_REQUEST_DONE", "resolved": "filled"})
    assert rsp.resolved == "filled" and rsp.not_sent is False

    # 旧网关没有这两个字段 / older gateways omit both
    rsp = gc._trade_rsp({"ok": True})
    assert rsp.resolved == "" and rsp.not_sent is False


def test_busy_not_sent_is_rejected_not_failed():
    """网关"繁忙、未发出"必须落 REJECTED（可以放心重下），不能是 FAILED（先核对持仓）。
    Gateway busy/not-sent must be REJECTED (safe to retry), never FAILED."""

    class _O:
        action = "ORDER"
        status = "PENDING"
        message = ""

    o = _O()
    ge.apply_trade_result(o, gc._trade_rsp({
        "ok": False, "retcode": "MT_RET_ERR_BUSY", "notSent": True,
        "message": "网关同时在处理的交易已达上限,本次指令未发往券商",
    }))
    assert o.status == "REJECTED"
    assert "未发往券商" in o.message


# ---------- 每用户在途开仓上限 / per-user in-flight cap ----------


def test_user_open_cap_admits_up_to_limit_then_refuses():
    uid = "cap-user-1"
    got = [ge._admit_user_open(uid) for _ in range(ge.USER_OPEN_INFLIGHT_CAP + 2)]
    try:
        assert got == [True] * ge.USER_OPEN_INFLIGHT_CAP + [False, False]
        assert ge.user_open_inflight(uid) == ge.USER_OPEN_INFLIGHT_CAP
    finally:
        for _ in range(ge.USER_OPEN_INFLIGHT_CAP):
            ge._release_user_open(uid)
    assert ge.user_open_inflight(uid) == 0
    # 名额还回来后又能下 / slots return
    assert ge._admit_user_open(uid) is True
    ge._release_user_open(uid)


def test_user_open_cap_is_per_user():
    a, b = "cap-user-a", "cap-user-b"
    try:
        for _ in range(ge.USER_OPEN_INFLIGHT_CAP):
            assert ge._admit_user_open(a)
        assert ge._admit_user_open(b) is True
    finally:
        for _ in range(ge.USER_OPEN_INFLIGHT_CAP):
            ge._release_user_open(a)
        ge._release_user_open(b)


def test_user_open_cap_is_thread_safe():
    uid = "cap-user-threads"
    results = []
    lock = threading.Lock()

    def worker():
        ok = ge._admit_user_open(uid)
        with lock:
            results.append(ok)

    threads = [threading.Thread(target=worker) for _ in range(50)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    try:
        assert results.count(True) == ge.USER_OPEN_INFLIGHT_CAP
    finally:
        for _ in range(results.count(True)):
            ge._release_user_open(uid)


def test_wrapper_releases_slot_even_when_body_raises(monkeypatch):
    uid = "cap-user-raise"

    def body(db, order, account, admitted):
        assert ge._admit_user_open(uid)
        admitted.append(uid)
        raise RuntimeError("boom")

    monkeypatch.setattr(ge, "_try_gateway_execute", body)
    try:
        ge.try_gateway_execute(None, object())
    except RuntimeError:
        pass
    assert ge.user_open_inflight(uid) == 0


# ---------- 回执顺带持仓 / positions attached to the reply ----------


def test_trade_rsp_parses_attached_positions():
    rsp = gc._trade_rsp({
        "ok": True, "retcode": "MT_RET_REQUEST_DONE", "position": 77,
        "positions": [{"ticket": 77, "symbol": "XAUUSD", "side": "BUY", "volume": 0.1,
                       "priceOpen": 4000.5, "priceCurrent": 4001.0, "stopLoss": 3990.0,
                       "takeProfit": 0.0, "profit": 5.0, "comment": "PRISMX-C1abcde"}],
    })
    assert rsp.positions is not None and len(rsp.positions) == 1
    p = rsp.positions[0]
    assert p.ticket == 77 and p.price_open == 4000.5 and p.stop_loss == 3990.0

    # 网关没带 → None（调用方自己读）；带了空表 → []（全平后账号空仓）
    assert gc._trade_rsp({"ok": True}).positions is None
    assert gc._trade_rsp({"ok": True, "positions": []}).positions == []


def test_push_positions_now_uses_known_rows_without_reading(monkeypatch):
    from app.services import gateway_snapshot as gs

    reads = []
    pushed = {}

    async def fake_read(login):
        reads.append(login)
        return [{"ticket": 1, "login": login}], True

    async def fake_funds(login):
        return None

    async def fake_push(user_id, data, source=None):
        pushed["data"] = data

    monkeypatch.setattr(gs, "read_positions_priority", fake_read)
    monkeypatch.setattr(gs, "_read_funds", fake_funds)
    monkeypatch.setattr(gs.manager, "push_positions", fake_push)
    monkeypatch.setattr(gs, "record_priority_read", lambda uid, started: None)

    known = {"1001": gc._trade_rsp({"ok": True, "positions": [
        {"ticket": 77, "symbol": "XAUUSD", "side": "BUY", "volume": 0.1}]}).positions}

    ok = asyncio.run(gs.push_positions_now("u-known", ["1001", "1002"], known=known))
    assert ok is True
    # 1001 用回执里的，只读了 1002 / only the login without attached positions is read
    assert reads == ["1002"]
    tickets = sorted((r["login"], r["ticket"]) for r in pushed["data"])
    assert tickets == [("1001", 77), ("1002", 1)]
