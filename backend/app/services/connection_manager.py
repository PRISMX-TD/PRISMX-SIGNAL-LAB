"""连接管理器：维护 user_id 与前端 WebSocket 的映射。
Connection manager: maps user_id to client WebSocket connections.
"""
import asyncio
from datetime import datetime, timezone

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        # user_id -> 前端连接集合 / set of client connections per user
        self._clients: dict[str, set[WebSocket]] = {}
        # user_id -> 最近一次持仓快照 / latest positions snapshot per user
        self._positions: dict[str, list] = {}
        # user_id -> login -> {symbol: {bid, ask, login, ...}}：按交易商账户区分的
        # 报价快照，供下单确认页按所选账户取对应报价。全站统一展示报价另见
        # quotes_store.py（EA 推送，不区分用户/账户）。
        # user_id -> login -> {symbol: {bid, ask, login, ...}}: per-broker-account
        # quote snapshot, so the order-confirmation page can look up the quote
        # for whichever account is selected. The site-wide display feed is
        # separate; see quotes_store.py (EA-pushed, not user/account-scoped).
        self._quotes: dict[str, dict[str, dict]] = {}
        self._lock = asyncio.Lock()

    # ---------- 持仓缓存 / Positions cache ----------
    def set_positions(self, user_id: str, positions: list) -> None:
        """缓存某用户最新持仓，供前端重连时补推 / cache latest positions for re-push."""
        self._positions[user_id] = positions or []

    def get_positions(self, user_id: str) -> list:
        return self._positions.get(user_id, [])

    # ---------- 报价缓存 / Quotes cache ----------
    def update_quotes(self, user_id: str, quotes: list) -> list:
        """合并某用户按账户区分的报价快照，仅返回相对上次发生变化的条目。
        Merge a user's per-account quote snapshot; return only entries changed
        since last time.

        quotes: [{"symbol": str, "login": str, "bid": float, "ask": float, "digits": int?}, ...]
        """
        prev = self._quotes.setdefault(user_id, {})
        changed: list = []
        for q in quotes or []:
            sym = q.get("symbol")
            login = q.get("login")
            if not sym or not login:
                continue
            by_symbol = prev.setdefault(login, {})
            old = by_symbol.get(sym)
            if old is None or old.get("bid") != q.get("bid") or old.get("ask") != q.get("ask"):
                by_symbol[sym] = q
                changed.append(q)
        return changed

    def get_quotes(self, user_id: str) -> list:
        out: list = []
        for by_symbol in self._quotes.get(user_id, {}).values():
            out.extend(by_symbol.values())
        return out

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

    def connected_user_ids(self) -> list[str]:
        """当前有前端连接的用户 id 列表，供按等级过滤广播时查询这些用户的 plan。
        User ids with an active client connection right now, so callers can
        look up these users' plans before a plan-filtered broadcast."""
        return list(self._clients.keys())


manager = ConnectionManager()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
