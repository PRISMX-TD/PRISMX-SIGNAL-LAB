"""交易报告月底存档循环（只在领导 worker 上跑）。每 10 分钟看一眼：上个月还没存完就接着存。

- 每月 1 号 00:05（UTC）之后开始存上个月；一轮最多处理 MAX_USERS_PER_PASS 个人，存完记一个水位
  （platform_settings 里的 persona_archive），之后整月不再扫。
- 存档时还没平的浮亏单按亏损算（方案第 4 节），用的是此刻的持仓快照；所以只在月底后 6 小时内带上它们，
  更晚才补存（比如服务停过）就不带，免得拿几天后的浮亏冒充月底的。
- 总开关 persona_visible 关着也照常存：打开时用户能直接看到过去几个月。AI 点评另看 persona_ai_comment。

Month-end archive loop (leader worker only). Every 10 minutes: if last month isn't fully archived,
continue. Starts 00:05 UTC on the 1st, at most MAX_USERS_PER_PASS users per pass, then records a
watermark. Floating losers come from the live positions snapshot, so they're only included within
6 hours of month end. Archives run even with the user switch off, so history is there when it opens.
"""
import asyncio
import logging
from datetime import timedelta

from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import PersonaReport, PlatformSetting
from app.services.persona import service
from app.services.persona.positions import utcnow

logger = logging.getLogger("prismx.persona")

LOOP_INTERVAL_SECONDS = 600
START_DELAY = timedelta(minutes=5)
OPEN_ROWS_GRACE = timedelta(hours=6)
MAX_USERS_PER_PASS = 200
WATERMARK_KEY = "persona_archive"


def _watermark(db) -> str | None:
    import json
    row = db.query(PlatformSetting).filter(PlatformSetting.key == WATERMARK_KEY).first()
    if row is None:
        return None
    try:
        return (json.loads(row.value) or {}).get("period")
    except (ValueError, AttributeError):
        return None


def run_archive_pass(now=None) -> dict:
    """存一轮。返回 {period, archived, skipped, done}。/ One archive pass."""
    from app.services.settings_store import get_gamification_settings, set_setting
    now = now or utcnow()
    period = service.previous_period(service.period_of(now))
    start_of_month, _ = service.month_bounds(service.period_of(now))
    if now < start_of_month + START_DELAY:
        return {"period": period, "waiting": True}
    db = SessionLocal()
    try:
        if _watermark(db) == period:
            return {"period": period, "done": True, "archived": 0}
        ai_enabled = bool(get_gamification_settings(db).get("persona_ai_comment"))
        with_open = now - start_of_month < OPEN_ROWS_GRACE
        done_ids = {u for (u,) in db.query(PersonaReport.user_id).filter(PersonaReport.period == period).all()}
        todo = [u for u in service.candidate_users(db, period) if u not in done_ids]
        archived = skipped = 0
        for uid in todo[:MAX_USERS_PER_PASS]:
            rows = None
            if with_open:
                try:
                    from app.services.connection_manager import manager
                    rows = manager.get_positions_shared(uid)
                except Exception:  # noqa: BLE001 —— 快照读不到就不带浮亏单 / no snapshot, no floating losers
                    rows = None
            try:
                row = service.archive_user(db, uid, period, now, open_rows=rows, ai_enabled=ai_enabled)
            except Exception:  # noqa: BLE001 —— 一个人出错不拖累其他人 / one failure doesn't stop the rest
                db.rollback()
                logger.exception("persona archive failed for a user")
                skipped += 1
                continue
            if row is None:
                skipped += 1
            else:
                archived += 1
        finished = len(todo) <= MAX_USERS_PER_PASS
        if finished:
            set_setting(db, WATERMARK_KEY, {"period": period, "at": now.isoformat()})
            db.commit()
        return {"period": period, "archived": archived, "skipped": skipped, "done": finished}
    finally:
        db.close()


async def persona_loop(startup_delay: float = 50.0):
    await asyncio.sleep(startup_delay)
    from app.services import loop_health
    while True:
        loop_health.beat("persona")
        try:
            result = await run_in_threadpool(run_archive_pass)
            if result.get("archived"):
                logger.info("persona archive %s", result)
        except Exception:
            logger.exception("persona archive pass failed")
        await asyncio.sleep(LOOP_INTERVAL_SECONDS)
