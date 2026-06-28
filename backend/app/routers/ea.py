"""EA 绑定路由：Token 管理、MT5 账号登记、在线状态。
EA binding router: token management, MT5 account registration, online status.
"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import generate_api_token
from app.models import EABinding, User
from app.schemas import EAStatusOut, EATokenOut, MT5AccountRequest, SymbolSuffixRequest
from app.services.connection_manager import manager
from app.services.deps import get_current_user

router = APIRouter(prefix="/ea", tags=["ea"])


def _get_binding(db: Session, user_id: str) -> EABinding:
    binding = db.query(EABinding).filter(EABinding.user_id == user_id).first()
    if binding is None:
        binding = EABinding(user_id=user_id)
        db.add(binding)
        db.commit()
        db.refresh(binding)
    return binding


@router.get("/token", response_model=EATokenOut)
def get_token(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取当前用户的 API Token 与绑定账号 / get API token and bound account."""
    binding = _get_binding(db, user.id)
    return EATokenOut(apiToken=user.api_token, boundAccount=binding.mt5_login)


@router.post("/token/reset", response_model=EATokenOut)
def reset_token(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """重置 API Token（旧 Token 立即失效）/ reset API token (old token invalidated)."""
    user.api_token = generate_api_token()
    db.commit()
    db.refresh(user)
    binding = _get_binding(db, user.id)
    return EATokenOut(apiToken=user.api_token, boundAccount=binding.mt5_login)


@router.post("/account")
def register_account(
    req: MT5AccountRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """登记 MT5 账号与服务器 / register MT5 login and server."""
    binding = _get_binding(db, user.id)
    binding.mt5_login = req.mt5Login
    binding.mt5_server = req.mt5Server
    db.commit()
    return {"ok": True}


@router.post("/suffix")
def set_symbol_suffix(
    req: SymbolSuffixRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """设置该用户券商的品种后缀（如 .sc / .s）/ set broker symbol suffix."""
    binding = _get_binding(db, user.id)
    binding.symbol_suffix = (req.symbolSuffix or "").strip()
    db.commit()
    return {"ok": True, "symbolSuffix": binding.symbol_suffix}


@router.get("/status", response_model=EAStatusOut)
def ea_status(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """查询 EA 在线状态 / query EA online status."""
    binding = _get_binding(db, user.id)
    # WS 版即时连接，或轮询版近 20 秒内有心跳，均视为在线。
    # Online if WS connected, or polling EA sent a heartbeat within 20s.
    online = manager.is_ea_online(user.id)
    if not online and binding.last_heartbeat is not None:
        last = binding.last_heartbeat
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        online = (datetime.now(timezone.utc) - last) < timedelta(seconds=20)
    return EAStatusOut(
        online=online,
        mt5Login=binding.mt5_login,
        mt5Server=binding.mt5_server,
        symbolSuffix=binding.symbol_suffix or "",
        accountName=binding.account_name,
        accountCurrency=binding.account_currency,
        balance=binding.balance,
        equity=binding.equity,
        leverage=binding.leverage,
        company=binding.company,
        lastHeartbeat=binding.last_heartbeat,
    )
