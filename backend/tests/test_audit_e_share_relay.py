"""分享图中转不再每次都回源下载（routers/share.py）。

审计 backend/routers/share.py:share-png-relay-refetches-storage-per-request-without-limit：
GET /share/i/{token}.png 不用登录，每次请求都用 service key 从 Supabase 整张（最多 4MB）拉一遍，
没有缓存、没有限流——一个链接被反复刷就是成倍的存储出口流量。修复后：进程内有界缓存（按总字节
淘汰、带时效），同一张图在时效内只回源一次；按 IP 限流；图片响应不再被 GZip 白白压一遍。

The share-image relay now serves repeats from a bounded in-process cache (byte-capped,
time-limited), is rate limited per IP, and skips gzip for the PNG.
"""
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.core.rate_limit import limiter
from app.routers import share


@pytest.fixture()
def client(monkeypatch):
    share._relay_cache_clear()
    limiter.reset()
    monkeypatch.setattr(limiter, "enabled", True)
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(share.router, prefix="/api")
    yield TestClient(app)
    share._relay_cache_clear()
    limiter.reset()


@pytest.fixture()
def fetches(monkeypatch):
    calls = []
    blob = b"\x89PNG\r\n\x1a\n" + os.urandom(256 * 1024)

    def fake(path):
        calls.append(path)
        return blob

    monkeypatch.setattr(share, "_fetch_object", fake)
    return calls, blob


def test_repeated_gets_hit_storage_once(client, fetches):
    calls, blob = fetches
    tok = share.make_token("share/u1/x.png")
    for _ in range(20):
        r = client.get(f"/api/share/i/{tok}.png", headers={"Accept-Encoding": "gzip"})
        assert r.status_code == 200 and r.content == blob
    assert calls == ["share/u1/x.png"]


def test_png_is_not_gzipped_by_the_app_middleware(client, fetches):
    """main.py 的 GZipMiddleware 不该再压一遍 PNG：响应带 Content-Encoding: identity 时它原样放过。
    The app-level GZip must pass the PNG through untouched."""
    from fastapi.middleware.gzip import GZipMiddleware

    app = FastAPI()
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)
    app.include_router(share.router, prefix="/api")
    tok = share.make_token("share/u1/x.png")
    r = TestClient(app).get(f"/api/share/i/{tok}.png", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") != "gzip"


def test_relay_is_rate_limited_per_ip(client, fetches):
    tok = share.make_token("share/u1/x.png")
    codes = [client.get(f"/api/share/i/{tok}.png").status_code for _ in range(40)]
    assert codes[:30] == [200] * 30
    assert 429 in codes[30:]


def test_cache_is_bounded_by_bytes(client, monkeypatch):
    monkeypatch.setattr(share, "RELAY_CACHE_MAX_BYTES", 1000)
    monkeypatch.setattr(share, "_fetch_object", lambda path: b"P" * 400)
    for i in range(10):
        tok = share.make_token(f"share/u1/{i}.png")
        assert client.get(f"/api/share/i/{tok}.png").status_code == 200
    assert share._relay_cache_bytes() <= 1000


def test_expired_token_still_404_even_when_cached(client, fetches, monkeypatch):
    tok = share.make_token("share/u1/x.png")
    assert client.get(f"/api/share/i/{tok}.png").status_code == 200
    import time as _time

    real = _time.time
    monkeypatch.setattr(share.time, "time", lambda: real() + share.TOKEN_TTL_SECONDS + 60)
    assert client.get(f"/api/share/i/{tok}.png").status_code == 404
