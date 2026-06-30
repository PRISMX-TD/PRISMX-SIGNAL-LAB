"""Web Push 推送派发 / Web Push dispatching.
当信号引擎或 webhook 产生新信号时调用 dispatch_push 遍历匹配用户并推送。"""
import json
import logging

from pywebpush import WebPushException, webpush

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import NotificationPref, PushSubscription, Signal
from app.utils.indicator import indicator_category

logger = logging.getLogger("push")


def dispatch_push(signal: Signal) -> None:
    """对一条新生成的信号，找出匹配的通知偏好用户并推送到其所有设备。
    Match a newly generated signal against users' notification prefs, then
    push to every subscribed device."""
    cat = indicator_category(signal.indicator)
    logger.warning(f"[push] dispatch start: indicator={signal.indicator!r} -> cat={cat!r}")
    if not cat:
        logger.warning("[push] empty category, skip")
        return
    vapid_claims = {"sub": settings.VAPID_SUBJECT}
    pem = settings.vapid_private_key
    if not pem or not settings.VAPID_PUBLIC_KEY:
        logger.warning("[push] VAPID keys not configured, skipping push dispatch")
        return

    db = SessionLocal()
    try:
        # 取所有启用通知且此指标类别在白名单中的用户 / all users with matching prefs
        prefs = db.query(NotificationPref).filter(
            NotificationPref.enabled == True,
            NotificationPref.selected_categories.like(f"%{cat}%"),
        ).all()
        logger.warning(f"[push] matched prefs: {len(prefs)} (enabled & whitelist contains {cat!r})")
        if not prefs:
            # 额外打印当前所有启用的偏好，便于排查白名单不匹配 / dump enabled prefs for debugging
            enabled = db.query(NotificationPref).filter(NotificationPref.enabled == True).all()
            logger.warning(
                "[push] no match; enabled prefs whitelists: "
                + "; ".join(p.selected_categories or "[]" for p in enabled)
            )
            return

        user_ids = set(p.user_id for p in prefs)
        subs = (
            db.query(PushSubscription)
            .filter(PushSubscription.user_id.in_(user_ids))
            .all()
        )
        logger.warning(f"[push] subscriptions for matched users: {len(subs)}")

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
                logger.warning(f"[push] webpush failed sub={sub.id} status={status}: {e}")
                if e.response is not None and e.response.status_code in (410, 404):
                    failed_ids.append(sub.id)
                continue
        logger.warning(f"[push] sent ok: {sent}, failed: {len(failed_ids)}")

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
