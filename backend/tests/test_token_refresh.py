"""JWT 滑动续期测试 / JWT sliding-renewal tests.

剩余有效期不足一半的 token 请求受保护接口时，应在 X-Refreshed-Token 头
收到新 token；新鲜 token 则不应触发续期。
A token past half-life should receive a fresh one via X-Refreshed-Token on
any authed endpoint; a fresh token should not trigger a renewal.
"""
from datetime import datetime, timedelta, timezone

from jose import jwt

from app.core.config import settings
from app.core.security import create_access_token, decode_access_token


def _token_with_ttl(user_id: str, minutes_left: float) -> str:
    """手工签发指定剩余时长的 token / craft a token with a given TTL."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=minutes_left)
    return jwt.encode(
        {"sub": user_id, "exp": expire},
        settings.JWT_SECRET,
        algorithm=settings.JWT_ALGORITHM,
    )


def test_stale_token_gets_refreshed(client, user):
    # 剩余 10 分钟 < 半衰期（默认 12 小时）→ 应下发新 token
    old = _token_with_ttl(user.id, minutes_left=10)
    res = client.get("/api/orders", headers={"Authorization": f"Bearer {old}"})
    assert res.status_code == 200
    refreshed = res.headers.get("X-Refreshed-Token")
    assert refreshed and refreshed != old
    # 新 token 可用且指向同一用户 / the new token works and maps to the same user
    assert decode_access_token(refreshed) == user.id


def test_fresh_token_not_refreshed(client, user):
    fresh = create_access_token(user.id)
    res = client.get("/api/orders", headers={"Authorization": f"Bearer {fresh}"})
    assert res.status_code == 200
    assert res.headers.get("X-Refreshed-Token") is None


def test_expired_token_rejected(client, user):
    dead = _token_with_ttl(user.id, minutes_left=-1)
    res = client.get("/api/orders", headers={"Authorization": f"Bearer {dead}"})
    assert res.status_code == 401


# ---------- API Token 哈希存储 / hashed API-token storage ----------


def test_token_reset_returns_plaintext_once_and_stores_hash(client, auth_headers, db, user):
    from app.core.security import hash_api_token

    # 查询时不回显 / reads never expose the token
    res = client.get("/api/ea/token", headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["apiToken"] is None

    # 重置返回一次明文，库中只存哈希 / reset returns plaintext once, DB keeps the hash
    res = client.post("/api/ea/token/reset", headers=auth_headers)
    raw = res.json()["apiToken"]
    assert raw and raw.startswith("prismx_")
    db.expire_all()
    assert user.api_token == hash_api_token(raw)

    # 新明文可用于桥接鉴权 / the new plaintext authenticates the bridge
    p = client.post("/api/bridge/poll", json={"accounts": []}, headers={"X-Api-Token": raw})
    assert p.status_code == 200
