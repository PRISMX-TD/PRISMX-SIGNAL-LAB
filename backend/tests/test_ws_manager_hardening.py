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
    """卡住的那个连接不能让同一批里其他人等它——并发发送，超时各算各的。"""
    async def scenario():
        mgr = ConnectionManager()
        stalled, healthy = FakeWS(stalls=True), FakeWS()
        await mgr.register_client("u1", stalled)
        await mgr.register_client("u1", healthy)

        task = asyncio.create_task(mgr._deliver_local("u1", {"type": "PING"}))
        # 转几圈事件循环：并发实现下健康连接此刻已经收到，串行实现还卡在第一个上。
        for _ in range(5):
            await asyncio.sleep(0)
        delivered = list(healthy.sent)

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return delivered

    assert asyncio.run(scenario()) == [{"type": "PING"}]


def test_a_stalled_socket_is_dropped_on_timeout(monkeypatch):
    """超时就当死连接摘掉，否则每 1.5 秒一拍会一直对它白发。"""
    monkeypatch.setattr("app.services.connection_manager.SEND_TIMEOUT_SECONDS", 0.01)

    async def scenario():
        mgr = ConnectionManager()
        stalled, healthy = FakeWS(stalls=True), FakeWS()
        await mgr.register_client("u1", stalled)
        await mgr.register_client("u1", healthy)

        await mgr._deliver_local("u1", {"type": "PING"})
        return mgr, healthy

    mgr, healthy = asyncio.run(scenario())
    assert mgr._clients["u1"] == {healthy}
    assert healthy.sent == [{"type": "PING"}]


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
