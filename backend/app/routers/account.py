"""账户路由：查询个人信息、修改密码 / Account router: profile & password."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import hash_password, verify_password
from app.models import EABinding, MT5Account, User
from app.services.deps import get_current_user

router = APIRouter(prefix="/auth", tags=["account"])


class AccountInfoOut(BaseModel):
    id: str
    email: str
    hasPassword: bool
    createdAt: str | None
    mt5Accounts: list[dict]
    class Config:
        from_attributes = True


@router.get("/me", response_model=AccountInfoOut)
def get_account(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """返回当前用户的基本信息和绑定的 MT5 账号概览。"""
    bindings = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == current_user.id)
        .all()
    )
    return AccountInfoOut(
        id=current_user.id,
        email=current_user.email,
        hasPassword=current_user.password_hash is not None,
        createdAt=current_user.created_at.isoformat() if current_user.created_at else None,
        mt5Accounts=[
            {
                "login": b.login,
                "server": b.server,
                "accountName": b.account_name,
                "accountCurrency": b.account_currency,
                "balance": b.balance,
                "equity": b.equity,
                "leverage": b.leverage,
                "company": b.company,
                "online": b.online,
            }
            for b in bindings
        ],
    )


class ChangePasswordRequest(BaseModel):
    old_password: str | None = Field(None, description="旧密码（首次设置密码时可为空）")
    new_password: str = Field(..., min_length=6, max_length=128)


@router.post("/password")
def change_password(
    body: ChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """修改密码；Google 用户首次调用时为设置密码。"""
    if current_user.password_hash:
        # 已有密码 → 须校验旧密码 / existing password → verify old
        if not body.old_password:
            raise HTTPException(status_code=400, detail="需提供旧密码 / old password is required")
        if not verify_password(body.old_password, current_user.password_hash):
            raise HTTPException(status_code=403, detail="旧密码错误 / old password is wrong")
    # 设置/修改密码 / set or change password
    current_user.password_hash = hash_password(body.new_password)
    db.commit()
    return {"ok": True}
