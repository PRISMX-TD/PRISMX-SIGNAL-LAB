"""限流器：基于 slowapi，按客户端 IP 维度限速。
Rate limiter: slowapi-based, keyed by client IP.
"""
import time

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings

# 存储后端：默认进程内内存，单实例部署足够。多实例部署时把
# RATE_LIMIT_STORAGE_URI 指向 Redis（如 redis://127.0.0.1:6379/0），否则每个实例
# 各算各的计数，等比放大攻击者可试的次数——两个实例就等于限流放宽一倍。
# Storage backend: in-process memory by default, which is fine for a single
# instance. For multi-instance deployments point RATE_LIMIT_STORAGE_URI at Redis
# (e.g. redis://127.0.0.1:6379/0); otherwise each instance counts separately and
# the effective limit is multiplied by the instance count.
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=settings.RATE_LIMIT_STORAGE_URI or None,
)

# ---------------------------------------------------------------------------
# 失败计数与临时锁定 / failed-attempt tracking and temporary lockout
#
# 用途是限流器挡不住的那一类攻击：攻击者轮换出口 IP，对**同一个标的**（一个邮箱、
# 一个 MT5 账号）持续撞库。按 IP 的限流对此完全无效，必须按标的本身计数。
#
# 同限流器一样是进程内状态：多实例部署时每个实例各持一份计数，锁定阈值被实例数
# 稀释。真要多实例，这份状态也应随 RATE_LIMIT_STORAGE_URI 一起迁到 Redis。
#
# Covers the attack the IP limiter cannot: rotating egress IPs against one
# *target* (a single email, a single MT5 login). Per-IP limits do nothing there,
# so the count has to be keyed by the target itself. Like the limiter, this is
# in-process state — multi-instance deployments dilute the threshold by the
# instance count and should move it to Redis alongside the limiter.
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

_failures: dict[tuple[str, str], tuple[int, float]] = {}


def _is_locked(namespace: str, key: str) -> bool:
    max_attempts, lockout_seconds = _POLICIES[namespace]
    entry = _failures.get((namespace, key))
    if not entry:
        return False
    count, locked_at = entry
    if count < max_attempts:
        return False
    if time.time() - locked_at > lockout_seconds:
        _failures.pop((namespace, key), None)
        return False
    return True


def _record_failure(namespace: str, key: str) -> None:
    count, _ = _failures.get((namespace, key), (0, 0.0))
    _failures[(namespace, key)] = (count + 1, time.time())


def _clear_failures(namespace: str, key: str) -> None:
    _failures.pop((namespace, key), None)


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
