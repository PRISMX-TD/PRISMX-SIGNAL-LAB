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

from starlette.concurrency import run_in_threadpool
from pywebpush import WebPushException, webpush

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import NotificationPref, PushSubscription, Signal, User
from app.services.plans import can_use_push
from app.utils.indicator import indicator_category

logger = logging.getLogger("push")

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
EVENT_TYPES = {EVENT_ORDER_FILLED, EVENT_ORDER_REJECTED, EVENT_AUTO_MANAGE, EVENT_BRIDGE_OFFLINE}

# 白名单哨兵值："不限"，命中任意取值（含此刻还不存在、以后才出现的品种/类别）。
# Whitelist sentinel meaning "unrestricted" — matches any value, including
# ones (like a symbol) that don't exist yet and only show up later.
ALL_SENTINEL = "__ALL__"


def _list_matches(selected: list, value: str) -> bool:
    """selected 是否放行 value：命中哨兵值即不限，否则要求精确匹配。
    Whether the whitelist `selected` allows `value`: the sentinel means
    unrestricted, otherwise an exact match is required."""
    return ALL_SENTINEL in selected or value in selected


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
            "icon": "/favicon.svg",
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
    """该用户是否开启了通知总开关、这个事件类型在其白名单里、且订阅等级允许推送。
    Whether the user has notifications on, this event type whitelisted, and
    their plan allows push at all."""
    pref = db.query(NotificationPref).filter(NotificationPref.user_id == user_id).first()
    if not pref or not pref.enabled:
        return False
    try:
        event_types = json.loads(pref.event_types or "[]")
    except (json.JSONDecodeError, TypeError):
        return False
    if not isinstance(event_types, list) or event_type not in event_types:
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
        payload = json.dumps({"title": title, "body": body, "icon": "/favicon.svg"})
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
