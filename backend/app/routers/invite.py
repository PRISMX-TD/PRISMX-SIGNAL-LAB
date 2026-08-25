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
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import InviteLink, User
from app.routers.admin import _log_change
from app.schemas import InviteClickRequest, InviteLinkCreate, InviteLinkOut, InviteLinkUpdate
from app.services.deps import require_admin
from app.services.settings_store import get_trial_settings

router = APIRouter(prefix="/invite", tags=["invite"])
# require_admin 是**两处都挂**，不是二选一：main.py 挂载时的 router 级依赖是兜底
# （漏写逐端点声明也不会裸奔），下面每个端点再各自声明一次，让路由函数自己就能
# 看出它是管理员专属的。tickets.admin_router 也是这么做的。FastAPI 对同一个依赖
# 在单次请求内只求值一次，重复声明不会多打一次库。
# 别把这里改写成「只在挂载点声明」——那会让人以为端点上的 Depends 是冗余的而
# 顺手删掉，于是安全性就全押在 main.py 那一行上了。
# require_admin is declared in *both* places, not either/or: the router-level
# dependency at mount time in main.py is the backstop (a forgotten per-endpoint
# dep can never ship an open endpoint), and each endpoint below declares it
# again so the guard is visible at the handler itself. tickets.admin_router does
# the same. FastAPI caches identical dependencies per request, so the repetition
# costs no extra DB work. Do not rewrite this as "declared at mount only" — that
# reads as if the per-endpoint deps were redundant and invites deleting them.
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


def _normalize_code(code: str) -> str:
    """查库前统一去空白转小写。

    _CODE_ALPHABET 全小写，大写字母永远不可能是真码，所以这个归一是无损的。
    不做的话：二维码/短链/印刷物料链路上任何一段做过大小写归一（有的工具会），
    或者有人照着单子手抄时抄成大写，SQLite 与 Postgres 的比较都是大小写敏感的，
    于是一个字不差也查不到。而打点端一律 204、坏 ref 又从不拦注册，归因丢了
    没有任何一处会报警——只会表现为"这条链接的数据莫名其妙是零"。

    Normalize before lookup. _CODE_ALPHABET is lowercase-only, so an uppercase
    character can never be part of a real code and folding case is lossless.
    Without it, a code that passed through any case-normalizing QR / short-link
    / print pipeline — or was retyped by hand — matches nothing, because the
    comparison is case-sensitive on both SQLite and Postgres. And since the
    click endpoint always returns 204 and a bad ref never blocks signup, the
    lost attribution raises no signal anywhere: it just looks like a link that
    inexplicably scored zero.
    """
    return code.strip().lower()


def record_click(db: Session, code: str) -> None:
    """点击计数：条件原子 UPDATE；未命中（不存在/已停用）静默不计。"""
    db.query(InviteLink).filter(
        InviteLink.code == _normalize_code(code), InviteLink.is_active.is_(True)
    ).update({InviteLink.clicks: InviteLink.clicks + 1}, synchronize_session=False)
    db.commit()


def _active_link(db: Session, code: str) -> InviteLink | None:
    """按码查一条活跃链接；不存在或已停用返回 None。

    apply_invite 与 offer_days 共用本函数，保证两边看到的"这个码是否可用"
    永远是同一次查询逻辑，不会因为以后加过期时间、点击上限之类的条件时
    只改了一边而分叉。record_click 不用它——它是条件原子 UPDATE，不是读，
    这是故意的（见 record_click 自己的注释）。

    Shared active-link lookup for apply_invite and offer_days, so both sides
    agree on what "usable" means and can't silently diverge if a future
    condition (expiry, click cap) lands on only one of them. record_click does
    NOT use this — it is a conditional atomic UPDATE, not a read, deliberately
    (see record_click's own comment).
    """
    return (
        db.query(InviteLink)
        .filter(InviteLink.code == _normalize_code(code), InviteLink.is_active.is_(True))
        .first()
    )


def offer_days(db: Session, code: str) -> int | None:
    """这个 ref 码此刻能带来几天试用；不带返回 None。

    与 record_click 同层的纯服务函数，路由 offer 只是它的薄壳。拆开是为了可测：
    路由挂着限流装饰器，slowapi 要求 request 是真的 Request 实例，而本仓库的测试
    是 service 级的、没有 TestClient（既有用例同样只测 record_click、不测 click）。

    Service-layer twin of record_click; the offer route is a thin wrapper over
    it. Split out for testability: the route carries the rate limiter, which
    demands a genuine Request, and this repo's tests are service-level with no
    TestClient — the same reason record_click exists alongside click.
    """
    link = _active_link(db, code)
    return _trial_grant_days(db, link) if link is not None else None


def _trial_grant_days(db: Session, link: InviteLink) -> int | None:
    """这条链接此刻能发几天试用；不发返回 None。

    两个开关在这一处、也只在这一处合流：链接自己的 grants_trial，和全局的
    trial_enabled 总闸。发放路径（apply_invite）与公开查询端点（offer）共用本
    函数，因此落地页/注册页承诺的与后端实际发放的不可能分叉——这正是把判定
    抽出来而不是两边各写一遍的理由，别把它内联回去。

    天数取全局 trial_days：链接不单独配置天数（YAGNI，见设计文档第 8 节）。

    How many trial days this link grants right now, or None. The per-link
    switch and the global master gate meet here and nowhere else. The granting
    path and the public offer endpoint share this function, so what the landing
    and signup pages promise can never diverge from what the backend actually
    grants — that is the whole reason it is factored out; do not inline it.
    """
    if not bool(link.grants_trial):
        return None
    trial = get_trial_settings(db)
    if not trial["trial_enabled"]:
        return None
    days = int(trial["trial_days"])
    # 天数非正时当成"不发"处理：管理端 schema 把 trial_days 下限设成 ge=1，
    # 正常途径永远到不了这里，但 platform_settings 是能被手改的。真让 0（或负数）
    # 流出去，apply_invite 会把 plan_expires_at 设成"现在"、燃掉用户唯一一次
    # 试用机会却不留审计行（auth.py 判的是 if granted_days，0 是假值），前端两处
    # `if (r.trialDays)` 也会把它当没有活动——三个消费方全都不认 0，只有这里认，
    # 干脆在唯一的判定点堵死。
    #
    # A non-positive day count is treated as "no grant": the admin schema
    # bounds trial_days at ge=1 so this is unreachable through normal channels,
    # but platform_settings can be hand-edited. Letting 0 (or negative) through
    # would make apply_invite set plan_expires_at to "now", burn the user's
    # one-time trial with no audit row (auth.py checks `if granted_days`, and 0
    # is falsy), while both frontends' `if (r.trialDays)` treat it as no offer
    # too. None of the three consumers accept 0 — only this function did, so
    # the guard belongs at this single decision point.
    if days <= 0:
        return None
    return days


def apply_invite(db: Session, user: User, ref: str | None) -> int | None:
    """注册归因与自动试用发放：ref 命中开了送试用的活跃链接时，注册即开通
    PRO 试用；否则仅写入备注快照与归因码。

    返回实际发放的试用天数，未发放为 None。Task 3 的 auth.py 靠这个返回值
    决定是否写审计行。

    只应在**新建用户**的路径上调用（auth.register / google 的创建分支）。
    Google 端点是查找或创建二合一，对已存在的用户应用 ref 会覆盖管理员手写
    的备注、伪造注册来源；invite_code 已有值时也不覆盖，同一用户只归因一次。

    Registration attribution and auto-trial grant: if ref matches an active link
    with the per-link switch on, the registration grants PRO trial immediately;
    otherwise, just write the note and code. Returns the number of trial days
    actually granted, or None. Task 3's auth.py branches on this return value
    to decide whether to write an audit row.

    Call only on user-creation paths (register / google's create branch): the
    Google endpoint is find-or-create, and applying ref to an existing user
    would clobber the admin's hand-written note and fabricate attribution.
    An already-set invite_code is never overwritten either.
    """
    if not ref:
        return None
    if user.invite_code is not None:
        return None
    link = _active_link(db, ref)
    if link is None:
        return None  # 乱填/停用的 code 静默忽略，注册照常 / bad codes never block signup
    user.plan_note = link.label
    user.invite_code = link.code

    days = _trial_grant_days(db, link)
    if days is None:
        return None

    # 注册即开通：直接写在**尚未 INSERT** 的 user 对象上。
    #
    # 这里刻意**不用** payments.claim_trial 那套条件原子 UPDATE。那套防的是同
    # 一个已存在用户并发点两次领取；而此刻这一行在库里还不存在，没有并发对手，
    # 原子性由注册那一次 commit 提供。别"补"一个 UPDATE 上来——它不会更安全，
    # 只会对着一行不存在的记录空转。
    #
    # 字段与 claim_trial 完全一致（同一份权益）：到期后由
    # services/plan_expiry.py 的既有机制自动降回 FREE，本功能不新增到期逻辑。
    #
    # Granted by writing straight onto the not-yet-INSERTed user object. The
    # conditional atomic UPDATE used by payments.claim_trial is deliberately
    # absent: it guards against one existing user double-clicking, but this row
    # does not exist yet, so there is no competitor and atomicity comes from the
    # registration commit. Adding one would not be safer — it would update zero
    # rows. Fields match claim_trial exactly (same entitlement); expiry is
    # handled by the existing plan_expiry mechanism, unchanged.
    now = datetime.now(timezone.utc)
    user.plan = "PRO"
    user.plan_expires_at = now + timedelta(days=days)
    user.trial_used_at = now
    user.plan_is_trial = True
    return days


def _link_out(link: InviteLink, registrations: int) -> InviteLinkOut:
    return InviteLinkOut(
        id=link.id,
        code=link.code,
        label=link.label,
        clicks=link.clicks,
        registrations=registrations,
        isActive=link.is_active,
        grantsTrial=bool(link.grants_trial),
        createdAt=link.created_at,
    )


def _audit_value(link: InviteLink) -> str:
    return json.dumps(
        {
            "label": link.label,
            "isActive": link.is_active,
            "grantsTrial": bool(link.grants_trial),
        },
        ensure_ascii=False,
    )


@router.post("/click", status_code=204)
@limiter.limit(settings.RATE_LIMIT_INVITE_CLICK)
def click(request: Request, req: InviteClickRequest, db: Session = Depends(get_db)):
    """公开打点：一律 204，不区分 code 是否存在（防枚举探测）。"""
    record_click(db, req.code)
    return Response(status_code=204)


@router.get("/offer")
@limiter.limit(settings.RATE_LIMIT_INVITE_CLICK)
def offer(
    request: Request,
    code: str = Query(min_length=1, max_length=32),
    db: Session = Depends(get_db),
):
    """公开查询：这个 ref 码此刻能带来几天 PRO 试用；不带则 trialDays 为 null。

    为什么它存在：注册前就告诉访客有这份权益，是这条链路上最强的转化钩子；藏
    到注册之后等于没有。落地页与注册页据此选择文案。

    **这是对 /invite/click「一律 204、不给任何 code 存活信号」那条防枚举原则的
    一次有意放宽**，不是漏写。别把它改回不可区分——那会让上面两个页面无法在
    注册前说任何话，功能就没了。放宽的边界收得很窄，请一并保持：

    ① 「码不存在」「码已停用」「码没开送试用」返回**完全相同**的 null，因此现有
       那些不发试用的合作链接仍然完全不可探测；能被探出来的只有正在对外宣传送
       礼的那批码，而那本来就是主动广而告之的东西。
    ② 不返回 label，不返回 is_active——合作方名字与链接状态都不出网。
    ③ 天数并非新增泄露：/payments/public 本就公开返回「当前有无试用活动 + 几
       天」。本端点新增的信息量只有「这一个 code 送不送」。
    ④ 判定走 _trial_grant_days，与实际发放同源，前台承诺不可能与后端分叉。

    Public lookup: how many PRO trial days this ref code currently carries, or
    null. Exists because telling visitors before they sign up is the strongest
    conversion hook on this path. This is a *deliberate* relaxation of click's
    always-204 no-oracle rule, not an oversight — do not "fix" it back. The
    relaxation is deliberately narrow; keep it that way: unknown, disabled and
    non-granting codes all answer identically, so existing non-granting partner
    links stay unprobeable; no label or active flag ever leaves the server; the
    day count is already public via /payments/public; and the decision reuses
    _trial_grant_days so the promise can never diverge from the grant.
    """
    return {"trialDays": offer_days(db, code)}


@admin_router.get("", response_model=dict)
def list_invite_links(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
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
    # is_active 与 grants_trial 都显式传，不吃模型上的 Column(default=...) ：
    # 那是**写库时**才应用的 Python 侧默认值，而 SessionLocal 是 autoflush=False，
    # 下一行 _audit_value(link) 读到的还是 None——审计行会记成 {"isActive": null,
    # "grantsTrial": null}，把新建的链接记成状态不明。显式赋值比在这里插一次
    # db.flush() 好：不提前把 INSERT 发出去（校验失败时事务里干干净净），也不依赖
    # flush 的时机。
    # is_active and grants_trial are passed explicitly rather than relying on the
    # model's Column defaults: those are applied at flush time, and SessionLocal is
    # autoflush=False, so _audit_value(link) on the next line would still read None
    # and record null fields — a freshly created link logged in an unknown state.
    # Preferred over a db.flush() here: it doesn't emit the INSERT early and
    # doesn't depend on flush timing.
    link = InviteLink(code=new_unique_code(db), label=label, is_active=True, grants_trial=False)
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
    if data.get("grantsTrial") is not None:
        link.grants_trial = data["grantsTrial"]
    _log_change(db, admin.id, admin.id, f"invite:{link.code}", old, _audit_value(link))
    db.commit()
    db.refresh(link)
    registrations = (
        db.query(func.count(User.id)).filter(User.invite_code == link.code).scalar() or 0
    )
    return _link_out(link, registrations)
