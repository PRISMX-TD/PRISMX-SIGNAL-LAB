"""多 worker 共享状态的落地点：登录 / MT5 验证锁定、回测闸门、/me 判定节流、
后台循环领导权、WebSocket 跨进程转发、EA 行情缓存。全部用 FakeRedis 模拟"两个
worker 共用一台 Redis"，钉住：一个进程写的另一个进程看得见、只有一个 worker 跑
循环、推送发布到频道而不是本地 socket、行情在两边一致。
Where the shared state lands: lockouts, the backtest gate, the /me throttle,
background-loop leadership, WS fan-out and the market stores, simulated with a
FakeRedis shared by "two workers".
"""
import asyncio
import json
import time

import pytest

from app.core import rate_limit, strategy_limits
from app.core.config import settings
from app.services import background, chart_store, quotes_store, shared_state
from app.services.connection_manager import ConnectionManager
from tests.fake_redis import FakeRedis


@pytest.fixture()
def redis_on(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    fake = FakeRedis()
    shared_state.reset_for_tests(fake)
    yield fake
    shared_state.reset_for_tests()


@pytest.fixture()
def redis_off(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


# ---- 锁定 / lockouts ----------------------------------------------------------

def test_lockout_shared_across_workers(redis_on):
    max_attempts, _ = rate_limit._POLICIES["mt5_verify"]
    for _ in range(max_attempts):
        rate_limit.record_failed_mt5_verify(700001)      # "worker A" 记的失败
    assert rate_limit.is_mt5_verify_locked(700001)        # "worker B" 读同一台 Redis
    assert redis_on.get("prismx:lockout:mt5_verify:700001") is not None
    rate_limit.clear_failed_mt5_verify(700001)
    assert not rate_limit.is_mt5_verify_locked(700001)


def test_lockout_entry_expires_after_quiet_spell(redis_off, monkeypatch):
    rate_limit.record_failed_login("a@t.co")
    _max, lockout = rate_limit._POLICIES["login"]
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + lockout + 2)
    assert rate_limit._read("login", "a@t.co") is None    # 阈值以下的计数安静一段时间后归零


# ---- 回测闸门 / backtest gate -------------------------------------------------

def test_backtest_gate_is_exclusive_and_releases(redis_on):
    with strategy_limits.backtest_gate("u1"):
        with pytest.raises(strategy_limits.BacktestBusy):
            with strategy_limits.backtest_gate("u1"):     # 同一用户第二个并发：拒
                pass
        with strategy_limits.backtest_gate("u2"):         # 别的用户不受影响
            pass
    with strategy_limits.backtest_gate("u1"):             # 释放后可再进
        pass


def test_backtest_gate_memory_backend(redis_off):
    with strategy_limits.backtest_gate("u1"):
        with pytest.raises(strategy_limits.BacktestBusy):
            with strategy_limits.backtest_gate("u1"):
                pass


# ---- 领导权 / leadership -------------------------------------------------------

async def _forever():
    while True:
        await asyncio.sleep(3600)


def test_only_one_worker_runs_loops_and_takeover(redis_on):
    async def scenario():
        a = background.BackgroundLoops({"x": _forever, "y": _forever}, owner="worker-A")
        b = background.BackgroundLoops({"x": _forever, "y": _forever}, owner="worker-B")
        assert a.poll() is True and a.running == ["x", "y"]
        assert b.poll() is False and b.running == []
        assert a.poll() is True                             # 续期 / renewal
        a.shutdown()                                        # A 下线，释放锁
        assert a.running == []
        assert b.poll() is True and b.running == ["x", "y"] # B 接管 / B takes over
        b.shutdown()
    asyncio.run(scenario())


def test_leader_lock_expires_when_holder_dies(redis_on, monkeypatch):
    async def scenario():
        a = background.BackgroundLoops({"x": _forever}, owner="worker-A")
        b = background.BackgroundLoops({"x": _forever}, owner="worker-B")
        assert a.poll() is True
        real = time.time
        monkeypatch.setattr(time, "time", lambda: real() + background.LOCK_TTL_SECONDS + 1)
        assert b.poll() is True                             # A 没续期，锁过期，B 接管
        assert a.poll() is False and a.running == []        # A 回来发现已丢，停掉自己的
        b.shutdown()
    asyncio.run(scenario())


def test_without_redis_loops_start_directly(redis_off):
    async def scenario():
        loops = background.BackgroundLoops({"x": _forever})
        loops.launch()
        assert loops.is_leader and loops.running == ["x"]
        loops.shutdown()
        assert loops.running == []
    asyncio.run(scenario())


# ---- WebSocket 转发 / fan-out --------------------------------------------------

class _Sock:
    def __init__(self):
        self.sent = []

    async def send_json(self, m):
        self.sent.append(m)


def test_push_publishes_instead_of_local_send(redis_on):
    async def scenario():
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)
        await m.push_to_client("u1", {"type": "ORDER_UPDATE"})
        assert ws.sent == []                                # 本地没直接发 / not sent locally
        assert len(redis_on.published) == 1
        channel, body = redis_on.published[0]
        assert channel == "prismx:ws"
        data = json.loads(body)
        assert data["user"] == "u1" and data["message"] == {"type": "ORDER_UPDATE"}
        # 订阅协程收到同一条后投递到本进程的 socket / the subscriber delivers it locally
        await m.handle_fanout_message(body)
        assert ws.sent == [{"type": "ORDER_UPDATE"}]
        # 广播：user=None，所有本地用户都收到 / broadcast reaches every local user
        await m.broadcast_to_clients({"type": "SIGNAL"})
        await m.handle_fanout_message(redis_on.published[-1][1])
        assert ws.sent[-1] == {"type": "SIGNAL"}
        # 不是本进程的用户：忽略，不报错 / a user on another worker is ignored
        await m.handle_fanout_message(json.dumps({"user": "someone-else", "message": {"type": "X"}}))
        assert len(ws.sent) == 2
    asyncio.run(scenario())


def test_presence_merges_other_workers(redis_on):
    async def scenario():
        a = ConnectionManager()
        b = ConnectionManager()
        await a.register_client("u1", _Sock())
        await b.register_client("u2", _Sock())
        assert sorted(a.connected_user_ids()) == ["u1", "u2"]   # 看得到连在 B 的 u2
        assert sorted(b.connected_user_ids()) == ["u1", "u2"]
    asyncio.run(scenario())


def test_without_redis_push_is_local(redis_off):
    async def scenario():
        m = ConnectionManager()
        ws = _Sock()
        await m.register_client("u1", ws)
        await m.push_to_client("u1", {"type": "X"})
        assert ws.sent == [{"type": "X"}]
        assert m.connected_user_ids() == ["u1"]
        assert m.start_cross_worker_tasks() == []
    asyncio.run(scenario())


# ---- 行情缓存 / market stores --------------------------------------------------

def test_quotes_store_shared_and_ordered(redis_on):
    changed = quotes_store.update([
        {"symbol": "XAUUSD", "bid": 1.0, "ask": 1.1, "digits": 2},
        {"symbol": "EURUSD", "bid": 1.0, "ask": 1.1, "digits": 5},
    ])
    assert [q["symbol"] for q in changed] == ["XAUUSD", "EURUSD"]
    assert quotes_store.update([{"symbol": "XAUUSD", "bid": 1.0, "ask": 1.1, "digits": 2}]) == []   # 没变
    assert [q["symbol"] for q in quotes_store.get_all()] == ["XAUUSD", "EURUSD"]        # 首次出现的顺序
    assert quotes_store.get_active_symbols() == ["XAUUSD", "EURUSD"]
    assert quotes_store.get_digits("EURUSD") == 5 and quotes_store.get_digits("NOPE") is None
    # closed 翻转也算变化 / a closed flip counts as a change
    assert len(quotes_store.update([{"symbol": "XAUUSD", "bid": 1.0, "ask": 1.1, "digits": 2, "closed": True}])) == 1


def test_quotes_active_window(redis_on, monkeypatch):
    quotes_store.update([{"symbol": "XAUUSD", "bid": 1.0, "ask": 1.1}])
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + quotes_store.ACTIVE_WINDOW_SECONDS + 1)
    assert quotes_store.get_active_symbols() == []


def test_chart_store_shared_replace_merge_latest(redis_on):
    bars = [{"t": t, "o": 1, "h": 2, "l": 0, "c": 1, "v": 1} for t in range(10)]
    chart_store.replace_series("XAUUSD", "15", bars)
    got = chart_store.get_latest("XAUUSD", "15", n=2)
    assert [b["t"] for b in got["bars"]] == [8, 9] and got["updatedAt"] is not None
    chart_store.merge_bars("XAUUSD", "15", [{"t": 9, "o": 1, "h": 2, "l": 0, "c": 5, "v": 1}, {"t": 10, "o": 1, "h": 2, "l": 0, "c": 1, "v": 1}])
    got = chart_store.get_latest("XAUUSD", "15", n=3)
    assert [(b["t"], b["c"]) for b in got["bars"]] == [(8, 1), (9, 5), (10, 1)]
    chart_store.merge_bars("EURUSD", "15", [{"t": 1, "o": 1, "h": 1, "l": 1, "c": 1, "v": 0}])   # 没基线：丢弃
    assert chart_store.get_latest("EURUSD", "15")["bars"] == []
    big = [{"t": t, "o": 1, "h": 1, "l": 1, "c": 1, "v": 0} for t in range(chart_store.MAX_BARS + 50)]
    chart_store.replace_series("XAUUSD", "1", big)
    assert redis_on.llen("prismx:chart:XAUUSD:1") == chart_store.MAX_BARS


def test_chart_store_memory_path_unchanged(redis_off):
    chart_store.replace_series("XAUUSD", "15", [{"t": 1, "o": 1, "h": 1, "l": 1, "c": 1, "v": 0}])
    chart_store.merge_bars("XAUUSD", "15", [{"t": 2, "o": 1, "h": 1, "l": 1, "c": 2, "v": 0}])
    assert [b["t"] for b in chart_store.get_latest("XAUUSD", "15")["bars"]] == [1, 2]
