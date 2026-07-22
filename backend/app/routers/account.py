"""账户路由：查询个人信息、修改密码、用户偏好 / Account router: profile, password & prefs."""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.core.security import create_access_token, hash_password, verify_password
from app.models import MT5Account, User, UserPref
from app.services.connection_manager import manager
from app.services.deps import get_current_user

router = APIRouter(prefix="/auth", tags=["account"])


class AccountInfoOut(BaseModel):
    id: str
    email: str
    plan: str
    planExpiresAt: str | None
    # 当前 PRO 是否为免费试用（而非正式付费/管理员赠送）/ whether the current
    # PRO is a free trial, as opposed to a paid or admin-granted plan.
    planIsTrial: bool = False
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
        planIsTrial=bool(current_user.plan_is_trial),
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
    """修改密码；Google 用户首次调用时为设置密码。

    会话版本号（token_version）自增一次，使改密前签发的所有旧 token（包括
    已经泄露、仍在别处被使用的）立即失效——仅清客户端本地 token 做不到这点。
    本次请求自己带的 token 也会随之失效，因此响应里附带一个已盖新版本号的
    新 token，前端据此原地替换，不会把用户反手登出。

    Increments the session version (token_version) once, instantly
    invalidating every token issued before this change — including one
    that's leaked and still being used elsewhere; merely clearing the
    client's local token can't do that. This request's own token is
    invalidated by the same bump, so the response carries a freshly stamped
    token for the frontend to swap in, so changing your own password never
    logs you out.
    """
    if current_user.password_hash:
        # 已有密码 → 须校验旧密码 / existing password → verify old
        if not body.old_password:
            raise HTTPException(status_code=400, detail="需提供旧密码 / old password is required")
        if not verify_password(body.old_password, current_user.password_hash):
            raise HTTPException(status_code=403, detail="旧密码错误 / old password is wrong")
    # 设置/修改密码 / set or change password
    current_user.password_hash = hash_password(body.new_password)
    current_user.token_version = (current_user.token_version or 0) + 1
    db.commit()
    new_token = create_access_token(current_user.id, current_user.token_version)
    return {"ok": True, "token": new_token}


# ---- 用户偏好（跨设备同步）/ User prefs (cross-device sync) ----


class UserPrefsOut(BaseModel):
    data: dict


class UserPrefsIn(BaseModel):
    # 只传发生变化的那一个命名空间（如 "signals"），服务端与已存的其它命名空间
    # 合并——不再整份覆盖。此前整份覆盖时，两台设备几乎同时改了不同命名空间
    # （如手机改了筛选、电脑同时在画线）后保存的那次会用它本地那份（可能还
    # 没收到对方 WS 推来的最新值）整个覆盖掉，先保存的改动就丢了。
    # Only the namespace that changed (e.g. "signals"); the server merges it
    # into the existing document instead of overwriting the whole thing. This
    # used to be a full overwrite: if two devices changed different namespaces
    # at nearly the same time (e.g. the phone changed a filter while the
    # desktop was mid-drawing), whichever PUT landed second would overwrite
    # everything with its own (possibly stale, if it hadn't yet received the
    # other device's WS push) local copy — silently dropping the first change.
    namespace: str = Field(min_length=1, max_length=64)
    data: dict = Field(default_factory=dict)

    @field_validator("data")
    @classmethod
    def _cap_size(cls, v: dict) -> dict:
        # 偏好是界面设置/画线这类小数据，序列化后设个上限，防止把超大 JSON
        # 塞进这个每次登录都要整份读回来的字段。/ Prefs are small UI/drawing
        # settings; cap the serialized size so an oversized JSON can't be
        # stuffed into this field, which is read back in full on every login.
        if len(json.dumps(v, ensure_ascii=False)) > 256 * 1024:
            raise ValueError("偏好数据过大 / prefs payload too large")
        return v


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
    """按命名空间合并保存偏好 JSON，并把合并后的完整文档实时推送给该用户其它
    在线设备。

    只覆盖 body.namespace 对应的那一段，其它命名空间原样保留——避免两台设备
    并发改动不同命名空间时互相覆盖（见 UserPrefsIn 的说明）。落库是阻塞的
    同步操作，放线程池执行，避免卡住事件循环（WS 推送/桥接轮询共用该循环，
    与 orders/bridge 的写法一致）。推送的是合并后的完整文档而不是只有这个
    命名空间——其它设备的前端状态是整份替换的，只推局部会让它们丢失自己
    本地持有、但这次请求里没提到的其它命名空间。

    Merge-save the prefs JSON by namespace and push the merged, complete
    document live to the user's other devices.

    Only the body.namespace segment is overwritten; every other namespace is
    left untouched — this is what prevents two devices concurrently editing
    different namespaces from clobbering each other (see UserPrefsIn's
    docstring). The blocking DB write runs in a thread pool so it doesn't
    stall the event loop (shared by WS pushes and bridge polling, matching
    orders/bridge). The push carries the full merged document, not just this
    namespace — other devices replace their entire local state on receipt, so
    pushing only the changed namespace would make them drop whatever other
    namespaces they hold locally that this request never mentioned.
    """
    def _save() -> dict:
        pref = _get_or_create_prefs(db, current_user.id)
        try:
            existing = json.loads(pref.data or "{}")
        except (json.JSONDecodeError, TypeError):
            existing = {}
        if not isinstance(existing, dict):
            existing = {}
        existing[body.namespace] = body.data
        pref.data = json.dumps(existing, ensure_ascii=False)
        db.commit()
        return existing

    merged = await run_in_threadpool(_save)
    await manager.push_to_client(
        current_user.id, {"type": "PREFS_UPDATE", "data": merged}
    )
    return UserPrefsOut(data=merged)
