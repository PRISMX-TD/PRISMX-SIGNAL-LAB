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


async def dispatch_push_async(signal: Signal) -> None:
    """在线程池中执行推送派发，避免阻塞事件循环。
    Run push dispatching in a thread pool to keep the event loop responsive."""
    try:
        await run_in_threadpool(dispatch_push, signal)
    except Exception:
        logger.exception("dispatch_push_async error")


def _matched_user_ids(db, cat: str) -> set[str]:
    """解析每个用户的白名单 JSON 并做精确匹配（不用 SQL LIKE，避免类别名互为
    子串时误匹配），再按当前订阅等级过滤掉 FREE。

    这条新信号此刻仍是 ACTIVE（尚未过期），FREE 等级要等它过期后才能在
    REST/WS 里看到——这里必须同步过滤，否则一个此前是付费用户、开过推送、
    后来被降级为 FREE 的账号，会绕过延迟机制提前用推送收到通知（偏好行的
    enabled=True 不会因降级自动清空）。

    Parse each user's whitelist JSON and match exactly (SQL LIKE would
    false-match categories that are substrings of one another), then filter
    out FREE-plan users.

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
        except (ValueError, TypeError):
            continue
        if isinstance(cats, list) and cat in cats:
            user_ids.add(p.user_id)
    if not user_ids:
        return user_ids
    realtime_ids = {
        uid
        for uid, plan in db.query(User.id, User.plan).filter(User.id.in_(user_ids)).all()
        if can_use_push(plan)
    }
    return realtime_ids


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
        user_ids = _matched_user_ids(db, cat)
        logger.debug("[push] category %r matched %d user(s)", cat, len(user_ids))
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
            try:
                webpush(
                    subscription_info={
                        "endpoint": sub.endpoint,
                        "keys": {"p256dh": sub.keys_p256dh, "auth": sub.keys_auth},
                    },
                    data=payload,
                    vapid_private_key=pem,
                    vapid_claims=vapid_claims,
                    headers=push_headers,
                )
                sent += 1
            except WebPushException as e:
                # 过期或无效订阅，标记清理 / mark stale subscriptions for cleanup
                status = e.response.status_code if e.response is not None else "?"
                logger.warning("[push] webpush failed sub=%s status=%s: %s", sub.id, status, e)
                if e.response is not None and e.response.status_code in (410, 404):
                    failed_ids.append(sub.id)
                continue
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
