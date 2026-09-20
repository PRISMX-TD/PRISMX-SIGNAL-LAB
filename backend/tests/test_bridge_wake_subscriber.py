"""桥接唤醒的跨 worker 订阅协程不能漏连接（审计 F-09 的同源第二处）。

`shared_state.new_async_pubsub` 每次调用都新建一个 redis.asyncio 客户端（连同它
自己的连接池）。这条订阅循环断线后每 3 秒重来一轮，不关旧客户端的话，Redis 每抖动
一次就多留一组连接——一段不稳定期下来连接数线性堆高，最后撞 maxclients。而这条链路
挂着的是「订单落库立刻叫醒长轮询中的桥接」，堵住就退回 1.5 秒轮询的下单延迟。

`connection_manager.run_fanout_subscriber` 早已用 `with_client=True` + finally 关闭，
这里钉住 `bridge_wake.run_subscriber` 与它同款。

The bridge-wake fan-out subscriber must close its per-pass redis client.
"""
import asyncio

import pytest

from app.core.config import settings
from app.services import bridge_wake, shared_state


class _FakePubSub:
    def __init__(self, messages, fail_after=False):
        self._messages = messages
        self._fail_after = fail_after
        self.closed = False

    async def subscribe(self, _channel):
        pass

    async def listen(self):
        for m in self._messages:
            yield m
        if self._fail_after:
            raise RuntimeError("connection dropped")

    async def aclose(self):
        self.closed = True


class _FakeClient:
    def __init__(self):
        self.closed = False

    async def aclose(self):
        self.closed = True


@pytest.fixture()
def redis_on(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    yield
    shared_state.reset_for_tests()


def _run_one_pass(monkeypatch, messages, fail_after):
    """跑订阅循环，等它绕完一轮后取消，返回这一轮用过的 (pubsub, client)。"""
    made = []

    def fake_new_async_pubsub(channel, with_client=False):
        assert with_client, "必须用 with_client=True 才拿得到客户端句柄来关闭它"
        ps, cl = _FakePubSub(list(messages), fail_after), _FakeClient()
        made.append((ps, cl))
        return ps, channel, cl

    monkeypatch.setattr(shared_state, "new_async_pubsub", fake_new_async_pubsub)
    monkeypatch.setattr(shared_state, "enabled", lambda: True)

    async def scenario():
        task = asyncio.create_task(bridge_wake.run_subscriber())
        # 让循环跑到第一轮结束（断线后它会 sleep(3) 再重来）
        for _ in range(50):
            await asyncio.sleep(0)
            if made and made[0][1].closed:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(scenario())
    return made


def test_subscriber_closes_client_after_a_drop(redis_on, monkeypatch):
    """断线重连那一轮必须把 pubsub 与 client 都关掉——泄漏正是发生在异常路径上。
    The client must be closed on the error path, which is where the leak lived."""
    made = _run_one_pass(monkeypatch, messages=[], fail_after=True)
    assert made, "订阅循环没跑起来"
    ps, cl = made[0]
    assert ps.closed is True
    assert cl.closed is True


def test_subscriber_still_applies_wakes(redis_on, monkeypatch):
    """关连接是顺带做的，唤醒本身照常生效（别把功能一起改没了）。
    Closing is incidental; the wake itself must still be delivered."""
    import json

    bridge_wake._events.clear()
    ev = bridge_wake._event("u1")
    assert not ev.is_set()
    msg = {"type": "message", "data": json.dumps({"from": "other-worker", "user": "u1"})}
    _run_one_pass(monkeypatch, messages=[msg], fail_after=True)
    assert ev.is_set()
    bridge_wake._events.clear()


def test_close_helper_never_lets_a_cleanup_failure_kill_the_loop():
    """关闭失败只记日志：清理出问题不该把订阅循环带下去。
    A cleanup failure must never propagate out of the loop."""
    class _Boom:
        async def aclose(self):
            raise RuntimeError("already gone")

    asyncio.run(bridge_wake._close_pubsub(_Boom(), None))
