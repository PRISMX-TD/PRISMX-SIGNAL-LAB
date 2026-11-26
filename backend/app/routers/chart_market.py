"""图表阶段 6 的行情读接口（2026-11-27）：按时间范围 / 多品种批量取 K 线、交易时段、品种规格、日内涨跌基准。
Chart phase-6 market-data reads: candles by time range and for several symbols at once, trading
sessions, symbol spec and day-change references.

  GET /chart/range?symbol&interval&from&to&limit  → {symbol, interval, bars, truncated, earliest}
  GET /chart/batch?symbols=A,B&interval&limit     → {interval, series: {SYM: {bars, hasMore}}}
  GET /chart/sessions?symbol                      → {symbol, known, openNow, holiday, nextOpenAt,
                                                     serverUtcOffsetSec, sessions, source}
  GET /chart/spec?symbol                          → ChartSymbolSpec（拿不到的字段为 null）
  GET /chart/day-refs                             → {items: {SYM: {open, prevClose, t}}}

K 线都读 candles 表（只有已收盘的 bar），形状与 /chart/history 完全一样；仍在形成的那根照旧由
/chart/latest 给。所有查询都走唯一约束 (symbol, interval, t) 的索引。

Candles come from the candles table (closed bars only), shaped exactly like /chart/history; the
forming bar still comes from /chart/latest. Every query uses the (symbol, interval, t) unique index.
"""
from __future__ import annotations

import logging
import math
import re
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select, union_all
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import get_db
from app.core.strategy_limits import user_limiter
from app.models import Candle, MT5Account
from app.routers import chart as chart_router
from app.services import chart_store, gateway_client, market_hours, quotes_store, shared_cache
# 服务端兜底的合约规模表与外汇判定，和收盘交易核对用的是同一张。
# Server-side contract-size table and FX test, shared with the closed-trade plausibility check.
from app.services.closed_trade_store import _CONTRACT_SIZE, _FX_CONTRACT_SIZE, _base_symbol, _is_fx
from app.services.connection_manager import manager
from app.services.deps import get_current_user_id_light
from app.services.gateway_binding import not_removed
from app.services.symbol_aliases import broker_symbol, lot_step, min_lot

logger = logging.getLogger("prismx.chart_market")

router = APIRouter(tags=["chart"])

ALLOWED_INTERVALS = chart_router.ALLOWED_INTERVALS

# ---- /chart/range ----
RANGE_MAX_LIMIT = 5000
RANGE_RATE_LIMIT = "60/minute"
# from / to 的跨度上限：只是挡掉胡乱的参数（结果条数另由 limit 封顶）。100 年，from=0 到现在也放行
# （「to 之前最新的 limit 根」是合法用法）。
# Span sanity cap; the row count is bounded separately by limit. 100 years, so from=0 up to now
# ("the newest `limit` bars before `to`") still passes.
RANGE_MAX_SPAN_SECONDS = 100 * 366 * 86400
_EARLIEST_TTL = 300

# ---- /chart/batch ----
BATCH_MAX_SYMBOLS = 8
BATCH_DEFAULT_LIMIT = 500
BATCH_RATE_LIMIT = chart_router.CHART_HISTORY_RATE_LIMIT

# ---- /chart/sessions ----
SESSIONS_RATE_LIMIT = "60/minute"
_SESSIONS_TTL = 60
# 网关不可达时的结果只缓存一小会儿，网关回来后很快能拿到真时段。
# An unreachable-gateway result is cached briefly so real sessions show soon after it recovers.
_SESSIONS_FAIL_TTL = 15

# ---- /chart/spec ----
SPEC_RATE_LIMIT = "60/minute"

# ---- /chart/day-refs ----
DAY_REFS_RATE_LIMIT = "30/minute"
_DAY_REFS_TTL = 60
_DAY_REFS_KEY = "chart:day_refs"
# 只看最近这么多天的日线：够跨过长假，又让查询只扫每个品种最近十几行。
# Only daily bars from the last N days: spans long holidays while each symbol scans a dozen rows.
_DAY_REFS_LOOKBACK_SECONDS = 21 * 86400

# 品种名：与 /chart/history 一样转大写；字符集同画线（券商后缀 .m / # 等）。
# Symbols are upper-cased like /chart/history; same character set as drawings.
_SYMBOL_RE = re.compile(r"^[A-Z0-9._#-]{1,32}$")


def _check_symbol(symbol: str) -> str:
    sym = (symbol or "").strip().upper()
    if not _SYMBOL_RE.match(sym):
        raise HTTPException(status_code=400, detail="品种名无效 / invalid symbol")
    return sym


def _check_interval(interval: str) -> str:
    if interval not in ALLOWED_INTERVALS:
        raise HTTPException(status_code=400, detail="bad interval")
    return interval


def _bar(r) -> dict:
    return {"t": r[0], "o": r[1], "h": r[2], "l": r[3], "c": r[4], "v": r[5]}


# ================================================================ /chart/range

def _earliest(db: Session, sym: str, interval: str) -> int | None:
    """该品种该周期最早一根的时间，缓存 5 分钟。MIN(t) 走 (symbol, interval, t) 索引，一次索引探查。
    包一层 {"e": ...}：None（没数据）也要能命中缓存。
    Earliest stored bar time, cached 5 min. MIN(t) is a single probe of the (symbol, interval, t)
    index. Wrapped in {"e": ...} so a None result still caches."""
    def _load() -> dict:
        v = (
            db.query(func.min(Candle.t))
            .filter(Candle.symbol == sym, Candle.interval == interval)
            .scalar()
        )
        return {"e": int(v) if v is not None else None}

    return shared_cache.cached_json(f"chart:earliest:{sym}:{interval}", _EARLIEST_TTL, _load).get("e")


@router.get("/chart/range")
@user_limiter.limit(RANGE_RATE_LIMIT)
def chart_range(
    request: Request,
    symbol: str = Query(max_length=32),
    interval: str = Query(),
    from_: int = Query(alias="from", ge=0, le=2**40),
    to: int = Query(ge=0, le=2**40),
    limit: int = Query(default=RANGE_MAX_LIMIT, ge=1, le=RANGE_MAX_LIMIT),
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """[from, to]（含两端，unix 秒）内的已收盘 K 线，升序。超过 limit 根时保留**最新**的 limit 根并
    truncated=true（倒序取 limit+1 根再翻回正序，多取的那一根只用来判断截断）。回放 / 跳转日期用。
    Closed bars in [from, to] inclusive, ascending. Beyond limit the newest `limit` are kept and
    truncated=true (fetch limit+1 descending, reverse; the extra row only signals truncation).
    A plain def: the blocking query runs on the thread pool."""
    sym = _check_symbol(symbol)
    _check_interval(interval)
    if from_ > to:
        raise HTTPException(status_code=400, detail="from 不能晚于 to / from must not be after to")
    if to - from_ > RANGE_MAX_SPAN_SECONDS:
        raise HTTPException(status_code=400, detail="时间范围过大 / time range too large")
    rows = (
        db.query(Candle.t, Candle.o, Candle.h, Candle.l, Candle.c, Candle.v)
        .filter(Candle.symbol == sym, Candle.interval == interval, Candle.t >= from_, Candle.t <= to)
        .order_by(Candle.t.desc())
        .limit(limit + 1)
        .all()
    )
    truncated = len(rows) > limit
    rows = rows[:limit]
    rows.reverse()
    return {
        "symbol": sym,
        "interval": interval,
        "bars": [_bar(r) for r in rows],
        "truncated": truncated,
        "earliest": _earliest(db, sym, interval),
    }


# ================================================================ /chart/batch

def _parse_symbols(raw: str) -> list[str]:
    out: list[str] = []
    for part in (raw or "").split(","):
        if not part.strip():
            continue
        sym = _check_symbol(part)
        if sym not in out:
            out.append(sym)
    if not out:
        raise HTTPException(status_code=400, detail="至少要一个品种 / at least one symbol is required")
    if len(out) > BATCH_MAX_SYMBOLS:
        raise HTTPException(
            status_code=400,
            detail=f"一次最多 {BATCH_MAX_SYMBOLS} 个品种 / at most {BATCH_MAX_SYMBOLS} symbols per request",
        )
    return out


def _latest_pages(db: Session, syms: list[str], interval: str, limit: int) -> dict[str, list[dict]]:
    """多个品种各自最新的 limit 根（升序），**一次往返**：每个品种一个「倒序 + LIMIT」子查询，
    UNION ALL 拼起来。每个子查询都只在索引上走 limit 步，不会因为某个品种历史很长而扫全表。
    The newest `limit` bars per symbol (ascending) in one round trip: a descending LIMIT subquery
    per symbol, UNION ALL'd. Each subquery walks `limit` index entries, however long the history."""
    selects = []
    for s in syms:
        sub = (
            select(Candle.symbol, Candle.t, Candle.o, Candle.h, Candle.l, Candle.c, Candle.v)
            .where(Candle.symbol == s, Candle.interval == interval)
            .order_by(Candle.t.desc())
            .limit(limit)
            .subquery()
        )
        selects.append(select(sub))
    stmt = selects[0] if len(selects) == 1 else union_all(*selects)
    out: dict[str, list[dict]] = {s: [] for s in syms}
    for r in db.execute(stmt).all():
        bars = out.get(r[0])
        if bars is not None:
            bars.append({"t": r[1], "o": r[2], "h": r[3], "l": r[4], "c": r[5], "v": r[6]})
    for bars in out.values():
        bars.sort(key=lambda b: b["t"])
    return out


@router.get("/chart/batch")
@user_limiter.limit(BATCH_RATE_LIMIT)
def chart_batch(
    request: Request,
    symbols: str = Query(max_length=400),
    interval: str = Query(),
    limit: int = Query(default=BATCH_DEFAULT_LIMIT, ge=1, le=chart_router.CHART_HISTORY_MAX_LIMIT),
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """最多 8 个品种同一周期的最新一页，语义同 /chart/history 不带 before 的首页（hasMore = 拿满一页）。
    对比品种与多图首屏用，只算一次限流。limit 恰好是首屏那档时复用 /chart/history 的首页缓存
    （新收盘 bar 落库时那份缓存会被主动删掉，所以读写两边都安全）。
    Latest page for up to 8 symbols on one interval, same semantics as /chart/history's first page
    (hasMore = a full page). One rate-limit hit. When limit equals the history first-page size, the
    history first-page cache is shared (it is dropped whenever a new closed bar lands)."""
    _check_interval(interval)
    syms = _parse_symbols(symbols)
    first_page = limit == chart_router.CHART_HISTORY_FIRST_PAGE

    series: dict[str, dict] = {}
    missing: list[str] = []
    for s in syms:
        hit = shared_cache.get_json(chart_router._history_first_key(s, interval)) if first_page else None
        if isinstance(hit, dict) and isinstance(hit.get("bars"), list):
            series[s] = {"bars": hit["bars"], "hasMore": bool(hit.get("hasMore"))}
        else:
            missing.append(s)

    if missing:
        pages = _latest_pages(db, missing, interval, limit)
        for s in missing:
            bars = pages.get(s, [])
            has_more = len(bars) == limit
            series[s] = {"bars": bars, "hasMore": has_more}
            if first_page:
                shared_cache.set_json(
                    chart_router._history_first_key(s, interval),
                    {"symbol": s, "interval": interval, "bars": bars, "hasMore": has_more},
                    chart_router._HISTORY_FIRST_TTL,
                )
    # 按请求顺序输出 / keep the requested order
    return {"interval": interval, "series": {s: series[s] for s in syms}}


# ================================================================ /chart/sessions

def _gateway_login_for(db: Session, user_id: str) -> int | None:
    """与 GET /orders/market-status 同一个选法：该用户第一个未删除的网关账号，网关按它的组解析后缀。
    Same choice as GET /orders/market-status: the user's first non-removed gateway account, so the
    gateway resolves the group suffix."""
    row = (
        db.query(MT5Account.login)
        .filter(MT5Account.user_id == user_id, MT5Account.source == "gateway", not_removed())
        .first()
    )
    if row is None:
        return None
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return None


def _unknown_sessions(sym: str) -> dict:
    return {
        "symbol": sym, "known": False, "openNow": None, "holiday": False, "nextOpenAt": None,
        "serverUtcOffsetSec": None, "sessions": [], "source": "none",
    }


def _int_or_none(v) -> int | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if math.isfinite(f) else None


def normalize_sessions(sym: str, data: dict) -> dict:
    """网关 /symbol-sessions 回包 → ChartSessions。网关的 open/close 已经是服务器时间当天的分钟数
    （MT5 CIMTConSymbolSession.Open/Close），这里只做夹取与清洗：day 0–6、0 ≤ open < close ≤ 1440。
    sessionsKnown=false 时网关的 openNow 只反映 TradeMode、不是按时段判的，所以给 null。
    Gateway /symbol-sessions reply → ChartSessions. open/close are already minutes of the server
    day (MT5 session Open/Close); this only clamps and cleans. With sessionsKnown=false the
    gateway's openNow reflects TradeMode alone, not the sessions, so it becomes null."""
    sessions: list[dict] = []
    for s in data.get("sessions") or []:
        if not isinstance(s, dict):
            continue
        day, op, cl = _int_or_none(s.get("day")), _int_or_none(s.get("open")), _int_or_none(s.get("close"))
        if day is None or op is None or cl is None or not 0 <= day <= 6:
            continue
        op, cl = max(0, min(1440, op)), max(0, min(1440, cl))
        if cl <= op:
            continue
        sessions.append({"day": day, "open": op, "close": cl})
    sessions.sort(key=lambda x: (x["day"], x["open"]))
    known = bool(data.get("sessionsKnown")) and bool(sessions)
    next_open = None
    nxt = _int_or_none(data.get("nextOpenUtc"))
    if nxt and nxt > 0:
        next_open = datetime.fromtimestamp(nxt, timezone.utc).isoformat()
    open_now = data.get("openNow")
    return {
        "symbol": sym,
        "known": known,
        "openNow": bool(open_now) if known and open_now is not None else None,
        "holiday": bool(data.get("holiday")),
        "nextOpenAt": next_open,
        "serverUtcOffsetSec": _int_or_none(data.get("serverUtcOffsetSec")),
        "sessions": sessions,
        "source": "gateway",
    }


@router.get("/chart/sessions")
@user_limiter.limit(SESSIONS_RATE_LIMIT)
async def chart_sessions(
    request: Request,
    symbol: str = Query(max_length=32),
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """品种的 MT5 交易时段（网关 /symbol-sessions 透传 + 清洗），按品种缓存 60 秒（跨 worker）。
    MARKET_HOURS_GATE 关着、网关不可达或读不到这个品种时返回 known=false、sessions=[]（200，不报错）。
    The symbol's MT5 trading sessions (gateway passthrough, cleaned), cached 60 s per symbol across
    workers. Gate off, gateway unreachable or symbol unknown → known=false, sessions=[] (200)."""
    sym = _check_symbol(symbol)
    if not settings.MARKET_HOURS_GATE:
        return _unknown_sessions(sym)
    base = broker_symbol(sym)
    key = f"chart:sessions:{base}"
    hit = await run_in_threadpool(shared_cache.get_json, key)
    if isinstance(hit, dict):
        return {**hit, "symbol": sym}

    login = await run_in_threadpool(_gateway_login_for, db, user_id)
    data = None
    try:
        data = await gateway_client.get_symbol_sessions(
            base, login, timeout=market_hours.GATEWAY_TIMEOUT_SECONDS,
        )
    except Exception as e:  # noqa: BLE001 —— 读不到就是「未知」，不能把图表接口打挂
        logger.warning("读取 %s 交易时段失败: %s", base, e)
    if isinstance(data, dict) and data.get("ok"):
        out = normalize_sessions(sym, data)
        ttl = _SESSIONS_TTL
    else:
        out = _unknown_sessions(sym)
        ttl = _SESSIONS_FAIL_TTL
    await run_in_threadpool(shared_cache.set_json, key, out, ttl)
    return out


# ================================================================ /chart/spec

def _base(symbol: str) -> str:
    """平台基础名（去券商后缀、归一别名）；切完为空（#AAPL 这种）就用原名。
    Platform base name (suffix stripped, aliases folded); the raw name when that leaves nothing."""
    return _base_symbol(symbol) or symbol.strip().upper()


def _pos_float(v) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and f > 0 else None


def _digits(v) -> int | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    d = int(v)
    return d if 0 <= d <= 10 else None


def build_spec(sym: str, bridge_quotes: list, global_quotes: list) -> dict:
    """拼品种规格，拿不到的一律 null。来源优先级：
      ① 该用户自己的桥接（桌面端）按账户上报的报价：券商真实的 digits / contractSize / tickSize /
         tickValue（tickValue 是该账户币种的，所以只能按用户取，不能全站共享）。source="bridge"。
      ② 全站 EA 报价只有 digits。
      ③ 合约规模兜底表（与前端估算表一致，外汇 100000、黄金 100…）与按品种名推出的外汇币种：
         source="estimate"，tickSize / tickValue 仍为 null（估不准就不给）。
      手数下限 / 步长来自平台下单闸门用的同一张表（symbol_aliases，指数 0.1、WTI 0.1、其余 0.01）；
      最大手数、描述、保证金币种（非外汇）网关没有接口提供，为 null。
    Build the spec with null for anything unknown. Sources: ① the user's own desktop bridge quotes
    (broker-real digits / contract / tick fields; tickValue is in that account's currency, hence per
    user) → source "bridge"; ② the site EA quotes (digits only); ③ the fallback contract table plus
    FX currencies inferred from the name → source "estimate", tick fields stay null. Volume min /
    step come from the platform's own order-gate table; max volume, description and (non-FX)
    margin currency have no backend source and stay null."""
    base = _base(sym)
    spec = {
        "symbol": sym,
        "digits": None, "contractSize": None, "tickSize": None, "tickValue": None,
        "volumeMin": min_lot(sym), "volumeMax": None, "volumeStep": lot_step(sym),
        "currencyBase": None, "currencyProfit": None, "currencyMargin": None,
        "description": None, "source": "none",
    }

    # ① 桥接报价：同一品种可能有多个账户，挑带合约规格的那条。
    # ① bridge quotes: several accounts may carry the symbol; prefer one with the spec fields.
    best = None
    for q in bridge_quotes or []:
        if not isinstance(q, dict) or not isinstance(q.get("symbol"), str):
            continue
        qs = q["symbol"].strip().upper()
        if qs != sym and _base(qs) != base:
            continue
        if best is None or (_pos_float(q.get("contractSize")) and not _pos_float(best.get("contractSize"))):
            best = q
    if best is not None:
        spec["digits"] = _digits(best.get("digits"))
        spec["contractSize"] = _pos_float(best.get("contractSize"))
        spec["tickSize"] = _pos_float(best.get("tickSize"))
        spec["tickValue"] = _pos_float(best.get("tickValue"))
        if spec["contractSize"] is not None or spec["tickValue"] is not None:
            spec["source"] = "bridge"

    # ② 全站报价的 digits / ② digits from the site quotes
    if spec["digits"] is None:
        for q in global_quotes or []:
            if isinstance(q, dict) and str(q.get("symbol", "")).upper() in (sym, base):
                spec["digits"] = _digits(q.get("digits"))
                if spec["digits"] is not None:
                    break

    # ③ 兜底估算 / ③ fallback estimate
    if spec["contractSize"] is None:
        est = _CONTRACT_SIZE.get(base) or (_FX_CONTRACT_SIZE if _is_fx(base) else None)
        if est is not None:
            spec["contractSize"] = est
            if spec["source"] == "none":
                spec["source"] = "estimate"
    if _is_fx(base):
        spec["currencyBase"], spec["currencyProfit"], spec["currencyMargin"] = base[:3], base[3:], base[:3]
    elif len(base) == 6 and base.isalpha() and base.endswith("USD"):
        # XAUUSD / XAGUSD / BTCUSD / ETHUSD：计价币种是美元 / quoted in USD
        spec["currencyBase"], spec["currencyProfit"] = base[:3], "USD"
    return spec


@router.get("/chart/spec")
@user_limiter.limit(SPEC_RATE_LIMIT)
async def chart_spec(
    request: Request,
    symbol: str = Query(max_length=32),
    user_id: str = Depends(get_current_user_id_light),
):
    """品种规格（尽力而为，拿不到的为 null，见 build_spec）。纯内存 / Redis 读，不查库。
    Symbol spec, best effort (see build_spec). Memory / Redis reads only, no DB."""
    sym = _check_symbol(symbol)
    try:
        bridge_quotes = await manager.get_quotes_async(user_id)
    except Exception as e:  # noqa: BLE001
        logger.debug("读取分账户报价失败 / per-account quotes read failed: %s", e)
        bridge_quotes = []
    try:
        global_quotes = await quotes_store.get_all_async()
    except Exception:  # noqa: BLE001
        global_quotes = []
    return build_spec(sym, bridge_quotes, global_quotes)


# ================================================================ /chart/day-refs

def _finite(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def compute_day_refs(db: Session, now: float | None = None) -> dict:
    """全部活跃品种的日内涨跌基准：open = 最新一根日线的开盘价，prevClose = 前一根日线的收盘价。
    库里只有已收盘的日线，所以先用**一条**窗口函数查询取每个品种最近两根（只看最近 21 天，走索引），
    再叠上 chart_store 里正在形成的那根（今天的日线只在那里）。EA 停推、没有活跃品种时退回库里这
    21 天出现过的全部品种。
    Day-change refs for every active symbol: open of the latest daily bar, close of the one before.
    The table holds closed bars only, so one window-function query fetches each symbol's last two
    (21-day window, indexed), then the forming bar from chart_store (today's lives only there) is
    laid over them. With no active symbols (EA quiet) every symbol seen in that window is used."""
    now = time.time() if now is None else now
    try:
        active = quotes_store.get_active_symbols()
    except Exception:  # noqa: BLE001
        active = []
    rn = func.row_number().over(partition_by=Candle.symbol, order_by=Candle.t.desc()).label("rn")
    inner = select(Candle.symbol, Candle.t, Candle.o, Candle.c, rn).where(
        Candle.interval == "D", Candle.t >= int(now - _DAY_REFS_LOOKBACK_SECONDS),
    )
    if active:
        inner = inner.where(Candle.symbol.in_(active))
    sub = inner.subquery()
    rows = db.execute(select(sub.c.symbol, sub.c.t, sub.c.o, sub.c.c).where(sub.c.rn <= 2)).all()

    bars: dict[str, dict[int, tuple[float, float]]] = {}
    for sym, t, o, c in rows:
        bars.setdefault(sym, {})[int(t)] = (o, c)
    for sym in list(dict.fromkeys([*active, *bars.keys()])):
        try:
            live = chart_store.get_latest(sym, "D", 2).get("bars") or []
        except Exception:  # noqa: BLE001 —— 缓存读不到就只用库里的 / cache unreadable: DB only
            live = []
        for b in live:
            if isinstance(b, dict) and isinstance(b.get("t"), (int, float)):
                bars.setdefault(sym, {})[int(b["t"])] = (b.get("o"), b.get("c"))

    items: dict[str, dict] = {}
    for sym, by_t in bars.items():
        ts = sorted(by_t)
        if not ts:
            continue
        open_ = _finite(by_t[ts[-1]][0])
        if open_ is None:
            continue
        prev = _finite(by_t[ts[-2]][1]) if len(ts) >= 2 else None
        items[sym] = {"open": open_, "prevClose": prev, "t": ts[-1]}
    return {"items": items}


@router.get("/chart/day-refs")
@user_limiter.limit(DAY_REFS_RATE_LIMIT)
def chart_day_refs(
    request: Request,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """全部活跃品种的日内涨跌基准，全员同值、跨 worker 缓存 60 秒。普通 def：查库走线程池。
    Day-change refs for every active symbol; identical for everyone, cached 60 s across workers."""
    return shared_cache.cached_json(_DAY_REFS_KEY, _DAY_REFS_TTL, lambda: compute_day_refs(db))
