"""WebSocket 路由：前端推送通道 + EA 桥接通道。
WebSocket router: client push channel + EA bridge channel.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.database import SessionLocal
from app.core.security import authenticate_api_token, decode_access_token
from app.models import EABinding, Order, User
from app.services.connection_manager import manager

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
    # 连接即补推最近一次报价快照 / re-push the latest quotes snapshot on connect
    cached_quotes = manager.get_quotes(user_id)
    if cached_quotes:
        await websocket.send_json({"type": "QUOTES", "data": cached_quotes})
    try:
        while True:
            # 前端通道以服务端推送为主，这里仅保活 / mainly server-push; keep alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.unregister_client(user_id, websocket)
    except Exception:
        await manager.unregister_client(user_id, websocket)


# ---------- EA 通道 / EA channel ----------
@router.websocket("/ws/ea")
async def ws_ea(websocket: WebSocket):
    """EA WebSocket：API Token 鉴权，处理认证/心跳/回执/持仓。
    EA WebSocket: authenticate by API token; handle auth/heartbeat/result/positions.
    """
    await websocket.accept()
    user_id: str | None = None

    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type")

            # 认证 / authentication
            if mtype == "AUTH":
                api_token = msg.get("apiToken", "")
                db = SessionLocal()
                try:
                    user = authenticate_api_token(db, api_token)
                    if not user:
                        await websocket.send_json({"type": "AUTH_FAIL", "reason": "invalid api token"})
                        await websocket.close()
                        return
                    user_id = user.id
                    # 记录 MT5 账号与在线状态 / record MT5 account and online state
                    binding = db.query(EABinding).filter(EABinding.user_id == user_id).first()
                    if binding is None:
                        binding = EABinding(user_id=user_id)
                        db.add(binding)
                    reported_login = str(msg.get("mt5Login", "") or "")
                    if reported_login:
                        binding.mt5_login = reported_login
                    if msg.get("mt5Server"):
                        binding.mt5_server = str(msg.get("mt5Server"))
                    # EA 上报的账户信息 / account info reported by EA
                    if msg.get("accountName") is not None:
                        binding.account_name = str(msg.get("accountName"))
                    if msg.get("accountCurrency") is not None:
                        binding.account_currency = str(msg.get("accountCurrency"))
                    if msg.get("company") is not None:
                        binding.company = str(msg.get("company"))
                    if msg.get("balance") is not None:
                        binding.balance = float(msg.get("balance"))
                    if msg.get("equity") is not None:
                        binding.equity = float(msg.get("equity"))
                    if msg.get("leverage") is not None:
                        binding.leverage = int(msg.get("leverage"))
                    # EA 探测后缀作为兜底（用户未手动设置时）/ detected suffix as fallback
                    detected = msg.get("detectedSuffix")
                    if detected is not None and not (binding.symbol_suffix or "").strip():
                        binding.symbol_suffix = str(detected)
                    binding.online = True
                    binding.last_heartbeat = datetime.now(timezone.utc)
                    db.commit()
                finally:
                    db.close()

                await manager.register_ea(user_id, websocket)
                await websocket.send_json({"type": "AUTH_OK", "userId": user_id})
                await manager.push_to_client(user_id, {
                    "type": "EA_STATUS",
                    "data": {"online": True, "mt5Login": reported_login or None},
                })
                continue

            # 认证前不接受其他消息 / reject other messages before auth
            if user_id is None:
                await websocket.send_json({"type": "AUTH_FAIL", "reason": "not authenticated"})
                continue

            # 心跳 / heartbeat
            if mtype == "HEARTBEAT":
                db = SessionLocal()
                try:
                    binding = db.query(EABinding).filter(EABinding.user_id == user_id).first()
                    if binding:
                        binding.online = True
                        binding.last_heartbeat = datetime.now(timezone.utc)
                        db.commit()
                finally:
                    db.close()
                continue

            # 下单回执 / order execution result
            if mtype == "ORDER_RESULT":
                client_order_id = msg.get("clientOrderId")
                db = SessionLocal()
                try:
                    order = (
                        db.query(Order)
                        .filter(Order.user_id == user_id, Order.client_order_id == client_order_id)
                        .first()
                    )
                    if order:
                        success = bool(msg.get("success"))
                        order.status = "FILLED" if success else "REJECTED"
                        order.mt5_ticket = msg.get("mt5Ticket")
                        order.filled_price = msg.get("filledPrice")
                        order.message = msg.get("message")
                        db.commit()
                        db.refresh(order)
                        payload = {
                            "type": "ORDER_UPDATE",
                            "data": {
                                "id": order.id,
                                "clientOrderId": order.client_order_id,
                                "signalId": order.signal_id,
                                "symbol": order.symbol,
                                "side": order.side,
                                "volume": order.volume,
                                "status": order.status,
                                "mt5Ticket": order.mt5_ticket,
                                "filledPrice": order.filled_price,
                                "message": order.message,
                                "createdAt": order.created_at.isoformat(),
                                "updatedAt": order.updated_at.isoformat(),
                            },
                        }
                    else:
                        payload = None
                finally:
                    db.close()
                if payload:
                    await manager.push_to_client(user_id, payload)
                continue

            # 持仓上报 / positions report
            if mtype == "POSITIONS":
                positions = msg.get("data", [])
                manager.set_positions(user_id, positions)
                await manager.push_to_client(user_id, {
                    "type": "POSITIONS",
                    "data": positions,
                })
                continue

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if user_id is not None:
            await manager.unregister_ea(user_id, websocket)
            db = SessionLocal()
            try:
                binding = db.query(EABinding).filter(EABinding.user_id == user_id).first()
                if binding:
                    binding.online = False
                    db.commit()
            finally:
                db.close()
            await manager.push_to_client(user_id, {
                "type": "EA_STATUS",
                "data": {"online": False, "mt5Login": None},
            })
