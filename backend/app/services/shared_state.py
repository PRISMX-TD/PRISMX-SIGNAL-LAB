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

# 内存后端每多少次写做一次过期清扫（见 _MemoryBackend._sweep_locked）。
# How many writes between expiry sweeps in the memory backend.
_MEMORY_SWEEP_EVERY_WRITES = 256


class _MemoryBackend:
    """与用到的那几条 Redis 命令同形的内存实现（含过期），单 worker 部署走这里。
    In-memory stand-in for the handful of Redis commands used here, with expiry."""

    def __init__(self) -> None:
        self._kv: dict[str, tuple[Any, float | None]] = {}
        self._sets: dict[str, dict[str, float | None]] = {}
        self._lock = threading.Lock()
        self._subscribers: list[Callable[[str, str], None]] = []
        self._writes_since_sweep = 0

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
            self._sweep_locked()
            return True

    def _sweep_locked(self) -> None:
        """每隔若干次写扫一遍已过期的键（调用方须已持锁）。

        真 Redis 自己回收过期键，内存后端不会——而这里存的恰好是失败锁定计数，
        键就是攻击者枚举过的邮箱 / MT5 账号。只在 get() 里 pop 的话，枚举过就
        再没人读的键会永远留在 dict 里，成了一条随枚举量稳定增长的内存泄漏。

        每 N 次写做一次全量扫描，而不是每次写扫固定的前几条：dict 按插入序遍历，
        前面若压着一批没有 TTL 的长寿键（行情缓存那类），固定前缀扫描永远够不到
        后面真正过期的锁定键。全量扫描摊到 N 次写上，单次写的均摊代价仍是常数级。

        Sweep expired keys every N writes (caller holds the lock). Real Redis
        reclaims them itself; this backend doesn't, and what it holds is the
        lockout counters keyed by whatever emails / MT5 logins an attacker
        enumerated — keys nobody ever reads again, so popping only in get()
        never reclaims them. A full sweep every N writes rather than a fixed
        prefix per write: dicts iterate in insertion order, and a run of
        TTL-less long-lived keys at the front (the market caches) would hide
        every expired lockout key behind it. Amortised over N writes the cost
        per write is still constant.
        """
        self._writes_since_sweep += 1
        if self._writes_since_sweep < _MEMORY_SWEEP_EVERY_WRITES:
            return
        self._writes_since_sweep = 0
        now = time.time()
        dead = [k for k, (_v, exp) in self._kv.items() if exp is not None and exp <= now]
        for k in dead:
            self._kv.pop(k, None)

    def delete(self, *keys: str) -> int:
        with self._lock:
            return sum(1 for k in keys if self._kv.pop(k, None) is not None)

    def delete_if(self, key: str, value: str) -> bool:
        """值相符才删（对应 Redis 侧的 Lua 脚本），在同一把锁里完成。
        Delete only if the value matches (the memory twin of the Redis Lua
        script), done under one lock."""
        with self._lock:
            hit = self._kv.get(key)
            if hit is None or not self._alive(hit[1]) or hit[0] != value:
                return False
            self._kv.pop(key, None)
            return True

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


def incr_with_ttl(key: str, ttl: int, refresh: bool = False) -> int:
    """自增；第一次写入时定过期。

    refresh=True 则每次自增都把过期时间往后推（滑动窗口：距**最后一次**自增
    ttl 秒后整条归零）。失败锁定计数要的是这个语义——固定窗口下攻击者可以卡着
    边界让计数周期性清零。

    Increment, setting the expiry on first write. With refresh=True every
    increment pushes the expiry out, giving a sliding window (the entry lapses
    ttl seconds after the *last* increment) — what the lockout counters need,
    since a fixed window lets an attacker ride the boundary to reset the count.
    """
    if enabled():
        r = _redis()
        n = r.incr(_k(key))
        if n == 1 or refresh:
            r.expire(_k(key), ttl)
        return int(n)
    n = _memory.incr(_k(key))
    if n == 1 or refresh:
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


# "是我持有的才删"必须是一个不可分割的动作。分成 GET + DELETE 两步时，持有者卡顿
# 超过 TTL、锁已被另一个 worker 抢走的情况下，恰好在两步之间换主就会把**新主**的
# 锁删掉，于是同一时刻出现两个领导者。Lua 脚本在 Redis 侧一次执行完，中间插不进
# 别人的命令。/ "Delete only if I still hold it" has to be indivisible. Split into
# GET + DELETE, a holder that stalled past the TTL can delete the *new* owner's
# lock if the handover lands between the two steps, leaving two leaders at once.
# The Lua script runs to completion inside Redis with nothing interleaved.
_RELEASE_LOCK_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
"""


def release_lock(name: str, owner: str = WORKER_ID) -> None:
    key = _k("lock:" + name)
    if enabled():
        _redis().eval(_RELEASE_LOCK_LUA, 1, key, owner)
    else:
        # 内存后端同理：同进程的两个线程之间也会有这个窗口，所以比对与删除放进
        # 后端的同一把锁里。/ Same in-process: the window exists between threads
        # too, so the compare and the delete happen under the backend's one lock.
        _memory.delete_if(key, owner)


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


def new_async_pubsub(channel: str, with_client: bool = False) -> Any:
    """给异步订阅循环用的 redis.asyncio PubSub；没配 Redis 返回 None。

    每次调用都新建一个客户端（连接池）。订阅循环断线后会重来一次，所以**调用方
    必须在 finally 里把客户端关掉**，否则 Redis 一抖动连接数就线性泄漏。
    with_client=True 时多返回这个客户端句柄；默认仍返回两元组，老调用方不受影响。

    A fresh client (and connection pool) per call. Subscriber loops call this
    again after every drop, so the caller must close the client in a finally
    block or connections leak linearly through a Redis wobble. with_client=True
    hands the client back; the default stays a 2-tuple for existing callers.
    """
    if not enabled():
        return None
    import redis.asyncio as aioredis

    client = aioredis.from_url(redis_url(), decode_responses=True)
    ps = client.pubsub(ignore_subscribe_messages=True)
    if with_client:
        return ps, _k(channel), client
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
