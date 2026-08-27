"""连接管理器：维护 user_id 与前端 WebSocket 的映射。
Connection manager: maps user_id to client WebSocket connections.
"""
import asyncio
import hashlib
import json

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        # user_id -> 前端连接集合 / set of client connections per user
        self._clients: dict[str, set[WebSocket]] = {}
        # user_id -> source -> 最近一次持仓快照。
        #
        # 必须按来源分区：一个用户可以同时绑 bridge 账号和 gateway 账号，两条
        # 上报路径各自只知道自己那批账号。若共用一个 list，bridge 上报会把
        # gateway 的持仓覆盖掉，gateway 上报再覆盖回来，前端（整表替换语义）
        # 就表现为持仓行来回闪烁。分区存、推送时合并，两路互不干扰。
        #
        # user_id -> source -> latest positions snapshot.
        #
        # Partitioning by source is required: a user can have both bridge- and
        # gateway-managed accounts, and each reporting path only knows its own
        # subset. Sharing one list makes the two paths overwrite each other, and
        # since the frontend replaces the whole table, positions visibly flicker.
        # Store per source and merge on push so the paths stay independent.
        self._positions: dict[str, dict[str, list]] = {}
        # user_id -> login -> {symbol: {bid, ask, login, ...}}：按交易商账户区分的
        # 报价快照，供下单确认页按所选账户取对应报价。全站统一展示报价另见
        # quotes_store.py（EA 推送，不区分用户/账户）。
        # user_id -> login -> {symbol: {bid, ask, login, ...}}: per-broker-account
        # quote snapshot, so the order-confirmation page can look up the quote
        # for whichever account is selected. The site-wide display feed is
        # separate; see quotes_store.py (EA-pushed, not user/account-scoped).
        self._quotes: dict[str, dict[str, dict]] = {}
        # user_id -> 上一次 POSITIONS 推送内容的摘要，用于跳过重复推送
        # user_id -> digest of the last POSITIONS payload, to skip repeat pushes
        self._last_positions_push: dict[str, bytes] = {}
        self._lock = asyncio.Lock()

    # ---------- 持仓缓存 / Positions cache ----------
    def get_positions(self, user_id: str) -> list:
        """某用户全部来源合并后的最新持仓，供前端重连时补推。
        Merged latest positions across all sources, for re-push on reconnect."""
        by_source = self._positions.get(user_id)
        if not by_source:
            return []
        merged: list = []
        for rows in by_source.values():
            merged.extend(rows)
        return merged

    # ---------- 账号浮动盈亏缓存 / Per-account floating P/L cache ----------
    #
    # 为什么需要这个：账号的 balance/equity 存在 mt5_accounts 表里，由 bridge 的
    # /bridge/poll（约 1.5 秒）或 gateway 轮询（15 秒）刷新，前端再每 5 秒读库。
    # 净值因此最坏能落后 20 秒，而持仓列表里每笔的 profit 是随 POSITIONS 一起推的，
    # 延迟只有一两秒 —— 同一屏上两个数字对不上。
    #
    # 浮动盈亏本身不必等资金刷新：它等于当前各持仓 profit 之和，而持仓快照我们
    # 每拍都有。所以这里按 login 汇总一份浮盈随 POSITIONS 一起下发，前端拿它加上
    # balance 就能算出实时净值。
    #
    # 不落库是故意的：浮盈每秒都在变，落库只为给 HTTP 轮询读，白增写压力，延迟还
    # 是被轮询间隔卡住。这个值天生属于推送通道。
    #
    # Why this exists: balance/equity live in mt5_accounts, refreshed by the
    # bridge poll (~1.5s) or the gateway loop (15s), and the frontend then polls
    # the DB every 5s -- so equity can lag by ~20s. Per-position profit, on the
    # other hand, rides along with every POSITIONS push. The two numbers end up
    # disagreeing on screen.
    #
    # Floating P/L doesn't need the funds refresh at all: it's the sum of the
    # current positions' profit, and we have that snapshot every tick. So we
    # aggregate it per login and ship it with POSITIONS; the frontend adds
    # balance to get live equity.
    #
    # Deliberately not persisted: floating P/L changes every second, storing it
    # would only serve HTTP polling -- extra write load, and the latency would
    # still be capped by the poll interval. This value belongs on the push path.
    @staticmethod
    def account_funds_from_positions(positions: list) -> list[dict]:
        """按 login 汇总持仓浮动盈亏，供随 POSITIONS 一起推送。

        Aggregate floating P/L per login, to be pushed alongside POSITIONS.

        入参是 POSITIONS 的 payload（bridge 与 gateway 用的是同一套字段），
        返回 [{"login": str, "profit": float}, ...]。

        没有持仓的账号不会出现在结果里 —— 调用方无从得知"该用户有哪些账号"，
        这里只对看得见的持仓做汇总。前端必须把"某 login 缺席"理解为浮盈 0，
        而不是"数据未知"，否则平掉最后一笔仓后浮盈会停在旧值上。
        Accounts with no positions are absent from the result: this helper only
        sees the positions payload, not the user's account list. The frontend
        must treat a missing login as zero floating P/L rather than "unknown",
        otherwise closing the last position would leave a stale number on screen.
        """
        by_login: dict[str, float] = {}
        for p in positions or []:
            if not isinstance(p, dict):
                continue
            login = p.get("login")
            if login is None:
                continue
            profit = p.get("profit")
            if not isinstance(profit, (int, float)) or isinstance(profit, bool):
                continue
            # login 在 bridge/gateway 两侧都以字符串下发，这里统一成字符串，
            # 避免前端因 100039 与 "100039" 不匹配而找不到账号。
            by_login[str(login)] = by_login.get(str(login), 0.0) + float(profit)

        # 浮点累加会带出 -17.499999999999996 这类尾数，前端要直接显示，
        # 这里按分位取整（资金类字段两位小数足够）。
        return [
            {"login": login, "profit": round(total, 2)}
            for login, total in by_login.items()
        ]

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
            # 让持仓去重失效：新连接（多开一个标签页也算）还没收到过任何快照，
            # 若沿用旧摘要，内容不变时下一拍会被跳过，新页面就只能干等到持仓
            # 真的发生变化。
            # Invalidate positions de-duplication: a new connection (including a
            # second tab) has received no snapshot yet. Keeping the old digest
            # would skip the next unchanged tick and leave the new page waiting
            # until positions actually change.
            self._last_positions_push.pop(user_id, None)

    async def unregister_client(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._clients.get(user_id)
            if conns:
                conns.discard(ws)
                if not conns:
                    self._clients.pop(user_id, None)
                    # 人都走了，摘要留着只会占内存
                    # Nobody left; the digest would just leak memory
                    self._last_positions_push.pop(user_id, None)

    async def push_to_client(self, user_id: str, message: dict) -> None:
        """向指定用户的所有前端连接推送，并顺带清掉发不出去的连接。

        Push to all of a user's client connections, dropping any that fail.

        发送失败几乎只有一个原因：对端已经没了，而 `receive_text()` 那侧的
        disconnect 分支没能触发（进程被杀、网络断开、代理超时都会这样）。
        以前这里是 `except: pass`，死连接会永远留在集合里，之后每一拍推送都对它
        白发一次 —— 持仓每 1.5 秒推一回，积累起来很浪费。

        A send failure essentially means the peer is gone while the disconnect
        branch on the `receive_text()` side never fired (killed process, dropped
        network, proxy timeout). This used to be `except: pass`, which left dead
        sockets in the set forever and re-sent to them on every tick.
        """
        conns = list(self._clients.get(user_id, set()))
        dead: list[WebSocket] = []
        for ws in conns:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            # 复用 unregister_client 而不是直接改集合，保证"最后一个连接走了就删掉
            # user_id 这一项"的清理逻辑只有一份。
            # Reuse unregister_client instead of touching the set directly, so the
            # "drop the user_id entry once the last connection is gone" logic
            # lives in exactly one place.
            await self.unregister_client(user_id, ws)

    async def push_positions(
        self, user_id: str, positions: list, source: str = "bridge"
    ) -> None:
        """推送持仓快照（含资金），内容与上一拍相同则跳过。

        `positions` 只是 `source` 这条上报路径看到的那部分持仓；本方法会与其他
        来源的最新快照合并后再推，因为 POSITIONS 在前端是整表替换语义。
        `positions` is only the slice seen by the `source` reporting path; it is
        merged with the other sources' latest snapshots before pushing, since
        POSITIONS replaces the whole table on the frontend.

        Push a positions snapshot (with funds), skipping unchanged ticks.

        持仓每 1.5~2 秒推一次，但休市、无持仓、行情不动时内容是完全一样的。
        照发的代价是每个连接一条 WS 帧加一次前端 JSON 解析 —— 前端的 keepIfEqual
        只能避免重渲染，省不掉传输和解析。
        这里比较序列化后的字节：持仓字段都是原始类型，字节相同即内容相同。
        Positions are pushed every 1.5-2s, but the payload is byte-identical when
        the market is closed or nothing moved. The frontend's keepIfEqual avoids
        re-rendering but can't avoid the transfer and JSON parse. Positions
        contain only primitives, so comparing serialized bytes is sound.
        """
        self._positions.setdefault(user_id, {})[source] = positions or []
        merged = self.get_positions(user_id)
        message = {
            "type": "POSITIONS",
            "data": merged,
            "funds": self.account_funds_from_positions(merged),
        }
        # sort_keys 让相同内容必定得到相同字节，不受 dict 插入顺序影响。
        # sort_keys makes identical content produce identical bytes regardless of
        # dict insertion order.
        # 存 16 字节摘要而不是整份 JSON：持仓多的用户一份快照可达几十 KB，
        # 每个在线用户都留一份原文没必要。
        # Store a 16-byte digest instead of the full JSON: a snapshot can reach
        # tens of KB for users with many positions.
        payload = json.dumps(message, sort_keys=True, default=str)
        digest = hashlib.blake2b(payload.encode(), digest_size=16).digest()
        if self._last_positions_push.get(user_id) == digest:
            return
        self._last_positions_push[user_id] = digest
        await self.push_to_client(user_id, message)

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
