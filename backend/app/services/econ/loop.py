"""财经日历后台循环（只在领导 worker 上跑，见 services/background.py）。每 30 秒一轮：

1. 总开关关着或没配 NARWHAL_API_KEY：只记状态，不发任何请求。
2. 每小时同步一次日程：关注的国家，昨天到 7 天后（约 2–3 次调用）。
3. 到点补查公布值：公布时刻后 2、5、15、60 分钟各查一次（按日期取，一次调用覆盖当天所有国家）。
   Narwhal 的 webhook 还没接（推送延迟未测），先用补查；每月调用量估算见临时计划第 5 节。
4. 写预案：未来 24 小时内的中高重要度组（DeepSeek 高峰时段只写 6 小时内的），每轮最多 3 组，
   受每日调用上限约束。
5. 公布值到了：给预案记上命中的情景（不调模型）。

Calendar loop (leader worker only), every 30s: hourly schedule sync, post-release re-checks at
+2/+5/+15/+60 min, previews for the next 24h (6h during DeepSeek peak hours, at most 3 per pass,
under the daily cap), and outcome stamping when actuals land. With the switch off or no key it
sends nothing.
"""
import asyncio
import logging
import time
from datetime import datetime, timedelta

from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import EconPreview, EconRelease
from app.services.econ import deepseek, narwhal, previews, store

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


def run_previews(db, cfg: dict, now: datetime) -> int:
    if not cfg["previews"] or not deepseek.configured():
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
