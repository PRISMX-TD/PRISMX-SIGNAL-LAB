"""客服写接口都有按用户的频率上限（2026-11-18 审计：support.py 原来一个限流都没有）。

Every support write endpoint carries a per-user rate limit (the 2026-11-18 audit found
support.py had none).
"""
from app.core.strategy_limits import user_limiter
from app.routers import support

from tests.test_support_desk import _auth, client, db, people  # noqa: F401


def test_every_support_write_route_is_rate_limited():
    limited = set(getattr(user_limiter, "_route_limits", {}).keys())
    missing = []
    for r in support.router.routes:
        methods = getattr(r, "methods", set()) or set()
        if not methods & {"POST", "PUT", "PATCH", "DELETE"}:
            continue
        fn = r.endpoint
        if f"{fn.__module__}.{fn.__name__}" not in limited:
            missing.append(f"{sorted(methods)} {r.path}")
    assert not missing, missing


def test_support_writes_return_429_past_the_limit(client, people):
    user_limiter.reset()
    admin, c = people["admin"], people["customer"]
    url = f"/api/support/users/{c.id}/do-not-contact"
    codes = [client.post(url, headers=_auth(admin)).status_code for _ in range(31)]
    assert codes[:30].count(429) == 0
    assert codes[30] == 429
    user_limiter.reset()
