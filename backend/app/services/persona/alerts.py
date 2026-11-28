"""每日亏损提醒（2026-11-28，rev 58）：用户自己设一个「今天最多亏多少」，到了发一条通知。

- 只是提醒：不拦单、不平仓、不改下单流程。
- 「今天」按 UTC 自然日（和交易报告同一把尺）。今日盈亏 = 今天整仓平完的实盘单的净盈亏
  + 此刻实盘持仓的浮动盈亏（盈亏都算）；只算本平台下的单，口径和报告一致。
- 一天只提醒一次（persona_prefs.loss_fired_day）；用户当天改了金额或重新打开开关会重新计。
- 循环只在领导 worker 上跑，每 60 秒一轮，只看开着提醒的人；总开关 persona_visible 关着时不发
  （入口在交易报告页，关着的时候用户进不去）。

The self-set daily loss alert: a notification once the day's loss reaches the user's own limit. It only
notifies; orders are never blocked. "Today" is the UTC day; the figure is today's closed real positions
plus the floating P&L of open real positions, platform orders only. Fires once per day.
"""
import asyncio
import logging
from datetime import datetime, timezone

from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import PersonaPref
from app.services.persona.positions import load_positions, open_real_profit, utcnow

logger = logging.getLogger("prismx.persona")

LOOP_INTERVAL_SECONDS = 60
MAX_USERS_PER_PASS = 500
LIMIT_MIN = 1.0
LIMIT_MAX = 1_000_000.0
ALERT_LINK = "/persona"
PUSH_TAG = "prismx-loss-alert"

# {loss} 今天的亏损金额，{limit} 用户设的上限，都已格式化成两位小数。
# {loss} is today's loss and {limit} the user's own limit, both formatted to two decimals.
PUSH_COPY = {
    "zh": ("今日亏损已到你设的上限", "今天已亏损 {loss}，达到你设的 {limit}。先停一停，看看今天的单。"),
    "en": ("Daily loss limit reached", "You are down {loss} today, at the {limit} limit you set. Take a pause and review today's trades."),
    "ja": ("本日の損失が上限に達しました", "本日の損失は {loss}、設定した上限 {limit} に達しました。いったん手を止めて今日の取引を見直しましょう。"),
    "th": ("ขาดทุนวันนี้ถึงขีดจำกัดที่คุณตั้งไว้", "วันนี้ขาดทุน {loss} ถึงขีดจำกัด {limit} ที่คุณตั้งไว้แล้ว พักสักครู่แล้วทบทวนออเดอร์ของวันนี้"),
    "vi": ("Lỗ hôm nay đã chạm mức bạn đặt", "Hôm nay bạn đã lỗ {loss}, chạm mức {limit} bạn đặt. Hãy tạm dừng và xem lại các lệnh hôm nay."),
}


def push_text(lang: str, loss: float, limit: float) -> tuple[str, str]:
    title, body = PUSH_COPY.get(lang, PUSH_COPY["zh"])
    return title, body.format(loss=f"{loss:.2f}", limit=f"{limit:.2f}")


def day_key(now: datetime) -> str:
    return now.astimezone(timezone.utc).strftime("%Y-%m-%d")


def alert_out(row: PersonaPref | None, now: datetime) -> dict:
    return {
        "limit": row.loss_limit if row is not None else None,
        "enabled": bool(row.loss_enabled) if row is not None else False,
        "firedToday": bool(row is not None and row.loss_fired_day == day_key(now)),
    }


def save_alert(db, user_id: str, limit: float | None, enabled: bool) -> PersonaPref:
    """存用户的设置。金额变了或重新打开，当天的「已提醒」清掉。不提交。
    Store the user's setting; a new limit or re-enabling clears today's fired mark. Does not commit."""
    from app.services.persona.extras import pref_row
    if limit is not None:
        limit = round(float(limit), 2)
        if not (LIMIT_MIN <= limit <= LIMIT_MAX):
            raise ValueError("limit out of range")
    if enabled and limit is None:
        raise ValueError("limit required")
    row = pref_row(db, user_id, create=True)
    if limit != row.loss_limit or (enabled and not row.loss_enabled):
        row.loss_fired_day = None
    row.loss_limit = limit
    row.loss_enabled = bool(enabled)
    return row


def today_pnl(db, user_id: str, open_rows, now: datetime) -> float:
    start = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    realized = sum(p.profit for p in load_positions(db, user_id, start, now))
    return realized + open_real_profit(db, user_id, open_rows or [])


def run_alert_pass(now: datetime | None = None) -> dict:
    """看一轮。返回 {checked, fired}。/ One pass over the users with the alert on."""
    from app.services.settings_store import get_gamification_settings
    now = now or utcnow()
    today = day_key(now)
    db = SessionLocal()
    try:
        if not get_gamification_settings(db).get("persona_visible"):
            return {"checked": 0, "fired": 0, "off": True}
        rows = (db.query(PersonaPref)
                  .filter(PersonaPref.loss_enabled.is_(True), PersonaPref.loss_limit.isnot(None))
                  .limit(MAX_USERS_PER_PASS * 4).all())
        todo = [r for r in rows if r.loss_fired_day != today][:MAX_USERS_PER_PASS]
        fired: list[tuple[str, float, float]] = []
        for row in todo:
            try:
                try:
                    from app.services.connection_manager import manager
                    open_rows = manager.get_positions_shared(row.user_id)
                except Exception:  # noqa: BLE001 —— 快照读不到就只看已平仓的 / closed positions only
                    open_rows = None
                pnl = today_pnl(db, row.user_id, open_rows, now)
            except Exception:  # noqa: BLE001 —— 一个人出错不拖累其他人 / one failure doesn't stop the rest
                db.rollback()
                logger.exception("loss alert check failed for a user")
                continue
            if pnl <= -float(row.loss_limit):
                # 先把「今天已提醒」落库再发：后面谁出错回滚，都不会让这个人被提醒第二次
                # The fired mark is committed before anything is sent, so a later rollback can't re-fire it.
                row.loss_fired_day = today
                db.commit()
                fired.append((row.user_id, -pnl, float(row.loss_limit)))
        if fired:
            _notify(db, fired)
        return {"checked": len(todo), "fired": len(fired)}
    finally:
        db.close()


def _notify(db, fired: list[tuple[str, float, float]]) -> None:
    from app.services.notification_feed import KIND_LOSS_ALERT, create_notification, notify_ws_many
    try:
        for uid, loss, limit in fired:
            create_notification(db, uid, KIND_LOSS_ALERT, text=f"-{loss:.2f} / {limit:.2f}", link=ALERT_LINK,
                                ref_id=None)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("loss alert notifications failed")
        return
    notify_ws_many([u for u, _, _ in fired])
    try:
        from app.services.persona.loop import DEFAULT_PUSH_LANG, user_langs
        from app.services.push_dispatch import EVENT_LOSS_ALERT, dispatch_users_push
        langs = user_langs(db, [u for u, _, _ in fired])
        for uid, loss, limit in fired:
            title, body = push_text(langs.get(uid, DEFAULT_PUSH_LANG), loss, limit)
            dispatch_users_push([uid], EVENT_LOSS_ALERT, title, body, url=ALERT_LINK, tag=PUSH_TAG)
    except Exception:  # noqa: BLE001
        logger.exception("loss alert push failed")


async def loss_alert_loop(startup_delay: float = 70.0):
    await asyncio.sleep(startup_delay)
    from app.services import loop_health
    while True:
        loop_health.beat("persona_alerts")
        try:
            result = await run_in_threadpool(run_alert_pass)
            if result.get("fired"):
                logger.info("loss alerts %s", result)
        except Exception:
            logger.exception("loss alert pass failed")
        await asyncio.sleep(LOOP_INTERVAL_SECONDS)
