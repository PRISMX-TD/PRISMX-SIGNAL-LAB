"""WebSocket 路由：前端推送通道。
WebSocket router: client push channel.

MT5 侧执行统一走 PRISMX Bridge 的 HTTP 轮询（/api/bridge/*），
原 /ws/ea EA 通道已随 EA 接入方式一并移除。
MT5 execution goes exclusively through the PRISMX Bridge HTTP polling
(/api/bridge/*); the legacy /ws/ea EA channel has been removed.
"""
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.security import decode_access_token
from app.services import quotes_store
from app.services.connection_manager import manager

logger = logging.getLogger("prismx.ws")

router = APIRouter()


# ---------- 前端通道 / Client channel ----------
@router.websocket("/ws/client")
async def ws_client(websocket: WebSocket):
    """前端 WebSocket：JWT 鉴权后接收信号/订单推送。
    Client WebSocket: authenticate by JWT, then receive signal/order pushes.

    鉴权方式：连接后由客户端发送首帧 {"type":"AUTH","token":"<jwt>"}。
    避免把 JWT 放在 URL query（会被代理/网关访问日志记录）。为兼容旧客户端，
    仍接受 query 参数 token 作为回退。
    Auth: client sends a first frame {"type":"AUTH","token":"<jwt>"} after connect.
    Avoids putting the JWT in the URL query (logged by proxies/gateways). For
    backward compatibility a query param token is still accepted as fallback.
    """
    await websocket.accept()

    # 优先使用首帧消息中的 token；回退到 query 参数 / prefer first-frame token, fall back to query
    token = ""
    try:
        first = await websocket.receive_json()
        if isinstance(first, dict) and first.get("type") == "AUTH":
            token = str(first.get("token", "") or "")
    except Exception:
        token = ""
    if not token:
        token = websocket.query_params.get("token", "")

    user_id = decode_access_token(token)
    if not user_id:
        await websocket.send_json({"type": "AUTH_FAIL", "reason": "invalid token"})
        await websocket.close()
        return

    await manager.register_client(user_id, websocket)
    await websocket.send_json({"type": "AUTH_OK", "userId": user_id})
    # 连接即补推最近一次持仓快照，避免刷新后持仓短暂消失。
    # Re-push the latest positions snapshot on connect to avoid a blank gap after refresh.
    cached = manager.get_positions(user_id)
    if cached:
        await websocket.send_json({"type": "POSITIONS", "data": cached})
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
