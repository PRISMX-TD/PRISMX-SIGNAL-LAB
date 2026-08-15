"""邀请链接路由：公开点击打点 + 管理员增改查 + 注册归因助手。

公开端点只有 /invite/click 一个：无论 code 是否存在、是否停用，一律 204——
不给外界任何探测 code 存活状态的信号。计数是一条条件原子 UPDATE（照
payments.py 试用抢占的写法），同时消掉读改写竞态和停用判断的时间差。

链接行永不删除（见 InviteLink 模型注释）；审计日志照平台设置的惯例写——
AdminAuditLog.target_user_id 是指向 users.id 的非空外键，拿链接当目标在
Postgres 会外键违约，所以用操作者自身占位、field 加 "invite:" 前缀区分。

Invite-link router: public click counter + admin CRUD + the registration
attribution helper. The single public endpoint always returns 204 whether or
not the code exists or is active — no liveness oracle. The counter is one
conditional atomic UPDATE (the payments.py trial-claim shape), which removes
both the lost-update race and the is_active TOCTOU. Audit rows follow the
platform-settings convention: target_user_id is a NOT NULL FK to users, so
the acting admin stands in and the "invite:" field prefix disambiguates.
"""
import json
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import InviteLink, User
from app.routers.admin import _log_change
from app.schemas import InviteClickRequest, InviteLinkCreate, InviteLinkOut, InviteLinkUpdate
from app.services.deps import require_admin

router = APIRouter(prefix="/invite", tags=["invite"])
# require_admin 在 main.py 挂载时以 router 级依赖统一施加（照 tickets.admin_router
# 的方式）——比逐端点挂 Depends 少一种「漏挂一个就裸奔」的失败模式。
# require_admin is applied router-wide at mount time in main.py (the
# tickets.admin_router pattern) — one fewer way to ship an unguarded endpoint.
admin_router = APIRouter(prefix="/admin/invite-links", tags=["admin"])

# 短码字符集：剔除易混淆的 0/O/1/l/I。8 位 ≈ 31^8 ≈ 8.5 千亿组合，随机碰撞
# 由唯一查询兜底、生成时重试。
# Code alphabet with ambiguous 0/O/1/l/I removed. 8 chars ≈ 8.5e11
# combinations; collisions are handled by the uniqueness lookup + retry.
_CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
_CODE_LENGTH = 8


def generate_code() -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LENGTH))


def new_unique_code(db: Session) -> str:
    for _ in range(10):
        code = generate_code()
        if db.query(InviteLink).filter(InviteLink.code == code).first() is None:
            return code
    # 8.5 千亿的空间里 10 连撞不可能是运气，是别的东西坏了（比如字符集被改短）。
    # Ten straight collisions in an 8.5e11 space is not luck — something broke.
    raise HTTPException(
        status_code=500,
        detail="生成邀请码失败，请重试 / Failed to generate an invite code, please retry",
    )


def record_click(db: Session, code: str) -> None:
    """点击计数：条件原子 UPDATE；未命中（不存在/已停用）静默不计。"""
    db.query(InviteLink).filter(
        InviteLink.code == code, InviteLink.is_active.is_(True)
    ).update({InviteLink.clicks: InviteLink.clicks + 1}, synchronize_session=False)
    db.commit()


def apply_invite(db: Session, user: User, ref: str | None) -> None:
    """注册归因：ref 命中活跃链接时写入备注快照与归因码。

    只应在**新建用户**的路径上调用（auth.register / google 的创建分支）。
    Google 端点是查找或创建二合一，对已存在的用户应用 ref 会覆盖管理员手写
    的备注、伪造注册来源；invite_code 已有值时也不覆盖，同一用户只归因一次。

    Call only on user-creation paths (register / google's create branch): the
    Google endpoint is find-or-create, and applying ref to an existing user
    would clobber the admin's hand-written note and fabricate attribution.
    An already-set invite_code is never overwritten either.
    """
    if not ref:
        return
    if user.invite_code is not None:
        return
    link = (
        db.query(InviteLink)
        .filter(InviteLink.code == ref, InviteLink.is_active.is_(True))
        .first()
    )
    if link is None:
        return  # 乱填/停用的 code 静默忽略，注册照常 / bad codes never block signup
    user.plan_note = link.label
    user.invite_code = link.code


def _link_out(link: InviteLink, registrations: int) -> InviteLinkOut:
    return InviteLinkOut(
        id=link.id,
        code=link.code,
        label=link.label,
        clicks=link.clicks,
        registrations=registrations,
        isActive=link.is_active,
        createdAt=link.created_at,
    )


def _audit_value(link: InviteLink) -> str:
    return json.dumps({"label": link.label, "isActive": link.is_active}, ensure_ascii=False)


@router.post("/click", status_code=204)
@limiter.limit(settings.RATE_LIMIT_INVITE_CLICK)
def click(request: Request, req: InviteClickRequest, db: Session = Depends(get_db)):
    """公开打点：一律 204，不区分 code 是否存在（防枚举探测）。"""
    record_click(db, req.code)
    return Response(status_code=204)


@admin_router.get("", response_model=dict)
def list_invite_links(db: Session = Depends(get_db)):
    # 注册人数一条 GROUP BY 全查出来，避免每行一个 COUNT 的 N+1。
    # One GROUP BY for all registration counts — no per-row COUNT N+1.
    counts = dict(
        db.query(User.invite_code, func.count(User.id))
        .filter(User.invite_code.isnot(None))
        .group_by(User.invite_code)
        .all()
    )
    links = db.query(InviteLink).order_by(InviteLink.created_at.desc()).all()
    return {
        "links": [
            _link_out(l, counts.get(l.code, 0)).model_dump(mode="json") for l in links
        ]
    }


@admin_router.post("", response_model=InviteLinkOut)
def create_invite_link(
    body: InviteLinkCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    label = body.label.strip()
    if not label:
        raise HTTPException(
            status_code=422, detail="标记名不能为空 / Label must not be empty"
        )
    link = InviteLink(code=new_unique_code(db), label=label)
    db.add(link)
    _log_change(db, admin.id, admin.id, f"invite:{link.code}", None, _audit_value(link))
    db.commit()
    db.refresh(link)
    return _link_out(link, 0)


@admin_router.patch("/{link_id}", response_model=InviteLinkOut)
def update_invite_link(
    link_id: str,
    body: InviteLinkUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    link = db.query(InviteLink).filter(InviteLink.id == link_id).first()
    if link is None:
        raise HTTPException(status_code=404, detail="链接不存在 / Link not found")
    data = body.model_dump(exclude_unset=True)
    old = _audit_value(link)
    if data.get("label") is not None:
        label = data["label"].strip()
        if not label:
            raise HTTPException(
                status_code=422, detail="标记名不能为空 / Label must not be empty"
            )
        link.label = label
    if data.get("isActive") is not None:
        link.is_active = data["isActive"]
    _log_change(db, admin.id, admin.id, f"invite:{link.code}", old, _audit_value(link))
    db.commit()
    db.refresh(link)
    registrations = (
        db.query(func.count(User.id)).filter(User.invite_code == link.code).scalar() or 0
    )
    return _link_out(link, registrations)
