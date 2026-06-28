"""认证依赖与风控 / Auth dependencies and risk control."""
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.security import decode_access_token
from app.models import Order, User


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """从 Authorization: Bearer <token> 解析当前用户 / resolve current user from JWT."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="缺少凭证 / Missing token")
    token = authorization.split(" ", 1)[1]
    user_id = decode_access_token(token)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="凭证无效 / Invalid token")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在 / User not found")
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
