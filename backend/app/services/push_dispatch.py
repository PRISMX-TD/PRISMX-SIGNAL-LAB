"""Web Push 推送派发 / Web Push dispatching.
当信号引擎或 webhook 产生新信号时调用 dispatch_push 遍历匹配用户并推送。

注意：dispatch_push 内部有阻塞网络 IO（逐个订阅调用推送服务），
必须放在线程池里执行（见 dispatch_push_async），不能直接在事件循环中调用。
Note: dispatch_push does blocking network IO (one HTTP call per subscription),
so it must run in a thread pool (see dispatch_push_async), never directly on
the event loop.
"""
import json
import logging
import re
import threading
from datetime import datetime, timezone
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from starlette.concurrency import run_in_threadpool
from pywebpush import WebPushException, webpush

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import NotificationPref, PushSubscription, Signal, User
from app.services.plans import can_use_push
from app.utils.indicator import indicator_category

logger = logging.getLogger("push")

# 推送服务域名白名单。订阅的 endpoint 完全由浏览器给出、再由前端原样上报，服务端
# 拿到后会直接对它发起 HTTP 请求——这是一个由用户提供 URL、服务端去访问的经典
# SSRF 面：不加限制的话，付费用户可以注册一个指向内网（169.254.169.254 之类云元
# 数据服务、或内部管理端口）的"订阅"，借服务端去打内网。
#
# 真实的 Web Push 端点只可能来自浏览器厂商的少数几个域，按域名后缀匹配即可。写成
# 配置项是因为厂商偶尔会启用新域名，那时不该需要改代码重新发版。
#
# Allowlist of push-service hosts. A subscription endpoint comes from the
# browser, is relayed verbatim by the frontend, and the server then makes an HTTP
# request to it — the textbook shape of an SSRF sink (user-supplied URL, fetched
# server-side). Unrestricted, a paying user could register a "subscription"
# pointing at the internal network (cloud metadata at 169.254.169.254, an
# internal admin port) and have the server reach it for them.
#
# Real endpoints only ever come from a handful of browser-vendor domains, so a
# host-suffix match suffices. It lives in config because vendors do occasionally
# bring up new domains, and that shouldn't require a code change.
_PUSH_HOST_SUFFIXES = tuple(
    h.strip().lower()
    for h in settings.PUSH_ENDPOINT_HOST_SUFFIXES.split(",")
    if h.strip()
)


def is_allowed_push_endpoint(endpoint: str) -> bool:
    """endpoint 是否是可信推送服务的 https 地址 / whether this is an https URL on a known push service."""
    try:
        parsed = urlparse(endpoint)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    # 后缀匹配必须带点边界，否则 "evilfcm.googleapis.com.attacker.tld" 之类
    # 也会被 endswith 放行。/ The dot boundary matters: a bare endswith would
    # also accept "…googleapis.com.attacker.tld".
    return any(host == s or host.endswith("." + s) for s in _PUSH_HOST_SUFFIXES)


# ---------- App 端订阅（FCM）/ app-side subscriptions (FCM) ----------
# 安卓 App 是 Capacitor WebView，里面没有 Web Push。App 内的桥接把自己伪装成一条
# 普通订阅上报给未改动的前端：endpoint = "fcm://<FCM 注册令牌>"，keys 用占位串。
#
# 这个 endpoint **不是 URL，服务端永远不会对它发起 HTTP 请求**——真正的请求固定
# 打向 FCM_ENDPOINT_TMPL 这一个写死的 googleapis.com 地址，令牌只作为请求体里的
# 一个字段。所以它不在 is_allowed_push_endpoint 的管辖范围内：那个白名单回答的
# 是「服务端能不能去请求这个用户给的 URL」（SSRF 面），而这里根本没有用户给的
# URL。故意写成两个独立谓词、在调用点显式分支，而不是把 fcm:// 塞进白名单函数
# ——后者会让那个函数的名字开始撒谎，日后读代码的人会以为 fcm:// 也被请求过。
#
# The Android app is a Capacitor WebView with no Web Push, so its bridge reports
# itself to the unchanged frontend as an ordinary subscription: endpoint =
# "fcm://<registration token>", placeholder keys.
#
# That endpoint is NOT a URL and the server never issues a request to it — the
# request always goes to the one hard-coded googleapis.com address below, with
# the token as a body field. Hence it stays outside is_allowed_push_endpoint,
# which answers a different question ("may the server fetch this user-supplied
# URL?", the SSRF surface) that simply doesn't arise here. Two separate
# predicates with explicit branching at the call sites, deliberately: widening
# the allowlist would make its name lie to the next reader.
FCM_SCHEME = "fcm://"
# 桥接上报的占位密钥。Web Push 的 p256dh/auth 在 FCM 路径上没有对应物，但订阅接口
# 的形状不变（前端未改动），所以桥接填这个字面量，服务端据此确认「这确实是 App
# 报上来的行」而不是谁手工构造的。
# The bridge's placeholder keys: Web Push's p256dh/auth have no counterpart on
# the FCM path, but the subscribe API's shape is unchanged (the frontend wasn't
# touched), so the bridge sends this literal and the server uses it to confirm
# the row really came from the app rather than being hand-crafted.
FCM_PLACEHOLDER_KEY = "fcm"
# 令牌形状取保守值：FCM 注册令牌很长，由 base64url 字符加 ":" 组成，绝不含
# "/" 或空白——把这两类挡在外面，等于从形状上排除掉「看起来像路径/URL」的输入。
# Conservative token shape: FCM registration tokens are long, made of base64url
# characters plus ":", and never contain "/" or whitespace — excluding those
# rules out anything path- or URL-shaped by construction.
_FCM_TOKEN_RE = re.compile(r"^[A-Za-z0-9_:\-]{50,4096}$")


def is_fcm_endpoint(endpoint: str) -> bool:
    """endpoint 是否是 App 桥接上报的 fcm:// 订阅（令牌形状也要合法）。
    Whether this is an app-bridge fcm:// subscription with a well-formed token."""
    if not isinstance(endpoint, str) or not endpoint.startswith(FCM_SCHEME):
        return False
    return bool(_FCM_TOKEN_RE.match(endpoint[len(FCM_SCHEME):]))


def fcm_token(endpoint: str) -> str:
    """取出 fcm:// 后面的注册令牌 / the registration token behind fcm://."""
    return endpoint[len(FCM_SCHEME):]


def _token_hint(token: str) -> str:
    """日志里只出现令牌前缀：完整令牌等同于一把可以向该设备发推送的钥匙。
    Logs only ever carry a prefix — a full token is a key to push to that device."""
    return f"{token[:8]}…({len(token)})" if token else "?"


# 事件类通知的合法取值：订单成交/拒绝、自动仓管触发、Bridge 掉线。
# 此前推送只有"新信号"一种，账户/交易层面发生的事都是静默的——包括自动仓管
# 这种会动用户仓位的后台动作，用户可能压根不知道发生过。
# Valid event-notification kinds: order fill/reject, auto-manage trigger,
# bridge offline. Push used to only ever fire for "new signal" — everything
# at the account/trading layer was silent, including auto-management actually
# touching the user's position in the background without them necessarily
# knowing it happened.
EVENT_ORDER_FILLED = "order_filled"
EVENT_ORDER_REJECTED = "order_rejected"
EVENT_AUTO_MANAGE = "auto_manage"
EVENT_BRIDGE_OFFLINE = "bridge_offline"
# 用户自建策略命中条件、生成个人信号时的通知——像平台信号一样可以推送，
# 但只对触发它的那一个用户,走事件类通知这条单用户路径,不是按类别扇出。
# Fired when the user's own strategy condition is met and a personal signal
# is generated — pushable just like a platform signal, but only to the one
# user who owns it, so it goes through the single-user event-notification
# path rather than the category fan-out.
EVENT_STRATEGY_SIGNAL = "strategy_signal"
# 直连账号的绑定被撤销（券商侧密码变了，见 services/gateway_binding.py）。
#
# 单独一类而不是复用 bridge_offline：两者要用户做的事完全不同。离线是"等等看
# 或去检查桥接"，撤销是"你不去重新验证，它永远不会自己好"——而且在那之前所有
# 自动下单都是静默失效的。合成一类会让这条最需要立刻动手的通知混在最常见的
# 那类噪音里。
#
# A direct-connect binding was revoked (the broker-side password changed).
# A separate kind rather than reusing bridge_offline: offline means wait, this
# means act — until the user re-verifies, every automated order silently fails.
EVENT_ACCOUNT_REVOKED = "account_revoked"
# 勋章授予通知。2026-09-07 起与账户 / 交易事件同一待遇：开了通知总开关就推
# （此前是 opt-in，NULL 偏好默认不含它）。
# Badge-awarded notification; since 2026-09-07 treated like the account/trading
# events: on whenever notifications are on (it used to be opt-in).
EVENT_BADGE_AWARDED = "badge_awarded"
# 平台公告。低频、由管理员逐条决定是否推送（AnnouncementIn.notify），用户侧与
# 账户事件同一待遇：开了通知总开关就收。
# Platform announcement. Rare, and each one opts into push on the admin side
# (AnnouncementIn.notify); users receive it whenever notifications are on.
EVENT_ANNOUNCEMENT = "announcement"
EVENT_TYPES = {
    EVENT_ORDER_FILLED, EVENT_ORDER_REJECTED, EVENT_AUTO_MANAGE,
    EVENT_BRIDGE_OFFLINE, EVENT_ACCOUNT_REVOKED, EVENT_STRATEGY_SIGNAL,
    EVENT_BADGE_AWARDED, EVENT_ANNOUNCEMENT,
}

# 只要通知总开关打开就一定推的事件（账户 / 交易 + 成就），不看事件白名单：通知
# 设置页 2026-09-07 起不再给这些事件单独的开关——它们要么是需要用户处理的事
# （成交 / 拒单 / 掉线 / 需重新验证 / 自动仓管动作），要么是低频正向反馈，没有
# "开了通知却不想知道"的合理场景，单独开关只会多一层误关的机会。事件白名单
# 现在只管 strategy_signal（我的策略信号）这一个仍由用户自己勾选的事件。
# Events that fire whenever notifications are on, regardless of the per-event
# whitelist. The settings page no longer offers toggles for them (2026-09-07):
# they are either things the user must act on or rare positive feedback, and
# a per-event switch only added a way to turn them off by accident. The
# whitelist now only governs strategy_signal, the one still user-toggled event.
ALWAYS_ON_EVENTS = EVENT_TYPES - {EVENT_STRATEGY_SIGNAL}

# 白名单哨兵值："不限"，命中任意取值（含此刻还不存在、以后才出现的品种/类别）。
# Whitelist sentinel meaning "unrestricted" — matches any value, including
# ones (like a symbol) that don't exist yet and only show up later.
ALL_SENTINEL = "__ALL__"


def _list_matches(selected: list, value: str) -> bool:
    """selected 是否放行 value：命中哨兵值即不限，否则要求精确匹配。
    Whether the whitelist `selected` allows `value`: the sentinel means
    unrestricted, otherwise an exact match is required."""
    return ALL_SENTINEL in selected or value in selected


def _parse_event_types(raw: str | None) -> set[str]:
    """解析偏好行的事件白名单。NULL = 用户从未配置过 → 全部事件默认开启（产品
    语义，见 models.NotificationPref）。"[]" = 明确全关；解析失败按全关处理
    （脏数据不该反而放大推送面）。注意派发侧对 ALWAYS_ON_EVENTS 不看这份白名单
    （见 _event_prefs_allow），这里的结果只对 strategy_signal 有实际约束力。
    Parse a pref row's event whitelist. NULL = never configured → all events
    on by default. "[]" = explicitly all off; unparseable data counts as all
    off (bad data must not widen the push surface). Dispatch ignores this list
    for ALWAYS_ON_EVENTS (see _event_prefs_allow), so in practice it only
    constrains strategy_signal."""
    if raw is None:
        return set(EVENT_TYPES)
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return set()
    if not isinstance(parsed, list):
        return set()
    return {e for e in parsed if e in EVENT_TYPES}


_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _within_push_window(pref: NotificationPref, now: datetime | None = None) -> bool:
    """当前时刻是否落在该用户设置的推送时段内。
    起止都为空 = 不限制；只设了一头或格式不合法 = 视为不限制（宁可多推也不能
    因脏数据静默吞掉所有通知）；start == end 同样视为不限制——时间选择器里把
    两头拖成一样多半是误操作，按"全天禁推"理解会让用户困惑为什么一条都收不到。
    start > end 表示跨零点的隔夜时段（如 22:00–07:00）。时区用用户设备上报的
    IANA 名称换算本地时间，缺失或无效回退 UTC。

    Whether "now" falls inside the user's push window. Both bounds empty = no
    restriction; only one bound set, or malformed values = treated as
    unrestricted (over-pushing beats silently swallowing everything on bad
    data); start == end is also unrestricted — dragging both pickers to the
    same value is almost always a slip, and reading it as "never push" would
    leave the user wondering why nothing arrives. start > end wraps overnight
    (e.g. 22:00–07:00). Local time comes from the device-reported IANA
    timezone, falling back to UTC when missing/invalid."""
    start_s, end_s = pref.push_window_start, pref.push_window_end
    if not start_s or not end_s:
        return True
    if not _HHMM_RE.match(start_s) or not _HHMM_RE.match(end_s):
        return True
    if start_s == end_s:
        return True
    try:
        tz = ZoneInfo(pref.push_window_tz) if pref.push_window_tz else timezone.utc
    except Exception:
        tz = timezone.utc
    local = (now or datetime.now(timezone.utc)).astimezone(tz)
    minutes = local.hour * 60 + local.minute
    start = int(start_s[:2]) * 60 + int(start_s[3:])
    end = int(end_s[:2]) * 60 + int(end_s[3:])
    if start < end:
        return start <= minutes < end
    # 跨零点 / overnight wrap
    return minutes >= start or minutes < end


async def dispatch_push_async(signal: Signal) -> None:
    """在线程池中执行推送派发，避免阻塞事件循环。
    Run push dispatching in a thread pool to keep the event loop responsive."""
    try:
        await run_in_threadpool(dispatch_push, signal)
    except Exception:
        logger.exception("dispatch_push_async error")


def _matched_user_ids(db, cat: str, symbol: str) -> set[str]:
    """解析每个用户的白名单 JSON 并做精确匹配（不用 SQL LIKE，避免类别名互为
    子串时误匹配），再按当前订阅等级过滤掉 FREE。

    策略类别与品种是两条独立白名单，按"与"关系联合：一条信号必须两边都命中
    才通知，例如只勾了"AIFT + 黄金"的用户收不到"AIFT + 欧美"或"云指标 + 黄金"。

    这条新信号此刻仍是 ACTIVE（尚未过期），FREE 等级要等它过期后才能在
    REST/WS 里看到——这里必须同步过滤，否则一个此前是付费用户、开过推送、
    后来被降级为 FREE 的账号，会绕过延迟机制提前用推送收到通知（偏好行的
    enabled=True 不会因降级自动清空）。

    Parse each user's whitelist JSON and match exactly (SQL LIKE would
    false-match categories that are substrings of one another), then filter
    out FREE-plan users.

    Category and symbol are two independent whitelists ANDed together: a
    signal only notifies if both match — e.g. a user who only ticked
    "AIFT + gold" won't get "AIFT + EURUSD" or "cloud-indicator + gold".

    This signal is still ACTIVE (not yet expired); FREE tier only sees it via
    REST/WS once it expires. Filtering here is required — otherwise a user
    who was once paid, enabled push, and later got downgraded to FREE would
    keep receiving push for brand-new signals ahead of the delay (their pref
    row's enabled=True doesn't get cleared by a downgrade).
    """
    user_ids: set[str] = set()
    prefs = db.query(NotificationPref).filter(NotificationPref.enabled == True).all()  # noqa: E712
    for p in prefs:
        # 推送时段外直接跳过（信号不补发：过了时段它多半已经过期）。
        # Outside the user's push window, skip — signals aren't re-sent later
        # (by then they've usually expired anyway).
        if not _within_push_window(p):
            continue
        try:
            cats = json.loads(p.selected_categories or "[]")
            syms = json.loads(p.selected_symbols or "[]")
        except (ValueError, TypeError):
            continue
        if not isinstance(cats, list) or not isinstance(syms, list):
            continue
        if _list_matches(cats, cat) and _list_matches(syms, symbol):
            user_ids.add(p.user_id)
    if not user_ids:
        return user_ids
    realtime_ids = {
        uid
        for uid, plan in db.query(User.id, User.plan).filter(User.id.in_(user_ids)).all()
        if can_use_push(plan)
    }
    return realtime_ids


def _webpush_one(
    sub: PushSubscription, payload: str, pem: str, vapid_claims: dict, headers: dict
) -> tuple[bool, bool]:
    """向单个订阅推送一条消息。返回 (是否发送成功, 是否应清理该订阅)。
    Push one message to a single subscription. Returns (sent ok, should prune)."""
    # 发出请求前再校验一次 endpoint。订阅入口已经挡了一道，这里是针对**库里存量
    # 行**的兜底：白名单收紧、或早于该校验写入的订阅，都不该在这一刻被真的请求
    # 出去。标记清理而非静默跳过——一个永远不合法的 endpoint 留在表里没有意义。
    # Re-check the endpoint before making the request. The subscribe endpoint
    # already rejects bad ones; this covers rows *already in the table* — written
    # before the check existed, or legal under an older, looser allowlist. Marked
    # for pruning rather than silently skipped: an endpoint that can never be
    # dispatched has no reason to stay.
    if not is_allowed_push_endpoint(sub.endpoint):
        logger.warning("[push] 拒绝非白名单 endpoint sub=%s", sub.id)
        return False, True
    try:
        webpush(
            subscription_info={
                "endpoint": sub.endpoint,
                "keys": {"p256dh": sub.keys_p256dh, "auth": sub.keys_auth},
            },
            data=payload,
            vapid_private_key=pem,
            # 必须按订阅复制：pywebpush 会把 aud（按第一个 endpoint 的推送服务
            # 域名推导）原地写进传入的 claims 字典且此后不再覆盖。调用方在循环里
            # 复用同一个字典时，第一个订阅是哪家推送服务（FCM/Apple/Mozilla），
            # aud 就永远是哪家——后续所有落在其它推送服务上的订阅（典型：桌面
            # Chrome + iPhone 混用的用户）全部因 aud 不匹配被 403 BadJwtToken
            # 拒收，而 403 不在清理名单里，会一直静默失败。生产日志已实锤。
            # Must copy per subscription: pywebpush writes aud (derived from the
            # first endpoint's push-service origin) into the caller's claims
            # dict in place and never overwrites it. With one dict reused
            # across a loop, whichever push service the first subscription
            # lives on (FCM/Apple/Mozilla) becomes the aud forever — every
            # later subscription on a different service (typical: a user with
            # desktop Chrome + an iPhone) gets rejected 403 BadJwtToken, and
            # 403 isn't in the prune list, so it fails silently indefinitely.
            # Confirmed in production logs.
            vapid_claims=dict(vapid_claims),
            headers=headers,
        )
        return True, False
    except WebPushException as e:
        # 过期或无效订阅，标记清理 / mark stale subscriptions for cleanup
        status = e.response.status_code if e.response is not None else "?"
        logger.warning("[push] webpush failed sub=%s status=%s: %s", sub.id, status, e)
        stale = e.response is not None and e.response.status_code in (410, 404)
        return False, stale


# ---------- FCM HTTP v1 发送（App 端）/ FCM HTTP v1 send (app side) ----------
# 不引入 firebase-admin：这条路径要的只是「用服务账号换一个 OAuth2 令牌」+「一次
# HTTPS POST」，requirements 里已有的 google-auth 与 httpx 就够了，多一个重依赖只
# 会多一份要跟着 Firebase 升级的东西。
# No firebase-admin: this path needs an OAuth2 token from the service account and
# one HTTPS POST, both covered by google-auth and httpx, already in requirements.
FCM_ENDPOINT_TMPL = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"
_FCM_SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"]
# 派发是逐订阅的阻塞 IO（跑在线程池里），单次不能挂太久，否则一个不响应的请求
# 会拖住整批推送。/ Dispatch is blocking per-subscription IO on a thread-pool
# worker; one unresponsive request must not stall the whole batch.
_FCM_TIMEOUT = 10.0

# 凭证与 HTTP 连接都按进程缓存一次：Credentials 对象自己管理令牌过期与刷新，
# httpx.Client 复用连接池。用锁是因为派发跑在线程池里，可能被并发调用。
# Credentials and the HTTP client are built once per process (the credentials
# object refreshes its own token; the client keeps a connection pool). Guarded
# by a lock because dispatch runs on thread-pool workers.
_fcm_lock = threading.Lock()
# None = 本进程还没尝试过；_FCM_UNAVAILABLE = 尝试过、配置不可用（失败也缓存，
# 否则每条 App 订阅都要重读一次服务账号文件）；元组 = 可用。
# None = not attempted yet in this process; _FCM_UNAVAILABLE = attempted and
# unusable (failures are cached too, otherwise every app row re-reads the
# service-account file); a tuple = ready.
_FCM_UNAVAILABLE = object()
_fcm_ctx: object | None = None
# 已经喊过的警告种类。一个全局布尔不行：配置类警告响过一次之后，"取令牌失败"
# （密钥被吊销 → App 推送全停）这种后来才出现的问题会被一并静音，只剩一行旧日志。
# Warning kinds already emitted. A single global flag won't do: once a config
# warning has fired, a later and different problem — "failed to obtain access
# token", i.e. a revoked key silently killing every app push — would be muted
# too, leaving one stale line and no further signal.
_fcm_warned: set[str] = set()


def _warn_fcm_once(key: str, msg: str, *args) -> None:
    """同一类 FCM 问题每个进程只喊一次（按 key 去重）：派发是逐订阅调用的，照实
    打会把日志刷爆，而同一类问题的信息量只有第一条；不同类之间互不影响。
    Warn once per process per kind (deduped by key): dispatch calls this per
    subscription and repeats of one kind carry no information beyond the first,
    but one kind must never silence another."""
    if key in _fcm_warned:
        return
    _fcm_warned.add(key)
    logger.warning(msg, *args)


def _fcm_context() -> tuple | None:
    """返回 (credentials, httpx client, project_id)；未配置或配置有问题返回 None。

    失败同样缓存：配置坏了就是坏了，重试不会变好，而派发是逐订阅调用的——不缓存
    的话一条坏路径会被每条 App 订阅各读一次盘。代价是运维改完配置要重启进程才
    生效，这与本项目其它 .env 配置项的行为一致。

    Returns (credentials, httpx client, project_id), or None when FCM isn't
    configured or the configuration is unusable. Failures are cached as well: a
    broken configuration doesn't heal on retry, and this is called per
    subscription, so without caching one bad path costs a disk read per app row.
    The trade-off — a config fix needs a process restart — matches how every
    other .env setting in this project behaves.
    """
    global _fcm_ctx
    cached = _fcm_ctx
    if cached is not None:
        return None if cached is _FCM_UNAVAILABLE else cached  # type: ignore[return-value]
    with _fcm_lock:
        cached = _fcm_ctx
        if cached is not None:
            return None if cached is _FCM_UNAVAILABLE else cached  # type: ignore[return-value]
        path = (settings.FCM_SERVICE_ACCOUNT_FILE or "").strip()
        if not path:
            # 没配就是没配：网页端一切照旧，App 订阅静默跳过（不清理——用户装着
            # App，只是服务端还没开这条路，把行删了会让他重装才能恢复）。
            # Not configured: the browser path is unaffected and app rows are
            # skipped, never pruned — the device is fine, the server just isn't
            # wired up yet, and deleting the row would require a reinstall.
            _warn_fcm_once(
                "unconfigured",
                "[push] FCM 未配置，App 订阅本次跳过 / FCM not configured, app subscriptions skipped",
            )
            _fcm_ctx = _FCM_UNAVAILABLE
            return None
        # 整段都在 try 里，httpx.Client() 的构造也算——它会读环境里的代理与 CA
        # 设置，畸形的 HTTPS_PROXY / 坏的 SSL_CERT_FILE 会让构造本身抛异常。这个
        # 异常一旦逃出去，只会被派发函数最外层的 except Exception 接住，那一整批
        # 推送（**包括还没轮到的浏览器订阅**）当场中断、清理记账全部作废。
        # Everything is inside the try, httpx.Client() construction included: it
        # reads proxy and CA settings from the environment, and a malformed
        # HTTPS_PROXY or a bad SSL_CERT_FILE makes the constructor itself raise.
        # Escaping here would be caught only by the dispatcher's outermost
        # except Exception, aborting the whole batch — browser subscriptions
        # that hadn't been reached yet included — and discarding its pruning.
        try:
            from google.oauth2 import service_account
            import httpx

            creds = service_account.Credentials.from_service_account_file(path, scopes=_FCM_SCOPES)
            project_id = (settings.FCM_PROJECT_ID or "").strip() or (getattr(creds, "project_id", "") or "")
            if not project_id:
                _warn_fcm_once(
                    "no-project",
                    "[push] FCM project_id 缺失（配置与服务账号 JSON 里都没有）"
                    " / FCM project_id missing from both config and the service-account JSON",
                )
                _fcm_ctx = _FCM_UNAVAILABLE
                return None
            client = httpx.Client(timeout=_FCM_TIMEOUT)
        except Exception as e:
            _warn_fcm_once(
                "load-failed",
                "[push] FCM 初始化失败，App 订阅跳过 / FCM init failed, app subscriptions skipped: %s",
                e,
            )
            _fcm_ctx = _FCM_UNAVAILABLE
            return None
        _fcm_ctx = (creds, client, project_id)
        return _fcm_ctx  # type: ignore[return-value]


def _fcm_access_token(creds) -> str:
    """取当前访问令牌，过期时就地刷新（google-auth 自己管有效期）。
    The current access token, refreshed in place when stale (google-auth owns
    the expiry bookkeeping)."""
    if not creds.valid:
        from google.auth.transport.requests import Request

        creds.refresh(Request())
    return creds.token


def _fcm_should_prune(status: int, err: dict) -> bool:
    """FCM 的这次失败是否说明「这个令牌已经死了」，对应 webpush 的 410/404。

    判据只有一个：错误体明确把**令牌**指认为原因——details 里的 UNREGISTERED
    （App 被卸载、令牌被轮换），或 400 INVALID_ARGUMENT 且错误信息确实提到令牌。

    光凭 HTTP 404 清理是错的，这与 Web Push 不同：webpush 的 404 来自那台设备
    专属的 endpoint，而这里的 URL 里带的是**项目**路径——FCM_PROJECT_ID 写错一个
    字符、或服务账号没有该项目的权限，`projects/<id>/messages:send` 会对**每一条**
    订阅都回 404/NOT_FOUND。按 404 就删的话，配错之后的第一次派发会把全部 App
    订阅清空，而这些设备其实完全正常。同理，我们自己把消息体发错也会 400
    INVALID_ARGUMENT，那是服务端 bug，不能让用户的设备陪葬。

    Whether this failure means the token is dead — the FCM counterpart of
    410/404. One criterion only: the error body names the *token* as the cause
    (UNREGISTERED in details, or a 400 INVALID_ARGUMENT whose message mentions
    the token). A bare 404 must not prune, unlike Web Push: there the 404 comes
    from that device's own endpoint, while this URL carries the *project* path —
    a one-character typo in FCM_PROJECT_ID, or a service account without access,
    returns 404/NOT_FOUND for every row, and pruning on it would wipe every app
    subscription on the first dispatch after the typo, all of them healthy.
    """
    error = err.get("error") if isinstance(err.get("error"), dict) else {}
    # details 来自外部服务的 JSON，形状不保证是列表；这个函数被放在返回值路径上，
    # 不能自己抛。/ details comes from an external service's JSON and isn't
    # guaranteed to be a list; this sits on the return path and must not throw.
    details = error.get("details")
    codes = {
        d.get("errorCode")
        for d in (details if isinstance(details, list) else [])
        if isinstance(d, dict)
    }
    if "UNREGISTERED" in codes:
        return True
    if status == 400 and error.get("status") == "INVALID_ARGUMENT":
        msg = str(error.get("message") or "").lower()
        return "token" in msg or "registration" in msg
    return False


def _fcm_one(sub: PushSubscription, payload: str) -> tuple[bool, bool]:
    """向单个 App 订阅推送一条消息，**保证不抛异常**——这是本函数的硬契约。

    派发循环外面只有一层 `except Exception`，异常从这里逃出去的后果不是"这条推送
    失败"，而是"整批中断"：同一批里还没轮到的**浏览器订阅**一条都不发，已经攒下
    的清理记账（failed_ids）连同事务一起作废，而且每次派发都会重演。App 通道的任
    何问题都不该有这么大的爆炸半径，所以整个函数体包在兜底里，未预期的异常一律
    降级成 (False, False) 加一行警告。

    Push one message to a single app subscription, and **never raise** — that is
    this function's hard contract. The dispatch loops have only one outer
    `except Exception`, so an exception escaping here doesn't mean "this push
    failed" but "the batch aborted": every browser subscription not yet reached
    in the same batch goes unsent, the pruning bookkeeping collected so far is
    discarded with the transaction, and it repeats on every dispatch. No problem
    on the app channel may have that blast radius, hence the blanket guard:
    anything unexpected degrades to (False, False) plus one warning.
    """
    try:
        return _fcm_send(sub, payload)
    except Exception as e:
        logger.warning("[push] fcm unexpected error sub=%s: %s", sub.id, e)
        return False, False


def _fcm_send(sub: PushSubscription, payload: str) -> tuple[bool, bool]:
    """实际发送。返回 (是否发送成功, 是否应清理)，与 _webpush_one 同一份契约，
    好让派发循环两边一视同仁。只经由 _fcm_one 调用（它负责兜底）。
    The actual send, under the same (sent, should prune) contract as
    _webpush_one. Only ever called through _fcm_one, which guards it.

    消息体的取舍：notification 只给 title/body（系统托盘要显示的两行），完整的原始
    payload 原样塞进 data.payload——App 里的处理逻辑与网页 Service Worker 共用同一份
    JSON（icon/tag/url/data 都在里面），这里不做裁剪也不做翻译。FCM 的 data 值必须
    是字符串，所以放的是整串 JSON 文本而不是对象。

    Push one message to a single app subscription, under the same (sent, should
    prune) contract as _webpush_one so the dispatch loops can treat both alike.
    notification carries only title/body (what the tray shows); the full original
    payload rides along verbatim in data.payload, because the app reuses the same
    JSON the web service worker consumes (icon/tag/url/data all live in it). FCM
    data values must be strings, hence the raw JSON text rather than an object.
    """
    ctx = _fcm_context()
    if ctx is None:
        return False, False
    creds, client, project_id = ctx
    token = fcm_token(sub.endpoint)
    try:
        access_token = _fcm_access_token(creds)
    except Exception as e:
        _warn_fcm_once(
            "access-token",
            "[push] FCM 取令牌失败（密钥被吊销 / 系统时钟偏移？）"
            " / failed to obtain FCM access token (revoked key, clock skew?): %s",
            e,
        )
        return False, False

    try:
        parsed = json.loads(payload)
        if not isinstance(parsed, dict):
            parsed = {}
    except (ValueError, TypeError):
        parsed = {}
    notification = {
        "title": str(parsed.get("title") or ""),
        "body": str(parsed.get("body") or ""),
    }
    message = {
        "message": {
            "token": token,
            "notification": notification,
            "data": {"payload": payload},
            # 与 Web Push 的 Urgency: high 对齐：信号与账户事件都有时效，要求系统
            # 尽快下发（含 Doze 休眠期间尝试唤醒）。
            # Mirrors Web Push's Urgency: high — signals and account events are
            # time-sensitive, so ask the system to deliver ASAP (Doze included).
            "android": {"priority": "high"},
        }
    }
    url = FCM_ENDPOINT_TMPL.format(project_id=project_id)
    try:
        resp = client.post(
            url,
            json=message,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json; charset=UTF-8",
            },
        )
    except Exception as e:
        # 网络层异常（超时、DNS）与推送服务无关，绝不能据此清理订阅。
        # A transport-level failure says nothing about the token — never prune.
        logger.warning("[push] fcm request failed sub=%s token=%s: %s", sub.id, _token_hint(token), e)
        return False, False

    if 200 <= resp.status_code < 300:
        return True, False
    try:
        err = resp.json()
    except Exception:
        err = {}
    stale = _fcm_should_prune(resp.status_code, err if isinstance(err, dict) else {})
    logger.warning(
        "[push] fcm failed sub=%s token=%s status=%s stale=%s",
        sub.id, _token_hint(token), resp.status_code, stale,
    )
    if resp.status_code == 404 and not stale:
        # 404 但错误体没有指认令牌：URL 里除了令牌就只有项目路径，所以这几乎一定
        # 是 FCM_PROJECT_ID 写错或服务账号没有该项目的权限——一条订阅都发不出去，
        # 但一条也不该删。按类去重，免得整批刷屏。
        # A 404 that doesn't name the token: the URL contains only the token and
        # the project path, so this is almost certainly a wrong FCM_PROJECT_ID or
        # a service account without access — nothing will deliver, and nothing
        # should be deleted. Deduped by kind so a whole batch doesn't spam.
        _warn_fcm_once(
            "project-404",
            "[push] FCM 404 未指明令牌失效，多半是 FCM_PROJECT_ID 配错或服务账号无权访问该项目"
            "（project_id=%s）；不清理订阅 / FCM 404 without a token error — likely a wrong"
            " FCM_PROJECT_ID or a service account lacking access (project_id=%s); not pruning",
            project_id, project_id,
        )
    return False, stale


def _send_one(
    sub: PushSubscription, payload: str, pem: str, vapid_claims: dict, headers: dict
) -> tuple[bool, bool]:
    """按订阅的 endpoint 形态选择通道：App 的 fcm:// 行走 FCM，其余一律原样走
    Web Push。契约（是否发送成功, 是否应清理）两边相同，调用方的清理记账不变。
    Pick the channel by endpoint shape: app fcm:// rows go to FCM, everything
    else takes the unchanged Web Push path. Same (sent, should prune) contract
    on both sides, so callers' pruning bookkeeping is untouched."""
    if is_fcm_endpoint(sub.endpoint):
        return _fcm_one(sub, payload)
    return _webpush_one(sub, payload, pem, vapid_claims, headers)


def dispatch_push(signal: Signal) -> None:
    """对一条新生成的信号，找出匹配的通知偏好用户并推送到其所有设备。
    Match a newly generated signal against users' notification prefs, then
    push to every subscribed device."""
    cat = indicator_category(signal.indicator)
    if not cat:
        logger.debug("[push] empty category, skip (indicator=%r)", signal.indicator)
        return
    vapid_claims = {"sub": settings.VAPID_SUBJECT}
    pem = settings.vapid_private_key
    if not pem or not settings.VAPID_PUBLIC_KEY:
        logger.debug("[push] VAPID keys not configured, skipping push dispatch")
        return

    db = SessionLocal()
    try:
        user_ids = _matched_user_ids(db, cat, signal.symbol)
        logger.debug("[push] category %r symbol %r matched %d user(s)", cat, signal.symbol, len(user_ids))
        if not user_ids:
            return

        subs = (
            db.query(PushSubscription)
            .filter(PushSubscription.user_id.in_(user_ids))
            .all()
        )

        payload = json.dumps({
            "title": f"新信号 {signal.symbol}",
            "body": f"{signal.side} · {cat}",
            "icon": "/icons/icon-192.png",
        })

        failed_ids: list[str] = []
        sent = 0
        # 推送头：高紧急度要求系统尽快下发（即使手机处于 Doze 省电休眠也尝试唤醒），
        # TTL 设为信号存活时长，使离线/休眠设备在该窗口内仍能收到，过期后推送服务自动丢弃。
        # Push headers: high urgency asks the system to deliver ASAP (even under Doze),
        # TTL = signal lifespan so offline/sleeping devices still get it within the window.
        push_headers = {
            "Urgency": "high",
            "TTL": str(settings.SIGNAL_EXPIRE_MINUTES * 60),
        }
        for sub in subs:
            ok, stale = _send_one(sub, payload, pem, vapid_claims, push_headers)
            if ok:
                sent += 1
            if stale:
                failed_ids.append(sub.id)
        logger.info("[push] signal %s (%s): sent=%d failed=%d", signal.symbol, cat, sent, len(failed_ids))

        # 清理失败/过期的订阅 / remove stale subscriptions
        if failed_ids:
            db.query(PushSubscription).filter(
                PushSubscription.id.in_(failed_ids)
            ).delete(synchronize_session=False)
            db.commit()
    except Exception:
        logger.exception("[push] Error dispatching push notifications")
    finally:
        db.close()


# ---------- 事件类通知（单用户）/ event notifications (single user) ----------
# 与上面按指标类别向多个用户扇出的信号推送不同：这类通知只针对触发事件的
# 那一个用户，按他自己的事件类型偏好过滤。此前推送只覆盖"新信号"，订单
# 成交/拒绝、自动仓管的后台动作、Bridge 掉线全都是静默的。
# Unlike the signal push above (fanned out to many users by indicator
# category), these fire for exactly the one user who triggered the event,
# gated by that user's own event-type prefs. Push used to only ever cover
# "new signal" — order fills/rejections, auto-management acting on a
# position in the background, and the bridge going offline were all silent.


def _event_prefs_allow(db, user_id: str, event_type: str) -> bool:
    """该用户是否开启了通知总开关、这个事件类型在其白名单里、当前时刻落在其
    推送时段内、且订阅等级允许推送。事件白名单为 NULL 表示从未配置，按全部
    事件默认开启处理（见 _parse_event_types）。
    Whether the user has notifications on, this event type whitelisted, "now"
    inside their push window, and their plan allows push at all. A NULL event
    whitelist means never-configured and counts as all events on by default
    (see _parse_event_types)."""
    pref = db.query(NotificationPref).filter(NotificationPref.user_id == user_id).first()
    if not pref or not pref.enabled:
        return False
    # 账户 / 交易 / 成就事件不看白名单：总开关开了就推（见 ALWAYS_ON_EVENTS）。
    # 老用户以前在设置页勾掉过的项也一并恢复——那些开关已经撤了。
    # Account/trading/badge events skip the whitelist: on means on (see
    # ALWAYS_ON_EVENTS); toggles users unticked before are gone with the UI.
    if event_type not in ALWAYS_ON_EVENTS and event_type not in _parse_event_types(pref.event_types):
        return False
    if not _within_push_window(pref):
        return False
    plan = db.query(User.plan).filter(User.id == user_id).scalar()
    return can_use_push(plan)


def dispatch_event_push(user_id: str, event_type: str, title: str, body: str) -> None:
    """给触发了某个事件的用户推送一条通知（若其偏好允许）。同步、阻塞网络 IO，
    调用方须放线程池（见 dispatch_event_push_async）。
    Push one notification to the user who triggered an event (if their prefs
    allow it). Synchronous, blocking network IO — callers must use a thread
    pool (see dispatch_event_push_async)."""
    if event_type not in EVENT_TYPES:
        logger.warning("[push] unknown event_type %r, skipping", event_type)
        return
    pem = settings.vapid_private_key
    if not pem or not settings.VAPID_PUBLIC_KEY:
        return
    db = SessionLocal()
    try:
        if not _event_prefs_allow(db, user_id, event_type):
            return
        subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
        if not subs:
            return
        vapid_claims = {"sub": settings.VAPID_SUBJECT}
        payload = json.dumps({"title": title, "body": body, "icon": "/icons/icon-192.png"})
        # 账户/交易事件时效性不如新信号那么强，TTL 给固定 1 小时即可。
        # Account/trading events aren't as time-critical as a fresh signal; a flat 1h TTL is enough.
        push_headers = {"Urgency": "high", "TTL": str(3600)}
        failed_ids: list[str] = []
        for sub in subs:
            _ok, stale = _send_one(sub, payload, pem, vapid_claims, push_headers)
            if stale:
                failed_ids.append(sub.id)
        if failed_ids:
            db.query(PushSubscription).filter(
                PushSubscription.id.in_(failed_ids)
            ).delete(synchronize_session=False)
            db.commit()
    except Exception:
        logger.exception("[push] dispatch_event_push error (user=%s, event=%s)", user_id, event_type)
    finally:
        db.close()


async def dispatch_event_push_async(user_id: str, event_type: str, title: str, body: str) -> None:
    """在线程池中执行事件推送，避免阻塞事件循环。
    Run event push dispatching in a thread pool to keep the event loop responsive."""
    try:
        await run_in_threadpool(dispatch_event_push, user_id, event_type, title, body)
    except Exception:
        logger.exception("dispatch_event_push_async error")


# ---------- 工单回复通知（单用户）/ ticket reply notification (single user) ----------
# 管理员回复工单时，向工单提交者推送一条 Web Push 通知，让他们知道
# 工单有了新回复。与上面的事件推送使用相同的 VAPID / WebPush 通道。
# When an admin replies to a ticket, push a web-push notification to the
# ticket submitter so they know their ticket has a new reply. Uses the
# same VAPID / WebPush channel as the event-push functions above.


def dispatch_ticket_reply(ticket_id: str, recipient_id: str, replier_email: str) -> None:
    """工单有新回复时推送通知给接收方。同步、阻塞网络 IO，
    调用方须确保不在事件循环中直接调用。
    Push a notification when a ticket gets a new reply. Synchronous,
    blocking network IO — caller must not invoke directly on the event loop."""
    pem = settings.vapid_private_key
    if not pem or not settings.VAPID_PUBLIC_KEY:
        return
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == recipient_id).first()
        if not user:
            return
        # 工单回复不看通知开关/白名单（历史行为），但推送时段照样遵守——时段
        # 的意义就是"这段时间外别吵我"，工单回复也不例外。没有偏好行 = 没设过
        # 时段，照常推。
        # Ticket replies ignore the master switch/whitelists (historical
        # behavior) but do honor the push window — its whole point is "don't
        # buzz me outside these hours", tickets included. No pref row = no
        # window configured, push as before.
        pref = db.query(NotificationPref).filter(NotificationPref.user_id == recipient_id).first()
        if pref is not None and not _within_push_window(pref):
            return
        subs = db.query(PushSubscription).filter(PushSubscription.user_id == recipient_id).all()
        if not subs:
            return
        vapid_claims = {"sub": settings.VAPID_SUBJECT}
        # 双语标题与正文 / bilingual title and body
        title = "New ticket reply / 工单有新回复"
        body = f"{replier_email} replied to your ticket / {replier_email} 回复了你的工单"
        payload = json.dumps({
            "title": title,
            "body": body,
            "icon": "/icons/icon-192.png",
            "data": {"ticketId": ticket_id},
        })
        push_headers = {"Urgency": "high", "TTL": str(3600)}
        failed_ids: list[str] = []
        for sub in subs:
            _ok, stale = _send_one(sub, payload, pem, vapid_claims, push_headers)
            if stale:
                failed_ids.append(sub.id)
        if failed_ids:
            db.query(PushSubscription).filter(
                PushSubscription.id.in_(failed_ids)
            ).delete(synchronize_session=False)
            db.commit()
    except Exception:
        logger.exception("[push] dispatch_ticket_reply error (ticket=%s, user=%s)", ticket_id, recipient_id)
    finally:
        db.close()


# ---------- 公告推送（全体订阅用户）/ announcement push (every subscribed user) ----------


def dispatch_announcement_push(announcement_id: str, title: str, body: str) -> None:
    """管理员发布公告并勾选了推送：给每个「开了通知总开关、有订阅、当前在推送时段内、
    等级允许推送」的用户推一条。逐用户复用 _event_prefs_allow，与账户事件同一套判定。
    同步、阻塞网络 IO，调用方须放线程池（见 dispatch_announcement_push_async）。
    An admin published an announcement with push ticked: notify every user whose
    master switch is on, who has subscriptions, is inside their push window and
    whose plan allows push, reusing _event_prefs_allow per user. Synchronous,
    blocking IO; callers use the thread pool (dispatch_announcement_push_async)."""
    pem = settings.vapid_private_key
    if not pem or not settings.VAPID_PUBLIC_KEY:
        return
    db = SessionLocal()
    try:
        user_ids = [row[0] for row in db.query(PushSubscription.user_id).distinct().all()]
        if not user_ids:
            return
        vapid_claims = {"sub": settings.VAPID_SUBJECT}
        payload = json.dumps({
            "title": title,
            "body": body,
            "icon": "/icons/icon-192.png",
            "tag": f"prismx-announcement-{announcement_id}",
            "url": f"/announcements/{announcement_id}",
        }, ensure_ascii=False)
        # 公告不紧急：正常优先级，一天内送达即可。/ Not urgent: normal priority, a day's TTL.
        push_headers = {"Urgency": "normal", "TTL": str(86400)}
        failed_ids: list[str] = []
        sent = 0
        for uid in user_ids:
            if not _event_prefs_allow(db, uid, EVENT_ANNOUNCEMENT):
                continue
            subs = db.query(PushSubscription).filter(PushSubscription.user_id == uid).all()
            for sub in subs:
                ok, stale = _send_one(sub, payload, pem, vapid_claims, push_headers)
                sent += int(ok)
                if stale:
                    failed_ids.append(sub.id)
        if failed_ids:
            db.query(PushSubscription).filter(
                PushSubscription.id.in_(failed_ids)
            ).delete(synchronize_session=False)
            db.commit()
        logger.info("[push] announcement %s pushed to %d subscriptions", announcement_id, sent)
    except Exception:
        logger.exception("[push] dispatch_announcement_push error (announcement=%s)", announcement_id)
    finally:
        db.close()


async def dispatch_announcement_push_async(announcement_id: str, title: str, body: str) -> None:
    """线程池里跑公告推送 / run the announcement push in a thread pool."""
    try:
        await run_in_threadpool(dispatch_announcement_push, announcement_id, title, body)
    except Exception:
        logger.exception("dispatch_announcement_push_async error")


# ---------- 诊断用测试推送 / diagnostic test push ----------


def dispatch_test_push(user_id: str) -> dict:
    """给指定用户的所有订阅各发一条固定内容的测试通知，返回计数。

    与业务推送的区别：完全绕过通知偏好与白名单（enabled、类别、品种一概不看）。
    这是链路探针——用户点"发送测试通知"就是要验证推送能不能到，不该被他自己的
    筛选条件挡住。订阅等级检查由路由层负责，不在这里重复。

    同步阻塞网络 IO，调用方必须放在线程池中执行。

    Send one fixed test notification to each of the user's subscriptions and
    return the counts. Unlike business pushes this bypasses prefs and
    whitelists entirely (enabled, category, symbol are all ignored): it's a
    pipeline probe — someone tapping "send test notification" wants to know
    whether push works at all, not to be filtered out by their own settings.
    The plan check lives in the route layer, not duplicated here.

    Synchronous blocking network IO — the caller must run it in a thread pool.
    """
    pem = settings.vapid_private_key
    if not pem or not settings.VAPID_PUBLIC_KEY:
        # 与业务推送的静默 return 不同：这里必须让调用方能区分"服务端没配密钥"
        # 与"本设备有问题"，两者的用户侧行动完全不同。
        # Unlike the silent return in business dispatch, the caller must be able
        # to tell "server has no keys" from "this device is broken" — the user
        # action differs completely.
        raise RuntimeError("vapid-not-configured")

    db = SessionLocal()
    try:
        subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
        if not subs:
            return {"sent": 0, "failed": 0, "pruned": 0}

        vapid_claims = {"sub": settings.VAPID_SUBJECT}
        payload = json.dumps({
            "title": "测试通知 / Test notification",
            "body": "推送链路正常。/ Push delivery is working.",
            "icon": "/icons/icon-192.png",
            "data": {"url": "/account#notifications"},
        })
        push_headers = {"Urgency": "high", "TTL": "60"}

        sent = 0
        failed = 0
        stale_ids: list[str] = []
        for sub in subs:
            # _webpush_one 内部对 vapid_claims 做 per-subscription 复制，
            # 继承 aud 复用修复 / _webpush_one copies vapid_claims per
            # subscription, inheriting the aud-reuse fix.
            ok, stale = _send_one(sub, payload, pem, vapid_claims, push_headers)
            if ok:
                sent += 1
            else:
                failed += 1
            if stale:
                stale_ids.append(sub.id)

        if stale_ids:
            db.query(PushSubscription).filter(
                PushSubscription.id.in_(stale_ids)
            ).delete(synchronize_session=False)
            db.commit()

        logger.info("[push] test push user=%s sent=%d failed=%d pruned=%d", user_id, sent, failed, len(stale_ids))
        return {"sent": sent, "failed": failed, "pruned": len(stale_ids)}
    finally:
        db.close()
