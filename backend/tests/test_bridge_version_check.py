"""Bridge 最新版本查询：GitHub 抓取失败要退避、并发只抓一次。

Latest-version lookup: back off after a failed GitHub fetch and single-flight
concurrent refreshes.
"""
import threading
import time

import pytest

from app.services import bridge_version_check as bvc


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setattr(bvc, "_cache", None)
    monkeypatch.setattr(bvc, "_cached_at", 0.0)
    monkeypatch.setattr(bvc, "_failed_at", 0.0)


def test_failure_is_backed_off(monkeypatch):
    """失败一次后，退避期内不再打 GitHub。以前每个请求都会再等一次 6 秒超时。"""
    calls = {"n": 0}

    def boom():
        calls["n"] += 1
        raise RuntimeError("github down")

    monkeypatch.setattr(bvc, "_fetch_latest", boom)
    for _ in range(5):
        assert bvc.get_latest() is None
    assert calls["n"] == 1

    # 退避期过后再试一次 / retried once the backoff elapses
    monkeypatch.setattr(bvc, "_failed_at", time.time() - bvc._FAILURE_BACKOFF_SECONDS - 1)
    bvc.get_latest()
    assert calls["n"] == 2


def test_failure_keeps_previous_cache(monkeypatch):
    monkeypatch.setattr(bvc, "_cache", {"latest": "1.2.3", "downloadUrl": "x"})
    monkeypatch.setattr(bvc, "_cached_at", time.time() - bvc._CACHE_TTL_SECONDS - 1)

    def boom():
        raise RuntimeError("github down")

    monkeypatch.setattr(bvc, "_fetch_latest", boom)
    assert bvc.get_latest() == {"latest": "1.2.3", "downloadUrl": "x"}
    assert bvc._failed_at > 0


def test_concurrent_refresh_fetches_once(monkeypatch):
    """缓存过期时多个请求同时到：只有一个去抓，其余不等、直接拿旧值。"""
    calls = {"n": 0}
    gate = threading.Event()

    def slow():
        calls["n"] += 1
        gate.wait(2)
        return {"latest": "2.0.0", "downloadUrl": "y"}

    monkeypatch.setattr(bvc, "_fetch_latest", slow)
    results = []
    threads = [threading.Thread(target=lambda: results.append(bvc.get_latest())) for _ in range(5)]
    for t in threads:
        t.start()
    time.sleep(0.2)
    gate.set()
    for t in threads:
        t.join(3)

    assert calls["n"] == 1
    assert results.count(None) == 4
    assert bvc.get_latest() == {"latest": "2.0.0", "downloadUrl": "y"}
