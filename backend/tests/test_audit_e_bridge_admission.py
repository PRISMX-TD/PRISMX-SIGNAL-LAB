"""桥接轮询 / 回执的「不排队」只给已经鉴权过的 token（core/admission.py）。

审计 backend/core/admission.py:bridge-exempt-path-granted-before-token-auth-unbounded-pool-checkout：
以前 /bridge/poll 与 /bridge/result 只看路径就免排队，任何人带一个随便编的 X-API-Token 就能绕过
入口排队，每个请求都去连接池里查一次库。修复后：只有 token 命中桥接鉴权缓存（最近 10 秒内成功
鉴权过、查库不碰数据库的那条快路径）才免排队；没带 token、token 不认识的都走普通请求那条道，
满了照样 503。

Bridge poll/result skip admission only for a token that is in the bridge auth cache (the
DB-free fast path); an unknown or missing token takes the ordinary http lane and is shed
with a 503 like everything else when it is full.
"""
import asyncio
import secrets
import time

import pytest

from app.core import admission
from app.core.config import settings
from app.core.security import hash_api_token

P = settings.API_PREFIX


class _App:
    def __init__(self, hold: float):
        self.hold = hold
        self.seen: list[str] = []

    async def __call__(self, scope, receive, send):
        self.seen.append(scope["path"])
        await asyncio.sleep(self.hold if scope["path"] == f"{P}/signals" else 0)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def _scope(path, token=None, method="POST"):
    headers = [(b"x-api-token", token.encode())] if token else []
    return {"type": "http", "path": path, "method": method, "headers": headers}


async def _call(mw, scope):
    out = {}

    async def send(msg):
        if msg["type"] == "http.response.start":
            out["status"] = msg["status"]

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    await mw(scope, receive, send)
    return out.get("status")


@pytest.fixture()
def lane(monkeypatch):
    http = admission._Lane("http", 1, 0.2, admission._HTTP_BUSY)
    monkeypatch.setattr(admission, "_http_lane", http)
    monkeypatch.setattr(settings, "ADMISSION_ENABLED", True)
    return http


@pytest.fixture()
def cached_token(monkeypatch):
    from app.routers import bridge

    tok = "good-" + secrets.token_hex(8)
    monkeypatch.setitem(bridge._auth_cache, hash_api_token(tok), (time.monotonic() + 30, object(), None))
    return tok


def test_lane_for_bridge_depends_on_cached_token(lane, cached_token):
    for path in (f"{P}/bridge/poll", f"{P}/bridge/result"):
        assert admission._lane_for(_scope(path, cached_token)) is None
        assert admission._lane_for(_scope(path, "unknown-" + secrets.token_hex(8))) is lane
        assert admission._lane_for(_scope(path)) is lane


def test_expired_cache_entry_is_not_exempt(lane, monkeypatch):
    from app.routers import bridge

    tok = "old-" + secrets.token_hex(8)
    monkeypatch.setitem(bridge._auth_cache, hash_api_token(tok), (time.monotonic() - 1, object(), None))
    assert admission._lane_for(_scope(f"{P}/bridge/poll", tok)) is lane


def test_invalid_token_flood_is_shed_while_cached_bridges_pass(lane, cached_token):
    """唯一的名额被占满时：20 个乱编 token 的轮询全部 503、一个都没进到下游；
    已鉴权的桥接照常直通。
    With the only slot held, 20 random-token polls are all shed (503) without reaching
    the app, while a cached bridge passes straight through."""
    app = _App(hold=0.5)
    mw = admission.AdmissionMiddleware(app)

    async def run():
        holder = asyncio.create_task(_call(mw, _scope(f"{P}/signals", method="GET")))
        await asyncio.sleep(0.05)
        bad = [
            _call(mw, _scope(f"{P}/bridge/poll", "bad-" + secrets.token_hex(8)))
            for _ in range(20)
        ]
        good = _call(mw, _scope(f"{P}/bridge/poll", cached_token))
        results = await asyncio.gather(*bad, good)
        await holder
        return results

    results = asyncio.run(run())
    assert results[:20] == [503] * 20
    assert results[20] == 200
    assert app.seen.count(f"{P}/bridge/poll") == 1
