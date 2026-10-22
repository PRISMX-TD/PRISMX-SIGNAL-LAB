"""每分钟一轮：① 到点的期结束并作废未用券；② 距结束 ≤ 24 小时、开关开着，给本期还有未用券的人
提醒一次（每期一次，reminder_sent_at 去重）。抽奖接口自己也校验期在进行中，这里晚几十秒没关系。

Every minute: end due rounds (voiding unused tickets); within 24h of the end and while visible,
remind holders of unused tickets once per round. The spin endpoint checks the window itself.
"""
import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import func
from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import LuckyRound, LuckyTicket
from app.services.lucky import rounds
from app.services.lucky.common import T_UNUSED, is_visible, utcnow
from app.services.notification_feed import KIND_LUCKY_EXPIRING, create_notification, notify_ws

logger = logging.getLogger("prismx.lucky")

SWEEP_INTERVAL_SECONDS = 60
REMIND_BEFORE = timedelta(hours=24)


def sweep_once(db, now: datetime) -> dict:
    out = {"ended": 0, "voided": 0, "reminded": 0}
    for r in db.query(LuckyRound).filter(LuckyRound.ended_at.is_(None), LuckyRound.ends_at <= now).all():
        out["voided"] += rounds.end_round(db, r, now, None)
        out["ended"] += 1
    db.commit()
    r = rounds.current_round(db)
    if (r is None or r.reminder_sent_at is not None or not is_visible(db)
            or rounds.phase(r, now) != "active" or r.ends_at - now > REMIND_BEFORE):
        return out
    rows = (db.query(LuckyTicket.user_id, func.count(LuckyTicket.id))
            .filter(LuckyTicket.round_id == r.id, LuckyTicket.status == T_UNUSED)
            .group_by(LuckyTicket.user_id).all())
    for uid, n in rows:
        create_notification(db, uid, KIND_LUCKY_EXPIRING, text=f"×{n} · {r.ends_at:%Y-%m-%d %H:%M} UTC",
                            link="/lucky", ref_id=r.id)
    r.reminder_sent_at = now
    db.commit()
    uids = [uid for uid, _ in rows]
    for uid in uids:
        notify_ws(uid)
    if uids:
        from app.services.push_dispatch import EVENT_LUCKY_WHEEL, dispatch_users_push
        dispatch_users_push(uids, EVENT_LUCKY_WHEEL, "抽奖券即将作废",
                            "你还有未使用的抽奖券，本期结束后自动作废", url="/lucky", tag="prismx-lucky")
    out["reminded"] = len(uids)
    return out


def _run() -> dict:
    db = SessionLocal()
    try:
        return sweep_once(db, utcnow())
    finally:
        db.close()


async def lucky_wheel_loop() -> None:
    from app.services import loop_health

    while True:
        loop_health.beat("lucky_wheel")
        try:
            await run_in_threadpool(_run)
        except Exception:
            logger.exception("lucky_wheel_loop error")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
