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
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import AdminAuditLog, InviteLink, InviteLinkAgent, MT5Account, PageVisitorDay, Payment, User
from app.schemas import (
    AgentLinkOut,
    AgentLinkUserOut,
    AgentLinkUsersOut,
    AgentMT5AccountOut,
    AgentOverviewOut,
    AgentPlanUpdate,
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
from app.services.agents import is_agent
from app.services.audit import log_change as _log_change
from app.services.deps import get_current_user, require_admin
from app.services.gamification import mask_account
from app.services.gateway_binding import is_revoked, not_removed
from app.services.notification_feed import (
    KIND_AGENT_PLAN_CHANGE,
    create_notification,
    notify_ws,
)
from app.services.pagination import (
    PAGE_SIZE_DEFAULT,
    PAGE_SIZE_MAX,
    resolve_range_or_422 as _resolve_range_or_422,
)
from app.services.plans import PLAN_DAYS, trial_grant_days
from app.services.stats_time import RangeSpec
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
# 代理页：只要求登录，不要求管理员。「是不是代理」不看 role，看 invite_link_agents
# 里有没有这个人的行（见 is_agent）；每个端点再各自按 link 归属校验，不属于自己
# 的链接一律 404——不给「链接存在但不是你的」这种信号。
# Agent view: login only, no admin. Agent-ness is not a role but the presence of
# a row in invite_link_agents (see is_agent); every endpoint re-checks ownership
# per link and answers 404 for links that aren't the caller's — no "exists but
# not yours" signal.
agent_router = APIRouter(prefix="/agent", tags=["agent"])

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
    # 全局那一半（总闸 + 天数非正当成不发）在 services/plans.trial_grant_days，
    # 与「登录后自己领」那条路共用同一处判定——见那个函数的说明。本函数只再叠上
    # 链接自己的开关。
    # The global half (master switch + non-positive day count) lives in
    # services/plans.trial_grant_days, shared with the self-claim path; this
    # function only adds the per-link switch on top.
    return trial_grant_days(db)


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


def _link_out(
    link: InviteLink, registrations: int, agents: list[InviteLinkAgentOut] | None = None
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
    )


# ---------- 代理指派 / agent assignment ----------


# is_agent 现在住在 services/agents.py，这里从上面 import 进来当本模块的名字用：
# 「代理」这个概念的入口本来就在这个文件，从 app.routers.invite 取它的既有调用方
# （含测试）不该因为一次内部搬家而改动。
# is_agent now lives in services/agents.py and is re-exported here: this file is
# where the agent concept is documented, and existing callers (tests included)
# shouldn't have to move for an internal relocation.

def _agents_by_link(db: Session, link_ids: list[str]) -> dict[str, list[InviteLinkAgentOut]]:
    """一次 join 取出这批链接各自的代理，避免每行一查。One join for all links, no N+1."""
    out: dict[str, list[InviteLinkAgentOut]] = {}
    if not link_ids:
        return out
    rows = (
        db.query(InviteLinkAgent, User.email, User.nickname)
        .join(User, User.id == InviteLinkAgent.user_id)
        .filter(InviteLinkAgent.link_id.in_(link_ids))
        .order_by(InviteLinkAgent.created_at)
        .all()
    )
    for a, email, nickname in rows:
        out.setdefault(a.link_id, []).append(
            InviteLinkAgentOut(userId=a.user_id, email=email, nickname=nickname, assignedAt=a.created_at)
        )
    return out


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


def assign_agent(db: Session, admin: User, link: InviteLink, target: User) -> InviteLinkAgent:
    """把链接指派给用户。已指派返回 409。审计行的 target 是被指派的真实用户——
    这是 invite:* 审计里唯一能填真目标的地方（链接本身不是 users 行）。
    Assign a link to a user; 409 if already assigned. The audit target is the
    assigned user — the one invite:* audit row that can carry a real target."""
    exists = (
        db.query(InviteLinkAgent.id)
        .filter(InviteLinkAgent.link_id == link.id, InviteLinkAgent.user_id == target.id)
        .first()
    )
    if exists is not None:
        raise HTTPException(
            status_code=409, detail="该用户已是此链接的代理 / User is already an agent of this link"
        )
    row = InviteLinkAgent(link_id=link.id, user_id=target.id, assigned_by=admin.id)
    db.add(row)
    _log_change(db, admin.id, target.id, f"invite:{link.code}:agent", None, "assigned")
    db.commit()
    return row


def unassign_agent(db: Session, admin: User, link: InviteLink, user_id: str) -> None:
    row = (
        db.query(InviteLinkAgent)
        .filter(InviteLinkAgent.link_id == link.id, InviteLinkAgent.user_id == user_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="指派不存在 / Assignment not found")
    db.delete(row)
    _log_change(db, admin.id, user_id, f"invite:{link.code}:agent", "assigned", None)
    db.commit()


def agent_links(db: Session, user: User) -> list[AgentLinkOut]:
    """当前用户持有的全部链接（含已停用——停用后名单仍是他的，数据不该消失）。
    Every link the user holds, disabled ones included: the list stays theirs."""
    links = (
        db.query(InviteLink)
        .join(InviteLinkAgent, InviteLinkAgent.link_id == InviteLink.id)
        .filter(InviteLinkAgent.user_id == user.id)
        .order_by(InviteLink.created_at.desc())
        .all()
    )
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
        )
        for l in links
    ]


def _owned_link(db: Session, user: User, link_id: str) -> InviteLink:
    link = (
        db.query(InviteLink)
        .join(InviteLinkAgent, InviteLinkAgent.link_id == InviteLink.id)
        .filter(InviteLink.id == link_id, InviteLinkAgent.user_id == user.id)
        .first()
    )
    if link is None:
        # 不存在与不是你的同一个 404 / not-found and not-yours are the same 404
        raise HTTPException(status_code=404, detail="链接不存在 / Link not found")
    return link


def agent_link_users(
    db: Session, user: User, link_id: str, limit: int = PAGE_SIZE_DEFAULT, offset: int = 0
) -> AgentLinkUsersOut:
    """经某条链接注册的用户名单，只读，字段见 AgentLinkUserOut。
    The read-only signup list for one link; fields per AgentLinkUserOut."""
    link = _owned_link(db, user, link_id)
    q = db.query(User).filter(User.invite_code == link.code)
    total = q.count()
    rows = q.order_by(User.created_at.desc()).offset(offset).limit(limit).all()
    # 活跃日与 MT5 绑定各一条批量查询，只针对当前这一页的人——名单可以很长，
    # 逐行查会让页数一多就变成几百条查询。
    # One batched query each for activity and bindings, scoped to this page only.
    ids = [u.id for u in rows]
    last_active = _last_active_days(db, ids)
    accounts = _mt5_accounts(db, ids)
    return AgentLinkUsersOut(
        users=[
            AgentLinkUserOut(
                nickname=u.nickname,
                email=u.email,
                plan=u.plan,
                createdAt=u.created_at,
                planExpiresAt=u.plan_expires_at,
                lastActiveDay=last_active.get(u.id),
                mt5Accounts=accounts.get(u.id, []),
            )
            for u in rows
        ],
        total=total,
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


def _agent_target(db: Session, link: InviteLink, email: str) -> User:
    """按 (链接, 邮箱) 找人。不是这条链接带来的、或者压根不存在，都是同一个 404。

    邮箱大小写不敏感：名单上显示什么，前端就回传什么，但库里存的是注册时那一份，
    中间任何一段（复制粘贴、输入法首字母大写）都可能改掉大小写。

    Resolve the target by (link, email); not-yours and not-found are the same
    404. Case-insensitive, because the address can pass through anything that
    capitalises it between the list and the request.
    """
    target = (
        db.query(User)
        .filter(func.lower(User.email) == email.strip().lower(), User.invite_code == link.code)
        .first()
    )
    if target is None or target.role == "admin":
        # 管理员即使真是这条链接注册的也不给动——代理不该有任何触碰管理员账号的路径。
        # Admins are untouchable here even if they did sign up through the link.
        raise HTTPException(status_code=404, detail="用户不存在 / User not found")
    return target


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
    表是不可变的事实，按 finished_at + 套餐天数算出这笔钱买到的窗口，落在窗口里
    就说明"他现在的权益是花钱买的"。

    只看 FINISHED：PROCESSING 的钱还没到账，EXPIRED/FAILED 的从来没到过。

    Whether this user holds a completed payment whose window hasn't lapsed. The
    verdict comes from the payments table rather than users.plan, because plan is
    mutable current state — once a downgrade lands, it reads FREE and the fact
    that money changed hands is no longer visible. Payments are immutable facts:
    finished_at plus the plan's day count is the window the money bought.
    """
    rows = (
        db.query(Payment.plan, Payment.finished_at)
        .filter(Payment.user_id == target_id, Payment.status == "FINISHED")
        .all()
    )
    for plan, finished_at in rows:
        if finished_at is None:
            continue
        ends = finished_at if finished_at.tzinfo else finished_at.replace(tzinfo=timezone.utc)
        if ends + timedelta(days=PLAN_DAYS.get(plan, 30)) > now:
            return True
    return False


def _notify_admins_agent_write(db: Session, agent: User, target: User, summary: str) -> list[str]:
    """代理动了别人的会员，给每位管理员留一条站内通知，返回收到的管理员 id。

    为什么必须有：代理页是 /agent/* 下唯一的写端点，改的是**别人的**付费权益，
    而此前它唯一的痕迹是审计表里两行——没有人会定期去翻审计表，于是"某个代理
    把一批客户开成 PRO"这件事在被客户投诉之前完全不可见。铃铛里一条通知是让
    这件事有人看见的最低成本做法（对比：新工单也是这么通知管理员的）。

    不发系统推送，理由与 tickets._notify_admins_new_ticket 一样：管理员就那几个
    人，往每台设备推一条只会把后台日常变成噪音。代理自己是管理员时不通知自己
    （他不会是——_agent_target 已经挡了管理员做目标，但操作者这一侧没挡）。

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
            KIND_AGENT_PLAN_CHANGE,
            text=summary,
            link=f"/admin?tab=users&q={target.email}",
            ref_id=target.id,
        )
    return admin_ids


def agent_set_plan(db: Session, agent: User, link_id: str, body: AgentPlanUpdate) -> AgentLinkUserOut:
    """代理调整自己名下客户的会员等级与到期日。返回改完之后的那一行。

    五条边界：
    ① 只能动自己名下链接带来的人（_owned_link + _agent_target，都是 404）；
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
    link = _owned_link(db, agent, link_id)
    target = _agent_target(db, link, body.email)

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

    _log_change(db, agent.id, target.id, f"agent:{link.code}:plan", old_plan, target.plan)
    _log_change(
        db, agent.id, target.id, f"agent:{link.code}:plan_expires_at", old_expiry, target.plan_expires_at
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
            f"agent:{link.code}{_AGENT_EXTEND_AUDIT_SUFFIX}",
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
    agents = _agents_by_link(db, [l.id for l in links])
    return {
        "links": [
            _link_out(l, counts.get(l.code, 0), agents.get(l.id)).model_dump(mode="json")
            for l in links
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
    return _link_out_full(db, link)


def _admin_link(db: Session, link_id: str) -> InviteLink:
    link = db.query(InviteLink).filter(InviteLink.id == link_id).first()
    if link is None:
        raise HTTPException(status_code=404, detail="链接不存在 / Link not found")
    return link


def _link_out_full(db: Session, link: InviteLink) -> InviteLinkOut:
    registrations = (
        db.query(func.count(User.id)).filter(User.invite_code == link.code).scalar() or 0
    )
    return _link_out(link, registrations, _agents_by_link(db, [link.id]).get(link.id))


@admin_router.post("/{link_id}/agents", response_model=InviteLinkOut)
def assign_invite_agent(
    link_id: str,
    body: InviteLinkAssignAgent,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """把链接指派给一个用户，让他成为这条链接的「代理」（只读视图，权益不变）。
    Assign the link to a user, making them its agent (read-only view, same entitlements)."""
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
    """代理调整自己名下客户的会员：延长 PRO（一次最多 60 天）或降回 FREE。

    **这是 /agent/* 唯一的写端点**（2026-09-19 之前这条路径上一个都没有）。边界与
    审计见 agent_set_plan；限流挂在这里而不是别处：其余代理端点都是只读，只有它
    能改别人的权益，被脚本连点会把一整批人开成 PRO。

    The only write endpoint under /agent/*. Boundaries and audit live in
    agent_set_plan; the rate limit sits here because this is the one call that
    changes someone else's entitlement.
    """
    return agent_set_plan(db, user, link_id, body)


@agent_router.get("/links/{link_id}/users", response_model=AgentLinkUsersOut)
def my_agent_link_users(
    link_id: str,
    limit: int = Query(default=PAGE_SIZE_DEFAULT, ge=1, le=PAGE_SIZE_MAX),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return agent_link_users(db, user, link_id, limit, offset)
