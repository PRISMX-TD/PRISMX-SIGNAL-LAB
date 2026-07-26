"""策略端点的按用户限流、并发闸门、成本上限与结果缓存。

与 core/rate_limit.py 的分工：那个限流器按 IP，服务于登录/下单等端点；这里按
用户 ID，服务于回测这类"一次请求就能占满 CPU"的端点。并发闸门沿用
rate_limit.is_login_locked 所示的进程内状态模式——单实例部署适用，多实例需换
Redis。

Per-user rate limiting, a concurrency gate, cost caps and result caching for the
strategy endpoints. Division of labour with core/rate_limit.py: that limiter is
IP-keyed and serves login/order endpoints; this one is user-keyed and serves
endpoints where a single request can saturate a core. The gate uses the same
in-process state pattern as rate_limit.is_login_locked — fine for a single
instance, needs Redis for several.
"""
import hashlib
import json
import threading
import time
from contextlib import contextmanager

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings
from app.core.security import decode_access_token


def user_rate_key(request) -> str:
    """限流 key：优先 JWT 里的用户 ID，取不到回落到 IP。

    回落而不是拒绝：key_func 在依赖注入之前运行，此时"未登录"与"token 无效"
    分不开，而真正的鉴权在端点依赖里会照常返回 401。前缀区分两个命名空间，
    避免用户 ID 与 IP 字符串意外相等。

    The limiter key: the JWT's user id when available, otherwise the IP. Falling
    back rather than rejecting, because key_func runs before dependency
    injection — "not logged in" and "invalid token" are indistinguishable here,
    and real auth still returns 401 from the endpoint's dependency. The prefixes
    keep the two namespaces from colliding.
    """
    auth = request.headers.get("Authorization") or ""
    parts = auth.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        user_id = decode_access_token(parts[1].strip())
        if user_id:
            return f"user:{user_id}"
    return f"ip:{get_remote_address(request)}"


# 独立的 Limiter 实例：与 rate_limit.limiter 的 key_func 不同，不能共用。
# 两个实例各自记账，互不影响。
# A separate Limiter instance: its key_func differs from rate_limit.limiter's,
# so they can't be shared. Each keeps its own counters.
user_limiter = Limiter(key_func=user_rate_key)


class BacktestBusy(Exception):
    """该用户已有一个回测在执行 / this user already has a backtest running."""


_gate_lock = threading.Lock()
_running: set[str] = set()


@contextmanager
def backtest_gate(user_id: str):
    """同一用户同时只允许一个回测执行，第二个直接拒绝而不是排队。

    这一层是关键：纯速率限制无法阻止单次请求长时间占满 CPU，而排队只会把
    等待转移到连接上（生产为 2 核单进程，排队等于让整个进程更久地被拖住）。

    One backtest per user at a time; a second is rejected outright rather than
    queued. This layer is the important one — rate limits can't stop a single
    request from saturating a core for a long time, and queueing would just move
    the wait onto held connections (production is 2 cores, single process, so a
    queue means the whole process stays bogged down longer).
    """
    with _gate_lock:
        if user_id in _running:
            raise BacktestBusy(user_id)
        _running.add(user_id)
    try:
        yield
    finally:
        with _gate_lock:
            _running.discard(user_id)


def cost_units(bars: int, conditions: int) -> int:
    """单次回测的工作量度量：bars 数 × 规则条件数。
    A backtest's workload measure: bars x rule conditions."""
    return int(bars) * max(1, int(conditions))


def assert_within_cost_cap(bars: int, conditions: int) -> None:
    """超出成本上限抛 ValueError（调用方转 400）。
    Raise ValueError past the cost cap; the caller turns it into a 400."""
    units = cost_units(bars, conditions)
    cap = settings.MAX_BACKTEST_COST_UNITS
    if units > cap:
        raise ValueError(
            f"回测规模过大：{bars} 根 × {conditions} 个条件 = {units}，上限 {cap}。"
            f"请减少天数或条件数 / backtest too large: {units} units exceeds the cap of {cap}"
        )


def cache_key(
    rules: dict, symbol: str, interval: str, days: int, costs_version: str,
    extra: dict | None = None,
) -> str:
    """结果缓存 key。规则用 sort_keys 的 JSON 哈希，使等价 AST（键序不同）命中
    同一条缓存；成本版本进 key，管理员改成本后旧缓存自然失效。
    Cache key. Rules are hashed as sort_keys JSON so equivalent ASTs with
    different key order share an entry; the cost version is part of the key so
    an admin's cost edit invalidates stale entries on its own."""
    blob = json.dumps(
        {
            "rules": rules,
            "symbol": symbol.upper(),
            "interval": interval,
            "days": days,
            "costs": costs_version,
            "extra": extra or {},
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}


def cache_get(key: str) -> dict | None:
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        stored_at, value = entry
        if time.time() - stored_at >= settings.BACKTEST_CACHE_TTL_SECONDS:
            _cache.pop(key, None)
            return None
        return value


def cache_put(key: str, value: dict) -> None:
    with _cache_lock:
        # 满了先淘汰最早写入的一条。dict 保留插入顺序，因此 next(iter(...)) 就是
        # 最旧的 key，不需要额外的 LRU 结构。
        # Evict the oldest entry when full. dict preserves insertion order, so
        # next(iter(...)) is the oldest key — no separate LRU structure needed.
        while len(_cache) >= settings.BACKTEST_CACHE_MAX_ENTRIES:
            _cache.pop(next(iter(_cache)), None)
        _cache[key] = (time.time(), value)


def cache_clear() -> None:
    with _cache_lock:
        _cache.clear()
