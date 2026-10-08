"""WebSocket 路由：前端推送通道。
WebSocket router: client push channel.

MT5 侧执行统一走 PRISMX Bridge 的 HTTP 轮询（/api/bridge/*），
原 /ws/ea EA 通道已随 EA 接入方式一并移除。
MT5 execution goes exclusively through the PRISMX Bridge HTTP polling
(/api/bridge/*); the legacy /ws/ea EA channel has been removed.
"""
import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from app.core.security import decode_token_payload
from app.services import net_quality
from app.services.connection_manager import manager, run_blocking
from app.services.deps import get_auth_state

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

    **同步阻塞**（缓存未命中时有一次数据库查询），协程里必须经 run_in_threadpool 调用。

    不再每次建连都查库：会话版本与停用状态读 services/deps.get_auth_state 的缓存（`{tv, d}`，
    Redis / 进程内，300 秒；改密、停用、恢复、重置密码提交后自动失效，见 shared_cache 里的说明）。
    Redis 出错当未命中、退回查库。已停用的账号也拒绝建连（停用时 tv 同时自增，旧 token 本来就过不了）。
    部署 / 切网时几百个客户端同一瞬间重连，以前是几百次远端查库排在 12 条连接的池上，现在命中缓存
    就一次 Redis 读。

    Validate the token and return the user_id; a session-version mismatch (invalidated by a
    password change) or a disabled account returns None. Same "tv" check as
    services/deps.get_current_user — see its docstring for the rationale. Blocking (a DB query on a
    cache miss); coroutines must call it via run_in_threadpool. The tv / disabled facts come from
    the cached {tv, d} in services/deps.get_auth_state (300s, invalidated automatically after a
    password change / disable / enable / reset), falling back to the DB when Redis errors — so a
    reconnect storm no longer queues hundreds of remote queries on a 12-connection pool.
    """
    payload = decode_token_payload(token)
    user_id = payload.get("sub") if payload else None
    if not user_id:
        return None
    token_tv = payload.get("tv") if isinstance(payload.get("tv"), int) else 0
    state = get_auth_state(user_id)
    if state is None or token_tv != state["tv"] or state["d"]:
        return None
    return user_id


async def _netq(fn, *args) -> None:
    """连接质量统计只是旁路记账：走 anyio 线程池（main.py 调到 256 条；同步 Redis，每次一个
    pipeline），失败只记日志，绝不影响这条连接。不用 asyncio.to_thread：它走 loop 的默认
    executor，2 核机器上只有 6 条线程，每个心跳都排进去，Redis 一抖就全钉住。
    Connection-quality stats are side bookkeeping: on anyio's pool (raised to 256 in main.py;
    sync Redis, one pipeline per call), and a failure is logged, never allowed to touch the
    socket. Not asyncio.to_thread: that is the loop's default executor with only 6 threads on the
    2-core box, which every heartbeat would queue on and a slow Redis would pin."""
    try:
        await run_blocking(fn, *args)
    except Exception:
        logger.debug("net_quality %s failed", getattr(fn, "__name__", fn), exc_info=True)


def _parse_ping(raw: str) -> dict | None:
    """是心跳就返回帧本身（里面可能捎带 rtt/jit，见 services/net_quality），否则 None。
    The PING frame itself (may carry rtt/jit, see services/net_quality), else None."""
    try:
        frame = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return frame if isinstance(frame, dict) and frame.get("type") == "PING" else None


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

    # 鉴权要查一次库（token_version）。生产库是远端 Supabase，一次往返几十毫秒起，
    # 网络不好时更久——直接在协程里同步查，这段时间整个事件循环停摆：所有 HTTP 请求、
    # 所有 WebSocket 推送、桥接长轮询一起卡住。而 WS 建连恰恰是个会突发的事件（部署
    # 重启、移动端从后台回来、网络切换，都会让一批客户端同时重连）。挪进线程池。
    # Authentication makes one DB query (token_version). Against a remote
    # Supabase that is tens of milliseconds at best, and running it synchronously
    # inside the coroutine stalls the entire event loop for that time — every
    # HTTP request, every WebSocket push and the bridge long-poll with it. WS
    # connects arrive in bursts (a restart, phones resuming, a network switch all
    # reconnect a batch at once), so it goes to the thread pool.
    user_id = await run_in_threadpool(_authenticate, token)
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
    conn_id = uuid.uuid4().hex
    # 连接质量记账不再排在 AUTH_OK 之前：AUTH_OK 发出后才在后台起一个任务去记（持有引用防 GC），
    # 不阻塞建连关键路径。连接秒断时 record_disconnect 会先等它跑完（见 finally），避免幽灵记录。
    # Connection-quality bookkeeping no longer sits in front of AUTH_OK: a background task is
    # started after AUTH_OK (reference held against GC), off the connect critical path. finally
    # waits for it before record_disconnect so a connect-then-drop leaves no ghost entry.
    netq_task: asyncio.Task | None = None
    # register 之后的一切都必须在 try 里。
    #
    # 下面这几帧补推原来在 try 之外：客户端在鉴权成功后立刻断开（移动端切后台、
    # 页面刷新，都很常见）时，send_json 抛出的异常跳过了所有 unregister，这条死
    # 连接就永远留在 manager._clients 里。后果不只是内存：connected_user_ids() 把
    # 该用户算作在线，于是 gateway 的慢拍与事件泵会持续为一个根本没人看的连接去
    # 券商那边拉持仓——这个项目对 egress 是敏感的。
    #
    # Everything after register must live inside the try. These catch-up
    # frames used to sit outside it, so a client that disconnected right after
    # authenticating (backgrounding a mobile app, refreshing the page — both
    # routine) raised past every unregister and left the dead socket in
    # manager._clients forever. The cost is not just memory: connected_user_ids()
    # then counts the user as online, so the gateway's slow tick and event pump
    # keep pulling positions from the broker for a connection nobody is reading,
    # and egress on this project is a standing concern.
    try:
        await websocket.send_json({"type": "AUTH_OK", "userId": user_id})
        netq_task = asyncio.create_task(_netq(net_quality.record_connect, conn_id, user_id))
        # 连接即补推最近一次持仓 / 挂单 / 分账户报价 / 全站报价快照，避免刷新后先空一拍。
        # 四份数据一次取齐（一个 Redis pipeline、一次往返，见 manager.connect_snapshot_async），
        # 而不是 4 次线程跳转 + 约 10 次串行往返。
        #
        # 取数与发送分开容错：**取数**失败（Redis 抖动等）只记日志、这一拍不补推（连接保留，下一拍
        # 的 POSITIONS / GLOBAL_QUOTES 广播自然补上）；**发送**不包 try——socket 已死时吞掉发送
        # 异常，会让流程走到 receive_text 再抛 RuntimeError，日志从「断开」变成「异常」噪音。
        # Catch up on the latest positions / pending orders / per-account quotes / site-wide quotes
        # so a refresh doesn't show a blank gap. All four are fetched together (one Redis pipeline,
        # one round-trip; see manager.connect_snapshot_async) instead of 4 thread hops and ~10
        # serial round-trips. Fetching and sending are guarded separately: a failed *fetch* (a
        # Redis blip) only logs and skips the catch-up — the connection stays and the next tick's
        # POSITIONS / GLOBAL_QUOTES broadcast fills it in — while *sends* are deliberately not
        # wrapped: swallowing a send error on a dead socket would run on to receive_text and raise a
        # RuntimeError, turning a disconnect in the log into exception noise.
        try:
            snapshot = await manager.connect_snapshot_async(user_id)
        except Exception:
            logger.warning("WS 建连补推取数失败，跳过 / connect catch-up fetch failed, skipping (user_id=%s)",
                           user_id, exc_info=True)
            snapshot = {}
        cached = snapshot.get("positions")
        # 空快照也要推，只要 Redis 里确实有这份快照（positions_known）：重连前最后一张单平掉的那帧
        # 很可能发给了已经死掉的旧连接，不推 [] 的话前端会一直显示那张早已平掉的单。Redis 里没有
        # 快照（刚重启 / 过期）时仍不推，免得把前端的表误清空。
        # Push an empty snapshot too, as long as Redis really holds one (positions_known): the frame
        # for the last close may have gone to the dead socket before this reconnect, and without []
        # the frontend keeps showing a long-closed position. With no snapshot in Redis (just
        # restarted / expired) still push nothing, so the table isn't blanked by mistake.
        if cached or snapshot.get("positions_known"):
            # 带上 funds，否则刷新后账户卡片要等下一拍推送才能拿到实时浮盈，
            # 中间那一两秒会退回"净值-余额"的旧口径，数字会跳一下。
            # Include funds, otherwise the account card would fall back to the old
            # equity-minus-balance figure until the next push and visibly jump.
            await websocket.send_json({
                "type": "POSITIONS",
                "data": cached,
                "funds": manager.account_funds_from_positions(cached),
            })
        # 挂单不带 funds——浮盈是持仓的概念，挂单还没有仓位。
        # No funds ride along with pending orders: floating P/L belongs to positions.
        cached_pending = snapshot.get("pending")
        if cached_pending or snapshot.get("pending_known"):
            await websocket.send_json({"type": "PENDING_ORDERS", "data": cached_pending})
        # 按交易商账户区分的报价（下单确认页用）/ per-account quotes (order-confirm page)
        cached_quotes = snapshot.get("quotes")
        if cached_quotes:
            await websocket.send_json({"type": "QUOTES", "data": cached_quotes})
        # 全站统一报价（展示用）/ site-wide quotes (display)
        cached_global_quotes = snapshot.get("global_quotes")
        if cached_global_quotes:
            await websocket.send_json({"type": "GLOBAL_QUOTES", "data": cached_global_quotes})
        while True:
            # 前端通道以服务端推送为主。客户端唯一会主动发的帧是应用层心跳
            # {"type":"PING"}，这里回一帧 PONG；其它内容一律忽略（老版本前端不发
            # 任何帧，行为不变）。
            #
            # 为什么需要应用层心跳而不是靠 uvicorn 的协议层 ping：协议层 ping/pong
            # 由浏览器自动应答，页面 JS 完全看不到，所以它只能帮**服务端**发现死连接，
            # 帮不了客户端。而客户端这一侧才是问题所在——安卓 App 切后台再回来，TCP
            # 早被运营商 NAT 或系统休眠掐断，WebSocket 的 readyState 却仍是 OPEN，
            # 前端永远不会重连，报价冻住、新信号一条都收不到（2026-09-15 两名用户
            # 反馈"同一手机网页有信号 App 没有"，根因就是这条僵尸连接）。客户端定时发
            # PING、在时限内收不到任何帧就主动断开重连，才能从页面这一侧把僵尸认出来。
            #
            # The only frame the client ever sends after AUTH is the app-level
            # heartbeat {"type":"PING"}; answer with PONG and ignore anything else
            # (older frontends send nothing, so their behaviour is unchanged).
            # Protocol-level ping/pong is answered by the browser and invisible to
            # page JS, so it only lets the *server* detect dead connections. The
            # client side is where it matters: an Android WebView resumed from the
            # background may hold a socket whose TCP was long cut by carrier NAT or
            # device sleep, yet readyState still says OPEN — no reconnect, frozen
            # quotes, no new signals (the 2026-09-15 "web shows signals, app
            # doesn't" reports). A client-driven PING with a reply deadline is the
            # only way the page can tell a zombie from a quiet connection.
            raw = await websocket.receive_text()
            ping = _parse_ping(raw)
            if ping is not None:
                # bg:true = 页面在后台，报价帧对它跳过；不带/false = 前台，取消标记。
                # bg:true = page in background, quote frames skipped; absent/false clears it.
                manager.set_background(websocket, ping.get("bg") is True)
                await websocket.send_json({"type": "PONG"})
                await _netq(net_quality.record_sample, conn_id, user_id, *net_quality.parse_ping(ping))
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("ws_client error (user_id=%s)", user_id)
    finally:
        # 改用 finally：两个 except 各自 unregister 一次，等于要求「所有退出路径都
        # 记得加一行」，而补推那几帧挪进 try 之后退出路径又多了几条。放在 finally 里
        # 是让"注册过就一定注销"成为结构性保证，而不是靠每处都写对。
        # A finally instead of one unregister per except: the old shape required
        # every exit path to remember the call, and moving the catch-up frames into
        # the try added more of them. This makes "registered implies unregistered"
        # structural rather than a thing each branch has to get right.
        await manager.unregister_client(user_id, websocket)
        if netq_task is not None:
            # record_connect 一定先于 record_disconnect 落地；它自己吞异常（_netq），这里只防取消。
            # record_connect always lands before record_disconnect; _netq swallows its own errors,
            # this only guards cancellation.
            try:
                await netq_task
            except Exception:  # noqa: BLE001
                pass
            await _netq(net_quality.record_disconnect, conn_id)
