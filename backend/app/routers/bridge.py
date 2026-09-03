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
from sqlalchemy import inspect as sa_inspect
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
from app.services.deps import ONLINE_WINDOW, get_current_user, is_account_online
from app.services.gateway_binding import is_revoked
from app.services.plans import max_mt5_accounts
from app.services.push_dispatch import (
    EVENT_BRIDGE_OFFLINE,
    EVENT_ORDER_FILLED,
    EVENT_ORDER_REJECTED,
    dispatch_event_push_async,
)
from app.services import bridge_version_check
from app.services.account_type import classify_account
from app.services.settings_store import (
    get_account_type_settings,
    get_broker_settings,
    server_matches_broker,
)
from app.services.symbol_aliases import broker_symbol
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

# user_id -> 上次推送的账号余额 {login: balance}。
#
# 余额只在出入金和平仓结算时变，属于低频事件，但变化必须尽快让前端知道：
# 账户卡片的净值 = 余额 + 浮动盈亏，浮盈已经随持仓每 1.5 秒推送，余额若还要等
# 前端 5 秒轮询，平仓瞬间净值就会用"新浮盈 + 旧余额"算，短时间显示一个错数。
#
# 这里只存余额不存净值：净值由前端自己用余额加浮盈算，本就不需要推。
# user_id -> last pushed balances {login: balance}. Balance only moves on
# deposits/withdrawals and close settlements, but the change must reach the
# frontend promptly: the card's equity is balance + floating P/L, and since
# floating P/L already streams every 1.5s, a stale balance would briefly render
# "new floating P/L + old balance". Only balance is tracked; equity is derived
# frontend-side.
_last_pushed_balances: dict[str, dict[str, float]] = {}


def _forget_idle_users(online_users: set[str]) -> None:
    """丢弃既无在线账号、又无 WS 连接的用户的推送去重状态。

    Drop push de-duplication state for users with neither online accounts nor a
    live WS connection.

    这两个字典是模块级的，只增不减：用户来过一次就留下条目，长期运行会一直涨。
    单条很小，但没有任何机制会把它删掉。

    两个条件必须同时满足才丢：
      · 无在线账号 —— 桥接已停，不会再有余额上报；
      · 无 WS 连接 —— 没人在看，丢了也不会漏推。
    只看其一都不安全：账号离线但页面还开着时，状态得留着，否则桥接一恢复就会
    因为"没有上次记录"而重推一遍；反之页面关了但桥接还在跑，也同理。

    重新出现的用户会被当作首次观测，照常收到一次完整推送，所以丢弃是安全的。

    Both conditions must hold: no online accounts (the bridge stopped, so no
    further balance reports) and no WS connection (nobody is watching, so
    dropping can't miss a push). Either alone is unsafe — with the page still
    open the state must persist, or the bridge coming back would re-push
    everything as if never seen. Users that reappear are treated as a first
    observation and get a full push, so dropping is safe.
    """
    connected = set(manager.connected_user_ids())
    for uid in set(_last_pushed_online) | set(_last_pushed_balances):
        if uid not in online_users and uid not in connected:
            _last_pushed_online.pop(uid, None)
            _last_pushed_balances.pop(uid, None)


async def push_balances_if_changed(user_id: str, balances: dict[str, float]) -> None:
    """只在余额变化时推送 ACCOUNTS_STATUS，不参与在线状态判定。

    Push ACCOUNTS_STATUS on balance changes only, without touching liveness.

    给 gateway 轮询用。gateway 账号没有心跳（在线与否取决于 gateway 服务本身），
    绝不能让它写 _last_pushed_online：那份状态由 bridge_poll 和 offline_monitor_loop
    按心跳维护，被 gateway 掺一脚会让 bridge 账号的在线状态每两秒抖动一次。
    所以这里把在线集合原样带回，只比对余额。

    Used by the gateway poller. Gateway accounts have no heartbeat, so this must
    never write _last_pushed_online — that state is maintained from heartbeats by
    bridge_poll and offline_monitor_loop, and letting the gateway interfere would
    make bridge accounts flap every two seconds. The online set is echoed back
    unchanged; only balances are compared.
    """
    previous = _last_pushed_balances.get(user_id)
    # 合并而非替换：一个用户可能同时有 bridge 和 gateway 账号，各自只知道自己
    # 那部分余额，直接覆盖会把对方的抹掉。
    # Merge rather than replace: a user may have both bridge and gateway accounts,
    # and each side only knows its own balances.
    merged = {**(previous or {}), **balances}
    if previous == merged:
        return
    _last_pushed_balances[user_id] = merged
    await manager.push_to_client(
        user_id,
        {
            "type": "ACCOUNTS_STATUS",
            "data": {
                "onlineLogins": sorted(_last_pushed_online.get(user_id, set())),
                "balances": merged,
            },
        },
    )


async def _push_accounts_status_if_changed(
    user_id: str, online: set[str], balances: dict[str, float] | None = None
) -> None:
    """在线账号集合或余额发生变化时推送 ACCOUNTS_STATUS；若从"有账号在线"变为
    "全部离线"，额外触发一次 bridge_offline 事件通知（若用户已开启）。

    Push ACCOUNTS_STATUS when the online-login set or any balance changed; if
    the transition is from "some accounts online" to "all offline", also fire
    a bridge_offline event notification (if the user has it enabled).
    """
    previous = _last_pushed_online.get(user_id)
    # 余额单独比对：在线集合往往一整天不变，只看它会把出入金和平仓结算的
    # 余额变化整个漏掉。
    # Compare balances separately: the online set often stays unchanged all day,
    # so keying only on it would miss every balance change.
    # 合并而非替换：同一用户的 gateway 账号余额由 push_balances_if_changed 写入，
    # 直接覆盖会把它们抹掉，前端那些账号的余额就会跳回旧值。
    # Merge rather than replace: this user's gateway balances are written by
    # push_balances_if_changed, and overwriting would wipe them.
    previous_balances = _last_pushed_balances.get(user_id)
    balances = {**(previous_balances or {}), **(balances or {})}
    balance_changed = previous_balances != balances
    if previous == online and not balance_changed:
        return
    _last_pushed_online[user_id] = online
    _last_pushed_balances[user_id] = balances
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
    # 带上余额，前端就能直接就地更新，不必再为此拉一次 /bridge/accounts。
    # Ship balances so the frontend can update in place instead of refetching.
    await manager.push_to_client(
        user_id,
        {
            "type": "ACCOUNTS_STATUS",
            "data": {"onlineLogins": sorted(online), "balances": balances},
        },
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
# 缓存的是 ORM 实例，跨请求复用有个硬性前提：它必须已脱离会话且所有列都已加载
# （见 _authenticate_cached 里的 expunge 与 _cached_user_usable）。
# The bridge fires several requests per second and each re-queries the DB just
# to authenticate its token — the single most repeated DB cost. Cache the
# authenticated user per token-hash for a few seconds; on a hit we skip the DB
# query. Cost: a plan change / token revocation takes at most TTL seconds to
# apply — fine for high-frequency polling. Reusing an ORM instance across
# requests has one hard requirement: it must be detached with every column
# loaded (see the expunge in _authenticate_cached and _cached_user_usable).
_AUTH_CACHE_TTL = 10.0  # 秒 / seconds
_auth_cache: dict[str, tuple[float, User]] = {}
_auth_cache_lock = Lock()


def invalidate_auth_cache_for_hash(token_hash: str | None) -> None:
    """按 token 哈希清除鉴权缓存条目。Token 重置时调用，让旧 Token 立即失效，
    不再有"重置后旧 Token 仍能用最多 TTL 秒"的窗口——重置本就是为了封掉一个
    可能已泄露的 Token，这个窗口必须归零。数据库里存的 user.api_token 就是
    Token 的 SHA-256 哈希，与本缓存的键完全一致，所以传旧的哈希即可精确命中。
    Drop a token-hash entry from the auth cache. Called on token reset so the old
    token stops working immediately, closing the "old token still valid for up to
    TTL seconds after reset" window — resetting exists precisely to kill a
    possibly-leaked token, so that window must be zero. The stored
    user.api_token is the token's SHA-256 hash, identical to this cache's key, so
    passing the old hash targets the exact entry."""
    if not token_hash:
        return
    with _auth_cache_lock:
        _auth_cache.pop(token_hash, None)


def _cached_user_usable(user: User) -> bool:
    """缓存实例是否还能安全读属性：必须是"游离且未过期"。
    Whether a cached instance is still safe to read: detached AND not expired.

    过期实例读任意一列都会触发一次刷新，而它已经没有会话可用，直接抛
    DetachedInstanceError。仍绑在某个会话上的实例同样不安全——那个会话属于
    另一个请求，随时可能提交（进而过期它）或被关闭。两种情况都当缓存未命中
    处理，回落到查库重新鉴权，代价只是一次 SELECT。
    Reading any column of an expired instance triggers a refresh, and with no
    session left that raises DetachedInstanceError. An instance still bound to a
    session is equally unsafe — that session belongs to another request and may
    commit (expiring it) or close at any moment. Both cases are treated as a
    cache miss and fall back to a DB lookup, costing just one SELECT.
    """
    state = sa_inspect(user)
    return state.session is None and not state.expired


def _authenticate_cached(db: Session, x_api_token: str | None) -> User | None:
    if not x_api_token:
        return None
    key = hash_api_token(x_api_token)
    now = time.monotonic()
    hit = _auth_cache.get(key)
    if hit is not None and hit[0] > now and _cached_user_usable(hit[1]):
        return hit[1]
    user = authenticate_api_token(db, x_api_token)
    if user is not None:
        # 缓存前先把实例摘出会话。SQLAlchemy 的 expire_on_commit 默认为 True，
        # 只要本请求后续任何一次 db.commit()，留在会话里的实例就会被整体标记为
        # 过期；请求结束会话一关，它就同时是 detached 又是 expired，下一个命中
        # 缓存的请求读任意一列即抛 DetachedInstanceError，端点 500。
        #
        # 这正是生产上桥接持续 500 的原因：/bridge/positions 每 1.5 秒上报一次，
        # mark_positions_seen() 和自动仓管评估都会 commit，而该端点在 commit 之后
        # 再没读过 user 的任何属性，于是把"已过期"的实例留在了缓存里；下一拍
        # /bridge/poll 命中缓存读 user.plan 就崩。/bridge/poll 自己不炸只是因为
        # 它在 commit 之后还访问了一次 user.id，顺手把实例刷活了——纯属巧合。
        #
        # expunge 之后，实例的所有列值都已加载且不再属于任何会话，任何人的
        # commit 都不会再让它过期，游离读取是安全的（也正是原注释设想的状态）。
        #
        # Expunge before caching. With SQLAlchemy's default expire_on_commit=True,
        # any later db.commit() in this request expires every instance still in
        # the session; once the request ends and the session closes, the instance
        # is both detached and expired, so the next request that hits the cache
        # raises DetachedInstanceError on the first column read and 500s.
        #
        # That is exactly the production outage: /bridge/positions reports every
        # 1.5s, mark_positions_seen() and the auto-manage pass both commit, and
        # that endpoint never touches user afterwards — leaving an expired
        # instance in the cache for the next /bridge/poll to trip over.
        # /bridge/poll survives its own commits only because it happens to read
        # user.id afterwards, incidentally refreshing the instance.
        #
        # After expunge, every column is loaded and the instance belongs to no
        # session, so nobody's commit can expire it and detached reads are safe —
        # the state the original comment assumed it already had.
        db.expunge(user)
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
    # 账户类型：0=模拟 1=竞赛 2=实盘（MT5 的 account_info().trade_mode 原值）。
    # 可空：旧版桥接不带这个字段，服务端按 None 处理、不覆盖已有值。
    # ⚠ 这是**用户侧程序自报**的值，理论上可伪造或故意缺省，可信度低于 gateway
    # 通道按券商组名判定的结果——见 models.MT5Account.trade_mode 的说明。
    # Account type as reported by the client (MT5's ACCOUNT_TRADE_MODE). Optional
    # so older bridges keep working. Self-reported, hence less trustworthy than
    # the gateway channel's broker-derived value.
    tradeMode: int | None = Field(default=None, ge=0, le=2)


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
    # 只在上报了才写：旧版桥接不带该字段，不能让 None 把已有值抹掉。
    # Only written when reported: an older bridge omits it, and None must not
    # wipe a value that's already there.
    if acc.tradeMode is not None:
        row.trade_mode = acc.tradeMode
    elif row.trade_mode is None:
        # 旧版桥接不报 tradeMode，且账号还没判定过：按组名/登录号段/服务器名
        # 依次兜底判一次（见 classify_account）。这里能拿到组名的账号很少——
        # 桥接载荷本身不带 MT5 组名，这个分支实际主要靠 server_login_rules
        # 的登录号段规则命中（如 Make Capital 一台服务器混跑模拟与实盘，靠
        # 登录号前几位区分）；`real_server_names` 整服务器白名单默认为空，
        # 只在券商真把模拟/实盘分到不同服务器时才配置。判不出来仍是 None，
        # 等下一轮 gamification 回填或运维补规则。
        # Older bridge omits tradeMode and the account has never been
        # classified: try the group / login-prefix / server fallback chain
        # (see classify_account). The bridge payload carries no MT5 group, so
        # in practice this branch is driven by the server_login_rules
        # login-prefix rules (e.g. Make Capital mixes demo and live on one
        # server, told apart by login prefix); the whole-server
        # `real_server_names` whitelist defaults to empty and only applies to
        # brokers that genuinely segregate demo/live onto separate servers.
        # Still None when nothing matches, left for the next gamification
        # backfill pass or an ops fix.
        settings = get_account_type_settings(db)
        row.trade_mode = classify_account(
            row.mt5_group, acc.server or row.server, acc.login, settings
        )
    row.online = True
    row.last_heartbeat = datetime.now(timezone.utc)
    return row, created


def _poll_db_work(
    db: Session, user: User, req: BridgePollRequest
) -> tuple[list[dict], list[dict], set[str], dict[str, float], list[str], list[str]]:
    """bridge_poll 的全部同步数据库工作（在线程池中执行）。
    All blocking DB work of bridge_poll (runs in a thread pool).

    返回 (待下发指令, 被作废订单的推送载荷, 在线账号集合, 账号余额 {login: balance},
    超额被拒的 login 列表, 非合作券商被拒的 login 列表)。
    Returns (commands to deliver, voided-order push payloads, online logins,
    balances keyed by login, logins rejected for exceeding the plan's account
    limit, logins rejected for not matching the partner broker).
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
    balances: dict[str, float] = {}
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
        # 取 row 而非 acc 的余额：被接受的账号才在这里，且 row 上的值已经过
        # _upsert_account 的"None 不覆盖"处理，与 /bridge/accounts 返回的完全一致。
        # Read balance off row, not acc: only accepted accounts reach here, and
        # row already went through _upsert_account's "don't overwrite with None"
        # handling, so it matches what /bridge/accounts returns.
        balances[acc.login] = float(row.balance or 0.0)
    # 记录这个用户最近上报的 Bridge 版本，供网页端"有新版本可更新"提示使用。
    # 注意：这里的 `user` 可能来自 get_bridge_user 的鉴权缓存（脱离本 db 会话的
    # detached 实例），直接改它的属性不会被 db.commit() 落库。必须按 id 显式
    # UPDATE，才能真正写进数据库。
    # Record this user's most recently reported Bridge version. NOTE: `user` may
    # come from get_bridge_user's auth cache (a detached instance not attached to
    # this db session), so mutating its attribute would NOT be persisted by
    # db.commit(). Persist via an explicit UPDATE keyed by id instead.
    if req.bridgeVersion and req.bridgeVersion != user.bridge_version:
        db.query(User).filter(User.id == user.id).update(
            {"bridge_version": req.bridgeVersion}, synchronize_session=False
        )
        user.bridge_version = req.bridgeVersion  # 同步缓存实例，避免下拍重复 UPDATE / keep the cached instance in sync
    db.commit()

    # 2) 取该用户、目标账号匹配的待执行订单 / fetch matching pending orders.
    #    包含两类：从未下发的；以及已下发但超时未回执的（可能回执丢失，需重发）。
    #    Includes: never-delivered orders, and delivered-but-unacked orders past
    #    the ack timeout (the ack may have been lost; safe to re-deliver because
    #    the bridge dedupes by clientOrderId).
    now = datetime.now(timezone.utc)
    ack_deadline = now - timedelta(seconds=settings.ORDER_ACK_TIMEOUT_SECONDS)
    # 自动仓管指令单独的超时窗口（30 秒）：追踪止损/保本的 MODIFY 和分批止盈的
    # CLOSE 是价格敏感的——桥接断线 3 分钟后重连，当初的止损价/止盈价已过时，
    # 再发出去是危险的。30 秒对桥接短暂的抖动（网络闪断、MT5 崩溃重启）足够宽容，
    # 对真正的长时间离线则直接作废。
    # Auto-manage commands get their own shorter timeout (30s): MODIFY for
    # trailing-stop/break-even and CLOSE for partial take-profit are price-
    # sensitive — if the bridge was gone for 3 minutes and reconnects, the
    # original SL/TP price is dangerously stale. 30s is forgiving enough for
    # transient blips (network flap, MT5 crash-restart) but voids commands that
    # are genuinely too old.
    AUTO_TTL_SECONDS = 30
    auto_deadline = now - timedelta(seconds=AUTO_TTL_SECONDS)
    pending = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.status == "PENDING")
        .order_by(Order.created_at.asc())
        .all()
    )
    # Gateway 账号的订单由 orders.py 实时执行，bridge 不轮询。
    # 提前查出所有 gateway 来源的 login，循环里直接跳过对应订单。
    # Gateway-sourced orders are executed directly by orders.py — skip them here.
    gateway_logins = set(
        row[0] for row in db.query(MT5Account.login).filter(
            MT5Account.user_id == user.id,
            MT5Account.source == "gateway",
        ).all()
    )
    commands = []
    voided: list[Order] = []
    for o in pending:
        # 跳过 gateway 账号的订单（已由 orders.py 实时执行）
        if o.mt5_login and o.mt5_login in gateway_logins:
            continue
        # 超时未执行的陈旧指令：作废而非下发，防止按过时价格成交。
        # Stale command past the pending timeout: void instead of dispatching,
        # so it can't fill at an outdated price.
        if is_stale_pending(o, now):
            void_stale_order(o)
            voided.append(o)
            continue
        # 自动仓管指令的超时窗口比通用指令短得多（30s vs 5min）：追踪止损/分批
        # 止盈是价格敏感的，旧指令的执行价已不可靠。已下发过一次且未回执、且超过
        # auto_deadline 的自动指令直接作废——下一轮持仓评估会按最新价格重新判断。
        # Auto-manage commands have a much shorter timeout (30s vs 5min):
        # trailing-stop/partial-take-profit are price-sensitive and an old
        # command's price is no longer trustworthy. Void any auto command that
        # was delivered at least once, is still unacked, and is past the
        # auto_deadline — the next evaluation pass will re-assess at current price.
        # created_at 落库为不带时区的列（Postgres TIMESTAMP / SQLite DATETIME），
        # 读回来是 naive；auto_deadline 是 aware。直接比较会抛
        # TypeError（can't compare offset-naive and offset-aware datetimes），
        # 整个 /bridge/poll 变 500——而这条自动指令永远作废不掉，桥接就会一直
        # 500 下去。与下面 delivered_at 的处理保持一致：先补上 UTC 时区。
        # created_at is stored in a timezone-naive column (Postgres TIMESTAMP /
        # SQLite DATETIME) and reads back naive, while auto_deadline is aware.
        # Comparing them directly raises TypeError and turns the whole
        # /bridge/poll into a 500 — and since the void never commits, the auto
        # command stays PENDING and every later poll 500s too. Normalize to UTC
        # first, same as delivered_at below.
        created = o.created_at
        if created is not None and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if (
            o.client_order_id and o.client_order_id.startswith(AUTO_PREFIX)
            and created is not None and created < auto_deadline
        ):
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
        # 下发的是"券商基础名 + 该账号的组后缀"：o.symbol 存的是信号侧的写法
        # （比特币是 TradingView 发来的 BTCUSDT），券商品种表里只有 BTCUSD.s
        # 这种名字，直接拼后缀会得到不存在的 BTCUSDT.s。桥接侧还会再解析一次
        # （见 mt5_worker._resolve_broker_symbol），那一层能兜住后缀探测出错和
        # 更冷门的命名漂移；这里先收敛名字，让旧版桥接也能受益。
        # Dispatch the broker base name plus this account's group suffix:
        # o.symbol holds the signal-side spelling (Bitcoin arrives from
        # TradingView as BTCUSDT) while the broker's table only has names like
        # BTCUSD.s, so appending the suffix raw yields a non-existent
        # BTCUSDT.s. The bridge resolves once more on its side (see
        # mt5_worker._resolve_broker_symbol), which also covers a mis-detected
        # suffix and rarer naming drift; collapsing the name here means older
        # bridge builds get the fix too.
        commands.append({
            "clientOrderId": o.client_order_id,
            "action": o.action or "ORDER",
            "login": target,
            "symbol": broker_symbol(o.symbol) + suffix,
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

    return (
        commands, voided_payloads, online_logins, balances,
        rejected_logins, broker_rejected,
    )


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
    (
        commands, voided_payloads, online_logins, balances,
        rejected_logins, broker_rejected,
    ) = await run_in_threadpool(
        _poll_db_work, db, user, req
    )

    # 推送被作废订单的状态给前端 / push voided orders' status to the client
    for payload in voided_payloads:
        await manager.push_to_client(user.id, payload)

    # 账号在线状态：仅变化时推送 / account status: push only on change
    await _push_accounts_status_if_changed(user.id, online_logins, balances)

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


def _result_db_work(db: Session, user_id: int, req: "BridgeResultRequest"):
    """回执落库的同步段。返回 (order, duplicate)。

    幂等判重下沉进 UPDATE 的 WHERE，用受影响行数判定，而不是"先读状态再无条件写"。

    原来那套读-改-写靠单事件循环天然串行：整段没有 await，第二个并发回执只可能在
    第一个 commit 之后才开始执行，必然读到 FILLED/REJECTED 而走 duplicate 分支。
    搬进线程池后两个回执会在各自的工作线程里同时读到 PENDING、同时提交，于是同一笔
    订单推两帧 ORDER_UPDATE、发两条 Web Push，第二个还会返回 {"ok": true} 而不是
    {"ok": true, "duplicate": true}。既然事件循环不再仲裁，就得让数据库来仲裁。

    SQL 条数与顺序不变：仍是 1 条 SELECT + 1 条 UPDATE + COMMIT + 1 条 refresh。

    Idempotency moves into the UPDATE's WHERE clause and is decided by the affected
    row count instead of "read the status, then write unconditionally". The old
    read-modify-write was serialized by the single event loop — no await inside, so
    a concurrent second result could only start after the first commit and would
    always take the duplicate branch. In a thread pool both would observe PENDING
    and both commit, emitting two ORDER_UPDATE frames and two web pushes. With the
    event loop no longer arbitrating, the database has to. Same SQL count and order.
    """
    order = (
        db.query(Order)
        .filter(Order.user_id == user_id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if not order:
        return None, False

    values = {
        "status": "FILLED" if req.success else "REJECTED",
        "mt5_ticket": req.mt5Ticket,
        "filled_price": req.filledPrice,
        "message": req.message,
    }
    # 兜底路由时补上实际执行账号，指定过目标账号的订单不覆盖已有值。
    # Backfill the actual executing account for fallback-routed orders; never
    # overwrite an order that already specified its target account.
    login = req.login or order.mt5_login
    if req.login and not order.mt5_login:
        values["mt5_login"] = req.login

    # 成交打章：从账号行拷贝 trade_mode 快照（设计 §1.2），失败/拒绝不打章。
    # Stamp the trade_mode snapshot from the account row on a genuine fill
    # (design §1.2); rejected orders are left unstamped.
    if req.success:
        from app.services.gamification.stamp import lookup_trade_mode
        tm = lookup_trade_mode(db, user_id, login)
        if tm is not None:
            values["trade_mode"] = tm

    # 真实回执覆盖状态（包括迟到回执纠正已超时作废的 FAILED——实际执行结果为准），
    # 但已是终态的不覆盖：这正是幂等判重，现在由 WHERE 条件表达。
    # The genuine result wins, including a late result correcting a timed-out
    # FAILED order — reality beats our assumption. Already-terminal rows are left
    # alone: that's the idempotency check, now expressed by the WHERE clause.
    claimed = (
        db.query(Order)
        .filter(Order.id == order.id, Order.status.notin_(("FILLED", "REJECTED")))
        .update(values, synchronize_session=False)
    )
    db.commit()
    if not claimed:
        return order, True

    db.refresh(order)
    return order, False


@router.post("/result")
async def bridge_result(
    req: BridgeResultRequest,
    user: User = Depends(get_bridge_user),
    db: Session = Depends(get_db),
):
    """桥接程序回报执行结果 / bridge reports execution result."""
    order, duplicate = await run_in_threadpool(_result_db_work, db, user.id, req)

    if order is None:
        raise HTTPException(status_code=404, detail="订单不存在 / Order not found")
    if duplicate:
        return {"ok": True, "duplicate": True}

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
    # push_positions 内部会缓存快照、附带按 login 汇总的浮动盈亏，并跳过与上一拍
    # 完全相同的推送。账户卡片因此和持仓表同源同拍，不再等 /bridge/accounts 那条
    # 5 秒轮询。
    # push_positions caches the snapshot, attaches per-login floating P/L, and
    # skips ticks identical to the previous one. The account card now shares the
    # positions table's data instead of waiting on the 5s /bridge/accounts poll.
    await manager.push_positions(user.id, req.data, source="bridge")
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


def _known_position_ids(db: Session, user_id: str, logins: set[str]) -> set[tuple[str, int]]:
    """本用户已成交开仓订单的 (账号, 仓位编号) 集合——归属核验的依据。

    两条通道的仓位编号存在不同列：bridge 在 mt5_ticket，gateway 在 mt5_position
    （见 services/trade_performance.position_id_of），两个都收。只查上报涉及的
    账号，不扫全表。
    """
    if not logins:
        return set()
    rows = (
        db.query(Order.mt5_login, Order.mt5_ticket, Order.mt5_position)
        .filter(
            Order.user_id == user_id,
            Order.action == "ORDER",
            Order.status == "FILLED",
            Order.mt5_login.in_(list(logins)),
        )
        .all()
    )
    known: set[tuple[str, int]] = set()
    for login, ticket, position in rows:
        for pos_id in (ticket, position):
            if pos_id:
                known.add((str(login), int(pos_id)))
    return known


def _trade_history_db_work(
    db: Session, user_id: str, legs: list["BridgeClosedTrade"]
) -> tuple[int, int]:
    """核验 + 落库，返回 (新插入条数, 未通过核验条数)。

    与 `_result_db_work` 同样的理由抽成模块级函数：端点把它丢进线程池执行，
    留在闭包里就没法单独测——而这里的判定逻辑正是最需要测的部分。
    Module-level for the same reason as _result_db_work: the endpoint hands it
    to a threadpool, and a closure can't be tested on its own.
    """
    known = _known_position_ids(db, user_id, {leg.login for leg in legs})
    inserted = 0
    unverified = 0
    for leg in legs:
        is_ours = (leg.login, leg.positionTicket) in known
        if not is_ours:
            unverified += 1
        db.add(ClosedTrade(
            user_id=user_id,
            mt5_login=leg.login,
            symbol=leg.symbol,
            side=leg.side,
            close_volume=leg.closeVolume,
            close_price=leg.closePrice,
            profit=leg.profit,
            position_ticket=leg.positionTicket,
            deal_ticket=leg.dealTicket,
            closed_at=leg.closedAt,
            verified=is_ours,
        ))
        try:
            db.commit()
            inserted += 1
        except IntegrityError:
            # 唯一约束冲突：已经上报过这笔成交，跳过 / already reported, skip
            db.rollback()
    return inserted, unverified


@router.post("/trade-history")
async def bridge_trade_history(
    req: BridgeClosedTradesRequest,
    user: User = Depends(get_bridge_user),
    db: Session = Depends(get_db),
):
    """桥接程序上报真实平仓明细：按 (用户, 账号, MT5 成交编号) 去重后落库。

    与用户是否通过网页下单/平仓无关——只要仓位当初是本平台开的，后续不管是
    网页平仓还是在 MT5 客户端手动平仓，都会被上报到这里。

    **服务端归属核验**：这个端点的数据来自用户自己电脑上的桥接程序，凭的是该
    用户自己的 API Token。"只收本平台开的仓位"这条规则原本只跑在客户端（靠魔术
    号码筛选），服务端收到什么写什么——任何人都能用自己的 token 直接 POST 一批
    凭空捏造的盈利记录。这里补上与 gateway 通道同款的核对（见 routers/gateway.py
    的 _save_closed_trades）：平仓腿的 (账号, 仓位编号) 必须对得上本用户一笔已成交
    的开仓订单，对得上才 verified=True。

    核不过的记录**照常入库**、只是标 False：回执丢失、历史遗留等正当原因都会让
    订单侧缺号，因存疑就丢掉用户真实的交易记录代价更大。凡是"对外代表用户成绩"
    的统计（未来的排行榜/比赛/等级考核）都只应认 True。

    Bridge reports real closing deals, deduped by (user, login, deal ticket).
    Adds the server-side attribution check the bridge channel never had (the
    magic-number filter runs only on the user's own machine, so the endpoint
    used to store whatever it was sent): a leg's (login, position id) must match
    one of this user's filled opening orders. Unmatched legs are still stored,
    flagged verified=False, since a lost fill callback is a legitimate cause —
    but any statistic that represents the user's record to others must require
    True.
    """
    if not req.data:
        return {"ok": True, "inserted": 0}

    inserted, unverified = await run_in_threadpool(
        _trade_history_db_work, db, user.id, req.data
    )

    # 核不过的记录留一条日志：正式启用"只认 verified"之前，先靠它观察真实世界里
    # 有多少**正当**记录会被误判（回执丢失、历史遗留），避免日后一刀切误伤。
    # Log unverified legs: before anything starts requiring verified=True, this
    # is how we learn how many legitimate records would be caught by it.
    if unverified:
        logger.warning(
            "平仓明细归属核验：用户 %s 本次 %d 条中有 %d 条对不上本平台订单 / "
            "%d of %d reported legs matched no platform order",
            user.id, len(req.data), unverified, unverified, len(req.data),
        )

    # 有新平仓就立刻通知前端重拉，别等它自己的 45 秒轮询。
    # 上报是幂等的（唯一约束去重），所以只在真有新增时推，避免每轮都发无用消息。
    # Nudge the web app as soon as something new lands instead of waiting for
    # its own 45s poll. Reports are idempotent, so only push on real inserts.
    if inserted:
        await manager.push_to_client(user.id, {"type": "CLOSED_TRADE_NEW"})

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
            needsReverify=is_revoked(r),
            revokedReason=r.revoked_reason,
            tradeMode=r.trade_mode,
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
        """扫描当前在线的账号（同步 DB 操作）/ scan online logins (blocking DB work).

        只查心跳还新鲜的行，且只取两列。此前是 `db.query(MT5Account).all()`——
        每 2 秒把全表所有用户的所有账号整行取回，再在 Python 里逐行判在线。这个
        循环 24 小时不停，每分钟 30 次；生产库是远端 Supabase，每次都带一次网络
        往返，取回的行数随注册用户数线性增长，而其中绝大多数账号根本不在线。
        判定条件与 is_account_online 完全一致（同一个 ONLINE_WINDOW），只是把它
        从 Python 挪进 WHERE，让数据库走索引直接过滤。

        Query only rows whose heartbeat is still fresh, and only two columns. This
        used to be `db.query(MT5Account).all()` — every 2 seconds it pulled whole
        rows for every account of every user and evaluated liveness in Python. The
        loop never stops, 30 times a minute; production talks to a remote Supabase
        so each pass is a network round trip, the row count grows linearly with
        registered users, and nearly all of those accounts aren't online anyway.
        The predicate is identical to is_account_online (same ONLINE_WINDOW),
        just moved from Python into the WHERE clause so the database can use an
        index instead.
        """
        db = SessionLocal()
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(seconds=ONLINE_WINDOW)
            current: dict[str, set[str]] = {}
            rows = (
                db.query(MT5Account.user_id, MT5Account.login)
                .filter(MT5Account.last_heartbeat >= cutoff)
                .all()
            )
            for user_id, login in rows:
                current.setdefault(user_id, set()).add(login)
            return current
        finally:
            db.close()

    while True:
        await asyncio.sleep(2)
        try:
            # 没有活跃 WebSocket 连接时休眠 30 秒，避免无谓的数据库查询。
            # 断线检测的意义只在于把状态推给「正在看」的前端；没有任何前端
            # 连着时，扫库纯属浪费——生产库是远端 Supabase，每 2 秒一次网络往返
            # 的出站流量常年累积得非常可观。有连接时立即恢复 2 秒的灵敏度。
            # When no client is connected, sleep 30s to avoid needless DB queries:
            # offline detection only matters for a frontend that's actively
            # watching. With a remote Supabase, a round trip every 2s adds up.
            # Sensitivity returns to 2s the moment a client connects.
            if not manager.connected_user_ids():
                await asyncio.sleep(30)
                continue

            # DB 扫描放线程池，避免阻塞事件循环 / DB scan off the event loop
            current = await run_in_threadpool(_scan_online)
            # 合并历史里出现过的用户，确保「全部离线」也能被检测到；
            # 与 bridge_poll 共用 _last_pushed_online，状态未变不重复推送。
            # Include users seen before so an all-offline transition is caught;
            # shares _last_pushed_online with bridge_poll to avoid duplicate pushes.
            for uid in set(_last_pushed_online) | set(current):
                # 不传余额：这个循环只负责在线状态。函数内部会与上次推送的
                # 余额合并，所以已知余额不会丢，也不会被误判成变化。
                # No balances here: this loop only tracks liveness. The function
                # merges with the last pushed balances, so nothing is lost or
                # misread as a change.
                await _push_accounts_status_if_changed(uid, current.get(uid, set()))

            _forget_idle_users(set(current))
        except Exception:
            # 后台任务不因单次异常退出，但必须留下日志便于排查。
            # Never let the loop die on a transient error, but do log it.
            logger.exception("offline_monitor_loop error")
