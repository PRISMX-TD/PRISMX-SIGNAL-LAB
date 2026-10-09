"""connection_manager.find_position_shared（设计 §4.3）：给操作日志取「原止损 / 原止盈 /
原手数」。挡在手动改单 / 平仓的路上，所以：一次 MGET、专用短超时客户端、30 秒熔断、任何
异常返回 None、绝不抛；没配 Redis 时查本进程快照。

tests/fake_redis.FakeRedis 没有 MGET（那个文件不归这里改），这里就地补一个子类，顺带记下
每次 MGET 的键，用来验证「一次往返取两个来源」。

find_position_shared (design §4.3) feeds the activity log's "previous SL / TP /
volume". It sits in front of manual modify / close orders: one MGET, a dedicated
short-timeout client, a 30s breaker, None on any error, never raises; the local
snapshot without Redis. FakeRedis lacks MGET, so a local subclass adds it and
records the keys of each call.
"""
import json

import pytest

from app.core.config import settings
from app.services import connection_manager as cm
from app.services import shared_state
from tests.fake_redis import FakeRedis

UID = "user-1"


class MgetRedis(FakeRedis):
    def __init__(self) -> None:
        super().__init__()
        self.mget_calls: list[list[str]] = []

    def mget(self, keys):
        self.mget_calls.append(list(keys))
        return [self.get(k) for k in keys]


class BrokenRedis:
    def __init__(self) -> None:
        self.calls = 0

    def mget(self, keys):
        self.calls += 1
        raise TimeoutError("Timeout reading from socket")


def _pos(ticket, login="5001", sl=0.0, tp=0.0, volume=0.5, **extra):
    row = {"ticket": ticket, "symbol": "XAUUSD", "side": "BUY", "volume": volume,
           "stopLoss": sl, "takeProfit": tp, "login": login}
    row.update(extra)
    return row


def _put_local(manager, source, rows):
    manager._local("positions").setdefault(UID, {})[source] = rows
    manager._stamp_local("positions", UID, source)


@pytest.fixture()
def memory_backend(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
    shared_state.reset_for_tests()
    cm.reset_position_lookup_for_tests()
    yield
    shared_state.reset_for_tests()
    cm.reset_position_lookup_for_tests()


@pytest.fixture()
def redis_backend(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    fake = MgetRedis()
    shared_state.reset_for_tests(fake)
    cm.reset_position_lookup_for_tests(fake)
    yield fake
    shared_state.reset_for_tests()
    cm.reset_position_lookup_for_tests()


def _store(fake, source, rows):
    fake.set(f"prismx:positions:{UID}:{source}", json.dumps(rows))


# ── 没配 Redis：本进程快照 / memory backend ───────────────────────────────────

def test_memory_backend_reads_the_local_snapshot(memory_backend):
    m = cm.ConnectionManager()
    _put_local(m, "gateway", [_pos(11, sl=2390.5, tp=0.0, volume=0.3), _pos(12)])
    assert m.find_position_shared(UID, "5001", 11) == {"sl": 2390.5, "tp": 0.0, "volume": 0.3}
    assert m.find_position_shared(UID, "5001", "12") == {"sl": 0.0, "tp": 0.0, "volume": 0.5}


def test_not_found_and_bad_input_return_none(memory_backend):
    m = cm.ConnectionManager()
    _put_local(m, "gateway", [_pos(11)])
    assert m.find_position_shared(UID, "5001", 99) is None          # 没有这张票 / no such ticket
    assert m.find_position_shared(UID, "9999", 11) is None          # 别的账号 / other account
    assert m.find_position_shared("someone-else", "5001", 11) is None
    assert m.find_position_shared(UID, "5001", None) is None
    assert m.find_position_shared(UID, "5001", "abc") is None
    assert m.find_position_shared(UID, "5001", 0) is None


def test_login_matching_rules(memory_backend):
    """票号只在单个账号内唯一：给了账号就按账号挑；没给账号且两个账号撞号时不猜。
    Tickets are per account: pick by login when given, refuse to guess otherwise."""
    m = cm.ConnectionManager()
    _put_local(m, "gateway", [_pos(11, login="5001", sl=1.0), _pos(11, login="6002", sl=2.0),
                              _pos(13, login="5001", sl=3.0)])
    _put_local(m, "bridge", [_pos(14, login=None, sl=4.0)])
    assert m.find_position_shared(UID, "6002", 11)["sl"] == 2.0
    assert m.find_position_shared(UID, None, 11) is None             # 撞号不猜 / ambiguous
    assert m.find_position_shared(UID, None, 13)["sl"] == 3.0        # 唯一就用 / unique is fine
    assert m.find_position_shared(UID, "5001", 14)["sl"] == 4.0      # 行里没账号 / row lacks login


def test_missing_fields_read_as_none_and_empty_stops_as_zero(memory_backend):
    m = cm.ConnectionManager()
    _put_local(m, "gateway", [{"ticket": 21, "login": "5001", "stopLoss": None, "volume": "bad"}])
    assert m.find_position_shared(UID, "5001", 21) == {"sl": 0.0, "tp": None, "volume": None}


# ── 配了 Redis / Redis backend ────────────────────────────────────────────────

def test_one_mget_covers_both_sources(redis_backend):
    m = cm.ConnectionManager()
    _store(redis_backend, "bridge", [_pos(31, login="7003", sl=1.1, tp=1.3, volume=0.2)])
    _store(redis_backend, "gateway", [_pos(32, login="5001", sl=2.1, tp=0.0, volume=1.0)])

    assert m.find_position_shared(UID, "5001", 32) == {"sl": 2.1, "tp": 0.0, "volume": 1.0}
    assert m.find_position_shared(UID, "7003", 31) == {"sl": 1.1, "tp": 1.3, "volume": 0.2}
    assert redis_backend.mget_calls == [
        [f"prismx:positions:{UID}:bridge", f"prismx:positions:{UID}:gateway"]
    ] * 2


def test_source_missing_in_redis_falls_back_to_local(redis_backend):
    """Redis 里没有网关那一路（键过期 / 镜像写失败），本进程有：用本进程那份，与
    get_positions_shared 同一规则。/ A source absent from Redis comes from the local copy."""
    m = cm.ConnectionManager()
    _store(redis_backend, "bridge", [_pos(41, login="7003")])
    _put_local(m, "gateway", [_pos(42, login="5001", sl=9.9)])
    assert m.find_position_shared(UID, "5001", 42)["sl"] == 9.9


def test_redis_error_returns_none_and_opens_the_breaker(memory_backend, monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://broken")
    broken = BrokenRedis()
    cm.reset_position_lookup_for_tests(broken)
    m = cm.ConnectionManager()
    _put_local(m, "gateway", [_pos(51)])          # 本地有也不用：出错就是 None / error means None

    assert m.find_position_shared(UID, "5001", 51) is None
    assert broken.calls == 1
    # 熔断打开：30 秒内不再碰 Redis / breaker open: Redis is skipped for 30s
    assert m.find_position_shared(UID, "5001", 51) is None
    assert broken.calls == 1
    assert cm._position_lookup_open_until > 0

    # 熔断到期后再试一次。直接赋值而不是 monkeypatch：monkeypatch 收尾时会把「打开」的
    # 时刻还原回去，让后面别的测试文件撞上一个开着的熔断。fixture 收尾会把它清零。
    # Once it lapses, Redis is tried again. Plain assignment rather than monkeypatch,
    # whose undo would restore the "open" timestamp and leak an open breaker into
    # later test files; the fixture resets it on teardown.
    cm._position_lookup_open_until = 0.0
    assert m.find_position_shared(UID, "5001", 51) is None
    assert broken.calls == 2


def test_corrupt_snapshot_never_raises(redis_backend):
    m = cm.ConnectionManager()
    redis_backend.set(f"prismx:positions:{UID}:gateway", "{not json")
    redis_backend.set(f"prismx:positions:{UID}:bridge", json.dumps(["junk", 7, {"ticket": "x"}]))
    assert m.find_position_shared(UID, "5001", 61) is None


def test_dedicated_client_is_short_timeout_and_no_retry(monkeypatch):
    """专用客户端只建对象、不连网：0.3 秒的读 / 连 / 取池超时，零重试。
    Building the client opens no socket: 0.3s read / connect / pool timeouts, zero retries."""
    monkeypatch.setattr(settings, "REDIS_URL", "redis://127.0.0.1:6399/0")
    cm.reset_position_lookup_for_tests()
    try:
        client = cm._position_lookup_redis()
        assert cm._position_lookup_redis() is client          # 复用 / reused
        pool = client.connection_pool
        kw = pool.connection_kwargs
        assert kw["socket_timeout"] == cm.POSITION_LOOKUP_TIMEOUT_SECONDS == 0.3
        assert kw["socket_connect_timeout"] == 0.3
        assert pool.timeout == 0.3
        assert kw["retry"]._retries == 0
        assert client is not shared_state._redis_client      # 不是共享客户端 / not the shared one
    finally:
        cm.reset_position_lookup_for_tests()
