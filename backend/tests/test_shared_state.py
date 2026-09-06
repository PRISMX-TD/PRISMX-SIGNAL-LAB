"""services/shared_state：两种后端（进程内 / Redis）同一套语义。

用 tests/fake_redis.FakeRedis 代替真 Redis；每条用例都在两种后端上跑一遍，
钉住：带过期的 kv、自增、带成员过期的集合、锁的 NX / 续期 / 释放、发布订阅。
Both backends (in-memory and a fake Redis) through the same primitives.
"""
import time

import pytest

from app.core.config import settings
from app.services import shared_state
from tests.fake_redis import FakeRedis


@pytest.fixture(params=["memory", "redis"])
def backend(request, monkeypatch):
    if request.param == "redis":
        monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
        fake = FakeRedis()
        shared_state.reset_for_tests(fake)
        yield fake
    else:
        monkeypatch.setattr(settings, "REDIS_URL", "")
        monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
        shared_state.reset_for_tests()
        yield None
    shared_state.reset_for_tests()


def test_enabled_follows_settings(backend):
    assert shared_state.enabled() is (backend is not None)


def test_kv_roundtrip_and_ttl(backend, monkeypatch):
    shared_state.kv_set("a", "1", ttl=10)
    assert shared_state.kv_get("a") == "1"
    shared_state.kv_set_json("j", {"x": [1, 2]}, ttl=10)
    assert shared_state.kv_get_json("j") == {"x": [1, 2]}
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 11)
    assert shared_state.kv_get("a") is None
    assert shared_state.kv_get_json("j") is None
    shared_state.kv_set("b", "2")
    shared_state.kv_delete("b")
    assert shared_state.kv_get("b") is None


def test_incr_with_ttl(backend, monkeypatch):
    assert shared_state.incr_with_ttl("c", 5) == 1
    assert shared_state.incr_with_ttl("c", 5) == 2
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 6)
    assert shared_state.incr_with_ttl("c", 5) == 1        # 过期后重新计数 / restarts after expiry


def test_set_with_member_expiry(backend, monkeypatch):
    shared_state.set_add("s", "u1", ttl=10)
    shared_state.set_add("s", "u2", ttl=100)
    assert sorted(shared_state.set_members("s")) == ["u1", "u2"]
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 11)
    assert shared_state.set_members("s") == ["u2"]
    shared_state.set_remove("s", "u2")
    assert shared_state.set_members("s") == []


def test_lock_nx_renew_release(backend, monkeypatch):
    assert shared_state.try_lock("L", 30, owner="A") is True
    assert shared_state.try_lock("L", 30, owner="B") is False     # 别人持有 / held by someone else
    assert shared_state.try_lock("L", 30, owner="A") is True      # 自己续期 / own renewal
    shared_state.release_lock("L", owner="B")                     # 不是持有者，释放无效 / not the holder: no-op
    assert shared_state.try_lock("L", 30, owner="B") is False
    shared_state.release_lock("L", owner="A")
    assert shared_state.try_lock("L", 30, owner="B") is True
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 31)
    assert shared_state.try_lock("L", 30, owner="C") is True      # 过期后可被接管 / expired: taken over


def test_publish_goes_to_backend(backend):
    got = []
    if backend is None:
        shared_state.subscribe_memory(lambda ch, body: got.append((ch, body)))
        shared_state.publish("ws", {"user": "u1", "message": {"type": "X"}})
        assert got and got[0][0] == "prismx:ws" and '"user": "u1"' in got[0][1]
    else:
        shared_state.publish("ws", {"user": "u1", "message": {"type": "X"}})
        assert backend.published and backend.published[0][0] == "prismx:ws"


def test_ping(backend):
    assert shared_state.ping() is True


def test_keys_are_prefixed_once():
    assert shared_state._k("a") == "prismx:a"
    assert shared_state._k("prismx:a") == "prismx:a"
