"""认证依赖与风控 / Auth dependencies and risk control."""
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token, decode_token_payload
from app.models import User
from app.services.plan_expiry import downgrade_if_expired

# 滑动续期响应头：token 剩余有效期不足一半时，经此头下发新 token，
# 前端收到后自动替换本地 token，实现无感续期（不再每天被踢下线）。
# Sliding-renewal header: when the token has less than half its lifetime
# left, a fresh token is issued via this header; the frontend swaps it in
# silently so active users are never forced to re-login.
REFRESHED_TOKEN_HEADER = "X-Refreshed-Token"

# 账号在线判定窗口（秒）：桥接每 1.5 秒轮询一次，留 3 个周期容错，
# 既能快速反映断线（约 6~7 秒内置灰），又不会因偶发丢包误判离线。
# Online window (s): bridge polls every 1.5s; allow ~3 missed cycles so a
# disconnect is reflected within ~6-7s without flapping on a single drop.
ONLINE_WINDOW = 7

# last_active_at 落库节流窗口（秒）：DAU 只需要"今天活跃与否"的精度，
# 没必要每个请求都触发一次 UPDATE。
# Throttle window (s) for persisting last_active_at: DAU only needs
# day-level precision, so there's no need to UPDATE on every single request.
LAST_ACTIVE_THROTTLE_SECONDS = 300


def is_account_online(row) -> bool:
    """按最近心跳判断一个 MT5 账号是否在线 / whether an MT5 account is online
    based on its last heartbeat (row is an MT5Account)."""
    if not row.last_heartbeat:
        return False
    last = row.last_heartbeat
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - last).total_seconds() < ONLINE_WINDOW


def get_current_user(
    response: Response,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """从 Authorization: Bearer <token> 解析当前用户 / resolve current user from JWT."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="缺少凭证 / Missing token")
    token = authorization.split(" ", 1)[1]
    payload = decode_token_payload(token)
    user_id = payload.get("sub") if payload else None
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="凭证无效 / Invalid token")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在 / User not found")

    # 会员到期即时生效：本人任一带凭证请求都会自愈等级——到期后第一次请求就把
    # plan 落库改回 FREE，之后所有 is_realtime_plan(user.plan) 等判断自然看到 FREE。
    # 不发请求、但仍被 WS 广播/推送直接按 DB plan 命中的在线用户，由后台
    # plan_expiry_sweep_loop 兜底。
    # Membership expiry takes effect immediately: any authenticated request by
    # the user self-heals — the first request after expiry persists plan back to
    # FREE, so every downstream is_realtime_plan(user.plan) check sees FREE.
    # Users who don't make requests but are still hit by WS broadcast/push via
    # the DB plan are covered by the background plan_expiry_sweep_loop.
    if downgrade_if_expired(db, user):
        db.commit()

    # 滑动续期：剩余有效期不足一半则下发新 token / sliding renewal at half-life
    exp = payload.get("exp")
    if isinstance(exp, (int, float)):
        remaining = exp - datetime.now(timezone.utc).timestamp()
        if remaining < settings.JWT_EXPIRE_MINUTES * 60 / 2:
            response.headers[REFRESHED_TOKEN_HEADER] = create_access_token(user.id)

    _touch_last_active(db, user)
    return user


def _touch_last_active(db: Session, user: User) -> None:
    """限流写入 last_active_at：同一用户 5 分钟内只落库一次，供 DAU 统计用。
    Throttled last_active_at write: at most once per 5 minutes per user, for DAU."""
    now = datetime.now(timezone.utc)
    last = user.last_active_at
    if last is not None:
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if (now - last).total_seconds() < LAST_ACTIVE_THROTTLE_SECONDS:
            return
    user.last_active_at = now
    db.commit()


def require_admin(user: User = Depends(get_current_user)) -> User:
    """要求当前用户具备管理员权限（role == "admin"）。
    Require the current user to hold admin rights (role == "admin")."""
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限 / Admin privileges required")
    return user


def validate_order(symbol: str, side: str, volume: float, equity: float | None = None) -> None:
    """服务端下单风控校验 / server-side order risk validation.

    equity 提供时，按"每手所需净值"粗估手数上限，防止小余额账户过度下单。
    When equity is provided, cap the lot size by a rough equity-per-lot rule to
    prevent over-sized orders on small accounts.
    """
    if side not in ("BUY", "SELL"):
        raise HTTPException(status_code=400, detail="方向无效 / Invalid side")
    if not symbol or len(symbol) > 20:
        raise HTTPException(status_code=400, detail="品种无效 / Invalid symbol")
    if volume < settings.MIN_VOLUME_PER_ORDER:
        raise HTTPException(
            status_code=400,
            detail=f"低于单笔最小手数 {settings.MIN_VOLUME_PER_ORDER} / Below min volume",
        )
    if volume > settings.MAX_VOLUME_PER_ORDER:
        raise HTTPException(
            status_code=400,
            detail=f"超过单笔最大手数 {settings.MAX_VOLUME_PER_ORDER} / Exceeds max volume",
        )
    # 按净值粗估手数上限 / rough equity-based lot cap
    if equity is not None and equity > 0 and settings.EQUITY_PER_LOT > 0:
        max_by_equity = equity / settings.EQUITY_PER_LOT
        if volume > max_by_equity:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"手数超过账户净值可承受上限（约 {max_by_equity:.2f} 手）"
                    f" / Volume exceeds equity-based cap (~{max_by_equity:.2f} lots)"
                ),
            )
