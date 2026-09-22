"""连接管理器：维护 user_id 与前端 WebSocket 的映射。
Connection manager: maps user_id to client WebSocket connections.
"""
import asyncio
import hashlib
import json
import logging

from fastapi import WebSocket

from app.services import shared_state

logger = logging.getLogger("prismx.ws")

# 多 worker 下的跨进程转发（配了 REDIS_URL 才启用）：
#   · 发送方不直接写本进程的 socket，而是 publish 到 Redis 频道 `prismx:ws`；
#   · 每个 worker 起一个订阅协程（run_fanout_subscriber），收到后投递给**本进程**
#     连着的那些 socket。发送方自己也是订阅者之一，所以本进程的用户同样收得到；
#   · 在线用户名单（connected_user_ids）= 本进程的 ∪ Redis 里带过期的 ZSET
#     `prismx:ws:users`，每个 worker 每 30 秒把自己这边的用户续一次期（90 秒过期）。
# 单 worker（REDIS_URL 留空）时全部走本地，与从前一模一样。
# Cross-worker fan-out (only with REDIS_URL): senders publish to `prismx:ws`
# instead of writing local sockets; every worker runs a subscriber that delivers
# to its own sockets (the sender included). The connected-user roster merges the
# local set with an expiring ZSET refreshed every 30s by each worker.
WS_CHANNEL = "ws"
PRESENCE_KEY = "ws:users"
PRESENCE_TTL_SECONDS = 90
PRESENCE_REFRESH_SECONDS = 30

# 单个 socket 的发送超时（秒）。TCP 背压下 send_json 可以长时间不返回：对端还活着
# 但读得极慢（手机切后台、弱网），内核发送缓冲区一满就卡在那里。持仓每 1.5 秒一拍、
# 广播要走遍所有在线用户，一个这样的连接足以把整批推送拖住。超时即当作死连接摘掉，
# 前端本来就会重连并在下一拍拿到完整快照。
# Per-socket send timeout. Under TCP back-pressure send_json can block for a long
# time -- the peer is alive but reading very slowly (backgrounded phone, weak
# network) and stalls once the send buffer fills. Positions tick every 1.5s and a
# broadcast walks every online user, so one such connection holds up the whole
# batch. On timeout we drop it as dead; the frontend reconnects and gets a full
# snapshot on the next tick anyway.
SEND_TIMEOUT_SECONDS = 2


async def _offload(fn, *args):
    """把一次同步 Redis 调用挪出事件循环。

    shared_state 用的是**同步** redis 客户端（socket_timeout=2 秒）。在 async 函数
    里直接调，Redis 稍有延迟或断连就会把事件循环整个冻住最多 2 秒——这段时间里
    所有 HTTP 请求与所有 WebSocket 一起停摆。这里不改写成 redis.asyncio（那要动
    全部调用方，风险远大于收益），只把阻塞调用丢到线程里，事件循环照常转。

    Run one synchronous Redis call off the event loop. shared_state uses the sync
    redis client (socket_timeout=2s); calling it directly from a coroutine freezes
    the entire loop for up to two seconds on any Redis hiccup, stalling every HTTP
    request and every WebSocket at once. Rather than converting everything to
    redis.asyncio (a far larger change than the problem warrants), the blocking
    call is handed to a thread and the loop keeps running.
    """
    return await asyncio.to_thread(fn, *args)


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
        # user_id -> source -> 最近一次**挂单**快照。分区理由与 _positions 完全
        # 相同（bridge 与 gateway 各自只看得见自己那批账号），推送时同样合并。
        # user_id -> source -> latest pending-orders snapshot, partitioned and
        # merged for exactly the same reason as _positions.
        self._pending_orders: dict[str, dict[str, list]] = {}
        # user_id -> 上一次 POSITIONS 推送内容的摘要，用于跳过重复推送
        # user_id -> digest of the last POSITIONS payload, to skip repeat pushes
        self._last_positions_push: dict[str, bytes] = {}
        # 同上，PENDING_ORDERS 那一路。挂单在休市/无操作时长时间一动不动，
        # 重复帧比持仓还多，去重的收益更大。
        # Same for PENDING_ORDERS. Pending orders sit unchanged for long stretches,
        # so this skips even more repeat frames than the positions one.
        self._last_pending_push: dict[str, bytes] = {}
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

    def get_pending_orders(self, user_id: str) -> list:
        """某用户全部来源合并后的最新挂单，供前端重连时补推。
        Merged latest pending orders across all sources, for re-push on reconnect."""
        by_source = self._pending_orders.get(user_id)
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

        quotes: [{"symbol": str, "login": str, "bid": float, "ask": float, "digits": int?,
                  "contractSize": float?, "tickSize": float?, "tickValue": float?}, ...]

        合约规格三个字段也参与"是否变化"的判断：桥接升级到会上报规格的版本后，
        第一轮报价的价格可能与升级前完全相同，只比 bid/ask 会把规格漏推给前端，
        直到价格下一次跳动。ts 不参与，否则每轮都算变化。
        The spec fields take part in change detection too: right after a bridge
        upgrade the first quote may carry the same price as before, and comparing
        bid/ask alone would withhold the spec until the next tick. ts is excluded.
        """
        prev = self._quotes.setdefault(user_id, {})
        changed: list = []
        watched = ("bid", "ask", "contractSize", "tickSize", "tickValue")
        for q in quotes or []:
            sym = q.get("symbol")
            login = q.get("login")
            if not sym or not login:
                continue
            by_symbol = prev.setdefault(login, {})
            old = by_symbol.get(sym)
            if old is None or any(old.get(k) != q.get(k) for k in watched):
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
        # 在线名单登记放到锁外、并丢给线程：它是一次同步 Redis 往返（见
        # _mark_present），在事件循环里直接调会把整个进程卡住最多一个 socket 超时。
        # Presence registration happens outside the lock and off the event loop:
        # it's a synchronous Redis round-trip (see _mark_present), which would
        # otherwise stall the whole process for up to one socket timeout.
        await self._mark_present_async(user_id)

    async def unregister_client(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            conns = self._clients.get(user_id)
            if conns:
                conns.discard(ws)
                if not conns:
                    self._clients.pop(user_id, None)
                    # 人都走了，这几张按 user_id 存的缓存留着只会占内存：进程不重启
                    # 就永远保着"曾经连过的每个用户 × 他当时的持仓/报价条数"。
                    # 重连后下一拍（1.5 秒内）会重新填上，丢掉没有代价。
                    # Nobody left; these per-user caches would otherwise keep one
                    # entry per user who *ever* connected, times their positions
                    # and quotes, until the process restarts. The next tick after
                    # a reconnect (within 1.5s) refills them, so dropping is free.
                    self._last_positions_push.pop(user_id, None)
                    self._last_pending_push.pop(user_id, None)
                    self._positions.pop(user_id, None)
                    self._pending_orders.pop(user_id, None)
                    self._quotes.pop(user_id, None)

    async def push_to_client(self, user_id: str, message: dict) -> None:
        """向指定用户的所有前端连接推送。多 worker 时改为发布到 Redis，由各 worker
        的订阅协程投递到自己的 socket（含本进程）；单 worker 直接本地投递。
        Push to all of a user's connections: publish across workers with Redis,
        deliver locally otherwise."""
        if shared_state.enabled():
            try:
                await _offload(shared_state.publish, WS_CHANNEL, {"user": user_id, "message": message})
                return
            except Exception as e:
                # Redis 不可达：退回本地投递，至少连在本进程的用户不断流。
                # Redis unreachable: fall back to local delivery so this worker's users still get it.
                logger.warning("WS 跨进程转发失败，退回本地投递 / fan-out publish failed, delivering locally: %s", e)
        await self._deliver_local(user_id, message)

    async def _deliver_local(self, user_id: str, message: dict) -> None:
        """向连在**本进程**的该用户连接推送，并顺带清掉发不出去的连接。

        Push to all of a user's client connections, dropping any that fail.

        发送失败几乎只有一个原因：对端已经没了，而 `receive_text()` 那侧的
        disconnect 分支没能触发（进程被杀、网络断开、代理超时都会这样）。
        以前这里是 `except: pass`，死连接会永远留在集合里，之后每一拍推送都对它
        白发一次 —— 持仓每 1.5 秒推一回，积累起来很浪费。

        A send failure essentially means the peer is gone while the disconnect
        branch on the `receive_text()` side never fired (killed process, dropped
        network, proxy timeout). This used to be `except: pass`, which left dead
        sockets in the set forever and re-sent to them on every tick.

        并发发送而不是逐个 await：串行时一个读得慢的客户端会按顺序拖住它后面
        所有连接，广播还会把这个延迟传导到下一个用户。每个发送单独带超时，
        超时与报错一样按死连接处理。
        Sends run concurrently instead of one awaited after another: serially, one
        slow reader holds up every connection behind it, and in a broadcast that
        delay carries over to the next user. Each send carries its own timeout,
        and a timeout is treated exactly like a failure — a dead connection.
        """
        conns = list(self._clients.get(user_id, set()))
        if not conns:
            return
        results = await asyncio.gather(
            *(asyncio.wait_for(ws.send_json(message), SEND_TIMEOUT_SECONDS) for ws in conns),
            return_exceptions=True,
        )
        dead = [ws for ws, outcome in zip(conns, results) if isinstance(outcome, BaseException)]
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

    async def push_pending_orders(
        self, user_id: str, orders: list, source: str = "bridge"
    ) -> None:
        """推送挂单快照（券商服务器上真实挂着的限价/止损单），内容不变则跳过。

        与 POSITIONS 一样是整表替换语义，所以同样要按来源合并后再推：只推本次
        上报的那一部分，会让另一条通道的挂单在前端整批消失又出现。

        Push the snapshot of pending orders living at the broker, skipping unchanged
        ticks. Same whole-table-replace semantics as POSITIONS, hence the same
        merge-across-sources rule: pushing only the reporting path's own slice would
        make the other channel's orders vanish and reappear on the frontend.
        """
        self._pending_orders.setdefault(user_id, {})[source] = orders or []
        merged = self.get_pending_orders(user_id)
        message = {"type": "PENDING_ORDERS", "data": merged}
        payload = json.dumps(message, sort_keys=True, default=str)
        digest = hashlib.blake2b(payload.encode(), digest_size=16).digest()
        if self._last_pending_push.get(user_id) == digest:
            return
        self._last_pending_push[user_id] = digest
        await self.push_to_client(user_id, message)

    async def broadcast_to_clients(self, message: dict) -> None:
        """向所有在线前端广播（如新信号）/ broadcast to all clients (e.g. new signals)."""
        if shared_state.enabled():
            try:
                await _offload(shared_state.publish, WS_CHANNEL, {"user": None, "message": message})
                return
            except Exception as e:
                logger.warning("WS 跨进程广播失败，退回本地 / broadcast publish failed, delivering locally: %s", e)
        await self._broadcast_local(message)

    async def _broadcast_local(self, message: dict) -> None:
        # 用户之间也并发：串行时每个用户最坏要等一个发送超时，在线用户一多，
        # 一条广播的总耗时就是"用户数 × 超时"。
        # Users run concurrently too: serially each one can cost a full send
        # timeout, making a broadcast take users x timeout in the worst case.
        user_ids = list(self._clients.keys())
        if not user_ids:
            return
        await asyncio.gather(
            *(self._deliver_local(user_id, message) for user_id in user_ids),
            return_exceptions=True,
        )

    async def connected_user_ids_async(self) -> list[str]:
        """协程里读在线名单：把同步 Redis 调用挪到线程池。

        `connected_user_ids` 在配了 Redis 时会走一次同步 `set_members`（客户端
        `socket_timeout=2s`）。协程里直接调它，Redis 一抖动就把事件循环整个冻住
        最多 2 秒——而这个名单恰恰被两条高频循环在 async 上下文里反复读：网关慢拍
        每 2 秒一次、事件泵每 0.25 秒一次。

        为什么不是把 `connected_user_ids` 本身改成 `async def`：它还有三个**同步**
        调用方在本次可改范围之外（`routers/bridge.py` 的 `_forget_idle_users`、
        `services/push_dispatch.py:_online_user_ids`、`services/signal_broadcast.py`），
        改签名会当场把它们打断，而那几个文件不归这次改动。所以判定逻辑只保留一份
        （下面那个同步方法），这里只包一层线程池，协程侧的调用方改用它即可。

        Read the roster from a coroutine without blocking the loop.
        `connected_user_ids` makes one synchronous Redis call (client
        socket_timeout=2s) when Redis is on; called straight from a coroutine, a
        Redis hiccup freezes the whole event loop for up to two seconds — and this
        roster is read by two hot loops in async context (the gateway slow tick
        every 2s, the event pump every 250ms).

        Why not make `connected_user_ids` itself `async def`: three *synchronous*
        callers live outside this change's scope (bridge.py's
        `_forget_idle_users`, push_dispatch's `_online_user_ids`,
        signal_broadcast), and changing the signature would break them on the
        spot. So the logic stays in one place — the sync method below — and this
        is just a thread hop for coroutine callers.
        """
        # 没配 Redis 时根本没有阻塞调用（纯字典读），多一次线程调度反而是浪费。
        # Without Redis there is nothing blocking (a dict read); skip the hop.
        if not shared_state.enabled():
            return self.connected_user_ids()
        return await _offload(self.connected_user_ids)

    def connected_user_ids(self) -> list[str]:
        """当前有前端连接的用户 id 列表（多 worker 时含连在其它 worker 的），供按等级
        过滤广播时查询这些用户的 plan。

        **配了 Redis 时这是一次阻塞调用**，协程里请改用 `connected_user_ids_async`。
        Blocking when Redis is on; coroutines should use connected_user_ids_async.

        User ids with an active client connection right now (across workers with
        Redis), so callers can look up these users' plans before a plan-filtered
        broadcast."""
        local = list(self._clients.keys())
        if not shared_state.enabled():
            return local
        try:
            remote = shared_state.set_members(PRESENCE_KEY)
        except Exception as e:
            logger.warning("在线名单读取失败，只用本进程的 / presence read failed, using local only: %s", e)
            return local
        seen = set(local)
        return local + [u for u in remote if u not in seen]

    # ---------- 多 worker 的转发与在线名单 / cross-worker fan-out & presence ----------
    def _mark_present(self, *user_ids: str) -> None:
        """登记若干用户在线。**同步阻塞**，协程里请走 _mark_present_async。
        Register users as present. Blocking; coroutines use _mark_present_async."""
        if not shared_state.enabled():
            return
        for user_id in user_ids:
            try:
                shared_state.set_add(PRESENCE_KEY, user_id, PRESENCE_TTL_SECONDS)
            except Exception as e:
                logger.warning("在线名单写入失败 / presence write failed: %s", e)

    async def _mark_present_async(self, *user_ids: str) -> None:
        """一次线程往返登记这一批用户：整批在同一个线程里写完，而不是每人一次
        to_thread——续期循环一跑就是全部在线用户，每人一次线程调度太浪费。
        One thread hop for the whole batch rather than one per user: the refresh
        loop walks every online user, and a hop each would be pure overhead."""
        if not shared_state.enabled() or not user_ids:
            return
        await _offload(self._mark_present, *user_ids)

    async def refresh_presence_loop(self) -> None:
        """每 30 秒把本进程连着的用户续一次期（90 秒过期），进程死了名单自然掉。
        Renew this worker's users every 30s (90s expiry); a dead worker's entries lapse."""
        while True:
            await asyncio.sleep(PRESENCE_REFRESH_SECONDS)
            await self._mark_present_async(*list(self._clients.keys()))

    async def handle_fanout_message(self, raw: str) -> None:
        """处理一条来自 Redis 频道的转发消息（也供测试直接调用）。
        Handle one fan-out message from the channel (also called directly by tests)."""
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return
        message = data.get("message")
        if not isinstance(message, dict):
            return
        user_id = data.get("user")
        if user_id is None:
            await self._broadcast_local(message)
        elif user_id in self._clients:
            await self._deliver_local(str(user_id), message)

    async def run_fanout_subscriber(self) -> None:
        """订阅 Redis 频道并投递到本进程的 socket；断线后 3 秒重连。
        Subscribe to the channel and deliver locally; reconnect 3s after a drop."""
        while True:
            pubsub = client = None
            try:
                sub = shared_state.new_async_pubsub(WS_CHANNEL, with_client=True)
                if sub is None:
                    return
                pubsub, channel, client = sub
                await pubsub.subscribe(channel)
                async for msg in pubsub.listen():
                    if msg.get("type") != "message":
                        continue
                    await self.handle_fanout_message(msg.get("data") or "")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("WS 转发订阅中断，3 秒后重连 / fan-out subscriber dropped, reconnecting in 3s: %s", e)
                await asyncio.sleep(3)
            finally:
                # 每一轮都新建了一个客户端（连接池），不关掉的话 Redis 每抖动一次
                # 就多留一组连接——一段不稳定期下来连接数线性堆高，最后撞上
                # maxclients。异常路径也要走到，所以放在 finally 而不是循环末尾。
                # Each pass created a fresh client (and pool); leaving it open
                # means one more set of connections per Redis wobble, growing
                # linearly through an unstable spell until maxclients is hit. It
                # has to run on the error path too, hence finally.
                await self._close_pubsub(pubsub, client)

    @staticmethod
    async def _close_pubsub(pubsub, client) -> None:
        for obj in (pubsub, client):
            if obj is None:
                continue
            try:
                await obj.aclose()
            except Exception as e:      # 关闭失败不该把订阅循环带下去 / never let cleanup kill the loop
                logger.debug("关闭 Redis 订阅连接失败 / closing pubsub connection failed: %s", e)

    def start_cross_worker_tasks(self) -> list[asyncio.Task]:
        """多 worker 时每个进程都要跑的两条协程；单 worker 返回空列表。
        The two per-worker coroutines needed with Redis; empty without it."""
        if not shared_state.enabled():
            return []
        return [
            asyncio.create_task(self.run_fanout_subscriber(), name="ws:fanout"),
            asyncio.create_task(self.refresh_presence_loop(), name="ws:presence"),
        ]


manager = ConnectionManager()
