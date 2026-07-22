"""安全相关：密码哈希、JWT、Token 生成 / Security: password hashing, JWT, token generation."""
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

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
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except JWTError:
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
