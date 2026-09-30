"""社区情绪缓存在多 worker 下的可见性：抓取循环只在领导 worker 上跑（services/background.py），
其它 worker 的 /sentiment 必须读到领导写进 shared_state 的那一份，而不是自己进程里的空表。
用 FakeRedis 模拟两个 worker 共用一台 Redis；"换一个 worker" 就是把模块里的进程内状态清空。
Sentiment visibility across workers: the fetch loop runs on the leader only, so every other
worker's /sentiment must read the snapshot the leader published to shared_state rather than its
own empty in-process copy. "Switching worker" = clearing the module's in-process state.
"""
import time

import pytest

from app.core.config import settings
from app.services import sentiment_store, shared_state
from tests.fake_redis import FakeRedis

DATA = {"XAUUSD": {"longPct": 66, "shortPct": 34}, "EURUSD": {"longPct": 72, "shortPct": 28}}


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
    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


@pytest.fixture(autouse=True)
def fresh_process(monkeypatch):
    """每个测试从"刚启动的进程"开始 / every test starts as a freshly started process."""
    as_other_worker(monkeypatch)


def as_other_worker(monkeypatch):
    monkeypatch.setattr(sentiment_store, "_cache", {})
    monkeypatch.setattr(sentiment_store, "_updated_at", None)
    monkeypatch.setattr(sentiment_store, "_last_error", None)


def fetch_ok(monkeypatch, data=DATA):
    monkeypatch.setattr(sentiment_store, "_fetch_once", lambda: dict(data))


def fetch_fail(monkeypatch):
    def boom():
        raise RuntimeError("fxssi down")
    monkeypatch.setattr(sentiment_store, "_fetch_once", boom)


def test_follower_worker_sees_leader_data(redis_on, monkeypatch):
    fetch_ok(monkeypatch)
    assert sentiment_store.refresh() is True          # 领导 worker 抓到了 / the leader fetched
    as_other_worker(monkeypatch)                      # 请求落到另一个 worker / request lands elsewhere
    got = sentiment_store.get_sentiment()
    assert got["sentiment"] == DATA
    assert got["stale"] is False
    assert got["updatedAt"] is not None


def test_failed_refresh_keeps_shared_data_and_marks_stale(redis_on, monkeypatch):
    fetch_ok(monkeypatch)
    sentiment_store.refresh()
    fetch_fail(monkeypatch)
    assert sentiment_store.refresh() is False
    as_other_worker(monkeypatch)
    got = sentiment_store.get_sentiment()
    assert got["sentiment"] == DATA
    assert got["stale"] is True


def test_new_leader_failing_first_fetch_does_not_wipe_shared(redis_on, monkeypatch):
    fetch_ok(monkeypatch)
    sentiment_store.refresh()                         # 旧领导 / old leader
    as_other_worker(monkeypatch)                      # 接任的新领导进程里还是空的 / new leader, empty
    fetch_fail(monkeypatch)
    assert sentiment_store.refresh() is False
    as_other_worker(monkeypatch)
    assert sentiment_store.get_sentiment()["sentiment"] == DATA


def test_shared_snapshot_expires_relative_to_last_success(redis_on, monkeypatch):
    fetch_ok(monkeypatch)
    sentiment_store.refresh()
    fetch_fail(monkeypatch)
    real = time.time
    # 一直失败到快过期：每轮失败都重写 stale 标记，但不能借此把旧数据的寿命续下去。
    # Failing right up to expiry: each failed round rewrites the stale flag but must not extend
    # the old data's lifetime.
    monkeypatch.setattr(time, "time", lambda: real() + sentiment_store.SNAPSHOT_TTL_SECONDS - 5)
    sentiment_store.refresh()
    monkeypatch.setattr(time, "time", lambda: real() + sentiment_store.SNAPSHOT_TTL_SECONDS + 5)
    as_other_worker(monkeypatch)
    assert sentiment_store.get_sentiment()["sentiment"] == {}


def test_redis_read_error_falls_back_to_local(redis_on, monkeypatch):
    fetch_ok(monkeypatch)
    sentiment_store.refresh()

    def down(_key):
        raise ConnectionError("redis blip")
    monkeypatch.setattr(shared_state, "kv_get", down)
    # 领导自己手里有，Redis 抖一下也照样答得出 / the leader still answers from its own copy
    assert sentiment_store.get_sentiment()["sentiment"] == DATA


def test_single_worker_without_redis(redis_off, monkeypatch):
    fetch_ok(monkeypatch)
    sentiment_store.refresh()
    got = sentiment_store.get_sentiment()
    assert got["sentiment"] == DATA and got["stale"] is False
