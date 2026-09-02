"""账户路由：查询个人信息、修改密码、用户偏好 / Account router: profile, password & prefs."""
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.core.security import create_access_token, hash_password, verify_password
from app.models import MT5Account, User, UserPref
from app.schemas import PhoneRequest, ProfilePatchIn, UserOut
from app.services.phone import compose_phone
from app.services.connection_manager import manager
from app.services.deps import get_current_user
from app.services.settings_store import get_gamification_settings

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
    # 游戏化（设计 §6/§11）：功能是否对该用户可见 + 4 个资料字段，供前端
    # 一次性拿到而不必再单独请求 /gamification/me 才知道要不要显示入口。
    # Gamification: whether the feature is visible to this user, plus 4
    # profile fields — so the frontend knows whether to show the entry point
    # without a separate /gamification/me round trip.
    gamificationVisible: bool = False
    leaderboardVisible: bool = False
    competitionsVisible: bool = False
    nickname: str | None = None
    nicknamePublic: bool = False
    leaderboardOptOut: bool = False
    equippedBadge: str | None = None
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
        gamificationVisible=(
            True if current_user.role == "admin"
            else bool(get_gamification_settings(db).get("user_visible"))
        ),
        leaderboardVisible=(
            True if current_user.role == "admin"
            else bool(get_gamification_settings(db).get("leaderboard_visible"))
        ),
        competitionsVisible=(
            True if current_user.role == "admin"
            else bool(get_gamification_settings(db).get("competitions_visible"))
        ),
        nickname=current_user.nickname,
        nicknamePublic=bool(current_user.nickname_public),
        leaderboardOptOut=bool(current_user.leaderboard_opt_out),
        equippedBadge=current_user.equipped_badge,
    )


def _apply_profile_patch(db: Session, user: User, body: ProfilePatchIn) -> User:
    """局部更新游戏化资料四个字段；只处理 body 里实际传了的字段。

    用 model_fields_set 而不是 `is not None` 判断「是否传了这个字段」——
    equippedBadge 显式传 null（卸下）与没传（不变）语义不同，只有前者才能
    这样区分。校验（昵称长度/保留词、勋章持有）在赋值前做，一旦某个字段
    校验失败就直接抛 400，此前（如果有）已赋的字段仍停留在 session 里但
    还没 commit——请求整体失败，调用方看到的是纯粹的错误响应，不会有「改了
    一半」的落库结果。

    Partially updates the 4 gamification profile fields — only fields actually
    present in body are touched. Uses model_fields_set rather than `is not
    None` to tell "field sent" from "field absent": equippedBadge sent as null
    (unequip) is semantically different from omitted (untouched), and only
    fields_set can distinguish the two. Validation (nickname length/reserved
    word, badge ownership) happens before assignment; if a field's validation
    fails partway through, any earlier assignment this call made is still
    sitting in the session but never committed — the whole request fails and
    the caller only sees the error response, never a half-applied write.
    """
    from app.models import UserBadge
    from app.services.gamification import nickname_reserved

    sent = body.model_fields_set
    if "nickname" in sent:
        nick = (body.nickname or "").strip()
        if not (2 <= len(nick) <= 20):
            raise HTTPException(400, "昵称需 2-20 个字符 / Nickname must be 2-20 characters")
        if nickname_reserved(nick):
            raise HTTPException(400, "昵称包含保留词 / Nickname contains a reserved word")
        user.nickname = nick
    if "nicknamePublic" in sent and body.nicknamePublic is not None:
        user.nickname_public = body.nicknamePublic
    if "leaderboardOptOut" in sent and body.leaderboardOptOut is not None:
        user.leaderboard_opt_out = body.leaderboardOptOut
    if "equippedBadge" in sent:
        if body.equippedBadge is None:
            user.equipped_badge = None
        else:
            owned = (
                db.query(UserBadge.id)
                .filter(UserBadge.user_id == user.id, UserBadge.badge_id == body.equippedBadge)
                .first()
            )
            if owned is None:
                raise HTTPException(400, "尚未获得该勋章 / Badge not earned yet")
            user.equipped_badge = body.equippedBadge
    db.commit()
    db.refresh(user)
    return user


@router.patch("/profile")
@limiter.limit(settings.RATE_LIMIT_PASSWORD)
def patch_profile(
    request: Request,
    body: ProfilePatchIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """局部更新昵称/隐私开关/佩戴勋章，只改传了的字段。"""
    u = _apply_profile_patch(db, current_user, body)
    return {
        "nickname": u.nickname,
        "nicknamePublic": u.nickname_public,
        "leaderboardOptOut": u.leaderboard_opt_out,
        "equippedBadge": u.equipped_badge,
    }


@router.post("/phone", response_model=UserOut)
@limiter.limit(settings.RATE_LIMIT_PASSWORD)
def set_phone(
    request: Request,
    req: PhoneRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """补录手机号。Google 注册的用户首次登录后被拦在这一步。

    只允许「从无到有」，不允许改号：改号是另一件事（要防账号被接管后悄悄换掉
    联系方式），需要验证旧号码或密码，不该混在这个为了走完注册流程而存在的
    接口里。已经有号码的用户调这里直接拒。

    Fill in a missing phone. Google-created users are gated here on first login.
    Only ever fills a blank — changing an existing number is a different operation
    (an attacker who took over an account must not be able to quietly swap the
    contact details) and needs its own verified flow.
    """
    if current_user.phone:
        raise HTTPException(
            status_code=409,
            detail="手机号已存在，如需修改请联系客服 / Phone already set; contact support to change it",
        )

    phone = compose_phone(req.phoneCountry, req.phone)
    if not phone:
        raise HTTPException(
            status_code=422,
            detail="手机号格式不正确，请检查区号与号码 / Invalid phone number — check the dial code and number",
        )

    current_user.phone = phone
    db.commit()
    db.refresh(current_user)

    return UserOut(
        id=current_user.id,
        email=current_user.email,
        role=current_user.role,
        plan=current_user.plan,
        phone=current_user.phone,
        needsPhone=False,
    )


class ChangePasswordRequest(BaseModel):
    old_password: str | None = Field(None, description="旧密码（首次设置密码时可为空）")
    # 与注册的密码规则保持一致（≥8 位）/ same rule as registration (≥8 chars)
    new_password: str = Field(..., min_length=8, max_length=128)


@router.post("/password")
@limiter.limit(settings.RATE_LIMIT_PASSWORD)
def change_password(
    request: Request,
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
