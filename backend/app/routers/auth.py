"""认证路由：注册与登录 / Auth router: register & login."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    create_access_token,
    generate_api_token,
    hash_password,
    verify_password,
)
from app.models import EABinding, User
from app.schemas import AuthRequest, AuthResponse, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=AuthResponse)
def register(req: AuthRequest, db: Session = Depends(get_db)):
    """注册新用户 / Register a new user."""
    existing = db.query(User).filter(User.email == req.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="邮箱已注册 / Email already registered")

    user = User(
        email=req.email,
        password_hash=hash_password(req.password),
        api_token=generate_api_token(),
    )
    db.add(user)
    db.flush()
    # 同时创建一条空的 EA 绑定记录 / create an empty EA binding row
    db.add(EABinding(user_id=user.id))
    db.commit()
    db.refresh(user)

    token = create_access_token(user.id)
    return AuthResponse(token=token, user=UserOut(id=user.id, email=user.email))


@router.post("/login", response_model=AuthResponse)
def login(req: AuthRequest, db: Session = Depends(get_db)):
    """用户登录 / User login."""
    user = db.query(User).filter(User.email == req.email).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="邮箱或密码错误 / Invalid email or password")

    token = create_access_token(user.id)
    return AuthResponse(token=token, user=UserOut(id=user.id, email=user.email))
