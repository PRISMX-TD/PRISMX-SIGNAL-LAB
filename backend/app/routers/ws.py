"""WebSocket 路由：前端推送通道。
WebSocket router: client push channel.

MT5 侧执行统一走 PRISMX Bridge 的 HTTP 轮询（/api/bridge/*），
原 /ws/ea EA 通道已随 EA 接入方式一并移除。
MT5 execution goes exclusively through the PRISMX Bridge HTTP polling
(/api/bridge/*); the legacy /ws/ea EA channel has been removed.
"""
import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.database import SessionLocal
from app.core.security import decode_token_payload
from app.models import User
from app.services import quotes_store
from app.services.connection_manager import manager

logger = logging.getLogger("prismx.ws")

router = APIRouter()

# 等待鉴权首帧的上限（秒）。没有它，一个连上来就不说话的客户端会让服务端在
# receive_json 上无限期挂着——每条这样的连接都占一个未鉴权的 WebSocket 与一个
# 协程，开够了就是一次廉价的资源耗尽。真实前端在 onopen 里立刻就发首帧
# （store/useClientSocket.ts），5 秒对任何正常网络都绰绰有余。
# Cap on waiting for the auth frame. Without it a client that connects and stays
# silent parks the server on receive_json indefinitely, each such connection
# holding an unauthenticated socket and a coroutine — cheap resource exhaustion
# at volume. The real frontend sends the frame from onopen
# (store/useClientSocket.ts), so five seconds is ample on any real network.
AUTH_FRAME_TIMEOUT_SECONDS = 5


def _authenticate(token: str) -> str | None:
    """校验 token 并返回 user_id；会话版本不匹配（改密码后已失效）返回 None。
    与 services/deps.get_current_user 同一套 tv 校验规则，见其说明。

    Validate the token and return the user_id; a session-version mismatch
    (invalidated by a password change) returns None. Same "tv" check as
    services/deps.get_current_user — see its docstring for the rationale.
    """
    payload = decode_token_payload(token)
    user_id = payload.get("sub") if payload else None
    if not user_id:
        return None
    token_tv = payload.get("tv") if isinstance(payload.get("tv"), int) else 0
    db = SessionLocal()
    try:
        current_tv = db.query(User.token_version).filter(User.id == user_id).scalar()
    finally:
        db.close()
    if current_tv is None or token_tv != (current_tv or 0):
        return None
    return user_id


# ---------- 前端通道 / Client channel ----------
@router.websocket("/ws/client")
async def ws_client(websocket: WebSocket):
    """前端 WebSocket：JWT 鉴权后接收信号/订单推送。
    Client WebSocket: authenticate by JWT, then receive signal/order pushes.

    鉴权方式：连接后由客户端发送首帧 {"type":"AUTH","token":"<jwt>"}。
    只在建连这一刻校验会话版本——已经建立的连接不会因为期间发生的密码修改被强制
    断开，会随该连接下次重连时自然生效（前端重连时会带上刷新过的新 token）。

    这里刻意不接受 `?token=<jwt>` 这种 query 参数写法。URL 会被反向代理、网关、
    CDN 的访问日志原样记下来，而本站的 JWT 有效期长达 30 天（见 config 里
    JWT_EXPIRE_MINUTES 的说明）——一份泄露的访问日志就等于一批可用一个月的凭证。
    曾保留 query 回退是为兼容旧客户端，但前端从一开始就只走首帧（见
    store/useClientSocket.ts），这条回退没有任何在用的调用方，只留下风险。

    Auth: client sends a first frame {"type":"AUTH","token":"<jwt>"} after connect.
    The session-version check only runs at connect time — an already-open
    connection isn't force-dropped by a password change that happens while it's
    live; it takes effect the next time that connection reconnects (picking up
    the refreshed token the frontend stores by then).

    A `?token=<jwt>` query parameter is deliberately NOT accepted. URLs are
    recorded verbatim by reverse-proxy, gateway and CDN access logs, and this
    site's JWTs last 30 days (see JWT_EXPIRE_MINUTES) — one leaked access log
    would be a batch of month-long credentials. The fallback existed for older
    clients, but the frontend has only ever sent the AUTH frame (see
    store/useClientSocket.ts), so it had no callers and only carried risk.
    """
    await websocket.accept()

    # 鉴权 token 只从首帧取，且限时 / the auth token comes from the first frame only, with a deadline
    token = ""
    try:
        first = await asyncio.wait_for(
            websocket.receive_json(), timeout=AUTH_FRAME_TIMEOUT_SECONDS
        )
        if isinstance(first, dict) and first.get("type") == "AUTH":
            token = str(first.get("token", "") or "")
    except WebSocketDisconnect:
        # 客户端在发出鉴权帧之前就断开了。连接已经不存在，没有对象可以通知，直接
        # 收工。必须单独接住这一支：若和下面的通用分支一样往下走，就会对一个已经
        # 关闭的连接调用 send_json，starlette 抛
        # 「Unexpected ASGI message 'websocket.send', after ... close」，
        # 在日志里留下一整段无人受害的 ASGI 报错。移动端切后台、刷新页面都会正常
        # 产生这种"连上就断"，所以它不是异常情况，是日常流量。
        # The client vanished before sending the auth frame. There is no
        # connection left to inform, so simply stop. This needs its own branch:
        # falling through would call send_json on a closed socket and make
        # starlette raise "Unexpected ASGI message 'websocket.send', after ...
        # close" — a full ASGI traceback in the log with no actual victim.
        # Backgrounding a mobile browser or refreshing the page produces exactly
        # this connect-then-drop, so it is routine traffic, not an anomaly.
        return
    except Exception:
        token = ""

    user_id = _authenticate(token)
    if not user_id:
        # 告知失败原因后关闭。这里同样要防"对端已经走了"：超时分支走到这里时连接
        # 通常还在（所以这条 AUTH_FAIL 有意义），但客户端完全可能恰好在这一刻断开。
        # Tell the client why, then close. Guarded for the same reason: on the
        # timeout path the peer is usually still there (which is what makes
        # AUTH_FAIL worth sending), but it may drop at exactly this moment.
        try:
            await websocket.send_json({"type": "AUTH_FAIL", "reason": "invalid token"})
            await websocket.close()
        except (WebSocketDisconnect, RuntimeError):
            pass
        return

    await manager.register_client(user_id, websocket)
    await websocket.send_json({"type": "AUTH_OK", "userId": user_id})
    # 连接即补推最近一次持仓快照，避免刷新后持仓短暂消失。
    # Re-push the latest positions snapshot on connect to avoid a blank gap after refresh.
    cached = manager.get_positions(user_id)
    if cached:
        # 带上 funds，否则刷新后账户卡片要等下一拍推送才能拿到实时浮盈，
        # 中间那一两秒会退回"净值-余额"的旧口径，数字会跳一下。
        # Include funds, otherwise the account card would fall back to the old
        # equity-minus-balance figure until the next push and visibly jump.
        await websocket.send_json({
            "type": "POSITIONS",
            "data": cached,
            "funds": manager.account_funds_from_positions(cached),
        })
    # 连接即补推最近一次报价快照（按交易商账户区分，下单确认页用）
    # re-push the latest per-account quotes snapshot on connect (order-confirm page)
    cached_quotes = manager.get_quotes(user_id)
    if cached_quotes:
        await websocket.send_json({"type": "QUOTES", "data": cached_quotes})
    # 连接即补推全站统一报价快照（展示用）/ re-push the site-wide quotes snapshot (display)
    cached_global_quotes = quotes_store.get_all()
    if cached_global_quotes:
        await websocket.send_json({"type": "GLOBAL_QUOTES", "data": cached_global_quotes})
    try:
        while True:
            # 前端通道以服务端推送为主，这里仅保活 / mainly server-push; keep alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.unregister_client(user_id, websocket)
    except Exception:
        logger.exception("ws_client error (user_id=%s)", user_id)
        await manager.unregister_client(user_id, websocket)
