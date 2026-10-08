"""连接管理器：维护 user_id 与前端 WebSocket 的映射。
Connection manager: maps user_id to client WebSocket connections.
"""
import asyncio
import hashlib
import json
import logging
import time

import anyio.to_thread
from fastapi import WebSocket

from app.services import quotes_store, shared_state

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
PRESENCE_REFRESH_SECONDS_RENEW = PRESENCE_REFRESH_SECONDS

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

# 每条连接自己的发件队列深度。持仓帧可达几十 KB，一条卡住的连接囤的帧越多内存越大，
# 所以取得浅：队列满就说明这条连接已经落后十几拍（持仓 1.5~2 秒一拍），按死连接摘掉并
# 关闭，让前端重连拿一份完整快照——比继续攒着强。真正的「卡住」通常在队列满之前就被写协程
# 里的 SEND_TIMEOUT_SECONDS 超时判死。
# Depth of each connection's own outbox. Positions frames can reach tens of KB, so a stuck
# connection must not hoard many: a full queue means it is a dozen ticks behind, and it is
# dropped (and closed) so the frontend reconnects to a full snapshot. A truly stuck socket
# usually hits the writer's SEND_TIMEOUT_SECONDS before the queue ever fills.
OUTBOX_MAXSIZE = 12

# 远端在线名单（别的 worker 上有谁连着）的刷新间隔，以及「多久没刷新成功就不敢信」。
# 名单只用来做一件事：判断一条推送**可能**有别的 worker 上的接收者，从而决定要不要走 Redis
# 转发。读不到 / 太旧 = 不知道 = 照常转发（宁多勿少）。
# How often the remote roster (who is connected on *other* workers) is refreshed, and how old
# it may get before it is distrusted. It decides one thing only: whether a push may have a
# receiver on another worker and so must go through Redis. Unreadable or too old means
# "unknown", which means publish as usual (better too many than too few).
PRESENCE_VIEW_REFRESH_SECONDS = 2
PRESENCE_VIEW_MAX_AGE_SECONDS = 10

# 订阅断线后的重连节奏：第一次立刻重连，连续失败才退避，成功一次归零。
# Fan-out subscriber reconnect pacing: immediately the first time, backing off only on
# consecutive failures, reset by one success.
FANOUT_RECONNECT_BACKOFF_SECONDS = (0.0, 0.2, 0.5, 1.0, 3.0)
# 重订阅后补推本进程用户快照时的并发上限。/ Concurrency cap for the post-resubscribe catch-up.
RESYNC_CONCURRENCY = 16

# 多 worker 下的持仓 / 挂单 / 分账户报价共享（配了 REDIS_URL 才启用）。
#
# 进程内的缓存只装得下「本进程收到过的上报」：网关的持仓与挂单轮询只在抢到领导锁
# 的那个 worker 上跑，桥接的 /bridge/positions、/bridge/quotes 每拍随机落到某个
# worker。于是
#   · 一键平仓的请求落到另一个 worker 时，那边的持仓快照是空的，接口回「当前没有
#     可平仓的持仓」——两个 worker 就是一半概率；
#   · 同时绑了桥接和网关账号的用户，两个 worker 各自拿「自己那半」合并推送，另一路
#     的持仓 / 挂单行在前端来回闪；
#   · 刷新页面连到另一个 worker，补推的持仓、挂单、报价是空的或旧的；
#   · 分账户报价按「与本进程上次相比变没变」决定推不推：价格在 A 上从 X 变 Y、
#     在 B 上又变回 X 时，B 记得的还是 X，认为没变，前端就停在 Y 上。
# 所以持仓与挂单按来源分键镜像到 Redis（两条上报路径各写各的键，不存在读改写
# 竞争），分账户报价放进每个用户一张 Redis hash；合并、变化判断与补推都以 Redis
# 为准，Redis 不可达时退回本进程那份。
# 过期时间给得宽：来源停报（EA 掉线、用户断开后网关停轮询）时，旧行为是本进程一直
# 留着最后一份，这里保持「留一阵」而不是两拍后就清空。
#
# Cross-worker positions / pending orders / per-account quotes (only with
# REDIS_URL). In-process caches only hold reports this process received: the
# gateway polls run on the leader alone and bridge reports land on whichever
# worker. Close-all on the other worker found nothing ("no open positions"),
# users with both bridge and gateway accounts saw one source's rows flicker, a
# reconnect to the other worker got an empty catch-up, and per-account quotes
# could stick at a stale price because change detection compared against this
# process's memory only. Positions and pending orders are mirrored per source to
# their own Redis keys (no read-modify-write race); per-account quotes live in one
# Redis hash per user. Merges, change detection and catch-ups prefer Redis and
# fall back to the local copy when Redis is unreachable.
SNAPSHOT_SOURCES = ("bridge", "gateway")
SNAPSHOT_TTL_SECONDS = 600
# kind -> Redis 键模板 / key template per snapshot kind
_SNAPSHOT_KEYS = {
    "positions": "positions:{user}:{source}",
    "pending": "pending:{user}:{source}",
}
# 分账户报价：hash 字段是 "<login>|<symbol>"（login 是纯数字，不会含 "|"）。
# 桥接约每秒报一次，一小时没报就当这批报价作废。
# Per-account quotes: hash fields are "<login>|<symbol>" (logins are digits and
# never contain "|"). Bridges report about once a second; an hour of silence
# retires the whole set.
QUOTES_KEY = "uquotes:{user}"
QUOTES_TTL_SECONDS = 3600
# 本进程快照兜底的回收节奏（秒），见 ConnectionManager._maybe_prune_local。
# How often local fallback snapshots are swept; see _maybe_prune_local.
LOCAL_PRUNE_EVERY = 60.0
# 持仓 / 挂单快照内容没变时，最多隔这么久也要重推一次（秒）。去重摘要只活在发起推送的那个
# worker（gateway 慢拍只在 leader 上跑）；客户端重连落到另一个 worker 时，register_client 清的是
# 那边的摘要，leader 上的旧摘要会把「内容没变」的快照一直挡住。最典型的是空仓：最后一张单平掉时
# 推出去的 [] 发给了已经死掉的旧连接，新连接的建连补推又不发空快照，App 就一直挂着那张早已平掉
# 的单（2026-10-08 100502「止损高开没打掉」）。定期重推给它一个最长等待时间；空仓用户一帧几十字节。
# Re-push an unchanged positions / pending snapshot at least this often (seconds). The dedup
# digest lives only on the pushing worker (the gateway slow tick runs on the leader), so a client
# reconnecting to another worker clears the wrong digest and the leader keeps suppressing the
# "unchanged" snapshot — classically the empty one: the [] pushed when the last position closed
# went to a dead socket, the new socket's catch-up skips empty snapshots, and the app kept showing
# a long-closed position (2026-10-08, login 100502). This bounds the wait; a flat user's frame is
# a few dozen bytes.
SNAPSHOT_REPUSH_SECONDS = 15.0
# 参与「报价变没变」判断的字段 / fields that count toward "quote changed"
_QUOTE_WATCHED = ("bid", "ask", "contractSize", "tickSize", "tickValue")


def _snapshot_key(kind: str, user_id: str, source: str) -> str:
    return _SNAPSHOT_KEYS[kind].format(user=user_id, source=source)


def _merge_sources(by_source: dict[str, list]) -> list:
    merged: list = []
    for rows in by_source.values():
        merged.extend(rows)
    return merged


def _quote_changed(old: dict | None, q: dict) -> bool:
    return old is None or any(old.get(k) != q.get(k) for k in _QUOTE_WATCHED)


def _decode_rows(raw) -> list | None:
    """Redis 里的一份快照（JSON 文本）→ 行列表；缺失 / 坏数据 / 不是列表都返回 None。
    A stored snapshot (JSON text) -> rows; None when missing, corrupt or not a list."""
    if raw is None:
        return None
    try:
        rows = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return rows if isinstance(rows, list) else None


def _decode_account_quotes(raw_map) -> list:
    """按账户报价的 hash（field -> JSON）→ 报价列表，坏值跳过。
    The per-account quotes hash (field -> JSON) -> quote list, bad values skipped."""
    out: list = []
    for v in (raw_map or {}).values():
        try:
            q = json.loads(v)
        except (ValueError, TypeError):
            continue
        if isinstance(q, dict):
            out.append(q)
    return out


def _decode_global_quotes(order_raw, raw_map) -> list:
    """全站报价（顺序表 + hash）→ 按首次出现顺序的列表；与 quotes_store._all_redis 同口径。
    Site-wide quotes (order list + hash) in first-seen order; same rules as
    quotes_store._all_redis."""
    quotes: dict[str, dict] = {}
    for sym, v in (raw_map or {}).items():
        try:
            quotes[sym] = json.loads(v)
        except (ValueError, TypeError):
            continue
    order = list(dict.fromkeys(order_raw or []))
    seen = set(order)
    order += [s for s in quotes if s not in seen]
    return [quotes[s] for s in order if s in quotes]


def _presence_user(member: str) -> tuple[str | None, str]:
    """在线名单成员 -> (所属 worker, user_id)。老格式（裸 user_id，滚动发布期间旧 worker 写的）
    返回 (None, member)。
    A roster member -> (owning worker, user_id). The legacy bare-user-id shape, written by old
    workers during a rolling deploy, gives (None, member)."""
    worker, sep, user = member.partition("|")
    if not sep:
        return None, member
    return worker, user


class _Outbox:
    """一条连接自己的发件队列与常驻写协程。/ One connection's outbox and its writer task."""

    __slots__ = ("queue", "task")

    def __init__(self, queue: "asyncio.Queue[str]", task: "asyncio.Task") -> None:
        self.queue = queue
        self.task = task


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

    走 anyio 的默认线程池（main.py 启动时调到 256 条），不走 asyncio.to_thread：后者用
    的是 loop 的默认 executor，只有 min(32, CPU+4) 条——生产 2 核就是 6 条。Redis 一慢，
    6 条线程全卡在 socket 上，其余所有 to_thread（推送、在线名单、快照镜像）一起排队。
    abandon_on_cancel=True 保持 asyncio.to_thread 的取消语义：等待方被取消时立刻抛出，
    不陪着线程等完这一次往返。
    Uses anyio's default pool (raised to 256 in main.py) instead of
    asyncio.to_thread, whose loop executor holds min(32, CPU+4) threads — six on
    the 2-core production box, all of which a slow Redis can pin at once.
    abandon_on_cancel=True keeps asyncio.to_thread's cancellation behaviour.
    """
    return await anyio.to_thread.run_sync(fn, *args, abandon_on_cancel=True)


async def run_blocking(fn, *args):
    """_offload 的公开名，供别的模块把同步 Redis 调用挪出事件循环（见 _offload）。
    Public name of _offload for other modules (see _offload)."""
    return await _offload(fn, *args)


# ---------- redis.asyncio 单例 / the redis.asyncio singleton ----------
#
# 推送（publish）和在线名单（ZSET 读写）是最高频的两类 Redis 调用：持仓每 1.5 秒
# 每个在线用户一次 publish。原来每一次都是「同步客户端 + 一次线程调度」，线程池一
# 忙起来推送就跟着排队。这两类改走 redis.asyncio，事件循环上直接 await，不占线程。
#
# 生命周期：由 start_cross_worker_tasks（lifespan 启动时调）在主事件循环上建，
# 配套的 ws:aredis 任务在关停被 cancel 时关掉它。客户端绑定在建它的那个事件循环上，
# 别的循环（run_on_main_loop 退回 asyncio.run 的脚本 / 单测场景）拿不到它，自动退回
# 「同步客户端 + 线程池」的老路径，行为不变。
# 测试里 shared_state 注入的是同步替身（tests/fake_redis.py），那时也不建异步客户端，
# 同样走老路径；异步路径的用例用 _install_async_redis 注入替身。
#
# Publish and the presence ZSET are the hottest Redis calls (one publish per online
# user every 1.5s for positions). Each used to cost a sync call plus a thread hop,
# queueing behind a busy pool. They now use redis.asyncio, awaited on the loop.
# Lifecycle: built on the main loop by start_cross_worker_tasks (called from the
# lifespan), closed by the companion ws:aredis task when it is cancelled at
# shutdown. The client is bound to the loop that built it; any other loop (the
# asyncio.run fallback in scripts/tests) doesn't see it and takes the old
# sync-client-plus-thread path unchanged. With a sync test double injected into
# shared_state no async client is built either; tests of the async path inject one
# via _install_async_redis.

# 连接池上限与取连接的等待：推送并发起来时最多占 64 条连接，排不到 2 秒就报错，
# 由调用方退回本地投递——而不是无上限地开连接直到撞上 Redis 的 maxclients。
# Pool cap and checkout wait: at most 64 connections under a push burst; after 2s
# without one the call fails and the caller falls back to local delivery, rather
# than opening connections without bound until Redis hits maxclients.
ASYNC_REDIS_MAX_CONNECTIONS = 64
ASYNC_REDIS_TIMEOUT_SECONDS = 2.0

_aredis_client = None
_aredis_loop: asyncio.AbstractEventLoop | None = None


def _async_redis():
    """当前事件循环上可用的 redis.asyncio 客户端；没有则 None（调用方走线程池老路径）。
    The redis.asyncio client for the running loop, or None (callers use the thread path)."""
    if _aredis_client is None:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    return _aredis_client if loop is _aredis_loop else None


def _install_async_redis(client, loop: asyncio.AbstractEventLoop | None = None) -> None:
    """登记异步客户端（生产由 _start_async_redis 调；测试直接注入替身）。None 表示清空。
    Register the async client (called by _start_async_redis; tests inject a double)."""
    global _aredis_client, _aredis_loop
    _aredis_client = client
    _aredis_loop = (loop or asyncio.get_running_loop()) if client is not None else None


def _start_async_redis() -> bool:
    """在当前（主）事件循环上建 redis.asyncio 客户端。建不了就返回 False，一切照旧走线程池。
    Build the redis.asyncio client on the current (main) loop; False keeps the thread path."""
    if not shared_state.enabled() or _aredis_client is not None:
        return False
    try:
        import redis
        import redis.asyncio as aioredis
        from redis.exceptions import ConnectionError as RedisConnectionError

        injected = shared_state._redis_client
        if injected is not None and not isinstance(injected, redis.Redis):
            # shared_state 里是测试替身：异步客户端连的会是一台不存在的 Redis。
            # A test double sits in shared_state; an async client would dial nothing real.
            return False
        pool = aioredis.BlockingConnectionPool.from_url(
            shared_state.redis_url(),
            decode_responses=True,
            max_connections=ASYNC_REDIS_MAX_CONNECTIONS,
            timeout=ASYNC_REDIS_TIMEOUT_SECONDS,
            socket_timeout=ASYNC_REDIS_TIMEOUT_SECONDS,
            socket_connect_timeout=ASYNC_REDIS_TIMEOUT_SECONDS,
            # 只对 ConnectionError 重试 1 次（Redis 重启 / 连接被掐的那一瞬间），不对超时重试。
            # One retry on ConnectionError only (a restart / a cut connection), never on timeouts.
            retry=shared_state.redis_retry(1, async_client=True),
            retry_on_error=[RedisConnectionError],
            health_check_interval=shared_state.REDIS_HEALTH_CHECK_INTERVAL_SECONDS,
        )
        _install_async_redis(aioredis.Redis.from_pool(pool))
        return True
    except Exception as e:
        logger.warning("redis.asyncio 客户端初始化失败，推送继续走线程池 / async redis init failed, using the thread path: %s", e)
        return False


async def _close_async_redis() -> None:
    client = _aredis_client
    _install_async_redis(None)
    if client is None:
        return
    try:
        await client.aclose()
    except Exception as e:      # 关停路径上不抛 / never raise on shutdown
        logger.debug("关闭 redis.asyncio 客户端失败 / closing async redis failed: %s", e)


async def _hold_async_redis() -> None:
    """什么都不做，只在被 cancel（关停）时把异步客户端关掉。
    Does nothing but close the async client when cancelled at shutdown."""
    try:
        await asyncio.Event().wait()
    finally:
        await _close_async_redis()


# ---------- 跨进程转发的消息格式 / fan-out wire format ----------
#
# 以前每条消息都是 json.dumps({"from":…, "user":…, "message":{…}})，而**每个** worker
# 都订阅同一个频道：一条只给某个用户的持仓快照（可达几十 KB），N 个 worker 各自完整
# json.loads 一遍，再发现这个用户根本不连在自己这里。
# 现在信封的键顺序固定、目标放在最前面：
#   {"user":"<id>","message":{…}}                 定向
#   {"user":null,"message":{…}}                   广播
#   {"user":"*","users":["a","b"],"message":{…}}  多目标（如按等级过滤后的新信号）
# 收到后先只解码开头那一小段（目标），不在本地就直接丢，message 一个字节都不解析；
# 在本地时 message 那一段本身就是合法 JSON 文本，原样 send_text 出去，也不必解析再
# 序列化。
# 它仍然是合法 JSON：灰度期间还没升级的老 worker 照旧 json.loads，定向/广播两种照常
# 投递；多目标那种老 worker 读到的 user 是 "*"，不是任何人的 id，会被安全地丢掉
# （不会误投给不该收的人）。反过来，新 worker 解不出这个前缀时（老 worker 发来的
# {"from":…} 格式）退回完整 json.loads，两种格式都认。
#
# Every message used to be json.dumps({"from", "user", "message"}), and every worker
# subscribes to the channel, so each one fully parsed a per-user snapshot (tens of
# KB) only to find the user wasn't connected there. The envelope now has a fixed
# key order with the target first; a receiver decodes just that head and drops the
# message untouched when the target isn't local, and when it is, the message slice
# is already valid JSON text and goes out via send_text as is. It is still valid
# JSON, so old workers during a rolling deploy parse it as before (a multi-target
# envelope reads as user "*", which matches nobody and is safely dropped); new
# workers fall back to a full json.loads for the old {"from", ...} shape.

_ENV_USER = '{"user":'
_ENV_USERS = ',"users":'
_ENV_MESSAGE = ',"message":'
_MULTI_TARGET = "*"
_decoder = json.JSONDecoder()


def _dumps(message: dict) -> str:
    """推给前端的文本：与 starlette 的 send_json 同一种紧凑写法（ensure_ascii=False），
    外加 default=str（跨进程那条路一直是这么序列化的）。
    Frontend text, serialized exactly like starlette's send_json, plus default=str
    (which the cross-worker path always used)."""
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False, default=str)


def _envelope(user_id: str | None, text: str, users: list[str] | None = None) -> str:
    head = _ENV_USER + json.dumps(user_id, ensure_ascii=False)
    if users is not None:
        head += _ENV_USERS + json.dumps(users, separators=(",", ":"), ensure_ascii=False)
    return head + _ENV_MESSAGE + text + "}"


def _peek_envelope(raw: str):
    """只解码信封开头的目标部分，返回 (user, users, message 文本)；不是新格式返回 None。
    Decode only the envelope's target head: (user, users, message text), or None."""
    if not raw.startswith(_ENV_USER):
        return None
    try:
        user, i = _decoder.raw_decode(raw, len(_ENV_USER))
        users = None
        if raw.startswith(_ENV_USERS, i):
            users, i = _decoder.raw_decode(raw, i + len(_ENV_USERS))
            if not isinstance(users, list):
                return None
        if not raw.startswith(_ENV_MESSAGE, i):
            return None
    except ValueError:
        return None
    start = i + len(_ENV_MESSAGE)
    if not (raw.endswith("}") and raw.startswith("{", start)):
        return None
    if user is not None and not isinstance(user, str):
        return None
    return user, users, raw[start:-1]


_QUOTE_FRAME_PREFIXES = ('{"type":"QUOTES"', '{"type":"GLOBAL_QUOTES"')


class ConnectionManager:
    def __init__(self) -> None:
        # 前端在后台时（PING 带 bg:true）标记的连接：只存本进程内存，不碰 Redis；
        # 全站/按账户报价帧对它们跳过，其余帧照发。空集合时投递路径零额外开销。
        # Connections whose page is in the background (PING carries bg:true):
        # in-process only, no Redis. Quote frames skip them, everything else is
        # delivered. An empty set costs the delivery path nothing.
        self._background: set[WebSocket] = set()
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
        self._last_positions_push: dict[str, tuple[bytes, float]] = {}
        # 同上，PENDING_ORDERS 那一路。挂单在休市/无操作时长时间一动不动，
        # 重复帧比持仓还多，去重的收益更大。
        # Same for PENDING_ORDERS. Pending orders sit unchanged for long stretches,
        # so this skips even more repeat frames than the positions one.
        self._last_pending_push: dict[str, tuple[bytes, float]] = {}
        # user_id -> {(kind, source): 上次写进 Redis 的那份快照的摘要}。内容没变就不再 SET，只续期。
        # user_id -> {(kind, source): digest of the slice last written to Redis}; unchanged
        # content is refreshed with EXPIRE instead of rewritten.
        self._mirrored: dict[str, dict[tuple[str, str], bytes]] = {}
        # websocket -> 发件队列 / websocket -> its outbox
        self._outboxes: dict[WebSocket, _Outbox] = {}
        # 死连接收尾（关 socket）的后台任务，持有引用防止被 GC。
        # Background tasks that close dropped sockets; held so they aren't garbage collected.
        self._reap_tasks: set[asyncio.Task] = set()
        # 在线名单里的身份。默认是本进程的 WORKER_ID；同进程模拟多个 worker 的测试可以覆盖。
        # Identity in the presence roster; tests that simulate several workers in one process
        # may override it.
        self._worker_id: str = shared_state.WORKER_ID
        # 「连在**别的** worker 上的用户」视图，由 refresh_presence_loop 每 2 秒刷新。
        # None = 还没读到过。见 _route。
        # Users connected on *other* workers, refreshed every 2s by refresh_presence_loop. None
        # until first read. See _route.
        self._remote_users: set[str] = set()
        self._remote_at: float | None = None
        # 最近一次成功读到的全站报价，Redis 抖动时建连补推退回这一份。
        # The last site-wide quotes read successfully; connect catch-up falls back to it.
        self._last_global_quotes: list = []
        # 本进程快照的写入时刻（monotonic）：user_id -> {(kind, source): t}，报价按用户一份。
        # 本进程这份只是 Redis 的兜底，而它以前只在用户最后一条 WS 断开时才清——只走桥接
        # 上报、从不开页面的用户永远不清；Redis 里的键过期之后，补缺时还会把很久以前的
        # 持仓当成当前的用上。所以兜底只采信不比 Redis TTL 更老的那份（见 _fresh_local），
        # 写入时顺带按同样的年龄回收没有连接的用户（见 _maybe_prune_local）。
        # Write time of each local slice: user_id -> {(kind, source): t}; quotes per
        # user. The local copy is Redis's fallback, yet it was only released when the
        # user's last WS left — bridge-only users never — and once the Redis keys
        # expired, stale local positions were served as current. Fallback now only
        # trusts slices no older than the Redis TTL, and idle users are reclaimed.
        self._local_at: dict[str, dict[tuple[str, str], float]] = {}
        self._quotes_at: dict[str, float] = {}
        self._pruned_at: float = time.monotonic()
        self._lock = asyncio.Lock()

    # ---------- 持仓 / 挂单快照 / Positions & pending-orders snapshots ----------
    def _local(self, kind: str) -> dict[str, dict[str, list]]:
        return self._positions if kind == "positions" else self._pending_orders

    def _fresh_local(self, kind: str, user_id: str) -> dict[str, list]:
        """本进程该用户各来源的快照，只留不比 SNAPSHOT_TTL_SECONDS 更老的（与 Redis 键同寿）。
        没有写入时刻记录的（直接塞进来的旧条目）当作新鲜。
        This process's per-source slices no older than the Redis TTL; a slice
        without a recorded write time counts as fresh."""
        local = self._local(kind).get(user_id) or {}
        if not local:
            return {}
        stamps = self._local_at.get(user_id) or {}
        now = time.monotonic()
        return {
            src: rows for src, rows in local.items()
            if now - stamps.get((kind, src), now) <= SNAPSHOT_TTL_SECONDS
        }

    def _stamp_local(self, kind: str, user_id: str, source: str) -> None:
        self._local_at.setdefault(user_id, {})[(kind, source)] = time.monotonic()
        self._maybe_prune_local()

    def _local_quotes_fresh(self, user_id: str) -> bool:
        at = self._quotes_at.get(user_id)
        return at is None or time.monotonic() - at <= QUOTES_TTL_SECONDS

    def _maybe_prune_local(self, force: bool = False) -> None:
        """回收本进程里过期的快照与没有连接用户的去重状态（最多每 LOCAL_PRUNE_EVERY 秒一趟）。
        Reclaim stale local slices and idle users' de-dup state, at most every
        LOCAL_PRUNE_EVERY seconds."""
        now = time.monotonic()
        if not force and now - self._pruned_at < LOCAL_PRUNE_EVERY:
            return
        self._pruned_at = now
        users = (
            set(self._positions) | set(self._pending_orders) | set(self._quotes)
            | set(self._last_positions_push) | set(self._last_pending_push)
            | set(self._mirrored) | set(self._local_at) | set(self._quotes_at)
        )
        for uid in users:
            stamps = self._local_at.get(uid) or {}
            for kind in ("positions", "pending"):
                slices = self._local(kind).get(uid)
                if not slices:
                    continue
                for src in list(slices):
                    at = stamps.get((kind, src))
                    if at is None:
                        # 没有记录的旧条目：从现在起计时 / start the clock now
                        stamps[(kind, src)] = now
                        self._local_at[uid] = stamps
                    elif now - at > SNAPSHOT_TTL_SECONDS:
                        slices.pop(src, None)
                        stamps.pop((kind, src), None)
                if not slices:
                    self._local(kind).pop(uid, None)
            if uid in self._quotes:
                at = self._quotes_at.get(uid)
                if at is None:
                    self._quotes_at[uid] = now
                elif now - at > QUOTES_TTL_SECONDS:
                    self._quotes.pop(uid, None)
                    self._quotes_at.pop(uid, None)
            if uid in self._clients:
                continue
            # 没有连接、本进程也没有任何还新鲜的快照：去重摘要与写入记录一并丢掉。
            # 再出现时当首次观测处理（多推一帧 / 多写一次），不会漏推。
            # No connection and nothing fresh left: drop the digests and stamps too;
            # a returning user is a first observation (one extra frame, never a miss).
            if uid not in self._positions and uid not in self._pending_orders:
                self._last_positions_push.pop(uid, None)
                self._last_pending_push.pop(uid, None)
                self._mirrored.pop(uid, None)
                self._local_at.pop(uid, None)
            if uid not in self._quotes:
                self._quotes_at.pop(uid, None)

    def get_positions(self, user_id: str) -> list:
        """**本进程**收到的持仓，全部来源合并。跨 worker 的读取用 get_positions_shared。
        Positions this process received, merged across sources. For the
        cross-worker view use get_positions_shared."""
        return _merge_sources(self._fresh_local("positions", user_id))

    def get_pending_orders(self, user_id: str) -> list:
        """**本进程**收到的挂单，全部来源合并。跨 worker 的读取用 get_pending_orders_shared_async。
        Pending orders this process received, merged across sources."""
        return _merge_sources(self._fresh_local("pending", user_id))

    def _shared_by_source(
        self, kind: str, user_id: str, skip: str | None = None
    ) -> dict[str, dict | list]:
        """按来源取 Redis 里的快照，缺的来源用本进程那份补（**同步**，会阻塞）。

        没配 Redis 时就是本进程的快照。某来源在 Redis 里没有键（从没上报过、已过期、
        或镜像写失败）而本进程有，用本地的。`skip` 的来源不去 Redis 读——调用方手里
        已经有它最新的那份。
        Per-source snapshot from Redis, gaps filled from this process's copy
        (synchronous; blocks). Without Redis it is just the local copy. `skip`
        names a source the caller already holds fresh, so it isn't re-read.
        """
        local = self._fresh_local(kind, user_id)
        if not shared_state.enabled():
            return local
        shared: dict[str, list] = {}
        try:
            for source in SNAPSHOT_SOURCES:
                if source == skip:
                    continue
                rows = shared_state.kv_get_json(_snapshot_key(kind, user_id, source))
                if isinstance(rows, list):
                    shared[source] = rows
        except Exception as e:
            logger.warning("读取共享快照失败，退回本进程快照 / shared %s read failed: %s", kind, e)
            return local
        for source, rows in local.items():
            shared.setdefault(source, rows)
        return shared

    def _mirror_pipeline_sync(
        self, kind: str, user_id: str, source: str, own_text: str, unchanged: bool
    ) -> list:
        """同步版：一个 pipeline 完成「写（或续期）本来源的键 + 读其它来源的键」，返回结果列表；
        续期返回 0（键在 Redis 里已经没了：重启 / 驱逐）时补一次 SET。放线程里跑。
        Sync flavour: one pipeline writes (or refreshes) this source's key and reads the others,
        returning the results; when EXPIRE reports 0 (the key is gone from Redis — restart or
        eviction) a SET follows. Run it on a thread."""
        r = shared_state._redis()
        own_key = shared_state._k(_snapshot_key(kind, user_id, source))
        pipe = r.pipeline(transaction=False)
        if unchanged:
            pipe.expire(own_key, SNAPSHOT_TTL_SECONDS)
        else:
            pipe.set(own_key, own_text, ex=SNAPSHOT_TTL_SECONDS)
        for other in SNAPSHOT_SOURCES:
            if other != source:
                pipe.get(shared_state._k(_snapshot_key(kind, user_id, other)))
        results = pipe.execute()
        if unchanged and not results[0]:
            r.set(own_key, own_text, ex=SNAPSHOT_TTL_SECONDS)
        return results

    async def _mirror_pipeline_async(
        self, client, kind: str, user_id: str, source: str, own_text: str, unchanged: bool
    ) -> list:
        """异步版：同上，直接在事件循环上 await，不占线程。
        Async flavour: same, awaited on the loop with no thread."""
        own_key = shared_state._k(_snapshot_key(kind, user_id, source))
        pipe = client.pipeline(transaction=False)
        if unchanged:
            pipe.expire(own_key, SNAPSHOT_TTL_SECONDS)
        else:
            pipe.set(own_key, own_text, ex=SNAPSHOT_TTL_SECONDS)
        for other in SNAPSHOT_SOURCES:
            if other != source:
                pipe.get(shared_state._k(_snapshot_key(kind, user_id, other)))
        results = await pipe.execute()
        if unchanged and not results[0]:
            await client.set(own_key, own_text, ex=SNAPSHOT_TTL_SECONDS)
        return results

    async def _store_and_merge(self, kind: str, user_id: str, source: str, rows: list) -> list:
        """记下本来源的最新快照，返回全部来源合并后的完整列表。

        配了 Redis 时：本来源的 rows 只序列化一遍；内容与上次写进 Redis 的相同就**不再 SET**，
        改成每拍把「EXPIRE 本来源的键」和「GET 其它来源的键」放进同一个 pipeline（仍是 1 次往返），
        EXPIRE 返回 0（键已经不在了）再补一次 SET——既省掉休市 / 无持仓时的整份写，又不会因为
        Redis 重启 / 驱逐把键丢了而让别的 worker（一键平仓走共享读）读到空。有异步客户端时直接
        在事件循环上 await，否则一次线程往返。任何 Redis 错误整体退回本进程的快照。

        Record this source's latest slice and return the full merged list. With Redis the rows
        are serialized once, and content identical to what was last written is not SET again:
        each tick pipelines EXPIRE on this source's key with GET on the others (still one
        round-trip), with a SET only when EXPIRE says the key is gone — saving the full write
        while the market is closed without letting a Redis restart or eviction leave other
        workers (close-all reads the shared copy) staring at nothing. Any Redis error falls back
        to this process's snapshots as a whole.
        """
        local = self._local(kind)
        local.setdefault(user_id, {})[source] = rows
        self._stamp_local(kind, user_id, source)
        if not shared_state.enabled():
            return _merge_sources(self._fresh_local(kind, user_id))
        own_text = json.dumps(rows, ensure_ascii=False, default=str)
        digest = hashlib.blake2b(own_text.encode(), digest_size=16).digest()
        mirrored = self._mirrored.setdefault(user_id, {})
        unchanged = mirrored.get((kind, source)) == digest
        try:
            client = _async_redis()
            if client is not None:
                results = await self._mirror_pipeline_async(client, kind, user_id, source, own_text, unchanged)
            else:
                results = await _offload(self._mirror_pipeline_sync, kind, user_id, source, own_text, unchanged)
        except Exception as e:
            logger.warning("写/读共享快照失败，退回本进程快照 / shared %s mirror failed, using local: %s", kind, e)
            mirrored.pop((kind, source), None)
            return _merge_sources(self._fresh_local(kind, user_id))
        mirrored[(kind, source)] = digest
        # 与 _shared_by_source 同一套规则：其它来源以 Redis 为准，Redis 没有的用本进程那份补，
        # 最后本来源覆盖成刚收到的 rows。
        # Same rules as _shared_by_source: other sources from Redis, gaps from the local copy,
        # and this source last, as just received.
        by_source: dict[str, list] = {}
        others = [o for o in SNAPSHOT_SOURCES if o != source]
        for other, raw in zip(others, results[1:]):
            decoded = _decode_rows(raw)
            if decoded is not None:
                by_source[other] = decoded
        for src, src_rows in self._fresh_local(kind, user_id).items():
            by_source.setdefault(src, src_rows)
        by_source[source] = rows
        return _merge_sources(by_source)

    def get_positions_shared(self, user_id: str) -> list:
        """全部 worker 视角下该用户的最新持仓（**同步**，同步端点里直接调）。

        一键平仓必须用这个而不是 get_positions：请求落到哪个 worker 是随机的，
        本进程的快照可能压根没有网关那一路。
        The user's latest positions as seen across every worker (synchronous; for
        sync endpoints). Close-all needs this, not get_positions: the request may
        land on a worker that never received the gateway slice.
        """
        return _merge_sources(self._shared_by_source("positions", user_id))

    async def get_positions_shared_async(self, user_id: str) -> list:
        """同上，协程里用（Redis 调用挪出事件循环）。/ Same, for coroutines."""
        if not shared_state.enabled():
            return self.get_positions(user_id)
        return await _offload(self.get_positions_shared, user_id)

    async def get_pending_orders_shared_async(self, user_id: str) -> list:
        """全部 worker 视角下该用户的最新挂单（协程）。/ Cross-worker pending orders."""
        if not shared_state.enabled():
            return self.get_pending_orders(user_id)
        return await _offload(
            lambda: _merge_sources(self._shared_by_source("pending", user_id))
        )

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

        多 worker 时变化判断对的是 Redis 里那份（全体 worker 共用），不是本进程上次
        见过的——否则价格在另一个 worker 上变过又变回来时，这里会误判"没变"，前端
        停在中间那个价上。**同步**，协程里用 update_quotes_async。
        With several workers the comparison is against the shared Redis copy, not
        this process's memory; otherwise a price that moved on another worker and
        came back would read as unchanged here and the frontend would stick at the
        intermediate price. Synchronous; coroutines use update_quotes_async.
        """
        valid = [q for q in quotes or [] if q.get("symbol") and q.get("login")]
        changed = self._update_local_quotes(user_id, valid)
        if not shared_state.enabled():
            return changed
        try:
            return self._update_shared_quotes(user_id, valid)
        except Exception as e:
            logger.warning("共享报价读写失败，按本进程判断 / shared quotes failed: %s", e)
            return changed

    def _update_local_quotes(self, user_id: str, quotes: list) -> list:
        if quotes:
            self._quotes_at[user_id] = time.monotonic()
            self._maybe_prune_local()
        prev = self._quotes.setdefault(user_id, {})
        changed: list = []
        for q in quotes:
            by_symbol = prev.setdefault(q["login"], {})
            if _quote_changed(by_symbol.get(q["symbol"]), q):
                by_symbol[q["symbol"]] = q
                changed.append(q)
        return changed

    def _update_shared_quotes(self, user_id: str, quotes: list) -> list:
        r = shared_state._redis()
        key = shared_state._k(QUOTES_KEY.format(user=user_id))
        stored = r.hgetall(key)
        changed: list = []
        pipe = r.pipeline()
        for q in quotes:
            field = f"{q['login']}|{q['symbol']}"
            raw = stored.get(field)
            try:
                old = json.loads(raw) if raw else None
            except (ValueError, TypeError):
                old = None
            if _quote_changed(old, q):
                pipe.hset(key, field, json.dumps(q, default=str))
                changed.append(q)
        # 没变也续期：报价还在报，这批就还活着 / renew even when unchanged: still reporting
        if quotes:
            pipe.expire(key, QUOTES_TTL_SECONDS)
            pipe.execute()
        return changed

    async def update_quotes_async(self, user_id: str, quotes: list) -> list:
        """同 update_quotes，协程里用（Redis 调用挪出事件循环）。/ Same, for coroutines."""
        if not shared_state.enabled():
            return self.update_quotes(user_id, quotes)
        return await _offload(self.update_quotes, user_id, quotes)

    def get_quotes(self, user_id: str) -> list:
        """该用户的分账户报价；多 worker 时读 Redis 里共用的那份（**同步**）。
        The user's per-account quotes; the shared Redis copy with several workers."""
        if shared_state.enabled():
            try:
                raw = shared_state._redis().hgetall(shared_state._k(QUOTES_KEY.format(user=user_id)))
                out = []
                for v in raw.values():
                    try:
                        q = json.loads(v)
                    except (ValueError, TypeError):
                        continue
                    if isinstance(q, dict):
                        out.append(q)
                return out
            except Exception as e:
                logger.warning("读取共享报价失败，退回本进程快照 / shared quotes read failed: %s", e)
        out: list = []
        if not self._local_quotes_fresh(user_id):
            return out
        for by_symbol in self._quotes.get(user_id, {}).values():
            out.extend(by_symbol.values())
        return out

    async def get_quotes_async(self, user_id: str) -> list:
        """同 get_quotes，协程里用。/ Same, for coroutines."""
        if not shared_state.enabled():
            return self.get_quotes(user_id)
        return await _offload(self.get_quotes, user_id)

    # ---------- 建连补推快照 / Connect catch-up snapshot ----------
    def _snapshot_keys(self, user_id: str) -> list[str]:
        """建连补推要读的键，顺序固定：持仓×来源、挂单×来源、分账户报价、全站报价三件套。
        Keys read for the connect catch-up, in a fixed order: positions per source, pending per
        source, per-account quotes, then the three site-wide quote structures."""
        keys = [shared_state._k(_snapshot_key(kind, user_id, src))
                for kind in ("positions", "pending") for src in SNAPSHOT_SOURCES]
        keys.append(shared_state._k(QUOTES_KEY.format(user=user_id)))
        return keys

    def _snapshot_pipeline_sync(self, user_id: str) -> list:
        r = shared_state._redis()
        n = len(SNAPSHOT_SOURCES)
        keys = self._snapshot_keys(user_id)
        pipe = r.pipeline(transaction=False)
        for key in keys[: 2 * n]:
            pipe.get(key)
        pipe.hgetall(keys[2 * n])
        pipe.lrange(shared_state._k(quotes_store._KEY_ORDER), 0, -1)
        pipe.hgetall(shared_state._k(quotes_store._KEY_QUOTES))
        return pipe.execute()

    async def _snapshot_pipeline_async(self, client, user_id: str) -> list:
        n = len(SNAPSHOT_SOURCES)
        keys = self._snapshot_keys(user_id)
        pipe = client.pipeline(transaction=False)
        for key in keys[: 2 * n]:
            pipe.get(key)
        pipe.hgetall(keys[2 * n])
        pipe.lrange(shared_state._k(quotes_store._KEY_ORDER), 0, -1)
        pipe.hgetall(shared_state._k(quotes_store._KEY_QUOTES))
        return await pipe.execute()

    def _local_snapshot(self, user_id: str) -> dict:
        """本进程手里的那一份（没配 Redis，或 Redis 读失败时用）。
        What this process holds (no Redis, or the Redis read failed)."""
        return {
            "positions": self.get_positions(user_id),
            "pending": self.get_pending_orders(user_id),
            "quotes": self.get_quotes(user_id) if not shared_state.enabled() else self._local_account_quotes(user_id),
            "global_quotes": (
                quotes_store.get_all() if not shared_state.enabled() else list(self._last_global_quotes)
            ),
        }

    def _local_account_quotes(self, user_id: str) -> list:
        out: list = []
        if not self._local_quotes_fresh(user_id):
            return out
        for by_symbol in self._quotes.get(user_id, {}).values():
            out.extend(by_symbol.values())
        return out

    async def connect_snapshot_async(self, user_id: str) -> dict:
        """WS 建连补推要的全部数据，一次取齐：持仓、挂单、分账户报价、全站报价。

        以前是 4 次线程跳转 + 约 10 次串行 Redis 往返（持仓 2 GET、挂单 2 GET、HGETALL、
        全站报价 pipeline）；现在是**一个 pipeline、一次往返**：有 redis.asyncio 客户端时直接在
        事件循环上 await，没有就一次线程往返。解析规则与各自的单独读取一致：持仓 / 挂单按来源
        以 Redis 为准、Redis 里缺的来源用本进程那份补（`_shared_by_source` 的语义）。

        **不抛异常**：Redis 出错时整体退回本进程的快照，全站报价退回上一份成功读到的——Redis 抖
        一下不该让刚建好的连接立刻被异常关掉、再 300ms 后重连、再抖一次。

        返回 {"positions", "pending", "quotes", "global_quotes"}，都是列表。
        Everything the WS connect catch-up needs in one go, in a single pipeline / round-trip
        (the async client awaits on the loop, otherwise one thread hop). Parsing follows the
        individual reads: per-source snapshots prefer Redis with local gaps filled. Never raises:
        a Redis error falls back to this process's snapshots, and the site-wide quotes to the
        last good read, so a blip doesn't close a fresh connection only for it to reconnect into
        the next blip. Returns {"positions", "pending", "quotes", "global_quotes"} as lists.
        """
        if not shared_state.enabled():
            return self._local_snapshot(user_id)
        try:
            client = _async_redis()
            if client is not None:
                results = await self._snapshot_pipeline_async(client, user_id)
            else:
                results = await _offload(self._snapshot_pipeline_sync, user_id)
            n = len(SNAPSHOT_SOURCES)
            out: dict[str, list] = {}
            for idx, (kind, name) in enumerate((("positions", "positions"), ("pending", "pending"))):
                by_source: dict[str, list] = {}
                for j, src in enumerate(SNAPSHOT_SOURCES):
                    decoded = _decode_rows(results[idx * n + j])
                    if decoded is not None:
                        by_source[src] = decoded
                for src, rows in self._fresh_local(kind, user_id).items():
                    by_source.setdefault(src, rows)
                out[name] = _merge_sources(by_source)
                # 至少一个来源真有快照（哪怕是 []）：空列表就是「确实没有」，而不是「还不知道」。
                # At least one source holds a snapshot (even []): empty then means "none", not "unknown".
                out[f"{name}_known"] = bool(by_source)
            out["quotes"] = _decode_account_quotes(results[2 * n])
            out["global_quotes"] = _decode_global_quotes(results[2 * n + 1], results[2 * n + 2])
            self._last_global_quotes = out["global_quotes"]
            return out
        except Exception as e:  # noqa: BLE001
            logger.warning("建连补推读取失败，退回本进程快照 / connect snapshot read failed, using local: %s", e)
            return self._local_snapshot(user_id)

    # ---------- 前端连接 / Client connections ----------
    # ---------- 发件队列 / Per-connection outbox ----------
    def _outbox_for(self, ws: WebSocket, user_id: str) -> _Outbox:
        """这条连接的发件队列；没有（或写协程已随事件循环一起结束）就新建。
        This connection's outbox; created if absent (or if its writer ended with a dead loop)."""
        box = self._outboxes.get(ws)
        if box is None or box.task.done():
            queue: asyncio.Queue[str] = asyncio.Queue(maxsize=OUTBOX_MAXSIZE)
            task = asyncio.create_task(self._writer(user_id, ws, queue), name="ws:writer")
            box = self._outboxes[ws] = _Outbox(queue, task)
        return box

    async def _writer(self, user_id: str, ws: WebSocket, queue: "asyncio.Queue[str]") -> None:
        """一条连接的常驻写协程：按顺序把队列里的帧发出去，每一帧带发送超时。

        发送失败或超时就是死连接：摘掉并关闭它，写协程随之退出。慢连接只拖住它自己这一条队列，
        订阅循环与同批的其它连接不再等它（以前是 gather 等满 SEND_TIMEOUT_SECONDS）。
        One writer per connection: sends queued frames in order, each with a send timeout. A
        failure or timeout means a dead connection: drop and close it, and the writer exits. A
        slow connection now only stalls its own queue; the subscriber loop and the rest of the
        batch no longer wait on it (they used to sit out SEND_TIMEOUT_SECONDS in a gather).
        """
        while True:
            text = await queue.get()
            try:
                await asyncio.wait_for(ws.send_text(text), SEND_TIMEOUT_SECONDS)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 —— 超时与报错一样按死连接处理 / a timeout is a dead peer too
                await self._drop_dead(user_id, ws)
                return

    async def _drop_dead(self, user_id: str, ws: WebSocket) -> None:
        """把死连接摘出名单，并在后台关掉它，让前端重连、拿一份完整快照。

        只摘不关的话，这条连接的读循环还活着、心跳照常回 PONG，客户端以为一切正常，却再也收不到
        推送——一条僵尸。关闭放进独立任务并限时：对一个发送缓冲区已满的 socket，close 帧同样可能
        发不出去，不能让它拖住调用方。
        Drop the dead connection from the roster and close it in the background so the frontend
        reconnects to a full snapshot. Dropping alone would leave its read loop alive answering
        PONGs, a zombie that never receives another push. The close runs as its own bounded task:
        on a socket whose send buffer is full even the close frame can hang.
        """
        await self.unregister_client(user_id, ws)
        close = getattr(ws, "close", None)
        if close is None:
            return

        async def _close() -> None:
            try:
                await asyncio.wait_for(close(code=1013), 1.0)
            except Exception:  # noqa: BLE001 —— 已经死了，关不掉也无所谓 / already dead
                pass

        task = asyncio.create_task(_close(), name="ws:reap")
        self._reap_tasks.add(task)
        task.add_done_callback(self._reap_tasks.discard)

    async def register_client(self, user_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.setdefault(user_id, set()).add(ws)
            self._outbox_for(ws, user_id)
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

    def set_background(self, ws: WebSocket, background: bool) -> None:
        """标记/取消某连接的后台状态 / mark or clear a connection's background flag."""
        if background:
            self._background.add(ws)
        else:
            self._background.discard(ws)

    async def unregister_client(self, user_id: str, ws: WebSocket) -> None:
        self._background.discard(ws)
        last_gone = False
        box = self._outboxes.pop(ws, None)
        if box is not None and box.task is not asyncio.current_task():
            box.task.cancel()
        async with self._lock:
            conns = self._clients.get(user_id)
            if conns:
                conns.discard(ws)
                if not conns:
                    last_gone = True
                    self._clients.pop(user_id, None)
                    self._mirrored.pop(user_id, None)
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
                    self._quotes_at.pop(user_id, None)
                    self._local_at.pop(user_id, None)
        # 最后一条连接走了：立刻把「本 worker|该用户」从在线名单摘掉（放锁外、失败只记日志），
        # 名单即时准确——以前要等上一次续期起 60~90 秒才掉，网关循环这期间继续为已经走掉的人去券商
        # 拉持仓。
        # The last connection left: drop "this worker|user" from the roster at once (outside the
        # lock; a failure only logs). It used to linger 60-90s, during which the gateway loop kept
        # pulling positions from the broker for someone who had already gone.
        if last_gone:
            await self._unmark_present_async(user_id)

    # ---------- 路由：本地直投还是走 Redis 转发 / routing: local delivery or Redis fan-out ----------
    def _presence_fresh(self) -> bool:
        return self._remote_at is not None and time.monotonic() - self._remote_at <= PRESENCE_VIEW_MAX_AGE_SECONDS

    def _route(self, targets: list[str] | None) -> str:
        """这条推送要不要经 Redis 转发：'publish' 或 'local'。

        只有「确定**没有**任何目标连在别的 worker 上」才走 'local'（本进程直投，本进程也没有目标就
        什么都不发生）：远端名单是每 2 秒刷新的、且没过期，并且里面没有这批目标。名单还没读到过、
        已经 10 秒没刷新成功（Redis 抖动）、或没配 Redis 以外的任何不确定，一律 'publish'——宁多勿少。
        这样「桥接 24 小时挂着、网页没人开」的用户，每秒 ~2 次 PUBLISH 不再进 Redis；单 worker 却配了
        REDIS_URL 的部署零绕路。代价：某用户 2 秒内刚在另一个 worker 上开了第二页，这 2 秒内的
        一次性事件推送（ORDER_UPDATE 之类）到不了那一页——新页面建连时已从 Redis 补推了持仓 / 挂单 /
        报价，POSITIONS 下一拍（≤2 秒）也会再来，下单响应本身也带着结果。

        Should this push go through Redis: 'publish' or 'local'. 'local' only when it is certain that
        no target is connected on another worker: the remote roster is refreshed every 2s, isn't
        stale, and lacks every target. Never read yet, older than 10s (a Redis blip), anything
        uncertain: 'publish' — better too many than too few. Users whose bridge runs 24/7 with no
        page open no longer cost ~2 PUBLISHes a second; a single worker with REDIS_URL set pays no
        detour at all. The price: a one-off event (ORDER_UPDATE...) in the ~2s after the same user
        opens a second page on another worker misses that page, which already got positions /
        pending / quotes on connect and gets the next POSITIONS tick within 2s.
        """
        if not shared_state.enabled():
            return "local"
        if not self._presence_fresh():
            return "publish"
        remote = self._remote_users
        if targets is None:
            return "publish" if remote else "local"
        return "publish" if any(t in remote for t in targets) else "local"

    async def push_to_client(self, user_id: str, message: dict) -> None:
        """向指定用户的所有前端连接推送。多 worker 时改为发布到 Redis，由各 worker
        的订阅协程投递到自己的 socket（含本进程）；单 worker 直接本地投递。
        Push to all of a user's connections: publish across workers with Redis,
        deliver locally otherwise."""
        await self.push_text_to_client(user_id, _dumps(message))

    async def push_text_to_client(self, user_id: str, text: str) -> None:
        """同 push_to_client，但入参已经是序列化好的帧文本（持仓 / 挂单推送只序列化一遍）。
        Same as push_to_client, taking already-serialized frame text (positions / pending
        pushes serialize exactly once)."""
        if shared_state.enabled():
            if self._route([str(user_id)]) == "local":
                await self._deliver_local_text(user_id, text)
                return
            try:
                await self._publish(_envelope(str(user_id), text))
                return
            except Exception as e:
                # Redis 不可达：退回本地投递，至少连在本进程的用户不断流。
                # Redis unreachable: fall back to local delivery so this worker's users still get it.
                logger.warning("WS 跨进程转发失败，退回本地投递 / fan-out publish failed, delivering locally: %s", e)
        await self._deliver_local_text(user_id, text)

    async def push_to_users(self, user_ids, message: dict) -> None:
        """同一条消息推给一批用户：多 worker 时**一次** publish（信封里带目标名单），
        各 worker 只投给连在自己这里的那些人。
        以前按等级过滤的新信号是逐人 await push_to_client：一个人一次 publish，在线
        用户多了，一条信号要排几百次 Redis 往返才发完。
        One message to a batch of users: a single publish carrying the target list,
        each worker delivering to its own connections. Plan-filtered signals used to
        await push_to_client once per user — hundreds of round-trips per signal.
        """
        targets = [str(u) for u in dict.fromkeys(user_ids or []) if u]
        if not targets:
            return
        if len(targets) == 1:
            await self.push_to_client(targets[0], message)
            return
        text = _dumps(message)
        if shared_state.enabled():
            if self._route(targets) == "local":
                await self._deliver_many_local(targets, text)
                return
            try:
                await self._publish(_envelope(_MULTI_TARGET, text, users=targets))
                return
            except Exception as e:
                logger.warning("WS 跨进程多目标转发失败，退回本地投递 / multi-target publish failed, delivering locally: %s", e)
        await self._deliver_many_local(targets, text)

    async def _publish(self, raw: str) -> None:
        """把一条信封发布到转发频道：优先 redis.asyncio，拿不到就走「同步客户端 + 线程池」。
        失败照常抛出，由调用方决定退回本地投递。
        Publish one envelope: redis.asyncio when available, else the sync client on
        a worker thread. Failures propagate so the caller can deliver locally."""
        channel = shared_state._k(WS_CHANNEL)
        client = _async_redis()
        if client is not None:
            await client.publish(channel, raw)
            return
        await _offload(lambda: shared_state._redis().publish(channel, raw))

    async def _deliver_local(self, user_id: str, message: dict) -> None:
        """向连在本进程的该用户连接推送（序列化一次，见 _deliver_local_text）。
        Local delivery; serialized once, see _deliver_local_text."""
        await self._deliver_local_text(user_id, _dumps(message))

    async def _deliver_many_local(self, user_ids, text: str) -> None:
        """把同一段文本投给本进程上的这批用户（不在本进程的直接跳过）。
        Deliver one text to whichever of these users are connected to this process."""
        local = [u for u in user_ids if u in self._clients]
        if not local:
            return
        await asyncio.gather(
            *(self._deliver_local_text(u, text) for u in local),
            return_exceptions=True,
        )

    async def _deliver_local_text(self, user_id: str, text: str) -> None:
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

        入参是**已经序列化好**的文本：以前每条连接各自 send_json 一次，同一条广播在
        N 条连接上就 json.dumps N 遍（持仓快照可达几十 KB）。现在上游序列化一次，
        这里只 send_text。
        Takes pre-serialized text: every connection used to send_json on its own,
        re-serializing one broadcast N times. Now it is serialized once upstream.
        """
        conns = list(self._clients.get(user_id, set()))
        if not conns:
            return
        bg = self._background
        if bg and text.startswith(_QUOTE_FRAME_PREFIXES):
            conns = [ws for ws in conns if ws not in bg]
            if not conns:
                return
        dead: list[WebSocket] = []
        for ws in conns:
            try:
                self._outbox_for(ws, user_id).queue.put_nowait(text)
            except asyncio.QueueFull:
                dead.append(ws)
        for ws in dead:
            # 队列满 = 这条连接已经落后十几帧：判死清理（复用 unregister_client，保证
            # 「最后一个连接走了就删掉 user_id 这一项」的清理逻辑只有一份）。
            # A full queue means this connection is a dozen frames behind: drop it (via
            # unregister_client, so the "last connection gone -> clean the user entry" logic
            # lives in exactly one place).
            await self._drop_dead(user_id, ws)
        # 让空闲的写协程当场发完：正常连接的一次 send 不需要真正挂起，让出一两拍事件循环，
        # 帧就已经发出去了（也让发送失败的连接在本次调用内被摘掉）；卡住的连接不会被等。
        # Let idle writers finish on the spot: a healthy send needs no real suspension, so a
        # yield or two gets the frame out (and lets a failing connection be dropped within this
        # call); a stuck connection is not waited for.
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    @staticmethod
    def _is_repeat_push(last: dict[str, tuple[bytes, float]], user_id: str, digest: bytes) -> bool:
        """与上次推送内容相同、且还没到 SNAPSHOT_REPUSH_SECONDS：跳过。否则记下这次并放行。
        Same content as the last push and the re-push interval not yet due: skip. Otherwise
        record this push and let it through."""
        now = time.monotonic()
        prev = last.get(user_id)
        if prev is not None and prev[0] == digest and now - prev[1] < SNAPSHOT_REPUSH_SECONDS:
            return True
        last[user_id] = (digest, now)
        return False

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
        merged = await self._store_and_merge("positions", user_id, source, positions or [])
        message = {
            "type": "POSITIONS",
            "data": merged,
            "funds": self.account_funds_from_positions(merged),
        }
        # 只序列化一遍：这段文本既是去重摘要的输入，也是要发出去的帧本身（以前先 sort_keys 序列化
        # 做摘要、真要推时再序列化一遍，几十 KB 的快照白做一次）。不带 sort_keys：键序取决于合并顺序，
        # 本地行与 Redis 回读行的键序一致（都是 JSON 原序），最坏只是多推一帧，不会漏推。
        # Serialized exactly once: this text is both the input to the dedup digest and the frame
        # itself (it used to be dumped with sort_keys for the digest and again when actually
        # pushing — a wasted pass over a snapshot of tens of KB). No sort_keys: key order follows
        # the merge order, and local rows and rows read back from Redis share JSON order, so the
        # worst case is one extra frame, never a missed one.
        # 存 16 字节摘要而不是整份 JSON：持仓多的用户一份快照可达几十 KB，
        # 每个在线用户都留一份原文没必要。
        # Store a 16-byte digest instead of the full JSON: a snapshot can reach
        # tens of KB for users with many positions.
        text = _dumps(message)
        digest = hashlib.blake2b(text.encode(), digest_size=16).digest()
        if self._is_repeat_push(self._last_positions_push, user_id, digest):
            return
        await self.push_text_to_client(user_id, text)

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
        merged = await self._store_and_merge("pending", user_id, source, orders or [])
        text = _dumps({"type": "PENDING_ORDERS", "data": merged})
        digest = hashlib.blake2b(text.encode(), digest_size=16).digest()
        if self._is_repeat_push(self._last_pending_push, user_id, digest):
            return
        await self.push_text_to_client(user_id, text)

    async def broadcast_to_clients(self, message: dict) -> None:
        """向所有在线前端广播（如新信号）/ broadcast to all clients (e.g. new signals)."""
        text = _dumps(message)
        if shared_state.enabled():
            if self._route(None) == "local":
                await self._broadcast_local_text(text)
                return
            try:
                await self._publish(_envelope(None, text))
                return
            except Exception as e:
                logger.warning("WS 跨进程广播失败，退回本地 / broadcast publish failed, delivering locally: %s", e)
        await self._broadcast_local_text(text)

    async def _broadcast_local(self, message: dict) -> None:
        await self._broadcast_local_text(_dumps(message))

    async def _broadcast_local_text(self, text: str) -> None:
        # 用户之间也并发：串行时每个用户最坏要等一个发送超时，在线用户一多，
        # 一条广播的总耗时就是"用户数 × 超时"。序列化只在上游做一次，这里每条
        # 连接只是 send_text 同一段文本。
        # Users run concurrently too: serially each one can cost a full send
        # timeout, making a broadcast take users x timeout in the worst case. The
        # text is serialized once upstream; every connection just sends it.
        user_ids = list(self._clients.keys())
        if not user_ids:
            return
        await asyncio.gather(
            *(self._deliver_local_text(user_id, text) for user_id in user_ids),
            return_exceptions=True,
        )

    async def connected_user_ids_async(self) -> list[str]:
        """协程里读在线名单：把同步 Redis 调用挪到线程池。

        `connected_user_ids` 在配了 Redis 时会走一次同步 `set_members`（客户端
        `socket_timeout=2s`）。协程里直接调它，Redis 一抖动就把事件循环整个冻住
        最多 2 秒——而这个名单恰恰被两条高频循环在 async 上下文里反复读：网关慢拍
        每 2 秒一次、事件泵每 0.25 秒一次。

        为什么不是把 `connected_user_ids` 本身改成 `async def`：它还有**同步**
        调用方（如 `services/push_dispatch.py:_online_user_ids`；`routers/bridge.py`
        的 `_forget_idle_users` 已改为由协程侧取好名单再传入），
        改签名会当场把它们打断，而那几个文件不归这次改动。所以判定逻辑只保留一份
        （下面那个同步方法），这里只包一层线程池，协程侧的调用方改用它即可。

        Read the roster from a coroutine without blocking the loop.
        `connected_user_ids` makes one synchronous Redis call (client
        socket_timeout=2s) when Redis is on; called straight from a coroutine, a
        Redis hiccup freezes the whole event loop for up to two seconds — and this
        roster is read by two hot loops in async context (the gateway slow tick
        every 2s, the event pump every 250ms).

        Why not make `connected_user_ids` itself `async def`: *synchronous*
        callers remain (e.g. push_dispatch's `_online_user_ids`; bridge.py's
        `_forget_idle_users` now receives the roster from its coroutine caller), and changing the signature would break them on the
        spot. So the logic stays in one place — the sync method below — and this
        is just a thread hop for coroutine callers.
        """
        # 没配 Redis 时根本没有阻塞调用（纯字典读），多一次线程调度反而是浪费。
        # Without Redis there is nothing blocking (a dict read); skip the hop.
        if not shared_state.enabled():
            return self.connected_user_ids()
        client = _async_redis()
        if client is None:
            return await _offload(self.connected_user_ids)
        # 有 redis.asyncio 客户端时直接在事件循环上读（与 shared_state.set_members
        # 同样的两步：先删过期、再取未过期），一次 pipeline 往返，不占线程。
        # With the async client, read on the loop itself — the same two steps as
        # shared_state.set_members, in one pipelined round-trip.
        local = list(self._clients.keys())
        members = await self._read_roster_async(client)
        if members is None:
            logger.warning("在线名单读取失败，只用本进程的 / presence read failed, using local only")
            return local
        return self._merge_roster(local, members)

    async def _read_roster_async(self, client) -> list[str] | None:
        """异步客户端读一次在线名单成员（原样，未解析）；失败返回 None。读到的同时刷新远端视图。
        Read the roster members once with the async client (raw); None on failure. Also refreshes
        the remote view."""
        try:
            key = shared_state._k(PRESENCE_KEY)
            now = time.time()
            pipe = client.pipeline(transaction=False)
            pipe.zremrangebyscore(key, "-inf", now)
            pipe.zrangebyscore(key, now, "+inf")
            _removed, members = await pipe.execute()
        except Exception as e:  # noqa: BLE001
            logger.debug("presence read failed: %s", e)
            return None
        members = list(members or [])
        self._ingest_roster(members)
        return members

    def _ingest_roster(self, members: list[str]) -> None:
        """用刚读到的名单成员刷新「连在别的 worker 上的用户」视图。成员形如 `worker|user`，别人的
        worker 前缀才算远端；老格式（裸 user_id）也算远端。读取失败时**不**调用本方法——视图保持上一份
        （清空会误判成「本地独有」而漏投），只是 _remote_at 不再更新，超过 10 秒就不再被信任。
        Refresh the "users on other workers" view from freshly read roster members. Members look
        like `worker|user`; only another worker's prefix counts as remote, and so does the legacy
        bare user id. A failed read never calls this — the view stays as it was (clearing it would
        read as "local only" and drop pushes), only _remote_at stops advancing so the view is
        distrusted after 10 seconds."""
        remote: set[str] = set()
        for member in members:
            worker, user = _presence_user(member)
            if worker != self._worker_id:
                remote.add(user)
        self._remote_users = remote
        self._remote_at = time.monotonic()

    @staticmethod
    def _merge_roster(local: list[str], members: list[str]) -> list[str]:
        """本进程的用户 + 名单里其它人（去重，保持顺序）。/ Local users plus everyone else on the roster."""
        seen = set(local)
        out = list(local)
        for member in members:
            _worker, user = _presence_user(member)
            if user not in seen:
                seen.add(user)
                out.append(user)
        return out

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
            members = shared_state.set_members(PRESENCE_KEY)
        except Exception as e:
            logger.warning("在线名单读取失败，只用本进程的 / presence read failed, using local only: %s", e)
            return local
        self._ingest_roster(members)
        return self._merge_roster(local, members)

    # ---------- 多 worker 的转发与在线名单 / cross-worker fan-out & presence ----------
    def _presence_member(self, user_id: str) -> str:
        return f"{self._worker_id}|{user_id}"

    def _mark_present(self, *user_ids: str) -> None:
        """登记若干用户在线（成员写成 `worker|user`）。**同步阻塞**，协程里请走 _mark_present_async。
        Register users as present (members are `worker|user`). Blocking; coroutines use
        _mark_present_async."""
        if not shared_state.enabled():
            return
        for user_id in user_ids:
            try:
                shared_state.set_add(PRESENCE_KEY, self._presence_member(user_id), PRESENCE_TTL_SECONDS)
            except Exception as e:
                logger.warning("在线名单写入失败 / presence write failed: %s", e)

    async def _mark_present_async(self, *user_ids: str) -> None:
        """一次线程往返登记这一批用户：整批在同一个线程里写完，而不是每人一次
        to_thread——续期循环一跑就是全部在线用户，每人一次线程调度太浪费。
        One thread hop for the whole batch rather than one per user: the refresh
        loop walks every online user, and a hop each would be pure overhead."""
        if not shared_state.enabled() or not user_ids:
            return
        client = _async_redis()
        if client is None:
            await _offload(self._mark_present, *user_ids)
            return
        # 异步客户端：整批一条 ZADD（与 shared_state.set_add 同样的成员级过期写法）。
        # Async client: one ZADD for the whole batch, same per-member expiry as set_add.
        try:
            expires = time.time() + PRESENCE_TTL_SECONDS
            await client.zadd(shared_state._k(PRESENCE_KEY), {self._presence_member(u): expires for u in user_ids})
        except Exception as e:
            logger.warning("在线名单写入失败 / presence write failed: %s", e)

    async def _unmark_present_async(self, user_id: str) -> None:
        """把「本 worker|该用户」从在线名单摘掉（最后一条连接走了）。失败只记日志：成员本来就带
        90 秒过期，最坏是晚摘一会儿。摘完再看一眼：这一小段里若同一个用户又连上来了，补登一次，
        免得新连接被这次 ZREM 误摘。
        Remove "this worker|user" from the roster (its last connection left). A failure only logs —
        the member expires in 90s anyway. Afterwards, if the same user reconnected in the meantime,
        re-register, so the fresh connection isn't undone by this ZREM."""
        if not shared_state.enabled():
            return
        member = self._presence_member(user_id)
        try:
            client = _async_redis()
            if client is not None:
                await client.zrem(shared_state._k(PRESENCE_KEY), member)
            else:
                await _offload(shared_state.set_remove, PRESENCE_KEY, member)
        except Exception as e:  # noqa: BLE001
            logger.warning("在线名单摘除失败 / presence removal failed: %s", e)
            return
        if user_id in self._clients:
            await self._mark_present_async(user_id)

    async def _refresh_remote_view(self) -> None:
        """读一次在线名单刷新「别的 worker 上有谁」的视图（1 次往返）。失败保持上一份。
        Read the roster once to refresh the "who is on other workers" view (one round-trip); a
        failure keeps the previous view."""
        client = _async_redis()
        if client is not None:
            await self._read_roster_async(client)
            return
        try:
            members = await _offload(shared_state.set_members, PRESENCE_KEY)
        except Exception as e:  # noqa: BLE001
            logger.debug("presence view refresh failed: %s", e)
            return
        self._ingest_roster(members)

    async def refresh_presence_loop(self) -> None:
        """两件事：每 2 秒刷新一次「别的 worker 上有谁」的视图（所有 worker 都做，决定推送要不要经
        Redis 转发，见 _route）；每 30 秒把本进程连着的用户续一次期（90 秒过期），进程死了名单自然掉。
        Two jobs: every 2s refresh the "who is on other workers" view (every worker does, deciding
        whether a push goes through Redis — see _route); every 30s renew this worker's users (90s
        expiry), so a dead worker's entries lapse."""
        renew_every = max(1, PRESENCE_REFRESH_SECONDS_RENEW // PRESENCE_VIEW_REFRESH_SECONDS)
        tick = 0
        while True:
            try:
                if tick % renew_every == 0:
                    await self._mark_present_async(*list(self._clients.keys()))
                await self._refresh_remote_view()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 —— 循环不能因为一次失败退出 / never let one failure end the loop
                logger.warning("在线名单刷新失败 / presence refresh failed: %s", e)
            tick += 1
            await asyncio.sleep(PRESENCE_VIEW_REFRESH_SECONDS)

    async def handle_fanout_message(self, raw: str) -> None:
        """处理一条来自 Redis 频道的转发消息（也供测试直接调用）。
        Handle one fan-out message from the channel (also called directly by tests).

        先按新信封只看目标（见上方「消息格式」）：目标不在本进程就直接返回，message
        不解析；在本进程则把 message 那段文本原样发出去。认不出新信封（老 worker 发的
        {"from":…} 格式）才整条 json.loads，按原来的方式处理。
        New envelopes are routed on their head alone (see "fan-out wire format"):
        not local → return without parsing the message; local → send the message
        slice verbatim. Anything else (the old {"from", ...} shape) is parsed in
        full and handled as before.
        """
        if not isinstance(raw, str):
            return
        peeked = _peek_envelope(raw)
        if peeked is not None:
            user_id, users, text = peeked
            if users is not None:
                if user_id == _MULTI_TARGET:
                    await self._deliver_many_local([str(u) for u in users], text)
                return
            if user_id is None:
                await self._broadcast_local_text(text)
            elif user_id in self._clients:
                await self._deliver_local_text(user_id, text)
            return
        # 老格式 / legacy shape
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return
        if not isinstance(data, dict):
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
        """订阅 Redis 频道并投递到本进程的 socket。

        断线后**立刻**重连（连续失败才 0.2s→0.5s→1s→3s 退避，成功一次归零），而不是固定黑屏 3 秒——
        pub/sub 发完即忘，断开期间别的 worker 发布的每一条对本 worker 的用户都是永久丢失。重订阅成功后
        给本进程的用户补推一次持仓 / 挂单快照（去重摘要在发送方进程里，内容不变就不会再发，光等下一拍
        补不回来）。订阅端连接带建连超时与空闲健康检查（见 shared_state.new_async_pubsub）。
        Subscribe to the channel and deliver to this process's sockets. Reconnect immediately after a
        drop (backing off 0.2s -> 0.5s -> 1s -> 3s only on consecutive failures, reset by one
        success) instead of a fixed 3s blackout: pub/sub is fire-and-forget, so everything other
        workers publish while we're down is lost for this worker's users for good. After a successful
        resubscribe, this process's users get a positions / pending catch-up (the dedup digest lives
        on the sender, so unchanged content is never re-sent and waiting for the next tick wouldn't
        repair it).
        """
        failures = 0
        resyncs: set[asyncio.Task] = set()
        while True:
            pubsub = client = None
            try:
                sub = shared_state.new_async_pubsub(WS_CHANNEL, with_client=True)
                if sub is None:
                    return
                pubsub, channel, client = sub
                await pubsub.subscribe(channel)
                failures = 0
                if self._clients:
                    task = asyncio.create_task(self._resync_local_users(), name="ws:resync")
                    resyncs.add(task)
                    task.add_done_callback(resyncs.discard)
                async for msg in pubsub.listen():
                    if msg.get("type") != "message":
                        continue
                    await self.handle_fanout_message(msg.get("data") or "")
            except asyncio.CancelledError:
                for task in list(resyncs):
                    task.cancel()
                raise
            except Exception as e:
                delay = FANOUT_RECONNECT_BACKOFF_SECONDS[min(failures, len(FANOUT_RECONNECT_BACKOFF_SECONDS) - 1)]
                failures += 1
                logger.warning(
                    "WS 转发订阅中断，%.1f 秒后重连 / fan-out subscriber dropped, reconnecting in %.1fs: %s",
                    delay, delay, e,
                )
                # 第一次立刻重连；sleep(0) 只是让出一拍，避免连续失败时空转独占事件循环。
                # Immediate the first time; sleep(0) just yields so a failing loop can't hog the loop.
                await asyncio.sleep(delay)
            finally:
                # 每一轮都新建了一个客户端（连接池），不关掉的话 Redis 每抖动一次
                # 就多留一组连接——一段不稳定期下来连接数线性堆高，最后撞上
                # maxclients。异常路径也要走到，所以放在 finally 而不是循环末尾。
                # Each pass created a fresh client (and pool); leaving it open
                # means one more set of connections per Redis wobble, growing
                # linearly through an unstable spell until maxclients is hit. It
                # has to run on the error path too, hence finally.
                await self._close_pubsub(pubsub, client)

    async def _resync_local_users(self) -> None:
        """给本进程当前连着的每个用户补推一份持仓 / 挂单快照（读 Redis 里的共享快照，直接投给本地
        socket，不再经 Redis 转发）。并发上限 RESYNC_CONCURRENCY；一次性事件，不是常态负担。
        和建连补推一样，快照为空就不发——免得 Redis 刚重启、键还没重新写满时把前端的表清空。
        Catch up every locally connected user with a positions / pending snapshot read from Redis and
        delivered straight to local sockets. Bounded concurrency; a one-off, not a steady load. As on
        connect, an empty snapshot isn't sent, so a Redis that just restarted can't blank the tables."""
        users = list(self._clients.keys())
        if not users:
            return
        sem = asyncio.Semaphore(RESYNC_CONCURRENCY)

        async def one(user_id: str) -> None:
            async with sem:
                try:
                    positions = await self.get_positions_shared_async(user_id)
                    if positions and user_id in self._clients:
                        await self._deliver_local_text(user_id, _dumps({
                            "type": "POSITIONS",
                            "data": positions,
                            "funds": self.account_funds_from_positions(positions),
                        }))
                    pending = await self.get_pending_orders_shared_async(user_id)
                    if pending and user_id in self._clients:
                        await self._deliver_local_text(user_id, _dumps({"type": "PENDING_ORDERS", "data": pending}))
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    logger.debug("resync catch-up failed for %s: %s", user_id, e)

        await asyncio.gather(*(one(u) for u in users), return_exceptions=True)

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
        """多 worker 时每个进程都要跑的协程；单 worker 返回空列表。
        顺带在主事件循环上建 redis.asyncio 客户端，并用 ws:aredis 任务托管它的关闭
        （lifespan 关停时 cancel 这些任务，客户端随之关掉）。
        The per-worker coroutines needed with Redis; empty without it. Also builds
        the redis.asyncio client on the main loop, owned by the ws:aredis task so the
        lifespan's cancel at shutdown closes it."""
        if not shared_state.enabled():
            return []
        tasks = [
            asyncio.create_task(self.run_fanout_subscriber(), name="ws:fanout"),
            asyncio.create_task(self.refresh_presence_loop(), name="ws:presence"),
        ]
        if _start_async_redis():
            tasks.append(asyncio.create_task(_hold_async_redis(), name="ws:aredis"))
        return tasks


manager = ConnectionManager()
