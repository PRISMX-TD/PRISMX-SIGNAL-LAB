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
from datetime import datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.services.image_upload import UploadError, is_configured as is_upload_configured, upload_image
from app.models import AdminAuditLog, MT5Account, PageVisitorDay, PageViewStat, Signal, User
from app.schemas import AdminBrokerSettings, AdminBulkUserUpdate, AdminCandleSettings, AdminDisciplineSettings, AdminMetricsOut, AdminPageStatsOut, AdminPricingSettings, AdminStrategyCostEntry, AdminStrategyCosts, AdminStrategySettings, AdminStrategySignalListOut, AdminStrategyWinRateOut, AdminTrialSettings, AdminUserOut, AdminUserUpdate, PageDayPointOut, PageStatOut, PlatformStrategyListOut, PlatformStrategyOut
from app.services.deps import require_admin
from app.services.strategy_winrate import compute_strategy_session_winrate, session_keys_for
from app.services.settings_store import (
    get_broker_settings,
    get_candle_settings,
    get_discipline_settings,
    get_platform_strategies,
    get_pricing_settings,
    get_strategy_costs,
    get_strategy_settings,
    get_trial_settings,
    invalidate_candle_cache,
    invalidate_discipline_cache,
    invalidate_platform_strategies_cache,
    invalidate_pricing_cache,
    invalidate_settings_cache,
    invalidate_strategy_costs_cache,
    invalidate_strategy_settings_cache,
    invalidate_trial_cache,
    save_candle_settings,
    save_discipline_settings,
    save_platform_strategies,
    save_pricing_settings,
    save_strategy_costs,
    save_strategy_settings,
    save_trial_settings,
    set_setting,
)

router = APIRouter(prefix="/admin", tags=["admin"])

PAGE_SIZE_DEFAULT = 50
PAGE_SIZE_MAX = 200


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


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
        like = f"%{q}%"
        conds = [User.email.ilike(like), User.phone.ilike(like)]
        digits = "".join(ch for ch in q if ch.isdigit())
        if digits:
            conds.append(User.phone.ilike(f"%{digits.lstrip('0')}"))
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

    users = [
        AdminUserOut(
            id=u.id,
            email=u.email,
            phone=u.phone,
            role=u.role,
            plan=u.plan,
            planExpiresAt=u.plan_expires_at,
            planNote=u.plan_note,
            createdAt=u.created_at,
            lastActiveAt=u.last_active_at,
            mt5AccountCount=counts.get(u.id, 0),
        )
        for u in rows
    ]
    return {"users": [x.model_dump(mode="json") for x in users], "total": total, "limit": limit, "offset": offset}


def _log_change(db: Session, admin_id: str, target_id: str, field: str, old_value, new_value) -> None:
    old_s = "" if old_value is None else str(old_value)
    new_s = "" if new_value is None else str(new_value)
    if old_s == new_s:
        return
    db.add(
        AdminAuditLog(
            admin_user_id=admin_id,
            target_user_id=target_id,
            field=field,
            old_value=old_s,
            new_value=new_s,
        )
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
    return AdminUserOut(
        id=target.id,
        email=target.email,
        role=target.role,
        plan=target.plan,
        planExpiresAt=target.plan_expires_at,
        planNote=target.plan_note,
        createdAt=target.created_at,
        lastActiveAt=target.last_active_at,
        mt5AccountCount=account_count,
    )


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


@router.get("/metrics", response_model=AdminMetricsOut)
def metrics(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """基础运营指标：总用户数、DAU/WAU（按 last_active_at）、各等级人数、近 7 天注册量。
    Basic operating metrics: total users, DAU/WAU (by last_active_at), plan
    breakdown, and signups over the last 7 days."""
    now = datetime.now(timezone.utc)
    total_users = db.query(func.count(User.id)).scalar() or 0

    dau_cutoff = now - timedelta(hours=24)
    wau_cutoff = now - timedelta(days=7)
    dau = db.query(func.count(User.id)).filter(User.last_active_at >= dau_cutoff).scalar() or 0
    wau = db.query(func.count(User.id)).filter(User.last_active_at >= wau_cutoff).scalar() or 0

    plan_counts: dict[str, int] = {}
    for plan_value, cnt in db.query(User.plan, func.count(User.id)).group_by(User.plan).all():
        plan_counts[plan_value or "FREE"] = cnt

    # 近 7 天每日注册量（含今天，按 UTC 日期分组，Python 侧分组以跨数据库一致）
    # Daily signups for the last 7 days (incl. today, grouped in Python for
    # cross-DB consistency, same approach as signals.signal_stats)
    start_date = (now - timedelta(days=6)).date()
    rows = db.query(User.created_at).filter(
        User.created_at >= datetime.combine(start_date, datetime.min.time(), tzinfo=timezone.utc)
    ).all()
    counts: dict[str, int] = {}
    for i in range(7):
        day = start_date + timedelta(days=i)
        counts[day.isoformat()] = 0
    for (created_at,) in rows:
        ts = _aware(created_at)
        if ts is None:
            continue
        key = ts.date().isoformat()
        if key in counts:
            counts[key] += 1
    signups_last_7d = [{"date": d, "count": c} for d, c in counts.items()]

    return AdminMetricsOut(
        totalUsers=total_users,
        dau=dau,
        wau=wau,
        planCounts=plan_counts,
        signupsLast7d=signups_last_7d,
    )


@router.get("/page-stats", response_model=AdminPageStatsOut)
def page_stats(
    days: int = Query(7, ge=1, le=90),
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
    today = datetime.now(timezone.utc).date()
    # 含今天在内的 days 天，所以起点回退 days-1 天。用日期而非"当前时刻减 N×24h"，
    # 否则窗口边界会落在半天中间，首尾两天的数据都是残缺的、折线图看着像是掉了。
    # A window of `days` days including today, so the start is days-1 back. Date
    # based rather than "now minus N×24h", which would cut the first and last day
    # mid-way and make the line chart look like a dip at both ends.
    start_day = today - timedelta(days=days - 1)
    cutoff = datetime.combine(start_day, time.min)

    # 排除后台自己：/admin 已从上报白名单移除，但库里还有之前累积的行，
    # 查询侧也要滤掉，否则历史数据会一直挂在排行里。
    # Exclude the admin page itself: /admin is off the reporting whitelist, but
    # previously accumulated rows remain in the DB, so filter here too or the
    # historical data would sit in the ranking forever.
    view_rows = (
        db.query(
            PageViewStat.path,
            func.date(PageViewStat.time_bucket).label("day"),
            func.sum(PageViewStat.views),
            func.sum(PageViewStat.total_seconds),
        )
        .filter(PageViewStat.time_bucket >= cutoff, PageViewStat.path != "/admin")
        .group_by(PageViewStat.path, func.date(PageViewStat.time_bucket))
        .all()
    )
    # 三个人数查询共用同一组过滤条件。抽出来是因为漏掉任何一个的 path != "/admin"
    # 都不会报错，只会让某个数字悄悄把后台自己算进去。
    # The three visitor queries share one filter. Extracted because omitting the
    # path != "/admin" clause anywhere fails silently, just quietly folding the
    # admin page into one of the numbers.
    visitor_window = (PageVisitorDay.day >= start_day, PageVisitorDay.path != "/admin")
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

    # 按 (path, day) 归拢两张表的结果。func.date() 在 SQLite 下返回字符串、
    # 在其他驱动下可能返回 date 对象，统一成 ISO 字符串再当键用。
    # Merge both tables keyed by (path, day). func.date() yields a string on
    # SQLite but may yield a date elsewhere, so normalise to an ISO string.
    def _day_key(value) -> str:
        return value.isoformat() if hasattr(value, "isoformat") else str(value)[:10]

    per_page: dict[str, dict[str, dict]] = {}
    for path, day, views, seconds in view_rows:
        cell = per_page.setdefault(path, {}).setdefault(
            _day_key(day), {"views": 0, "seconds": 0.0, "visitors": 0}
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
    day_keys = [(start_day + timedelta(days=i)).isoformat() for i in range(days)]

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
        days=days,
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


def _strategy_winrate_signals_impl(db: Session, strategy: str, symbol: str, days: int) -> dict:
    """明细查询实体。策略名匹配故意放在 Python 里做（不用 SQL TRIM 模拟），
    详见下方长注释；其余过滤（source/symbol/窗口）仍下推给 SQL。
    Strategy-name matching is deliberately done in Python, not via SQL TRIM —
    see the long comment below; the other filters (source/symbol/window) still
    go to SQL.

    早期版本这里写的是 `func.trim(func.coalesce(Signal.indicator, "")) ==
    strategy.strip()`，本意是"与聚合侧同口径"，但没有做到：SQL 标准 TRIM()
    （SQLite、PostgreSQL 都一样）不带参数时**只剥离半角空格**，不认 tab、
    换行等其它空白字符；而聚合侧 `strategy_winrate.py` 用的是 Python
    `str.strip()`，会剥掉所有空白类字符。于是一个被 "\tAlpha\n" 这种非空格
    空白垫过的策略名，聚合侧按 "Alpha" 分组、明细侧的 SQL TRIM 却查不到它——
    正是"矩阵里算得进、点开明细却看不见"的那种静默不一致，而且是 brief 原文
    那行 SQL 自己就达不到它自己声明的不变量，不是 Python 侧的问题。

    改法：让两侧结构性地共用同一行代码 `(x or "").strip()`，而不是让 SQL 去
    模仿 Python 的空白语义——语义永远不会再第二次漂移。代价是要把该
    (symbol, window) 组合下的整批行拉到 Python 里再过滤/计数，SQL 侧无法再
    用 count()/LIMIT 直接给出真实总数。这里认为代价可接受：这是管理员专用、
    单品种、窗口 ≤90 天的低频端点（只在点开品种页签时才请求），聚合端点本来
    就要在同一次请求里扫整个窗口下全部品种的信号，这里至多是同一批行再多做
    一次 strip 比较。

    Earlier this line read `func.trim(func.coalesce(Signal.indicator, "")) ==
    strategy.strip()`, meant to match the aggregation side's grouping — but it
    didn't: the SQL-standard TRIM() (identical in SQLite and PostgreSQL) with
    no argument strips ASCII spaces only, not tabs, newlines, or other
    whitespace, while the aggregation side (strategy_winrate.py) uses Python's
    str.strip(), which strips every whitespace class. A strategy name padded
    with "\tAlpha\n" therefore groups under "Alpha" on the aggregation side but
    the SQL TRIM() here fails to find it — the exact "counted into the matrix
    cell, invisible in the drill-down" failure, and the brief's own SQL line
    couldn't satisfy the invariant it was written to satisfy.

    Fix: make both sides structurally share the same line of code,
    `(x or "").strip()`, instead of asking SQL to imitate Python's whitespace
    semantics — the two definitions can never drift apart again. The cost is
    pulling the whole (symbol, window) row set into Python before
    filtering/counting, so SQL can no longer hand back a true total via
    count()/LIMIT directly. Accepted here: this is an admin-only,
    single-symbol, <=90-day endpoint fetched only when a symbol tab is opened,
    and the aggregation endpoint already scans every symbol in the window on
    one request — this only adds one more strip() comparison over the same
    rows.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).replace(tzinfo=None)
    rows = (
        db.query(Signal)
        .filter(
            Signal.source == "tradingview",
            Signal.symbol == symbol,
            Signal.created_at >= cutoff,
        )
        .order_by(Signal.created_at.desc())
        .all()
    )
    target = strategy.strip()
    # 与 compute_strategy_session_winrate 的分组键同一行代码：(indicator or "").strip()。
    # Same line of code as compute_strategy_session_winrate's grouping key.
    matched = [s for s in rows if (s.indicator or "").strip() == target]
    total = len(matched)  # 真实总数，必须在 Python 过滤之后算 / true count, taken after the Python filter
    signals = []
    for s in matched[:50]:
        resolve_seconds = None
        if s.result in ("HIT_TP", "HIT_SL") and s.resolved_at and s.created_at:
            resolve_seconds = (s.resolved_at - s.created_at).total_seconds()
        signals.append({
            "side": s.side, "entry": s.entry, "stopLoss": s.stop_loss,
            "takeProfit": s.take_profit, "createdAt": s.created_at,
            "sessionKeys": session_keys_for(s.created_at) if s.created_at else [],
            "result": s.result or "PENDING",
            "resolveSeconds": resolve_seconds,
        })
    return {"strategy": strategy, "symbol": symbol, "days": days,
            "total": total, "signals": signals}


@router.get("/strategy-winrate/signals", response_model=AdminStrategySignalListOut)
def strategy_winrate_signals(
    strategy: str = Query(..., max_length=128),
    symbol: str = Query(..., max_length=20),
    days: int = Query(7, ge=1, le=90),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """某（策略, 品种）组合窗口内的信号明细，最多 50 条、时间倒序。
    只在管理员点开品种页签时请求，不塞进主响应。
    Drill-down detail for one (strategy, symbol) combo; fetched on demand."""
    return _strategy_winrate_signals_impl(db, strategy, symbol, days)


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
    data = {
        "pro_monthly_price": body.proMonthlyPrice,
        "pro_yearly_price": body.proYearlyPrice,
        "sale_enabled": body.saleEnabled,
        "sale_percent": body.salePercent,
        "sale_badge": body.saleBadge.strip(),
        "sale_end_at": body.saleEndAt.strip() or None,
    }
    save_pricing_settings(db, data)
    _log_change(db, admin.id, admin.id, "setting:pricing", None, json.dumps(data))
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
    data = {
        "trial_enabled": body.trialEnabled,
        "trial_days": body.trialDays,
    }
    save_trial_settings(db, data)
    _log_change(db, admin.id, admin.id, "setting:trial", None, json.dumps(data))
    db.commit()
    invalidate_trial_cache()
    return get_trial(db, admin)


# ---------- 纪律分参数设置 / discipline-score parameter settings ----------

@router.get("/discipline", response_model=AdminDisciplineSettings)
def get_discipline(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """读取纪律分参数。Read discipline-score parameters."""
    c = get_discipline_settings(db)
    return AdminDisciplineSettings(
        windowDays=int(c["window_days"]),
        weightStop=int(c["weight_stop"]),
        weightVolume=int(c["weight_volume"]),
        weightExit=int(c["weight_exit"]),
        slTolerancePct=float(c["sl_tolerance_pct"]),
        volumeMultiple=float(c["volume_multiple"]),
        volumeHistoryMin=int(c["volume_history_min"]),
    )


@router.put("/discipline", response_model=AdminDisciplineSettings)
def put_discipline(
    body: AdminDisciplineSettings,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """保存纪律分参数。三个权重不能全为零，否则总分永远算不出来。
    Save discipline-score parameters. The three weights can't all be zero,
    or the total score could never be computed."""
    if body.weightStop + body.weightVolume + body.weightExit <= 0:
        raise HTTPException(
            status_code=400,
            detail="权重不能全为零 / Weights cannot all be zero",
        )
    data = {
        "window_days": body.windowDays,
        "weight_stop": body.weightStop,
        "weight_volume": body.weightVolume,
        "weight_exit": body.weightExit,
        "sl_tolerance_pct": body.slTolerancePct,
        "volume_multiple": body.volumeMultiple,
        "volume_history_min": body.volumeHistoryMin,
    }
    save_discipline_settings(db, data)
    _log_change(db, admin.id, admin.id, "setting:discipline", None, json.dumps(data))
    db.commit()
    invalidate_discipline_cache()
    return get_discipline(db, admin)


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
    data = {"m1_retention_days": body.m1RetentionDays}
    save_candle_settings(db, data)
    _log_change(db, admin.id, admin.id, "setting:candle_history", None, json.dumps(data))
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
    data = {"max_strategies_per_user": body.maxStrategiesPerUser, "pro_only": body.proOnly}
    save_strategy_settings(db, data)
    _log_change(db, admin.id, admin.id, "setting:strategy", None, json.dumps(data))
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
    _log_change(db, admin.id, admin.id, "setting:strategy_costs", None, json.dumps(data))
    db.commit()
    invalidate_strategy_costs_cache()
    return get_strategy_cost_settings(db, admin)


# ---------- 图片上传 / image upload ----------

@router.post("/upload-image", response_model=dict)
async def upload_admin_image(
    file: UploadFile = File(...),
    _admin: User = Depends(require_admin),
):
    """上传一张策略配图，返回公开 URL。仅管理员。

    只读一次到内存并在读完后按上限判断：策略配图上限 4MB（见 UPLOAD_MAX_BYTES），
    不值得为它引入流式落盘。注意不能信任 Content-Length——它由客户端提供，所以
    实际拦截依据是读到的字节数。
    Upload one strategy illustration and return its public URL. Admin only.

    The file is read into memory once and checked against the cap afterwards:
    illustrations are capped at 4MB (see UPLOAD_MAX_BYTES), which doesn't justify
    streaming to disk. Content-Length is client-supplied and therefore not
    trusted; the real check is on the bytes actually read.
    """
    if not is_upload_configured():
        raise HTTPException(
            status_code=503,
            detail="后台未配置图片存储，请改用外链图片地址 / Image storage isn't configured; use an external image URL instead",
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
    save_platform_strategies(db, items)
    _log_change(db, admin.id, admin.id, "setting:platform_strategies", None, json.dumps({"count": len(items), "ids": ids}, ensure_ascii=False))
    db.commit()
    invalidate_platform_strategies_cache()
    return get_admin_platform_strategies(db, admin)



