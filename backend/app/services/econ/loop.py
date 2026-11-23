"""财经日历后台循环（只在领导 worker 上跑，见 services/background.py）。每 30 秒一轮：

1. 总开关关着或没配 NARWHAL_API_KEY：只记状态，不发任何请求。
2. 每小时同步一次日程：关注的国家，昨天到 7 天后（约 2–3 次调用）。
3. 到点补查公布值：公布时刻后 2、5、15、60 分钟各查一次（按日期取，一次调用覆盖当天所有国家）。
   Narwhal 的 webhook 还没接（推送延迟未测），先用补查；每月调用量估算见临时计划第 5 节。
4. 写预案：未来 24 小时内的中高重要度组（DeepSeek 高峰时段只写 6 小时内的），每轮最多 3 组，
   受每日调用上限约束。
5. 公布值到了：给预案记上命中的情景（不调模型）。
6. 红色数据公布前 30 分钟推送提醒（2026-11-23，rev 54；还要求「对用户开放」和「提醒」两个开关）。

Calendar loop (leader worker only), every 30s: hourly schedule sync, post-release re-checks at
+2/+5/+15/+60 min, previews for the next 24h (6h during DeepSeek peak hours, at most 3 per pass,
under the daily cap), and outcome stamping when actuals land. With the switch off or no key it
sends nothing.
"""
import asyncio
import json
import logging
import time
from datetime import datetime, timedelta
from urllib.parse import urlencode

from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import EconPreview, EconRelease
from app.services import push_dispatch
from app.services.econ import deepseek, narwhal, previews, rules, store

logger = logging.getLogger("prismx.econ")

LOOP_INTERVAL_SECONDS = 30
FULL_SYNC_SECONDS = 3600
CHECK_OFFSETS = [timedelta(minutes=m) for m in (2, 5, 15, 60)]
PREVIEWS_PER_PASS = 3
RETENTION_DAYS = 120

_last_full_sync = 0.0


def full_sync(db, cfg: dict, now: datetime) -> dict:
    """同步昨天到 7 天后的日程并入库提交。/ Sync yesterday … +7 days and commit."""
    start, end = now.date() - timedelta(days=1), now.date() + timedelta(days=7)
    res = narwhal.fetch_calendar(cfg["countries"], start, end)
    stats = store.upsert_releases(db, res.releases, now)
    db.commit()
    stats["outcomes"] = previews.apply_outcomes(db, stats["actualGroups"], now)
    cutoff = now - timedelta(days=RETENTION_DAYS)
    db.query(EconRelease).filter(EconRelease.at.isnot(None), EconRelease.at < cutoff).delete(synchronize_session=False)
    db.commit()
    store.update_status(lastSyncAt=now.isoformat() + "Z", lastSyncCalls=res.calls, lastSyncSeen=stats["seen"],
                        balance=res.balance, lastError=None, lastErrorAt=None)
    return stats


def sync_range(start, end) -> dict:
    """管理员在小日历上选了某一周、手动同步那一周（阻塞，放线程池）。约 2–3 次调用。
    Sync an arbitrary week the admin picked on the mini calendar (blocking). About 2–3 calls."""
    db = SessionLocal()
    try:
        cfg = store.get_settings(db)
        now = store.utcnow()
        try:
            res = narwhal.fetch_calendar(cfg["countries"], start, end)
        except narwhal.NarwhalError as exc:
            store.update_status(lastError=str(exc)[:300], lastErrorAt=now.isoformat() + "Z")
            return {"error": str(exc)}
        stats = store.upsert_releases(db, res.releases, now)
        db.commit()
        stats["outcomes"] = previews.apply_outcomes(db, stats["actualGroups"], now)
        db.commit()
        fields = {"lastSyncAt": now.isoformat() + "Z", "lastSyncCalls": res.calls, "lastSyncSeen": stats["seen"],
                  "lastError": None, "lastErrorAt": None}
        if res.balance is not None:
            fields["balance"] = res.balance
        store.update_status(**fields)
        return {"sync": stats}
    finally:
        db.close()


def due_checks(db, cfg: dict, now: datetime) -> list[EconRelease]:
    """到了补查时刻、还没有公布值、带数值的发布。/ Releases due for a re-check that still lack an actual."""
    rows = (db.query(EconRelease)
            .filter(EconRelease.at.isnot(None), EconRelease.at <= now - CHECK_OFFSETS[0],
                    EconRelease.at >= now - CHECK_OFFSETS[-1] - timedelta(minutes=30),
                    EconRelease.has_actual.is_(False), EconRelease.status != "cancelled",
                    EconRelease.check_stage < len(CHECK_OFFSETS), EconRelease.values_json != "[]",
                    EconRelease.country.in_(cfg["countries"]))
            .all())
    return [r for r in rows if r.at <= now - CHECK_OFFSETS[r.check_stage]]


def run_checks(db, cfg: dict, now: datetime) -> dict:
    due = due_checks(db, cfg, now)
    if not due:
        return {"checked": 0}
    days = sorted({r.at.date() for r in due})
    calls = 0
    balance = None
    for d in days:
        res = narwhal.fetch_calendar(cfg["countries"], d, d)
        calls += res.calls
        balance = res.balance if res.balance is not None else balance
        stats = store.upsert_releases(db, res.releases, now)
        db.commit()
        previews.apply_outcomes(db, stats["actualGroups"], now)
    for r in due:
        db.refresh(r)
        if not r.has_actual:
            r.check_stage = (r.check_stage or 0) + 1
    db.commit()
    fields = {"lastCheckAt": now.isoformat() + "Z", "lastCheckCalls": calls}
    if balance is not None:
        fields["balance"] = balance
    store.update_status(**fields)
    return {"checked": len(due), "calls": calls}


# 红色数据提醒：公布前 30 分钟以内、还没推过的就推（2026-11-23，rev 54）。同一时刻的几条合成一条。
# Red-release alerts: within 30 minutes of release and not yet sent; one push per moment.
ALERT_LEAD = timedelta(minutes=30)
ALERT_MIN_LEFT = timedelta(minutes=2)
ALERT_MAX_NAMES = 3


def _alert_name(row: EconRelease, previews_by_group: dict[str, EconPreview]) -> str:
    """推送里一项的名字：有预案就用预案的中文标题（后端没有指标中文名表），否则 Narwhal 的英文名。
    One item's name: the preview's Chinese title when there is one (the backend has no Chinese name
    table), else Narwhal's English name."""
    p = previews_by_group.get(row.group_key or "")
    if p is not None and p.status == "ok" and p.content_json:
        try:
            title = json.loads(p.content_json).get("title_zh")
        except (ValueError, TypeError, AttributeError):
            title = None
        if isinstance(title, str) and title.strip():
            return title.strip()
    return row.name


def run_alerts(db, cfg: dict, now: datetime) -> dict:
    """红色数据公布前的推送：先在库里记上 alert_sent_at 并提交，再发——发送失败也不会重推。
    Pre-release push for red releases: alert_sent_at is committed before sending, so a failed send
    never repeats."""
    if not (cfg["alerts"] and cfg["public"]):
        return {"sent": 0}
    rows = (db.query(EconRelease)
            .filter(EconRelease.at.isnot(None), EconRelease.at > now + ALERT_MIN_LEFT,
                    EconRelease.at <= now + ALERT_LEAD, EconRelease.importance >= rules.HIGH,
                    EconRelease.status == "scheduled", EconRelease.alert_sent_at.is_(None),
                    EconRelease.country.in_(cfg["countries"]))
            .order_by(EconRelease.at, EconRelease.country).all())
    if not rows:
        return {"sent": 0}
    keys = {r.group_key for r in rows if r.group_key}
    previews_by_group = {p.group_key: p for p in db.query(EconPreview).filter(EconPreview.group_key.in_(keys)).all()}         if keys else {}
    moments: dict[datetime, list[EconRelease]] = {}
    for r in rows:
        moments.setdefault(r.at, []).append(r)
        r.alert_sent_at = now
    db.commit()
    messages = []
    for at, members in moments.items():
        items: list[str] = []
        for r in members:
            label = f"{r.currency or r.country} {_alert_name(r, previews_by_group)}"
            if label not in items:
                items.append(label)
        minutes = max(1, round((at - now).total_seconds() / 60))
        body = "、".join(items[:ALERT_MAX_NAMES])
        if len(items) > ALERT_MAX_NAMES:
            body += f" 等 {len(items)} 项"
        first = members[0]
        url = "/calendar?" + urlencode({"day": at.date().isoformat(), "focus": first.group_key or ""})
        messages.append((f"高影响数据 {minutes} 分钟后公布", body, url, f"prismx-econ-{at:%Y%m%d%H%M}"))
    sent = 0
    for title, body, url, tag in messages:
        sent += push_dispatch.dispatch_broadcast_push(push_dispatch.EVENT_ECON_ALERT, title, body, url, tag)
    store.update_status(lastAlertAt=now.isoformat() + "Z", lastAlertMoments=len(messages), lastAlertSubs=sent)
    return {"moments": len(messages), "sent": sent}


WEEK_JOB_STALE = timedelta(minutes=30)


def week_job_running(now: datetime | None = None) -> bool:
    """管理员手动生成的整周任务还在跑吗（30 分钟没结束当作已死）。
    Is an admin-triggered week job still running (treated as dead after 30 min)."""
    job = store.get_status().get("weekJob") or {}
    if not job.get("running"):
        return False
    started = store._parse_at(job.get("startedAt"))
    return started is not None and (now or store.utcnow()) - started < WEEK_JOB_STALE


def run_week_job(lo: datetime, hi: datetime) -> dict:
    """管理员点「生成这一周预案」：把 [lo, hi) 里该写的组逐个写完（阻塞，放线程池）。
    进度写进状态 weekJob，前端轮询。仍受每日调用上限约束。
    Admin "generate this week": write every due group in [lo, hi) one by one (blocking). Progress goes
    to status.weekJob for the page to poll. Still bound by the daily cap."""
    db = SessionLocal()
    now = store.utcnow()
    job = {"running": True, "startedAt": now.isoformat() + "Z", "from": lo.isoformat() + "Z",
           "to": hi.isoformat() + "Z", "total": 0, "done": 0, "failed": 0, "capHit": False}
    store.update_status(weekJob=job)
    try:
        cfg = store.get_settings(db)
        groups = previews.due_groups(db, cfg, now, lo=lo, hi=hi, retry_failed=True)
        job["total"] = len(groups)
        store.update_status(weekJob=dict(job))
        for key, rows in groups:
            if store.llm_calls_today() >= cfg["dailyLlmCap"]:
                job["capHit"] = True
                break
            p = previews.generate(db, key, rows, store.utcnow())
            db.commit()
            job["done" if p.status == "ok" else "failed"] += 1
            store.update_status(weekJob=dict(job))
        return job
    except Exception as exc:   # 任务失败也要把 running 关掉 / always clear running
        logger.exception("econ week job failed")
        job["error"] = str(exc)[:300]
        return job
    finally:
        job["running"] = False
        job["finishedAt"] = store.utcnow().isoformat() + "Z"
        store.update_status(weekJob=dict(job))
        db.close()


def run_previews(db, cfg: dict, now: datetime) -> int:
    if not cfg["previews"] or not deepseek.configured():
        return 0
    if week_job_running(now):   # 手动整周任务在写，别抢同一批组 / the admin week job is writing these
        return 0
    written = 0
    for key, rows in previews.due_groups(db, cfg, now)[:PREVIEWS_PER_PASS]:
        if store.llm_calls_today() >= cfg["dailyLlmCap"]:
            store.update_status(llmCapHit=now.isoformat() + "Z")
            break
        p = previews.generate(db, key, rows, now)
        db.commit()
        if p.status == "ok":
            written += 1
        else:
            logger.warning("econ preview failed for %s: %s", key, p.error)
    return written


def stamp_pending_outcomes(db, now: datetime) -> int:
    keys = [k for (k,) in db.query(EconPreview.group_key)
            .filter(EconPreview.outcome.is_(None), EconPreview.at <= now, EconPreview.at >= now - timedelta(days=3))
            .all()]
    n = previews.apply_outcomes(db, keys, now)
    if n:
        db.commit()
    return n


def run_once(force_sync: bool = False) -> dict:
    """一轮（阻塞，放线程池）。/ One pass (blocking; run in a thread pool)."""
    global _last_full_sync
    db = SessionLocal()
    out: dict = {}
    try:
        cfg = store.get_settings(db)
        store.update_status(enabled=cfg["enabled"], narwhalConfigured=narwhal.configured(),
                            deepseekConfigured=deepseek.configured())
        if not (cfg["enabled"] or force_sync) or not narwhal.configured():
            return {"skipped": True}
        now = store.utcnow()
        try:
            if force_sync or time.time() - _last_full_sync >= FULL_SYNC_SECONDS:
                out["sync"] = full_sync(db, cfg, now)
                _last_full_sync = time.time()
            if cfg["enabled"]:
                out["checks"] = run_checks(db, cfg, now)
        except narwhal.NarwhalError as exc:
            db.rollback()
            # 出错 5 分钟后再试整页同步，不每 30 秒撞一次 / retry the full sync in 5 min, not every pass
            _last_full_sync = time.time() - FULL_SYNC_SECONDS + 300
            store.update_status(lastError=str(exc)[:300], lastErrorAt=now.isoformat() + "Z")
            logger.warning("econ narwhal error: %s", exc)
            out["error"] = str(exc)
        if cfg["enabled"]:
            try:
                out["alerts"] = run_alerts(db, cfg, now)
            except Exception:   # 提醒出错不能挡住预案和命中记录 / alerts must not block the rest
                db.rollback()
                logger.exception("econ alerts failed")
            out["outcomes"] = stamp_pending_outcomes(db, now)
            out["previews"] = run_previews(db, cfg, now)
        return out
    finally:
        db.close()


async def econ_calendar_loop() -> None:
    from app.services import loop_health

    # 与其它循环错开启动 / stagger startup against the other loops
    await asyncio.sleep(20)
    while True:
        loop_health.beat("econ_calendar")
        try:
            await run_in_threadpool(run_once)
        except Exception:
            logger.exception("econ_calendar_loop error")
        await asyncio.sleep(LOOP_INTERVAL_SECONDS)
