"""成交后即时持仓快照 + 挂单轮询减负（2026-11-11 "成交了但仓位几秒后才出现"）。

钉住：
- 即时读带 priority=True，网关回 read_busy 时短暂重试，不是一次就放弃；
- 连不上 / 超时不重试（交给周期读）；
- 推完记下读开始时刻，比它早开始的周期读不再推（防止新仓位被旧快照盖掉）；
- 同一用户并发触发合并成至多两次读；
- 挂单周期轮询跳过「已确认没有挂单」的账号，挂单类动作清掉标记后一定真读。
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app.services import gateway_client, gateway_snapshot, pending_orders, shared_state


def _pos(ticket: int) -> dict:
    return {
        "ticket": ticket, "symbol": "XAUUSD.s", "side": "BUY", "volume": 0.01,
        "priceOpen": 4000.0, "priceCurrent": 4001.0, "stopLoss": 0, "takeProfit": 0,
        "profit": 1.0, "comment": "PRISMX-x",
    }


@pytest.fixture
def gw(monkeypatch):
    """stub 网关 HTTP：按路径排好回复队列，记录每次请求体。"""
    calls: list[tuple[str, dict]] = []
    replies: dict[str, list[dict]] = {}

    async def _fake_post(path, body, timeout=None):
        calls.append((path, dict(body)))
        q = replies.get(path) or []
        return dict(q.pop(0)) if q else {"ok": True, "positions": [], "orders": []}

    monkeypatch.setattr(gateway_client, "_post", _fake_post)
    monkeypatch.setattr(gateway_snapshot, "PRIORITY_READ_RETRY_DELAY", 0.0)
    shared_state.reset_for_tests()
    gateway_snapshot._inflight.clear()
    yield calls, replies
    shared_state.reset_for_tests()
    gateway_snapshot._inflight.clear()


@pytest.fixture
def pushed(monkeypatch):
    out: list[tuple[str, list]] = []

    async def _push_positions(user_id, data, source="bridge"):
        out.append((user_id, list(data)))

    async def _push_pending(user_id, rows, source="bridge"):
        out.append((user_id, list(rows)))

    async def _push_to_client(user_id, message):
        out.append((user_id, message))

    monkeypatch.setattr(gateway_snapshot.manager, "push_positions", _push_positions)
    monkeypatch.setattr(gateway_snapshot.manager, "push_to_client", _push_to_client)
    monkeypatch.setattr(pending_orders.manager, "push_pending_orders", _push_pending)
    return out


def test_priority_read_sends_flag_and_retries_read_busy(gw):
    calls, replies = gw
    replies["/positions"] = [
        {"ok": False, "error": "read_busy"},
        {"ok": False, "error": "read_busy"},
        {"ok": True, "positions": [_pos(11)]},
    ]
    rows, ok = asyncio.run(gateway_snapshot.read_positions_priority("500001"))
    assert ok and [r["ticket"] for r in rows] == [11]
    assert len(calls) == 3
    assert all(body == {"login": 500001, "priority": True} for _, body in calls)


def test_priority_read_gives_up_on_connect_failure(gw):
    calls, replies = gw
    replies["/positions"] = [{"ok": False, "error": "connect_failed"}]
    rows, ok = asyncio.run(gateway_snapshot.read_positions_priority("500001"))
    assert (rows, ok) == ([], False)
    assert len(calls) == 1


def test_periodic_read_has_no_priority_flag(gw):
    calls, _ = gw
    asyncio.run(gateway_client.get_positions(500001))
    assert calls == [("/positions", {"login": 500001})]


def test_push_now_pushes_all_logins_and_stamps(gw, pushed):
    _, replies = gw
    replies["/positions"] = [
        {"ok": True, "positions": [_pos(1)]},
        {"ok": True, "positions": [_pos(2)]},
    ]
    before = time.time()
    assert asyncio.run(gateway_snapshot.push_positions_now("u1", ["500001", "500002"]))
    assert sorted(r["ticket"] for r in pushed[0][1]) == [1, 2]
    # 比即时读早开始的周期读不推；之后开始的照推。
    assert gateway_snapshot.priority_read_after("u1", before - 1.0)
    assert not gateway_snapshot.priority_read_after("u1", time.time() + 1.0)
    assert not gateway_snapshot.priority_read_after("other-user", before - 1.0)


def test_push_now_skips_when_any_login_fails(gw, pushed):
    _, replies = gw
    replies["/positions"] = [
        {"ok": True, "positions": [_pos(1)]},
        {"ok": False, "error": "timeout"},
    ]
    assert not asyncio.run(gateway_snapshot.push_positions_now("u1", ["500001", "500002"]))
    assert pushed == []
    assert not gateway_snapshot.priority_read_after("u1", 0.0)


def test_push_now_coalesces_concurrent_requests(gw, pushed):
    calls, _ = gw

    async def _burst():
        await asyncio.gather(*(gateway_snapshot.push_positions_now("u1", ["500001"]) for _ in range(10)))

    asyncio.run(_burst())
    # 第一次读 + 合并后的一次重跑，不是十次。/ One read plus one coalesced rerun.
    assert len([c for c in calls if c[0] == "/positions"]) == 2
    assert len([p for p in pushed if isinstance(p[1], list)]) == 2
    assert gateway_snapshot._inflight == {}


def test_pending_poll_skips_known_empty_until_forgotten(gw, pushed):
    calls, replies = gw
    replies["/orders"] = [{"ok": True, "orders": []}]

    asyncio.run(pending_orders.push_gateway_pending_orders("u1", ["500001"], skip_known_empty=True))
    assert len([c for c in calls if c[0] == "/orders"]) == 1

    # 已确认没有挂单：周期轮询不再读，但照推空帧。/ Known empty: no read, still pushes.
    asyncio.run(pending_orders.push_gateway_pending_orders("u1", ["500001"], skip_known_empty=True))
    assert len([c for c in calls if c[0] == "/orders"]) == 1
    assert pushed[-1] == ("u1", [])

    # 挂单动作后的即时刷新（不带 skip）一定真读。/ The post-action refresh always reads.
    asyncio.run(pending_orders.push_gateway_pending_orders("u1", ["500001"]))
    assert len([c for c in calls if c[0] == "/orders"]) == 2

    # 清掉标记后周期轮询也真读。/ Once forgotten, the poll reads again.
    pending_orders.forget_no_pending("500001")
    asyncio.run(pending_orders.push_gateway_pending_orders("u1", ["500001"], skip_known_empty=True))
    assert len([c for c in calls if c[0] == "/orders"]) == 3


def test_pending_poll_keeps_reading_logins_with_orders(gw, pushed):
    calls, replies = gw
    order = {"ticket": 9, "symbol": "XAUUSD.s", "type": 2, "volume": 0.01,
             "priceOrder": 3990.0, "stopLoss": 0, "takeProfit": 0, "comment": ""}
    replies["/orders"] = [{"ok": True, "orders": [order]}, {"ok": True, "orders": [order]}]
    for _ in range(2):
        asyncio.run(pending_orders.push_gateway_pending_orders("u1", ["500001"], skip_known_empty=True))
    assert len([c for c in calls if c[0] == "/orders"]) == 2
    assert len(pushed[-1][1]) == 1


def test_push_now_also_pushes_funds_with_adj(gw, pushed):
    _, replies = gw
    replies["/positions"] = [{"ok": True, "positions": [_pos(1)]}]
    replies["/account"] = [{"ok": True, "login": 500001, "balance": 1000.0, "equity": 1000.5,
                            "margin": 40.0, "marginFree": 960.5}]
    assert asyncio.run(gateway_snapshot.push_positions_now("u1", ["500001"]))
    # 持仓先推，资金紧跟：平仓后余额和浮盈同一刻对上。/ Positions first, funds right after.
    assert isinstance(pushed[0][1], list)
    msg = pushed[1][1]
    assert msg["type"] == "ACCOUNT_FUNDS"
    # adj = 净值 − 余额 − 浮盈(1.0)。/ adj = equity − balance − floating.
    assert msg["data"] == {"500001": {"balance": 1000.0, "equity": 1000.5, "margin": 40.0, "adj": -0.5}}


def test_push_now_skips_funds_when_account_read_fails(gw, pushed):
    _, replies = gw
    replies["/positions"] = [{"ok": True, "positions": [_pos(1)]}]
    replies["/account"] = [{"ok": False, "error": "read_busy"}]
    assert asyncio.run(gateway_snapshot.push_positions_now("u1", ["500001"]))
    assert len(pushed) == 1 and isinstance(pushed[0][1], list)
