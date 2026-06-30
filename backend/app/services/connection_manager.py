"""连接管理器：维护 user_id 与 EA / 前端 WebSocket 的映射。
Connection manager: maps user_id to EA and client WebSocket connections.
"""
import asyncio
from datetime import datetime, timezone

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        # user_id -> EA WebSocket 连接 / EA connection per user
        self._ea: dict[str, WebSocket] = {}
        # user_id -> 前端连接集合 / set of client connections per user
        self._clients: dict[str, set[WebSocket]] = {}
        # user_id -> 最近一次持仓快照 / latest positions snapshot per user
        self._positions: dict[str, list] = {}
        # user_id -> 最近一次报价快照 {symbol: {bid, ask, ...}} / latest quotes snapshot per user
        self._quotes: dict[str, dict] = {}
        self._lock = asyncio.Lock()

    # ---------- 持仓缓存 / Positions cache ----------
    def set_positions(self, user_id: str, positions: list) -> None:
        """缓存某用户最新持仓，供前端重连时补推 / cache latest positions for re-push."""
        self._positions[user_id] = positions or []

    def get_positions(self, user_id: str) -> list:
        return self._positions.get(user_id, [])

    # ---------- 报价缓存 / Quotes cache ----------
    def update_quotes(self, user_id: str, quotes: list) -> list:
        """合并某用户的报价快照，仅返回相对上次发生变化的条目。
        Merge a user's quote snapshot; return only entries changed since last time.

        quotes: [{"symbol": str, "bid": float, "ask": float, "ts": str?}, ...]
        """
        prev = self._quotes.setdefault(user_id, {})
        changed: list = []
        for q in quotes or []:
            sym = q.get("symbol")
            if not sym:
                continue
            old = prev.get(sym)
            if old is None or old.get("bid") != q.get("bid") or old.get("ask") != q.get("ask"):
                prev[sym] = q
                changed.append(q)
        return changed

    def get_quotes(self, user_id: str) -> list:
        return list(self._quotes.get(user_id, {}).values())

    # ---------- EA 连接 / EA connections ----------
    async def register_ea(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            # 同一用户旧连接被新连接接管 / new connection takes over the old one
            old = self._ea.get(user_id)
            if old is not None and old is not ws:
                try:
                    await old.close()
                except Exception:
                    pass
            self._ea[user_id] = ws

    async def unregister_ea(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            if self._ea.get(user_id) is ws:
                self._ea.pop(user_id, None)

    def is_ea_online(self, user_id: str) -> bool:
        return user_id in self._ea

    async def send_to_ea(self, user_id: str, message: dict) -> bool:
        """向指定用户的 EA 下发消息 / send a message to a user's EA."""
        ws = self._ea.get(user_id)
        if ws is None:
            return False
        try:
            await ws.send_json(message)
            return True
        except Exception:
            return False

    # ---------- 前端连接 / Client connections ----------
    async def register_client(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.setdefault(user_id, set()).add(ws)

    async def unregister_client(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._clients.get(user_id)
            if conns:
                conns.discard(ws)
                if not conns:
                    self._clients.pop(user_id, None)

    async def push_to_client(self, user_id: str, message: dict) -> None:
        """向指定用户的所有前端连接推送 / push to all client connections of a user."""
        conns = list(self._clients.get(user_id, set()))
        for ws in conns:
            try:
                await ws.send_json(message)
            except Exception:
                pass

    async def broadcast_to_clients(self, message: dict) -> None:
        """向所有在线前端广播（如新信号）/ broadcast to all clients (e.g. new signals)."""
        for user_id in list(self._clients.keys()):
            await self.push_to_client(user_id, message)


manager = ConnectionManager()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
