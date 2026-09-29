"""WS / Redis / 鉴权 / 稳定性 这一批优化的钉子。

覆盖：建连补推合成一个 pipeline、心跳记账一个 pipeline、轻量鉴权缓存（{tv, disabled} 与失效）、
持仓镜像「没变不写、EXPIRE 为 0 补 SET」、推送路由（全站没人在线不 publish、读不到名单照常 publish）、
订阅断线立即重连与重订阅补推、限流器 Redis 故障内存兜底、失败锁定 Redis 出错放行、
gamification 的「只是缓存」不再 500、DB 池超时 → 503、RLIMIT_NOFILE、permessage-deflate 窗口。

Pins for the WS / Redis / auth / stability batch (see the Chinese paragraph above). 仓库里没有
pytest-asyncio，异步用例一律 asyncio.run 包一层。
"""
import asyncio
import json
import sys
import time
import types
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException, Response

from app.core import rate_limit
from app.core.config import settings
from app.core.security import create_access_token
from app.services import connection_manager as cm
from app.services import deps, net_quality, quotes_store, shared_cache, shared_state
from app.services.connection_manager import ConnectionManager
from tests.fake_redis import AsyncFakeRedis, FakeRedis


# ---------------------------------------------------------------------------
# 夹具与替身 / fixtures and doubles
# ---------------------------------------------------------------------------

class TripRedis(FakeRedis):
    """数往返：顶层命令各算一次，pipeline 整体执行算一次。
    Counts round-trips: each top-level command is one, a pipeline execute is one."""

    def __init__(self) -> None:
        super().__init__()
        self.trips = 0
        self.log: list[str] = []
        self._in_pipe = False

    def pipeline(self, transaction=True):
        outer = self
        pipe = super().pipeline(transaction)
        real = pipe.execute

        def execute():
            outer.trips += 1
            outer.log.append("pipeline:" + ",".join(op[0] for op in pipe.ops))
            outer._in_pipe = True
            try:
                return real()
            finally:
                outer._in_pipe = False

        pipe.execute = execute
        return pipe


def _count(name):
    base = getattr(FakeRedis, name)

    def method(self, *a, **kw):
        if not self._in_pipe:
            self.trips += 1
            self.log.append(name)
        return base(self, *a, **kw)

    return method


for _n in ("get", "set", "hgetall", "lrange", "zadd", "zrem", "zrangebyscore", "zremrangebyscore",
           "expire", "incr", "delete", "publish"):
    setattr(TripRedis, _n, _count(_n))


class BrokenRedis:
    """任何命令都抛 ConnectionError 的同步替身。/ Sync double whose every command raises."""

    def __getattr__(self, name):
        def boom(*a, **kw):
            raise ConnectionError("redis is down")
        return boom


@pytest.fixture()
def redis_on(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    fake = TripRedis()
    shared_state.reset_for_tests(fake)
    cm._install_async_redis(None)
    yield fake
    cm._install_async_redis(None)
    shared_state.reset_for_tests()


@pytest.fixture()
def redis_off(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
    shared_state.reset_for_tests()
    quotes_store._quotes.clear()
    quotes_store._updated_at.clear()
    yield
    shared_state.reset_for_tests()
    quotes_store._quotes.clear()
    quotes_store._updated_at.clear()


@pytest.fixture()
def redis_broken(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    shared_state.reset_for_tests(BrokenRedis())
    cm._install_async_redis(None)
    yield
    cm._install_async_redis(None)
    shared_state.reset_for_tests()


class _Sock:
    def __init__(self):
        self.sent = []

    async def send_json(self, m):
        self.sent.append(m)

    async def send_text(self, text):
        self.sent.append(json.loads(text))


def _run(coro):
    return asyncio.run(coro)


_REAL_SLEEP = asyncio.sleep     # 有的用例会替换 cm.asyncio.sleep（同一个模块对象），测试自己的等待用这份


ROWS_GW = [{"login": "1", "ticket": 1, "profit": 1.0}]
ROWS_BR = [{"login": "2", "ticket": 2, "profit": 2.0}]


def _seed_user(redis_on):
    """让 Redis 里有 u1 的持仓（网关）、挂单（桥接）、分账户报价与全站报价。"""
    seeder = ConnectionManager()
    _run(seeder.push_positions("u1", ROWS_GW, source="gateway"))
    _run(seeder.push_pending_orders("u1", [{"ticket": 21}], source="bridge"))
    seeder.update_quotes("u1", [{"symbol": "XAUUSD", "login": "100", "bid": 1.0, "ask": 1.1}])
    quotes_store.update([
        {"symbol": "XAUUSD", "bid": 1.0, "ask": 1.1, "digits": 2},
        {"symbol": "EURUSD", "bid": 1.0, "ask": 1.1, "digits": 5},
    ])


# ---------------------------------------------------------------------------
# 1. 建连补推：一个 pipeline / connect catch-up in one round-trip
# ---------------------------------------------------------------------------

def test_connect_snapshot_is_a_single_round_trip(redis_on):
    _seed_user(redis_on)
    redis_on.trips = 0
    redis_on.log.clear()

    snap = _run(ConnectionManager().connect_snapshot_async("u1"))

    assert redis_on.trips == 1, redis_on.log      # 以前约 10 次串行往返
    assert snap["positions"] == ROWS_GW
    assert snap["pending"] == [{"ticket": 21}]
    assert [q["symbol"] for q in snap["global_quotes"]] == ["XAUUSD", "EURUSD"]   # 首次出现顺序
    assert [q["bid"] for q in snap["quotes"]] == [1.0]


def test_connect_snapshot_with_the_async_client_needs_no_thread_and_one_pipeline(redis_on, monkeypatch):
    _seed_user(redis_on)
    hops = []
    real = cm.anyio.to_thread.run_sync

    async def counting(fn, *a, **kw):
        hops.append(fn)
        return await real(fn, *a, **kw)

    monkeypatch.setattr(cm.anyio.to_thread, "run_sync", counting)
    aio = AsyncFakeRedis(redis_on)

    async def scenario():
        cm._install_async_redis(aio)
        return await ConnectionManager().connect_snapshot_async("u1")

    snap = _run(scenario())
    assert hops == [] and aio.commands == ["pipeline"]
    assert snap["positions"] == ROWS_GW and len(snap["global_quotes"]) == 2


def test_connect_snapshot_fills_a_missing_source_from_the_local_copy(redis_on):
    """语义与 _shared_by_source 一致：Redis 里缺的来源用本进程那份补，Redis 有的以 Redis 为准。"""
    _seed_user(redis_on)
    m = ConnectionManager()
    m._positions["u1"] = {"bridge": ROWS_BR}          # 本进程只知道桥接那一路
    snap = _run(m.connect_snapshot_async("u1"))
    assert sorted(p["ticket"] for p in snap["positions"]) == [1, 2]


def test_connect_snapshot_never_raises_and_falls_back_when_redis_is_down(redis_on):
    """Redis 抖动：整体退回本进程快照，全站报价退回上一份成功读到的；绝不抛出（否则刚建好的连接会被
    异常关掉、300ms 后重连、再抖一次）。"""
    _seed_user(redis_on)
    m = ConnectionManager()
    good = _run(m.connect_snapshot_async("u1"))
    assert len(good["global_quotes"]) == 2
    m._positions["u1"] = {"gateway": ROWS_GW}

    async def scenario():
        cm._install_async_redis(AsyncFakeRedis(redis_on, fail=True))
        return await m.connect_snapshot_async("u1")

    snap = _run(scenario())
    assert snap["positions"] == ROWS_GW                 # 本进程那份
    assert snap["global_quotes"] == good["global_quotes"]   # 上一份
    assert snap["pending"] == [] and snap["quotes"] == []


def test_connect_snapshot_without_redis_is_local_and_hop_free(redis_off):
    quotes_store.update([{"symbol": "XAUUSD", "bid": 1.0, "ask": 1.1}])
    m = ConnectionManager()
    _run(m.push_positions("u1", ROWS_GW, source="gateway"))
    m.update_quotes("u1", [{"symbol": "XAUUSD", "login": "1", "bid": 1.0, "ask": 1.1}])
    snap = _run(m.connect_snapshot_async("u1"))
    assert snap["positions"] == ROWS_GW and snap["pending"] == []
    assert [q["symbol"] for q in snap["global_quotes"]] == ["XAUUSD"] and len(snap["quotes"]) == 1


# ---------------------------------------------------------------------------
# 8. 持仓镜像：没变不写，EXPIRE 为 0 补 SET / mirror: no rewrite when unchanged
# ---------------------------------------------------------------------------

def test_unchanged_snapshot_is_refreshed_with_expire_not_rewritten(redis_on):
    m = ConnectionManager()
    key = "prismx:positions:u1:gateway"
    _run(m._store_and_merge("positions", "u1", "gateway", ROWS_GW))
    assert json.loads(redis_on.kv[key]) == ROWS_GW
    redis_on.log.clear()

    merged = _run(m._store_and_merge("positions", "u1", "gateway", ROWS_GW))

    assert merged == ROWS_GW
    assert len(redis_on.log) == 1 and redis_on.log[0] == "pipeline:expire,get", redis_on.log
    assert "set" not in redis_on.log[0]                       # 没有整份重写


def test_a_changed_snapshot_is_written_in_the_same_single_round_trip(redis_on):
    m = ConnectionManager()
    _run(m._store_and_merge("positions", "u1", "gateway", ROWS_GW))
    redis_on.log.clear()
    _run(m._store_and_merge("positions", "u1", "gateway", [{"login": "1", "ticket": 1, "profit": 9.0}]))
    assert redis_on.log == ["pipeline:set,get"]


def test_expire_returning_zero_restores_the_key(redis_on):
    """Redis 重启 / 驱逐把键丢了而内容没变：EXPIRE 返回 0，补一次 SET，别的 worker 不会读到空。"""
    m = ConnectionManager()
    key = "prismx:positions:u1:gateway"
    _run(m._store_and_merge("positions", "u1", "gateway", ROWS_GW))
    redis_on.kv.pop(key)                                      # 模拟键被驱逐 / simulate eviction
    _run(m._store_and_merge("positions", "u1", "gateway", ROWS_GW))
    assert json.loads(redis_on.kv[key]) == ROWS_GW
    assert ConnectionManager().get_positions_shared("u1") == ROWS_GW


def test_mirror_merges_the_other_source_read_in_the_same_pipeline(redis_on):
    a, b = ConnectionManager(), ConnectionManager()
    _run(b.push_positions("u1", ROWS_GW, source="gateway"))
    redis_on.published.clear()
    _run(a.push_positions("u1", ROWS_BR, source="bridge"))
    msg = json.loads(redis_on.published[-1][1])["message"]
    assert sorted(p["ticket"] for p in msg["data"]) == [1, 2]


def test_mirror_failure_falls_back_to_the_local_merge(redis_on):
    async def scenario():
        cm._install_async_redis(AsyncFakeRedis(redis_on, fail=True))
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)
        await m.push_positions("u1", ROWS_GW, source="gateway")
        return ws

    ws = _run(scenario())
    assert ws.sent and ws.sent[-1]["data"] == ROWS_GW          # 推送没有因为 Redis 出错而丢


def test_positions_frame_is_serialized_once(redis_off, monkeypatch):
    """去重摘要与要发的帧共用同一次序列化（以前 sort_keys 序列化一遍做摘要、再 _dumps 一遍发送）。"""
    calls = []
    real = cm._dumps

    def counting(message):
        calls.append(message.get("type"))
        return real(message)

    monkeypatch.setattr(cm, "_dumps", counting)

    async def scenario():
        m = ConnectionManager()
        await m.register_client("u1", _Sock())
        await m.push_positions("u1", ROWS_GW)
        await m.push_pending_orders("u1", [{"ticket": 1}])

    _run(scenario())
    assert calls == ["POSITIONS", "PENDING_ORDERS"]


# ---------------------------------------------------------------------------
# 9. 推送路由与在线名单 / push routing and the presence roster
# ---------------------------------------------------------------------------

def _fresh_view(m: ConnectionManager, remote=()):
    m._remote_users = set(remote)
    m._remote_at = time.monotonic()


def test_route_only_skips_redis_when_it_is_certain_nobody_is_elsewhere(redis_on):
    m = ConnectionManager()
    assert m._route(["u1"]) == "publish"            # 从没读到过名单：不知道，照常转发
    _fresh_view(m)
    assert m._route(["u1"]) == "local" and m._route(None) == "local"
    _fresh_view(m, remote={"u2"})
    assert m._route(["u1"]) == "local"              # u1 不在别的 worker 上
    assert m._route(["u1", "u2"]) == "publish"      # 批里有人在别处
    assert m._route(None) == "publish"              # 广播：别处有人
    m._remote_at = time.monotonic() - cm.PRESENCE_VIEW_MAX_AGE_SECONDS - 1
    assert m._route(["u1"]) == "publish"            # 名单太旧（Redis 抖动）：不敢信，照常转发


def test_route_is_always_local_without_redis(redis_off):
    assert ConnectionManager()._route(["u1"]) == "local"


def test_a_local_only_user_is_delivered_directly_without_publishing(redis_on):
    async def scenario():
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)
        _fresh_view(m)                                 # 名单新鲜，别处没人
        await m.push_to_client("u1", {"type": "ORDER_UPDATE"})
        await m.push_to_users(["u1", "u9"], {"type": "SIGNAL_NEW"})
        await m.broadcast_to_clients({"type": "SIGNAL"})
        return ws

    ws = _run(scenario())
    assert redis_on.published == []
    assert [f["type"] for f in ws.sent] == ["ORDER_UPDATE", "SIGNAL_NEW", "SIGNAL"]


def test_nobody_online_anywhere_means_no_publish_at_all(redis_on):
    """桥接 24 小时挂着、网页没人开：这条推送既没有本地接收者、别处也没有——不进 Redis。"""
    async def scenario():
        m = ConnectionManager()
        _fresh_view(m)
        await m.push_to_client("u1", {"type": "QUOTES"})
        await m.push_positions("u1", ROWS_GW, source="bridge")

    _run(scenario())
    assert redis_on.published == []
    # 但持仓快照照写（一键平仓与建连补推要用）/ the snapshot mirror is still written
    assert json.loads(redis_on.kv["prismx:positions:u1:bridge"]) == ROWS_GW


def test_a_user_on_another_worker_is_still_published(redis_on):
    async def scenario():
        m = ConnectionManager()
        _fresh_view(m, remote={"u2"})
        await m.push_to_client("u2", {"type": "ORDER_UPDATE"})

    _run(scenario())
    assert len(redis_on.published) == 1


def test_a_stale_or_unread_roster_publishes_as_usual(redis_on):
    async def scenario():
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)
        await m.push_to_client("u1", {"type": "A"})            # 从没读到过
        m._remote_users, m._remote_at = set(), time.monotonic() - 60
        await m.push_to_client("u1", {"type": "B"})            # 读到过但太旧
        return ws

    ws = _run(scenario())
    assert len(redis_on.published) == 2 and ws.sent == []      # 走了 Redis，没有本地直发


def test_presence_members_are_worker_prefixed_and_removed_on_last_disconnect(redis_on):
    async def scenario():
        m = ConnectionManager()
        a, b = _Sock(), _Sock()
        await m.register_client("u1", a)
        await m.register_client("u1", b)
        member = f"{m._worker_id}|u1"
        assert member in redis_on.zsets["prismx:ws:users"]
        await m.unregister_client("u1", a)
        assert member in redis_on.zsets["prismx:ws:users"]      # 还有一页开着，不能摘
        await m.unregister_client("u1", b)
        return redis_on.zsets["prismx:ws:users"]

    assert _run(scenario()) == {}, "最后一条连接走了，名单要立刻准确，而不是等 60~90 秒过期"


def test_a_quick_reconnect_is_not_undone_by_the_removal(redis_on):
    """摘除与重连交错：ZREM 发出后发现同一用户又连上来了，要补登，别把新连接误摘。"""
    async def scenario():
        m = ConnectionManager()
        a = _Sock()
        await m.register_client("u1", a)
        member = f"{m._worker_id}|u1"
        real_zrem = redis_on.zrem

        def zrem_then_user_reconnects(key, *members):
            n = real_zrem(key, *members)
            m._clients.setdefault("u1", set()).add(_Sock())     # ZREM 生效的同时用户又连上来了
            return n

        redis_on.zrem = zrem_then_user_reconnects
        await m.unregister_client("u1", a)
        return member in redis_on.zsets.get("prismx:ws:users", {})

    assert _run(scenario()) is True


def test_roster_view_ignores_own_members_and_counts_legacy_ids_as_remote(redis_on):
    m = ConnectionManager()
    m._worker_id = "A"
    m._ingest_roster(["A|u1", "B|u2", "u3"])           # u3 是老 worker 写的裸 user_id
    assert m._remote_users == {"u2", "u3"} and m._presence_fresh()
    assert m._merge_roster(["u1"], ["A|u1", "B|u2", "u3", "B|u2"]) == ["u1", "u2", "u3"]


def test_connected_user_ids_reads_prefixed_and_legacy_members(redis_on):
    async def scenario():
        a, b = ConnectionManager(), ConnectionManager()
        a._worker_id, b._worker_id = "A", "B"
        await a.register_client("u1", _Sock())
        await b.register_client("u2", _Sock())
        redis_on.zadd("prismx:ws:users", {"legacy-user": time.time() + 60})
        return sorted(a.connected_user_ids()), a._remote_users

    ids, remote = _run(scenario())
    assert ids == ["legacy-user", "u1", "u2"]
    assert remote == {"u2", "legacy-user"}


def test_refresh_loop_updates_the_remote_view_on_every_worker(redis_on, monkeypatch):
    """所有 worker 都按 ~2 秒刷新「别处有谁」（这里把间隔压快）；读失败时保持上一份。"""
    monkeypatch.setattr(cm, "PRESENCE_VIEW_REFRESH_SECONDS", 0.01)

    async def scenario():
        a, b = ConnectionManager(), ConnectionManager()
        a._worker_id, b._worker_id = "A", "B"
        await b.register_client("u2", _Sock())
        task = asyncio.create_task(a.refresh_presence_loop())
        for _ in range(100):
            if a._remote_users == {"u2"}:
                break
            await asyncio.sleep(0.01)
        seen = set(a._remote_users)
        # Redis 断了：视图保持上一份，不清空（清空会误判成本地独有而漏投）
        shared_state.reset_for_tests(BrokenRedis())
        await asyncio.sleep(0.05)
        kept = set(a._remote_users)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return seen, kept

    seen, kept = _run(scenario())
    assert seen == {"u2"} and kept == {"u2"}


# ---------------------------------------------------------------------------
# 9. 订阅断线：立即重连 + 重订阅补推 / subscriber reconnect and catch-up
# ---------------------------------------------------------------------------

class _FakeClient:
    async def aclose(self):
        pass


class _FakePubSub:
    """subscribe 按脚本成功或抛错；listen 之后挂起直到被取消。"""

    def __init__(self, fail: bool):
        self.fail = fail

    async def subscribe(self, channel):
        if self.fail:
            raise ConnectionError("cannot subscribe")

    async def listen(self):
        await asyncio.Event().wait()
        yield  # pragma: no cover

    async def aclose(self):
        pass


def _install_pubsubs(monkeypatch, plan: list[bool]):
    """plan[i] = 第 i 次订阅是否失败。返回 (尝试次数记录, sleep 时长记录)。"""
    attempts, delays = [], []

    def new_pubsub(channel, with_client=False):
        i = len(attempts)
        attempts.append(i)
        return _FakePubSub(plan[min(i, len(plan) - 1)]), "prismx:ws", _FakeClient()

    monkeypatch.setattr(shared_state, "new_async_pubsub", new_pubsub)
    async def rec_sleep(delay, *a, **kw):
        delays.append(delay)
        await _REAL_SLEEP(0)

    monkeypatch.setattr(cm.asyncio, "sleep", rec_sleep)
    return attempts, delays


async def _until(pred, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        await _REAL_SLEEP(0.005)
    return False


def test_the_first_drop_reconnects_immediately_and_failures_back_off(monkeypatch):
    attempts, delays = _install_pubsubs(monkeypatch, [True, True, True, True, True, True, False])

    async def scenario():
        m = ConnectionManager()
        task = asyncio.create_task(m.run_fanout_subscriber())
        await _until(lambda: len(attempts) >= 7)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    _run(scenario())
    # 第一次立刻重连（0 秒），连续失败才 0.2 -> 0.5 -> 1 -> 3，封顶 3 秒；不再固定黑屏 3 秒
    assert delays[:6] == [0.0, 0.2, 0.5, 1.0, 3.0, 3.0]


def test_a_successful_subscribe_resets_the_backoff(monkeypatch):
    attempts, delays = _install_pubsubs(monkeypatch, [True, True, False])

    async def scenario():
        m = ConnectionManager()
        task = asyncio.create_task(m.run_fanout_subscriber())
        await _until(lambda: len(attempts) >= 3)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    _run(scenario())
    assert delays[:2] == [0.0, 0.2]


def test_local_users_get_a_positions_and_pending_catch_up_after_resubscribing(redis_on, monkeypatch):
    """订阅断开期间别的 worker 发布的持仓变化永久丢失；发送方的去重摘要又让「内容不变就不再发」，
    所以重订阅成功后必须给本进程的用户补一份快照。"""
    _seed_user(redis_on)
    _install_pubsubs(monkeypatch, [True, False])

    async def scenario():
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)
        task = asyncio.create_task(m.run_fanout_subscriber())
        ok = await _until(lambda: {f["type"] for f in ws.sent} >= {"POSITIONS", "PENDING_ORDERS"})
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return ok, ws

    ok, ws = _run(scenario())
    assert ok
    pos = next(f for f in ws.sent if f["type"] == "POSITIONS")
    assert pos["data"] == ROWS_GW and "funds" in pos


def test_catch_up_skips_empty_snapshots_and_survives_errors(redis_on):
    """快照为空就不发（Redis 刚重启、键还没写满时不能把前端的表清空）；取数出错只记日志。"""
    async def scenario():
        m = ConnectionManager()
        ok, boom = _Sock(), _Sock()
        await m.register_client("empty", ok)
        await m.register_client("boom", boom)
        real = m.get_positions_shared_async

        async def flaky(uid):
            if uid == "boom":
                raise ConnectionError("down")
            return await real(uid)

        m.get_positions_shared_async = flaky
        await m._resync_local_users()
        return ok, boom

    ok, boom = _run(scenario())
    assert ok.sent == [] and boom.sent == []


def test_subscriber_connection_gets_connect_timeout_and_health_check_but_no_socket_timeout(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://127.0.0.1:1/0")
    shared_state.reset_for_tests()
    ps, _channel, client = shared_state.new_async_pubsub("ws", with_client=True)
    kwargs = client.connection_pool.connection_kwargs
    assert kwargs["socket_connect_timeout"] == 2.0
    assert kwargs["health_check_interval"] == shared_state.REDIS_HEALTH_CHECK_INTERVAL_SECONDS
    # 空闲的 listen() 本来就无限期阻塞读，加 socket_timeout 会让空闲订阅被自己超时断开
    assert kwargs.get("socket_timeout") is None
    asyncio.run(client.aclose())


# ---------------------------------------------------------------------------
# 7. 发件队列的顺序与死连接 —— 见 test_ws_manager_hardening.py
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 3. 心跳记账：一个 pipeline / heartbeat bookkeeping in one pipeline
# ---------------------------------------------------------------------------

def test_a_heartbeat_sample_is_one_redis_round_trip(redis_on):
    net_quality.record_connect("c1", 1)
    redis_on.trips = 0
    redis_on.log.clear()

    net_quality.record_sample("c1", 1, 120, 5, "web")

    assert redis_on.trips == 1, redis_on.log          # 以前 zadd + set + 两组 incr/expire 共 4~5 次
    snap = net_quality.snapshot()
    assert snap["live"]["connections"] == 1 and snap["live"]["dist"]["good"] == 1
    assert snap["hourly"][-1]["good"] == 1 and snap["hourly"][-1]["avgRtt"] == 120


def test_connect_and_disconnect_are_one_round_trip_each(redis_on):
    redis_on.trips = 0
    net_quality.record_connect("c1", 1)
    assert redis_on.trips == 1
    net_quality.record_disconnect("c1")
    assert redis_on.trips == 2
    snap = net_quality.snapshot()
    assert snap["live"]["connections"] == 0
    assert snap["hourly"][-1]["connects"] == 1 and snap["hourly"][-1]["disconnects"] == 1


def test_counters_keep_their_ttl_through_the_pipeline(redis_on):
    net_quality.record_sample("c1", 1, 50, None, "web")
    hour_keys = [k for k in redis_on.kv if k.startswith("prismx:netq:h:")]
    assert hour_keys and all(k in redis_on.exp for k in hour_keys)


# ---------------------------------------------------------------------------
# 2. 轻量鉴权 {tv, disabled} 缓存 / lightweight auth cache
# ---------------------------------------------------------------------------

@pytest.fixture()
def auth_db(db_session, monkeypatch):
    """让 deps 里的 SessionLocal 指向测试库（与 db_session 同一个引擎）。"""
    from sqlalchemy.orm import sessionmaker

    monkeypatch.setattr(deps, "SessionLocal", sessionmaker(bind=db_session.get_bind()))
    return db_session


def _mk_user(db, email="u@example.com", role="user", **kw):
    from app.models import User

    user = User(email=email, password_hash="x", api_token=f"tok-{email}", role=role, plan="PRO", **kw)
    db.add(user)
    db.commit()
    return user


def _tok(user):
    return create_access_token(user.id, user.token_version or 0)


def test_auth_state_is_cached_and_a_raw_sql_change_is_not_seen_until_invalidated(auth_db):
    """缓存确实在起作用（原生 SQL 绕过 ORM 事件改 tv 看不到），显式 invalidate 之后立刻生效。"""
    from sqlalchemy import text

    user = _mk_user(auth_db)
    assert deps.get_auth_state(user.id) == {"tv": 0, "d": False}
    auth_db.execute(text("UPDATE users SET token_version = 5 WHERE id = :i"), {"i": user.id})
    auth_db.commit()
    assert deps.get_auth_state(user.id) == {"tv": 0, "d": False}        # 命中缓存
    shared_cache.invalidate_auth_state(user.id)
    assert deps.get_auth_state(user.id) == {"tv": 5, "d": False}


def test_an_orm_password_change_invalidates_the_cache_by_itself(auth_db):
    """改密码 = token_version 自增并 commit：不需要调用点记得删缓存，ORM 事件在 commit 后自动删。"""
    user = _mk_user(auth_db)
    old_token = _tok(user)
    assert deps.check_token_light(old_token) == user.id

    user.token_version = (user.token_version or 0) + 1
    auth_db.commit()

    with pytest.raises(HTTPException) as err:
        deps.check_token_light(old_token)
    assert err.value.status_code == 401
    assert deps.check_token_light(_tok(user)) == user.id


def test_disable_takes_effect_immediately_on_the_light_path(auth_db):
    """test_account_disable 的语义在轻量路径上不变：停用后旧 token 立刻 403（带原因），恢复后立刻可用。"""
    from app.routers.admin import disable_user, enable_user
    from app.schemas import AdminUserDisableIn

    admin = _mk_user(auth_db, email="admin@example.com", role="admin")
    target = _mk_user(auth_db, email="t@example.com")
    assert deps.check_token_light(_tok(target)) == target.id          # 进缓存

    disable_user(target.id, AdminUserDisableIn(reason="涉嫌刷单"), db=auth_db, admin=admin)
    fresh = create_access_token(target.id, target.token_version)      # 用新 tv 也不行：仍是停用
    with pytest.raises(HTTPException) as err:
        deps.check_token_light(fresh)
    assert err.value.status_code == 403 and "涉嫌刷单" in err.value.detail

    enable_user(target.id, db=auth_db, admin=admin)                    # 恢复不动 tv，只清 disabled_at
    assert deps.check_token_light(fresh) == target.id


def test_directly_setting_disabled_at_is_seen_after_commit(auth_db):
    """直接改库停用（test_account_disable 那种写法）走 ORM 属性赋值，同样触发失效，不用等 300 秒 TTL。"""
    user = _mk_user(auth_db)
    tok = _tok(user)
    assert deps.check_token_light(tok) == user.id
    user.disabled_at = datetime.now(timezone.utc)
    auth_db.commit()
    with pytest.raises(HTTPException) as err:
        deps.check_token_light(tok)
    assert err.value.status_code == 403


def test_a_rolled_back_change_does_not_invalidate(auth_db):
    user = _mk_user(auth_db)
    deps.get_auth_state(user.id)
    key = shared_cache.auth_state_key(user.id)
    assert shared_cache.get_json(key) is not None
    user.token_version = 9
    auth_db.flush()
    auth_db.rollback()
    assert shared_cache.get_json(key) is not None
    assert deps.get_auth_state(user.id)["tv"] == 0


def test_light_auth_error_paths(auth_db):
    user = _mk_user(auth_db)
    for bad in (None, "", "Token abc", "Bearer "):
        with pytest.raises(HTTPException) as err:
            deps.get_current_user_id_light(authorization=bad)
        assert err.value.status_code == 401
    with pytest.raises(HTTPException) as err:
        deps.check_token_light(create_access_token("no-such-user", 0))
    assert err.value.status_code == 401
    assert deps.get_current_user_id_light(authorization="Bearer " + _tok(user)) == user.id


def test_auth_cache_falls_back_to_the_database_when_redis_errors(auth_db, redis_broken):
    user = _mk_user(auth_db)
    assert deps.check_token_light(_tok(user)) == user.id              # Redis 全挂：照样查库放行


def test_auth_cache_lives_in_redis_for_300_seconds_when_configured(auth_db, redis_on):
    user = _mk_user(auth_db)
    deps.get_auth_state(user.id)
    key = "prismx:rc:" + shared_cache.auth_state_key(user.id)
    assert json.loads(redis_on.kv[key]) == {"tv": 0, "d": False}
    assert 290 < redis_on.exp[key] - time.time() <= 300


# ---------------------------------------------------------------------------
# 10. 限流器 Redis 故障 / rate limiter under a Redis outage
# ---------------------------------------------------------------------------

def test_limiter_options_carry_fallback_swallow_and_socket_timeouts(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://127.0.0.1:1/0")
    opts = rate_limit.limiter_options()
    assert opts["in_memory_fallback_enabled"] is True and opts["swallow_errors"] is True
    assert opts["storage_options"] == {"socket_timeout": 1.0, "socket_connect_timeout": 1.0}
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
    assert "storage_options" not in rate_limit.limiter_options()      # 内存存储没有 socket


def test_both_real_limiters_are_configured_for_outages():
    from app.core import strategy_limits

    for lim in (rate_limit.limiter, strategy_limits.user_limiter):
        assert lim._in_memory_fallback_enabled is True
        assert lim._swallow_errors is True


def _limited_app(lim):
    from fastapi import FastAPI, Request
    from slowapi import _rate_limit_exceeded_handler
    from slowapi.errors import RateLimitExceeded
    from starlette.testclient import TestClient

    app = FastAPI()
    app.state.limiter = lim
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    @app.get("/x")
    @lim.limit("2/minute")
    def x(request: Request):
        return {"ok": True}

    return TestClient(app)


def _fresh_limiter():
    from slowapi import Limiter
    from slowapi.util import get_remote_address

    return Limiter(key_func=get_remote_address, storage_uri=None, **rate_limit.limiter_options())


# slowapi 0.1.9 在切内存兜底时调用已弃用的 Logger.warn；pytest.ini 把警告当错误，这里只放行这一条。
# slowapi 0.1.9 uses the deprecated Logger.warn when switching to the fallback; pytest.ini turns
# warnings into errors, so only that one is let through.
@pytest.mark.filterwarnings("ignore:The 'warn' method is deprecated:DeprecationWarning")
def test_a_dead_limiter_backend_degrades_to_memory_counting_not_500(monkeypatch):
    """Redis 一抛错，带 @limiter.limit 的接口不再在进入函数体前就 500：切到进程内计数，429 照常。"""
    lim = _fresh_limiter()

    def down(*a, **kw):
        raise ConnectionError("redis is down")

    monkeypatch.setattr(lim._limiter, "hit", down)
    monkeypatch.setattr(lim._limiter, "test", down)
    client = _limited_app(lim)
    assert client.get("/x").status_code == 200
    assert client.get("/x").status_code == 200
    assert client.get("/x").status_code == 429          # 兜底计数生效：限流没有丢


def test_429_still_works_in_the_normal_case():
    client = _limited_app(_fresh_limiter())
    assert [client.get("/x").status_code for _ in range(3)] == [200, 200, 429]


# ---------------------------------------------------------------------------
# 10. 失败锁定 Redis 出错放行 / lockout counters fail open
# ---------------------------------------------------------------------------

def test_lockout_helpers_fail_open_when_redis_is_down(redis_broken):
    assert rate_limit.is_login_locked("a@t.co", "src") is False
    rate_limit.record_failed_login("a@t.co", "src")            # 不抛
    rate_limit.clear_failed_logins("a@t.co", "src")
    rate_limit.remember_login_source("a@t.co", "src")
    assert rate_limit.is_known_login_source("a@t.co", "src") is False
    assert rate_limit.is_mt5_verify_locked(700001) is False
    rate_limit.record_failed_mt5_verify(700001)
    rate_limit.clear_failed_mt5_verify(700001)


def test_lockout_still_locks_when_redis_is_healthy(redis_on):
    max_attempts, _ = rate_limit._POLICIES["mt5_verify"]
    for _ in range(max_attempts):
        rate_limit.record_failed_mt5_verify(700002)
    assert rate_limit.is_mt5_verify_locked(700002) is True


# ---------------------------------------------------------------------------
# 10. gamification 的「只是缓存」/ gamification caches that must not 500
# ---------------------------------------------------------------------------

def test_judge_throttle_degrades_towards_doing_less(redis_broken):
    from app.routers import gamification

    # Redis 读失败视为「刚判定过」：跳过，而不是每个 /me 都去跑判定与发勋章的重查询
    assert gamification._judge_due("u1", 1.0) is False


def test_judge_throttle_runs_once_per_window(redis_off):
    from app.routers import gamification

    assert gamification._judge_due("u1", 1.0) is True
    assert gamification._judge_due("u1", 2.0) is False


def test_judge_claim_write_failure_still_judges_once(monkeypatch, redis_off):
    from app.routers import gamification

    def boom(*a, **kw):
        raise ConnectionError("down")

    monkeypatch.setattr(gamification.shared_state, "kv_set", boom)
    assert gamification._judge_due("u1", 1.0) is True


def test_winrate_summary_and_profile_stats_survive_a_redis_outage(db_session, redis_broken, monkeypatch):
    from app.routers import gamification

    user = _mk_user(db_session)
    payload = gamification.build_winrate_summary_payload(db_session, user)     # 不抛
    assert isinstance(payload, dict)

    monkeypatch.setattr(
        gamification, "compute_comprehensive_stats",
        lambda db, uid: {"win_rate": 0.5, "window_days": 30, "trades": 4},
    )
    target = types.SimpleNamespace(id="t1", public_id="pub1")
    assert gamification._profile_stats(db_session, target) == {"winRate": 0.5, "windowDays": 30, "trades": 4}


def test_gamification_caches_live_in_shared_cache_namespace(db_session, redis_on, monkeypatch):
    from app.routers import gamification

    monkeypatch.setattr(
        gamification, "compute_comprehensive_stats",
        lambda db, uid: {"win_rate": 0.5, "window_days": 30, "trades": 4},
    )
    target = types.SimpleNamespace(id="t1", public_id="pub1")
    gamification._profile_stats(db_session, target)
    assert "prismx:rc:profile-stats:pub1" in redis_on.kv          # rc: 前缀，clear_for_tests 一把能清


# ---------------------------------------------------------------------------
# 11. 同步 Redis 客户端 retry / 池上限 / sync client hardening
# ---------------------------------------------------------------------------

def test_sync_client_is_a_bounded_blocking_pool_with_retry_and_health_check(monkeypatch):
    import redis

    monkeypatch.setattr(settings, "REDIS_URL", "redis://127.0.0.1:1/0")
    shared_state.reset_for_tests()
    try:
        client = shared_state._redis()
        pool = client.connection_pool
        assert isinstance(pool, redis.BlockingConnectionPool)
        assert pool.max_connections == shared_state.SYNC_REDIS_MAX_CONNECTIONS >= 256 + 64
        assert pool.timeout == shared_state.SYNC_REDIS_POOL_TIMEOUT_SECONDS
        kwargs = pool.connection_kwargs
        assert kwargs["socket_timeout"] == 2.0 and kwargs["socket_connect_timeout"] == 2.0
        assert kwargs["health_check_interval"] == 30
        conn = pool.make_connection()
        assert conn.retry._retries == 1
    finally:
        shared_state.reset_for_tests()


def test_retry_covers_connection_errors_only_never_timeouts():
    from redis.exceptions import ConnectionError as RedisConnectionError
    from redis.exceptions import TimeoutError as RedisTimeoutError

    retry = shared_state.redis_retry(1)

    def attempts(exc):
        calls = []

        def do():
            calls.append(1)
            raise exc

        with pytest.raises(type(exc)):
            retry.call_with_retry(do, lambda e: None)
        return len(calls)

    assert attempts(RedisConnectionError("cut")) == 2          # 1 次重试
    assert attempts(RedisTimeoutError("slow")) == 1            # 超时不重试：别把 2 秒卡顿变 6 秒


def test_async_retry_flavour_is_also_connection_errors_only():
    from redis.asyncio.retry import Retry
    from redis.exceptions import ConnectionError as RedisConnectionError

    retry = shared_state.redis_retry(1, async_client=True)
    assert isinstance(retry, Retry) and retry._supported_errors == (RedisConnectionError,)


# ---------------------------------------------------------------------------
# 4/5/6/12. main.py 与 database.py / process-level settings
# ---------------------------------------------------------------------------

def test_slowapi_middleware_is_gone_but_limiting_and_the_429_handler_stay():
    from slowapi.errors import RateLimitExceeded

    from app import main
    from fastapi.middleware.gzip import GZipMiddleware

    names = [m.cls.__name__ for m in main.app.user_middleware]
    assert "SlowAPIMiddleware" not in names
    assert GZipMiddleware.__name__ in names                    # 压缩仍在
    assert RateLimitExceeded in main.app.exception_handlers    # 429 处理器仍在
    # 不比较对象身份：test_limiter_shared_storage 会 reload rate_limit / strategy_limits，
    # 换掉模块里的实例；这里只确认两个限流器都还挂在 app.state 上（端点装饰器靠它读 429 头）。
    from slowapi import Limiter
    assert isinstance(main.app.state.limiter, Limiter)
    assert isinstance(main.app.state.user_limiter, Limiter)


def test_pool_timeout_maps_to_503_with_retry_after():
    from sqlalchemy.exc import TimeoutError as SAPoolTimeout

    from app import main

    handler = main.app.exception_handlers[SAPoolTimeout]
    request = types.SimpleNamespace(method="GET", url=types.SimpleNamespace(path="/api/x"))
    resp = _run(handler(request, SAPoolTimeout("QueuePool limit reached")))
    assert resp.status_code == 503 and resp.headers["retry-after"] == "2"
    assert "detail" in json.loads(resp.body)


def test_engine_kwargs_carry_pool_timeout_and_lifo_for_real_pools_only():
    from app.core import database

    assert settings.DB_POOL_TIMEOUT == 8
    pg = database._make_engine_kwargs(False)
    assert pg["pool_timeout"] == settings.DB_POOL_TIMEOUT and pg["pool_use_lifo"] is True
    assert pg["pool_pre_ping"] is True
    sqlite = database._make_engine_kwargs(True)
    assert "pool_timeout" not in sqlite and "pool_use_lifo" not in sqlite   # SQLite 不用 QueuePool


def _fake_resource(soft, hard, fail_set=None):
    calls = []
    mod = types.ModuleType("resource")
    mod.RLIMIT_NOFILE = 7
    mod.RLIM_INFINITY = -1
    state = {"limits": (soft, hard)}

    def getrlimit(which):
        return state["limits"]

    def setrlimit(which, limits):
        if fail_set:
            raise fail_set
        calls.append(limits)
        state["limits"] = limits

    mod.getrlimit, mod.setrlimit = getrlimit, setrlimit
    return mod, calls


@pytest.mark.parametrize("soft,hard,expected", [
    (1024, 524288, (65536, 524288)),        # systemd 默认：软 1024 抬到 65536
    (1024, -1, (65536, -1)),                # 硬上限无限：取 65536
    (1024, 4096, (4096, 4096)),             # 硬上限只有 4096：抬到硬上限
])
def test_nofile_soft_limit_is_raised_to_the_hard_limit_capped_at_65536(monkeypatch, soft, hard, expected):
    from app import main

    mod, calls = _fake_resource(soft, hard)
    monkeypatch.setitem(sys.modules, "resource", mod)
    main._raise_nofile_limit()
    assert calls == [expected]


def test_nofile_is_left_alone_when_already_high_or_unavailable(monkeypatch):
    from app import main

    mod, calls = _fake_resource(100000, 524288)
    monkeypatch.setitem(sys.modules, "resource", mod)
    main._raise_nofile_limit()
    assert calls == []
    monkeypatch.setitem(sys.modules, "resource", None)        # Windows：没有 resource 模块
    main._raise_nofile_limit()                                # 不抛
    mod, calls = _fake_resource(1024, 524288, fail_set=ValueError("nope"))
    monkeypatch.setitem(sys.modules, "resource", mod)
    main._raise_nofile_limit()                                # setrlimit 失败只记日志，不抛


# 已装的 websockets 新版会在 import websockets.legacy 时发弃用警告（uvicorn 0.30.6 仍在用它）。
# Newer websockets warns on `import websockets.legacy`, which uvicorn 0.30.6 still does.
@pytest.mark.filterwarnings("ignore:websockets.*deprecated:DeprecationWarning")
def test_websocket_deflate_window_is_shrunk_for_every_new_connection():
    from uvicorn.protocols.websockets import websockets_impl

    from app import main

    assert main._shrink_ws_deflate_window() is True
    factory = websockets_impl.ServerPerMessageDeflateFactory()      # uvicorn 每条连接这样调用（无参）
    assert factory.server_max_window_bits == main.WS_DEFLATE_WINDOW_BITS == 12
    assert factory.client_max_window_bits == 12
    assert factory.compress_settings == {"memLevel": main.WS_DEFLATE_MEM_LEVEL}
    # 幂等：再调一次不会把偏函数套第二层
    assert main._shrink_ws_deflate_window() is True
    assert isinstance(websockets_impl.ServerPerMessageDeflateFactory, __import__("functools").partial)
    assert websockets_impl.ServerPerMessageDeflateFactory.func.__name__ == "ServerPerMessageDeflateFactory"
