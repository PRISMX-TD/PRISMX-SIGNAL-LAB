"""邀请链接路由：公开点击打点 + 管理员增改查 + 注册归因助手。

公开端点只有 /invite/click 一个：无论 code 是否存在、是否停用，一律 204——
不给外界任何探测 code 存活状态的信号。计数是一条条件原子 UPDATE（照
payments.py 试用抢占的写法），同时消掉读改写竞态和停用判断的时间差。

链接删除分硬删 / 软删（见 InviteLink 模型注释与 delete_invite_link）；审计日志照平台设置的惯例写——
AdminAuditLog.target_user_id 是指向 users.id 的非空外键，拿链接当目标在
Postgres 会外键违约，所以用操作者自身占位、field 加 "invite:" 前缀区分。

Invite-link router: public click counter + admin CRUD + the registration
attribution helper. The single public endpoint always returns 204 whether or
not the code exists or is active — no liveness oracle. The counter is one
conditional atomic UPDATE (the payments.py trial-claim shape), which removes
both the lost-update race and the is_active TOCTOU. Audit rows follow the
platform-settings convention: target_user_id is a NOT NULL FK to users, so
the acting admin stands in and the "invite:" field prefix disambiguates.
Deletion is hard or soft depending on attribution (see the InviteLink model and
delete_invite_link).
"""
import json
import secrets
from urllib.parse import quote
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.routers.admin import _like_escape
from app.models import (
    AdminAuditLog,
    AgentNode,
    Competition,
    CompetitionParticipant,
    InviteLink,
    InviteLinkAgent,
    MT5Account,
    PageVisitorDay,
    User,
)
from app.schemas import (
    AdminAgentAppoint,
    AdminAgentMove,
    AdminAgentPlanRight,
    AdminAgentSettingsUpdate,
    AdminAgentTreeLinkOut,
    AdminAgentTreeNodeOut,
    AdminAgentTreeOut,
    AdminLinkOwnerUpdate,
    AgentLinkOut,
    AgentLinkUserOut,
    AgentLinkUsersOut,
    AgentMT5AccountOut,
    AgentOpenAccountUrlUpdate,
    AgentOverviewOut,
    AgentPlanUpdate,
    AgentTeamNodeOut,
    AgentTeamOut,
    AgentTreeTarget,
    AgentTreeUserOut,
    AgentTreeUsersOut,
    OverviewRangeOut,
    InviteClickRequest,
    InviteLinkAgentOut,
    InviteLinkAssignAgent,
    InviteLinkCreate,
    InviteLinkOut,
    InviteLinkUpdate,
)
from app.services.account_type import CONTEST, DEMO, REAL
from app.services.admin_overview import activity_daily, headline
# 代理身份的判定与分页/范围解析都在 services 层：前者 account.py 也要用，后者
# admin.py 也要用，从 router 互相 import 会把两个路由绑死（见那两个模块的开头）。
# Both predicates live in services: account.py needs the first, admin.py the
# second, and importing across routers would tie them together (see their docs).
from app.services.agents import is_agent  # noqa: F401 — 再导出给既有调用方 / re-exported
from app.services.agent_tree import (
    add_node,
    descendants,
    is_customer,
    links_by_code,
    move_node,
    node_of,
    remove_node,
    scope_filter,
    set_link_owner,
    subtree_height,
)
from app.services.attribution import pick_ref  # noqa: F401 — 再导出给既有调用方 / re-exported
from app.services.audit import log_change as _log_change
from app.services.email_domains import alias_trial_used
from app.services.deps import get_current_user, require_admin
from app.services.gamification import mask_account
from app.services.gateway_binding import is_revoked, not_removed
from app.services.open_account import MSG_COMP_LINK_OPEN_URL, normalize_agent_open_url
from app.services.notification_feed import (
    KIND_AGENT_PLAN_CHANGE,
    KIND_AGENT_PROMOTED,
    KIND_AGENT_TREE_CHANGE,
    create_notification,
    notify_ws,
)
from app.services.pagination import (
    PAGE_SIZE_DEFAULT,
    PAGE_SIZE_MAX,
    resolve_range_or_422 as _resolve_range_or_422,
)
from app.services.paid_entitlement import paid_entitlement_end
from app.services.plans import trial_grant_days
from app.services.settings_store import (
    get_agent_settings,
    invalidate_agent_cache,
    save_agent_settings,
)
from app.services.stats_time import RangeSpec
from app.services.stats_time import day_start_utc
from app.services.stats_time import today as stats_today

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
# 代理页：只要求登录，不要求管理员。「是不是代理」不看 role，看 agent_nodes 里有没有
# 这个人的节点（见 services/agents.is_agent）；每个端点再各自按范围 / 链接归属校验，
# 不属于自己的一律 404——不给「存在但不是你的」这种信号。
# Agent view: login only, no admin. Agent-ness is having a node in agent_nodes;
# every endpoint re-checks scope / link ownership and answers 404 otherwise.
agent_router = APIRouter(prefix="/agent", tags=["agent"])
# 代理层级的管理端（rev 50 从 /admin/invite-links 下面独立出来）。require_admin 两处都挂，理由同上。
# Admin side of the agent tree (split out of /admin/invite-links in rev 50); admin-guarded twice as above.
admin_agents_router = APIRouter(prefix="/admin/agents", tags=["admin"])

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
        InviteLink.code == _normalize_code(code),
        InviteLink.is_active.is_(True),
        InviteLink.deleted_at.is_(None),
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
        .filter(
            InviteLink.code == _normalize_code(code),
            InviteLink.is_active.is_(True),
            # 软删会同时置 is_active=False；这里再挡一次，防止有人把停用开关拨回来。
            # Soft delete also clears is_active; filtered again in case it is flipped back.
            InviteLink.deleted_at.is_(None),
        )
        .first()
    )


# 选码（来源 / 归属 / 开户跳转的旧口径）住在 services/attribution.py；pick_ref 在上面从那里
# 导入、在这里当本模块的名字用，既有调用方与测试不必跟着搬。
# Ref picking lives in services/attribution; pick_ref is re-exported for existing callers.


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
    # 全局那一半（总闸 + 天数非正当成不发）在 services/plans.trial_grant_days，
    # 与「登录后自己领」那条路共用同一处判定——见那个函数的说明。本函数只再叠上
    # 链接自己的开关。
    # The global half (master switch + non-positive day count) lives in
    # services/plans.trial_grant_days, shared with the self-claim path; this
    # function only adds the per-link switch on top.
    return trial_grant_days(db)


def _plan_note(db: Session, link: InviteLink) -> str:
    """注册时快照进 users.plan_note 的备注。比赛推广链接写成「比赛名·标记」，用户
    列表里一眼看出是哪场比赛拉来的；比赛是软引用（无外键），找不到就退回标记。
    The note snapshotted at signup. Competition links read "competition·label"
    so the admin user list shows which competition brought the user in; the
    competition is a soft reference (no FK), so a missing row falls back to the label."""
    if link.competition_id:
        comp = db.get(Competition, link.competition_id)
        if comp is not None:
            return f"{comp.name}·{link.label}"
    return link.label


def apply_invite(
    db: Session,
    user: User,
    ref: str | None,
    *,
    grant_trial: bool = True,
    agent_owner: str | None = None,
) -> int | None:
    """注册归因与自动试用发放：ref 命中开了送试用的活跃链接时，注册即开通
    PRO 试用；否则仅写入备注快照与归因码。

    grant_trial=False 只归因、不发试用：邮箱密码注册走这条——试用要等邮箱验证
    通过后由 grant_deferred_invite_trial 补发（见那个函数）。Google 注册的邮箱
    创建即验证，仍走默认的当场发放。
    grant_trial=False attributes without granting: password sign-ups take this
    path and get the trial from grant_deferred_invite_trial once the address is
    verified. Google sign-ups are verified at creation and keep the default.

    返回实际发放的试用天数，未发放为 None。Task 3 的 auth.py 靠这个返回值
    决定是否写审计行。

    rev 50：ref 是**来源**（写 invite_code，试用也看它）；agent_owner 是 attribution.pick_signup
    另外挑出的**归属代理**，写 agent_user_id。没传 agent_owner 时退回来源链接自己的主人。
    rev 50: `ref` is the source (invite_code; the trial follows it); agent_owner
    is the owning agent picked separately by attribution.pick_signup, written to
    agent_user_id, falling back to the source link's own owner.

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
    user.plan_note = _plan_note(db, link)
    user.invite_code = link.code
    if user.agent_user_id is None:
        user.agent_user_id = agent_owner or link.owner_user_id

    if not grant_trial:
        return None
    days = _trial_grant_days(db, link)
    if days is None:
        return None
    # 同一收件箱（规范邮箱）下别的账号用过试用 / 付过费：只归因、不发试用。这条路是 Google
    # 新建账号，user 还没 INSERT，排除自己不需要 id。
    # Another account on the same mailbox used a trial or paid: attribute only.
    # The user isn't inserted yet, so there is nothing of its own to exclude.
    if alias_trial_used(db, user.email, exclude_user_id=user.id):
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


def grant_deferred_invite_trial(db: Session, user: User) -> int | None:
    """邮箱验证通过时，补发注册那一刻因为「还没验证」而扣下的邀请试用。

    判定在**验证这一刻**重新做：链接得还是活跃的、还开着送试用、全局总闸也开着
    （_trial_grant_days，与注册当场发放同一处判定）。注册后链接被停用或关了送
    试用，那就不发——落地页承诺的是「此刻注册送」，不是一张永久兑换券。

    用条件原子 UPDATE 抢占资格（同 payments.claim_trial）：用户可能在两台设备上
    同时点开验证链接，也可能先自己去领了试用，两条路都不能发出第二份。只改库、
    写审计，不 commit——调用方（验证 / 重置密码）在同一个事务里提交。

    Grants the invite trial a password sign-up was denied at registration for
    being unverified. Re-evaluated now via _trial_grant_days, the same decision
    the at-signup grant uses: a link disabled or switched off since then grants
    nothing. A conditional atomic UPDATE (as in payments.claim_trial) keeps two
    simultaneous clicks, or a self-claim that got there first, from granting
    twice. Does not commit; the caller does, in the same transaction.
    """
    if not user.invite_code:
        return None
    link = _active_link(db, user.invite_code)
    if link is None:
        return None
    days = _trial_grant_days(db, link)
    if days is None:
        return None
    # 试用每个收件箱一次（同 payments.claim_trial，见 email_domains.alias_trial_used）。
    # One trial per mailbox, as in payments.claim_trial.
    if alias_trial_used(db, user.email, exclude_user_id=user.id):
        return None
    now = datetime.now(timezone.utc)
    claimed = (
        db.query(User)
        .filter(User.id == user.id, User.trial_used_at.is_(None), User.plan == "FREE")
        .update(
            {
                "plan": "PRO",
                "plan_expires_at": now + timedelta(days=days),
                "trial_used_at": now,
                "plan_is_trial": True,
            },
            synchronize_session=False,
        )
    )
    if not claimed:
        return None
    db.add(AdminAuditLog(
        admin_user_id=user.id,
        target_user_id=user.id,
        field="plan:invite_trial",
        old_value="FREE",
        new_value=f"PRO({days}d)",
    ))
    return days


def _link_kind(link: InviteLink) -> str:
    """链接分类（设计 2026-10-27 §4.2），全部由数据推导。比赛链接不能有主人，所以先看 competition_id。
    Derived kind; competition links can't have an owner."""
    if link.competition_id:
        return "competition"
    return "agent" if link.owner_user_id else "platform"


def _link_out(
    link: InviteLink,
    registrations: int,
    agents: list[InviteLinkAgentOut] | None = None,
    *,
    competition_name: str | None = None,
    entries: int = 0,
    registrations_month: int = 0,
    owned_customers: int = 0,
) -> InviteLinkOut:
    return InviteLinkOut(
        id=link.id,
        code=link.code,
        label=link.label,
        clicks=link.clicks,
        registrations=registrations,
        isActive=link.is_active,
        grantsTrial=bool(link.grants_trial),
        createdAt=link.created_at,
        agents=agents or [],
        competitionId=link.competition_id,
        competitionName=competition_name,
        channel=link.channel,
        openAccountUrl=link.open_account_url,
        deletedAt=link.deleted_at,
        kind=_link_kind(link),
        entries=entries,
        registrationsMonth=registrations_month,
        ownedCustomers=owned_customers,
    )


# ---------- 代理指派 / agent assignment ----------


# is_agent 现在住在 services/agents.py，这里从上面 import 进来当本模块的名字用：
# 「代理」这个概念的入口本来就在这个文件，从 app.routers.invite 取它的既有调用方
# （含测试）不该因为一次内部搬家而改动。
# is_agent now lives in services/agents.py and is re-exported here: this file is
# where the agent concept is documented, and existing callers (tests included)
# shouldn't have to move for an internal relocation.

def _registrations_since(db: Session, codes: list[str], since: datetime) -> dict[str, int]:
    """since 之后（含）的注册人数，按 invite_code 一条 GROUP BY。
    Signups at/after `since`, one GROUP BY by invite_code."""
    if not codes:
        return {}
    return dict(
        db.query(User.invite_code, func.count(User.id))
        .filter(User.invite_code.in_(codes), User.created_at >= since)
        .group_by(User.invite_code)
        .all()
    )


def _agents_by_link(db: Session, links: list[InviteLink]) -> dict[str, list[InviteLinkAgentOut]]:
    """这批链接各自的主人（0 或 1 个），一条查询取完。One query for all owners, no N+1."""
    owner_ids = list({l.owner_user_id for l in links if l.owner_user_id})
    if not owner_ids:
        return {}
    people = {u.id: u for u in db.query(User).filter(User.id.in_(owner_ids)).all()}
    levels = dict(db.query(AgentNode.user_id, AgentNode.depth).filter(AgentNode.user_id.in_(owner_ids)).all())
    out: dict[str, list[InviteLinkAgentOut]] = {}
    for l in links:
        u = people.get(l.owner_user_id or "")
        if u is not None:
            out[l.id] = [
                InviteLinkAgentOut(
                    userId=u.id, email=u.email, nickname=u.nickname, assignedAt=l.owner_assigned_at,
                    level=levels.get(u.id),
                )
            ]
    return out


def _owned_customers(db: Session, links: list[InviteLink]) -> dict[str, int]:
    """每条链接：来源是它、此刻仍归它当前主人（无主人则仍是平台客户）的普通客户数，键是 link.id。
    转主人弹窗里「连同 N 位客户迁移」就是这批人（见 _move_link_customers）。
    Per link: customers from it still owned by its current owner (or still
    platform when it has none) -- exactly who a transfer with moveCustomers moves."""
    if not links:
        return {}
    rows = (
        db.query(User.invite_code, User.agent_user_id, func.count(User.id))
        .filter(User.invite_code.in_([l.code for l in links]), is_customer())
        .group_by(User.invite_code, User.agent_user_id)
        .all()
    )
    counts = {(code, owner): n for code, owner, n in rows}
    return {l.id: counts.get((l.code, l.owner_user_id), 0) for l in links}


def _registrations(db: Session, codes: list[str]) -> dict[str, int]:
    """注册人数按 users.invite_code 一条 GROUP BY 全查出来（管理列表与代理列表共用）。
    Signup counts by users.invite_code in one GROUP BY (shared by admin and agent lists)."""
    if not codes:
        return {}
    return dict(
        db.query(User.invite_code, func.count(User.id))
        .filter(User.invite_code.in_(codes))
        .group_by(User.invite_code)
        .all()
    )


def _competition_names(db: Session, comp_ids: list[str]) -> dict[str, str]:
    if not comp_ids:
        return {}
    return dict(db.query(Competition.id, Competition.name).filter(Competition.id.in_(comp_ids)).all())


def _entries(db: Session, links: list[InviteLink]) -> dict[str, int]:
    """比赛链接的报名数，键是 link.id。一条 join + GROUP BY 查完整批：参赛条目按
    (competition_id, 属主 invite_code) 分组，再按链接自己的 (competition_id, code) 取。
    Entry counts for competition links, keyed by link.id: one join + GROUP BY over
    (competition_id, owner's invite_code), then looked up per link."""
    comp_links = [l for l in links if l.competition_id]
    if not comp_links:
        return {}
    rows = (
        db.query(CompetitionParticipant.competition_id, User.invite_code, func.count(CompetitionParticipant.id))
        .join(User, User.id == CompetitionParticipant.user_id)
        .filter(
            CompetitionParticipant.competition_id.in_({l.competition_id for l in comp_links}),
            User.invite_code.in_({l.code for l in comp_links}),
            CompetitionParticipant.disqualified.is_(False),
        )
        .group_by(CompetitionParticipant.competition_id, User.invite_code)
        .all()
    )
    counts = {(comp_id, code): n for comp_id, code, n in rows}
    return {l.id: counts.get((l.competition_id, l.code), 0) for l in comp_links}


def _link_outs(db: Session, links: list[InviteLink]) -> list[InviteLinkOut]:
    """一批链接的完整输出：注册数、代理、比赛名、报名数各一条批量查询，没有 N+1。
    Full output for a batch: one query each for signups, agents, names, entries."""
    counts = _registrations(db, [l.code for l in links])
    month = _registrations_since(db, [l.code for l in links], day_start_utc(stats_today().replace(day=1)))
    agents = _agents_by_link(db, links)
    owned = _owned_customers(db, links)
    names = _competition_names(db, list({l.competition_id for l in links if l.competition_id}))
    entries = _entries(db, links)
    return [
        _link_out(
            l,
            counts.get(l.code, 0),
            agents.get(l.id),
            competition_name=names.get(l.competition_id) if l.competition_id else None,
            entries=entries.get(l.id, 0),
            registrations_month=month.get(l.code, 0),
            owned_customers=owned.get(l.id, 0),
        )
        for l in links
    ]


# 代理页「活跃」的窗口：近 7 天（含今天）。管理看板用的是可选时间范围，代理页
# 不给选——多一个控件换不来一个决策，代理只要知道"这批人还在不在用"。
# The agent view's activity window: last 7 days, today included. The admin
# dashboard takes a range picker; this page deliberately doesn't — one more
# control buys no extra decision for an agent.
ACTIVE_WINDOW_DAYS = 7

# MT5 trade_mode → 对外说法。NULL / 认不出的值一律 None（"未判定"），不猜。
# trade_mode → wire value; unknown or NULL maps to None rather than a guess.
_TRADE_MODE_NAME = {DEMO: "demo", CONTEST: "contest", REAL: "real"}


def _active_window_start() -> date:
    return stats_today() - timedelta(days=ACTIVE_WINDOW_DAYS - 1)


def _active_users(db: Session, codes: list[str]) -> dict[str, int]:
    """每条链接名下近 7 天活跃的人数（一条 GROUP BY 全查，不是每条链接一查）。

    活跃口径与管理看板同源：page_visitor_days 里有行 = 当天打开过页面。这里
    join users 而不是直接按 user_id 数，是因为归因只记在 users.invite_code 上。

    Per-link 7-day active head count in one GROUP BY. "Active" means a
    page_visitor_days row, same as the admin dashboard; the join to users is
    needed because attribution lives only on users.invite_code.
    """
    if not codes:
        return {}
    rows = (
        db.query(User.invite_code, func.count(func.distinct(PageVisitorDay.user_id)))
        .join(PageVisitorDay, PageVisitorDay.user_id == User.id)
        .filter(User.invite_code.in_(codes), PageVisitorDay.day >= _active_window_start())
        .group_by(User.invite_code)
        .all()
    )
    return {code: int(n) for code, n in rows}


def _mt5_users(db: Session, codes: list[str]) -> dict[str, int]:
    """每条链接名下「至少有一个有效 MT5 绑定」的人数。

    已撤销的绑定（revoked_at 非空）不算：那条连接此刻是断的，算进来会让代理以为
    人还挂着。这一条同时也把用户自己解绑的软删行挡在外面——两者共用 revoked_at，
    而这里要的正是"两种都不算"。COUNT(DISTINCT user_id) 而不是数账号——一人绑两
    个仍是一个人。

    Per-link count of people holding at least one live MT5 binding. Revoked rows
    are excluded (that connection is down right now) and the count is DISTINCT on
    the user, so two accounts on one person still count once.
    """
    if not codes:
        return {}
    rows = (
        db.query(User.invite_code, func.count(func.distinct(MT5Account.user_id)))
        .join(MT5Account, MT5Account.user_id == User.id)
        .filter(User.invite_code.in_(codes), MT5Account.revoked_at.is_(None))
        .group_by(User.invite_code)
        .all()
    )
    return {code: int(n) for code, n in rows}


def _last_active_days(db: Session, user_ids: list[str]) -> dict[str, date]:
    """这批用户各自的最近活跃日。名单一页最多 200 人，一条 GROUP BY 拿完。
    Last active day per user, one GROUP BY for the whole page."""
    if not user_ids:
        return {}
    rows = (
        db.query(PageVisitorDay.user_id, func.max(PageVisitorDay.day))
        .filter(PageVisitorDay.user_id.in_(user_ids))
        .group_by(PageVisitorDay.user_id)
        .all()
    )
    return {uid: day for uid, day in rows if day is not None}


def _mt5_accounts(db: Session, user_ids: list[str]) -> dict[str, list[AgentMT5AccountOut]]:
    """这批用户各自的 MT5 绑定，能用的在前；下发前打码，见 AgentMT5AccountOut。

    两处判定都不是本文件自己定的，复用站内唯一定义，别在这里另写一套：
    - 软删的行（用户自己在界面上解绑）用 not_removed() 排除，与所有"当前有效
      账号"的查询一致——对代理来说那个账号等于不存在；
    - 「还连得上吗」= 直连看授权有没有作废（gateway_binding.is_revoked，它对桥接
      行恒为 False：那条通道的凭证在用户自己手里，不套这套语义），桥接则只要绑定
      还在就算连着。**刻意不看瞬时在线，也不看 last_heartbeat**：桥接的在线随客户
      关电脑闪烁，而直连的"在线"其实是平台自己那台网关的健康状态、全站共享
      （写在客户那一行上会把平台抖动显示成客户掉线），两者代理都用不上。

    排序：能用的在前，其余按最近心跳倒序（只有桥接有心跳）。放在 Python 侧做，
    因为 NULL 心跳在 ORDER BY ... DESC 下 SQLite 与 Postgres 正好排反。

    MT5 bindings per user, usable ones first, masked on the way out. Both
    verdicts reuse the single site-wide definition: soft-removed rows are
    excluded via not_removed(), and "still connected" means not revoked for a
    gateway binding (is_revoked is always False for bridge rows) or simply
    existing for a bridge one. Live online state and last_heartbeat are
    deliberately ignored — see AgentMT5AccountOut. Sorted in Python because NULL
    heartbeats sort opposite ways under SQLite and Postgres.
    """
    if not user_ids:
        return {}
    rows = (
        db.query(MT5Account)
        .filter(MT5Account.user_id.in_(user_ids), not_removed())
        .all()
    )
    rows.sort(key=lambda a: (not is_revoked(a), a.last_heartbeat or datetime.min), reverse=True)
    out: dict[str, list[AgentMT5AccountOut]] = {}
    for a in rows:
        out.setdefault(a.user_id, []).append(
            AgentMT5AccountOut(
                login=mask_account(a.login),
                server=a.server,
                accountType=_TRADE_MODE_NAME.get(a.trade_mode),
                connected=not is_revoked(a),
            )
        )
    return out


def assign_agent(db: Session, admin: User, link: InviteLink, target: User) -> None:
    """旧的「指派代理」（rev 50 前的 POST /admin/invite-links/{id}/agents，留一版给旧热更新包）：
    他还不是代理就先任命为一级，再把链接给他。链接已有主人 409。不迁移老客户。
    The pre-rev-50 assignment, kept one release for old app bundles: appoint as
    top level if needed, then hand over the link. 409 if it has an owner."""
    if link.owner_user_id:
        raise HTTPException(
            status_code=409,
            detail="这条链接已有推荐官，一条链接只能有一个推荐官 / This link already has an ambassador; a link can have only one",
        )
    if link.competition_id:
        raise HTTPException(
            status_code=400, detail="比赛推广链接不能指派推荐官 / Competition promo links cannot have ambassadors"
        )
    if node_of(db, target.id) is None:
        add_node(db, target.id, None, admin.id)
        _log_change(db, admin.id, target.id, "agent_parent", None, "-")
    admin_set_link_owner(db, admin, link, AdminLinkOwnerUpdate(userId=target.id))


_MSG_HAS_CHILDREN = (
    "该推荐官下面还有下级推荐官，请先改挂或撤销下级推荐官 / "
    "This ambassador still has downline ambassadors; move or remove them first"
)


def _has_children(db: Session, user_id: str) -> bool:
    return db.query(AgentNode.id).filter(AgentNode.parent_user_id == user_id).first() is not None


def unassign_agent(db: Session, admin: User, link: InviteLink, user_id: str) -> None:
    """旧的「取消指派」（留一版）：只把链接收回成平台链接。rev 50 起**不再顺带撤销代理**——
    撤销代理只有一个入口（admin_revoke_agent / agent_demote），老客户也不跟着动。
    The pre-rev-50 unassign, kept one release: the link just becomes a platform
    link. It no longer revokes anyone, and customers stay where they are."""
    if link.owner_user_id != user_id:
        raise HTTPException(status_code=404, detail="指派不存在 / Assignment not found")
    admin_set_link_owner(db, admin, link, AdminLinkOwnerUpdate(userId=None))


def agent_links(db: Session, user: User) -> list[AgentLinkOut]:
    """当前用户持有的全部链接（含已停用——停用后名单仍是他的，数据不该消失）。
    Every link the user holds, disabled ones included: the list stays theirs."""
    links = (
        db.query(InviteLink)
        .filter(InviteLink.owner_user_id == user.id, InviteLink.deleted_at.is_(None))
        .order_by(InviteLink.created_at.desc())
        .all()
    )
    return _agent_link_outs(db, links)


def _agent_link_outs(db: Session, links: list[InviteLink]) -> list[AgentLinkOut]:
    codes = [l.code for l in links]
    counts = _registrations(db, codes)
    active = _active_users(db, codes)
    connected = _mt5_users(db, codes)
    return [
        AgentLinkOut(
            id=l.id,
            code=l.code,
            label=l.label,
            clicks=l.clicks,
            registrations=counts.get(l.code, 0),
            activeUsers7d=active.get(l.code, 0),
            mt5Users=connected.get(l.code, 0),
            isActive=l.is_active,
            createdAt=l.created_at,
            openAccountUrl=l.open_account_url,
        )
        for l in links
    ]


def _owned_link(db: Session, user: User, link_id: str) -> InviteLink:
    link = (
        db.query(InviteLink)
        .filter(
            InviteLink.id == link_id,
            InviteLink.owner_user_id == user.id,
            InviteLink.deleted_at.is_(None),
        )
        .first()
    )
    if link is None:
        # 不存在与不是你的同一个 404 / not-found and not-yours are the same 404
        raise HTTPException(status_code=404, detail="链接不存在 / Link not found")
    return link


def agent_link_users(
    db: Session,
    user: User,
    link_id: str,
    limit: int = PAGE_SIZE_DEFAULT,
    offset: int = 0,
    q: str | None = None,
) -> AgentLinkUsersOut:
    """旧接口（留一版）：我这条链接带来、此刻仍在我范围里的人。新前端用 /agent/customers?link=。
    Legacy (one release): people from my link still in my scope; new clients use
    /agent/customers?link=."""
    link = _owned_link(db, user, link_id)
    page = agent_tree_users(db, user, limit, offset, q, link_id=link.id)
    return AgentLinkUsersOut(
        users=[AgentLinkUserOut(**u.model_dump(include=set(AgentLinkUserOut.model_fields))) for u in page.users],
        total=page.total,
        limit=limit,
        offset=offset,
    )


def agent_overview(db: Session, user: User, link_id: str, spec: RangeSpec) -> AgentOverviewOut:
    """代理看板：这条链接带来的人的头部指标 + 活跃/新注册趋势。

    数字由管理看板那两个函数算（headline / activity_daily），只多传一个 scope
    条件把范围收在 users.invite_code 上——共用的理由见 admin_overview 顶部。

    The agent dashboard for one link, computed by the admin dashboard's own
    functions with a single extra scope filter on users.invite_code.
    """
    link = _owned_link(db, user, link_id)
    scope = (User.invite_code == link.code,)
    return AgentOverviewOut(
        range=OverviewRangeOut(
            start=spec.start.isoformat(),
            end=spec.end.isoformat(),
            days=spec.days,
            compareStart=spec.compare_start.isoformat(),
            compareEnd=spec.compare_end.isoformat(),
        ),
        headline=headline(db, spec, stats_today(), *scope),
        activity=activity_daily(db, spec, *scope),
    )


# ---------- 代理调整客户会员 / agent-side plan changes ----------

# 单次延长上限（天）。产品决定：代理能降级也能延长，但一次最多 60 天——要开
# 一年就点六次。**摩擦是故意的**：防的是一次点到 2099 年，不是防长期客户。
# Per-call extension cap. Agents may downgrade and extend, but at most 60 days
# at a time; a year takes six clicks. The friction is deliberate.
AGENT_MAX_EXTEND_DAYS = 60

# 每个客户在任意滚动 30 天窗口内、由代理累计延长的上限（天）。
#
# 单次上限单独存在时其实挡不住什么：这个端点限流 30/分钟，60 天 × 30 次 = 每分钟
# 1800 天，"防一次点到 2099 年"的说法在连点面前不成立。真正要封的是总量——一个
# 客户一个月最多从代理这里拿到 90 天（三次满额），再多就该是管理员或者一笔付费
# 订单的事。90 这个数字给的是"季度套餐"的余量：正常的续期节奏够用，批量刷权益
# 的路子走不通。
#
# 窗口按"滚动 30 天"而不是自然月：自然月会在每月 1 号把额度清零，于是 30 号加
# 满、1 号再加满，一次就能拿到两倍。
#
# Cumulative cap per customer within any rolling 30-day window. The per-call cap
# alone stops nothing: at 30 requests/minute it allows 1800 days a minute, so the
# "can't reach year 2099" claim doesn't survive a script. What has to be bounded
# is the total — 90 days a month from an agent (three full-size grants), beyond
# which it belongs to an admin or to a paid order. Rolling rather than calendar
# month, because a calendar reset lets the 30th and the 1st stack into double.
AGENT_EXTEND_WINDOW_DAYS = 30
AGENT_MAX_EXTEND_DAYS_PER_WINDOW = 90

# 累计额度靠审计表本身来算，不新建表、不加列：每次延长都额外写一条
# `agent:{code}:extend_days` 行，new_value 就是这次加的天数。审计行是这个操作
# 已经必须写的东西，让它顺便当账本，比为一个配额引一张新表（迁移、清理、
# schema_rev）划算得多；数得准的前提是**每次延长都写**，别在别处绕开它。
# The quota is computed from the audit table itself — one extra
# `agent:{code}:extend_days` row per extension, new_value being the day count.
# The audit row has to be written anyway, which beats a new table (migration,
# retention, schema_rev) for one quota. It only counts right if every extension
# writes one; do not add a path that skips it.
_AGENT_EXTEND_AUDIT_SUFFIX = ":extend_days"


def _agent_extended_days(db: Session, target_id: str, now: datetime) -> int:
    """这个客户在最近 AGENT_EXTEND_WINDOW_DAYS 天里，已经被代理累计延长了几天。

    数的是审计表里 `agent:*:extend_days` 那批行（见
    _AGENT_EXTEND_AUDIT_SUFFIX）。**不按链接分组**：额度是给"这个客户"的，
    否则把同一个人挂到两条链接下就能拿两份额度，而代理本来就可能持有多条链接。

    new_value 是自己写的整数字符串，仍然用 try 兜一层——这张表的行也可能来自
    人工 SQL 修补，一条脏值不该让正常的延长请求 500。

    How many days agents have already added to this customer inside the rolling
    window, counted off the audit rows. Deliberately not grouped by link: the
    quota belongs to the customer, or holding two links would double it. The
    day count is parsed defensively because rows can also come from hand-written
    SQL, and one bad value must not 500 a legitimate request.
    """
    since = (now - timedelta(days=AGENT_EXTEND_WINDOW_DAYS)).replace(tzinfo=None)
    rows = (
        db.query(AdminAuditLog.new_value)
        .filter(
            AdminAuditLog.target_user_id == target_id,
            AdminAuditLog.field.like(f"agent:%{_AGENT_EXTEND_AUDIT_SUFFIX}"),
            AdminAuditLog.created_at >= since,
        )
        .all()
    )
    total = 0
    for (value,) in rows:
        try:
            total += int(value)
        except (TypeError, ValueError):
            continue
    return total


def _has_live_paid_plan(db: Session, target_id: str, now: datetime) -> bool:
    """这个人手里有没有一笔**还在有效期内**的已完成付款。

    判据是付款本身而不是 users.plan：plan 是个会被覆盖的当前状态，一旦代理已经
    点下降级，事后再看 plan 只能看到 FREE，付过钱这件事就查不出来了。payments
    表是不可变的事实，这笔钱买到的窗口由 services/paid_entitlement 统一计算（叠加链 +
    入账时记下的 credited_until，老行退回 plan:payment 审计行），与退款收回下限共用。

    只看 FINISHED：PROCESSING 的钱还没到账，EXPIRED/FAILED/REFUNDED 的不给窗口。

    Whether this user holds a completed payment whose window hasn't lapsed. The
    verdict comes from the payments table rather than users.plan, because plan is
    mutable current state — once a downgrade lands, it reads FREE and the fact
    that money changed hands is no longer visible. The paid window is computed by
    services/paid_entitlement (shared with the refund revoke floor).
    """
    ends = paid_entitlement_end(db, target_id)
    return ends is not None and ends > now


def _notify_admins_agent_write(
    db: Session, agent: User, target: User, summary: str, kind: str = KIND_AGENT_PLAN_CHANGE
) -> list[str]:
    """代理动了别人的会员，给每位管理员留一条站内通知，返回收到的管理员 id。

    为什么必须有：代理页是 /agent/* 下唯一的写端点，改的是**别人的**付费权益，
    而此前它唯一的痕迹是审计表里两行——没有人会定期去翻审计表，于是"某个代理
    把一批客户开成 PRO"这件事在被客户投诉之前完全不可见。铃铛里一条通知是让
    这件事有人看见的最低成本做法（对比：新工单也是这么通知管理员的）。

    不发系统推送，理由与 tickets._notify_admins_new_ticket 一样：管理员就那几个
    人，往每台设备推一条只会把后台日常变成噪音。代理自己是管理员时不通知自己
    （他不会是——_tree_target 已经挡了管理员做目标，但操作者这一侧没挡）。

    One in-app notification per admin whenever an agent changes someone else's
    paid entitlement. This is the only write endpoint under /agent/*, and its
    only previous trace was two audit rows that nobody reads on a schedule — so
    an agent upgrading a batch of customers was invisible until a customer
    complained. No tray push, for the same reason as new tickets: admins are a
    handful of people and per-device fan-out turns routine work into noise.
    """
    admin_ids = [
        r[0] for r in db.query(User.id).filter(User.role == "admin").all()
        if r[0] != agent.id
    ]
    for admin_id in admin_ids:
        create_notification(
            db,
            admin_id,
            kind,
            text=summary,
            # 邮箱进 URL 必须编码：本地部分可以合法地带 "+"、"&"、"#"，原样拼进去会把查询串截断
            # 或改写（"+" 被读成空格）。/ Encode: a local part may legally hold "+", "&"
            # or "#", which would otherwise truncate or rewrite the query string.
            link=f"/admin?tab=users&q={quote(target.email, safe='')}",
            ref_id=target.id,
        )
    return admin_ids


def agent_set_plan(db: Session, agent: User, link_id: str, body: AgentPlanUpdate) -> AgentLinkUserOut:
    """代理调整自己名下客户的会员等级与到期日。返回改完之后的那一行。

    五条边界：
    ① 只能动自己这条链接带来、且仍在自己范围里的人（_owned_link + _tree_target，都是 404）；
    ② 一次最多延长 AGENT_MAX_EXTEND_DAYS 天（schema 里已卡 le=60，这里再兜一次——
       schema 是给 HTTP 的，这个函数本身也会被测试与将来的调用方直接用）；
    ③ 每个客户在滚动 30 天内累计最多 AGENT_MAX_EXTEND_DAYS_PER_WINDOW 天。单次
       上限在 30/分钟 的限流下形同虚设（每分钟 1800 天），真正封住"无限开 PRO"
       的是这一条，见 AGENT_MAX_EXTEND_DAYS_PER_WINDOW 的说明；
    ④ **正在付费有效期内的客户不许降级**。代理一点降级就能抹掉用户真金白银买来
       的权益，用户既收不到通知也没有申诉入口，直接 409 让他去找管理员——退款
       与例外是运营决策，不该由一个代理单方面完成；
    ⑤ **不限期 PRO 不许碰**。那是管理员手动给的（内部赠送 / KOL 合作，
       plan_expires_at 为空 = 永久），延长会把永久变成有限期、降级会直接撤销管理员
       的决定——两种都是代理在覆盖管理员，所以一律 409 让他去找管理员。

    每个真正变化的字段各写一条审计行，field 带 `agent:{code}:` 前缀：这样一眼看出
    这次改动来自代理页而不是后台，而 admin_user_id 记的就是那个代理。写操作同时
    给每位管理员留一条站内通知（见 _notify_admins_agent_write）。

    Agent-side plan change for one of their own referrals, returning the updated
    row. Five boundaries: their own referrals only (404 otherwise); the per-call
    day cap; a rolling 30-day cumulative cap per customer (the per-call cap is
    meaningless at 30 requests/minute); no downgrading a customer still inside a
    paid window (409 — refunds and exceptions are an operator's call, not an
    agent's); and never-expiring PRO is off limits (409), since extending or
    downgrading it would have an agent overrule an admin. Every changed field
    gets its own prefixed audit row, and every write notifies the admins.
    """
    _require_plan_right(db, agent)
    link = _owned_link(db, agent, link_id)
    target = _tree_target(db, _Scope(db, agent), body.email, agent)
    if target.invite_code != link.code:
        raise HTTPException(status_code=404, detail=_MSG_USER_NOT_FOUND)
    return _apply_agent_plan(db, agent, target, link.code, body)


def _apply_agent_plan(
    db: Session, agent: User, target: User, code: str, body: AgentPlanUpdate
) -> AgentLinkUserOut:
    """agent_set_plan 的执行部分：目标已经校验过（是这个代理树上的人、不是管理员、不是自己）。
    code 是目标归属的链接码，进审计字段前缀。按链接改（旧端点）与按整棵树改（rev 47）共用。
    The shared execution half once the target is vetted; `code` is the target's
    link code for the audit prefix. Used by the per-link and the tree endpoint."""
    if target.plan == "PRO" and target.plan_expires_at is None:
        raise HTTPException(
            status_code=409,
            detail="该用户是不限期会员，请联系管理员 / This user's membership has no expiry; contact an admin",
        )

    old_plan, old_expiry = target.plan, target.plan_expires_at
    now = datetime.now(timezone.utc)
    granted_days = 0

    if body.action == "extend":
        days = body.days
        if not days or days > AGENT_MAX_EXTEND_DAYS:
            raise HTTPException(
                status_code=422,
                detail=f"一次最多延长 {AGENT_MAX_EXTEND_DAYS} 天 / At most {AGENT_MAX_EXTEND_DAYS} days per change",
            )
        used = _agent_extended_days(db, target.id, now)
        if used + days > AGENT_MAX_EXTEND_DAYS_PER_WINDOW:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"该客户 {AGENT_EXTEND_WINDOW_DAYS} 天内最多累计延长 "
                    f"{AGENT_MAX_EXTEND_DAYS_PER_WINDOW} 天（已用 {used} 天），请联系管理员 / "
                    f"At most {AGENT_MAX_EXTEND_DAYS_PER_WINDOW} days per customer per "
                    f"{AGENT_EXTEND_WINDOW_DAYS} days ({used} already used); contact an admin"
                ),
            )
        # 从"还没过期的到期日"往后接，过期或 FREE 则从此刻起算——否则给一个
        # 上个月就到期的人加 30 天，会算出一个仍然在过去的到期日。
        # Extend from a still-future expiry, otherwise from now: adding 30 days
        # to an expiry that lapsed last month would land in the past.
        base = now
        if old_expiry is not None:
            current = old_expiry if old_expiry.tzinfo else old_expiry.replace(tzinfo=timezone.utc)
            if current > now:
                base = current
        target.plan = "PRO"
        target.plan_expires_at = (base + timedelta(days=days)).replace(tzinfo=None)
        granted_days = days
    else:
        if _has_live_paid_plan(db, target.id, now):
            raise HTTPException(
                status_code=409,
                detail=(
                    "该用户有仍在有效期内的付费订单，请联系管理员 / "
                    "This user has a paid order still within its term; contact an admin"
                ),
            )
        target.plan = "FREE"
        target.plan_expires_at = None

    # 代理的手动调整与管理员的一样是权威操作，盖掉试用状态：否则一个正在试用的
    # 人被延长之后，plan_is_trial 还挂着 True，到期降级那套会把他当试用处理。
    # Like an admin's, a manual change is authoritative and clears the trial flag.
    target.plan_is_trial = False

    _log_change(db, agent.id, target.id, f"agent:{code}:plan", old_plan, target.plan)
    _log_change(
        db, agent.id, target.id, f"agent:{code}:plan_expires_at", old_expiry, target.plan_expires_at
    )
    if granted_days:
        # 配额账本那一行（见 _AGENT_EXTEND_AUDIT_SUFFIX）。old_value 用 0 而不是
        # None：log_change 在 old == new 时会跳过写入，天数恒为正所以不会撞上，
        # 但显式写出来免得将来有人把"加 0 天"当成合法输入。
        # The quota ledger row. old_value is an explicit 0 because log_change
        # skips no-op writes; the day count is always positive so it never
        # collides, but spelling it out keeps a future "extend by 0" honest.
        _log_change(
            db,
            agent.id,
            target.id,
            f"agent:{code}{_AGENT_EXTEND_AUDIT_SUFFIX}",
            0,
            granted_days,
        )
    summary = (
        f"{agent.email} → {target.email}: "
        + (f"+{granted_days}d PRO" if granted_days else "PRO → FREE")
    )
    admin_ids = _notify_admins_agent_write(db, agent, target, summary)
    db.commit()
    db.refresh(target)
    for admin_id in admin_ids:
        notify_ws(admin_id)
    return _agent_user_out(db, target)


def _agent_user_out(db: Session, u: User) -> AgentLinkUserOut:
    """一个用户在代理名单里的那一行。列表与改完之后的单行响应共用这一处构造，
    免得哪天加了字段只补了其中一边（admin._user_out 也是这个理由）。
    One construction site for the row, shared by the list and the post-change
    response — the same reason admin._user_out exists."""
    return AgentLinkUserOut(
        nickname=u.nickname,
        email=u.email,
        plan=u.plan,
        createdAt=u.created_at,
        planExpiresAt=u.plan_expires_at,
        lastActiveDay=_last_active_days(db, [u.id]).get(u.id),
        mt5Accounts=_mt5_accounts(db, [u.id]).get(u.id, []),
    )


# ---------- 代理层级 / agent hierarchy ----------
#
# 规则见 AgentNode 模型注释与 services/agent_tree 顶部（rev 50）。几条贯穿下面所有端点的约定：
# - 范围 = 归属在自己与全部下级名下的普通客户 + 全部下级代理本人；不在范围内的人与不存在的人
#   同一个 404，不给「这个人存在但不归你」的信号；
# - 写操作只有一级代理能做（_require_top，403）；
# - 目标一律按邮箱定位，user id 不下发给代理（同 AgentPlanUpdate）。
# Rules are in the AgentNode docstring and services/agent_tree (rev 50). Scope =
# customers owned by the caller or any descendant, plus the descendant agents;
# out-of-scope and unknown are the same 404; writes are top-level only (403);
# targets are addressed by email, never by user id.

_MSG_TOP_ONLY = "只有一级推荐官可以操作 / Only top-level ambassadors can do this"
_MSG_NO_PLAN_RIGHT = (
    "管理员还没有给你开通修改会员的权限 / An admin has not given you the right to change plans"
)
_MSG_USER_NOT_FOUND = "用户不存在 / User not found"


def _caller_level(db: Session, user: User) -> int | None:
    """调用者是第几级代理；不是代理返回 None。/ The caller's level, or None for non-agents."""
    node = node_of(db, user.id)
    return (node.depth or 1) if node is not None else None


def _require_top(db: Session, user: User) -> None:
    if _caller_level(db, user) != 1:
        raise HTTPException(status_code=403, detail=_MSG_TOP_ONLY)


def _require_plan_right(db: Session, user: User) -> None:
    """改会员只看管理员给的 can_set_plan（rev 51），不看层级：一级没开也不行，二级开了就行。
    Changing plans needs the admin-granted can_set_plan (rev 51), whatever the level."""
    node = node_of(db, user.id)
    if node is None or not node.can_set_plan:
        raise HTTPException(status_code=403, detail=_MSG_NO_PLAN_RIGHT)


class _Scope:
    """一个代理此刻的范围：自己与全部下级的 id（客户归属看它们），下级代理本人的 id，
    以及这些人持有的链接 {code: (主人, 链接)}。
    An agent's scope: their own and descendants' ids (customer owners), the
    descendant agents themselves, and the links they hold."""

    def __init__(self, db: Session, user: User):
        self.nodes = descendants(db, user.id)
        self.agent_ids = [n.user_id for n in self.nodes]
        self.owner_ids = [user.id] + self.agent_ids
        self.parent_of = {n.user_id: n.parent_user_id for n in self.nodes}
        self.codes = links_by_code(db, self.owner_ids)

    def filter(self):
        return scope_filter(self.owner_ids, self.agent_ids)


def _tree_target(db: Session, scope: _Scope, email: str, agent: User) -> User:
    """按邮箱在范围内找人：不在范围 / 不存在 / 管理员都是 404，自己 403。
    Resolve an in-scope user by email: out of scope, unknown or admin is 404; self is 403."""
    if email.strip().lower() == (agent.email or "").lower():
        raise HTTPException(
            status_code=403,
            detail="不能修改自己的会员 / You cannot change your own plan",
        )
    target = (
        db.query(User)
        .filter(func.lower(User.email) == email.strip().lower(), scope.filter())
        .first()
    )
    if target is None or target.role == "admin":
        # 管理员即使真归在这棵树下也不给动——代理不该有任何触碰管理员账号的路径。
        # Admins are untouchable even if they sit in the tree.
        raise HTTPException(status_code=404, detail=_MSG_USER_NOT_FOUND)
    return target


def _via_of(scope: _Scope, u: User) -> str | None:
    """这个人在树上挂在谁下面：代理看节点的上级，客户看归属。
    Whom this person hangs under: an agent's parent, a customer's owner."""
    if u.id in scope.parent_of:
        return scope.parent_of[u.id]
    return u.agent_user_id


def _tree_user_outs(
    db: Session, rows: list[User], scope: _Scope, show_levels: bool = True
) -> list[AgentTreeUserOut]:
    """一批客户行：活跃日、MT5、挂在哪个代理下、自己是不是代理，各一条批量查询。
    show_levels=False（二级起的代理在看）时只说是不是代理、不给层级。
    A batch of customer rows; one batched query per extra column. With
    show_levels=False (a sub-agent viewing) only isAgent is given, no level."""
    ids = [u.id for u in rows]
    last_active = _last_active_days(db, ids)
    accounts = _mt5_accounts(db, ids)
    levels = (
        dict(db.query(AgentNode.user_id, AgentNode.depth).filter(AgentNode.user_id.in_(ids)).all())
        if ids
        else {}
    )
    via_ids = list({v for v in (_via_of(scope, u) for u in rows) if v})
    vias = {o.id: o for o in db.query(User).filter(User.id.in_(via_ids)).all()} if via_ids else {}
    out = []
    for u in rows:
        via = vias.get(_via_of(scope, u) or "")
        out.append(
            AgentTreeUserOut(
                nickname=u.nickname,
                email=u.email,
                plan=u.plan,
                createdAt=u.created_at,
                planExpiresAt=u.plan_expires_at,
                lastActiveDay=last_active.get(u.id),
                mt5Accounts=accounts.get(u.id, []),
                viaEmail=via.email if via else None,
                viaNickname=via.nickname if via else None,
                isAgent=u.id in levels,
                agentLevel=levels.get(u.id) if show_levels else None,
            )
        )
    return out


def _owner_counts(db: Session, owner_ids: list[str]) -> tuple[dict, dict, dict]:
    """按归属代理汇总：(客户数, 近 7 日活跃人数, 已连 MT5 人数)，各一条 GROUP BY。只数普通客户。
    Per owning agent: customers, 7-day actives, MT5-connected; one GROUP BY each."""
    if not owner_ids:
        return {}, {}, {}
    base = (User.agent_user_id.in_(owner_ids), is_customer())
    regs = dict(db.query(User.agent_user_id, func.count(User.id)).filter(*base).group_by(User.agent_user_id).all())
    active = dict(
        db.query(User.agent_user_id, func.count(func.distinct(PageVisitorDay.user_id)))
        .join(PageVisitorDay, PageVisitorDay.user_id == User.id)
        .filter(*base, PageVisitorDay.day >= _active_window_start())
        .group_by(User.agent_user_id)
        .all()
    )
    mt5 = dict(
        db.query(User.agent_user_id, func.count(func.distinct(MT5Account.user_id)))
        .join(MT5Account, MT5Account.user_id == User.id)
        .filter(*base, MT5Account.revoked_at.is_(None))
        .group_by(User.agent_user_id)
        .all()
    )
    return regs, active, mt5


def agent_team(db: Session, user: User) -> AgentTeamOut:
    """我的团队：自己 + 全部下级，每人带直属客户数、整棵子树客户数、近 7 日活跃、已连 MT5。
    数字按归属（users.agent_user_id）汇总。自己那一行不带上级——下级看不到上级。
    The caller's team: self plus every descendant, with direct and subtree
    customer counts, 7-day actives and MT5 head count, summed by owning agent.
    The caller's own row carries no parent: looking upwards is not possible."""
    max_depth = get_agent_settings(db)["agent_max_depth"]
    level = _caller_level(db, user)
    if level is None:
        return AgentTeamOut(level=None, canManage=False, canSetPlan=False, maxDepth=max_depth, nodes=[])
    scope = _Scope(db, user)
    nodes = scope.nodes
    direct, act, m5 = _owner_counts(db, scope.owner_ids)
    # 宽度优先倒过来走 = 先子后父，每个节点加到父节点上时自己的子树已经算完。
    # Reversed breadth-first visits children before parents, so each subtree total
    # is final by the time it is added to its parent.
    team = dict(direct)
    for n in reversed(nodes):
        team[n.parent_user_id] = team.get(n.parent_user_id, 0) + team.get(n.user_id, 0)
    ids = scope.owner_ids
    people = {u.id: u for u in db.query(User).filter(User.id.in_(ids)).all()}
    me = node_of(db, user.id)

    def row(uid: str, lvl: int | None, parent: str | None, created) -> AgentTeamNodeOut:
        u = people.get(uid)
        p = people.get(parent) if parent else None
        return AgentTeamNodeOut(
            email=u.email if u else "",
            nickname=u.nickname if u else None,
            level=lvl,
            parentEmail=p.email if p else None,
            isSelf=uid == user.id,
            directCustomers=direct.get(uid, 0),
            teamCustomers=team.get(uid, 0),
            activeUsers7d=act.get(uid, 0),
            mt5Users=m5.get(uid, 0),
            createdAt=created,
        )

    # 层级只给一级代理看：二级起连自己是第几级都不下发（下级的层级减一就是自己的，一起抹掉）。
    # Levels go to top-level agents only — a sub-agent's children would give theirs away too.
    top = level == 1
    out = [row(user.id, level if top else None, None, me.created_at if me else None)]
    out += [row(n.user_id, (n.depth or 1) if top else None, n.parent_user_id, n.created_at) for n in nodes]
    return AgentTeamOut(
        isAgent=True,
        level=level if top else None,
        canManage=top,
        canSetPlan=bool(me and me.can_set_plan),
        maxDepth=max_depth,
        nodes=out,
    )


def agent_tree_users(
    db: Session,
    user: User,
    limit: int = PAGE_SIZE_DEFAULT,
    offset: int = 0,
    q: str | None = None,
    under: str | None = None,
    link_id: str | None = None,
) -> AgentTreeUsersOut:
    """范围内的人（rev 50：按归属，不按来源）。under 给了邮箱就只看挂在那个代理下的人（他的
    客户与直属下级代理，他得在范围内，否则 404）；link_id 给了就只看来源是那条链接的人（链接
    得是范围内某人持有的，否则 404）。
    Everyone in scope (by ownership, not source). `under` (an agent's email)
    narrows to the people hanging directly under that agent; `link_id` narrows
    to people whose source is that link. Either out of scope is a 404."""
    if _caller_level(db, user) is None:
        return AgentTreeUsersOut(users=[], total=0, limit=limit, offset=offset)
    scope = _Scope(db, user)
    query = db.query(User).filter(scope.filter())
    if under:
        owner = (
            db.query(User.id)
            .filter(func.lower(User.email) == under.strip().lower(), User.id.in_(scope.owner_ids))
            .first()
        )
        if owner is None:
            raise HTTPException(status_code=404, detail="推荐官不存在 / Ambassador not found")
        kids = [uid for uid, parent in scope.parent_of.items() if parent == owner[0]]
        query = query.filter(
            or_(and_(User.agent_user_id == owner[0], is_customer()), User.id.in_(kids or [""]))
        )
    if link_id:
        link = next((l for _o, l in scope.codes.values() if l.id == link_id), None)
        if link is None:
            raise HTTPException(status_code=404, detail="链接不存在 / Link not found")
        query = query.filter(User.invite_code == link.code)
    q = (q or "").strip()
    if q:
        # 只搜名单上本来就看得到的昵称与邮箱——手机号不在代理视野内，不能拿来撞。通配符转义。
        # Search only what the list already shows (nickname, email); wildcards escaped.
        like = f"%{_like_escape(q)}%"
        query = query.filter(or_(User.email.ilike(like, escape="\\"), User.nickname.ilike(like, escape="\\")))
    total = query.count()
    rows = query.order_by(User.created_at.desc()).offset(offset).limit(limit).all()
    users = _tree_user_outs(db, rows, scope, show_levels=_caller_level(db, user) == 1)
    return AgentTreeUsersOut(users=users, total=total, limit=limit, offset=offset)


def agent_tree_set_plan(db: Session, agent: User, body: AgentPlanUpdate) -> AgentTreeUserOut:
    """有改会员权限的代理（rev 51，管理员给的，任何层级）给自己整支团队里的人改会员。
    边界、配额、审计、通知全部在 _apply_agent_plan。
    An agent holding the plan right (rev 51, admin-granted, any level) changes the
    plan of anyone in their team; guards live in _apply_agent_plan."""
    _require_plan_right(db, agent)
    scope = _Scope(db, agent)
    target = _tree_target(db, scope, body.email, agent)
    _apply_agent_plan(db, agent, target, target.invite_code or "-", body)
    return _tree_user_outs(db, [target], scope)[0]


def _promoted_label(target: User) -> str:
    """自动生成的链接的标记名：昵称，没有就用邮箱 @ 前面那段。管理后台的链接列表靠它认人。
    Label for an auto-created link: the nickname, else the email's local part."""
    name = (target.nickname or "").strip() or target.email.split("@", 1)[0]
    return name[:40]


def _check_depth(db: Session, depth: int) -> None:
    max_depth = get_agent_settings(db)["agent_max_depth"]
    if depth > max_depth:
        raise HTTPException(
            status_code=409,
            detail=(
                f"已达到最大层级（{max_depth} 级），不能再往下设推荐官 / "
                f"The maximum depth ({max_depth} levels) is reached"
            ),
        )


def _mint_agent_link(db: Session, actor: User, target: User, grants_trial: bool) -> InviteLink:
    """给新代理生成一条专属链接：送不送试用由调用方定，开户网址留空由他自己填。审计照管理员
    建链接的写法（invite:{code}）加一条主人变更（link_owner:{code}）。
    Mint a new agent's own link; audited like an admin-created link plus an owner change."""
    link = InviteLink(
        code=new_unique_code(db),
        label=_promoted_label(target),
        is_active=True,
        grants_trial=grants_trial,
        competition_id=None,
        channel=None,
    )
    db.add(link)
    set_link_owner(db, link, target.id, actor.id)
    db.flush()
    _log_change(db, actor.id, actor.id, f"invite:{link.code}", None, _audit_value(link))
    _log_change(db, actor.id, target.id, f"link_owner:{link.code}", None, target.email)
    return link


def agent_promote(db: Session, actor: User, email: str) -> AgentTreeUserOut:
    """一级代理把自己范围里的一个普通客户升为代理。

    新代理的上级是这个客户此刻的归属代理（不一定是 actor 本人），层级 = 上级层级 + 1，不得超过
    agent_max_depth。系统给他生成一条专属链接：送不送试用跟他来源那条链接一致。被升的人收到一条
    站内通知，管理员各收到一条。

    A top-level agent promotes a customer in their scope. The new parent is the
    customer's owning agent, level = parent + 1, capped by agent_max_depth. A
    fresh link is minted (trial setting copied from their source link); the
    user and every admin get an in-app notification.
    """
    _require_top(db, actor)
    scope = _Scope(db, actor)
    target = _tree_target(db, scope, email, actor)
    if node_of(db, target.id) is not None:
        raise HTTPException(status_code=409, detail="该用户已经是推荐官 / This user is already an ambassador")
    parent_node = node_of(db, target.agent_user_id) if target.agent_user_id else None
    if parent_node is None:
        # 范围内的客户必有归属代理且在树上；走到这里只可能是脏数据，按不存在处理。
        # An in-scope customer always has an owning agent on the tree; dirty data otherwise.
        raise HTTPException(status_code=404, detail=_MSG_USER_NOT_FOUND)
    depth = (parent_node.depth or 1) + 1
    _check_depth(db, depth)
    source = db.query(InviteLink).filter(InviteLink.code == target.invite_code).first() if target.invite_code else None
    add_node(db, target.id, parent_node, actor.id)
    _mint_agent_link(db, actor, target, bool(source.grants_trial) if source is not None else False)
    create_notification(db, target.id, KIND_AGENT_PROMOTED, link="/agent")
    admin_ids = _notify_admins_agent_write(
        db, actor, target, f"{actor.email} → {target.email}: L{depth} ambassador", KIND_AGENT_TREE_CHANGE
    )
    db.commit()
    db.refresh(target)
    notify_ws(target.id)
    for admin_id in admin_ids:
        notify_ws(admin_id)
    return _tree_user_outs(db, [target], _Scope(db, actor))[0]


def _revoke(db: Session, actor: User, node: AgentNode) -> None:
    """撤销一个代理的唯一路径（代理页与管理后台共用）：机制见 services/agent_tree.remove_node。
    一级代理下面还有下级 → 409（产品决定：先改挂或撤下级）。每条去向各写一条审计。不提交。
    The single revoke path shared by the agent page and the admin console. A
    top-level agent with sub-agents is refused (409). Audited; does not commit."""
    if node.parent_user_id is None and _has_children(db, node.user_id):
        raise HTTPException(status_code=409, detail=_MSG_HAS_CHILDREN)
    target = db.get(User, node.user_id)
    parent = db.get(User, node.parent_user_id) if node.parent_user_id else None
    before = {l.id: _audit_value(l) for l in db.query(InviteLink).filter(InviteLink.owner_user_id == node.user_id)}
    links, customers = remove_node(db, node)
    _log_change(db, actor.id, node.user_id, "agent_parent", parent.email if parent else "-", None)
    for link in links:
        # 10-28 起链接一律收回成平台链接（remove_node），新主人为空。/ Links now go back to the platform.
        _log_change(
            db, actor.id, node.user_id, f"link_owner:{link.code}", target.email if target else None, None
        )
        if before.get(link.id) != _audit_value(link):
            _log_change(db, actor.id, actor.id, f"invite:{link.code}", before.get(link.id), _audit_value(link))
    for uid in customers:
        _log_change(db, actor.id, uid, "agent_user", target.email if target else None, parent.email if parent else None)


def agent_demote(db: Session, actor: User, email: str) -> AgentTeamOut:
    """一级代理撤销自己树里的一个代理（见 _revoke）。不在 actor 子树里的代理（包括 actor 自己）
    一律 404。返回刷新后的团队。
    A top-level agent removes an agent below them (see _revoke). Anyone not
    strictly below the actor — the actor included — is a 404."""
    _require_top(db, actor)
    target = db.query(User).filter(func.lower(User.email) == email.strip().lower()).first()
    node = node_of(db, target.id) if target is not None else None
    if node is None or node.user_id not in {n.user_id for n in descendants(db, actor.id)}:
        raise HTTPException(status_code=404, detail="推荐官不存在 / Ambassador not found")
    _revoke(db, actor, node)
    admin_ids = _notify_admins_agent_write(
        db, actor, target, f"{actor.email} → {target.email}: ambassador revoked", KIND_AGENT_TREE_CHANGE
    )
    db.commit()
    for admin_id in admin_ids:
        notify_ws(admin_id)
    return agent_team(db, actor)


def admin_agent_tree(db: Session) -> AdminAgentTreeOut:
    """管理后台「代理」：全部代理、各自的链接与客户数。按 (层级, 任命时间) 排好，前端拼树。
    The admin tree: every agent with links and customer counts, sorted by
    (level, created_at); the frontend assembles the tree."""
    nodes = db.query(AgentNode).all()
    nodes.sort(key=lambda n: (n.depth or 1, n.created_at is None, n.created_at or datetime.min))
    ids = [n.user_id for n in nodes]
    codes = links_by_code(db, ids)
    direct, _active, _mt5 = _owner_counts(db, ids)
    links: dict[str, list[AdminAgentTreeLinkOut]] = {}
    for code, (owner, link) in sorted(codes.items(), key=lambda kv: kv[1][1].created_at or datetime.min):
        links.setdefault(owner, []).append(
            AdminAgentTreeLinkOut(id=link.id, code=link.code, label=link.label, isActive=link.is_active)
        )
    # 深的先加到父节点上，与 agent_team 同一个思路。/ Deepest first, as in agent_team.
    team = dict(direct)
    known = set(ids)
    for n in sorted(nodes, key=lambda n: -(n.depth or 1)):
        if n.parent_user_id in known:
            team[n.parent_user_id] = team.get(n.parent_user_id, 0) + team.get(n.user_id, 0)
    people = {u.id: u for u in db.query(User).filter(User.id.in_(ids)).all()} if ids else {}
    return AdminAgentTreeOut(
        maxDepth=get_agent_settings(db)["agent_max_depth"],
        nodes=[
            AdminAgentTreeNodeOut(
                userId=n.user_id,
                email=people[n.user_id].email if n.user_id in people else "",
                nickname=people[n.user_id].nickname if n.user_id in people else None,
                level=n.depth or 1,
                parentUserId=n.parent_user_id,
                links=links.get(n.user_id, []),
                directCustomers=direct.get(n.user_id, 0),
                teamCustomers=team.get(n.user_id, 0),
                canSetPlan=bool(n.can_set_plan),
                createdAt=n.created_at,
            )
            for n in nodes
        ],
    )


def admin_set_plan_right(db: Session, admin: User, user_id: str, body: AdminAgentPlanRight) -> AdminAgentTreeOut:
    """管理员开 / 关一个代理的改会员权限（rev 51）。只有管理员能动——代理页没有任何入口，
    一级代理也不能替自己或下级开。没变化不写审计；审计字段 agent_plan_right（on / off）。
    Admin switches an agent's plan right (rev 51). Agents have no way to set it,
    top level included. Audited as agent_plan_right (on / off) when it changes."""
    node = node_of(db, user_id)
    if node is None:
        raise HTTPException(status_code=404, detail="推荐官不存在 / Ambassador not found")
    if bool(node.can_set_plan) != body.enabled:
        _log_change(
            db, admin.id, user_id, "agent_plan_right",
            "on" if node.can_set_plan else "off", "on" if body.enabled else "off",
        )
        node.can_set_plan = body.enabled
        db.commit()
        notify_ws(user_id)
    return admin_agent_tree(db)


def admin_appoint_agent(db: Session, admin: User, body: AdminAgentAppoint) -> AdminAgentTreeOut:
    """管理员任命代理：挂在 parentUserId 下（null = 一级），同时生成一条专属链接——代理没链接就拉不了人，
    所以不再给「不生成」的选项（要把现成的链接给他，到推广链接里换主人，多出的这条停用即可）。
    不改他的来源，也不改任何客户（设计 §6）；他自己原来的归属代理由 add_node 清掉。已是代理 409，
    上级不是代理 404。
    Admin appoints an agent under parentUserId (null = top) and always mints
    them a link. Touches no customer; add_node clears the appointee's own owner.
    409 if already an agent; 404 for a bad parent."""
    target = db.get(User, body.userId)
    if target is None:
        raise HTTPException(status_code=404, detail=_MSG_USER_NOT_FOUND)
    if node_of(db, target.id) is not None:
        raise HTTPException(status_code=409, detail="该用户已经是推荐官 / This user is already an ambassador")
    parent = None
    if body.parentUserId:
        parent = node_of(db, body.parentUserId)
        if parent is None:
            raise HTTPException(status_code=404, detail="上级不是推荐官 / The upline is not an ambassador")
    depth = (parent.depth or 1) + 1 if parent is not None else 1
    _check_depth(db, depth)
    add_node(db, target.id, parent, admin.id)
    parent_user = db.get(User, parent.user_id) if parent is not None else None
    _log_change(db, admin.id, target.id, "agent_parent", None, parent_user.email if parent_user else "-")
    _mint_agent_link(db, admin, target, False)
    create_notification(db, target.id, KIND_AGENT_PROMOTED, link="/agent")
    db.commit()
    notify_ws(target.id)
    return admin_agent_tree(db)


def admin_revoke_agent(db: Session, admin: User, user_id: str) -> AdminAgentTreeOut:
    """管理员撤销代理：与代理页撤销同一条路径（_revoke）。/ Same path as the agent page."""
    node = node_of(db, user_id)
    if node is None:
        raise HTTPException(status_code=404, detail="推荐官不存在 / Ambassador not found")
    _revoke(db, admin, node)
    db.commit()
    return admin_agent_tree(db)


def admin_move_agent(db: Session, admin: User, body: AdminAgentMove) -> AdminAgentTreeOut:
    """管理员把一个代理连同整棵子树改挂到另一个代理下面（parentUserId 为空 = 改成一级）。

    只改树（services/agent_tree.move_node）：他的客户与下级跟着他走；他自己的来源与归属不动——
    rev 50 起代理本人在树上的位置只看节点，不需要再改 invite_code 去迁就范围判断。
    挡掉：挂到自己或自己的下级下面（环）、新位置会让子树超过最大层级、上级没变。

    Admin re-parents an agent with their whole subtree (null = top level). Only
    the tree changes; customers and sub-agents come along. Cycles, exceeding the
    depth cap, and no-op moves are rejected.
    """
    node = node_of(db, body.userId)
    if node is None:
        raise HTTPException(status_code=404, detail="推荐官不存在 / Ambassador not found")
    parent = None
    if body.parentUserId:
        if body.parentUserId == node.user_id or body.parentUserId in {
            d.user_id for d in descendants(db, node.user_id)
        }:
            raise HTTPException(
                status_code=409,
                detail="不能挂到他自己或他的下级下面 / Cannot move an ambassador under themselves or their own downline ambassador",
            )
        parent = node_of(db, body.parentUserId)
        if parent is None:
            raise HTTPException(status_code=404, detail="新上级不是推荐官 / The new upline is not an ambassador")
    if (parent.user_id if parent else None) == node.parent_user_id:
        raise HTTPException(status_code=409, detail="上级没有变化 / The upline is unchanged")
    new_depth = (parent.depth or 1) + 1 if parent is not None else 1
    max_depth = get_agent_settings(db)["agent_max_depth"]
    if new_depth + subtree_height(db, node) > max_depth:
        raise HTTPException(
            status_code=409,
            detail=(
                f"挂过去后他的下线会超过最大层级（{max_depth} 级） / "
                f"The move would push their downline ambassadors past the maximum depth ({max_depth} levels)"
            ),
        )

    old_parent = db.get(User, node.parent_user_id) if node.parent_user_id else None
    new_parent = db.get(User, parent.user_id) if parent is not None else None
    move_node(db, node, parent)
    _log_change(
        db,
        admin.id,
        node.user_id,
        "agent_parent",
        old_parent.email if old_parent else "-",
        new_parent.email if new_parent else "-",
    )
    db.commit()
    return admin_agent_tree(db)


def _move_link_customers(db: Session, actor: User, link: InviteLink, old_owner: str | None, new_owner: str | None) -> int:
    """把来源是这条链接、此刻仍归旧主人的普通客户改归新主人。每人一条审计。返回人数。不提交。
    Re-own the customers from this link still owned by the old owner; audited per person."""
    owner_match = User.agent_user_id == old_owner if old_owner else User.agent_user_id.is_(None)
    ids = [uid for (uid,) in db.query(User.id).filter(User.invite_code == link.code, owner_match, is_customer())]
    if not ids:
        return 0
    emails = dict(db.query(User.id, User.email).filter(User.id.in_([i for i in (old_owner, new_owner) if i])).all())
    db.query(User).filter(User.id.in_(ids)).update({User.agent_user_id: new_owner}, synchronize_session=False)
    for uid in ids:
        _log_change(db, actor.id, uid, "agent_user", emails.get(old_owner or ""), emails.get(new_owner or ""))
    return len(ids)


def admin_set_link_owner(db: Session, admin: User, link: InviteLink, body: AdminLinkOwnerUpdate) -> None:
    """换链接主人（null = 平台链接）。新主人必须是代理；比赛推广链接不能有主人。默认只影响以后
    的新注册；moveCustomers 为真才把经这条链接注册、仍归旧主人的客户一起迁过去。不改任何人的
    代理身份（设计 §6）。
    Set a link's owner (null = platform). The owner must be an agent;
    competition links can't have one. Only future signups follow unless
    moveCustomers. Nobody's agent status changes."""
    new_owner = body.userId or None
    if new_owner is not None:
        # 比赛推广链接是平台自有的投放链接（设计 2026-10-08 §1.1），算给代理就把平台投放算走了。
        # Competition links are platform ad links; an owner would claim platform spend.
        if link.competition_id:
            raise HTTPException(
                status_code=400, detail="比赛推广链接不能指派推荐官 / Competition promo links cannot have ambassadors"
            )
        if node_of(db, new_owner) is None:
            raise HTTPException(status_code=404, detail="该用户不是推荐官 / This user is not an ambassador")
    old_owner = link.owner_user_id
    if old_owner == new_owner:
        raise HTTPException(status_code=409, detail="主人没有变化 / The owner is unchanged")
    emails = dict(db.query(User.id, User.email).filter(User.id.in_([i for i in (old_owner, new_owner) if i])).all())
    set_link_owner(db, link, new_owner, admin.id)
    _log_change(
        db, admin.id, new_owner or old_owner, f"link_owner:{link.code}",
        emails.get(old_owner or ""), emails.get(new_owner or ""),
    )
    if body.moveCustomers:
        _move_link_customers(db, admin, link, old_owner, new_owner)
    db.commit()


def _clean_channel(raw: str | None) -> str | None:
    """渠道标签去首尾空白，空白存 NULL——统计按渠道汇总时不会多出一个「空」渠道。
    Trim the channel tag; blank stores NULL so per-channel stats get no "empty" bucket."""
    ch = (raw or "").strip()
    return ch or None


def _set_open_account_url(link: InviteLink, raw: str | None) -> None:
    """管理端与代理自助共用：校验后写入，空则清除。比赛推广链接不许设（它们用比赛自己的
    开户链接），但清空对它们是无害的 no-op，照放行。两边谁后写谁算。
    Shared by admin and agent self-service: validate, then store (blank clears).
    Competition promo links can't carry one (they use the competition's), though
    clearing is a harmless no-op. Last write wins between the two callers."""
    url = normalize_agent_open_url(raw)
    if url is not None and link.competition_id:
        raise HTTPException(status_code=400, detail=MSG_COMP_LINK_OPEN_URL)
    link.open_account_url = url


def _audit_value(link: InviteLink) -> str:
    return json.dumps(
        {
            "label": link.label,
            "isActive": link.is_active,
            "grantsTrial": bool(link.grants_trial),
            "competitionId": link.competition_id,
            "channel": link.channel,
            "openAccountUrl": link.open_account_url,
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
    kind: Literal["competition", "agent", "platform"] | None = Query(default=None),
    competitionId: str | None = Query(default=None, max_length=64),
    channel: str | None = Query(default=None, max_length=32),
    # 普通默认值而不是 Query(default=False)：服务级测试直接调用本函数时不传它，
    # Query 对象本身是真值，会把已删除的链接悄悄带出来。
    # A plain default, not Query(default=False): service-level callers omit it, and a
    # Query object is truthy — it would silently include deleted links.
    includeDeleted: bool = False,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    # 分类筛选与 _link_kind 同一口径，在 SQL 里做：competition = 关联了比赛；agent /
    # platform 都要求没关联比赛，再看有没有主人。各项计数在 _link_outs 里各一条批量查询。
    # Kind filter mirrors _link_kind, done in SQL. Counts are batched in _link_outs.
    q = db.query(InviteLink)
    # 软删的链接默认不出现；用户表的归因列 / 筛选器带 includeDeleted 拉，好显示它们的名字。
    # Soft-deleted links are hidden unless includeDeleted (the users table needs labels).
    if not includeDeleted:
        q = q.filter(InviteLink.deleted_at.is_(None))
    has_agents = InviteLink.owner_user_id.isnot(None)
    if kind == "competition":
        q = q.filter(InviteLink.competition_id.isnot(None))
    elif kind == "agent":
        q = q.filter(InviteLink.competition_id.is_(None), has_agents)
    elif kind == "platform":
        q = q.filter(InviteLink.competition_id.is_(None), ~has_agents)
    if competitionId:
        q = q.filter(InviteLink.competition_id == competitionId)
    ch = (channel or "").strip()
    if ch:
        q = q.filter(InviteLink.channel == ch)
    links = q.order_by(InviteLink.created_at.desc()).all()
    return {"links": [o.model_dump(mode="json") for o in _link_outs(db, links)]}


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
    # 比赛推广链接：比赛得存在且没终审（终审后再拉人报名没有意义）。草稿也允许——
    # 管理员常在比赛编辑页先把推广链接备好。比赛 id 写入后不可改。
    # Competition promo link: the competition must exist and not be settled.
    # Drafts are allowed (links are often prepared on the edit page first).
    competition_id = None
    if body.competitionId:
        comp = db.get(Competition, body.competitionId)
        if comp is None:
            raise HTTPException(status_code=404, detail="比赛不存在 / Competition not found")
        if comp.status == "settled":
            raise HTTPException(
                status_code=400,
                detail="比赛已终审，不能再新建推广链接 / Competition is settled; promo links can no longer be created",
            )
        competition_id = comp.id
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
    link = InviteLink(
        code=new_unique_code(db),
        label=label,
        is_active=True,
        grants_trial=False,
        competition_id=competition_id,
        channel=_clean_channel(body.channel),
    )
    db.add(link)
    _log_change(db, admin.id, admin.id, f"invite:{link.code}", None, _audit_value(link))
    db.commit()
    db.refresh(link)
    return _link_out_full(db, link)


@admin_router.patch("/{link_id}", response_model=InviteLinkOut)
def update_invite_link(
    link_id: str,
    body: InviteLinkUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    link = _admin_link(db, link_id)
    data = body.model_dump(exclude_unset=True)
    old = _audit_value(link)
    # 先做会 400 的那一项，校验不过时别的字段还没动过。
    # The field that can 400 goes first, so nothing else is touched when it fails.
    if "openAccountUrl" in data:
        _set_open_account_url(link, data["openAccountUrl"])
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
    if "channel" in data:
        link.channel = _clean_channel(data["channel"])
    _log_change(db, admin.id, admin.id, f"invite:{link.code}", old, _audit_value(link))
    db.commit()
    db.refresh(link)
    return _link_out_full(db, link)


def _admin_link(db: Session, link_id: str) -> InviteLink:
    """管理端按 id 取一条未删除的链接；不存在或已软删一律 404。
    Fetch a non-deleted link for admin writes; unknown or soft-deleted is 404."""
    link = (
        db.query(InviteLink)
        .filter(InviteLink.id == link_id, InviteLink.deleted_at.is_(None))
        .first()
    )
    if link is None:
        raise HTTPException(status_code=404, detail="链接不存在 / Link not found")
    return link


def _link_out_full(db: Session, link: InviteLink) -> InviteLinkOut:
    return _link_outs(db, [link])[0]


@admin_router.delete("/{link_id}", response_model=dict)
def delete_invite_link(
    link_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """删除邀请链接（规则见 InviteLink 模型注释）。

    没有任何用户归因到这个码 → 硬删：代理行与链接行一起删，码释放（没人挂在它上面，
    重新生成也不会错归因）。promo_funnel_daily 里按文本记的这个码不动——漏斗历史是
    软指标，留着。
    有人归因 → 软删：写 deleted_at、停用；链接行（连同主人）保留，new_unique_code 仍把码视为
    已占用。rev 50 起删链接**不碰任何人**：用户的来源、归属、代理身份一律不动（设计 R7）。
    不存在或已软删 → 404。两种都写一条 invite:{code} 审计。

    Delete an invite link. HARD when no user carries the code, SOFT (deleted_at,
    inactive, row and owner kept so the code is never reissued) otherwise. Since
    rev 50 deleting a link touches nobody: sources, owners and agent status all
    stay. Unknown or already soft-deleted ids are 404. Audited under invite:{code}.
    """
    link = _admin_link(db, link_id)
    attributed = db.query(User.id).filter(User.invite_code == link.code).first() is not None
    mode = "soft" if attributed else "hard"
    old = _audit_value(link)
    if attributed:
        link.deleted_at = datetime.now(timezone.utc)
        link.is_active = False
    else:
        # 冻结的旧表（rev 50 停止读写、下一版删）里可能还有指向它的行，有外键，先清掉。
        # The frozen pre-rev-50 table may still reference it via a foreign key.
        db.query(InviteLinkAgent).filter(InviteLinkAgent.link_id == link.id).delete(synchronize_session=False)
        db.delete(link)
    _log_change(
        db, admin.id, admin.id, f"invite:{link.code}", old, json.dumps({"deleted": mode})
    )
    db.commit()
    return {"mode": mode}


@admin_router.put("/{link_id}/owner", response_model=InviteLinkOut)
def put_invite_link_owner(
    link_id: str,
    body: AdminLinkOwnerUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """换链接主人 / 收回成平台链接，可选连同客户迁移（见 admin_set_link_owner）。
    Set or clear a link's owner, optionally moving its customers."""
    link = _admin_link(db, link_id)
    admin_set_link_owner(db, admin, link, body)
    return _link_out_full(db, link)


@admin_router.post("/{link_id}/agents", response_model=InviteLinkOut)
def assign_invite_agent(
    link_id: str,
    body: InviteLinkAssignAgent,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """旧接口（留一版给旧热更新包）：见 assign_agent。/ Legacy, see assign_agent."""
    link = _admin_link(db, link_id)
    target = db.query(User).filter(User.id == body.userId).first()
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在 / User not found")
    assign_agent(db, admin, link, target)
    return _link_out_full(db, link)


@admin_router.delete("/{link_id}/agents/{user_id}", response_model=InviteLinkOut)
def unassign_invite_agent(
    link_id: str,
    user_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """旧接口（留一版）：见 unassign_agent。/ Legacy, see unassign_agent."""
    link = _admin_link(db, link_id)
    unassign_agent(db, admin, link, user_id)
    return _link_out_full(db, link)


# ---------- 代理端点 / agent endpoints ----------


@agent_router.get("/links", response_model=dict)
def my_agent_links(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """我持有的链接：点击、注册人数、近 7 日活跃人数、已连 MT5 人数、状态。
    非代理拿到空数组，不是 403——前端入口本就按 isAgent 隐藏，这里不必再多一种
    错误形态。
    Links I hold, with clicks, signups, 7-day actives, MT5-connected head count
    and status. Non-agents get an empty list rather than 403: the entry point is
    already hidden by isAgent, no need for one more error shape."""
    return {"links": [l.model_dump(mode="json") for l in agent_links(db, user)]}


@agent_router.get("/links/{link_id}/overview", response_model=AgentOverviewOut)
def my_agent_link_overview(
    link_id: str,
    range_: str | None = Query(None, alias="range"),
    from_: date | None = Query(None, alias="from"),
    to: date | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """这条链接的看板：头部指标 + 活跃/新注册趋势。范围参数与管理看板完全一致
    （预设 `range=` 或自定义 `from=&to=`，都不给默认本月），解析也是同一个函数。
    One link's dashboard: headline tiles plus the activity/signup trend. Same
    range parameters and the same parser as the admin dashboard."""
    return agent_overview(db, user, link_id, _resolve_range_or_422(range_, from_, to))


@agent_router.patch("/links/{link_id}/users/plan", response_model=AgentLinkUserOut)
@limiter.limit("30/minute")
def my_agent_set_user_plan(
    request: Request,
    link_id: str,
    body: AgentPlanUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """旧接口（留一版给旧热更新包，新前端用 PATCH /agent/customers/plan）：按链接改会员。
    边界与审计见 agent_set_plan；限流理由：能改别人的权益，被脚本连点会把一整批人开成 PRO。
    Legacy per-link plan change (one release; new clients use /agent/customers/plan).
    Rate-limited because a script could mint PRO in bulk."""
    return agent_set_plan(db, user, link_id, body)


@agent_router.patch("/links/{link_id}/open-account-url", response_model=AgentLinkOut)
@limiter.limit("30/minute")
def my_agent_set_open_account_url(
    request: Request,
    link_id: str,
    body: AgentOpenAccountUrlUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """代理设置 / 清除自己链接的开户链接：经这条链接进比赛页的访客点「开户」时跳这里。
    不是自己的链接 404（_owned_link）；校验与管理端同一个口（_set_open_account_url）；
    审计行照 invite:{code} 惯例，操作者就是代理本人。与管理端谁后写谁算。
    Agent sets/clears their own link's open-account URL. Not-yours is 404; same
    validation as the admin path; audited under invite:{code} with the agent as
    the actor. Last write wins against the admin."""
    link = _owned_link(db, user, link_id)
    old = _audit_value(link)
    _set_open_account_url(link, body.url)
    _log_change(db, user.id, user.id, f"invite:{link.code}", old, _audit_value(link))
    db.commit()
    db.refresh(link)
    return _agent_link_outs(db, [link])[0]


@agent_router.get("/links/{link_id}/users", response_model=AgentLinkUsersOut)
def my_agent_link_users(
    link_id: str,
    limit: int = Query(default=PAGE_SIZE_DEFAULT, ge=1, le=PAGE_SIZE_MAX),
    offset: int = Query(default=0, ge=0),
    q: str | None = Query(default=None, max_length=128, description="按昵称或邮箱模糊搜索 / fuzzy search by nickname or email"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return agent_link_users(db, user, link_id, limit, offset, q)


# ---------- 代理层级端点（rev 47）/ agent hierarchy endpoints ----------


@agent_router.get("/team", response_model=AgentTeamOut)
def my_agent_team(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """我是第几级、能不能改、我这棵树。非代理拿到 level=null 的空树，不是 403（同 /agent/links）。
    My level, write access and tree. Non-agents get an empty tree, not a 403."""
    return agent_team(db, user)


@agent_router.get("/customers", response_model=AgentTreeUsersOut)
def my_agent_customers(
    limit: int = Query(default=PAGE_SIZE_DEFAULT, ge=1, le=PAGE_SIZE_MAX),
    offset: int = Query(default=0, ge=0),
    q: str | None = Query(default=None, max_length=128),
    agent: str | None = Query(default=None, max_length=320, description="只看挂在这个代理下的人（邮箱）/ narrow to one agent (email)"),
    link: str | None = Query(default=None, max_length=64, description="只看来源是这条链接的人 / narrow to one source link"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return agent_tree_users(db, user, limit, offset, q, agent, link)


@agent_router.patch("/customers/plan", response_model=AgentTreeUserOut)
@limiter.limit("30/minute")
def my_agent_customer_plan(
    request: Request,
    body: AgentPlanUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """有改会员权限的代理（rev 51，管理员给的）改整支团队里某个客户的会员。限流理由同按链接改的那条（它能批量开 PRO）。
    Needs the admin-granted plan right; rate-limited like the per-link endpoint."""
    return agent_tree_set_plan(db, user, body)


@agent_router.post("/promote", response_model=AgentTreeUserOut)
@limiter.limit("30/minute")
def my_agent_promote(
    request: Request,
    body: AgentTreeTarget,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return agent_promote(db, user, body.email)


@agent_router.post("/demote", response_model=AgentTeamOut)
@limiter.limit("30/minute")
def my_agent_demote(
    request: Request,
    body: AgentTreeTarget,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return agent_demote(db, user, body.email)


@admin_agents_router.get("/tree", response_model=AdminAgentTreeOut)
@admin_router.get("/agent-tree", response_model=AdminAgentTreeOut)
def get_agent_tree(db: Session = Depends(get_db), _admin: User = Depends(require_admin)):
    """全部代理。旧路径 /admin/invite-links/agent-tree 留一版。/ Legacy path kept one release."""
    return admin_agent_tree(db)


@admin_agents_router.post("", response_model=AdminAgentTreeOut)
def post_appoint_agent(
    body: AdminAgentAppoint,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    return admin_appoint_agent(db, admin, body)


@admin_agents_router.post("/move", response_model=AdminAgentTreeOut)
@admin_router.post("/agent-tree/move", response_model=AdminAgentTreeOut)
def post_agent_tree_move(
    body: AdminAgentMove,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    return admin_move_agent(db, admin, body)


@admin_agents_router.put("/{user_id}/plan-right", response_model=AdminAgentTreeOut)
def put_agent_plan_right(
    user_id: str,
    body: AdminAgentPlanRight,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    return admin_set_plan_right(db, admin, user_id, body)


@admin_agents_router.post("/{user_id}/revoke", response_model=AdminAgentTreeOut)
def post_revoke_agent(
    user_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    return admin_revoke_agent(db, admin, user_id)


@admin_agents_router.put("/settings", response_model=AdminAgentTreeOut)
@admin_router.put("/agent-settings", response_model=AdminAgentTreeOut)
def put_agent_settings(
    body: AdminAgentSettingsUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """改最大层级。调低不动已有的代理（见 settings_store.AGENT_DEFAULTS）。审计照平台设置的
    逐键写法（setting:agent:<key>）。
    Change the max depth; lowering it demotes nobody. Audited per key like the
    other platform settings."""
    old = get_agent_settings(db)["agent_max_depth"]
    save_agent_settings(db, {"agent_max_depth": body.maxDepth})
    _log_change(db, admin.id, admin.id, "setting:agent:agent_max_depth", json.dumps(old), json.dumps(body.maxDepth))
    db.commit()
    invalidate_agent_cache()
    return admin_agent_tree(db)
