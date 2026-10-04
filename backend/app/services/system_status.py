"""管理后台「系统状态」页的数据：每个部件一盏灯（ok / warn / down / idle）+ 判断依据。

给不懂技术的管理员看：灯是什么颜色、旁边该写什么处理建议，由前端按 key + level 查文案；
这里只负责「量出来」和「定级」。每一项都有超时、都不抛异常——状态页本身不能因为某个
部件坏了而打不开，那正是最需要它的时候。

Data for the admin system-status page: one light per component plus the facts
behind it. Every probe is bounded and never raises — the page must still load
when a component is down, which is exactly when it's needed.
"""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import func, text
from starlette.concurrency import run_in_threadpool

from app.core import config
from app.core.database import SessionLocal, engine
from app.models import MT5Account, Signal
from app.services import gateway_client, loop_health, quotes_store, shared_state
from app.services.deps import ONLINE_WINDOW

OK, WARN, DOWN, IDLE = "ok", "warn", "down", "idle"

PROBE_TIMEOUT = 5.0
# 本进程启动时刻：两个 worker 同时起，近似当作「后端运行了多久」。
_STARTED_AT = time.time()

# 行情：最新一条报价多少秒内算正常 / 多少秒以上算断了。EA 默认 2 秒推一次，休市品种也会
# 带 closed 标记照推（见 routers/chart.py 的休市兜底），所以「全部品种都很久没更新」只有
# 一种解释：行情 EA 或它所在的 MT5 终端停了。
FEED_OK_SEC = 60
FEED_DOWN_SEC = 300

# 各后台循环一轮的正常间隔（秒）。心跳超过 2 倍间隔 + 2 分钟没更新就判「停了」。
# 间隔改了这里跟着改；没列的循环按 STALE_DEFAULT 算。
LOOP_INTERVALS: dict[str, int] = {
    "offline_monitor": 32,          # 2 秒；没人在线时 30 秒
    "stale_orders": 10,
    "signal_expiry": 5,
    "stale_signals": 3600,
    "stale_strategy_signals": 3600,
    "sentiment": 300,
    "plan_expiry": 900,
    "email_broadcast": 300,
    "gamification": 3600,
    "competitions": 60,
    "boards": 300,
    "candle_retention": 86400,
    "gateway_positions": 2,
    "signal_engine": 15,
}
STALE_DEFAULT = 3600
LOOP_ERROR_RECENT_SEC = 3600


def _ago(ts: float | None, now: float) -> int | None:
    return None if not ts else max(0, int(now - ts))


async def _bounded(fn: Callable[[], Any], timeout: float = PROBE_TIMEOUT) -> tuple[Any, str | None]:
    """在线程池里跑一个阻塞探测，最多等 timeout 秒。返回 (结果, 错误说明)。
    超时后线程还会继续跑完，但请求不再等它。"""
    try:
        return await asyncio.wait_for(run_in_threadpool(fn), timeout), None
    except asyncio.TimeoutError:
        return None, "超时（%.0f 秒）" % timeout
    except Exception as e:  # noqa: BLE001
        return None, "%s: %s" % (type(e).__name__, str(e)[:200])


# ---------------------------------------------------------------- 各部件


def _deployed_commit() -> str | None:
    """自动部署记下的「最近一次健康上线」的 commit（backend/scripts/deploy.sh）。"""
    path = os.path.join(os.path.expanduser("~"), ".prismx-deploy", "last-good-commit")
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()[:12] or None
    except OSError:
        return None


def _backend(app: Any, now: float) -> dict:
    loops = getattr(app.state, "background_loops", None)
    leader = None
    try:
        leader = shared_state.kv_get("lock:background-loops")
    except Exception:  # noqa: BLE001
        pass
    return {
        "level": OK,
        "uptimeSec": int(now - _STARTED_AT),
        "workers": config._WORKER_COUNT or 1,
        "workerId": shared_state.WORKER_ID,
        "isLeader": bool(loops and loops.is_leader),
        "leader": leader,
        "commit": _deployed_commit(),
    }


def _db_probe() -> dict:
    t0 = time.perf_counter()
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    ms = int((time.perf_counter() - t0) * 1000)
    pool = engine.pool
    out: dict = {"latencyMs": ms}
    for attr in ("size", "checkedout", "overflow"):
        fn = getattr(pool, attr, None)
        if callable(fn):
            try:
                out["pool" + attr.capitalize()] = int(fn())
            except Exception:  # noqa: BLE001
                pass
    return out


async def _database() -> dict:
    res, err = await _bounded(_db_probe)
    if err:
        return {"level": DOWN, "error": err}
    level = OK if res["latencyMs"] < 1000 else WARN
    return {"level": level, **res}


def _redis_probe() -> int:
    t0 = time.perf_counter()
    if not shared_state.ping():
        raise RuntimeError("PING 没有回应")
    return int((time.perf_counter() - t0) * 1000)


async def _redis() -> dict:
    if not shared_state.enabled():
        return {"level": IDLE, "enabled": False}
    ms, err = await _bounded(_redis_probe, 3.0)
    if err:
        return {"level": DOWN, "enabled": True, "error": err}
    return {"level": OK if ms < 200 else WARN, "enabled": True, "latencyMs": ms}


def _gateway(now: float) -> dict:
    p = gateway_client.last_probe()
    if not p.get("at"):
        return {"level": IDLE, "monitorRunning": p.get("monitorRunning", False)}
    body = p.get("body") or {}
    reachable = bool(body.get("ok"))
    facts = {
        "probeAgoSec": _ago(p["at"], now),
        "online": p["online"],
        "reachable": reachable,
        "mt5Connected": body.get("mt5Connected") if reachable else None,
        "dealerActive": body.get("dealerActive") if reachable else None,
        "degradedSec": body.get("degradedSec"),
        "gateBlockedSec": body.get("gateBlockedSec"),
        "readChannels": body.get("readChannels"),
        "readChannelsConnected": body.get("readChannelsConnected"),
        "detail": p.get("detail") or "",
    }
    if not p["online"]:
        level = DOWN
    elif not p.get("ok"):
        level = WARN          # 刚失败、还在 30 秒宽限里
    elif facts["probeAgoSec"] is not None and facts["probeAgoSec"] > 30:
        level = WARN          # 探活协程停了，数据不新鲜
    elif (facts["readChannels"] or 0) > (facts["readChannelsConnected"] or 0):
        level = WARN          # 查询通道没连满：能用，但高峰时查询会慢
    else:
        level = OK
    return {"level": level, **facts}


async def _feed(now: float) -> dict:
    rows, err = await _bounded(quotes_store.get_feed_state, 3.0)
    if err:
        return {"level": WARN, "error": err}
    if not rows:
        return {"level": IDLE, "symbols": 0}
    newest = max(ts for _, ts, _ in rows)
    newest_ago = _ago(newest, now)
    active = [(s, closed) for s, ts, closed in rows if now - ts <= quotes_store.ACTIVE_WINDOW_SECONDS]
    if newest_ago is None or newest_ago > FEED_DOWN_SEC:
        level = DOWN
    elif newest_ago > FEED_OK_SEC:
        level = WARN
    else:
        level = OK
    return {
        "level": level,
        "newestAgoSec": newest_ago,
        "symbols": len(rows),
        "activeSymbols": len(active),
        "closedSymbols": sum(1 for _, closed in active if closed),
    }


def _db_counts() -> dict:
    db = SessionLocal()
    try:
        last_signal = (
            db.query(func.max(Signal.created_at)).filter(Signal.source == "mt5").scalar()
        )
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=ONLINE_WINDOW)
        bridges = (
            db.query(func.count(MT5Account.id))
            .filter(MT5Account.source != "gateway", MT5Account.last_heartbeat >= cutoff)
            .scalar()
        )
        gateway_accounts = (
            db.query(func.count(MT5Account.id))
            .filter(MT5Account.source == "gateway", MT5Account.revoked_at.is_(None))
            .scalar()
        )
        return {"lastSignal": last_signal, "bridges": int(bridges or 0),
                "gatewayAccounts": int(gateway_accounts or 0)}
    finally:
        db.close()


def _to_epoch(dt: datetime | None) -> float | None:
    if dt is None:
        return None
    if dt.tzinfo is None:   # 库里是 naive UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _loops(app: Any, now: float, uptime: int) -> list[dict]:
    loops = getattr(app.state, "background_loops", None)
    names = loops.names if loops is not None else []
    snap = loop_health.snapshot(names)
    out = []
    for name in names:
        rec = snap.get(name, {})
        interval = LOOP_INTERVALS.get(name, STALE_DEFAULT)
        stale_after = 2 * interval + 120
        beat_ago = _ago(rec.get("beatAt"), now)
        error_ago = _ago(rec.get("errorAt"), now)
        crash_ago = _ago(rec.get("crashAt"), now)
        if crash_ago is not None:
            level = DOWN
        elif beat_ago is None:
            # 刚启动、第一轮还没跑到（有的循环先睡一整个间隔再干活）
            level = IDLE if uptime < stale_after else WARN
        elif beat_ago > stale_after:
            level = DOWN
        elif error_ago is not None and error_ago < LOOP_ERROR_RECENT_SEC:
            level = WARN
        else:
            level = OK
        out.append({
            "name": name,
            "level": level,
            "intervalSec": interval,
            "beatAgoSec": beat_ago,
            "errorAgoSec": error_ago,
            "errorMessage": rec.get("errorMessage"),
            "crashAgoSec": crash_ago,
            "crashMessage": rec.get("crashMessage"),
        })
    return out


def _roll_up(levels: list[str]) -> str:
    if DOWN in levels:
        return DOWN
    if WARN in levels:
        return WARN
    if levels and all(lv == IDLE for lv in levels):
        return IDLE
    return OK


async def collect(app: Any) -> dict:
    """整页数据，一次返回。/ The whole page in one call."""
    from app.services.connection_manager import manager

    now = time.time()
    # 读领导锁、读循环记录都是同步 Redis 往返：Redis 卡住时不能拖住事件循环，也不能拖垮整页。
    backend, backend_err = await _bounded(lambda: _backend(app, now), 3.0)
    if backend_err:
        backend = {"level": OK, "uptimeSec": int(now - _STARTED_AT), "error": backend_err}

    async def _users() -> int | None:
        try:
            return len(await asyncio.wait_for(manager.connected_user_ids_async(), 3.0))
        except Exception:  # noqa: BLE001
            return None

    database, redis, feed, (counts, counts_err), online_users = await asyncio.gather(
        _database(), _redis(), _feed(now), _bounded(_db_counts), _users(),
    )

    if counts_err:
        signals = {"level": WARN, "error": counts_err}
        counts = {}
    else:
        last = _to_epoch(counts.get("lastSignal"))
        signals = {"level": OK if last else IDLE, "lastAgoSec": _ago(last, now)}

    loop_rows, loops_err = await _bounded(lambda: _loops(app, now, backend["uptimeSec"]))
    if loops_err:
        loop_rows = []
        loops_light = {"level": WARN, "error": loops_err}
    else:
        loops_light = {
            "level": _roll_up([r["level"] for r in loop_rows]),
            "total": len(loop_rows),
            "down": sum(1 for r in loop_rows if r["level"] == DOWN),
            "warn": sum(1 for r in loop_rows if r["level"] == WARN),
        }

    online = {
        "level": OK,
        "users": online_users,
        "bridges": counts.get("bridges"),
        "gatewayAccounts": counts.get("gatewayAccounts"),
    }

    components = {
        "backend": backend,
        "database": database,
        "redis": redis,
        "gateway": _gateway(now),
        "feed": feed,
        "signals": signals,
        "loops": loops_light,
        "online": online,
    }
    return {
        "generatedAt": now,
        "overall": _roll_up([c["level"] for c in components.values()]),
        "components": components,
        "loops": loop_rows,
    }
