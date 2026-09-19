"""限流器：基于 slowapi，按客户端 IP 维度限速。
Rate limiter: slowapi-based, keyed by client IP.
"""
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.services import shared_state

# 存储后端：默认进程内内存，单实例部署足够。多实例部署必须指向 Redis，否则每个
# 实例各算各的计数，等比放大攻击者可试的次数——两个实例就等于限流放宽一倍。
#
# 取值走 shared_state.redis_url()，不直接读 RATE_LIMIT_STORAGE_URI：文档与
# config.py 的启动闸门都以 REDIS_URL 为「开多 worker 的那一个开关」，只读老键
# 的话，照文档只配 REDIS_URL 的部署会拿到进程内存储，而启动闸门看到 REDIS_URL
# 非空就放行——限流被 worker 数静默稀释且无人报警，正是那道闸门要消灭的降级。
# redis_url() 已实现「REDIS_URL 优先、回落 RATE_LIMIT_STORAGE_URI」的取值逻辑。
#
# Storage backend: in-process memory by default, fine for a single instance;
# multi-instance deployments must point at Redis or each instance counts
# separately and the effective limit is multiplied by the instance count.
#
# The URI comes from shared_state.redis_url() rather than RATE_LIMIT_STORAGE_URI
# directly: both the docs and config.py's startup gate treat REDIS_URL as *the*
# switch that makes multiple workers supported. Reading only the older key would
# leave a REDIS_URL-only deployment (the documented one) on memory storage while
# the gate happily lets it start — the silent, unalarmed degradation that gate
# exists to prevent. redis_url() already implements "REDIS_URL first, else
# RATE_LIMIT_STORAGE_URI".
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=shared_state.redis_url() or None,
)

# ---------------------------------------------------------------------------
# 失败计数与临时锁定 / failed-attempt tracking and temporary lockout
#
# 用途是限流器挡不住的那一类攻击：攻击者轮换出口 IP，对**同一个标的**（一个邮箱、
# 一个 MT5 账号）持续撞库。按 IP 的限流对此完全无效，必须按标的本身计数。
#
# 计数放在 services/shared_state：配了 REDIS_URL 就是全体 worker 共享的一份，没配
# 就是进程内内存（与从前的 dict 行为一致）。键带过期：距最后一次失败超过锁定时长
# 就整条清掉，所以阈值以下的失败也会在安静一段时间后归零——比原来「永不遗忘」
# 更合理，也免得 Redis 里堆积键。
#
# Covers the attack the IP limiter cannot: rotating egress IPs against one
# *target* (a single email, a single MT5 login). Per-IP limits do nothing there,
# so the count has to be keyed by the target itself. Like the limiter, this is
# in-process state — multi-instance deployments dilute the threshold by the
# instance count. Counters now live in services/shared_state: one shared copy
# across workers with REDIS_URL, in-process memory otherwise. Entries expire a
# lockout-window after the last failure, so sub-threshold counts reset after a
# quiet spell (saner than "never forget", and no key pile-up in Redis).
# ---------------------------------------------------------------------------

# (最大失败次数, 锁定秒数) / (max failures, lockout seconds), per namespace
_POLICIES: dict[str, tuple[int, int]] = {
    "login": (8, 300),
    # MT5 账号验证比登录更严：这个端点把「账号+密码」转发给券商 Manager API 验证，
    # 等于让平台替攻击者去券商侧撞库。正常用户绑定账号时不会连错 5 次，而 15 分钟
    # 的锁定足以让全量账号号段的枚举变得不可行。
    # Stricter than login: this endpoint forwards login+password to the broker's
    # Manager API, which would make the platform a brute-force proxy against the
    # broker. Real users don't mistype five times, and a 15-minute lockout makes
    # sweeping the broker's login range impractical.
    "mt5_verify": (5, 900),
}

def _lock_key(namespace: str, key: str) -> str:
    return f"lockout:{namespace}:{key}"


def _read(namespace: str, key: str) -> int | None:
    """当前失败计数；键不存在或已过期返回 None。
    The current failure count; None when the entry is absent or expired."""
    raw = shared_state.kv_get(_lock_key(namespace, key))
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        # 升级前留在 Redis 里的旧格式（[count, 时间戳] 的 JSON）。当作"没有计数"，
        # 下一次失败会用新格式重建——这些键最长只活一个锁定窗口，不值得为它写
        # 兼容读取路径。/ Pre-upgrade entries used a [count, ts] JSON list. Treat
        # them as absent; the next failure rebuilds the key in the new format, and
        # they live at most one lockout window anyway.
        return None


def _is_locked(namespace: str, key: str) -> bool:
    max_attempts, _lockout_seconds = _POLICIES[namespace]
    count = _read(namespace, key)
    # 不再单独比对"锁定时刻 + 窗口"：键本身带着滑动过期（见 _record_failure），
    # 键还在就说明距最后一次失败不足一个窗口，过期判定由存储后端唯一裁定，
    # 避免两处各算一遍时间。
    # No separate "locked_at + window" comparison: the key carries a sliding
    # expiry (see _record_failure), so its mere presence means the last failure
    # is less than one window ago. One arbiter of expiry instead of two.
    return count is not None and count >= max_attempts


def _record_failure(namespace: str, key: str) -> None:
    _max_attempts, lockout_seconds = _POLICIES[namespace]
    # 原子自增，不是"读出来加一再写回"：同一个邮箱 / MT5 账号被并发撞库时，多个
    # worker（或同进程多线程）会读到同一个旧值，写回后实际只记了一次失败——阈值
    # 就按并发数被放大。INCR 由 Redis 单线程串行执行，内存后端也在同一把锁里做，
    # 每一次失败都算得上。
    # An atomic increment rather than read-modify-write: under a concurrent
    # credential-stuffing burst against one email / MT5 login, several workers (or
    # threads) read the same stale value and the writes collapse into one, which
    # inflates the effective threshold by the concurrency. INCR is serialised by
    # Redis, and the memory backend does it under its own lock, so every failure
    # counts.
    #
    # refresh=True 保持原来的"距最后一次失败一个窗口后整条归零"语义：不刷新的话
    # 过期时间只由第一次失败决定，攻击者可以卡着窗口边界让计数周期性清零。
    # refresh=True keeps the original "expires one window after the *last*
    # failure" semantics; without it the expiry is pinned to the first failure and
    # an attacker could ride the window boundary to reset the count.
    shared_state.incr_with_ttl(_lock_key(namespace, key), lockout_seconds + 1, refresh=True)


def _clear_failures(namespace: str, key: str) -> None:
    shared_state.kv_delete(_lock_key(namespace, key))


class _FailuresCompat:
    """老测试写 `rate_limit._failures.clear()` 清状态；保留这个名字，清的是共享状态。
    Kept for tests that call `_failures.clear()`; resets the shared-state backend."""

    def clear(self) -> None:
        shared_state.reset_for_tests()


_failures = _FailuresCompat()


# ---- 登录 / login ----


def is_login_locked(email: str) -> bool:
    """该邮箱是否因失败次数过多被临时锁定 / whether this email is temporarily locked out."""
    return _is_locked("login", email)


def record_failed_login(email: str) -> None:
    _record_failure("login", email)


def clear_failed_logins(email: str) -> None:
    _clear_failures("login", email)


# ---- MT5 账号验证 / MT5 account verification ----


def is_mt5_verify_locked(login: int | str) -> bool:
    """该 MT5 账号是否因验证失败过多被临时锁定 / whether this MT5 login is locked out."""
    return _is_locked("mt5_verify", str(login))


def record_failed_mt5_verify(login: int | str) -> None:
    _record_failure("mt5_verify", str(login))


def clear_failed_mt5_verify(login: int | str) -> None:
    _clear_failures("mt5_verify", str(login))
