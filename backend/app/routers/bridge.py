"""桥接程序路由：Python 桌面程序通过 REST + API Token 上报多账号并执行指令。
Bridge router: the Python desktop app reports multiple MT5 accounts and
executes order commands via REST + API token.
"""
import logging
import time
from datetime import datetime, timedelta, timezone
from threading import Lock

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import get_db
from app.core.security import authenticate_api_token, hash_api_token
from app.models import ClosedTrade, MT5Account, Order, Signal, User
from app.routers.orders import is_stale_pending, order_update_payload, void_stale_order
from app.schemas import LOGIN_PATTERN, SUFFIX_PATTERN, AccountSuffixRequest, MT5AccountOut
from app.services.auto_manage import AUTO_PREFIX, evaluate_positions
from app.services.connection_manager import manager
from app.services.deps import get_current_user, is_account_online
from app.services.plans import max_mt5_accounts
from app.services.push_dispatch import (
    EVENT_BRIDGE_OFFLINE,
    EVENT_ORDER_FILLED,
    EVENT_ORDER_REJECTED,
    dispatch_event_push_async,
)
from app.services import bridge_version_check
from app.services.settings_store import get_broker_settings, server_matches_broker
from app.services.trade_performance import mark_positions_seen

logger = logging.getLogger("prismx.bridge")

router = APIRouter(prefix="/bridge", tags=["bridge"])

# user_id -> 上次推送给前端的在线账号集合。桥接每 1.5 秒轮询一次，
# 状态没变化就不再重复推 ACCOUNTS_STATUS，避免无意义的 WS 流量。
# 该状态同时被 bridge_poll 与 offline_monitor_loop 使用（单事件循环内串行访问）。
# user_id -> last ACCOUNTS_STATUS pushed to clients. The bridge polls every
# 1.5s; skip the push when nothing changed to avoid useless WS traffic. Shared
# by bridge_poll and offline_monitor_loop (accessed serially on one event loop).
_last_pushed_online: dict[str, set[str]] = {}


async def _push_accounts_status_if_changed(user_id: str, online: set[str]) -> None:
    """仅在在线账号集合发生变化时推送 ACCOUNTS_STATUS；若从"有账号在线"变为
    "全部离线"，额外触发一次 bridge_offline 事件通知（若用户已开启）。

    Push ACCOUNTS_STATUS only when the online-login set actually changed; if
    the transition is from "some accounts online" to "all offline", also fire
    a bridge_offline event notification (if the user has it enabled).
    """
    previous = _last_pushed_online.get(user_id)
    if previous == online:
        return
    _last_pushed_online[user_id] = online
    # 只有"以前确实在线过、现在变空"才算真正的断线；previous 为 None 只是
    # 第一次观测到这个用户（比如刚启动服务、或用户从未连接过），不是真的
    # 从在线掉线，不该触发"离线"提醒。
    # Only "was previously online, now empty" counts as a real disconnect;
    # previous being None just means this is the first observation of this
    # user (e.g. right after the service starts, or they've never connected)
    # — not an actual online-to-offline transition, so it shouldn't fire an
    # "offline" alert.
    if previous and not online:
        await dispatch_event_push_async(
            user_id, EVENT_BRIDGE_OFFLINE,
            "PRISMX Bridge 已离线",
            "检测到你的 MT5 桥接程序已断开连接，新信号将无法自动下单执行。",
        )
    await manager.push_to_client(
        user_id,
        {"type": "ACCOUNTS_STATUS", "data": {"onlineLogins": sorted(online)}},
    )


def get_bridge_user(
    x_api_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """通过 API Token 鉴权桥接程序 / authenticate bridge app by API token."""
    user = _authenticate_cached(db, x_api_token)
    if not user:
        raise HTTPException(status_code=401, detail="API Token 无效 / Invalid API token")
    return user


# ---------- Token 鉴权缓存 / API-token auth cache ----------
# 桥接每秒发多个请求，每个请求都要查库做 Token 鉴权，是最重复的一笔 DB 开销。
# 这里按 token 哈希缓存已鉴权用户一小段时间（TTL 秒级），命中即跳过查库。
# 代价：用户等级变更 / Token 撤销最多延迟 TTL 秒生效——对高频轮询完全可接受。
# 只读取 user.id / user.plan 这类已加载的标量列，detached 实例访问是安全的。
# The bridge fires several requests per second and each re-queries the DB just
# to authenticate its token — the single most repeated DB cost. Cache the
# authenticated user per token-hash for a few seconds; on a hit we skip the DB
# query. Cost: a plan change / token revocation takes at most TTL seconds to
# apply — fine for high-frequency polling. We only read already-loaded scalar
# columns (user.id / user.plan), which is safe on a detached instance.
_AUTH_CACHE_TTL = 10.0  # 秒 / seconds
_auth_cache: dict[str, tuple[float, User]] = {}
_auth_cache_lock = Lock()


def _authenticate_cached(db: Session, x_api_token: str | None) -> User | None:
    if not x_api_token:
        return None
    key = hash_api_token(x_api_token)
    now = time.monotonic()
    hit = _auth_cache.get(key)
    if hit is not None and hit[0] > now:
        return hit[1]
    user = authenticate_api_token(db, x_api_token)
    if user is not None:
        with _auth_cache_lock:
            _auth_cache[key] = (now + _AUTH_CACHE_TTL, user)
            # 简单容量兜底：条目过多时清掉已过期项 / prune expired entries when large
            if len(_auth_cache) > 5000:
                for k, (exp, _u) in list(_auth_cache.items()):
                    if exp <= now:
                        _auth_cache.pop(k, None)
    return user


# ---------- 桥接程序上报的单个账号 / one account reported by the bridge ----------
class BridgeAccount(BaseModel):
    login: str = Field(pattern=LOGIN_PATTERN)
    server: str | None = Field(default=None, max_length=64)
    accountName: str | None = Field(default=None, max_length=128)
    accountCurrency: str | None = Field(default=None, max_length=16)
    balance: float | None = None
    equity: float | None = None
    leverage: int | None = Field(default=None, ge=0, le=100000)
    company: str | None = Field(default=None, max_length=128)
    detectedSuffix: str | None = Field(default=None, pattern=SUFFIX_PATTERN)


class BridgePollRequest(BaseModel):
    accounts: list[BridgeAccount] = []
    # Bridge 桌面程序自身的版本号（如 "1.3.15"），用于网页端提示更新——
    # 见 bridge_version_check.py。旧版 Bridge 不带这个字段，可选。
    # The Bridge desktop app's own version (e.g. "1.3.15"), used to power the
    # web app's update notice — see bridge_version_check.py. Older Bridge
    # builds don't send this field, so it's optional.
    bridgeVersion: str | None = Field(default=None, max_length=32)


def _upsert_account(
    db: Session, user_id: str, acc: BridgeAccount, existing_count: int, account_limit: int | None
) -> tuple[MT5Account | None, bool]:
    """插入或更新一个账号记录。若是全新账号且该用户等级的账户上限已用满，
    返回 (None, False)，不插入——调用方据此把该 login 记入"超额被拒"列表。

    Insert or update one account row. If this is a brand-new account and the
    user's plan-based account limit is already reached, returns (None, False)
    without inserting — the caller records this login as rejected.
    """
    row = (
        db.query(MT5Account)
        .filter(
            MT5Account.user_id == user_id,
            MT5Account.login == acc.login,
            MT5Account.server == (acc.server or None),
        )
        .first()
    )
    created = False
    if row is None:
        if account_limit is not None and existing_count >= account_limit:
            return None, False
        row = MT5Account(user_id=user_id, login=acc.login, server=acc.server, source="bridge")
        db.add(row)
        created = True
    if acc.accountName is not None:
        row.account_name = acc.accountName
    if acc.accountCurrency is not None:
        row.account_currency = acc.accountCurrency
    if acc.balance is not None:
        row.balance = acc.balance
    if acc.equity is not None:
        row.equity = acc.equity
    if acc.leverage is not None:
        row.leverage = acc.leverage
    if acc.company is not None:
        row.company = acc.company
    # 探测后缀仅作兜底（用户未手动设置时）/ detected suffix is fallback only
    if acc.detectedSuffix is not None and not (row.symbol_suffix or "").strip():
        row.symbol_suffix = acc.detectedSuffix
    row.online = True
    row.last_heartbeat = datetime.now(timezone.utc)
    return row, created


def _poll_db_work(
    db: Session, user: User, req: BridgePollRequest
) -> tuple[list[dict], list[dict], set[str], list[str], list[str]]:
    """bridge_poll 的全部同步数据库工作（在线程池中执行）。
    All blocking DB work of bridge_poll (runs in a thread pool).

    返回 (待下发指令, 被作废订单的推送载荷, 在线账号集合, 超额被拒的 login 列表,
    非合作券商被拒的 login 列表)。
    Returns (commands to deliver, voided-order push payloads, online logins,
    logins rejected for exceeding the plan's account limit, logins rejected
    for not matching the partner broker).
    """
    # 1) upsert 本次上报的账号。两道闸门，先券商后配额：
    #    ① 合作券商锁开启时，MT5 服务器名不含任一关键字的账号一律拒绝——
    #       包括锁开启前就绑定过的旧账号（跳过 upsert 即不再刷新心跳，数秒内
    #       转为离线，指令也不会再路由过去）；
    #    ② 全新账号超出该用户等级的账户数上限时拒绝。
    #    Upsert reported accounts behind two gates, broker first then quota:
    #    ① with the partner-broker lock on, any account whose MT5 server name
    #       contains none of the keywords is rejected — including accounts
    #       bound before the lock was enabled (skipping the upsert stops the
    #       heartbeat, so they drop offline within seconds and no commands
    #       route to them);
    #    ② brand-new accounts beyond the plan's account limit are rejected.
    broker = get_broker_settings(db)
    broker_lock = bool(broker.get("broker_lock_enabled"))
    broker_patterns = broker.get("broker_patterns") or []
    account_limit = max_mt5_accounts(user.plan)
    # 该用户所有已绑定账号的 login，按 login 升序——用于账户数上限的"稳定裁剪"。
    # This user's bound account logins, sorted ascending — the stable ordering
    # used to enforce the plan's account-count cap.
    bound_logins_ordered = [
        row[0]
        for row in db.query(MT5Account.login)
        .filter(MT5Account.user_id == user.id)
        .order_by(MT5Account.login.asc())
        .all()
    ]
    existing_count = len(bound_logins_ordered)
    bound_set = set(bound_logins_ordered)
    # 受订阅等级账户数上限约束时，已绑定账号里只有"按 login 升序的前 N 个"允许
    # 继续在线；超出的旧账号（典型是从 PRO 降级到 FREE 后多出来的账号）本次跳过
    # upsert——不再刷新心跳，数秒内转离线、不再接收任何指令。此前 _upsert_account
    # 只拦"新账号超额"，已绑定的老账号不受限，导致降级用户仍能多账号交易。
    # None 表示不限（PRO），走原有逻辑。选"前 N 个"而非"本次上报的前 N 个"是为了
    # 稳定：保留的账号不随每次上报的账号集合变化而抖动。
    # When the plan caps the account count, only the first N bound logins (by
    # ascending login) may stay online; any extra older accounts (typically the
    # ones left over after a PRO→FREE downgrade) skip the upsert this poll — no
    # heartbeat refresh, so they drop offline within seconds and receive no
    # commands. Previously _upsert_account only blocked *new* over-limit
    # accounts; already-bound ones were exempt, letting a downgraded user keep
    # trading on multiple accounts. None means unlimited (PRO). Using "first N
    # bound" rather than "first N reported" keeps the kept set stable across
    # polls instead of flapping with whatever the bridge happens to report.
    allowed_bound: set[str] | None = (
        set(bound_logins_ordered[:account_limit]) if account_limit is not None else None
    )
    suffix_by_login: dict[str, str] = {}
    online_logins: set[str] = set()
    rejected_logins: list[str] = []
    broker_rejected: list[str] = []
    for acc in req.accounts:
        if broker_lock and not server_matches_broker(acc.server, broker_patterns):
            broker_rejected.append(acc.login)
            continue
        # 已绑定但超出账户数上限（降级后的多余旧账号）：跳过，令其转离线。
        # 新账号的超额拦截仍由 _upsert_account 负责（见其 existing_count 判断）。
        # Already bound but over the cap (leftover accounts after a downgrade):
        # skip so it goes offline. New-account over-cap rejection is still
        # handled inside _upsert_account (its existing_count check).
        if allowed_bound is not None and acc.login in bound_set and acc.login not in allowed_bound:
            rejected_logins.append(acc.login)
            continue
        row, created = _upsert_account(db, user.id, acc, existing_count, account_limit)
        if row is None:
            rejected_logins.append(acc.login)
            continue
        if created:
            existing_count += 1
        suffix_by_login[acc.login] = (row.symbol_suffix or "").strip()
        online_logins.add(acc.login)
    # 记录这个用户最近上报的 Bridge 版本，供网页端"有新版本可更新"提示使用。
    # Record this user's most recently reported Bridge version, for the web
    # app's "a newer version is available" notice.
    if req.bridgeVersion and req.bridgeVersion != user.bridge_version:
        user.bridge_version = req.bridgeVersion
    db.commit()

    # 2) 取该用户、目标账号匹配的待执行订单 / fetch matching pending orders.
    #    包含两类：从未下发的；以及已下发但超时未回执的（可能回执丢失，需重发）。
    #    Includes: never-delivered orders, and delivered-but-unacked orders past
    #    the ack timeout (the ack may have been lost; safe to re-deliver because
    #    the bridge dedupes by clientOrderId).
    now = datetime.now(timezone.utc)
    ack_deadline = now - timedelta(seconds=settings.ORDER_ACK_TIMEOUT_SECONDS)
    pending = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.status == "PENDING")
        .order_by(Order.created_at.asc())
        .all()
    )
    commands = []
    voided: list[Order] = []
    for o in pending:
        # 超时未执行的陈旧指令：作废而非下发，防止按过时价格成交。
        # Stale command past the pending timeout: void instead of dispatching,
        # so it can't fill at an outdated price.
        if is_stale_pending(o, now):
            void_stale_order(o)
            voided.append(o)
            continue
        # 跳过已下发且仍在等待回执窗口内的订单 / skip recently delivered, still within ack window
        if o.delivered and o.delivered_at is not None:
            last = o.delivered_at
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if last > ack_deadline:
                continue
        # 仅下发给目标账号在本机在线的指令 / only deliver to a locally-online target
        if o.mt5_login and o.mt5_login not in online_logins:
            continue
        # 若订单未指定账号且只有一个在线账号，则发给它 / single-account fallback
        target = o.mt5_login or (next(iter(online_logins)) if len(online_logins) == 1 else None)
        if target is None:
            continue
        entry = stop_loss = take_profit = 0.0
        if o.signal_id:
            sig = db.query(Signal).filter(Signal.id == o.signal_id).first()
            if sig:
                entry = sig.entry or 0.0
                stop_loss = sig.stop_loss or 0.0
                take_profit = sig.take_profit or 0.0
        # 订单自定义 SL/TP 优先于信号默认值 / order's custom SL·TP overrides signal defaults
        if o.sl is not None:
            stop_loss = o.sl
        if o.tp is not None:
            take_profit = o.tp
        suffix = suffix_by_login.get(target, "")
        commands.append({
            "clientOrderId": o.client_order_id,
            "action": o.action or "ORDER",
            "login": target,
            "symbol": o.symbol + suffix,
            "side": o.side,
            "volume": o.volume,
            "ticket": o.ticket or 0,
            "entry": entry,
            "stopLoss": stop_loss,
            "takeProfit": take_profit,
        })
        o.delivered = True
        o.delivered_at = now
    db.commit()

    # 被作废订单的推送载荷（推送本身回到事件循环里做）
    # payloads for voided orders (the actual push happens back on the event loop)
    voided_payloads = [order_update_payload(o) for o in voided]

    return commands, voided_payloads, online_logins, rejected_logins, broker_rejected


@router.post("/poll")
async def bridge_poll(
    req: BridgePollRequest,
    user: User = Depends(get_bridge_user),
    db: Session = Depends(get_db),
):
    """桥接程序轮询：上报本机所有账号 + 拉取这些账号的待执行指令。
    Bridge polling: report all local accounts + fetch pending commands for them.

    同步数据库工作放线程池执行，避免阻塞事件循环（WS 推送共用该循环）；
    回到事件循环后再做 WS 推送。
    Blocking DB work runs in a thread pool so it can't stall the event loop
    (shared with the WS pushes); pushes happen back on the loop afterwards.
    """
    commands, voided_payloads, online_logins, rejected_logins, broker_rejected = await run_in_threadpool(
        _poll_db_work, db, user, req
    )

    # 推送被作废订单的状态给前端 / push voided orders' status to the client
    for payload in voided_payloads:
        await manager.push_to_client(user.id, payload)

    # 账号在线状态：仅变化时推送 / account status: push only on change
    await _push_accounts_status_if_changed(user.id, online_logins)

    # accountLimitExceeded：超出当前订阅等级账户上限、未被接受的 login 列表。
    # brokerRejected：MT5 服务器名不匹配合作券商、未被接受的 login 列表。
    # 当前桥接程序版本尚未读取这两个字段，供后续版本据此提示用户升级/换券商。
    # accountLimitExceeded: logins rejected for exceeding the plan's account
    # limit. brokerRejected: logins rejected because the MT5 server name
    # doesn't match the partner broker. The current bridge app doesn't read
    # these yet; a future version can surface them to the user.
    return {
        "commands": commands,
        "accountLimitExceeded": rejected_logins,
        "brokerRejected": broker_rejected,
    }


class BridgeResultRequest(BaseModel):
    clientOrderId: str
    success: bool
    mt5Ticket: int | None = None
    filledPrice: float | None = None
    message: str | None = None
    # 实际执行该指令的 MT5 账号 login。未指定目标账号、靠"唯一在线账号"兜底
    # 路由时，落库的指令本身不知道最终打到了哪个账号；有了这个字段，个人胜率
    # 按 (login, position ticket) 匹配平仓明细时才不会因为 mt5_login 缺失而配不上。
    # The MT5 login the command actually executed on. When an order has no
    # target account and was routed via the single-online-account fallback,
    # the stored command otherwise never learns which account it landed on;
    # this field lets personal win-rate matching key on (login, position
    # ticket) without falling over from a missing mt5_login.
    login: str | None = Field(default=None, pattern=LOGIN_PATTERN)


@router.post("/result")
async def bridge_result(
    req: BridgeResultRequest,
    user: User = Depends(get_bridge_user),
    db: Session = Depends(get_db),
):
    """桥接程序回报执行结果 / bridge reports execution result."""
    order = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在 / Order not found")

    # 幂等：订单已处于终态则直接确认，不被迟到的重复回执覆盖。
    # Idempotent: if already in a terminal state, just ack; don't let a late
    # duplicate result overwrite it.
    if order.status in ("FILLED", "REJECTED"):
        return {"ok": True, "duplicate": True}

    # 真实回执覆盖状态（包括迟到回执纠正已超时作废的 FAILED——实际执行结果为准）。
    # The genuine result wins, including a late result correcting a timed-out
    # FAILED order — reality beats our assumption.
    order.status = "FILLED" if req.success else "REJECTED"
    order.mt5_ticket = req.mt5Ticket
    order.filled_price = req.filledPrice
    order.message = req.message
    # 兜底路由时补上实际执行账号，指定过目标账号的订单不覆盖已有值。
    # Backfill the actual executing account for fallback-routed orders; never
    # overwrite an order that already specified its target account.
    if req.login and not order.mt5_login:
        order.mt5_login = req.login
    db.commit()
    db.refresh(order)

    await manager.push_to_client(user.id, order_update_payload(order))

    # Web Push 通知（若用户开启了对应事件类型）：跳过自动仓管生成的指令——
    # 那类指令已经在触发那一刻（auto_manage.evaluate_positions）单独推送过
    # 一次"自动仓管触发"通知，回执阶段不用再重复通知同一个动作。
    # Web Push notification (if the user has this event type enabled): skip
    # commands auto-management generated — those already got an
    # "auto-manage triggered" push at the moment the rule fired
    # (auto_manage.evaluate_positions), no need to notify the same action twice.
    if not order.client_order_id.startswith(AUTO_PREFIX):
        if order.status == "FILLED":
            await dispatch_event_push_async(
                user.id, EVENT_ORDER_FILLED,
                f"订单已成交 {order.symbol}",
                f"{order.side} {order.volume} 手 @ {order.filled_price}",
            )
        else:
            await dispatch_event_push_async(
                user.id, EVENT_ORDER_REJECTED,
                f"订单被拒绝 {order.symbol}",
                order.message or "-",
            )
    return {"ok": True}


class BridgePositionsRequest(BaseModel):
    data: list = []


@router.post("/positions")
async def bridge_positions(
    req: BridgePositionsRequest,
    user: User = Depends(get_bridge_user),
    db: Session = Depends(get_db),
):
    """桥接程序上报持仓 / bridge reports open positions.

    上报同时驱动自动仓位管理（PRO）：对本平台开出的仓位评估保本/追踪/分批
    规则，需要动作时向指令队列写入 MODIFY/CLOSE，由桥接下一拍拉取执行。
    评估失败绝不影响持仓上报本身。
    The report also drives auto position management (PRO): platform-opened
    positions are evaluated against the break-even/trailing/partial rules and
    any required MODIFY/CLOSE commands are enqueued for the bridge's next
    poll. An evaluation failure never breaks the report itself.
    """
    manager.set_positions(user.id, req.data)
    await manager.push_to_client(user.id, {"type": "POSITIONS", "data": req.data})
    # 拿实时持仓给个人胜率对账：给仍持仓的本平台仓位盖时间戳，让平仓明细漏报的
    # 仓位最终退出"进行中"。对账失败绝不影响持仓上报本身。
    # Reconcile personal win-rate against live positions: stamp still-open
    # platform positions so ones with missed close-legs eventually leave
    # "进行中". A reconciliation failure never breaks the report itself.
    try:
        await run_in_threadpool(mark_positions_seen, db, user.id, req.data)
    except Exception:
        logger.exception("position reconciliation failed (user=%s)", user.id)
    try:
        await run_in_threadpool(evaluate_positions, db, user.id, req.data)
    except Exception:
        logger.exception("auto_manage evaluation failed (user=%s)", user.id)
    return {"ok": True}


class BridgeQuote(BaseModel):
    symbol: str = Field(max_length=32)
    # 上报该报价的 MT5 账号 login：下单确认页按用户选中的账户取对应报价，
    # 而不是跨账户合并后的一份，不同交易商的报价可能不同。可选（而非必填）
    # 是迁移期的兼容考虑：旧版 Bridge.exe（v1.3.7 及更早）还没打包发布这个
    # 新字段，若设为必填，旧版桌面程序上报的每一条报价都会被 422 拒收——
    # 见 manager.update_quotes，缺 login 的条目会被安静丢弃而不是报错。
    # The MT5 login that reported this quote: the order-confirmation page
    # looks up the quote for whichever account the user selected, rather than
    # a cross-account merged one — different brokers can quote differently.
    # Optional (not required) for migration compatibility: older Bridge.exe
    # builds (v1.3.7 and earlier) haven't been repackaged with this new field
    # yet: making it required would 422-reject every quote reported by the
    # currently-deployed desktop app — see manager.update_quotes, which
    # silently drops entries missing login instead of erroring.
    login: str | None = Field(default=None, pattern=LOGIN_PATTERN)
    bid: float
    ask: float
    digits: int | None = Field(default=None, ge=0, le=10)
    ts: str | None = Field(default=None, max_length=40)


class BridgeQuotesRequest(BaseModel):
    data: list[BridgeQuote] = []


@router.post("/quotes")
async def bridge_quotes(
    req: BridgeQuotesRequest,
    user: User = Depends(get_bridge_user),
):
    """桥接程序上报按账户区分的实时报价（bid/ask）。仅把发生变化的条目推给
    前端，控制 WebSocket 流量。
    Bridge reports live bid/ask quotes per account. Only changed entries are
    pushed to clients to keep WebSocket traffic minimal.
    """
    incoming = [q.model_dump() for q in req.data]
    changed = manager.update_quotes(user.id, incoming)
    if changed:
        await manager.push_to_client(user.id, {"type": "QUOTES", "data": changed})
    return {"ok": True}


# ---------- 真实平仓明细上报（个人胜率用）/ closed-trade reporting (for personal win-rate) ----------
class BridgeClosedTrade(BaseModel):
    """桥接程序上报的一笔 MT5 平仓成交（可能是部分平仓）。
    One MT5 closing deal reported by the bridge (may be a partial close)."""

    login: str = Field(pattern=LOGIN_PATTERN)
    symbol: str = Field(max_length=32)
    side: str = Field(pattern=r"^(BUY|SELL)$")
    closeVolume: float = Field(gt=0, le=10000)
    closePrice: float = Field(ge=0)
    profit: float
    positionTicket: int = Field(gt=0)
    dealTicket: int = Field(gt=0)
    closedAt: datetime


class BridgeClosedTradesRequest(BaseModel):
    data: list[BridgeClosedTrade] = []


@router.post("/trade-history")
def bridge_trade_history(
    req: BridgeClosedTradesRequest,
    user: User = Depends(get_bridge_user),
    db: Session = Depends(get_db),
):
    """桥接程序上报真实平仓明细：按 (用户, MT5 成交编号) 去重后落库。

    与用户是否通过网页下单/平仓无关——只要仓位当初是本平台开的（魔术号码
    匹配），后续不管是网页平仓还是在 MT5 客户端手动平仓，都会被上报到这里。

    Bridge reports real closing deals; deduped by (user, MT5 deal ticket).
    Independent of whether the close was triggered via the web app — as long
    as the position was originally opened by this platform (magic-number
    matched), any subsequent close (web or manual in the MT5 terminal) lands
    here.
    """
    inserted = 0
    for leg in req.data:
        row = ClosedTrade(
            user_id=user.id,
            mt5_login=leg.login,
            symbol=leg.symbol,
            side=leg.side,
            close_volume=leg.closeVolume,
            close_price=leg.closePrice,
            profit=leg.profit,
            position_ticket=leg.positionTicket,
            deal_ticket=leg.dealTicket,
            closed_at=leg.closedAt,
        )
        db.add(row)
        try:
            db.commit()
            inserted += 1
        except IntegrityError:
            # 唯一约束冲突：已经上报过这笔成交，跳过 / already reported this deal, skip
            db.rollback()
    return {"ok": True, "inserted": inserted}


# ---------- 用户面向：Bridge 版本状态 / user-facing: Bridge version status ----------
@router.get("/version-status")
async def bridge_version_status(user: User = Depends(get_current_user)):
    """网页端"有新版本 Bridge 可更新"提示用：该用户最近上报的版本 + 当前
    GitHub 最新发布版本。`current` 为 null 表示这个用户从未连过带版本号
    上报的 Bridge（旧版或从未连接）——前端此时不应该提示更新（没有基准可比）。
    Powers the web app's "a newer Bridge is available" notice: this user's
    most recently reported version + the current latest GitHub release.
    `current` being null means this user has never connected a
    version-reporting Bridge (an old build, or never connected) — the
    frontend shouldn't show an update notice with nothing to compare against.
    """
    latest = await run_in_threadpool(bridge_version_check.get_latest)
    return {
        "current": user.bridge_version,
        "latest": (latest or {}).get("latest"),
        "downloadUrl": (latest or {}).get("downloadUrl"),
    }


# ---------- 用户面向：账号列表与后缀设置 / user-facing: account list & suffix ----------
@router.get("/accounts", response_model=dict)
def list_accounts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """列出当前用户的所有 MT5 账号 / list all MT5 accounts of the user."""
    rows = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user.id)
        .order_by(MT5Account.login.asc())
        .all()
    )
    accounts = [
        MT5AccountOut(
            login=r.login,
            server=r.server,
            source=r.source,
            accountName=r.account_name,
            accountCurrency=r.account_currency,
            balance=r.balance,
            equity=r.equity,
            leverage=r.leverage,
            company=r.company,
            symbolSuffix=r.symbol_suffix or "",
            online=is_account_online(r),
            lastHeartbeat=r.last_heartbeat,
        )
        for r in rows
    ]
    # accountLimit：当前订阅等级最多可连接的账户数，null 表示不限。
    # brokerLock：合作券商限制的展示信息，供绑定页提示"仅支持 XX 账户"。
    # accountLimit: max accounts allowed by the current plan; null means unlimited.
    # brokerLock: partner-broker lock display info for the Bind page notice.
    broker = get_broker_settings(db)
    return {
        "accounts": [a.model_dump(mode="json") for a in accounts],
        "accountLimit": max_mt5_accounts(user.plan),
        "brokerLock": {
            "enabled": bool(broker.get("broker_lock_enabled")),
            "displayName": broker.get("broker_display_name") or "",
            "referralUrl": broker.get("broker_referral_url") or "",
        },
    }


@router.delete("/accounts/{login}")
def delete_account(
    login: str,
    server: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除一个已知 MT5 账号（如已换券商的旧账号）。

    在线账号拒绝删除：桥接仍在上报的话，下次轮询会立刻把它重新插回，
    删除只会看起来"闪一下又出现"，不如直接提示用户先断开。

    Delete a known MT5 account (e.g. a stale one after switching brokers).
    Refuses to delete an online account: if the bridge is still reporting it,
    the next poll would just re-insert the row, so deletion would appear to
    flicker back — better to tell the user to disconnect first.
    """
    row = (
        db.query(MT5Account)
        .filter(
            MT5Account.user_id == user.id,
            MT5Account.login == login,
            MT5Account.server == (server or None),
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在 / Account not found")
    if is_account_online(row):
        raise HTTPException(
            status_code=409,
            detail="账号仍在线，请先断开桥接程序再删除 / Account is online; disconnect the bridge before deleting",
        )
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.post("/accounts/suffix")
def set_account_suffix(
    req: AccountSuffixRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """为指定账号设置品种后缀 / set symbol suffix for a specific account."""
    row = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user.id, MT5Account.login == req.login)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在 / Account not found")
    row.symbol_suffix = (req.symbolSuffix or "").strip()
    db.commit()
    return {"ok": True, "login": req.login, "symbolSuffix": row.symbol_suffix}


# ---------- 离线检测后台任务 / offline-detection background task ----------
async def offline_monitor_loop() -> None:
    """周期性检测账号从在线转离线并推送给前端。

    桥接停止轮询时不会再发 ACCOUNTS_STATUS，仅靠 last_heartbeat 过期，
    前端要等下次主动刷新才知道。此任务每 2 秒扫描一次，发现某用户的在线
    账号集合发生变化（尤其是变空）就主动推送，使断线在数秒内反映到前端。

    Periodically detect accounts that transitioned online->offline and push to
    clients. When the bridge stops polling it no longer sends ACCOUNTS_STATUS,
    so without this the UI only updates on the next manual refresh. Scanning
    every 2s and pushing on change makes a disconnect show up within seconds.
    """
    import asyncio

    from app.core.database import SessionLocal

    def _scan_online() -> dict[str, set[str]]:
        """扫描所有账号的在线状态（同步 DB 操作）/ scan online logins (blocking DB work)."""
        db = SessionLocal()
        try:
            current: dict[str, set[str]] = {}
            for r in db.query(MT5Account).all():
                if is_account_online(r):
                    current.setdefault(r.user_id, set()).add(r.login)
            return current
        finally:
            db.close()

    while True:
        await asyncio.sleep(2)
        try:
            # DB 扫描放线程池，避免阻塞事件循环 / DB scan off the event loop
            current = await run_in_threadpool(_scan_online)
            # 合并历史里出现过的用户，确保「全部离线」也能被检测到；
            # 与 bridge_poll 共用 _last_pushed_online，状态未变不重复推送。
            # Include users seen before so an all-offline transition is caught;
            # shares _last_pushed_online with bridge_poll to avoid duplicate pushes.
            for uid in set(_last_pushed_online) | set(current):
                await _push_accounts_status_if_changed(uid, current.get(uid, set()))
        except Exception:
            # 后台任务不因单次异常退出，但必须留下日志便于排查。
            # Never let the loop die on a transient error, but do log it.
            logger.exception("offline_monitor_loop error")
