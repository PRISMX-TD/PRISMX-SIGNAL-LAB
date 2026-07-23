"""认证路由：注册与登录 / Auth router: register & login."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import clear_failed_logins, is_login_locked, limiter, record_failed_login
from app.core.security import (
    create_access_token,
    generate_api_token,
    hash_api_token,
    hash_password,
    verify_google_id_token,
    verify_password,
)
from app.models import User
from app.schemas import AuthRequest, AuthResponse, GoogleAuthRequest, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_out(user: User) -> UserOut:
    return UserOut(id=user.id, email=user.email, role=user.role, plan=user.plan)


@router.post("/register", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_REGISTER)
def register(request: Request, req: AuthRequest, db: Session = Depends(get_db)):
    """注册新用户 / Register a new user."""
    email = req.email.lower()
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        # 统一非区分性错误，避免邮箱枚举 / generic error to avoid email enumeration
        raise HTTPException(status_code=400, detail="无法完成注册 / Unable to register")

    user = User(
        email=email,
        password_hash=hash_password(req.password),
        # 只存哈希；用户首次连接 MT5 时在绑定页生成可见 token / store the hash
        # only; the user generates a visible token on the Bind page
        api_token=hash_api_token(generate_api_token()),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user))


@router.post("/google", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_GOOGLE)
def google_login(request: Request, req: GoogleAuthRequest, db: Session = Depends(get_db)):
    """Google 登录：校验 ID Token，按邮箱找到或创建用户后签发 JWT。
    Google sign-in: verify ID token, find-or-create user by email, then issue a JWT.
    """
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="Google 登录未启用 / Google login is not enabled")

    info = verify_google_id_token(req.credential)
    if not info:
        raise HTTPException(status_code=401, detail="Google 凭证无效 / Invalid Google credential")

    email = info["email"].lower()
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        # 首次用 Google 登录：创建无密码用户，同时记下这个邮箱的 Google 身份
        # 已在此刻验证过——后面即便这个用户自己在账户设置里加了密码，这个
        # 时间戳也不会被清空，Google 登录会一直放行（见下面 elif 分支与
        # User.google_linked_at 的说明）。
        # First-time Google login: create a password-less user, and record
        # that this email's Google identity is verified as of right now — even
        # if the user later adds a password from their own account settings,
        # this timestamp is never cleared, so Google login keeps working (see
        # the elif branch below and User.google_linked_at's comment).
        user = User(
            email=email,
            password_hash=None,
            api_token=hash_api_token(generate_api_token()),
            google_linked_at=datetime.now(timezone.utc),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    elif user.password_hash is not None and user.google_linked_at is None:
        # 有密码、且这个邮箱的 Google 身份从未验证过：不能自动登入，否则任何
        # 人都可以提前用受害者邮箱注册密码账号，等受害者第一次用 Google 登录
        # 时被悄悄接入攻击者控制的账号（账号预劫持）。
        #
        # 只看"是否有密码"不够——账号本来就是靠 Google 登录创建的用户，后来
        # 自己在账户设置里加了一个密码（见 account.py 的 change_password），
        # 这个邮箱其实早就验证过，此时 google_linked_at 非空，不会走进这个
        # 分支，Google 登录照常放行。两种"有密码"的账号表面相同、实质不同，
        # 靠这个字段才分得清（详见 User 模型该列的说明）。
        #
        # This email has a password AND this email's Google identity has never
        # been verified: refuse to auto sign-in here. Otherwise an attacker
        # could pre-register the victim's email with a password of their own
        # choosing, then silently take over the account the moment the real
        # owner first tries Google sign-in (a classic account pre-hijack).
        #
        # "Has a password" alone isn't enough to decide this — an account that
        # originated from Google login and later had a password added by its
        # own owner (see account.py's change_password) has google_linked_at
        # already set, so it never reaches this branch and Google login keeps
        # working normally. The two "has a password" cases look identical but
        # aren't; this field is what tells them apart (see the column's
        # comment on the User model).
        raise HTTPException(
            status_code=409,
            detail=(
                "该邮箱已注册密码账号，请使用密码登录 / "
                "This email already has a password-protected account. Please log in with your password."
            ),
        )

    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user))


@router.post("/login", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_LOGIN)
def login(request: Request, req: AuthRequest, db: Session = Depends(get_db)):
    """用户登录 / User login."""
    email = req.email.lower()
    if is_login_locked(email):
        # 单个账号在短时间内失败次数过多：即使攻击者轮换 IP 绕过按 IP 限流，
        # 也无法继续对这一个账号撞库。
        # Too many failed attempts for this one account recently: blocks
        # credential-stuffing against a single account even if the attacker
        # rotates IPs to dodge the per-IP limiter above.
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后再试 / Too many login attempts, please try again later")

    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(req.password, user.password_hash):
        record_failed_login(email)
        raise HTTPException(status_code=401, detail="邮箱或密码错误 / Invalid email or password")

    clear_failed_logins(email)
    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user))
