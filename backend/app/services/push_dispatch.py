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
EVENT_TYPES = {
    EVENT_ORDER_FILLED, EVENT_ORDER_REJECTED, EVENT_AUTO_MANAGE,
    EVENT_BRIDGE_OFFLINE, EVENT_ACCOUNT_REVOKED, EVENT_STRATEGY_SIGNAL,
}

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
    """解析偏好行的事件白名单。NULL = 用户从未配置过 → 默认全部事件开启
    （产品语义，见 models.NotificationPref）；"[]" = 明确全关；解析失败按
    全关处理（脏数据不该反而放大推送面）。
    Parse a pref row's event whitelist. NULL = never configured → all events
    on by default (product semantics, see models.NotificationPref); "[]" =
    explicitly all off; unparseable data counts as all off (bad data must not
    widen the push surface)."""
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
            ok, stale = _webpush_one(sub, payload, pem, vapid_claims, push_headers)
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
    if event_type not in _parse_event_types(pref.event_types):
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
            _ok, stale = _webpush_one(sub, payload, pem, vapid_claims, push_headers)
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
            _ok, stale = _webpush_one(sub, payload, pem, vapid_claims, push_headers)
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
            ok, stale = _webpush_one(sub, payload, pem, vapid_claims, push_headers)
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
