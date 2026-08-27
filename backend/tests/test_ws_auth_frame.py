"""前端 WebSocket 的鉴权首帧：超时要收口，连上就断不能刷错误，无效 token 不放行。

这三条都是「不会有人来投诉」的失败：
  · 没有超时，连上来不说话的连接就一直挂着，占一个未鉴权 socket 加一个协程。
    没有报错、没有日志，只有内存和句柄慢慢涨——开够了就是一次廉价的资源耗尽。
  · 连上就断（手机切后台、刷新页面）是日常流量，一旦当成异常往下走，就会对已
    关闭的连接 send_json，日志里堆一整段无人受害的 ASGI 报错，把真正的错误淹掉。
  · `?token=` 这条 query 回退删掉之后，必须确认它真的不再被接受——回退代码删了
    但判据没删干净的话，看起来是修了，实际没修。

不用 TestClient（本仓库惯例：带 Depends 与限流装饰器的路由不做端到端测试），
直接用假 WebSocket 驱动 ws_client 协程。

The auth first-frame on the client WebSocket: the timeout must fire, a
connect-then-drop must not spam the log, and an invalid token must not pass.

All three fail without anyone complaining: a missing timeout parks sockets and
coroutines forever with nothing logged; treating a routine connect-then-drop as
an error floods the log with victimless ASGI tracebacks that bury real ones; and
a half-removed `?token=` fallback looks fixed while still being accepted.

No TestClient (repo convention: routes with Depends and rate-limit decorators
aren't tested end to end) — the coroutine is driven with a fake WebSocket.
"""
import asyncio
import time

import pytest
from fastapi import WebSocketDisconnect

from app.routers import ws as ws_mod


class _FakeWS:
    """够用的假 WebSocket：记录发出去的帧，按脚本回应 receive_json。"""

    def __init__(self, *, first_frame=None, silent=False, disconnect=False, query=None):
        self._first_frame = first_frame
        self._silent = silent          # 永不发首帧，用来触发超时
        self._disconnect = disconnect  # 首帧之前就断开
        self.query_params = query or {}
        self.sent: list[dict] = []
        self.accepted = False
        self.closed = False

    async def accept(self):
        self.accepted = True

    async def receive_json(self):
        if self._disconnect:
            raise WebSocketDisconnect(code=1001)
        if self._silent:
            await asyncio.sleep(3600)   # 比超时长得多，交给 wait_for 打断
        return self._first_frame

    async def receive_text(self):
        raise WebSocketDisconnect(code=1000)

    async def send_json(self, data):
        self.sent.append(data)

    async def close(self):
        self.closed = True


def _run(ws) -> None:
    asyncio.run(ws_mod.ws_client(ws))


# ---------- 超时 ----------


def test_silent_client_is_cut_off_by_the_timeout(monkeypatch):
    """连上来不说话的客户端必须被超时收掉，而不是无限期挂着。

    把上限压到 0.05 秒只是为了让用例跑得快；真正被钉住的是「有没有上限」。
    """
    monkeypatch.setattr(ws_mod, "AUTH_FRAME_TIMEOUT_SECONDS", 0.05)
    ws = _FakeWS(silent=True)
    started = time.monotonic()
    _run(ws)
    elapsed = time.monotonic() - started

    assert elapsed < 2, "没有在超时后收口，说明 receive_json 上没有时限"
    assert ws.accepted
    assert ws.closed
    assert ws.sent == [{"type": "AUTH_FAIL", "reason": "invalid token"}]


def test_timeout_constant_is_present_and_sane():
    """常量本身也钉住：删掉或调成 0 都会让上面那条测试失去意义。"""
    assert isinstance(ws_mod.AUTH_FRAME_TIMEOUT_SECONDS, (int, float))
    assert 0 < ws_mod.AUTH_FRAME_TIMEOUT_SECONDS <= 30


# ---------- 连上就断 ----------


def test_connect_then_drop_sends_nothing_and_does_not_raise():
    """手机切后台/刷新页面产生的「连上就断」是日常流量，不是异常。

    往下走会对已关闭的连接 send_json，starlette 抛
    「Unexpected ASGI message 'websocket.send', after ... close」。
    """
    ws = _FakeWS(disconnect=True)
    _run(ws)                    # 不抛异常本身就是断言的一部分
    assert ws.sent == [], "对已断开的连接发了帧"
    assert ws.closed is False


# ---------- 无效 token ----------


@pytest.mark.parametrize("frame", [
    None,                                          # 首帧不是 JSON 对象
    {"type": "PING"},                              # 不是 AUTH 帧
    {"type": "AUTH"},                              # AUTH 帧但没带 token
    {"type": "AUTH", "token": ""},                 # 空 token
    {"type": "AUTH", "token": "not-a-jwt"},        # 无效 token
])
def test_bad_first_frame_is_rejected(frame):
    ws = _FakeWS(first_frame=frame)
    _run(ws)
    assert ws.sent == [{"type": "AUTH_FAIL", "reason": "invalid token"}]
    assert ws.closed


def test_query_param_token_is_not_accepted(monkeypatch):
    """`?token=<jwt>` 这条回退已删除，必须确认它真的不再被接受。

    URL 会被反代/CDN 的访问日志原样记下，而本站 JWT 有效期 30 天——一份泄露的
    访问日志等于一批可用一个月的凭证。这里用一个「一定有效」的 token 放进 query，
    如果哪天回退被重新加回来，这条会立刻变红。
    """
    monkeypatch.setattr(ws_mod, "_authenticate", lambda token: "user-1" if token else None)
    ws = _FakeWS(first_frame={"type": "PING"}, query={"token": "would-be-valid"})
    _run(ws)
    assert ws.sent == [{"type": "AUTH_FAIL", "reason": "invalid token"}], (
        "query 里的 token 被接受了——`?token=` 回退不能重新出现"
    )
