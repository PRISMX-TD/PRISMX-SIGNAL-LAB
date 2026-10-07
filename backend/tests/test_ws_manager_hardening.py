"""WebSocket 连接管理器：断开后的缓存回收，与一个慢客户端的影响半径。

**缓存回收**：`_positions` / `_quotes` 都按 user_id 存。原来只在断开时清 `_clients`
与去重摘要，这两张表留着——进程内存于是随「**曾经**连过的用户 × 他当时的持仓与
报价条数」单调增长，只有重启才释放。重连后下一拍（1.5 秒内）会重新填上，丢掉没有
任何代价。

**慢客户端**：`send_json` 在 TCP 背压下可以长时间不返回（对端活着但读得极慢：手机
切后台、弱网）。原来是逐个 await，一个这样的连接会按顺序拖住它后面所有连接；广播
还会把这个延迟传导到下一个用户。现在并发发送、每个发送单独带超时，超时与报错一样
按死连接摘掉。

Connection-manager hardening: cache reclamation on disconnect, and the blast
radius of one slow client. (仓库里没有 pytest-asyncio，异步用例一律 asyncio.run
包一层，与 tests/test_auto_manage_gateway.py 等的写法一致。)
"""
import asyncio
import json

import pytest

from app.services.connection_manager import SEND_TIMEOUT_SECONDS, ConnectionManager


class FakeWS:
    """记下收到的消息；可以配置成「发不出去」或「发得极慢」。"""

    def __init__(self, *, fails: bool = False, stalls: bool = False) -> None:
        self.sent: list = []
        self.fails = fails
        self.stalls = stalls

    async def send_json(self, message):
        if self.fails:
            raise RuntimeError("peer is gone")
        if self.stalls:
            await asyncio.sleep(3600)
        self.sent.append(message)

    async def send_text(self, text):
        # 管理器序列化一次再 send_text；失败 / 卡住的行为与 send_json 相同。
        # The manager send_texts pre-serialized frames; same fail/stall behaviour.
        await self.send_json(json.loads(text))


# ---------- 断开后的缓存回收 / cache reclamation ----------

def test_last_disconnect_drops_the_per_user_caches():
    async def scenario():
        mgr = ConnectionManager()
        ws = FakeWS()
        await mgr.register_client("u1", ws)
        await mgr.push_positions("u1", [{"login": "100", "profit": 1.0}])
        mgr.update_quotes("u1", [{"symbol": "XAUUSD", "login": "100", "bid": 1.0, "ask": 1.1}])
        assert mgr.get_positions("u1") and mgr.get_quotes("u1")

        await mgr.unregister_client("u1", ws)
        return mgr

    mgr = asyncio.run(scenario())
    assert mgr._positions == {} and mgr._quotes == {}
    assert mgr._clients == {} and mgr._last_positions_push == {}


def test_a_second_tab_closing_keeps_the_caches():
    """多开一个标签页时关掉其中一个，人还在线，缓存不能跟着没了。"""
    async def scenario():
        mgr = ConnectionManager()
        tab1, tab2 = FakeWS(), FakeWS()
        await mgr.register_client("u1", tab1)
        await mgr.register_client("u1", tab2)
        await mgr.push_positions("u1", [{"login": "100", "profit": 1.0}])

        await mgr.unregister_client("u1", tab1)
        return mgr

    assert asyncio.run(scenario()).get_positions("u1")


def test_positions_come_back_after_a_reconnect():
    """回收不能把重连的人坑了：下一拍照常重新填上并推出去。"""
    async def scenario():
        mgr = ConnectionManager()
        ws = FakeWS()
        await mgr.register_client("u1", ws)
        await mgr.push_positions("u1", [{"login": "100", "profit": 1.0}])
        await mgr.unregister_client("u1", ws)

        again = FakeWS()
        await mgr.register_client("u1", again)
        await mgr.push_positions("u1", [{"login": "100", "profit": 1.0}])
        return mgr, again

    mgr, again = asyncio.run(scenario())
    assert again.sent and again.sent[-1]["type"] == "POSITIONS"
    assert mgr.get_positions("u1") == [{"login": "100", "profit": 1.0}]


# ---------- 一个慢客户端的影响半径 / one slow client ----------

def test_a_stalled_socket_does_not_hold_up_the_others():
    """卡住的那个连接不能让同一批里其他人等它——每条连接有自己的发件队列，投递只是入队。
    以前 gather 要等满发送超时；现在 _deliver_local 立刻返回，健康连接此刻已经收到。"""
    async def scenario():
        mgr = ConnectionManager()
        stalled, healthy = FakeWS(stalls=True), FakeWS()
        await mgr.register_client("u1", stalled)
        await mgr.register_client("u1", healthy)

        # 卡住的连接要 3600 秒才发得完；投递本身必须在远短于发送超时的时间内返回。
        await asyncio.wait_for(mgr._deliver_local("u1", {"type": "PING"}), 0.5)
        return list(healthy.sent)

    assert asyncio.run(scenario()) == [{"type": "PING"}]


def test_a_stalled_socket_is_dropped_on_timeout(monkeypatch):
    """超时就当死连接摘掉，否则每 1.5 秒一拍会一直对它白发。写协程里的发送超时到点即摘。"""
    monkeypatch.setattr("app.services.connection_manager.SEND_TIMEOUT_SECONDS", 0.01)

    async def scenario():
        mgr = ConnectionManager()
        stalled, healthy = FakeWS(stalls=True), FakeWS()
        await mgr.register_client("u1", stalled)
        await mgr.register_client("u1", healthy)

        await mgr._deliver_local("u1", {"type": "PING"})
        await asyncio.sleep(0.1)          # 写协程的 0.01 秒发送超时已到 / the writer's timeout has fired
        return mgr, healthy

    mgr, healthy = asyncio.run(scenario())
    assert mgr._clients["u1"] == {healthy}
    assert healthy.sent == [{"type": "PING"}]


def test_a_full_outbox_drops_and_closes_the_connection(monkeypatch):
    """队列满 = 这条连接已经落后十几帧：判死清理，并关掉它让前端重连拿完整快照。
    只摘不关的话它的读循环还活着、心跳照回 PONG，就成了收不到任何推送的僵尸。"""
    monkeypatch.setattr("app.services.connection_manager.OUTBOX_MAXSIZE", 3)

    class ClosableStalled(FakeWS):
        closed_with = None

        async def close(self, code=1000):
            self.closed_with = code

    async def scenario():
        mgr = ConnectionManager()
        stalled, healthy = ClosableStalled(stalls=True), FakeWS()
        await mgr.register_client("u1", stalled)
        await mgr.register_client("u1", healthy)
        for i in range(6):                # 写协程卡在第一帧上，后面的帧只能堆队列
            await mgr._deliver_local("u1", {"type": "TICK", "i": i})
        await asyncio.sleep(0.05)         # 让后台关闭任务跑完
        return mgr, stalled, healthy

    mgr, stalled, healthy = asyncio.run(scenario())
    assert mgr._clients["u1"] == {healthy}
    assert [m["i"] for m in healthy.sent] == list(range(6)), "健康连接一帧都不能少、顺序不能乱"
    assert stalled.closed_with == 1013
    assert stalled not in mgr._outboxes


def test_frames_to_one_connection_keep_their_order():
    """发件队列是 FIFO，同一条连接上帧的先后顺序与投递顺序一致。"""
    async def scenario():
        mgr = ConnectionManager()
        ws = FakeWS()
        await mgr.register_client("u1", ws)
        for i in range(8):
            await mgr._deliver_local("u1", {"i": i})
        return ws

    assert [m["i"] for m in asyncio.run(scenario()).sent] == list(range(8))


def test_unregister_stops_the_writer_task():
    """连接注销后写协程必须随之结束，否则每条连接白留一个常驻任务。"""
    async def scenario():
        mgr = ConnectionManager()
        ws = FakeWS()
        await mgr.register_client("u1", ws)
        task = mgr._outboxes[ws].task
        await mgr.unregister_client("u1", ws)
        await asyncio.sleep(0)
        return mgr, task

    mgr, task = asyncio.run(scenario())
    assert task.done() and mgr._outboxes == {}


def test_a_failed_socket_is_still_dropped():
    """原有行为不能丢：发不出去的连接照样摘掉，并触发最后一个连接的清理。"""
    async def scenario():
        mgr = ConnectionManager()
        await mgr.register_client("u1", FakeWS(fails=True))
        await mgr._deliver_local("u1", {"type": "PING"})
        return mgr

    assert "u1" not in asyncio.run(scenario())._clients


def test_broadcast_does_not_serialise_users(monkeypatch):
    """广播时一个用户卡住，不能让后面的用户排队等他。"""
    monkeypatch.setattr("app.services.connection_manager.SEND_TIMEOUT_SECONDS", 0.01)

    async def scenario():
        mgr = ConnectionManager()
        slow, fast = FakeWS(stalls=True), FakeWS()
        await mgr.register_client("slow_user", slow)
        await mgr.register_client("fast_user", fast)

        await mgr._broadcast_local({"type": "SIGNAL"})
        return fast

    assert asyncio.run(scenario()).sent == [{"type": "SIGNAL"}]


def test_the_timeout_is_short_enough_to_matter():
    """超时必须短于持仓推送的节拍（1.5~2 秒），否则慢连接仍会跨拍堆积。"""
    assert 0 < SEND_TIMEOUT_SECONDS <= 2


# ---------- 本进程兜底快照的过期与回收（2026-10-07）----------
# Local fallback snapshots: age limit and reclamation.

def _later(monkeypatch, seconds: float) -> None:
    """把 monotonic 往后拨 seconds 秒（保持递增，事件循环照常）。"""
    import time as _time

    import app.services.connection_manager as cm
    real = _time.monotonic
    monkeypatch.setattr(cm.time, "monotonic", lambda: real() + seconds)


def test_bridge_only_user_local_snapshot_expires_and_is_released(monkeypatch):
    """只走桥接上报、从不开页面的用户没有 WS 断开这一步，本进程的快照以前永远不清；
    超过 Redis 键的寿命后也不能再当成当前持仓用。/ A bridge-only user never disconnects,
    so the local copy was never released, and outlived the Redis keys it backs up."""
    import app.services.connection_manager as cm
    from app.services import shared_state

    monkeypatch.setattr(shared_state, "enabled", lambda: False)
    mgr = ConnectionManager()
    asyncio.run(mgr.push_positions("u1", [{"login": "100", "profit": 1.0}]))
    mgr.update_quotes("u1", [{"symbol": "XAUUSD", "login": "100", "bid": 1.0, "ask": 1.1}])
    assert mgr.get_positions("u1") and mgr.get_quotes("u1")

    _later(monkeypatch, cm.SNAPSHOT_TTL_SECONDS + 1)
    assert mgr.get_positions("u1") == []           # 过期的不再当成当前持仓
    assert mgr.get_positions_shared("u1") == []
    mgr._maybe_prune_local(force=True)
    assert mgr._positions == {} and mgr._last_positions_push == {}
    assert mgr._quotes                              # 报价寿命更长（QUOTES_TTL_SECONDS）

    _later(monkeypatch, cm.QUOTES_TTL_SECONDS + 1)
    assert mgr.get_quotes("u1") == []
    mgr._maybe_prune_local(force=True)
    assert mgr._quotes == {} and mgr._local_at == {} and mgr._quotes_at == {}


def test_stale_local_slice_does_not_fill_a_redis_gap(monkeypatch):
    """Redis 里该来源的键已过期：本进程那份同样过期，就不能拿来补缺。
    Once the Redis key has expired, an equally old local slice must not fill the gap."""
    import app.services.connection_manager as cm
    from app.core.config import settings
    from app.services import shared_state
    from tests.fake_redis import FakeRedis

    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    shared_state.reset_for_tests(FakeRedis())
    cm._install_async_redis(None)
    try:
        mgr = ConnectionManager()
        mgr._positions["u1"] = {"gateway": [{"login": "1", "ticket": 1}]}
        mgr._local_at["u1"] = {("positions", "gateway"): 0.0}
        _later(monkeypatch, cm.SNAPSHOT_TTL_SECONDS + 1)
        assert mgr.get_positions_shared("u1") == []
        snap = asyncio.run(mgr.connect_snapshot_async("u1"))
        assert snap["positions"] == []
    finally:
        shared_state.reset_for_tests()


def test_connected_user_keeps_fresh_state_through_prune(monkeypatch):
    from app.services import shared_state

    monkeypatch.setattr(shared_state, "enabled", lambda: False)

    async def scenario():
        mgr = ConnectionManager()
        ws = FakeWS()
        await mgr.register_client("u1", ws)
        await mgr.push_positions("u1", [{"login": "100", "profit": 1.0}])
        mgr._maybe_prune_local(force=True)
        return mgr

    mgr = asyncio.run(scenario())
    assert mgr.get_positions("u1") and "u1" in mgr._last_positions_push
