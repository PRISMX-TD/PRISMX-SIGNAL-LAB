"""跨 worker 的读缓存与失效版本号（建在 services/shared_state 之上）。

两件事，都是为多 worker 部署补的：

1. **读缓存**（get_json / set_json / cached_json / delete）：高频、全员同值的只读
   接口（信号列表、胜率、榜单前 50……）把结果放进 shared_state 一小段时间。配了
   REDIS_URL 就是全体 worker 共享一份，没配就是进程内内存，接口相同。键统一带
   `rc:` 前缀，测试可以一把清掉（见 clear_for_tests）。

2. **失效版本号**（SharedVersion）：进程内缓存（设置段、桥接 Token 鉴权、自动仓管
   资格、网关账号映射）以前只能清本进程——管理员在 worker A 上改了设置，worker B
   要等 TTL 自然过期才看得到。现在失效时在 shared_state 里换一个新的版本号，读
   缓存前比对：版本变了就当未命中回源（版本是随机串而不是计数器，见 bump）。
   版本号本身在本地再缓存 1 秒，所以每个 worker 每秒至多读一次 Redis，而不是
   每次命中缓存都读一次。

**Redis 出错时一律退回原有行为**：读缓存未命中→直接回源；版本号读不到→只按原来的
TTL 过期。这里的每个函数都不向调用方抛 Redis 异常——缓存是优化，不能变成新的故障点。

Cross-worker read cache and invalidation versions, built on shared_state.
(1) A read cache for hot, identical-for-everyone endpoints, shared across
workers when REDIS_URL is set. (2) SharedVersion: in-process caches used to be
cleared only in the worker that handled the invalidating request; now an
invalidation writes a fresh shared version that every worker compares against
before trusting its local copy (the version itself is cached locally for one
second).
Any Redis failure degrades to the previous behaviour — a miss, or TTL-only
expiry — and never raises into the caller.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any, Callable

from app.services import shared_state

logger = logging.getLogger("prismx.shared_cache")

CACHE_PREFIX = "rc:"

# 版本号键的过期时间。版本号本不需要过期，给一个很长的 TTL 只是不让废弃的键
# 永远留在 Redis 里；过期后读作 "0"，只会多触发一次回源。/ Version keys needn't
# expire; a long TTL just keeps abandoned ones from living in Redis forever. An
# expired key reads as "0", which merely costs one extra reload.
_VERSION_TTL_SECONDS = 400 * 24 * 3600


def _k(key: str) -> str:
    return CACHE_PREFIX + key


def get_json(key: str) -> Any:
    """读缓存；未命中或 Redis 出错都返回 None。/ None on a miss or any Redis error."""
    try:
        return shared_state.kv_get_json(_k(key))
    except Exception:  # noqa: BLE001 —— 缓存读失败当未命中 / a failed read is a miss
        logger.debug("shared_cache get failed: %s", key, exc_info=True)
        return None


def set_json(key: str, value: Any, ttl: int) -> None:
    try:
        shared_state.kv_set_json(_k(key), value, ttl=ttl)
    except Exception:  # noqa: BLE001
        logger.debug("shared_cache set failed: %s", key, exc_info=True)


def delete(*keys: str) -> None:
    """主动失效。失败只记警告：键带 TTL，最坏也就是晚一个 TTL 生效。
    Invalidate; a failure only logs — every key carries a TTL, so the worst case
    is the change landing one TTL late."""
    if not keys:
        return
    try:
        shared_state.kv_delete(*[_k(k) for k in keys])
    except Exception:  # noqa: BLE001
        logger.warning("shared_cache delete failed: %s", keys, exc_info=True)


def cached_json(key: str, ttl: int, compute: Callable[[], Any]) -> Any:
    """命中就回缓存，否则 compute() 回源并写入。compute 的结果必须能 JSON 序列化，
    且**不能含任何按请求者个性化的字段**——缓存是全员共享的。

    Return the cached value or compute and store it. The value must be JSON
    serialisable and must not contain anything personalised to the requester —
    the cache is shared by everyone."""
    hit = get_json(key)
    if hit is not None:
        return hit
    value = compute()
    set_json(key, value, ttl)
    return value


class SharedVersion:
    """一个跨 worker 的失效版本号。

    用法：进程内缓存装载数据时用 `current()` 记下当时的版本（stamp），命中时用
    `is_stale(stamp)` 判断期间有没有人失效过；失效方调用 `bump()`。

    版本号必须在**回源之前**读：失效方的顺序是「先 commit，再 bump」，于是凡是拿着
    新版本号的读者，它的回源一定发生在 commit 之后，读到的是新数据；拿着旧版本号的
    读者，下一次比对就会发现版本变了。

    读不到版本号（Redis 出错）时 current() 返回上一次读到的值（从没读到过就是
    None），is_stale 对 None 一律返回 False——即退回「只按 TTL 过期」的旧行为。

    A cross-worker invalidation counter. Loaders stamp their data with
    `current()` (read *before* hitting the DB — invalidators commit first and
    bump second, so a reader holding the new version necessarily loaded
    post-commit data); hits check `is_stale(stamp)`; invalidators `bump()`.
    When the counter can't be read, the last known value (or None) is used and
    None never counts as stale, i.e. plain TTL expiry as before.
    """

    def __init__(self, name: str, local_ttl: float = 1.0) -> None:
        self._key = _k("ver:" + name)
        self._local_ttl = local_ttl
        self._lock = threading.Lock()
        self._value: str | None = None
        self._read_at = float("-inf")

    def current(self) -> str | None:
        now = time.monotonic()
        with self._lock:
            if now - self._read_at < self._local_ttl:
                return self._value
        try:
            value: str | None = shared_state.kv_get(self._key) or "0"
        except Exception:  # noqa: BLE001
            logger.debug("shared version read failed: %s", self._key, exc_info=True)
            with self._lock:
                # 出错也记下读取时刻：Redis 挂掉时每秒最多试一次，而不是每次命中都试。
                # Record the attempt too, so a dead Redis is retried once a second
                # at most rather than on every cache hit.
                self._read_at = now
                return self._value
        with self._lock:
            self._value = value
            self._read_at = now
        return value

    def is_stale(self, stamp: str | None) -> bool:
        cur = self.current()
        return cur is not None and stamp is not None and cur != stamp

    def bump(self) -> None:
        """写入一个新的随机版本串。

        用随机串而不是 INCR 计数：计数器的键一旦丢失（过期、Redis 换实例、测试里
        重置内存后端）就会从 1 重新数起，某个进程内缓存恰好记着旧的 "1" 时，一次
        真实的失效就会被误判成「没变」。随机串与任何旧 stamp 都不会相等；并发
        bump 谁最后写谁生效，结果同样与所有旧 stamp 不同。

        Write a fresh random version. Random rather than INCR: a lost counter
        (expiry, a new Redis instance, a test resetting the memory backend)
        restarts at 1, and a cache still stamped "1" would then read a real
        invalidation as "unchanged". A random token never equals an old stamp;
        with concurrent bumps the last write wins and still differs from all.
        """
        token = uuid.uuid4().hex
        try:
            shared_state.kv_set(self._key, token, ttl=_VERSION_TTL_SECONDS)
        except Exception:  # noqa: BLE001
            logger.warning("shared version bump failed: %s（其它 worker 将按 TTL 过期）",
                           self._key, exc_info=True)
            return
        with self._lock:
            # 本 worker 立刻看到新版本，不必等本地那 1 秒。
            # This worker sees the new version at once instead of after local_ttl.
            self._value = token
            self._read_at = time.monotonic()

    def reset_local(self) -> None:
        """测试用：丢掉本地缓存的版本号。/ Tests: forget the locally cached value."""
        with self._lock:
            self._value = None
            self._read_at = float("-inf")


def clear_for_tests() -> None:
    """测试用：清掉内存后端里本模块的全部键（不动 shared_state 的其它状态）。
    版本号键一并清掉也安全：缺失读作 "0"，与任何随机 stamp 都不相等。
    Tests: drop this module's keys from the memory backend, nothing else. Version
    keys may go too: a missing one reads as "0", which no random stamp equals."""
    mem = shared_state._memory
    keys = mem.keys(shared_state.PREFIX + CACHE_PREFIX)
    if keys:
        mem.delete(*keys)


# ---------------------------------------------------------------------------
# 信号读缓存的键 / signal read-cache keys
# ---------------------------------------------------------------------------
# 键放在这里而不是 routers/signals.py：信号的写入方（webhook 落库）要删这几个键，
# 而 router 之间互相 import 是本项目刻意避免的（见 services/pagination.py 的说明）。
# The keys live here rather than in routers/signals.py because the writer (the
# webhook persistence path) deletes them, and router-to-router imports are
# avoided in this project (see services/pagination.py).
SIGNAL_LIST_KEY_REALTIME = "signals:list:realtime"
SIGNAL_LIST_KEY_FREE = "signals:list:free"
SIGNAL_STATS_KEY = "signals:stats"
SIGNAL_WINRATE_KEY = "signals:winrate"


def invalidate_signal_caches() -> None:
    """新信号入库后调用：列表、每日计数、胜率（pending 数）立即对所有 worker 失效。
    判定（HIT_TP/HIT_SL/STALE）与过期不主动失效，靠各自的短 TTL（见 routers/signals.py）。
    Call after a new signal is stored. Resolution and expiry rely on the short
    TTLs instead (see routers/signals.py)."""
    delete(SIGNAL_LIST_KEY_REALTIME, SIGNAL_LIST_KEY_FREE, SIGNAL_STATS_KEY, SIGNAL_WINRATE_KEY)
