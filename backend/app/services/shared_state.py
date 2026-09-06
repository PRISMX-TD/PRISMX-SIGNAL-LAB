"""跨进程共享状态：配了 REDIS_URL 走 Redis，没配走进程内内存，两者接口相同。

**为什么有这个模块**：限流失败锁定、回测并发闸门、/me 判定节流、后台循环的
「谁来跑」、WebSocket 推送的跨进程转发、EA 喂进来的报价与 K 线——这些原来全是
模块级 dict，单进程下没问题，一开多 worker 就各算各的（锁定阈值被稀释、循环
跑 N 遍、推送只到达连在本进程的用户、图表在别的 worker 上没数据）。这里把
「一个键、带过期、跨进程可见」这件事收成一个接口，各处改成调它；REDIS_URL
留空时行为与原来的进程内 dict 完全一致，单 worker 部署零变化。

只暴露最小的一组原语（get/set/delete/incr、集合、锁、发布订阅），不做 ORM。
键统一带 `prismx:` 前缀，同一台 Redis 上跑别的东西也不会撞。

Cross-process shared state: Redis when REDIS_URL is set, in-process memory
otherwise, behind one interface. Rate-limit lockouts, the backtest gate, the
/me judging throttle, background-loop leadership, WebSocket fan-out and the EA
market stores were all module-level dicts — fine on one worker, silently wrong
on several. With REDIS_URL empty every call behaves exactly like the old dicts.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from typing import Any, Callable

from app.core.config import settings

logger = logging.getLogger("prismx.shared_state")

PREFIX = "prismx:"
# 本进程的身份：锁的持有者标识、订阅时过滤自己发的消息都用它。
# This process's identity: lock ownership and pub/sub self-filtering.
WORKER_ID = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"


def redis_url() -> str:
    """REDIS_URL 优先；没配就沿用 RATE_LIMIT_STORAGE_URI（早先只给 slowapi 用的那个）。
    REDIS_URL first, else RATE_LIMIT_STORAGE_URI (the older slowapi-only setting)."""
    return (settings.REDIS_URL or settings.RATE_LIMIT_STORAGE_URI or "").strip()


def enabled() -> bool:
    return bool(redis_url())


# ---------------------------------------------------------------------------
# 进程内兜底 / in-memory fallback
# ---------------------------------------------------------------------------

class _MemoryBackend:
    """与用到的那几条 Redis 命令同形的内存实现（含过期），单 worker 部署走这里。
    In-memory stand-in for the handful of Redis commands used here, with expiry."""

    def __init__(self) -> None:
        self._kv: dict[str, tuple[Any, float | None]] = {}
        self._sets: dict[str, dict[str, float | None]] = {}
        self._lock = threading.Lock()
        self._subscribers: list[Callable[[str, str], None]] = []

    def _alive(self, exp: float | None) -> bool:
        return exp is None or exp > time.time()

    # -- kv --
    def get(self, key: str) -> str | None:
        with self._lock:
            hit = self._kv.get(key)
            if hit is None:
                return None
            val, exp = hit
            if not self._alive(exp):
                self._kv.pop(key, None)
                return None
            return val

    def set(self, key: str, value: str, ex: int | None = None, nx: bool = False) -> bool:
        with self._lock:
            if nx:
                hit = self._kv.get(key)
                if hit is not None and self._alive(hit[1]):
                    return False
            self._kv[key] = (value, time.time() + ex if ex else None)
            return True

    def delete(self, *keys: str) -> int:
        with self._lock:
            return sum(1 for k in keys if self._kv.pop(k, None) is not None)

    def incr(self, key: str) -> int:
        with self._lock:
            hit = self._kv.get(key)
            cur = int(hit[0]) if hit is not None and self._alive(hit[1]) else 0
            exp = hit[1] if hit is not None and self._alive(hit[1]) else None
            self._kv[key] = (str(cur + 1), exp)
            return cur + 1

    def expire(self, key: str, seconds: int) -> None:
        with self._lock:
            hit = self._kv.get(key)
            if hit is not None:
                self._kv[key] = (hit[0], time.time() + seconds)

    def keys(self, pattern_prefix: str) -> list[str]:
        with self._lock:
            return [k for k, (_v, exp) in self._kv.items() if k.startswith(pattern_prefix) and self._alive(exp)]

    # -- set with per-member expiry (Redis 侧用 ZSET 实现) --
    def sadd_ttl(self, key: str, member: str, ttl: int) -> None:
        with self._lock:
            self._sets.setdefault(key, {})[member] = time.time() + ttl

    def srem(self, key: str, member: str) -> None:
        with self._lock:
            self._sets.get(key, {}).pop(member, None)

    def smembers_alive(self, key: str) -> list[str]:
        with self._lock:
            members = self._sets.get(key, {})
            now = time.time()
            dead = [m for m, exp in members.items() if exp is not None and exp <= now]
            for m in dead:
                members.pop(m, None)
            return list(members.keys())

    # -- pub/sub（进程内：发给本进程的订阅者）--
    def publish(self, channel: str, payload: str) -> None:
        for fn in list(self._subscribers):
            fn(channel, payload)

    def subscribe(self, fn: Callable[[str, str], None]) -> None:
        self._subscribers.append(fn)


_memory = _MemoryBackend()
_redis_client: Any = None
_redis_lock = threading.Lock()


def _redis() -> Any:
    """惰性建同步客户端；连不上时抛错由调用方兜底（不在这里吞）。
    Lazily build the sync client; connection errors propagate to the caller."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    with _redis_lock:
        if _redis_client is None:
            import redis  # 依赖只在配了 Redis 时才真正需要 / imported only when configured

            _redis_client = redis.Redis.from_url(
                redis_url(), decode_responses=True, socket_timeout=2.0, socket_connect_timeout=2.0,
            )
    return _redis_client


def reset_for_tests(client: Any = None) -> None:
    """测试用：清空内存兜底、可注入一个假的 Redis 客户端。
    Tests: clear the memory backend, optionally inject a fake Redis client."""
    global _memory, _redis_client
    _memory = _MemoryBackend()
    _redis_client = client


def _k(key: str) -> str:
    return key if key.startswith(PREFIX) else PREFIX + key


# ---------------------------------------------------------------------------
# 原语 / primitives
# ---------------------------------------------------------------------------

def kv_get(key: str) -> str | None:
    if enabled():
        return _redis().get(_k(key))
    return _memory.get(_k(key))


def kv_set(key: str, value: str, ttl: int | None = None) -> None:
    if enabled():
        _redis().set(_k(key), value, ex=ttl)
    else:
        _memory.set(_k(key), value, ex=ttl)


def kv_delete(*keys: str) -> None:
    ks = [_k(k) for k in keys]
    if not ks:
        return
    if enabled():
        _redis().delete(*ks)
    else:
        _memory.delete(*ks)


def kv_get_json(key: str) -> Any:
    raw = kv_get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def kv_set_json(key: str, value: Any, ttl: int | None = None) -> None:
    kv_set(key, json.dumps(value, ensure_ascii=False, default=str), ttl)


def incr_with_ttl(key: str, ttl: int) -> int:
    """自增；第一次写入时定过期。/ Increment, setting the expiry on first write."""
    if enabled():
        r = _redis()
        n = r.incr(_k(key))
        if n == 1:
            r.expire(_k(key), ttl)
        return int(n)
    n = _memory.incr(_k(key))
    if n == 1:
        _memory.expire(_k(key), ttl)
    return n


def set_add(key: str, member: str, ttl: int) -> None:
    """带成员级过期的集合（在线用户表这类"不续期就掉"的名单）。
    Set with per-member expiry (for "drop unless refreshed" rosters)."""
    if enabled():
        _redis().zadd(_k(key), {member: time.time() + ttl})
    else:
        _memory.sadd_ttl(_k(key), member, ttl)


def set_remove(key: str, member: str) -> None:
    if enabled():
        _redis().zrem(_k(key), member)
    else:
        _memory.srem(_k(key), member)


def set_members(key: str) -> list[str]:
    if enabled():
        r = _redis()
        now = time.time()
        r.zremrangebyscore(_k(key), "-inf", now)
        return list(r.zrangebyscore(_k(key), now, "+inf"))
    return _memory.smembers_alive(_k(key))


def try_lock(name: str, ttl: int, owner: str = WORKER_ID) -> bool:
    """抢锁（SET NX EX）。已经是自己持有的话续期并返回 True。
    Acquire (SET NX EX); re-acquiring one's own lock renews it and returns True."""
    key = _k("lock:" + name)
    if enabled():
        r = _redis()
        if r.set(key, owner, ex=ttl, nx=True):
            return True
        if r.get(key) == owner:
            r.expire(key, ttl)
            return True
        return False
    if _memory.set(key, owner, ex=ttl, nx=True):
        return True
    if _memory.get(key) == owner:
        _memory.expire(key, ttl)
        return True
    return False


def release_lock(name: str, owner: str = WORKER_ID) -> None:
    key = _k("lock:" + name)
    if enabled():
        r = _redis()
        if r.get(key) == owner:
            r.delete(key)
    else:
        if _memory.get(key) == owner:
            _memory.delete(key)


# ---------------------------------------------------------------------------
# 发布订阅 / pub-sub（WebSocket 跨进程转发用）
# ---------------------------------------------------------------------------

def publish(channel: str, payload: dict) -> None:
    body = json.dumps({"from": WORKER_ID, **payload}, default=str)
    if enabled():
        _redis().publish(_k(channel), body)
    else:
        _memory.publish(_k(channel), body)


def subscribe_memory(fn: Callable[[str, str], None]) -> None:
    """进程内订阅（只在没配 Redis 时有意义；Redis 订阅走 connection_manager 的异步任务）。
    In-process subscription (only meaningful without Redis)."""
    _memory.subscribe(fn)


def new_async_pubsub(channel: str) -> Any:
    """给异步订阅循环用的 redis.asyncio PubSub；没配 Redis 返回 None。
    redis.asyncio PubSub for the async subscriber loop; None when Redis is off."""
    if not enabled():
        return None
    import redis.asyncio as aioredis

    client = aioredis.from_url(redis_url(), decode_responses=True)
    ps = client.pubsub(ignore_subscribe_messages=True)
    return ps, _k(channel)


def ping() -> bool:
    """健康检查用：没配 Redis 返回 True（内存后端总是好的）。
    For /health: True when Redis is off (memory is always fine)."""
    if not enabled():
        return True
    try:
        return bool(_redis().ping())
    except Exception:
        return False
