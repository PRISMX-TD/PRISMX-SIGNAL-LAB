"""连接质量统计：PING 捎带读数的解析、在线分布与小时计数、Redis/内存两种后端口径一致。
Connection-quality stats: PING parsing, live distribution and hourly counters,
identical on the Redis and in-memory backends."""
import pytest

from app.core.config import settings
from app.services import net_quality, shared_state
from tests.fake_redis import FakeRedis


@pytest.fixture(params=["memory", "redis"])
def backend(request, monkeypatch):
    if request.param == "redis":
        monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
        shared_state.reset_for_tests(FakeRedis())
    else:
        monkeypatch.setattr(settings, "REDIS_URL", "")
        shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


def test_parse_ping_rejects_junk():
    assert net_quality.parse_ping({"type": "PING"}) == (None, None, "web")
    assert net_quality.parse_ping({"type": "PING", "rtt": 42.7, "jit": 3, "app": True}) == (42, 3, "app")
    # 布尔、负数、离谱大值、字符串都不算读数 / bools, negatives, absurd values, strings aren't readings
    assert net_quality.parse_ping({"rtt": True, "jit": -1, "app": "yes"}) == (None, None, "web")
    assert net_quality.parse_ping({"rtt": 10**9, "jit": "5"}) == (None, None, "web")


def test_snapshot_aggregates(backend):
    net_quality.record_connect("a", 1)
    net_quality.record_connect("b", 1)
    net_quality.record_connect("c", 2)
    net_quality.record_sample("a", 1, 40, 5, "web")
    net_quality.record_sample("a", 1, 60, 5, "web")
    net_quality.record_sample("b", 1, 250, 30, "app")
    # c 是老版本前端，只有裸 PING / c is an old frontend sending bare PINGs
    net_quality.record_sample("c", 2, None, None, "web")

    snap = net_quality.snapshot()
    live = snap["live"]
    assert live["connections"] == 3 and live["users"] == 2
    assert live["dist"] == {"good": 1, "fair": 1, "poor": 0, "unknown": 1}
    assert live["byKind"] == {"app": 1, "web": 2}
    assert snap["worst"][0] == {"userId": 1, "rtt": 250, "jit": 30, "kind": "app"}

    now = snap["hourly"][-1]
    assert len(snap["hourly"]) == 24
    assert now["connects"] == 3
    assert (now["good"], now["fair"], now["poor"]) == (2, 1, 0)
    assert now["avgRtt"] == round((40 + 60 + 250) / 3)


def test_disconnect_leaves_live_set(backend):
    net_quality.record_connect("a", 1)
    net_quality.record_sample("a", 1, 500, None, "web")
    net_quality.record_disconnect("a")
    snap = net_quality.snapshot()
    assert snap["live"]["connections"] == 0
    assert snap["hourly"][-1]["disconnects"] == 1
    assert snap["hourly"][-1]["poor"] == 1
