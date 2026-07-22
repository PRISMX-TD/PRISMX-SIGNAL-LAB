"""认证路由：注册与登录 / Auth router: register & login."""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
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
        # 首次用 Google 登录：创建无密码用户。
        # First-time Google login: create a password-less user.
        user = User(
            email=email,
            password_hash=None,
            api_token=hash_api_token(generate_api_token()),
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user))


@router.post("/login", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_LOGIN)
def login(request: Request, req: AuthRequest, db: Session = Depends(get_db)):
    """用户登录 / User login."""
    email = req.email.lower()
    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="邮箱或密码错误 / Invalid email or password")

    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user))
