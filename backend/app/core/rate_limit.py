"""限流器：基于 slowapi，按客户端 IP 维度限速。
Rate limiter: slowapi-based, keyed by client IP.
"""
import time

from slowapi import Limiter
from slowapi.util import get_remote_address

# 默认内存存储，单实例部署足够；多实例可通过 storage_uri 指向 Redis。
# In-memory storage by default (fine for a single instance); point storage_uri
# to Redis for multi-instance deployments.
limiter = Limiter(key_func=get_remote_address)

# 按邮箱维度的登录失败计数，防止攻击者轮换 IP 对单个账号撞库。
# Per-email failed-login tracker, so rotating IPs can't brute-force one account.
# In-memory (matches the limiter above); fine for a single instance.
_MAX_FAILED_ATTEMPTS = 8
_LOCKOUT_SECONDS = 300
_failed_logins: dict[str, tuple[int, float]] = {}


def is_login_locked(email: str) -> bool:
    """该邮箱是否因失败次数过多被临时锁定 / whether this email is temporarily locked out."""
    entry = _failed_logins.get(email)
    if not entry:
        return False
    count, locked_at = entry
    if count < _MAX_FAILED_ATTEMPTS:
        return False
    if time.time() - locked_at > _LOCKOUT_SECONDS:
        _failed_logins.pop(email, None)
        return False
    return True


def record_failed_login(email: str) -> None:
    count, _ = _failed_logins.get(email, (0, 0.0))
    _failed_logins[email] = (count + 1, time.time())


def clear_failed_logins(email: str) -> None:
    _failed_logins.pop(email, None)
