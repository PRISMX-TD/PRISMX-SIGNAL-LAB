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


# ---------- 旧的一帧不能盖掉新的（一键平仓持仓数 6 → 0 → 5 → 0）----------
# ---------- an older frame must not overwrite a newer one ----------
#
# 成交后那一路手里的持仓是这一轮开始时的样子，却要等资金读完才推。这期间别的路（开平仓
# 事件快拍、周期读）推过一帧，手里这份就可能已经过期。2026-11-16 的第一版修复比的是「读
# 开始的时刻」，线上没挡住：事件快拍比回执这一轮**更早**开始读，读回来的却是**更新**的
# 状态（它去券商服务器读，到达时六笔已全平）。所以判据改成「我等的这段时间里有没有别的帧
# 推出去过」。
# The post-fill pass holds rows from its start until the funds read returns; if another
# path pushed in between, they may be stale. The first fix (2026-11-16) compared read
# start times and failed in production: the event snapshot started reading earlier than
# the reply's pass yet returned newer state. The test is now "did any other frame go out
# while this pass waited".


def _reply_positions(*tickets: int):
    """网关回执里带的持仓，解析成 push_positions_now 的 known 用的样子。"""
    return gateway_client._trade_rsp({"ok": True, "positions": [_pos(t) for t in tickets]}).positions


def _funds(balance: float, equity: float):
    from types import SimpleNamespace

    return SimpleNamespace(balance=balance, equity=equity, margin=0.0)


def _position_frames(pushed) -> list[list[int]]:
    return [sorted(r["ticket"] for r in p[1]) for p in pushed if isinstance(p[1], list)]


def _funds_frames(pushed) -> list[dict]:
    return [p[1]["data"] for p in pushed if isinstance(p[1], dict) and p[1].get("type") == "ACCOUNT_FUNDS"]


def test_rows_overtaken_by_a_frame_whose_read_started_earlier_are_dropped(gw, pushed, monkeypatch):
    """线上那一次的原样：一键平仓 6 笔，第一笔的回执带回「还剩 5 笔」。事件快拍的读比这一轮
    早几毫秒开始，却在这一轮等资金的时候推出了「0 笔」。过期的 5 笔不能再推；随后重新读一轮，
    留在页面上的是新读的。资金两次都推，第一次的浮盈按已经推出去的那份（空仓）算。"""
    _, replies = gw
    replies["/positions"] = [{"ok": True, "positions": []}]
    rounds = {"n": 0}

    async def _funds_while_event_snapshot_pushes(login):
        rounds["n"] += 1
        if rounds["n"] == 1:
            await asyncio.sleep(0.05)
            # 事件快拍：读开始得比本轮还早，现在才推。/ Its read began before this pass.
            gateway_snapshot.record_priority_read("u1", time.time() - 10.0)
        return _funds(1000.0, 1000.0)

    async def _latest(user_id):
        return []

    monkeypatch.setattr(gateway_snapshot, "_read_funds", _funds_while_event_snapshot_pushes)
    monkeypatch.setattr(gateway_snapshot.manager, "get_positions_shared_async", _latest)

    known = {"500001": _reply_positions(2, 3, 4, 5, 6)}
    assert asyncio.run(gateway_snapshot.push_positions_now("u1", ["500001"], known=known))

    assert _position_frames(pushed) == [[]]      # 只有重新读的那一帧，过期的 5 笔没有推
    # adj = 净值 − 余额 − 浮盈；两次浮盈都是 0，没有按过期那 5 笔的 5.0 算。
    assert _funds_frames(pushed) == [
        {"500001": {"balance": 1000.0, "equity": 1000.0, "margin": 0.0, "adj": 0.0}},
        {"500001": {"balance": 1000.0, "equity": 1000.0, "margin": 0.0, "adj": 0.0}},
    ]
    assert rounds["n"] == 2
    assert gateway_snapshot._inflight == {}


def test_never_chases_a_path_that_keeps_pushing(gw, pushed, monkeypatch):
    """被超过后只补读一轮。补读的那一轮又被超过：持仓交给一直在推的那条路，这里只推资金。"""
    calls, _ = gw
    rounds = {"n": 0}

    async def _funds_overtaken_every_time(login):
        rounds["n"] += 1
        await asyncio.sleep(0.05)
        gateway_snapshot.record_positions_pushed("u1")
        return _funds(1000.0, 1001.0)

    async def _latest(user_id):
        return [{"login": "500001", "ticket": 9, "profit": 1.0}]

    monkeypatch.setattr(gateway_snapshot, "_read_funds", _funds_overtaken_every_time)
    monkeypatch.setattr(gateway_snapshot.manager, "get_positions_shared_async", _latest)

    known = {"500001": _reply_positions(2, 3)}
    assert not asyncio.run(gateway_snapshot.push_positions_now("u1", ["500001"], known=known))

    assert _position_frames(pushed) == []
    assert rounds["n"] == 2                                        # 1 轮 + 补读 1 轮，不再多
    assert len([c for c in calls if c[0] == "/positions"]) == 1
    assert len(_funds_frames(pushed)) == 2
    assert gateway_snapshot._inflight == {}


def test_overtaken_and_snapshot_unreadable_pushes_nothing(gw, pushed, monkeypatch):
    """被超过、又读不到已推出去的那份：这一轮什么都不推（资金交给慢拍），也不报错。"""

    async def _funds_overtaken_every_time(login):
        await asyncio.sleep(0.05)
        gateway_snapshot.record_positions_pushed("u1")
        return _funds(1000.0, 1001.0)

    async def _boom(user_id):
        raise RuntimeError("redis down")

    monkeypatch.setattr(gateway_snapshot, "_read_funds", _funds_overtaken_every_time)
    monkeypatch.setattr(gateway_snapshot.manager, "get_positions_shared_async", _boom)

    known = {"500001": _reply_positions(2)}
    assert not asyncio.run(gateway_snapshot.push_positions_now("u1", ["500001"], known=known))
    assert pushed == []


def test_own_push_does_not_count_as_being_overtaken(gw, pushed):
    """自己上一轮推的那一帧不算「被别人超过」：合并进来的下一轮照常推。"""
    calls, _ = gw

    async def _burst():
        await asyncio.gather(*(gateway_snapshot.push_positions_now("u1", ["500001"]) for _ in range(5)))

    asyncio.run(_burst())
    assert len(_position_frames(pushed)) == 2
    assert len([c for c in calls if c[0] == "/positions"]) == 2


def test_periodic_push_claim(gw):
    """周期读：比最近一次即时快照早开始读就不推；能推且仓位增减了才记「有一帧推出去了」。"""
    t0 = time.time()
    # 仓位没变的帧不记 / a frame that only moves floating P/L is not recorded
    assert gateway_snapshot.claim_periodic_push("u1", t0, changed=False)
    assert not gateway_snapshot.positions_pushed_after("u1", t0 - 1.0)
    # 仓位增减了：记一笔 / a change in the set of positions is recorded
    assert gateway_snapshot.claim_periodic_push("u1", t0, changed=True)
    assert gateway_snapshot.positions_pushed_after("u1", t0 - 1.0)
    assert not gateway_snapshot.positions_pushed_after("u1", time.time() + 1.0)
    assert not gateway_snapshot.positions_pushed_after("someone-else", t0 - 1.0)
    # 即时快照的读比这一拍晚开始：这一拍不推，也不记
    gateway_snapshot.record_priority_read("u2", t0 + 5.0)
    marked = time.time()
    assert not gateway_snapshot.claim_periodic_push("u2", t0, changed=True)
    assert not gateway_snapshot.positions_pushed_after("u2", marked + 0.5)


def test_reply_rows_count_from_when_the_command_was_sent(gw, pushed, monkeypatch):
    """回执带的持仓是网关回执那一刻的样子，比这一轮开始得早。事件快拍在「指令发出之后、本轮
    开始之前」推了一帧：按本轮开始时刻比会漏判，过期的回执持仓又推出去（2026-11-17 审查）。
    给了 known_since 就从发单时刻算起，这份不推，重新读一轮。"""
    _, replies = gw
    replies["/positions"] = [{"ok": True, "positions": []}]
    sent_at = time.time() - 1.0
    # 事件快拍在发单之后、本轮开始之前推过 / pushed after the send, before this pass began
    gateway_snapshot.record_positions_pushed("u1")

    async def _funds(login):
        return _funds_obj()

    async def _latest(user_id):
        return []

    monkeypatch.setattr(gateway_snapshot, "_read_funds", _funds)
    monkeypatch.setattr(gateway_snapshot.manager, "get_positions_shared_async", _latest)

    known = {"500001": _reply_positions(2, 3)}
    asyncio.run(gateway_snapshot.push_positions_now("u1", ["500001"], known=known, known_since=sent_at))

    assert _position_frames(pushed) == [[]]


def test_without_known_since_the_pass_start_still_applies(gw, pushed, monkeypatch):
    """不给 known_since（周期读、事件快拍那几路）：照旧按本轮开始时刻判，之前推过的帧不算。"""
    gateway_snapshot.record_positions_pushed("u1")
    time.sleep(0.01)

    async def _funds(login):
        return _funds_obj()

    monkeypatch.setattr(gateway_snapshot, "_read_funds", _funds)
    known = {"500001": _reply_positions(2, 3)}
    asyncio.run(gateway_snapshot.push_positions_now("u1", ["500001"], known=known))

    assert _position_frames(pushed) == [[2, 3]]


def _funds_obj():
    return _funds(1000.0, 1000.0)
