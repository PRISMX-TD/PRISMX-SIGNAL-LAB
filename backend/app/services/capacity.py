"""容量：在线峰值采样、过载计数、「该不该升级、升级什么」的判定（管理后台系统状态页的「容量」灯）。

给不懂技术的管理员一个明确的信号：现在离上限还有多远、什么时候该升级、具体升级哪一样。
阈值来自 2026-10-10 / 10-11 的生产压测（2 核 4G 新加坡 + 2 个 worker，见《运维手册》§11.1），
刻意保守：黄灯是「开始准备」，红灯是「该动手了」，都留了余量——升级要排期、要停机窗口。

- 峰值：领导 worker 每分钟采一次（`capacity_loop`），按天记最大值，留 9 天；状态页看今天与近 7 天。
  只在有人打开状态页时才量的话，晚上的高峰根本看不到。
- 过载：入口排队超时（core/admission.py）与连接池超时（main.py）都会给用户回「繁忙请重试」，
  每次在本进程计一笔，至多 30 秒往共享存储刷一次（在线程里刷：过载时不能再给事件循环加同步 Redis 往返）。

Capacity for the admin status page: per-minute peak sampling on the leader, overload counts
from the admission and pool-timeout 503s, and a verdict naming what to upgrade. Thresholds
come from the 2026-10-10/11 production load tests (2-core Singapore box, 2 workers) and are
deliberately conservative: yellow means "start preparing", red means "upgrade now".
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from app.services import shared_state

logger = logging.getLogger("prismx.capacity")

OK, WARN, DOWN = "ok", "warn", "down"

# (黄灯, 红灯)。2026-10-11 生产实测：网页同时在线 1200 人 p95 0.16 秒、1600 人约 1 秒、2000 人约
# 2.5 秒；实际用户常开多个页面（手机 + 电脑），这里数的是「人」不是「页面」，所以取 800 / 1200。
# 桥接 450 个时 CPU 已满。网关直连用户本机单核约 1000，生产领导 worker 约 0.77 倍，再给网关
# 查询通道（券商那头）留余量。
# (yellow, red). Measured 2026-10-11: web 1200 online p95 0.16 s, 1600 ~1 s, 2000 ~2.5 s; real
# people often keep several pages open and this counts people, hence 800 / 1200. Bridges hit a
# full CPU at 450. Gateway users ~1000 on one local core, ~0.77x on the production leader,
# minus headroom for the gateway's query channels.
WEB_USERS = (800, 1200)
BRIDGES = (300, 400)
GATEWAY_USERS = (500, 700)
# 最近一次「繁忙请重试」：24 小时内红灯，7 天内黄灯。/ last overload: red within 24 h, yellow within 7 d
OVERLOAD_RED_SEC = 24 * 3600
OVERLOAD_WARN_SEC = 7 * 24 * 3600

SAMPLE_INTERVAL = 60
PEAK_TTL = 9 * 24 * 3600
_PEAK_KEY = "cap:peak:"          # + YYYY-MM-DD（UTC）
_OVERLOAD_COUNT_KEY = "cap:overload:"   # + YYYY-MM-DD
_OVERLOAD_LAST_KEY = "cap:overload:last"
FLUSH_EVERY = 30.0

# 升级建议的代号（前端按代号查文案，写清楚升级什么、怎么升）。
# Upgrade advice codes; the frontend turns each into concrete "what and how" copy.
ADVICE_SERVER = "server"            # 新加坡后端服务器加 CPU + worker 数 + DB 连接池
ADVICE_DATABASE = "database"        # Supabase 计算规格
ADVICE_GATEWAY = "gatewayChannels"  # 网关查询通道 read_channels
ADVICE_BRIDGE = "bridgeClient"      # 或者发一版「网页没开就放慢报到」的桥接
ADVICE_SURGE = "surge"              # 出现过「繁忙请重试」：先看是不是集中涌入


def _day(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc).strftime("%Y-%m-%d")


# ---------- 过载计数 / overload counting ----------
_lock = threading.Lock()
_pending: dict[str, int] = {}
_pending_last: tuple[float, str] | None = None
_flushed_at = 0.0


def note_overload(kind: str) -> None:
    """记一次「繁忙请重试」。在事件循环里调用也安全：只动内存，至多 30 秒在线程里刷一次共享存储。
    Count one "busy, retry" answer. Safe on the event loop: memory only, flushed to shared
    state at most every 30 s, in a thread."""
    global _pending_last, _flushed_at
    now = time.time()
    with _lock:
        _pending[kind] = _pending.get(kind, 0) + 1
        _pending_last = (now, kind)
        if now - _flushed_at < FLUSH_EVERY:
            return
        _flushed_at = now
    try:
        asyncio.get_running_loop().run_in_executor(None, flush_overload)
    except RuntimeError:     # 不在事件循环里（同步端点的线程）/ not on the loop
        flush_overload()


def flush_overload() -> None:
    """把本进程攒下的过载计数刷进共享存储。永不抛异常。/ Flush this process's counts; never raises."""
    global _pending_last
    with _lock:
        counts = dict(_pending)
        last = _pending_last
        _pending.clear()
        _pending_last = None
    if not counts:
        return
    try:
        total = sum(counts.values())
        day = _day(last[0] if last else None)
        shared_state.incr_with_ttl(_OVERLOAD_COUNT_KEY + day, PEAK_TTL, refresh=True, by=total)
        if last is not None:
            prev = shared_state.kv_get_json(_OVERLOAD_LAST_KEY) or {}
            if float(prev.get("at") or 0) <= last[0]:
                shared_state.kv_set_json(_OVERLOAD_LAST_KEY, {"at": last[0], "kind": last[1]}, ttl=PEAK_TTL)
    except Exception:  # noqa: BLE001 —— 统计写不进去不影响业务 / stats must never hurt the request path
        logger.debug("capacity overload flush failed", exc_info=True)


# ---------- 峰值采样 / peak sampling ----------
def record_sample(users: int | None, bridges: int | None, gateway_users: int | None,
                  now: float | None = None) -> dict:
    """把这一次采样并进当天的峰值（每项各自取最大，并记下各自出现的时刻）。返回当天的峰值。
    Merge one sample into today's peaks (each metric keeps its own max and when it happened)."""
    now = time.time() if now is None else now
    key = _PEAK_KEY + _day(now)
    peak = shared_state.kv_get_json(key) or {}
    changed = False
    for name, value in (("users", users), ("bridges", bridges), ("gatewayUsers", gateway_users)):
        if value is None:
            continue
        if int(value) > int(peak.get(name) or 0) or name not in peak:
            peak[name] = int(value)
            peak[name + "At"] = now
            changed = True
    if changed:
        shared_state.kv_set_json(key, peak, ttl=PEAK_TTL)
    return peak


def count_online(user_ids: list[str], session_factory=None) -> tuple[int, int]:
    """在线桥接账号数、在线的网关直连用户数（开着网页、名下有有效网关账号的人）。同步，查两条 SQL。
    Online bridge accounts, and online people holding a live gateway account. Blocking."""
    from sqlalchemy import func

    from app.models import MT5Account
    from app.services.deps import ONLINE_WINDOW

    if session_factory is None:
        from app.core.database import SessionLocal as session_factory
    db = session_factory()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=ONLINE_WINDOW)
        bridges = (
            db.query(func.count(MT5Account.id))
            .filter(MT5Account.source != "gateway", MT5Account.last_heartbeat >= cutoff)
            .scalar()
        ) or 0
        gateway_users = 0
        for i in range(0, len(user_ids), 500):
            chunk = user_ids[i:i + 500]
            gateway_users += (
                db.query(func.count(func.distinct(MT5Account.user_id)))
                .filter(MT5Account.source == "gateway", MT5Account.revoked_at.is_(None),
                        MT5Account.user_id.in_(chunk))
                .scalar()
            ) or 0
        return int(bridges), int(gateway_users)
    finally:
        db.close()


async def sample_once() -> dict:
    """量一次当前在线并记峰值。/ Measure current online once and record the peaks."""
    from starlette.concurrency import run_in_threadpool

    from app.services.connection_manager import manager

    users = await manager.connected_user_ids_async()
    bridges, gateway_users = await run_in_threadpool(count_online, list(users))
    return await run_in_threadpool(record_sample, len(users), bridges, gateway_users)


async def capacity_loop(startup_delay: float = 60.0) -> None:
    """领导 worker 上每分钟采一次在线峰值。/ Per-minute peak sampling on the leader."""
    await asyncio.sleep(startup_delay)      # 首个 await 前零阻塞（main.py lifespan 的约束）
    from starlette.concurrency import run_in_threadpool

    from app.services import loop_health

    while True:
        loop_health.beat("capacity")
        try:
            await sample_once()
            await run_in_threadpool(flush_overload)
        except Exception:
            logger.exception("capacity sample failed")
        await asyncio.sleep(SAMPLE_INTERVAL)


# ---------- 读与判定 / read and verdict ----------
def read_history(now: float | None = None) -> dict:
    """今天与近 7 天的峰值、近 7 天过载次数与最近一次。/ Today's and 7-day peaks plus overloads."""
    now = time.time() if now is None else now
    today = shared_state.kv_get_json(_PEAK_KEY + _day(now)) or {}
    week: dict = {}
    overload_7d = 0
    for d in range(7):
        ts = now - d * 86400
        p = shared_state.kv_get_json(_PEAK_KEY + _day(ts)) or {}
        for name in ("users", "bridges", "gatewayUsers"):
            v = p.get(name)
            if v is not None and int(v) >= int(week.get(name) or -1):
                week[name] = int(v)
                week[name + "At"] = p.get(name + "At")
        raw = shared_state.kv_get(_OVERLOAD_COUNT_KEY + _day(ts))
        overload_7d += int(raw or 0)
    last = shared_state.kv_get_json(_OVERLOAD_LAST_KEY) or {}
    last_at = last.get("at")
    return {
        "peakToday": today,
        "peak7d": week,
        "overload7d": overload_7d,
        "overloadLastAgoSec": int(now - float(last_at)) if last_at else None,
        "overloadLastKind": last.get("kind"),
    }


def _grade(value: int | None, limits: tuple[int, int]) -> str:
    if value is None:
        return OK
    if value >= limits[1]:
        return DOWN
    if value >= limits[0]:
        return WARN
    return OK


def evaluate(current: dict, history: dict) -> dict:
    """定级 + 理由 + 该升级什么。按「近 7 天峰值」与「当前」里大的那个判，峰值才是规划依据。
    Level, reasons and what to upgrade, judged on the larger of the 7-day peak and now."""
    week = history.get("peak7d") or {}
    reasons: list[dict] = []
    advice: list[str] = []
    level = OK

    def raise_(lv: str, code: str, value, limit, *codes: str) -> None:
        nonlocal level
        reasons.append({"code": code, "level": lv, "value": value, "limit": limit})
        for c in codes:
            if c not in advice:
                advice.append(c)
        if lv == DOWN or (lv == WARN and level == OK):
            level = lv

    def worst(name: str) -> int | None:
        vals = [v for v in (current.get(name), week.get(name)) if v is not None]
        return max(vals) if vals else None

    users = worst("users")
    lv = _grade(users, WEB_USERS)
    if lv != OK:
        limit = WEB_USERS[1] if lv == DOWN else WEB_USERS[0]
        raise_(lv, "webUsers", users, limit, ADVICE_SERVER, ADVICE_DATABASE)

    gw = worst("gatewayUsers")
    lv = _grade(gw, GATEWAY_USERS)
    if lv != OK:
        limit = GATEWAY_USERS[1] if lv == DOWN else GATEWAY_USERS[0]
        raise_(lv, "gatewayUsers", gw, limit, ADVICE_GATEWAY, ADVICE_SERVER)

    br = worst("bridges")
    lv = _grade(br, BRIDGES)
    if lv != OK:
        limit = BRIDGES[1] if lv == DOWN else BRIDGES[0]
        raise_(lv, "bridges", br, limit, ADVICE_SERVER, ADVICE_BRIDGE)

    ago = history.get("overloadLastAgoSec")
    if ago is not None and ago < OVERLOAD_WARN_SEC:
        lv = DOWN if ago < OVERLOAD_RED_SEC else WARN
        raise_(lv, "overload", history.get("overload7d"), None, ADVICE_SURGE, ADVICE_SERVER)

    return {"level": level, "reasons": reasons, "advice": advice}


def thresholds() -> dict:
    return {"webUsers": list(WEB_USERS), "bridges": list(BRIDGES), "gatewayUsers": list(GATEWAY_USERS)}
