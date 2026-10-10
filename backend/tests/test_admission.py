"""入口排队（core/admission.py）。

约定：
1. 有空位的请求直接通过，不排队；
2. 名额用满后，排队超过时限回 503 + Retry-After；交易指令的文案明确「未发出，可以重试」；
3. 交易指令与普通请求各用各的名额，互不挤占；
4. 看门狗探活、运维面板管理员校验、桥接轮询与回执、支付回调、EA / webhook 入口永远不排队；
5. 下游抛异常也会归还名额；
6. ADMISSION_ENABLED=false 时整个不起作用。

Front-door admission: free slots pass straight through; a full lane answers 503 after
its timeout (orders say "not sent, safe to retry"); orders and ordinary requests have
separate lanes; the probe, ops admin check, bridge, payment callback and data feeds are
never queued; an exception downstream still frees the slot; the switch turns it off.
"""
import asyncio
import json

import pytest

from app.core import admission
from app.core.config import settings


class _App:
    """被包住的下游 ASGI 应用：按路径决定挂多久，记录进来过哪些请求。
    The wrapped app: holds each request for a per-path time and records arrivals."""

    def __init__(self, hold: float = 0.2):
        self.hold = hold
        self.seen: list[str] = []

    async def __call__(self, scope, receive, send):
        self.seen.append(scope["path"])
        await asyncio.sleep(self.hold)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def _scope(path, method="GET"):
    return {"type": "http", "path": path, "method": method, "headers": []}


async def _call(mw, path, method="GET"):
    out = {}

    async def send(msg):
        if msg["type"] == "http.response.start":
            out["status"] = msg["status"]
            out["headers"] = dict(msg["headers"])
        else:
            out["body"] = msg.get("body", b"")

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    await mw(_scope(path, method), receive, send)
    return out


@pytest.fixture()
def lanes(monkeypatch):
    """每条用例换一组小名额、短时限的道 / small, fast lanes per test."""
    http = admission._Lane("http", 2, 0.15, admission._HTTP_BUSY)
    orders = admission._Lane("orders", 1, 0.15, admission._ORDER_BUSY)
    monkeypatch.setattr(admission, "_http_lane", http)
    monkeypatch.setattr(admission, "_order_lane", orders)
    monkeypatch.setattr(settings, "ADMISSION_ENABLED", True)
    return http, orders


def test_free_slots_pass_straight_through(lanes):
    app = _App(hold=0.01)
    mw = admission.AdmissionMiddleware(app)
    out = asyncio.run(_call(mw, "/api/signals"))
    assert out["status"] == 200
    http, _ = lanes
    assert http.inflight == 0 and http.rejected == 0


def test_full_lane_times_out_with_503(lanes):
    http, _ = lanes
    app = _App(hold=0.5)
    mw = admission.AdmissionMiddleware(app)

    async def go():
        return await asyncio.gather(*(_call(mw, "/api/signals") for _ in range(3)))

    results = asyncio.run(go())
    statuses = sorted(r["status"] for r in results)
    assert statuses == [200, 200, 503]
    busy = next(r for r in results if r["status"] == 503)
    assert busy["headers"][b"retry-after"] == b"2"
    assert http.rejected == 1 and http.inflight == 0
    assert len(app.seen) == 2, "排不上的请求不能进到下游"


def test_order_rejection_says_not_sent(lanes):
    app = _App(hold=0.5)
    mw = admission.AdmissionMiddleware(app)

    async def go():
        return await asyncio.gather(_call(mw, "/api/orders", "POST"), _call(mw, "/api/orders/close", "POST"))

    results = asyncio.run(go())
    busy = next(r for r in results if r["status"] == 503)
    assert "未发出" in json.loads(busy["body"])["detail"]


def test_orders_and_ordinary_requests_do_not_share_slots(lanes):
    http, orders = lanes
    app = _App(hold=0.3)
    mw = admission.AdmissionMiddleware(app)

    async def go():
        # 普通道 2 个名额占满，下单那条道仍然能进 / the ordinary lane full, orders still get in
        return await asyncio.gather(
            _call(mw, "/api/signals"), _call(mw, "/api/signals"), _call(mw, "/api/orders", "POST"),
        )

    assert [r["status"] for r in asyncio.run(go())] == [200, 200, 200]


def test_get_orders_is_an_ordinary_request(lanes):
    assert admission._lane_for(_scope("/api/orders", "GET")) is admission._http_lane
    assert admission._lane_for(_scope("/api/orders/close", "POST")) is admission._order_lane
    assert admission._lane_for(_scope("/api/orders/abc/cancel", "POST")) is admission._order_lane
    assert admission._lane_for(_scope("/api/ordersX", "POST")) is admission._http_lane


@pytest.mark.parametrize("path,method", [
    ("/", "GET"),
    ("/api/admin/trial", "GET"),
    ("/api/bridge/poll", "POST"),
    ("/api/bridge/result", "POST"),
    ("/api/payments/webhook", "POST"),
    ("/api/feed/quotes", "POST"),
    ("/api/feed/candles", "POST"),
    ("/api/webhook/tradingview", "POST"),
    ("/api/signals", "OPTIONS"),
])
def test_exempt_paths_never_queue(lanes, path, method):
    assert admission._lane_for(_scope(path, method)) is None


def test_slot_is_released_when_the_app_raises(lanes):
    http, _ = lanes

    async def boom(scope, receive, send):
        raise RuntimeError("endpoint blew up")

    mw = admission.AdmissionMiddleware(boom)
    with pytest.raises(RuntimeError):
        asyncio.run(_call(mw, "/api/signals"))
    assert http.inflight == 0, "下游抛异常也要把名额还回去"


def test_switch_off_bypasses_everything(lanes, monkeypatch):
    monkeypatch.setattr(settings, "ADMISSION_ENABLED", False)
    http, _ = lanes
    app = _App(hold=0.3)
    mw = admission.AdmissionMiddleware(app)

    async def go():
        return await asyncio.gather(*(_call(mw, "/api/signals") for _ in range(4)))

    assert [r["status"] for r in asyncio.run(go())] == [200] * 4
    assert http.inflight == 0 and http.rejected == 0
