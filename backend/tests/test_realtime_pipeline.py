"""实时推送链路的事件循环卫生与吞吐（2026-09-25）。

钉住的几件事，任何一件退回去，症状都是「Redis / 数据库 / 推送服务一慢，全站 WebSocket
跟着卡」，而且不会有任何报错：

  1. EA 行情写入（quotes_store.update / chart_store.merge_bars）的 Redis 往返次数与
     批量大小无关，且在 async 接口里经线程池跑；「只推变化的报价」「首次出现顺序」
     语义不变，并发首次写入留下的重复项读侧去重。
  2. 跨进程转发：信封先写目标，不在本进程的消息不解析 message；多目标一次 publish；
     老格式照样能处理；同一条广播只序列化一次。
  3. 有 redis.asyncio 客户端时 publish / 在线名单直接在事件循环上 await，不占线程；
     Redis 不可达时退回本地投递。阻塞调用走 anyio 的大线程池而不是 asyncio 默认
     executor。
  4. 按等级过滤的新信号：查库离开事件循环，整组一次 push_to_users；到期揭晓整轮只查一次。
  5. 信号 webhook 不再等推送发完才返回；推送失败不影响响应。
  6. Web Push：带超时、有界并发、发送阶段不持有数据库会话、单条异常不拖垮整批。
  7. 连不上网关（请求根本没发出）与「结果未知」分开：前者 REJECTED「未发出、可重试」。

Event-loop hygiene and throughput of the realtime push pipeline.
"""
import asyncio
import inspect
import json
import threading
import time
from types import SimpleNamespace

import httpx
import pytest

from app.core.config import settings
from app.services import chart_store, connection_manager as cm, quotes_store, shared_state
from app.services.connection_manager import ConnectionManager
from tests.fake_redis import AsyncFakeRedis, FakeRedis


_COUNTED_COMMANDS = (
    "get", "set", "hget", "hset", "hgetall", "rpush", "lrange", "llen", "lindex",
    "lset", "ltrim", "publish", "zadd", "zrangebyscore", "zremrangebyscore",
)


class CountingRedis(FakeRedis):
    """数往返：顶层命令各算一次，pipeline 整体执行算一次（里面的命令不再单独算）。
    Counts round-trips: each top-level command is one, a pipeline execute is one."""

    def __init__(self) -> None:
        super().__init__()
        self.round_trips = 0
        self._in_pipeline = False

    def pipeline(self):
        outer = self
        pipe = super().pipeline()
        real_execute = pipe.execute

        def execute():
            outer.round_trips += 1
            outer._in_pipeline = True
            try:
                return real_execute()
            finally:
                outer._in_pipeline = False

        pipe.execute = execute
        return pipe


def _counted(name):
    base = getattr(FakeRedis, name)

    def method(self, *a, **kw):
        if not self._in_pipeline:
            self.round_trips += 1
        return base(self, *a, **kw)

    return method


for _name in _COUNTED_COMMANDS:
    setattr(CountingRedis, _name, _counted(_name))


@pytest.fixture()
def redis_on(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    fake = CountingRedis()
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


class _Sock:
    def __init__(self):
        self.sent = []
        self.texts = []

    async def send_json(self, m):
        self.sent.append(m)

    async def send_text(self, text):
        self.texts.append(text)
        self.sent.append(json.loads(text))


def _q(sym, bid, ask=None, **kw):
    return {"symbol": sym, "bid": bid, "ask": ask if ask is not None else bid + 0.1, **kw}


# ---------------------------------------------------------------------------
# 1. 行情缓存 / market stores
# ---------------------------------------------------------------------------

def test_quotes_update_round_trips_do_not_grow_with_the_batch(redis_on):
    """7 个品种以前是 21+ 次往返；现在固定两次（HGETALL + 一个 pipeline）。"""
    batch = [_q(f"SYM{i}", 1.0 + i) for i in range(7)]
    redis_on.round_trips = 0
    quotes_store.update(batch)
    assert redis_on.round_trips == 2
    redis_on.round_trips = 0
    quotes_store.update([_q(f"SYM{i}", 2.0 + i) for i in range(7)])
    assert redis_on.round_trips == 2


def test_quotes_update_keeps_change_detection_and_first_seen_order(redis_on):
    assert [q["symbol"] for q in quotes_store.update([_q("XAUUSD", 1.0), _q("EURUSD", 1.0)])] == ["XAUUSD", "EURUSD"]
    # 没变的不推，变了的推 / unchanged is dropped, changed is returned
    changed = quotes_store.update([_q("XAUUSD", 1.0), _q("EURUSD", 2.0), _q("GBPUSD", 3.0)])
    assert [q["symbol"] for q in changed] == ["EURUSD", "GBPUSD"]
    assert [q["symbol"] for q in quotes_store.get_all()] == ["XAUUSD", "EURUSD", "GBPUSD"]
    assert quotes_store.get_active_symbols() == ["XAUUSD", "EURUSD", "GBPUSD"]
    # closed 翻转算变化 / a closed flip is a change
    assert len(quotes_store.update([_q("XAUUSD", 1.0, closed=True)])) == 1
    # 同一批里重复的品种：第二次跟第一次比 / a repeat within one batch compares to the first
    changed = quotes_store.update([_q("USDJPY", 1.0), _q("USDJPY", 1.0), _q("USDJPY", 5.0)])
    assert [q["bid"] for q in changed] == [1.0, 5.0]
    assert redis_on.lists["prismx:quotes:order"].count("USDJPY") == 1


def test_quotes_order_list_duplicates_from_concurrent_first_writes_are_ignored(redis_on):
    """两个 worker 同时第一次见到同一个品种会各 rpush 一次：读侧按首次出现去重。"""
    quotes_store.update([_q("XAUUSD", 1.0), _q("EURUSD", 1.0)])
    redis_on.rpush("prismx:quotes:order", "XAUUSD")        # 模拟另一个 worker 的重复写入
    assert [q["symbol"] for q in quotes_store.get_all()] == ["XAUUSD", "EURUSD"]
    assert quotes_store.get_active_symbols() == ["XAUUSD", "EURUSD"]


def test_quotes_memory_path_unchanged(redis_off):
    assert len(quotes_store.update([_q("XAUUSD", 1.0), _q("EURUSD", 1.0)])) == 2
    assert quotes_store.update([_q("XAUUSD", 1.0)]) == []
    assert [q["symbol"] for q in quotes_store.get_all()] == ["XAUUSD", "EURUSD"]


def _bars(ts, c=1):
    return [{"t": t, "o": 1, "h": 2, "l": 0, "c": c, "v": 1} for t in ts]


def test_chart_merge_round_trips_do_not_grow_with_the_bars(redis_on):
    chart_store.replace_series("XAUUSD", "1", _bars(range(10)))
    redis_on.round_trips = 0
    chart_store.merge_bars("XAUUSD", "1", _bars([9, 10, 11, 12], c=7))
    assert redis_on.round_trips == 2          # LINDEX + 一个 pipeline
    got = chart_store.get_latest("XAUUSD", "1", n=5)
    assert [(b["t"], b["c"]) for b in got["bars"]] == [(8, 1), (9, 7), (10, 7), (11, 7), (12, 7)]
    redis_on.round_trips = 0
    chart_store.get_latest("XAUUSD", "1")
    assert redis_on.round_trips == 1          # lrange + get 合成一次


def _old_redis_merge(r, k, bars):
    """改动前 merge_bars 的 Redis 分支原样照抄（逐根 lindex + lset/rpush），作为对照组。
    The pre-change Redis branch, verbatim, as the reference implementation."""
    if r.llen(k) == 0:
        return
    for b in bars:
        last_raw = r.lindex(k, -1)
        last_t = json.loads(last_raw)["t"] if last_raw else None
        body = json.dumps(b, default=str)
        if last_t is not None and b["t"] == last_t:
            r.lset(k, -1, body)
        elif last_t is None or b["t"] > last_t:
            r.rpush(k, body)
        else:
            continue
    r.ltrim(k, -chart_store.MAX_BARS, -1)


@pytest.mark.parametrize("tick", [
    [9], [10], [9, 10], [10, 10], [5, 10], [9, 9, 11], [3], [11, 10, 12], [9, 10, 10, 11],
])
def test_chart_merge_redis_matches_the_old_per_bar_algorithm(monkeypatch, tick):
    """批量化之后逐字节等价于原来的逐根算法（含同一批里重复时间戳「后者覆盖」的行为）。
    After batching, byte-for-byte identical to the old per-bar algorithm."""
    base = _bars(range(10))
    incoming = [{"t": t, "o": 1, "h": 2, "l": 0, "c": 100 + i, "v": 1} for i, t in enumerate(tick)]
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    old, new = FakeRedis(), FakeRedis()
    try:
        shared_state.reset_for_tests(old)
        chart_store.replace_series("M", "1", base)
        _old_redis_merge(old, "prismx:chart:M:1", incoming)
        shared_state.reset_for_tests(new)
        chart_store.replace_series("M", "1", base)
        chart_store.merge_bars("M", "1", incoming)
    finally:
        shared_state.reset_for_tests()
    assert new.lists["prismx:chart:M:1"] == old.lists["prismx:chart:M:1"]


def test_chart_merge_without_baseline_is_dropped(redis_on):
    chart_store.merge_bars("NOPE", "1", _bars([1]))
    assert chart_store.get_latest("NOPE", "1")["bars"] == []
    assert "prismx:chart:NOPE:1" not in redis_on.lists


def test_store_async_wrappers_offload_only_with_redis(redis_on):
    loop_ids, ran_on = {}, []
    real = redis_on.hgetall

    def spy(key):
        ran_on.append(threading.get_ident())
        return real(key)

    redis_on.hgetall = spy

    async def scenario():
        loop_ids["id"] = threading.get_ident()
        await quotes_store.update_async([_q("XAUUSD", 1.0)])
        await quotes_store.get_all_async()
        await quotes_store.get_active_symbols_async()
        await chart_store.replace_series_async("XAUUSD", "1", _bars(range(3)))
        await chart_store.merge_bars_async("XAUUSD", "1", _bars([3]))
        return await chart_store.get_latest_async("XAUUSD", "1")

    got = asyncio.run(scenario())
    assert [b["t"] for b in got["bars"]] == [2, 3]
    assert ran_on and loop_ids["id"] not in ran_on


def test_store_async_wrappers_stay_inline_without_redis(redis_off, monkeypatch):
    hops = []

    async def counting(fn, *a, **kw):
        hops.append(fn)
        return fn(*a, **kw)

    monkeypatch.setattr(quotes_store, "run_in_threadpool", counting)
    monkeypatch.setattr(chart_store, "run_in_threadpool", counting)

    async def scenario():
        await quotes_store.update_async([_q("XAUUSD", 1.0)])
        await quotes_store.get_all_async()
        await chart_store.replace_series_async("XAUUSD", "1", _bars(range(3)))
        await chart_store.merge_bars_async("XAUUSD", "1", _bars([3]))
        await chart_store.get_latest_async("XAUUSD", "1")

    asyncio.run(scenario())
    assert hops == []


def test_chart_history_is_a_sync_endpoint():
    """chart_history 同步查库（最多 1000 根）：必须是 def，让 FastAPI 放进线程池。"""
    from app.routers import chart

    assert not inspect.iscoroutinefunction(chart.chart_history)
    assert inspect.iscoroutinefunction(chart.chart_latest)


# ---------------------------------------------------------------------------
# 2. 转发消息格式 / fan-out wire format
# ---------------------------------------------------------------------------

def test_envelope_is_valid_json_with_the_target_first(redis_on):
    async def scenario():
        m = ConnectionManager()
        await m.push_to_client("u1", {"type": "ORDER_UPDATE", "data": {"名": 1}})
        await m.broadcast_to_clients({"type": "SIGNAL"})
        await m.push_to_users(["u1", "u2"], {"type": "SIGNAL_NEW"})

    asyncio.run(scenario())
    bodies = [b for _c, b in redis_on.published]
    assert bodies[0].startswith('{"user":"u1","message":')
    assert bodies[1].startswith('{"user":null,"message":')
    assert bodies[2].startswith('{"user":"*","users":["u1","u2"],"message":')
    # 仍是合法 JSON：老 worker 照样 json.loads / still valid JSON for old workers
    assert json.loads(bodies[0]) == {"user": "u1", "message": {"type": "ORDER_UPDATE", "data": {"名": 1}}}
    assert json.loads(bodies[2])["user"] == "*"


def test_non_local_target_is_dropped_without_parsing_the_message(redis_on, monkeypatch):
    """目标不在本进程：message 一个字节都不解析（这里把 json.loads 换成炸弹来证明）。"""
    async def scenario():
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)

        def boom(*a, **kw):
            raise AssertionError("message 不该被整条解析 / must not be fully parsed")

        big = {"type": "POSITIONS", "data": [{"ticket": i} for i in range(1000)]}
        frames = [
            cm._envelope("someone-else", cm._dumps(big)),
            cm._envelope(cm._MULTI_TARGET, cm._dumps(big), users=["x", "y"]),
            # 本地用户：原样发出 message 那段文本，同样不解析 / local: sent verbatim, unparsed
            cm._envelope("u1", cm._dumps({"type": "X"})),
        ]
        # 只换掉 connection_manager 看到的 json.loads（整条解析的唯一入口）。
        # Swap only the json.loads connection_manager sees (the full-parse entry point).
        monkeypatch.setattr(cm, "json", SimpleNamespace(loads=boom, dumps=json.dumps, JSONDecoder=json.JSONDecoder))
        for frame in frames:
            await m.handle_fanout_message(frame)
        return ws

    ws = asyncio.run(scenario())
    assert ws.texts == ['{"type":"X"}']


def test_multi_target_reaches_only_listed_local_users(redis_on):
    async def scenario():
        m = ConnectionManager()
        a, b, c = _Sock(), _Sock(), _Sock()
        await m.register_client("a", a)
        await m.register_client("b", b)
        await m.register_client("c", c)
        await m.push_to_users(["a", "c", "a", "remote"], {"type": "SIGNAL_NEW", "data": {"id": 1}})
        assert len(redis_on.published) == 1                     # 一次 publish / one publish
        await m.handle_fanout_message(redis_on.published[-1][1])
        return a, b, c

    a, b, c = asyncio.run(scenario())
    assert a.sent == [{"type": "SIGNAL_NEW", "data": {"id": 1}}]
    assert b.sent == []
    assert c.sent == [{"type": "SIGNAL_NEW", "data": {"id": 1}}]


def test_legacy_envelopes_are_still_handled(redis_on):
    """灰度期间老 worker 发的 {"from":…} 格式照常投递。"""
    async def scenario():
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)
        await m.handle_fanout_message(json.dumps({"from": "old-worker", "user": "u1", "message": {"type": "A"}}))
        await m.handle_fanout_message(json.dumps({"from": "old-worker", "user": None, "message": {"type": "B"}}))
        await m.handle_fanout_message(json.dumps({"from": "old-worker", "user": "u2", "message": {"type": "C"}}))
        await m.handle_fanout_message("not json")
        await m.handle_fanout_message('{"user":"u1","message":')      # 截断的新格式 / truncated
        return ws

    ws = asyncio.run(scenario())
    assert ws.sent == [{"type": "A"}, {"type": "B"}]


def test_push_to_users_without_redis_delivers_locally(redis_off):
    async def scenario():
        m = ConnectionManager()
        a, b = _Sock(), _Sock()
        await m.register_client("a", a)
        await m.register_client("b", b)
        await m.push_to_users(["a", "offline"], {"type": "S"})
        await m.push_to_users([], {"type": "never"})
        return a, b

    a, b = asyncio.run(scenario())
    assert a.sent == [{"type": "S"}] and b.sent == []


def test_broadcast_serializes_once(redis_off, monkeypatch):
    calls = []
    real = cm._dumps

    def counting(message):
        calls.append(message)
        return real(message)

    monkeypatch.setattr(cm, "_dumps", counting)

    async def scenario():
        m = ConnectionManager()
        socks = [_Sock() for _ in range(5)]
        for i, s in enumerate(socks):
            await m.register_client(f"u{i}", s)
        await m.register_client("u0", _Sock())          # 同一用户第二个标签页 / second tab
        await m.broadcast_to_clients({"type": "GLOBAL_QUOTES", "data": [1, 2, 3]})
        return socks

    socks = asyncio.run(scenario())
    assert len(calls) == 1
    assert all(s.sent == [{"type": "GLOBAL_QUOTES", "data": [1, 2, 3]}] for s in socks)


def test_local_frames_match_starlette_send_json_text(redis_off):
    """send_text 发出去的文本与 starlette 的 send_json 逐字节相同（紧凑、不转义中文）。"""
    msg = {"type": "PUSH_FALLBACK", "data": {"title": "新信号", "n": 1.5}}
    assert cm._dumps(msg) == json.dumps(msg, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# 3. redis.asyncio 路径与线程池 / async redis path and the thread pool
# ---------------------------------------------------------------------------

def _no_thread_hops(monkeypatch):
    hops = []
    real = cm.anyio.to_thread.run_sync

    async def counting(fn, *a, **kw):
        hops.append(fn)
        return await real(fn, *a, **kw)

    monkeypatch.setattr(cm.anyio.to_thread, "run_sync", counting)
    return hops


def test_async_client_publishes_on_the_loop_without_a_thread(redis_on, monkeypatch):
    hops = _no_thread_hops(monkeypatch)
    aio = AsyncFakeRedis(redis_on)

    async def scenario():
        cm._install_async_redis(aio)
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)                     # zadd 走异步客户端
        await m.push_to_client("u1", {"type": "ORDER_UPDATE"})
        await m.push_to_users(["u1", "u2"], {"type": "SIGNAL_NEW"})
        roster = await m.connected_user_ids_async()
        return ws, roster

    ws, roster = asyncio.run(scenario())
    assert hops == [], "有异步客户端时不该再跳线程 / no thread hop with the async client"
    assert aio.commands.count("publish") == 2 and "zadd" in aio.commands and "pipeline" in aio.commands
    assert roster == ["u1"]
    assert ws.sent == []                                     # 发布了，没本地直发
    assert "u1" in redis_on.zsets["prismx:ws:users"]


def test_async_client_failure_falls_back_to_local_delivery(redis_on):
    async def scenario():
        cm._install_async_redis(AsyncFakeRedis(redis_on, fail=True))
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)
        await m.push_to_client("u1", {"type": "A"})
        await m.push_to_users(["u1", "u2"], {"type": "B"})
        await m.broadcast_to_clients({"type": "C"})
        roster = await m.connected_user_ids_async()
        return ws, roster

    ws, roster = asyncio.run(scenario())
    assert ws.sent == [{"type": "A"}, {"type": "B"}, {"type": "C"}]
    assert roster == ["u1"]                                  # 只剩本进程的 / local only


def test_async_client_bound_to_another_loop_is_not_used(redis_on):
    """客户端绑定在建它的事件循环上；别的循环（asyncio.run 退回的场景）走线程池老路径。"""
    aio = AsyncFakeRedis(redis_on)
    other = asyncio.new_event_loop()
    cm._install_async_redis(aio, loop=other)

    async def scenario():
        m = ConnectionManager()
        await m.push_to_client("u1", {"type": "A"})

    try:
        asyncio.run(scenario())
    finally:
        other.close()
    assert aio.commands == []
    assert len(redis_on.published) == 1                      # 同步客户端发的 / via the sync client


def test_test_double_in_shared_state_never_builds_an_async_client(redis_on):
    async def scenario():
        m = ConnectionManager()
        tasks = m.start_cross_worker_tasks()
        try:
            return [t.get_name() for t in tasks], cm._aredis_client
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    names, client = asyncio.run(scenario())
    assert "ws:aredis" not in names and client is None


def test_async_client_is_closed_when_its_holder_task_is_cancelled(redis_on):
    aio = AsyncFakeRedis(redis_on)

    async def scenario():
        cm._install_async_redis(aio)
        task = asyncio.create_task(cm._hold_async_redis())
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
    assert aio.closed and cm._aredis_client is None


def test_blocking_calls_use_the_anyio_pool(redis_on, monkeypatch):
    """没有异步客户端时，同步 Redis 调用走 anyio 的线程池（main.py 调到 256 条），
    而不是 asyncio 默认 executor（2 核机器上只有 6 条）。"""
    hops = _no_thread_hops(monkeypatch)

    def no_default_executor(*a, **kw):
        raise AssertionError("不该走 asyncio.to_thread / must not use asyncio.to_thread")

    monkeypatch.setattr(asyncio, "to_thread", no_default_executor)

    async def scenario():
        m = ConnectionManager()
        await m.register_client("u1", _Sock())
        await m.push_to_client("u1", {"type": "A"})
        return await m.connected_user_ids_async()

    assert asyncio.run(scenario()) == ["u1"]
    assert len(hops) >= 3


def test_background_supervisor_takes_the_lock_off_the_loop(redis_on):
    from app.services import background

    loop_ids, ran_on = {}, []
    real = shared_state.try_lock

    def spy(*a, **kw):
        ran_on.append(threading.get_ident())
        return real(*a, **kw)

    async def forever():
        while True:
            await asyncio.sleep(3600)

    async def scenario():
        loop_ids["id"] = threading.get_ident()
        loops = background.BackgroundLoops({"x": forever}, owner="worker-A")
        shared_state.try_lock = spy
        try:
            held = await loops.poll_async()
        finally:
            shared_state.try_lock = real
        running = loops.running
        loops.shutdown()
        return held, running

    held, running = asyncio.run(scenario())
    assert held is True and running == ["x"]
    assert ran_on and loop_ids["id"] not in ran_on


# ---------------------------------------------------------------------------
# 4. 按等级过滤的信号广播 / plan-filtered signal broadcast
# ---------------------------------------------------------------------------

@pytest.fixture()
def plan_db(monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models import User
    from app.services import signal_broadcast as sb

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    db = maker()
    for uid, plan in [("pro1", "PRO"), ("pro2", "PRO"), ("free1", "FREE"), ("free2", "FREE")]:
        db.add(User(id=uid, email=f"{uid}@t.co", password_hash="x", api_token=f"tok-{uid}", plan=plan))
    db.commit()
    db.close()
    monkeypatch.setattr(sb, "SessionLocal", maker)
    yield sb
    engine.dispose()


class _FakeManager:
    def __init__(self, online):
        self.online = list(online)
        self.pushes = []
        self.roster_reads = 0

    async def connected_user_ids_async(self):
        self.roster_reads += 1
        return list(self.online)

    def connected_user_ids(self):
        raise AssertionError("协程里不该读同步名单 / sync roster read from a coroutine")

    async def push_to_users(self, user_ids, message):
        self.pushes.append((sorted(user_ids), message))

    async def push_to_client(self, user_id, message):
        raise AssertionError("应整组一次推送 / should push the group in one call")


def test_realtime_broadcast_queries_off_the_loop_and_pushes_once(plan_db, monkeypatch):
    sb = plan_db
    fake = _FakeManager(["pro1", "pro2", "free1"])
    monkeypatch.setattr(sb, "manager", fake)
    loop_ids, ran_on = {}, []
    real = sb._plan_group_user_ids

    def spy(*a, **kw):
        ran_on.append(threading.get_ident())
        return real(*a, **kw)

    monkeypatch.setattr(sb, "_plan_group_user_ids", spy)

    async def scenario():
        loop_ids["id"] = threading.get_ident()
        await sb.broadcast_signal_new_realtime({"id": "s1"})

    asyncio.run(scenario())
    assert fake.pushes == [(["pro1", "pro2"], {"type": "SIGNAL_NEW", "data": {"id": "s1"}})]
    assert ran_on and loop_ids["id"] not in ran_on


def test_free_tier_reveal_looks_up_the_roster_once_per_round(plan_db, monkeypatch):
    sb = plan_db
    fake = _FakeManager(["pro1", "free1", "free2"])
    monkeypatch.setattr(sb, "manager", fake)
    queries = []
    real = sb._plan_group_user_ids
    monkeypatch.setattr(sb, "_plan_group_user_ids", lambda *a, **kw: queries.append(1) or real(*a, **kw))

    asyncio.run(sb.broadcast_signals_new_free_tier([{"id": "a"}, {"id": "b"}, {"id": "c"}]))
    assert fake.roster_reads == 1 and len(queries) == 1
    assert [p[0] for p in fake.pushes] == [["free1", "free2"]] * 3
    assert [p[1]["data"]["id"] for p in fake.pushes] == ["a", "b", "c"]


def test_nobody_online_means_no_query(plan_db, monkeypatch):
    sb = plan_db
    fake = _FakeManager([])
    monkeypatch.setattr(sb, "manager", fake)
    monkeypatch.setattr(sb, "_plan_group_user_ids", lambda *a, **kw: pytest.fail("不该查库"))
    asyncio.run(sb.broadcast_signal_new_realtime({"id": "s1"}))
    asyncio.run(sb.broadcast_signals_new_free_tier([{"id": "s1"}]))
    assert fake.pushes == []


# ---------------------------------------------------------------------------
# 5. webhook 不等推送 / webhook doesn't wait for the fan-out
# ---------------------------------------------------------------------------

def test_webhook_fan_out_runs_after_the_response_and_swallows_failures(monkeypatch):
    import app.routers.webhook as wh

    order = []

    async def broadcast(data):
        order.append("broadcast")
        raise RuntimeError("redis down")

    async def push(sig):
        order.append("push")
        raise RuntimeError("push down")

    monkeypatch.setattr(wh, "broadcast_signal_new_realtime", broadcast)
    monkeypatch.setattr(wh, "dispatch_push_async", push)
    # 两步都炸也不抛；WS 广播失败不影响 Web Push / neither failure escapes, and push still runs
    asyncio.run(wh._fan_out_new_signal({"id": "s1"}, object()))
    assert order == ["broadcast", "push"]

    for fn in (wh.tradingview_webhook, wh.mt5_signal_webhook):
        assert "background_tasks" in inspect.signature(fn).parameters


def test_webhook_responds_before_the_fan_out_finishes(monkeypatch, tmp_path):
    """响应先出去、推送在后台跑：用一个「推送卡住」的替身证明响应不等它。"""
    import app.routers.webhook as wh
    from fastapi import FastAPI
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base

    engine = create_engine(f"sqlite:///{tmp_path / 'wh.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    monkeypatch.setattr(wh, "SessionLocal", sessionmaker(bind=engine, autocommit=False, autoflush=False))
    monkeypatch.setattr(wh.settings, "EA_TOKEN", "ea-token")
    monkeypatch.setattr(wh.limiter, "enabled", False)

    events = []

    async def slow_broadcast(data):
        events.append(("fanout-start", time.monotonic()))
        await asyncio.sleep(0.3)
        events.append(("fanout-end", time.monotonic()))

    async def push(sig):
        return None

    monkeypatch.setattr(wh, "broadcast_signal_new_realtime", slow_broadcast)
    monkeypatch.setattr(wh, "dispatch_push_async", push)
    app = FastAPI()
    app.include_router(wh.router)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            # ASGITransport 会等整个 ASGI 调用（含后台任务）结束才返回，所以这里看的是
            # 响应体发出的时刻：它必须早于后台推送结束。
            sent_at = {}
            real_send = None

            async def app_wrapper(scope, receive, send):
                async def spy_send(msg):
                    if msg["type"] == "http.response.body" and not msg.get("more_body"):
                        sent_at["t"] = time.monotonic()
                    await send(msg)
                await app(scope, receive, spy_send)

            transport.app = app_wrapper
            r = await client.post("/webhook/mt5-signal", json={
                "secret": "ea-token", "symbol": "XAUUSD", "side": "buy", "id": "BG-1",
            })
            return r, sent_at

    r, sent_at = asyncio.run(scenario())
    engine.dispose()
    assert r.status_code == 200 and r.json()["deduped"] is False
    end = dict(events)["fanout-end"]
    assert sent_at["t"] < end


# ---------------------------------------------------------------------------
# 6. Web Push 派发 / Web Push dispatch
# ---------------------------------------------------------------------------

def test_webpush_is_called_with_a_timeout(monkeypatch):
    from app.services import push_dispatch

    calls = []
    monkeypatch.setattr(push_dispatch, "webpush", lambda **kw: calls.append(kw))
    sub = SimpleNamespace(id="s", endpoint="https://fcm.googleapis.com/fcm/send/x", keys_p256dh="p", keys_auth="a")
    assert push_dispatch._webpush_one(sub, "{}", "pem", {"sub": "mailto:a@b.c"}, {}) == (True, False)
    assert calls[0]["timeout"] == push_dispatch._WEBPUSH_TIMEOUT == 10


def test_send_all_is_concurrent_but_bounded(monkeypatch):
    from app.services import push_dispatch

    lock = threading.Lock()
    state = {"now": 0, "peak": 0}

    def slow_send(sub, payload, pem, claims, headers):
        with lock:
            state["now"] += 1
            state["peak"] = max(state["peak"], state["now"])
        time.sleep(0.02)
        with lock:
            state["now"] -= 1
        return (sub.id != "bad", sub.id == "stale")

    monkeypatch.setattr(push_dispatch, "_send_one", slow_send)
    subs = [SimpleNamespace(id=f"s{i}") for i in range(40)] + [SimpleNamespace(id="stale"), SimpleNamespace(id="bad")]
    started = time.monotonic()
    results = push_dispatch._send_all(subs, "{}", "pem", {}, {})
    elapsed = time.monotonic() - started
    assert len(results) == len(subs)
    assert results[-2] == (True, True) and results[-1] == (False, False)
    assert 1 < state["peak"] <= push_dispatch._SEND_CONCURRENCY
    assert elapsed < 42 * 0.02                      # 比串行快 / faster than serial


def test_one_exploding_send_does_not_abort_the_batch(monkeypatch):
    from app.services import push_dispatch

    def send(sub, *a):
        if sub.id == "boom":
            raise TimeoutError("push service hung")      # 例如 requests.Timeout
        return True, False

    monkeypatch.setattr(push_dispatch, "_send_one", send)
    subs = [SimpleNamespace(id="a"), SimpleNamespace(id="boom"), SimpleNamespace(id="b")]
    assert push_dispatch._send_all(subs, "{}", "pem", {}, {}) == [(True, False), (False, False), (True, False)]


def test_dispatch_releases_the_db_session_before_sending(monkeypatch, db_session):
    """发送阶段不持有会话：订阅取完就关，失效订阅另开一个短会话删。"""
    from app.models import NotificationPref, PushSubscription, User
    from app.services import push_dispatch

    user = User(email="p@t.co", password_hash="x", api_token="tok-p", plan="PRO")
    db_session.add(user)
    db_session.commit()
    db_session.add(NotificationPref(user_id=user.id, enabled=True))
    for i in range(3):
        db_session.add(PushSubscription(
            user_id=user.id, endpoint=f"https://fcm.googleapis.com/fcm/send/{i}",
            keys_p256dh="p", keys_auth="a",
        ))
    db_session.commit()

    open_sessions = []

    class _Tracked:
        def __init__(self):
            self.closed = False
            open_sessions.append(self)

        def __getattr__(self, name):
            return getattr(db_session, name)

        def close(self):
            self.closed = True

    monkeypatch.setattr(push_dispatch, "SessionLocal", _Tracked)
    monkeypatch.setattr(type(push_dispatch.settings), "vapid_private_key", property(lambda self: "pem"))
    monkeypatch.setattr(push_dispatch.settings, "VAPID_PUBLIC_KEY", "pub", raising=False)
    monkeypatch.setattr(push_dispatch, "_ws_fallback", lambda *a, **kw: None)

    seen_open = []

    def send(sub, *a):
        seen_open.append(sum(1 for s in open_sessions if not s.closed))
        return (True, sub.endpoint.endswith("/1"))       # 第二条失效 / the second one is dead

    monkeypatch.setattr(push_dispatch, "_send_one", send)
    push_dispatch.dispatch_event_push(user.id, push_dispatch.EVENT_ORDER_FILLED, "t", "b")

    assert seen_open == [0, 0, 0], "发送时不该有打开的会话 / no session open while sending"
    remaining = sorted(s.endpoint for s in db_session.query(PushSubscription).all())
    assert remaining == ["https://fcm.googleapis.com/fcm/send/0", "https://fcm.googleapis.com/fcm/send/2"]
    assert all(s.closed for s in open_sessions)


# ---------------------------------------------------------------------------
# 7. 连不上网关 ≠ 结果未知 / "never connected" is not "outcome unknown"
# ---------------------------------------------------------------------------

class _RaisingClient:
    def __init__(self, exc):
        self.exc = exc

    async def post(self, url, json=None, headers=None, timeout=None):
        raise self.exc


@pytest.mark.parametrize("exc,expected", [
    (httpx.ConnectError("refused"), "connect_failed"),
    (httpx.ConnectTimeout("connect timed out"), "connect_failed"),
    (httpx.PoolTimeout("no free connection"), "connect_failed"),
    # 这些情况下请求可能已经发出：仍按「结果未知」/ the request may have gone out
    (httpx.ReadTimeout("read timed out"), "timeout"),
    (httpx.WriteTimeout("write timed out"), "timeout"),
    (httpx.RemoteProtocolError("server disconnected"), "request_failed"),
    (httpx.ReadError("connection reset"), "request_failed"),
    (httpx.WriteError("broken pipe"), "request_failed"),
])
def test_post_classifies_not_sent_vs_unknown(monkeypatch, exc, expected):
    import app.services.gateway_client as gc

    monkeypatch.setattr(gc, "_client", _RaisingClient(exc))
    monkeypatch.setattr(gc.settings, "GATEWAY_URL", "http://gw.test:8800")
    data = asyncio.run(gc._post("/trade/open", {"login": 1}, timeout=65.0))
    assert data["ok"] is False and data["error"] == expected


def _order(action="OPEN"):
    return SimpleNamespace(action=action, client_order_id="cid-1", status="PENDING", message="")


def _trade(**kw):
    from app.services.gateway_client import TradeRsp

    base = dict(ok=False, retcode="", message="", deal=0, order=0, price=0.0)
    base.update(kw)
    return TradeRsp(**base)


def test_connect_failure_is_rejected_as_not_sent():
    from app.services.gateway_execute import apply_trade_result

    order = _order()
    apply_trade_result(order, _trade(message="Gateway 连接失败，请求未发出", error="connect_failed"))
    assert order.status == "REJECTED"
    assert "未发出" in order.message and "可能已经执行" not in order.message


def test_unknown_outcome_is_still_failed():
    from app.services.gateway_execute import apply_trade_result

    for err in ("timeout", "request_failed"):
        order = _order()
        apply_trade_result(order, _trade(error=err, message="x"))
        assert order.status == "FAILED"


def test_connect_failure_is_not_re_asked(monkeypatch):
    import app.services.gateway_execute as ge

    calls = []

    async def call(timeout):
        calls.append(timeout)
        return _trade(error="connect_failed")

    monkeypatch.setattr(ge, "run_on_main_loop", lambda coro, timeout: asyncio.run(coro))
    rsp = ge.call_gateway_idempotent(_order(), call)
    assert rsp.error == "connect_failed" and calls == [ge.GATEWAY_TRADE_TIMEOUT]


def test_timeout_then_unreachable_reconcile_stays_unknown(monkeypatch):
    """第一问超时（可能已执行）、第二问连不上：仍是「结果未知」，绝不能落成「未发出」。"""
    import app.services.gateway_execute as ge

    answers = iter([_trade(error="timeout"), _trade(error="connect_failed")])

    async def call(timeout):
        return next(answers)

    monkeypatch.setattr(ge, "run_on_main_loop", lambda coro, timeout: asyncio.run(coro))
    rsp = ge.call_gateway_idempotent(_order(), call)
    assert rsp.retcode == "GATEWAY_TIMEOUT" and rsp.error == "timeout"
    order = _order()
    ge.apply_trade_result(order, rsp)
    assert order.status == "FAILED"


def test_trade_timeouts_are_unchanged():
    """下单时限是产品决定（dealer 60 / 后端 65 / 追问 75），这次改动不许碰。"""
    import app.services.gateway_execute as ge

    assert (ge.GATEWAY_TRADE_TIMEOUT, ge.GATEWAY_RECONCILE_TIMEOUT) == (65.0, 75.0)
