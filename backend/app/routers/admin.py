"""管理后台路由：用户列表/搜索、调整角色与订阅等级、基础指标看板。

所有端点都挂在 require_admin 之后——role 不是 admin 一律 403。每次修改角色
或订阅等级都写一条 AdminAuditLog，记录谁在什么时候把哪个字段从什么改成了
什么，供团队不止一人管理时追责/核对。

Admin router: user list/search, role & plan adjustment, basic metrics.

Every endpoint sits behind require_admin — anything but role == "admin" gets
a 403. Every role/plan change writes an AdminAuditLog row (who changed what
field, from what, to what, when), so once more than one person has admin
access there's a record to check against.
"""
import json
from datetime import date, timedelta

from fastapi import APIRouter, Depends, File, HTTPException, Path, Query, Request, UploadFile
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import get_db
from app.services.image_upload import UploadError, is_configured as is_upload_configured, upload_image
from app.models import AdminAuditLog, MT5Account, PageVisitorDay, PageViewStat, User
from app.services.audit import log_change
from app.schemas import AdminTraderLevelsOut, AdminTraderLevelUsersOut, AdminPotentialCustomersOut, AdminBrokerSettings, AdminBulkUserUpdate, AdminCandleSettings, AdminEmailGateSettings, AdminOverviewOut, AdminPageStatsOut, AdminPricingSettings, AdminStrategyCostEntry, AdminStrategyCosts, AdminStrategySettings, AdminSocialSettings, AdminStrategyWinRateOut, AdminTrialSettings, AdminWinrateSettings, AdminWinrateSettingsIn, AdminWinrateStrategyOut, AdminUserOut, AdminUserUpdate, PageDayPointOut, PageStatOut, PlatformStrategyListOut, PlatformStrategyOut
from app.services.deps import require_admin
from app.services.strategy_winrate import compute_strategy_session_winrate
from app.services.admin_overview import build_overview, potential_customers as build_potential_customers
from app.services.admin_trader_levels import DEFAULT_USER_LIMIT, LEVEL_COUNT, level_rows, level_users
from app.services.pagination import PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, resolve_range_or_422
from app.services.stats_time import day_start_utc, local_day, today as stats_today
from app.services.settings_store import (
    get_broker_settings,
    get_candle_settings,
    get_email_gate_settings,
    get_platform_strategies,
    get_pricing_settings,
    get_social_settings,
    get_strategy_costs,
    get_strategy_settings,
    get_trial_settings,
    get_winrate_settings,
    invalidate_candle_cache,
    invalidate_email_gate_cache,
    invalidate_platform_strategies_cache,
    invalidate_pricing_cache,
    invalidate_settings_cache,
    invalidate_social_cache,
    invalidate_strategy_costs_cache,
    invalidate_strategy_settings_cache,
    invalidate_trial_cache,
    invalidate_winrate_settings_cache,
    save_candle_settings,
    save_email_gate_settings,
    save_platform_strategies,
    save_pricing_settings,
    save_social_settings,
    save_strategy_costs,
    save_strategy_settings,
    save_trial_settings,
    save_winrate_settings,
    set_setting,
)

router = APIRouter(prefix="/admin", tags=["admin"])

# 分页常量与范围解析都搬去了 services/pagination.py（理由见那个模块的开头）。
# 这里保留同名别名，本文件几十处调用点不动——与下面 _log_change 的处理一致。
# Both moved to services/pagination.py (see its docstring); same-named aliases
# keep this file's call sites untouched, exactly like _log_change below.
_resolve_range_or_422 = resolve_range_or_422


def _like_escape(value: str) -> str:
    """把 LIKE 的元字符转义掉，供 `ilike(..., escape="\\\\")` 使用。
    Escape LIKE metacharacters for use with `ilike(..., escape="\\\\")`."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _user_out(u: User, account_count: int) -> AdminUserOut:
    """把 User 行转成管理端的用户载荷。

    一份定义而不是每个端点各写一遍：列表与单用户 PATCH 此前各自构造，PATCH 那份
    漏了 phone。漏字段不会报错——AdminUserOut 里 phone 有默认值 None，缺了就是安静
    地返回 null。前端保存后拿响应整行替换列表行（AdminPage.tsx），于是管理员每改
    一次用户，那一行的手机号就空掉，要刷新页面才回来。这类漏字段只要构造点不止
    一个就会再次发生，所以收敛成一处。

    Serialize a User row into the admin-facing payload.

    One definition rather than one per endpoint: the list and the single-user
    PATCH each built their own, and the PATCH one omitted phone. A missing field
    raises nothing — phone defaults to None on AdminUserOut, so it just returns
    null quietly. The frontend replaces the whole list row with the response
    (AdminPage.tsx), so every admin edit blanked that user's phone until a page
    reload. This recurs as long as there is more than one construction site.
    """
    return AdminUserOut(
        id=u.id,
        email=u.email,
        phone=u.phone,
        role=u.role,
        plan=u.plan,
        planExpiresAt=u.plan_expires_at,
        planNote=u.plan_note,
        createdAt=u.created_at,
        lastActiveAt=u.last_active_at,
        mt5AccountCount=account_count,
    )


@router.get("/users", response_model=dict)
def list_users(
    q: str | None = Query(default=None, max_length=128, description="按邮箱或手机号模糊搜索 / fuzzy search by email or phone"),
    plan: str | None = Query(default=None),
    role: str | None = Query(default=None),
    limit: int = Query(default=PAGE_SIZE_DEFAULT, ge=1, le=PAGE_SIZE_MAX),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """用户列表：支持按邮箱模糊搜索、按 plan/role 过滤，分页返回。
    User list: fuzzy email search, plan/role filters, paginated."""
    query = db.query(User)
    if q:
        # 邮箱与手机号一起搜：客服拿到的往往只有一个手机号，让他还得先换算成
        # 邮箱才能查，等于这个字段存了也用不上。
        # 号码存的是 E.164（+60...），而人工输入常常不带 +、或者带着本地前导 0，
        # 所以对纯数字的查询词额外补一次「按后缀匹配」——用后几位去撞，能同时
        # 命中 "123456789"、"0123456789"、"+60123456789" 这几种写法。
        # Search phone alongside email: support usually has only a number, and
        # forcing them to resolve it to an email first would make the column
        # useless. Numbers are stored E.164 but typed without the +, or with a
        # local trunk zero, so a digits-only query also matches by suffix.
        # LIKE 的通配符要先转义再拼进模式串：搜索词里的 % 会匹配任意串、_ 匹配任意
        # 单字符，管理员搜 "a_b@x.io" 时命中的会是一批毫不相干的人，而这类"结果多
        # 了几个"在人工核对时极难察觉。escape 字符本身也要先转义，否则 `\` 结尾的
        # 查询词会让数据库报语法错。
        # Escape LIKE wildcards before building the pattern: a % or _ typed into
        # the box silently widens the match, and "a few extra rows" is the kind of
        # wrongness nobody notices by eye. The escape character itself goes first,
        # or a trailing backslash becomes a syntax error.
        like = f"%{_like_escape(q)}%"
        conds = [User.email.ilike(like, escape="\\"), User.phone.ilike(like, escape="\\")]
        digits = "".join(ch for ch in q if ch.isdigit()).lstrip("0")
        # 去掉前导 0 之后可能什么都不剩（q="000"）。那时这个后缀条件会退化成
        # `phone LIKE '%'`，把所有填了手机号的用户都捞出来——搜索框里打三个零，
        # 返回的却是半个用户表。纯数字都被吃光就等于没有号码可搜，跳过即可。
        # Stripping leading zeros can leave nothing (q="000"), and the suffix
        # condition would degrade to `phone LIKE '%'` — typing three zeros would
        # return every user who has a phone number. No digits left, no suffix match.
        if digits:
            conds.append(User.phone.ilike(f"%{_like_escape(digits)}", escape="\\"))
        query = query.filter(or_(*conds))
    if plan:
        query = query.filter(User.plan == plan)
    if role:
        query = query.filter(User.role == role)

    total = query.count()
    rows = query.order_by(User.created_at.desc()).offset(offset).limit(limit).all()

    # 批量取这批用户各自绑定的 MT5 账号数，避免逐用户单独查询 / batch-fetch account counts
    user_ids = [u.id for u in rows]
    counts: dict[str, int] = {}
    if user_ids:
        for uid, cnt in (
            db.query(MT5Account.user_id, func.count(MT5Account.id))
            .filter(MT5Account.user_id.in_(user_ids))
            .group_by(MT5Account.user_id)
            .all()
        ):
            counts[uid] = cnt

    users = [_user_out(u, counts.get(u.id, 0)) for u in rows]
    return {"users": [x.model_dump(mode="json") for x in users], "total": total, "limit": limit, "offset": offset}


# 审计写入搬到 services/audit.py（比赛终审等 services 层也要用，不该反向 import
# router）。这里保留同名别名，本文件几十处调用点不动。
# Audit logging lives in services/audit.py now; same-named alias keeps call sites.
_log_change = log_change


def _log_settings_diff(db: Session, admin_id: str, prefix: str, old: dict, new: dict) -> None:
    """平台设置的审计：逐键比较，只给**真的变了**的键各写一条带旧值的行。

    此前这一批端点全是 `_log_change(..., f"setting:{prefix}", None, json.dumps(new))`
    ——old_value 恒为 None。审计行存在的唯一理由是回答"改之前是多少"，记一个
    永远是 null 的旧值等于没记：定价被调过一次之后，再想知道上一档价格只能翻
    数据库备份。合作券商锁那个端点（put_settings）本来就是逐键 diff 的写法，
    这里把其余八处统一成同一套。

    逐键而不是整份：整份 JSON 的 diff 要人眼比对两个几百字符的字符串才能看出
    改了哪一项，而按键拆开之后「谁把年付价从 199 改成 99」是一行就能读懂的事。
    值统一走 json.dumps，避免 True/"true"、1/1.0 这类 str() 差异被误判成变化。

    Per-key audit for the platform-settings endpoints. These all used to log a
    None old_value, which defeats the only purpose an audit row has — answering
    "what was it before". The partner-broker endpoint (put_settings) already
    diffs per key; this brings the other eight in line. Per key rather than
    whole-document because a JSON blob diff has to be eyeballed, and values go
    through json.dumps so True vs "true" isn't mistaken for a change.
    """
    for key, new_value in new.items():
        _log_change(
            db,
            admin_id,
            admin_id,
            f"setting:{prefix}:{key}",
            json.dumps(old.get(key), ensure_ascii=False),
            json.dumps(new_value, ensure_ascii=False),
        )


@router.patch("/users/bulk", response_model=dict)
def bulk_update_users(
    body: AdminBulkUserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """批量调整多个用户的角色/等级/到期时间/备注，逻辑与单个用户的 PATCH 完全一致，
    只是对一批目标各跑一遍；每个用户每个实际变化的字段仍各写一条审计日志——
    批量操作不会因为"批量"而降低可追责性。

    注册路由时必须排在 PATCH /users/{{user_id}} 之前：否则 "bulk" 会被当成
    user_id 匹配到那条参数化路由上。

    Bulk-adjust role/plan/expiry/note for multiple users at once — same logic
    as the single-user PATCH, just run per target; every field that actually
    changes on every user still gets its own audit row. A bulk operation
    doesn't get less traceable just for being bulk.

    Must be registered before PATCH /users/{{user_id}} — otherwise "bulk"
    would be captured as a user_id by that parameterized route.
    """
    fields = body.model_dump(exclude_unset=True, exclude={"userIds"})
    if not fields:
        raise HTTPException(status_code=400, detail="没有要修改的字段 / No fields to update")

    targets = db.query(User).filter(User.id.in_(body.userIds)).all()
    for target in targets:
        if "role" in fields and fields["role"] is not None:
            _log_change(db, admin.id, target.id, "role", target.role, fields["role"])
            target.role = fields["role"]
        if "plan" in fields and fields["plan"] is not None:
            _log_change(db, admin.id, target.id, "plan", target.plan, fields["plan"])
            target.plan = fields["plan"]
            # 管理员手动改等级视为权威操作，覆盖任何试用状态。
            # An admin's manual plan change is authoritative and overrides any trial state.
            target.plan_is_trial = False
        if "planExpiresAt" in fields:
            _log_change(db, admin.id, target.id, "plan_expires_at", target.plan_expires_at, fields["planExpiresAt"])
            target.plan_expires_at = fields["planExpiresAt"]
        if "planNote" in fields:
            _log_change(db, admin.id, target.id, "plan_note", target.plan_note, fields["planNote"])
            target.plan_note = fields["planNote"]
    db.commit()
    return {"updated": len(targets)}


@router.patch("/users/{user_id}", response_model=AdminUserOut)
def update_user(
    user_id: str,
    body: AdminUserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """调整某用户的角色 / 订阅等级 / 到期时间 / 备注，每个实际变化的字段各写一条审计日志。
    Adjust a user's role / plan / expiry / note; each field that actually
    changes gets its own audit log row."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在 / User not found")

    fields = body.model_dump(exclude_unset=True)

    if "role" in fields and fields["role"] is not None:
        _log_change(db, admin.id, target.id, "role", target.role, fields["role"])
        target.role = fields["role"]
    if "plan" in fields and fields["plan"] is not None:
        _log_change(db, admin.id, target.id, "plan", target.plan, fields["plan"])
        target.plan = fields["plan"]
        # 管理员手动改等级视为权威操作，覆盖任何试用状态。
        # An admin's manual plan change is authoritative and overrides any trial state.
        target.plan_is_trial = False
    if "planExpiresAt" in fields:
        _log_change(db, admin.id, target.id, "plan_expires_at", target.plan_expires_at, fields["planExpiresAt"])
        target.plan_expires_at = fields["planExpiresAt"]
    if "planNote" in fields:
        _log_change(db, admin.id, target.id, "plan_note", target.plan_note, fields["planNote"])
        target.plan_note = fields["planNote"]

    db.commit()
    db.refresh(target)

    account_count = db.query(func.count(MT5Account.id)).filter(MT5Account.user_id == target.id).scalar() or 0
    return _user_out(target, account_count)


# ---------- 平台设置：合作券商锁 / platform settings: partner-broker lock ----------

def _broker_settings_out(data: dict) -> AdminBrokerSettings:
    return AdminBrokerSettings(
        brokerLockEnabled=bool(data.get("broker_lock_enabled")),
        brokerPatterns=list(data.get("broker_patterns") or []),
        brokerDisplayName=data.get("broker_display_name") or "",
        brokerReferralUrl=data.get("broker_referral_url") or "",
    )


@router.get("/settings", response_model=AdminBrokerSettings)
def get_settings(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取合作券商锁设置 / read the partner-broker lock settings."""
    return _broker_settings_out(get_broker_settings(db))


@router.put("/settings", response_model=AdminBrokerSettings)
def put_settings(
    body: AdminBrokerSettings,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存合作券商锁设置：整份覆盖，每个实际变化的键各写一条审计日志。

    审计日志的 target_user_id 记为管理员自己（该表的目标列非空且指向用户，
    平台设置没有目标用户，用操作者自身占位；field 前缀 "setting:" 区分）。

    Save the partner-broker lock settings: full overwrite, one audit row per
    key that actually changed. The audit row's target_user_id is set to the
    admin themself (the column is non-null and points at a user; platform
    settings have no target user, so the actor stands in; the "setting:"
    field prefix disambiguates).
    """
    patterns = [p.strip() for p in body.brokerPatterns if p.strip()]
    if body.brokerLockEnabled and not patterns:
        raise HTTPException(
            status_code=400,
            detail="启用券商限制时至少需要一个匹配关键字 / At least one keyword is required while the broker lock is enabled",
        )

    current = get_broker_settings(db)
    updates = {
        "broker_lock_enabled": body.brokerLockEnabled,
        "broker_patterns": patterns,
        "broker_display_name": body.brokerDisplayName.strip(),
        "broker_referral_url": body.brokerReferralUrl.strip(),
    }
    for key, new_value in updates.items():
        old_value = current.get(key)
        if old_value != new_value:
            _log_change(
                db,
                admin.id,
                admin.id,
                f"setting:{key}",
                json.dumps(old_value, ensure_ascii=False),
                json.dumps(new_value, ensure_ascii=False),
            )
            set_setting(db, key, new_value)
    db.commit()
    invalidate_settings_cache()
    return _broker_settings_out(get_broker_settings(db))


@router.get("/overview", response_model=AdminOverviewOut)
def overview(
    range_: str | None = Query(None, alias="range"),
    from_: date | None = Query(None, alias="from"),
    to: date | None = Query(None),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """管理页看板：头部指标、活跃趋势、漏斗、留存、等级、策略与交易使用，一次返回。

    口径全部在 services/admin_overview.py；这里只解析范围。预设 `range=` 与自定义
    `from=&to=` 同时给时自定义优先；都不给默认本月。
    Admin dashboard in one call; all semantics live in services/admin_overview.
    """
    spec = _resolve_range_or_422(range_, from_, to)
    return build_overview(db, spec, stats_today())


@router.get("/potential-customers", response_model=AdminPotentialCustomersOut)
def potential_customers(
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """潜在转化客户名单：还没绑 MT5、但最近一周常来的人，给后台主动联系用。

    **不跟看板的时间范围走**，永远是"截至今天的最近一周"——这份名单的用途是
    "现在该联系谁"，按历史区间筛出一批早就冷掉的人没有意义。口径与漏斗那一行
    同源（services/admin_overview._potential_ids），两处数字不会漂。

    Warm-lead list for outreach. Deliberately ignores the dashboard range: it
    always means "the last week up to today", because the question is who to
    contact now. Shares its definition with the funnel row.
    """
    return build_potential_customers(db, stats_today(), limit=limit)


@router.get("/trader-levels", response_model=AdminTraderLevelsOut)
def trader_levels(
    range_: str | None = Query(None, alias="range"),
    from_: date | None = Query(None, alias="from"),
    to: date | None = Query(None),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """六级闯关的当前分布：每一级现有多少人 + 本期有多少人升到这一级。

    「现有」不跟时间范围走，「本期达成」跟。口径与名单接口同源
    （services/admin_trader_levels），所以卡片数字与展开的名单不会漂。
    Current distribution across the six trader levels: the stock per level plus
    the flow into it during the selected range.
    """
    spec = _resolve_range_or_422(range_, from_, to)
    return level_rows(db, spec)


@router.get("/trader-levels/{level}/users", response_model=AdminTraderLevelUsersOut)
def trader_level_users(
    level: int = Path(ge=1, le=LEVEL_COUNT),
    scope: str = Query("all", pattern="^(all|range)$"),
    limit: int = Query(DEFAULT_USER_LIMIT, ge=1, le=500),
    range_: str | None = Query(None, alias="range"),
    from_: date | None = Query(None, alias="from"),
    to: date | None = Query(None),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """某一级的用户名单，带达成时刻（精确到秒）。

    `scope=all` 是当前在这一级的人（时间范围不参与筛选）；`scope=range` 是本期升到
    这一级的人，含之后又升上去的，所以每行都带 currentLevel。
    Who is at this level (scope=all) or who reached it during the range
    (scope=range, including users who have since moved up).
    """
    spec = _resolve_range_or_422(range_, from_, to)
    return level_users(db, level, spec, scope=scope, limit=limit)


@router.get("/page-stats", response_model=AdminPageStatsOut)
def page_stats(
    range_: str | None = Query(None, alias="range"),
    from_: date | None = Query(None, alias="from"),
    to: date | None = Query(None),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """页面访问统计：每页每天的访问人数、访问次数、平均停留时长。

    平均值一律用 SUM(total_seconds) / SUM(views) 现算，不能先按桶求平均再平均——
    小时桶的访问量差别很大（凌晨可能只有 1 次、白天几百次），等权平均会让一个
    冷清时段的极端值和一个繁忙时段权重相同，算出来的"平均停留"是错的。同理，
    汇总行的平均值也不是各天平均值的平均，而是重新按总量加权。

    人数与次数来自两张不同的表，**不能互相推导**：次数在 PageViewStat（无身份），
    人数靠 PageVisitorDay 的去重标记 COUNT(DISTINCT)。因此汇总的"总人数"是
    整个窗口内的去重人数，不等于各天人数相加（同一个人连来 7 天，按天算是 7、
    去重后是 1），这是两个不同的问题，别为了让数字"对得上"而改成累加。

    Page stats: visitors, views and average dwell per page per day.

    Averages are always SUM(total_seconds) / SUM(views), never the mean of
    per-bucket means: hourly buckets differ wildly in volume (one view at 4am
    versus hundreds at midday), so equal-weighting buckets would give an
    outlier-heavy quiet hour the same weight as a busy one and yield a wrong
    "average dwell". Likewise summary averages re-weight by totals rather than
    averaging the daily averages.

    Visitors and views come from two different tables and CANNOT be derived from
    one another: views live in PageViewStat (identity-free), visitors come from
    COUNT(DISTINCT) over PageVisitorDay markers. So the summary "total visitors"
    is the distinct count across the whole window, which is NOT the sum of the
    daily figures (one person visiting 7 days running is 7 by day, 1 distinct) —
    two different questions; don't "fix" the mismatch by summing.
    """
    spec = _resolve_range_or_422(range_, from_, to)
    start_day, end_day = spec.start, spec.end
    # 桶是 UTC 整点，范围是 STATS_TZ 日；边界换成 naive UTC 再过滤，归日在 Python 侧做
    # Buckets are UTC hours, the range is STATS_TZ days: convert the bounds and
    # re-bucket per day in Python.
    cutoff = day_start_utc(start_day)
    cutoff_end = day_start_utc(end_day + timedelta(days=1))

    # 排除后台自己：/admin 已从上报白名单移除，但库里还有之前累积的行，
    # 查询侧也要滤掉，否则历史数据会一直挂在排行里。
    # Exclude the admin page itself: /admin is off the reporting whitelist, but
    # previously accumulated rows remain in the DB, so filter here too or the
    # historical data would sit in the ranking forever.
    view_rows = (
        db.query(PageViewStat.path, PageViewStat.time_bucket, PageViewStat.views, PageViewStat.total_seconds)
        .filter(PageViewStat.time_bucket >= cutoff, PageViewStat.time_bucket < cutoff_end, PageViewStat.path != "/admin")
        .all()
    )
    # 三个人数查询共用同一组过滤条件。抽出来是因为漏掉任何一个的 path != "/admin"
    # 都不会报错，只会让某个数字悄悄把后台自己算进去。
    # The three visitor queries share one filter. Extracted because omitting the
    # path != "/admin" clause anywhere fails silently, just quietly folding the
    # admin page into one of the numbers.
    visitor_window = (PageVisitorDay.day >= start_day, PageVisitorDay.day <= end_day, PageVisitorDay.path != "/admin")
    visitor_rows = (
        db.query(
            PageVisitorDay.path,
            PageVisitorDay.day,
            func.count(func.distinct(PageVisitorDay.user_id)),
        )
        .filter(*visitor_window)
        .group_by(PageVisitorDay.path, PageVisitorDay.day)
        .all()
    )
    # 每页的窗口去重人数：一次分组查完，不要在页面循环里逐页查（12 个路由就是
    # 12 次查询）。这个值不能由上面的按天人数相加得出——同一个人连来 7 天，
    # 按天是 7 人次、去重后是 1 个人。
    # Per-page distinct visitors for the window: one grouped query, not one per
    # page inside the loop. It cannot be summed from the daily figures above —
    # one person visiting 7 days is 7 daily entries but 1 distinct visitor.
    page_visitors = {
        path: int(count or 0)
        for path, count in db.query(
            PageVisitorDay.path,
            func.count(func.distinct(PageVisitorDay.user_id)),
        )
        .filter(*visitor_window)
        .group_by(PageVisitorDay.path)
        .all()
    }
    total_visitors = int(
        db.query(func.count(func.distinct(PageVisitorDay.user_id)))
        .filter(*visitor_window)
        .scalar()
        or 0
    )

    # 按 (path, day) 归拢两张表的结果。_day_key 只是把 PageVisitorDay.day 统一成
    # ISO 字符串——SQLite 下这一列可能回字符串，其他驱动可能回 date 对象。
    # view_rows 那边走的是 local_day(bucket)，本来就是 date，不需要它。
    # Merge both tables keyed by (path, day). _day_key only normalises
    # PageVisitorDay.day (SQLite may return a str, other drivers a date); the
    # view_rows side already goes through local_day(bucket) and needs no help.
    def _day_key(value) -> str:
        return value.isoformat() if hasattr(value, "isoformat") else str(value)[:10]

    per_page: dict[str, dict[str, dict]] = {}
    for path, bucket, views, seconds in view_rows:
        cell = per_page.setdefault(path, {}).setdefault(
            local_day(bucket).isoformat(), {"views": 0, "seconds": 0.0, "visitors": 0}
        )
        cell["views"] += int(views or 0)
        cell["seconds"] += float(seconds or 0.0)
    for path, day, visitors in visitor_rows:
        cell = per_page.setdefault(path, {}).setdefault(
            _day_key(day), {"views": 0, "seconds": 0.0, "visitors": 0}
        )
        cell["visitors"] += int(visitors or 0)

    # 补齐窗口内没有数据的日期为 0：折线图必须拿到连续日期序列，否则前端会把
    # "这天没人来"画成直接跨过去，看起来像访问量没掉过。
    # Backfill empty days with zeros: the line chart needs a contiguous date
    # series, otherwise a day with no traffic gets skipped and reads as "traffic
    # never dropped".
    day_keys = spec.day_keys()

    pages: list[PageStatOut] = []
    for path, by_day in per_page.items():
        page_views = sum(c["views"] for c in by_day.values())
        page_seconds = sum(c["seconds"] for c in by_day.values())
        if page_views <= 0 and not any(c["visitors"] for c in by_day.values()):
            continue
        series = [
            PageDayPointOut(
                date=key,
                views=by_day.get(key, {}).get("views", 0),
                visitors=by_day.get(key, {}).get("visitors", 0),
                avgSeconds=(
                    round(by_day[key]["seconds"] / by_day[key]["views"], 1)
                    if by_day.get(key, {}).get("views")
                    else 0.0
                ),
            )
            for key in day_keys
        ]
        pages.append(PageStatOut(
            path=path,
            views=page_views,
            visitors=page_visitors.get(path, 0),
            avgSeconds=round(page_seconds / page_views, 1) if page_views else 0.0,
            daily=series,
        ))

    pages.sort(key=lambda p: p.views, reverse=True)
    total_views = sum(p.views for p in pages)
    total_seconds = sum(c["seconds"] for by_day in per_page.values() for c in by_day.values())
    return AdminPageStatsOut(
        start=start_day.isoformat(),
        end=end_day.isoformat(),
        days=spec.days,
        totalViews=total_views,
        totalVisitors=total_visitors,
        avgSecondsOverall=round(total_seconds / total_views, 1) if total_views else 0.0,
        dates=day_keys,
        pages=pages,
    )


# ---------- 策略分时段胜率 / per-strategy, per-session win rate ----------

@router.get("/strategy-winrate", response_model=AdminStrategyWinRateOut)
def strategy_winrate(
    days: int = Query(7, ge=1, le=90),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """每个策略在亚洲盘/欧洲盘/纽约盘的近 `days` 天胜率。

    默认 7 天。上限 90 天不是随手定的：时段归属要按 IANA 时区逐条换算本地小时，
    窗口越长扫的行越多，而这个端点只有管理员会点，没必要为更长的窗口加缓存或
    预聚合表。

    定义成同步 def（与本文件其余端点一致）而不是 async：分桶是纯 CPU 的逐行循环
    （每条信号 × 3 个时区换算），FastAPI 会把同步端点丢进线程池，事件循环仍能
    继续服务行情推送的 WebSocket。

    Per-strategy win rate for the Asian / European / New York sessions over the
    last `days` days, defaulting to 7. The 90-day ceiling is deliberate: session
    assignment converts each row's timestamp into three local hours, so a longer
    window means more rows scanned — and only admins hit this endpoint, so
    caching or a pre-aggregated table isn't worth it.

    Declared sync (like every other endpoint here) rather than async: the
    bucketing is a pure-CPU per-row loop, and FastAPI runs sync endpoints in a
    thread pool, leaving the event loop free for the live-quote WebSockets.
    """
    return compute_strategy_session_winrate(db, days)


# ---------- 胜率对外公开设置 / win-rate publication settings ----------

# 设置页的统计窗口。与用户端「策略分析」页固定的 30 天保持一致——管理员按这里的
# 数字决定公不公开，用户看到的必须是同一个窗口算出来的，否则勾选依据和展示结果
# 对不上。
# The settings page's window, matching the 30 days the user-facing analysis page
# is pinned to: an admin decides based on these numbers, so users must be seeing
# the same window or the basis for ticking a box and the published result diverge.
WINRATE_PUBLIC_DAYS = 30


@router.get("/winrate-settings", response_model=AdminWinrateSettings)
def get_winrate_publication_settings(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """列出全部策略、各自近 30 天胜率、以及是否已对用户公开。

    **这里不过滤白名单**：管理员要看着全部策略的胜率才能决定公开谁，只显示已公开
    的等于让人闭着眼睛勾。白名单里存在、但窗口内没有信号的策略也补进列表（胜率
    null），否则管理员会以为自己没勾过。

    Lists every strategy with its 30-day win rate and whether it is published.
    **No whitelist filtering here**: an admin decides by comparing all strategies,
    and showing only the published ones would mean ticking boxes blind. Names in
    the whitelist with no signals in the window are appended (null win rate) or
    the admin would think the box was never ticked.
    """
    public = set(get_winrate_settings(db)["public_strategies"])
    data = compute_strategy_session_winrate(db, WINRATE_PUBLIC_DAYS)
    rows = [
        AdminWinrateStrategyOut(
            strategy=row["strategy"],
            resolved=row["total"]["resolved"],
            winRate=row["total"]["winRate"],
            public=row["strategy"] in public,
        )
        for row in data["strategies"]
    ]
    seen = {r.strategy for r in rows}
    rows.extend(
        AdminWinrateStrategyOut(strategy=name, resolved=0, winRate=None, public=True)
        for name in sorted(public - seen)
    )
    return AdminWinrateSettings(days=WINRATE_PUBLIC_DAYS, strategies=rows)


@router.put("/winrate-settings", response_model=AdminWinrateSettings)
def put_winrate_publication_settings(
    body: AdminWinrateSettingsIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存公开名单。名单直接决定用户端「策略分析」与仪表盘卡片统计哪些信号。
    Save the whitelist; it decides which signals the user-facing analysis page and
    the dashboard card are computed from."""
    # 去重并保持稳定顺序；空串（信号没带策略名的那一桶）不允许进名单——它在界面上
    # 显示成「未命名策略」，公开一个没有名字的策略对用户没有意义。
    # De-duplicate with a stable order. The empty string (the bucket for signals
    # that carried no strategy name) is never publishable: it renders as "unnamed
    # strategy", and publishing a nameless one means nothing to a user.
    names = sorted({n.strip() for n in body.publicStrategies if n.strip()})
    old = get_winrate_settings(db)
    data = {"public_strategies": names}
    save_winrate_settings(db, data)
    _log_settings_diff(db, admin.id, "winrate", old, data)
    db.commit()
    invalidate_winrate_settings_cache()
    return get_winrate_publication_settings(db, admin)


# ---------- 订阅定价设置 / subscription pricing settings ----------

@router.get("/pricing", response_model=AdminPricingSettings)
def get_pricing(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取订阅定价。Read subscription pricing."""
    p = get_pricing_settings(db)
    return AdminPricingSettings(
        proMonthlyPrice=float(p["pro_monthly_price"]),
        proYearlyPrice=float(p["pro_yearly_price"]),
        saleEnabled=bool(p["sale_enabled"]),
        salePercent=int(p["sale_percent"]),
        saleBadge=str(p.get("sale_badge", "")),
        saleEndAt=str(p.get("sale_end_at") or ""),
    )


@router.put("/pricing", response_model=AdminPricingSettings)
def put_pricing(
    body: AdminPricingSettings,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存订阅定价。Save subscription pricing.

    刻意不校验「年付是否便宜于月付×12」：定价是运营决策，年付贵于月付虽然反直觉，
    但可能是有意为之（比如只想推月付），后端不该替运营拍板。此处原先留着一个
    `if ...: pass` 的空判断表达这个意思，但空分支读起来像「这里少写了点什么」，
    不如直接写成一句话。
    Deliberately no "yearly must be cheaper than monthly x12" check: pricing is an
    operational decision, and a yearly price above 12x monthly — counter-intuitive
    as it looks — may well be intentional (e.g. steering everyone to monthly). The
    backend shouldn't overrule that. This used to be expressed as an empty
    `if ...: pass`, but an empty branch reads like something is missing; a sentence
    says it better.
    """
    # 价格必须为正、折扣不能到 100%：schema 只卡了 ge=0 / le=100，而 0 元套餐和
    # 100% 折扣都会算出 0 元订单 —— NOWPayments 直接拒收，用户侧看到的是一句
    # "支付订单创建失败"（502），没人会想到是后台把价格设成了 0。价格本身是运营
    # 决策（年付贵过月付也随他），但"0 元 PRO"不是定价，是个开不了的口子。
    # 约束写在路由里而不是 schema：那份 schema 归另一处维护，见审计报告 F-12。
    # Prices must be positive and a sale cannot reach 100%: the schema only bounds
    # ge=0 / le=100, but either extreme produces a zero-value order that
    # NOWPayments refuses, surfacing to the user as "could not create the payment"
    # with nothing pointing at the admin who typed a 0. Pricing itself stays an
    # operational call; a free PRO plan isn't pricing, it's an open door.
    if body.proMonthlyPrice <= 0 or body.proYearlyPrice <= 0:
        raise HTTPException(
            status_code=400,
            detail="套餐价格必须大于 0 / plan prices must be greater than zero",
        )
    if body.saleEnabled and body.salePercent >= 100:
        raise HTTPException(
            status_code=400,
            detail="折扣必须小于 100% / the sale percentage must be below 100",
        )
    old = get_pricing_settings(db)
    data = {
        "pro_monthly_price": body.proMonthlyPrice,
        "pro_yearly_price": body.proYearlyPrice,
        "sale_enabled": body.saleEnabled,
        "sale_percent": body.salePercent,
        "sale_badge": body.saleBadge.strip(),
        "sale_end_at": body.saleEndAt.strip() or None,
    }
    save_pricing_settings(db, data)
    _log_settings_diff(db, admin.id, "pricing", old, data)
    db.commit()
    invalidate_pricing_cache()
    return get_pricing(db, admin)


# ---------- 免费试用设置 / free-trial settings ----------

@router.get("/trial", response_model=AdminTrialSettings)
def get_trial(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取免费试用设置。Read free-trial settings."""
    t = get_trial_settings(db)
    return AdminTrialSettings(
        trialEnabled=bool(t["trial_enabled"]),
        trialDays=int(t["trial_days"]),
    )


@router.put("/trial", response_model=AdminTrialSettings)
def put_trial(
    body: AdminTrialSettings,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存免费试用设置。Save free-trial settings."""
    old = get_trial_settings(db)
    data = {
        "trial_enabled": body.trialEnabled,
        "trial_days": body.trialDays,
    }
    save_trial_settings(db, data)
    _log_settings_diff(db, admin.id, "trial", old, data)
    db.commit()
    invalidate_trial_cache()
    return get_trial(db, admin)


# ---------- 一次性邮箱闸门 / disposable-email gate ----------

@router.get("/email-gate", response_model=AdminEmailGateSettings)
def get_email_gate(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取一次性邮箱闸门设置。Read the disposable-email gate settings."""
    g = get_email_gate_settings(db)
    return AdminEmailGateSettings(
        disposableBlockEnabled=bool(g["disposable_block_enabled"]),
        extraBlockedDomains=list(g["extra_blocked_domains"]),
        extraAllowedDomains=list(g["extra_allowed_domains"]),
    )


@router.put("/email-gate", response_model=AdminEmailGateSettings)
def put_email_gate(
    body: AdminEmailGateSettings,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存一次性邮箱闸门设置。Save the disposable-email gate settings."""
    old = get_email_gate_settings(db)
    data = {
        "disposable_block_enabled": body.disposableBlockEnabled,
        "extra_blocked_domains": body.extraBlockedDomains,
        "extra_allowed_domains": body.extraAllowedDomains,
    }
    save_email_gate_settings(db, data)
    _log_settings_diff(db, admin.id, "email_gate", old, data)
    db.commit()
    invalidate_email_gate_cache()
    return get_email_gate(db, admin)


# ---------- 官方社交主页 / official social links ----------

@router.get("/social", response_model=AdminSocialSettings)
def get_social(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取官方社交主页地址。Read the official social links."""
    s = get_social_settings(db)
    return AdminSocialSettings(
        facebookUrl=s["facebook_url"],
        instagramUrl=s["instagram_url"],
        xUrl=s["x_url"],
        discordUrl=s["discord_url"],
        telegramUrl=s["telegram_url"],
    )


@router.put("/social", response_model=AdminSocialSettings)
def put_social(
    body: AdminSocialSettings,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存官方社交主页地址。Save the official social links."""
    old = get_social_settings(db)
    data = {
        "facebook_url": body.facebookUrl,
        "instagram_url": body.instagramUrl,
        "x_url": body.xUrl,
        "discord_url": body.discordUrl,
        "telegram_url": body.telegramUrl,
    }
    save_social_settings(db, data)
    _log_settings_diff(db, admin.id, "social", old, data)
    db.commit()
    invalidate_social_cache()
    return get_social(db, admin)


# ---------- K 线历史保留策略设置 / candle-history retention settings ----------

@router.get("/candle-history", response_model=AdminCandleSettings)
def get_candle_history(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取 K 线历史保留天数。Read the candle-history retention window."""
    c = get_candle_settings(db)
    return AdminCandleSettings(m1RetentionDays=int(c["m1_retention_days"]))


@router.put("/candle-history", response_model=AdminCandleSettings)
def put_candle_history(
    body: AdminCandleSettings,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存 K 线历史保留天数（只影响 1 分钟线；其余周期永久保留）。
    Save the candle-history retention window (only affects 1-minute candles;
    other intervals are kept permanently)."""
    old = get_candle_settings(db)
    data = {"m1_retention_days": body.m1RetentionDays}
    save_candle_settings(db, data)
    _log_settings_diff(db, admin.id, "candle_history", old, data)
    db.commit()
    invalidate_candle_cache()
    return get_candle_history(db, admin)


# ---------- 自定义策略平台设置 / custom-strategy platform settings ----------

@router.get("/strategy-settings", response_model=AdminStrategySettings)
def get_strategy_platform_settings(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取自定义策略平台设置。Read the custom-strategy platform settings."""
    c = get_strategy_settings(db)
    return AdminStrategySettings(
        maxStrategiesPerUser=int(c["max_strategies_per_user"]),
        proOnly=bool(c["pro_only"]),
    )


@router.put("/strategy-settings", response_model=AdminStrategySettings)
def put_strategy_platform_settings(
    body: AdminStrategySettings,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存自定义策略平台设置（每用户策略数上限、是否 PRO 专属）。
    Save the custom-strategy platform settings (max strategies per user,
    whether the feature is PRO-exclusive)."""
    old = get_strategy_settings(db)
    data = {"max_strategies_per_user": body.maxStrategiesPerUser, "pro_only": body.proOnly}
    save_strategy_settings(db, data)
    _log_settings_diff(db, admin.id, "strategy", old, data)
    db.commit()
    invalidate_strategy_settings_cache()
    return get_strategy_platform_settings(db, admin)


# ---------- 策略交易成本设置 / strategy trading-cost settings ----------

@router.get("/strategy-costs", response_model=AdminStrategyCosts)
def get_strategy_cost_settings(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取策略回测/实盘的交易成本配置。
    Read the trading-cost config used by strategy backtests and live eval."""
    c = get_strategy_costs(db)
    per_symbol = [
        AdminStrategyCostEntry(
            symbol=sym,
            spread=float(v.get("spread", c["default_spread"])),
            commissionPerLot=float(v.get("commissionPerLot", c["default_commission_per_lot"])),
            slippage=float(v.get("slippage", c["default_slippage"])),
        )
        for sym, v in sorted((c.get("per_symbol") or {}).items())
    ]
    return AdminStrategyCosts(
        defaultSpread=float(c["default_spread"]),
        defaultCommissionPerLot=float(c["default_commission_per_lot"]),
        defaultSlippage=float(c["default_slippage"]),
        perSymbol=per_symbol,
    )


@router.put("/strategy-costs", response_model=AdminStrategyCosts)
def put_strategy_cost_settings(
    body: AdminStrategyCosts,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存交易成本配置：写审计日志、提交后失效缓存，与 candle-history 同构。
    Save the trading-cost config: audit-logged, cache invalidated after commit;
    same shape as the candle-history endpoint."""
    old = get_strategy_costs(db)
    data = {
        "default_spread": body.defaultSpread,
        "default_commission_per_lot": body.defaultCommissionPerLot,
        "default_slippage": body.defaultSlippage,
        "per_symbol": {
            e.symbol.upper(): {
                "spread": e.spread,
                "commissionPerLot": e.commissionPerLot,
                "slippage": e.slippage,
            }
            for e in body.perSymbol
        },
    }
    save_strategy_costs(db, data)
    _log_settings_diff(db, admin.id, "strategy_costs", old, data)
    db.commit()
    invalidate_strategy_costs_cache()
    return get_strategy_cost_settings(db, admin)


# ---------- 图片上传 / image upload ----------

@router.post("/upload-image", response_model=dict)
async def upload_admin_image(
    request: Request,
    file: UploadFile = File(...),
    _admin: User = Depends(require_admin),
):
    """上传一张策略配图，返回公开 URL。仅管理员。

    两道大小判断，缺一不可：
    ① **先看声明的大小**（starlette 从 multipart 分片算出的 `file.size`，回落到
       请求头 Content-Length）。这一道纯粹是为了别把几百 MB 先 spool 到临时文件
       再整段读进内存——传错文件的人不该顺手把服务端的内存吃掉。
    ② **再看真正读到的字节数**（upload_image 内部那道）。声明值由客户端提供，
       可以随便写，所以它只配当快速拒绝的依据，永远不是最终裁决。

    删掉①会回到"先读完再说"，删掉②会让一个谎报 Content-Length 的请求直接绕过
    上限——两道各防一件事，别合并成一道。

    Upload one strategy illustration and return its public URL. Admin only.

    Two size checks, both load-bearing. The declared size (starlette's
    multipart-derived `file.size`, falling back to Content-Length) is checked
    first, purely to avoid spooling hundreds of megabytes to a temp file and
    reading them into memory before finding out. It is client-supplied, so it can
    only ever justify a fast rejection — the authoritative check stays on the
    bytes actually read (inside upload_image). Neither replaces the other.
    """
    if not is_upload_configured():
        raise HTTPException(
            status_code=503,
            detail="后台未配置图片存储，请改用外链图片地址 / Image storage isn't configured; use an external image URL instead",
        )
    declared = file.size
    if declared is None:
        try:
            declared = int(request.headers.get("content-length") or 0) or None
        except ValueError:
            declared = None
    if declared is not None and declared > settings.UPLOAD_MAX_BYTES:
        mb = settings.UPLOAD_MAX_BYTES / (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail=f"图片超过 {mb:.0f}MB 上限 / the image exceeds the {mb:.0f}MB limit",
        )
    data = await file.read()
    try:
        # upload_image 内部是**同步** httpx.post 直连 Supabase Storage，而那个
        # timeout=30.0 是 httpx 简写，展开后 connect/read/write/pool 各 30 秒
        # ——不是整个请求 30 秒封顶。慢链路上光是把 4MB 请求体分块 write 出去就
        # 可能自己跑满 30 秒，再叠加等响应的 30 秒。留在事件循环上意味着：管理员
        # 传一张图，全站所有人的 WebSocket 推送、桥接轮询、gateway 持仓拍全都
        # 停在那里等它——这是本项目单次影响最大的一处阻塞。
        #
        # 只把这一次网络调用挪进线程池，upload_image 自身一个字不改（它的校验、
        # 嗅探、错误文案都保持原样）。UploadError 会原样穿过线程边界，仍由下面的
        # except 捕获成 400，对外行为逐字节不变。
        #
        # upload_image does a **synchronous** httpx.post to Supabase Storage, and
        # its timeout=30.0 shorthand means 30s each for connect/read/write/pool —
        # not 30s overall. On a slow link, streaming a 4MB body can burn 30s by
        # itself before the response wait even starts. Leaving that on the event
        # loop stalls every WebSocket push, bridge poll and gateway position tick
        # site-wide while one admin uploads one picture — the single largest
        # blocking stall in this codebase. Only the call moves; upload_image is
        # untouched, and UploadError still propagates across the thread boundary
        # into the except below, so the response is byte-identical.
        url = await run_in_threadpool(upload_image, data)
    except UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"url": url}


# ---------- 平台策略介绍 / platform strategy write-ups ----------
# 内容型 CRUD，整表覆盖保存。与用户端 GET /signals/platform-strategies 的区别：
# 这里连未发布（published=false）的草稿一起返回，用户端只给已发布的。
# Content CRUD, saved as a whole list. Unlike the user-facing
# GET /signals/platform-strategies, this returns unpublished drafts too.

@router.get("/platform-strategies", response_model=PlatformStrategyListOut)
def get_admin_platform_strategies(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取全部策略介绍（含未发布草稿），按 order 升序。
    Read every write-up including unpublished drafts, ordered by `order`."""
    items = [PlatformStrategyOut(**it) for it in get_platform_strategies(db)["items"]]
    items.sort(key=lambda s: (s.order, s.nameEn or s.nameZh))
    return PlatformStrategyListOut(items=items)


@router.put("/platform-strategies", response_model=PlatformStrategyListOut)
def put_admin_platform_strategies(
    body: PlatformStrategyListOut,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """整表覆盖保存策略介绍。id 必须唯一——它是前端 key 与后续引用的锚点，
    重复会让编辑器改错条目，所以在这里挡下而不是静默去重。
    Whole-list replace. Ids must be unique: they anchor the client's keys and
    any later references, and duplicates would make the editor mutate the wrong
    entry — so this rejects rather than silently de-duplicating."""
    ids = [it.id for it in body.items]
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=400, detail="策略 id 重复 / duplicate strategy id")
    items = [it.model_dump() for it in body.items]
    # 这一处只记 id 清单而不是整份内容：介绍文本一条可能上千字，把新旧两份整体
    # 写进审计表既撑爆表也没人读得动。能回答"哪条被删了/加了/换了顺序"就够，
    # 具体文案的历史不归审计表管。
    # Only the id list is audited here, not the write-ups themselves: one entry
    # can run to thousands of characters, and storing both copies would bloat the
    # table without being readable. "Which entries came, went or moved" is what
    # this row needs to answer; prose history isn't the audit table's job.
    old_ids = [it.get("id") for it in get_platform_strategies(db)["items"]]
    save_platform_strategies(db, items)
    _log_settings_diff(
        db, admin.id, "platform_strategies", {"ids": old_ids}, {"ids": ids}
    )
    db.commit()
    invalidate_platform_strategies_cache()
    return get_admin_platform_strategies(db, admin)



