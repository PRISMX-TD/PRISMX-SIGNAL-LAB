"""交易报告月底存档循环（只在领导 worker 上跑）。每 10 分钟看一眼：上个月还没存完就接着存。

- 每月 1 号 00:05（UTC）之后开始存上个月；一轮最多处理 MAX_USERS_PER_PASS 个人，存完记一个水位
  （platform_settings 里的 persona_archive），之后整月不再扫。
- 存档时还没平的浮亏单按亏损算（方案第 4 节），用的是此刻的持仓快照；所以只在月底后 6 小时内带上它们，
  更晚才补存（比如服务停过）就不带，免得拿几天后的浮亏冒充月底的。
- 总开关 persona_visible 关着也照常存：打开时用户能直接看到过去几个月。AI 点评另看 persona_ai_comment。
- 存完一个人就给他发「月报出炉」的站内通知 + 推送（人格变了换一种文案）。只在总开关开着、而且是按时
  存档（月底后 6 小时内）时发：开关关着用户看不到报告；服务停过之后补存的旧月份也不该一次性补发。

Month-end archive loop (leader worker only). Every 10 minutes: if last month isn't fully archived,
continue. Starts 00:05 UTC on the 1st, at most MAX_USERS_PER_PASS users per pass, then records a
watermark. Floating losers come from the live positions snapshot, so they're only included within
6 hours of month end. Archives run even with the user switch off, so history is there when it opens.
Each archived user gets a "report is out" notification + push (different copy when the persona changed,
push text in the user's UI language),
only while the user switch is on and the archive ran on time (within those 6 hours), so a late catch-up
after an outage doesn't notify about an old month.
"""
import asyncio
import logging
from datetime import timedelta

from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import PersonaReport, PersonaState, PlatformSetting, UserPref
from app.services.persona import service
from app.services.persona.positions import utcnow

logger = logging.getLogger("prismx.persona")

LOOP_INTERVAL_SECONDS = 600
START_DELAY = timedelta(minutes=5)
OPEN_ROWS_GRACE = timedelta(hours=6)
MAX_USERS_PER_PASS = 200
WATERMARK_KEY = "persona_archive"
REPORT_LINK = "/persona"
PUSH_TAG = "prismx-persona"

# 推送文案按用户的界面语言发。界面语言存在云端偏好里（user_prefs.data 的 lang.lang，前端切语言时
# 同步上来）；没同步过、或不是这五种之一的按中文发（和其它推送一致）。{m} 是月份数字，英文用月份名。
# 每种语言两条：(标题, 正文)，same = 人格没变，changed = 人格变了。
# Push copy follows the user's UI language, read from the synced prefs (user_prefs.data → lang.lang,
# written by the frontend on a language switch); users without one, or with anything else, get Chinese
# like every other push. {m} is the month number (the month name in English).
PUSH_LANGS = ("zh", "en", "ja", "th", "vi")
DEFAULT_PUSH_LANG = "zh"
_EN_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September",
              "October", "November", "December")
PUSH_COPY = {
    "zh": {"same": ("交易报告出炉", "你的 {m} 月交易报告出炉了，来看看这个月的表现"),
           "changed": ("你的交易人格变了", "{m} 月交易报告出炉，你的交易人格换了一个，来看看变成了什么")},
    "en": {"same": ("Your trading report is out", "Your {m} trading report is ready. See how the month went."),
           "changed": ("Your trading persona changed",
                       "Your {m} trading report is ready and your persona is a new one. See what it became.")},
    "ja": {"same": ("取引レポートができました", "{m}月の取引レポートができました。今月の結果を確認しましょう"),
           "changed": ("取引人格が変わりました", "{m}月の取引レポートができました。取引人格が新しくなっています")},
    "th": {"same": ("รายงานการเทรดของคุณออกแล้ว", "รายงานการเทรดเดือน {m} ของคุณพร้อมแล้ว มาดูผลงานเดือนนี้กัน"),
           "changed": ("บุคลิกการเทรดของคุณเปลี่ยนไป",
                       "รายงานการเทรดเดือน {m} พร้อมแล้ว และบุคลิกการเทรดของคุณเปลี่ยนไป มาดูกันว่าเป็นแบบไหน")},
    "vi": {"same": ("Báo cáo giao dịch của bạn đã có",
                    "Báo cáo giao dịch tháng {m} của bạn đã sẵn sàng. Xem tháng này bạn giao dịch thế nào."),
           "changed": ("Tính cách giao dịch của bạn đã thay đổi",
                       "Báo cáo giao dịch tháng {m} đã sẵn sàng và tính cách giao dịch của bạn đã đổi. Xem bạn trở thành kiểu nào.")},
}


def push_text(lang: str, kind: str, month: int) -> tuple[str, str]:
    """(标题, 正文)。lang 不认识按中文；month 1–12。/ (title, body); unknown lang → Chinese."""
    title, body = PUSH_COPY.get(lang, PUSH_COPY[DEFAULT_PUSH_LANG])[kind]
    m = _EN_MONTHS[month - 1] if lang == "en" else str(month)
    return title, body.format(m=m)


def user_langs(db, user_ids) -> dict:
    """这批用户各自的界面语言（见 PUSH_COPY 上面的说明）。读不出来的一律给默认语言，绝不抛错。
    Each user's UI language from the synced prefs; anything unreadable falls back to the default."""
    import json
    ids = [u for u in dict.fromkeys(user_ids or []) if u]
    out = {u: DEFAULT_PUSH_LANG for u in ids}
    if not ids:
        return out
    try:
        rows = db.query(UserPref.user_id, UserPref.data).filter(UserPref.user_id.in_(ids)).all()
    except Exception:  # noqa: BLE001
        logger.exception("persona push: reading UI languages failed")
        return out
    for uid, raw in rows:
        try:
            lang = ((json.loads(raw or "{}") or {}).get("lang") or {}).get("lang")
        except (ValueError, AttributeError):
            continue
        if isinstance(lang, str) and lang[:2] in PUSH_LANGS:
            out[uid] = lang[:2]
    return out


def _watermark(db) -> str | None:
    import json
    row = db.query(PlatformSetting).filter(PlatformSetting.key == WATERMARK_KEY).first()
    if row is None:
        return None
    try:
        return (json.loads(row.value) or {}).get("period")
    except (ValueError, AttributeError):
        return None


def _notify(db, period: str, same: list[str], changed: list[tuple[str, str, str]]) -> None:
    """给这一轮存好档的人发通知。same：人格没变的用户；changed：(用户, 旧代号, 新代号)。
    站内通知先落库，再发 WS 信号和推送；任何一步出错只记日志，不影响存档。
    Notify the users archived in this pass. In-app rows are committed first, then the WS signal and the
    push go out; a failure anywhere is logged and never touches the archive."""
    if not same and not changed:
        return
    from app.services.notification_feed import (
        KIND_PERSONA_CHANGED, KIND_PERSONA_REPORT, create_notification, notify_ws_many,
    )
    try:
        for uid in same:
            create_notification(db, uid, KIND_PERSONA_REPORT, text=period, link=REPORT_LINK, ref_id=period)
        for uid, old, new in changed:
            create_notification(db, uid, KIND_PERSONA_CHANGED, text=f"{old} → {new} · {period}",
                                link=REPORT_LINK, ref_id=period)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("persona report notifications failed")
        return
    notify_ws_many(same + [u for u, _, _ in changed])
    try:
        from app.services.push_dispatch import EVENT_PERSONA_REPORT, dispatch_users_push
        month = int(period.split("-")[1])
        moved = [u for u, _, _ in changed]
        langs = user_langs(db, same + moved)
        # 同一种文案、同一种语言的人合成一批发 / one dispatch per (copy, language) group
        groups: dict = {}
        for kind, ids in (("same", same), ("changed", moved)):
            for uid in ids:
                groups.setdefault((kind, langs.get(uid, DEFAULT_PUSH_LANG)), []).append(uid)
        for (kind, lang), ids in groups.items():
            title, body = push_text(lang, kind, month)
            dispatch_users_push(ids, EVENT_PERSONA_REPORT, title, body, url=REPORT_LINK, tag=PUSH_TAG)
    except Exception:  # noqa: BLE001
        logger.exception("persona report push failed")


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
        gs = get_gamification_settings(db)
        ai_enabled = bool(gs.get("persona_ai_comment"))
        with_open = now - start_of_month < OPEN_ROWS_GRACE
        notify = bool(gs.get("persona_visible")) and with_open
        same: list[str] = []
        changed: list[tuple[str, str, str]] = []
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
                old_code = db.query(PersonaState.code).filter(PersonaState.user_id == uid).scalar() if notify else None
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
                if notify:
                    if old_code and row.code and old_code != row.code:
                        changed.append((uid, old_code, row.code))
                    else:
                        same.append(uid)
        _notify(db, period, same, changed)
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
