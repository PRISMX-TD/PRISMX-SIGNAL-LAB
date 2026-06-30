"""安全相关：密码哈希、JWT、Token 生成 / Security: password hashing, JWT, token generation."""
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


def create_access_token(user_id: str) -> str:
    """生成 JWT 访问令牌 / Create a JWT access token."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> str | None:
    """解析 JWT，返回 user_id / Decode JWT and return user_id, or None if invalid."""
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        return payload.get("sub")
    except JWTError:
        return None


def generate_api_token() -> str:
    """生成 EA 专属 API Token / Generate a per-user API token for EA binding."""
    return "prismx_" + secrets.token_urlsafe(32)


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

    先按 token 查询，再用 secrets.compare_digest 做常量时间比较，降低时序侧信道风险。
    Query by token then re-verify with constant-time compare to reduce timing
    side-channel risk.
    """
    from app.models import User

    if not x_api_token:
        return None
    user = db.query(User).filter(User.api_token == x_api_token).first()
    if user is None:
        return None
    if not secrets.compare_digest(user.api_token or "", x_api_token):
        return None
    return user
