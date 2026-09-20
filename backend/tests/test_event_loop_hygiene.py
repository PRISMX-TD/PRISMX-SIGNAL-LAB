"""协程里不许做阻塞调用（2026-09-20 技术债清理）。

本项目有两类阻塞调用会被误放进 `async def`：

  1. **同步 Redis**（`shared_state` 用的是同步客户端，`socket_timeout=2s`）。
     Redis 一抖动就把事件循环整个冻住最多 2 秒——这段时间里所有 HTTP、所有
     WebSocket 推送、桥接长轮询一起停摆。
  2. **同步数据库查询**（生产库是远端 Supabase，一次往返几十毫秒起）。

两者都不能靠"看代码时小心"来防，所以这里用**替身函数**钉住调用路径：替身只要发现
自己是在事件循环所在的线程上被调用，就把这件事记下来，用例断言"没有发生过"。

No blocking calls from coroutines: the sync Redis client (2s socket timeout) and
sync DB queries both stall the whole event loop. Pinned with stand-ins that
record whether they ran on the loop's own thread.
"""
import asyncio
import threading

import pytest

from app.core.config import settings
from app.services import shared_state
from app.services.connection_manager import ConnectionManager
from tests.fake_redis import FakeRedis


@pytest.fixture()
def redis_on(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    shared_state.reset_for_tests(FakeRedis())
    yield
    shared_state.reset_for_tests()


@pytest.fixture()
def redis_off(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "")
    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


class _Sock:
    def __init__(self):
        self.sent = []

    async def accept(self):
        pass

    async def send_json(self, m):
        self.sent.append(m)


# ---- 在线名单 / presence roster ------------------------------------------------

def test_connected_user_ids_async_runs_redis_off_the_loop(redis_on, monkeypatch):
    """`connected_user_ids_async` 必须把同步 `set_members` 丢进线程池。

    网关慢拍每 2 秒、事件泵每 0.25 秒各读一次这个名单；直接在协程里同步读，
    Redis 抖动就是全站 2 秒停摆。
    """
    loop_thread = {}
    ran_on = []
    real = shared_state.set_members

    def spy(key):
        ran_on.append(threading.get_ident())
        return real(key)

    monkeypatch.setattr(shared_state, "set_members", spy)

    async def scenario():
        loop_thread["id"] = threading.get_ident()
        m = ConnectionManager()
        await m.register_client("u1", _Sock())
        return await m.connected_user_ids_async()

    users = asyncio.run(scenario())
    assert users == ["u1"]
    assert ran_on, "set_members 根本没被调到，用例失去意义"
    assert loop_thread["id"] not in ran_on, "同步 Redis 调用跑在了事件循环线程上"


def test_connected_user_ids_async_matches_the_sync_one(redis_on):
    """异步包装只是换个线程跑，名单内容必须逐字相同（判定逻辑只有一份）。
    The async wrapper only changes threads; the roster itself must be identical."""
    async def scenario():
        a = ConnectionManager()
        b = ConnectionManager()
        await a.register_client("u1", _Sock())
        await b.register_client("u2", _Sock())
        return sorted(await a.connected_user_ids_async()), sorted(a.connected_user_ids())

    got_async, got_sync = asyncio.run(scenario())
    assert got_async == got_sync == ["u1", "u2"]


def test_connected_user_ids_async_skips_the_thread_hop_without_redis(redis_off, monkeypatch):
    """没配 Redis 时名单只是一次字典读，不该白白多一次线程调度。
    Without Redis the roster is a dict read; no thread hop should happen."""
    hops = []
    real_to_thread = asyncio.to_thread

    async def counting(fn, *a, **kw):
        hops.append(fn)
        return await real_to_thread(fn, *a, **kw)

    monkeypatch.setattr(asyncio, "to_thread", counting)

    async def scenario():
        m = ConnectionManager()
        await m.register_client("u1", _Sock())
        return await m.connected_user_ids_async()

    assert asyncio.run(scenario()) == ["u1"]
    assert hops == []


def test_sync_connected_user_ids_is_kept_for_non_async_callers():
    """同步版本必须保留：`routers/bridge.py`、`services/push_dispatch.py`、
    `services/signal_broadcast.py` 里都有**同步**调用方，把它改成 `async def`
    会当场把它们打断。判定逻辑只有同步这一份，异步版是它的线程池包装。
    The sync method must stay — three synchronous callers depend on it.
    """
    import inspect

    assert not inspect.iscoroutinefunction(ConnectionManager.connected_user_ids)
    assert inspect.iscoroutinefunction(ConnectionManager.connected_user_ids_async)


# ---- WebSocket 建连鉴权 / WS connect authentication ----------------------------

def test_ws_authentication_query_runs_off_the_loop(monkeypatch):
    """WS 建连鉴权要查一次 `token_version`，必须经线程池。

    建连是会突发的：部署重启、手机从后台回来、网络切换都会让一批客户端同时重连，
    每条都在事件循环上同步查一次远端库，就是一次自己造出来的停摆。
    """
    from app.routers import ws as ws_router

    loop_thread = {}
    ran_on = []

    def fake_authenticate(token):
        ran_on.append(threading.get_ident())
        return "u1" if token == "good" else None

    monkeypatch.setattr(ws_router, "_authenticate", fake_authenticate)

    class _Closing(_Sock):
        """鉴权成功后立刻断开：只验证鉴权这一段，不进推送循环。"""
        async def receive_json(self):
            return {"type": "AUTH", "token": "good"}

        async def receive_text(self):
            raise ws_router.WebSocketDisconnect()

        async def close(self):
            pass

    async def scenario():
        loop_thread["id"] = threading.get_ident()
        await ws_router.ws_client(_Closing())

    asyncio.run(scenario())
    assert ran_on, "_authenticate 没被调到，用例失去意义"
    assert loop_thread["id"] not in ran_on, "鉴权的同步数据库查询跑在了事件循环线程上"
