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
    if not cat:
        return
    vapid_claims = {"sub": settings.VAPID_SUBJECT}
    pem = settings.vapid_private_key_pem
    if not pem or not settings.VAPID_PUBLIC_KEY:
        logger.warning("VAPID keys not configured, skipping push dispatch")
        return

    db = SessionLocal()
    try:
        # 取所有启用通知且此指标类别在白名单中的用户 / all users with matching prefs
        prefs = db.query(NotificationPref).filter(
            NotificationPref.enabled == True,
            NotificationPref.selected_categories.like(f"%{cat}%"),
        ).all()
        if not prefs:
            return

        user_ids = set(p.user_id for p in prefs)
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
                )
            except WebPushException as e:
                # 过期或无效订阅，标记清理 / mark stale subscriptions for cleanup
                logger.info(f"Push failed for sub {sub.id}: {e}")
                if e.response is not None and e.response.status_code in (410, 404):
                    failed_ids.append(sub.id)
                continue

        # 清理失败/过期的订阅 / remove stale subscriptions
        if failed_ids:
            db.query(PushSubscription).filter(
                PushSubscription.id.in_(failed_ids)
            ).delete(synchronize_session=False)
            db.commit()
    except Exception:
        logger.exception("Error dispatching push notifications")
    finally:
        db.close()
