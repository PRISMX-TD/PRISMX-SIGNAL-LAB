"""安全相关：密码哈希、JWT、Token 生成 / Security: password hashing, JWT, token generation."""
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.core.config import settings

logger = logging.getLogger("prismx.security")


def _to_72(password: str) -> bytes:
    """bcrypt 仅支持前 72 字节，超长则截断 / bcrypt only uses first 72 bytes."""
    return password.encode("utf-8")[:72]


def hash_password(password: str) -> str:
    """对密码进行哈希 / Hash a plain password."""
    return bcrypt.hashpw(_to_72(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str | None) -> bool:
    """校验密码 / Verify a password against its hash."""
    if not hashed:
        # 无密码用户（如 Google 登录）不能用密码登录 / password-less users can't password-login
        return False
    try:
        return bcrypt.checkpw(_to_72(plain), hashed.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(user_id: str, token_version: int = 0) -> str:
    """生成 JWT 访问令牌 / Create a JWT access token.

    token_version 写入 "tv" 字段：改密码时用户的会话版本号自增一次，之后
    get_current_user 会拒绝任何 tv 与当前值不符的旧 token——这是撤销"改密码
    前已签发、可能已泄露"的 token 的唯一途径（JWT 本身在过期前无法单独撤销）。
    token_version is stamped into the "tv" claim: incrementing the user's
    session version on password change makes get_current_user reject any
    older token whose tv no longer matches — the only way to revoke a token
    issued (and possibly leaked) before the change, since a JWT can't be
    individually revoked before it expires.
    """
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
    payload = {"sub": user_id, "exp": expire, "tv": token_version}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> str | None:
    """解析 JWT，返回 user_id / Decode JWT and return user_id, or None if invalid."""
    payload = decode_token_payload(token)
    return payload.get("sub") if payload else None


def decode_token_payload(token: str) -> dict | None:
    """解析 JWT，返回完整载荷（含 sub 与 exp），无效返回 None。
    Decode a JWT and return its full payload (sub & exp); None if invalid."""
    # PyJWT：过期、签名错、格式错都是 PyJWTError 的子类，一并按"无效"处理。
    # 只允许配置里那一种算法（HS256），拒绝 token 头里自报的其它算法——这正是
    # 旧库 python-jose 3.3.0 曾出过的那类算法混淆问题。
    # PyJWT: expiry, bad signature and malformed tokens are all PyJWTError
    # subclasses. Only the configured algorithm is accepted; whatever the token
    # header claims is ignored — the algorithm-confusion class of bug the old
    # python-jose 3.3.0 dependency was known for.
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


def generate_api_token() -> str:
    """生成 EA 专属 API Token / Generate a per-user API token for EA binding."""
    return "prismx_" + secrets.token_urlsafe(32)


def hash_api_token(raw: str) -> str:
    """API Token 的存储哈希：数据库只存 SHA-256，泄库也无法冒充 Bridge。
    Token 本身是 32 字节强随机值，熵足够高，无需 bcrypt 这类慢哈希。
    Storage hash for API tokens: only the SHA-256 lands in the DB, so a DB
    leak can't be used to impersonate a bridge. The token is 32 bytes of
    strong randomness, so a fast hash is sufficient (no bcrypt needed).
    """
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def rotate_api_token(user) -> str | None:
    """给用户换一个全新的桥接 API Token（只落哈希，明文当场丢弃），返回**旧的哈希**。

    改密码 / 重置密码时调用：这两件事的前提都是「账号可能落到了别人
    手里」，而桥接 Token 是另一把能下单的钥匙——只让 JWT 失效、不换它，拿到 Token 的
    人照样能通过 Bridge 操作账户。明文不返回：用户之后在绑定页点「重置 Token」拿一个
    新的即可（同 /ea/token/reset）。调用方 commit 之后必须拿返回的旧哈希调用
    routers.bridge.invalidate_auth_cache_for_hash，否则旧 Token 还能在桥接鉴权缓存里
    活到 TTL。旧值为空也安全（invalidate 对 None 直接返回）。
    Rotate the bridge API token (hash stored, plaintext discarded) and return the
    OLD hash. Used on password change / reset: each assumes
    the account may be in someone else's hands, and the bridge token is a second
    key that can trade. The user gets a fresh visible token later from the Bind
    page. After committing, callers must pass the old hash to
    routers.bridge.invalidate_auth_cache_for_hash; a None old value is harmless."""
    old_hash = user.api_token
    user.api_token = hash_api_token(generate_api_token())
    return old_hash


def invalidate_bridge_token_cache(old_hash: str | None) -> None:
    """commit 之后清掉旧 Token 在桥接鉴权缓存里的条目（并让所有 worker 换版本号）。
    懒导入：core 不在模块级依赖 routers。失败只记警告——缓存 TTL 约 10 秒，最坏晚这么久。
    After the commit, drop the old token from the bridge auth cache on every
    worker. Lazy import (core must not depend on routers at import time); a
    failure only logs — the cache TTL is ~10s."""
    if not old_hash:
        return
    try:
        from app.routers.bridge import invalidate_auth_cache_for_hash

        invalidate_auth_cache_for_hash(old_hash)
    except Exception:  # noqa: BLE001
        logger.warning("桥接鉴权缓存失效失败 / bridge auth cache invalidation failed", exc_info=True)


def verify_google_id_token(credential: str) -> dict | None:
    """校验 Google ID Token，返回其载荷（含 email、sub 等）/ Verify a Google ID token.

    用 Google 官方库按配置的 GOOGLE_CLIENT_ID 校验签名、签发方与受众。
    校验失败（无效、过期、aud 不符等）返回 None。
    Validates signature, issuer and audience against GOOGLE_CLIENT_ID via Google's
    official library. Returns None on any failure (invalid/expired/wrong aud).
    """
    if not settings.GOOGLE_CLIENT_ID:
        return None
    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token

        info = id_token.verify_oauth2_token(
            credential,
            google_requests.Request(),
            settings.GOOGLE_CLIENT_ID,
        )
        # 仅接受已验证邮箱的 Google 账号 / only accept verified-email Google accounts
        if info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
            return None
        if not info.get("email") or not info.get("email_verified"):
            return None
        return info
    except Exception as exc:
        logger.warning("Google ID token verification failed: %r", exc)
        return None


def authenticate_api_token(db, x_api_token: str | None):
    """按 API Token 鉴权，返回 User 或 None / authenticate by API token.

    数据库存的是 SHA-256 哈希：先把传入的 token 哈希后查询，再用
    secrets.compare_digest 做常量时间比较，降低时序侧信道风险。
    The DB stores the SHA-256 hash: hash the incoming token, query by the
    hash, then re-verify with a constant-time compare to reduce timing
    side-channel risk.
    """
    from app.models import User

    if not x_api_token:
        return None
    hashed = hash_api_token(x_api_token)
    user = db.query(User).filter(User.api_token == hashed).first()
    if user is None:
        return None
    if not secrets.compare_digest(user.api_token or "", hashed):
        return None
    return user
