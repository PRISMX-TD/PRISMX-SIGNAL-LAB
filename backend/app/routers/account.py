"""账户路由：查询个人信息、修改密码、用户偏好 / Account router: profile, password & prefs."""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.core.security import hash_password, verify_password
from app.models import MT5Account, User, UserPref
from app.services.connection_manager import manager
from app.services.deps import get_current_user

router = APIRouter(prefix="/auth", tags=["account"])


class AccountInfoOut(BaseModel):
    id: str
    email: str
    plan: str
    planExpiresAt: str | None
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
        plan=current_user.plan,
        planExpiresAt=current_user.plan_expires_at.isoformat() if current_user.plan_expires_at else None,
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
    # 与注册的密码规则保持一致（≥8 位）/ same rule as registration (≥8 chars)
    new_password: str = Field(..., min_length=8, max_length=128)


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


# ---- 用户偏好（跨设备同步）/ User prefs (cross-device sync) ----


class UserPrefsOut(BaseModel):
    data: dict


class UserPrefsIn(BaseModel):
    # 整份偏好文档；前端按命名空间合并（如 {"signals": {...}}）
    # Whole prefs document; frontend merges by namespace (e.g. {"signals": {...}})
    data: dict = Field(default_factory=dict)


def _get_or_create_prefs(db: Session, user_id: str) -> UserPref:
    pref = db.query(UserPref).filter(UserPref.user_id == user_id).first()
    if not pref:
        pref = UserPref(user_id=user_id)
        db.add(pref)
        db.flush()
    return pref


@router.get("/prefs", response_model=UserPrefsOut)
def get_prefs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """返回当前用户的界面偏好 JSON（信号面板等）。"""
    pref = _get_or_create_prefs(db, current_user.id)
    try:
        data = json.loads(pref.data or "{}")
    except (json.JSONDecodeError, TypeError):
        data = {}
    return UserPrefsOut(data=data)


@router.put("/prefs", response_model=UserPrefsOut)
async def put_prefs(
    body: UserPrefsIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """整份覆盖保存当前用户的界面偏好 JSON，并实时推送给该用户其它在线设备。

    落库是阻塞的同步操作，放线程池执行，避免卡住事件循环（WS 推送/桥接轮询
    共用该循环，与 orders/bridge 的写法一致）。保存后经 WebSocket 把最新偏好推
    给该用户的所有在线连接——其它设备即时收到画线等改动；发起保存的本设备也会
    收到同一条，但前端是幂等应用、不会再回存，不会形成回环。

    Overwrite-save the prefs JSON and push it live to the user's other devices.
    The blocking DB write runs in a thread pool so it doesn't stall the event
    loop (shared by WS pushes and bridge polling, matching orders/bridge). After
    saving, the latest prefs are pushed over WebSocket to all of the user's
    connections — other devices update instantly (drawings, etc.). The device
    that saved also receives it, but the frontend applies it idempotently
    without re-saving, so there's no echo loop.
    """
    def _save() -> None:
        pref = _get_or_create_prefs(db, current_user.id)
        pref.data = json.dumps(body.data, ensure_ascii=False)
        db.commit()

    await run_in_threadpool(_save)
    await manager.push_to_client(
        current_user.id, {"type": "PREFS_UPDATE", "data": body.data}
    )
    return UserPrefsOut(data=body.data)
