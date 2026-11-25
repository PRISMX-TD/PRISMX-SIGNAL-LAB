"""图表警报的求值与触发。
Chart alert evaluation and firing.

两个入口，都挂在 routers/chart.py 的 EA 上报接口上：
  · on_quotes(changed)：每批全站报价（只含变了的品种）。价格 / 画线警报（触发方式 once、bar）在这里
    逐跳判，用 Bid——图表 K 线也是 Bid。
  · on_bars_closed(symbol, interval, new_ts)：某周期有新 K 线收盘落库。收盘类（trigger = close）、指标
    警报、按幅度移动在这里判。

缓存：所有 active 警报按品种放在本进程内存里，只在「版本号变了」时整表重读（接口每次写都 bump；配了
REDIS_URL 时版本号放在 Redis，别的 worker 也看得到），外加每 10 分钟兜底重读一次。不按时间轮询整表——
Supabase 出站流量曾是最大开销。

上一跳的值（判穿越要用）按 (警报 id, seq) 记在内存。没有上一跳时：如果建 / 改警报之后还没触发过，用
前端传来的 ref（建 / 改那一刻的价格）当上一跳，免得刚建好就穿过去的那一下漏掉；否则这一跳只记下来。

触发：按 (id, seq, status='active') 条件 UPDATE，抢到的才发通知——多个 worker 各自判中同一次穿越也只
通知一次。通知走四条路：WS（图表闪一下、弹提示）、站内通知、App 推送（总开关 / 推送时段 / 等级照常）、
邮件（逐条勾选，邮箱已验证，每人每天最多 EMAIL_DAILY_CAP 封）。

Two entry points, both on the EA feed endpoints in routers/chart.py: on_quotes for every batch of
changed quotes (price / drawing alerts with trigger once or bar, judged on the bid, which is what the
chart's bars are), and on_bars_closed when new bars are persisted (trigger close, indicator alerts,
moving-by). Active alerts are cached per symbol in memory and reloaded only when the version moves
(every API write bumps it; in Redis when configured) plus a 10-minute safety reload — never polling
the table, Supabase egress having been the top cost. The previous value needed for crossings is kept
per (alert id, seq); without one, the client's ref price at create / edit time stands in if the alert
hasn't fired since, otherwise the tick is just recorded. A fire is a conditional UPDATE on
(id, seq, status='active'), so workers judging the same crossing notify once. Notifications go out
over WS, the in-app feed, app push (master switch / window / plan apply) and email (per alert,
verified address, at most EMAIL_DAILY_CAP a day).
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from html import escape
from typing import Any

from starlette.concurrency import run_in_threadpool

from app.services import shared_state
from app.services.chart_alerts import conds as C
from app.services.chart_alerts import ind as IND

logger = logging.getLogger("prismx.chart_alerts")

WS_FIRED = "CHART_ALERT_FIRED"
WS_UPDATE = "CHART_ALERTS_UPDATE"
LOG_KEEP = 300
EMAIL_DAILY_CAP = 20
SAFETY_RELOAD_SECONDS = 600.0
_VER_KEY = "chart_alerts:ver"
_VER_TTL_LOCAL = 2.0
BARS_CACHE_MAX = 1600


@dataclass
class Rec:
    id: str
    user_id: str
    symbol: str
    kind: str
    cond: str
    spec: dict
    trigger: str
    interval: str
    message: str
    push: bool
    email: bool
    expires_at: float | None
    seq: int
    last_fired_at: float | None
    updated_at: float
    extra: dict = field(default_factory=dict)

    @property
    def on_close(self) -> bool:
        return self.trigger == "close" or self.kind == "indicator" or self.cond in C.CONDS_MOVE


# ───────── 缓存 / cache ─────────
_by_symbol: dict[str, list[Rec]] = {}
_loaded_ver: str | None = None
_loaded_at = float("-inf")
_local_ver = 0
_ver_cache: tuple[str, float] | None = None
_reload_lock: asyncio.Lock | None = None
_prev: dict[tuple[str, int], tuple] = {}
_inflight: set[str] = set()
_tasks: set[asyncio.Task] = set()
_bars: dict[tuple[str, str], list[dict]] = {}


def reset_for_tests() -> None:
    global _loaded_ver, _loaded_at, _local_ver, _ver_cache, _reload_lock
    _by_symbol.clear()
    _prev.clear()
    _inflight.clear()
    _bars.clear()
    _loaded_ver, _loaded_at, _local_ver, _ver_cache, _reload_lock = None, float("-inf"), 0, None, None


def _ts(dt: datetime | None) -> float | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def bump() -> None:
    """警报表有写入：让所有 worker 下一跳重读。失败只记日志（10 分钟兜底）。
    The table changed: every worker reloads on its next tick. Failures only log."""
    global _local_ver, _ver_cache
    _local_ver += 1
    _ver_cache = None
    if shared_state.enabled():
        try:
            shared_state.kv_set(_VER_KEY, uuid.uuid4().hex, ttl=30 * 86400)
        except Exception:  # noqa: BLE001
            logger.warning("chart alert version bump failed", exc_info=True)


def _version_sync() -> str:
    global _ver_cache
    if not shared_state.enabled():
        return f"L{_local_ver}"
    now = time.monotonic()
    if _ver_cache is not None and now - _ver_cache[1] < _VER_TTL_LOCAL:
        return _ver_cache[0]
    try:
        v = shared_state.kv_get(_VER_KEY) or "0"
    except Exception:  # noqa: BLE001
        v = f"err{int(now)}"
    v = f"{v}:L{_local_ver}"
    _ver_cache = (v, now)
    return v


def _rec_of(row) -> Rec | None:
    try:
        spec = json.loads(row.spec or "{}")
    except (TypeError, ValueError):
        return None
    return Rec(
        id=row.id, user_id=row.user_id, symbol=row.symbol.upper(), kind=row.kind, cond=row.cond, spec=spec,
        trigger=row.trigger, interval=row.interval, message=row.message or "", push=bool(row.notify_push),
        email=bool(row.notify_email), expires_at=_ts(row.expires_at), seq=int(row.seq or 0),
        last_fired_at=_ts(row.last_fired_at), updated_at=_ts(row.updated_at) or 0.0,
    )


def _reload_sync() -> dict[str, list[Rec]]:
    from app.core.database import SessionLocal
    from app.models import ChartAlert

    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        n = (
            db.query(ChartAlert)
            .filter(ChartAlert.status == "active", ChartAlert.expires_at.isnot(None), ChartAlert.expires_at < now)
            .update({"status": "expired"}, synchronize_session=False)
        )
        if n:
            db.commit()
        rows = db.query(ChartAlert).filter(ChartAlert.status == "active").all()
        out: dict[str, list[Rec]] = {}
        for row in rows:
            rec = _rec_of(row)
            if rec is not None:
                out.setdefault(rec.symbol, []).append(rec)
        return out
    finally:
        db.close()


async def ensure_loaded(force: bool = False) -> None:
    global _by_symbol, _loaded_ver, _loaded_at, _reload_lock
    ver = _version_sync() if not shared_state.enabled() else await run_in_threadpool(_version_sync)
    fresh = ver == _loaded_ver and time.monotonic() - _loaded_at < SAFETY_RELOAD_SECONDS
    if fresh and not force:
        return
    if _reload_lock is None:
        _reload_lock = asyncio.Lock()
    async with _reload_lock:
        if not force and ver == _loaded_ver and time.monotonic() - _loaded_at < SAFETY_RELOAD_SECONDS:
            return
        data = await run_in_threadpool(_reload_sync)
        _by_symbol = data
        _loaded_ver, _loaded_at = ver, time.monotonic()
        live = {(r.id, r.seq) for recs in data.values() for r in recs}
        for k in [k for k in _prev if k not in live]:
            _prev.pop(k, None)


# ───────── 时间 / time ─────────

def broker_offset(t: float) -> int:
    """券商服务器时区（GMT+2，美国夏令时期间 GMT+3），同前端 intervals.brokerOffsetSec。
    Broker server offset (GMT+2, GMT+3 during US DST), like the frontend's brokerOffsetSec."""
    y = datetime.fromtimestamp(t, timezone.utc).year
    mar1 = datetime(y, 3, 1, tzinfo=timezone.utc)
    nov1 = datetime(y, 11, 1, tzinfo=timezone.utc)
    # JS getUTCDay：周日 = 0；Python weekday：周一 = 0 / JS Sunday=0, Python Monday=0
    mar_dow = (mar1.weekday() + 1) % 7
    nov_dow = (nov1.weekday() + 1) % 7
    start = datetime(y, 3, 1 + (7 - mar_dow) % 7 + 7, 7, tzinfo=timezone.utc).timestamp()
    end = datetime(y, 11, 1 + (7 - nov_dow) % 7, 6, tzinfo=timezone.utc).timestamp()
    return 3 * 3600 if start <= t < end else 2 * 3600


def bar_start(interval: str, t: float) -> float:
    """t 所在这根 K 线的开盘时间（按券商时间分桶）。/ open time of the bar containing t."""
    sec = C.INTERVAL_SECONDS.get(interval, 900)
    off = broker_offset(t)
    b = t + off
    return b - (b % sec) - off


# ───────── 逐跳 / per tick ─────────

def _level_now(r: Rec, t: float) -> tuple[Any, bool]:
    """(B 的值或通道, 是否可判)。画线不在范围内时不可判。/ (B value or band, judgeable)."""
    s = r.spec
    if r.kind == "price":
        if r.cond in C.CONDS_CHANNEL:
            return (s["lo"], s["hi"]), True
        return s["level"], True
    win = s.get("win")
    if win and not win[0] <= t <= win[1]:
        return None, False
    lines = s.get("lines") or []
    if r.cond in C.CONDS_CHANNEL:
        band = C.band_of(C.line_value(lines[0], t, r.symbol), C.line_value(lines[1], t, r.symbol))
        return band, band is not None
    v = C.line_value(lines[0], t, r.symbol)
    return v, v is not None


def eval_tick(r: Rec, price: float, now: float) -> bool:
    """这一跳是否触发（不改库）。纯内存，给 on_quotes 和测试用。
    Whether this tick fires (no DB). Pure memory, for on_quotes and tests."""
    if r.expires_at is not None and now > r.expires_at:
        return False
    key = (r.id, r.seq)
    b, ok = _level_now(r, now)
    if not ok:
        _prev.pop(key, None)
        return False
    prev = _prev.get(key)
    if prev is None:
        ref = r.spec.get("ref")
        if ref and (r.last_fired_at is None or r.last_fired_at < r.updated_at):
            prev = (ref, b)
    _prev[key] = (price, b)
    a0, b0 = (prev if prev else (None, None))
    if r.cond in C.CONDS_CHANNEL:
        hit = C.check_channel(r.cond, a0, b0, price, b)
    else:
        hit = C.check_line(r.cond, a0, b0, price, b)
    if hit and r.trigger == "bar" and r.last_fired_at is not None:
        if bar_start(r.interval, r.last_fired_at) >= bar_start(r.interval, now):
            return False
    return hit


async def on_quotes(changed: list[dict]) -> None:
    """一批变了的报价。绝不抛：警报出错不能拖垮报价入口。
    A batch of changed quotes. Never raises: alerts must not break the quote feed."""
    if not changed:
        return
    try:
        await ensure_loaded()
        if not _by_symbol:
            return
        now = time.time()
        hits: list[tuple[Rec, float, float]] = []
        for q in changed:
            if q.get("closed"):
                continue
            recs = _by_symbol.get(str(q.get("symbol") or "").upper())
            bid = q.get("bid")
            if not recs or not isinstance(bid, (int, float)) or not math.isfinite(bid) or bid <= 0:
                continue
            for r in list(recs):
                if r.on_close or r.id in _inflight:
                    continue
                if eval_tick(r, float(bid), now):
                    hits.append((r, float(bid), now))
        _spawn_fires(hits)
    except Exception:  # noqa: BLE001
        logger.exception("chart alerts on_quotes failed")


def _spawn(coro) -> None:
    task = asyncio.get_running_loop().create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def _spawn_fires(hits: list[tuple[Rec, float, float]]) -> None:
    """同一批命中的警报放进一个任务里依次触发：收盘那一刻可能一下命中很多条，逐条走完不会
    一下子占满线程池 / 连接池。入队时就标成「进行中」，排队期间的下一跳不会重复命中。
    Fire one batch of hits sequentially in a single task: a bar close can hit many at once, and
    going one by one never floods the thread / connection pool. Marked in-flight on enqueue so
    ticks arriving while they wait don't hit them again."""
    hits = [h for h in hits if h[0].id not in _inflight]
    if not hits:
        return
    for r, _, _ in hits:
        _inflight.add(r.id)
    _spawn(_fire_batch(hits))


async def _fire_batch(hits: list[tuple[Rec, float, float]]) -> None:
    for r, price, now in hits:
        try:
            await _fire(r, price, now)
        except Exception:  # noqa: BLE001 —— 一条失败不拖累后面的 / one failure must not stop the rest
            logger.exception("chart alert %s fire failed", r.id)
        finally:
            _inflight.discard(r.id)


# ───────── 收盘 / at bar close ─────────

def _bars_sync(symbol: str, interval: str, need: int) -> list[dict]:
    """该序列最近的已收盘 K 线（升序）。本进程缓存一份，之后只查比缓存更新的行。
    Recent closed bars, ascending. Cached per process; later calls fetch only newer rows."""
    from app.core.database import SessionLocal
    from app.models import Candle

    key = (symbol, interval)
    cached = _bars.get(key)
    db = SessionLocal()
    try:
        cols = (Candle.t, Candle.o, Candle.h, Candle.l, Candle.c, Candle.v)
        if cached is not None and len(cached) >= min(need, 50):
            rows = (
                db.query(*cols).filter(Candle.symbol == symbol, Candle.interval == interval, Candle.t > cached[-1]["t"])
                .order_by(Candle.t.asc()).limit(BARS_CACHE_MAX).all()
            )
            cached.extend({"t": r[0], "o": r[1], "h": r[2], "l": r[3], "c": r[4], "v": r[5] or 0} for r in rows)
        if cached is None or len(cached) < need:
            rows = (
                db.query(*cols).filter(Candle.symbol == symbol, Candle.interval == interval)
                .order_by(Candle.t.desc()).limit(max(need, 300)).all()
            )
            rows.reverse()
            cached = [{"t": r[0], "o": r[1], "h": r[2], "l": r[3], "c": r[4], "v": r[5] or 0} for r in rows]
        if len(cached) > BARS_CACHE_MAX:
            del cached[: len(cached) - BARS_CACHE_MAX]
        _bars[key] = cached
        return cached
    finally:
        db.close()


def eval_close(r: Rec, bars: list[dict]) -> bool:
    """最新一根收盘时是否触发。/ whether the latest close fires."""
    if len(bars) < 2:
        return False
    s = r.spec
    t0, t1 = bars[-2]["t"], bars[-1]["t"]
    closes = [b["c"] for b in bars]
    if r.kind == "indicator":
        ind = s["ind"]
        a = IND.series(ind["type"], ind["inputs"], ind["plot"], bars)
    else:
        a = closes
    a0, a1 = a[-2], a[-1]
    if a1 is None:
        return False
    if r.cond in C.CONDS_MOVE:
        n = int(s["bars"])
        past = a[-1 - n] if len(a) > n else None
        return C.check_move(r.cond, past, a1, float(s["value"]))
    if r.kind == "price":
        if r.cond in C.CONDS_CHANNEL:
            band = (s["lo"], s["hi"])
            return C.check_channel(r.cond, a0, band, a1, band)
        return C.check_line(r.cond, a0, s["level"], a1, s["level"])
    if r.kind == "drawing":
        win = s.get("win")
        if win and not win[0] <= t1 <= win[1]:
            return False
        lines = s["lines"]
        if r.cond in C.CONDS_CHANNEL:
            b0 = C.band_of(C.line_value(lines[0], t0, r.symbol), C.line_value(lines[1], t0, r.symbol))
            b1 = C.band_of(C.line_value(lines[0], t1, r.symbol), C.line_value(lines[1], t1, r.symbol))
            return b1 is not None and C.check_channel(r.cond, a0, b0, a1, b1)
        v0, v1 = C.line_value(lines[0], t0, r.symbol), C.line_value(lines[0], t1, r.symbol)
        return v1 is not None and C.check_line(r.cond, a0, v0, a1, v1)
    target = s["target"]
    tk = target["kind"]
    if tk == "band":
        band = (target["lo"], target["hi"])
        return C.check_channel(r.cond, a0, band, a1, band)
    if tk == "value":
        return C.check_line(r.cond, a0, target["v"], a1, target["v"])
    if tk == "price":
        b = closes
    else:
        b = IND.series(s["ind"]["type"], s["ind"]["inputs"], target["plot"], bars)
    if b[-1] is None:
        return False
    return C.check_line(r.cond, a0, b[-2], a1, b[-1])


def _need_bars(r: Rec) -> int:
    n = 3
    if r.cond in C.CONDS_MOVE:
        n = max(n, int(r.spec.get("bars", 1)) + 2)
    if r.kind == "indicator":
        ind = r.spec["ind"]
        n = max(n, IND.warmup(ind["type"], ind["inputs"]))
    return n


async def on_bars_closed(symbol: str, interval: str, new_ts: list[int] | None) -> None:
    """某 (品种, 周期) 有新收盘 K 线落库。只判最新那根，而且得是刚收的（补历史时不触发）。绝不抛。
    New closed bars for a series. Only the newest one counts, and only if it just closed (backfills
    don't fire). Never raises."""
    if not new_ts:
        return
    try:
        await ensure_loaded()
        sym = symbol.upper()
        recs = [r for r in _by_symbol.get(sym, []) if r.on_close and r.interval == interval and r.id not in _inflight]
        if not recs:
            return
        sec = C.INTERVAL_SECONDS.get(interval, 900)
        now = time.time()
        latest = max(new_ts)
        if latest + sec < now - 2 * sec:
            return
        need = max(_need_bars(r) for r in recs)
        bars = await run_in_threadpool(_bars_sync, sym, interval, need)
        if not bars or bars[-1]["t"] != latest:
            return
        hits: list[tuple[Rec, float, float]] = []
        for r in recs:
            if r.expires_at is not None and now > r.expires_at:
                continue
            try:
                hit = eval_close(r, bars)
            except Exception:  # noqa: BLE001 —— 一条坏警报不拖累别的 / one bad alert must not stop the rest
                logger.exception("chart alert %s close eval failed", r.id)
                continue
            if hit:
                hits.append((r, float(bars[-1]["c"]), now))
        _spawn_fires(hits)
    except Exception:  # noqa: BLE001
        logger.exception("chart alerts on_bars_closed failed")


# ───────── 触发 / firing ─────────

def _fire_sync(r: Rec, price: float, now: float) -> dict | None:
    from app.core.database import SessionLocal
    from app.models import ChartAlert, ChartAlertLog, User
    from app.services.notification_feed import KIND_CHART_ALERT, create_notification

    db = SessionLocal()
    try:
        fired = datetime.fromtimestamp(now, timezone.utc)
        status = "fired" if r.trigger == "once" else "active"
        n = (
            db.query(ChartAlert)
            .filter(ChartAlert.id == r.id, ChartAlert.seq == r.seq, ChartAlert.status == "active")
            .update(
                {"seq": ChartAlert.seq + 1, "fire_count": ChartAlert.fire_count + 1, "last_fired_at": fired, "status": status},
                synchronize_session=False,
            )
        )
        if n == 0:
            db.rollback()
            return None
        email_to = None
        if r.email:
            row = db.query(User.email, User.email_verified_at, User.disabled_at).filter(User.id == r.user_id).first()
            if row and row[0] and row[1] is not None and row[2] is None:
                sent = (
                    db.query(ChartAlertLog.id)
                    .filter(ChartAlertLog.user_id == r.user_id, ChartAlertLog.emailed.is_(True),
                            ChartAlertLog.fired_at >= fired - timedelta(days=1))
                    .count()
                )
                if sent < EMAIL_DAILY_CAP:
                    email_to = row[0]
        db.add(ChartAlertLog(user_id=r.user_id, alert_id=r.id, symbol=r.symbol, price=price,
                             message=r.message[:200], emailed=email_to is not None, fired_at=fired))
        create_notification(db, r.user_id, KIND_CHART_ALERT, text=r.message, link=f"/charts?symbol={r.symbol}", ref_id=r.id)
        db.commit()
        old = (
            db.query(ChartAlertLog.id).filter(ChartAlertLog.user_id == r.user_id)
            .order_by(ChartAlertLog.fired_at.desc()).offset(LOG_KEEP).limit(200).all()
        )
        if old:
            db.query(ChartAlertLog).filter(ChartAlertLog.id.in_([o[0] for o in old])).delete(synchronize_session=False)
            db.commit()
        return {"seq": r.seq + 1, "status": status, "email_to": email_to, "fired": fired}
    except Exception:
        db.rollback()
        logger.exception("chart alert %s fire failed", r.id)
        return None
    finally:
        db.close()


def _fmt(price: float, digits: int | None) -> str:
    d = digits if isinstance(digits, int) and 0 <= digits <= 10 else 5
    return f"{price:.{d}f}"


def _email_sync(to: str, r: Rec, price: str, fired: datetime) -> None:
    from app.core.config import settings
    from app.services import email_signature, mailer

    try:
        sig_html, sig_text = email_signature.render()
    except Exception:  # noqa: BLE001
        sig_html, sig_text = "", ""
    when = fired.strftime("%Y-%m-%d %H:%M:%S UTC")
    base = (settings.PUBLIC_WEB_URL or "").rstrip("/")
    link = f"{base}/charts?symbol={r.symbol}" if base else ""
    msg = r.message or r.symbol
    html = (
        f"<div style=\"font-family:system-ui,sans-serif;max-width:720px\">"
        f"<h2 style=\"margin:0 0 12px\">{escape(msg)}</h2>"
        f"<p style=\"margin:0 0 6px\">{escape(r.symbol)} · {escape(price)}</p>"
        f"<p style=\"margin:0 0 16px;color:#666\">{escape(when)}</p>"
        + (f"<p><a href=\"{escape(link)}\">打开图表 / Open chart</a></p>" if link else "")
        + f"{sig_html}</div>"
    )
    text = f"{msg}\n{r.symbol} · {price}\n{when}\n" + (f"{link}\n" if link else "") + sig_text
    mailer.send_email(to, f"[{r.symbol}] {msg}"[:180], html, text)


async def _fire(r: Rec, price: float, now: float) -> None:
    """触发一条（调用方负责 _inflight）。/ Fire one alert (the caller owns _inflight)."""
    res = await run_in_threadpool(_fire_sync, r, price, now)
    if res is None:
        # 别处已改过 / 已触发：下次重读 / changed elsewhere: reload next time
        bump()
        return
    old_key = (r.id, r.seq)
    r.seq = res["seq"]
    r.last_fired_at = now
    if old_key in _prev:
        _prev[(r.id, r.seq)] = _prev.pop(old_key)
    if res["status"] != "active":
        recs = _by_symbol.get(r.symbol)
        if recs and r in recs:
            recs.remove(r)
    bump()
    await _notify(r, price, res)


async def _notify(r: Rec, price: float, res: dict) -> None:
    from app.services import push_dispatch, quotes_store
    from app.services.connection_manager import manager

    digits = None
    try:
        digits = quotes_store.get_digits(r.symbol) if not shared_state.enabled() else await run_in_threadpool(quotes_store.get_digits, r.symbol)
    except Exception:  # noqa: BLE001
        digits = None
    p = _fmt(price, digits)
    fired_iso = res["fired"].astimezone(timezone.utc).replace(tzinfo=None).isoformat(timespec="milliseconds") + "Z"
    payload = {"id": r.id, "symbol": r.symbol, "price": price, "message": r.message, "firedAt": fired_iso, "status": res["status"]}
    for msg in ({"type": WS_FIRED, "data": payload}, {"type": WS_UPDATE, "data": {}}, {"type": "NOTIFICATION_NEW", "data": {}}):
        try:
            await manager.push_to_client(r.user_id, msg)
        except Exception:  # noqa: BLE001
            logger.warning("chart alert WS push failed", exc_info=True)
    if r.push:
        title = f"{r.symbol} {p}"
        body = r.message or r.symbol
        url = f"/charts?symbol={r.symbol}"
        try:
            await run_in_threadpool(push_dispatch.dispatch_users_push, [r.user_id], push_dispatch.EVENT_CHART_ALERT,
                                    title, body, url, f"prismx-alert-{r.id}")
        except Exception:  # noqa: BLE001
            logger.warning("chart alert push failed", exc_info=True)
    if res.get("email_to"):
        try:
            await run_in_threadpool(_email_sync, res["email_to"], r, p, res["fired"])
        except Exception:  # noqa: BLE001
            logger.warning("chart alert email failed", exc_info=True)
