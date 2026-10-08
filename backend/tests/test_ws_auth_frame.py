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


# ---------- 应用层心跳 / app-level heartbeat ----------


class _FakeManager:
    """够用的假 connection_manager：只记录注册/注销，不碰 Redis 与在线名单。"""

    def __init__(self):
        self.registered: list[str] = []
        self.unregistered: list[str] = []

    bg_calls: list = []

    def set_background(self, ws, background):
        self.bg_calls = [*self.bg_calls, background]

    async def register_client(self, user_id, ws):
        self.registered.append(user_id)

    async def unregister_client(self, user_id, ws):
        self.unregistered.append(user_id)

    # 建连补推：一次取齐（见 ConnectionManager.connect_snapshot_async）。snapshot 可被用例替换；
    # snapshot_error 非空则取数时抛出。
    snapshot: dict = {}
    snapshot_error: Exception | None = None

    async def connect_snapshot_async(self, user_id):
        self.snapshot_calls = getattr(self, "snapshot_calls", 0) + 1
        if self.snapshot_error is not None:
            raise self.snapshot_error
        return dict(self.snapshot)

    @staticmethod
    def account_funds_from_positions(positions):
        return []


class _ScriptedWS(_FakeWS):
    """鉴权通过后按脚本逐帧交出 receive_text 的内容，脚本耗尽即断开。"""

    def __init__(self, frames: list[str]):
        super().__init__(first_frame={"type": "AUTH", "token": "valid"})
        self._frames = list(frames)

    async def receive_text(self):
        if not self._frames:
            raise WebSocketDisconnect(code=1000)
        return self._frames.pop(0)


def _authed(monkeypatch) -> _FakeManager:
    fake = _FakeManager()
    monkeypatch.setattr(ws_mod, "_authenticate", lambda token: "user-1" if token == "valid" else None)
    monkeypatch.setattr(ws_mod, "manager", fake)
    return fake


def test_ping_frame_is_answered_with_pong(monkeypatch):
    """客户端的 {"type":"PING"} 必须得到 {"type":"PONG"}。

    这是前端识别僵尸连接的唯一依据：安卓 App 切后台再回来，TCP 已断而
    readyState 仍是 OPEN，只有「发 PING 等 PONG 超时」能把它认出来并重连。
    服务端不回 PONG，前端会在每个心跳周期把好连接也当僵尸断掉重连。
    """
    fake = _authed(monkeypatch)
    ws = _ScriptedWS(['{"type":"PING"}', '{"type":"PING"}'])
    _run(ws)
    assert ws.sent[0] == {"type": "AUTH_OK", "userId": "user-1"}
    assert ws.sent[1:] == [{"type": "PONG"}, {"type": "PONG"}]
    assert fake.registered == ["user-1"]
    assert fake.unregistered == ["user-1"], "断开后没有注销连接"


@pytest.mark.parametrize("frame", [
    "",                       # 空帧
    "not json",               # 非 JSON
    "[1, 2]",                 # JSON 但不是对象
    '{"type":"HELLO"}',       # 对象但不是 PING
    '{"type":"AUTH","token":"valid"}',  # 重复鉴权帧也不回应
])
def test_non_ping_frames_are_ignored(monkeypatch, frame):
    """PING 之外的任何客户端帧都静默忽略——老版本前端一帧不发，行为也不能变。"""
    _authed(monkeypatch)
    ws = _ScriptedWS([frame])
    _run(ws)
    assert ws.sent == [{"type": "AUTH_OK", "userId": "user-1"}], f"对 {frame!r} 回了帧"


# ---------- 建连补推 / connect catch-up ----------


def test_catch_up_frames_come_from_one_snapshot_call_in_order(monkeypatch):
    """补推四帧来自同一次 connect_snapshot_async（一个 pipeline），顺序固定：
    AUTH_OK -> POSITIONS(带 funds) -> PENDING_ORDERS -> QUOTES -> GLOBAL_QUOTES；空的那份不发。"""
    fake = _authed(monkeypatch)
    fake.snapshot = {
        "positions": [{"login": "1", "profit": 2.0}],
        "pending": [{"ticket": 9}],
        "quotes": [],
        "global_quotes": [{"symbol": "XAUUSD"}],
    }
    ws = _ScriptedWS([])
    _run(ws)
    assert [f["type"] for f in ws.sent] == ["AUTH_OK", "POSITIONS", "PENDING_ORDERS", "GLOBAL_QUOTES"]
    assert ws.sent[1]["data"] == [{"login": "1", "profit": 2.0}] and "funds" in ws.sent[1]
    assert fake.snapshot_calls == 1


def test_known_empty_snapshot_is_pushed_but_unknown_is_not(monkeypatch):
    """Redis 里确有快照、只是空（positions_known / pending_known）：照推 []，前端才会把重连前
    已平掉的单清掉（2026-10-08 100502）。不知道（没有快照）时仍不推，免得误清空。"""
    fake = _authed(monkeypatch)
    fake.snapshot = {"positions": [], "positions_known": True, "pending": [], "pending_known": True}
    ws = _ScriptedWS([])
    _run(ws)
    assert [f["type"] for f in ws.sent] == ["AUTH_OK", "POSITIONS", "PENDING_ORDERS"]
    assert ws.sent[1]["data"] == [] and ws.sent[2]["data"] == []

    fake.snapshot = {"positions": [], "pending": []}
    ws = _ScriptedWS([])
    _run(ws)
    assert [f["type"] for f in ws.sent] == ["AUTH_OK"]


def test_a_failing_catch_up_fetch_keeps_the_connection(monkeypatch):
    """Redis 抖动时取数失败：只跳过补推，连接留着、PING 照回 PONG——不能「鉴权成功 -> 异常关闭 ->
    300ms 后重连」形成重连风暴。"""
    fake = _authed(monkeypatch)
    fake.snapshot_error = ConnectionError("redis is down")
    ws = _ScriptedWS(['{"type":"PING"}'])
    _run(ws)
    assert ws.sent == [{"type": "AUTH_OK", "userId": "user-1"}, {"type": "PONG"}]
    assert fake.unregistered == ["user-1"]        # 是被正常断开，不是被异常踢掉


def test_a_dead_socket_during_catch_up_still_unregisters(monkeypatch):
    """发送不包 try：socket 已死时发送异常照常冒出去走 finally 注销，不能把死连接留在名单里。"""
    fake = _authed(monkeypatch)
    fake.snapshot = {"positions": [{"login": "1", "profit": 1.0}]}

    class _DiesOnPositions(_ScriptedWS):
        async def send_json(self, data):
            if data.get("type") == "POSITIONS":
                raise RuntimeError("socket closed")
            await super().send_json(data)

    _run(_DiesOnPositions([]))
    assert fake.registered == ["user-1"] and fake.unregistered == ["user-1"]


def test_connection_quality_is_recorded_after_auth_ok_and_before_disconnect(monkeypatch):
    """连接质量记账不再卡在 AUTH_OK 之前；但 record_connect 一定先于 record_disconnect 落地，
    连接秒断也不留幽灵记录。"""
    _authed(monkeypatch)
    events: list[str] = []

    class _SpyWS(_ScriptedWS):
        async def send_json(self, data):
            events.append("send:" + data["type"])
            await super().send_json(data)

    def spy(name):
        def fn(*a, **kw):
            events.append(name)
        fn.__name__ = name
        return fn

    monkeypatch.setattr(ws_mod.net_quality, "record_connect", spy("record_connect"))
    monkeypatch.setattr(ws_mod.net_quality, "record_disconnect", spy("record_disconnect"))
    _run(_SpyWS([]))
    assert events[0] == "send:AUTH_OK"
    assert events.index("record_connect") < events.index("record_disconnect")
    assert events[-1] == "record_disconnect"


def test_heartbeat_bookkeeping_uses_the_anyio_pool_not_the_default_executor(monkeypatch):
    """每个 PING 的记账走 anyio 线程池（run_blocking），不再用 asyncio.to_thread（默认 executor 只有 6 条）。"""
    _authed(monkeypatch)
    used = []

    async def fake_run_blocking(fn, *args):
        used.append(getattr(fn, "__name__", str(fn)))

    def no_to_thread(*a, **kw):
        raise AssertionError("不该走 asyncio.to_thread")

    monkeypatch.setattr(ws_mod, "run_blocking", fake_run_blocking)
    monkeypatch.setattr(asyncio, "to_thread", no_to_thread)
    _run(_ScriptedWS(['{"type":"PING","rtt":40}']))
    assert "record_sample" in used and "record_connect" in used and "record_disconnect" in used


# ---------- 鉴权走缓存 / authentication from the cached {tv, d} ----------


def test_authenticate_uses_the_cached_state_and_rejects_stale_or_disabled(monkeypatch):
    """_authenticate 只信 get_auth_state 的 {tv, d}：tv 对得上放行；tv 不符、已停用、用户不存在都拒。"""
    from app.core.security import create_access_token

    states = {
        "ok": {"tv": 3, "d": False},
        "banned": {"tv": 0, "d": True},
    }
    monkeypatch.setattr(ws_mod, "get_auth_state", lambda uid: states.get(uid))
    assert ws_mod._authenticate(create_access_token("ok", 3)) == "ok"
    assert ws_mod._authenticate(create_access_token("ok", 2)) is None       # 改密之前签的旧 token
    assert ws_mod._authenticate(create_access_token("banned", 0)) is None   # 已停用
    assert ws_mod._authenticate(create_access_token("ghost", 0)) is None    # 用户不存在
    assert ws_mod._authenticate("not-a-jwt") is None


def test_ping_bg_flag_marks_and_clears_background(monkeypatch):
    fake = _authed(monkeypatch)
    ws = _ScriptedWS(['{"type":"PING","bg":true}', '{"type":"PING"}',
                      '{"type":"PING","bg":false,"rtt":30}', '{"type":"PING","bg":"yes"}'])
    _run(ws)
    assert fake.bg_calls == [True, False, False, False]
    assert ws.sent[1:] == [{"type": "PONG"}] * 4
