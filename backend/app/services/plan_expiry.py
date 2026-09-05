"""会员到期自动降级：把到期的付费等级落库回 FREE。

两条路径共用同一个 downgrade_if_expired()：
- 读取时（services/deps.get_current_user）：发起请求的用户本人即时自愈，
  到期后第一个带凭证的请求就把等级落库改回 FREE，之后不再触发。
- 后台扫描（plan_expiry_sweep_loop）：兜底覆盖那些不主动发 REST 请求、
  但仍被 WS 广播 / Web Push / 自动仓位管理**直接按数据库 plan 命中**的在线
  用户（这些路径不经过 get_current_user），并让管理后台/统计口径与真实权限一致。

每次自动降级写一条 AdminAuditLog 留痕。该表的 admin_user_id 非空且外键指向
用户，而自动降级没有管理员操作者——沿用本仓库既有约定（用户自身占位，靠
field="plan:auto_expire" 标记区分于人工操作，参见 admin.py 平台设置审计的写法）。

Automatic membership downgrade: persist an expired paid plan back to FREE.

Both entry points share downgrade_if_expired():
- Read-time (services/deps.get_current_user): the requesting user self-heals —
  the first authenticated request after expiry writes the plan back to FREE.
- Background sweep (plan_expiry_sweep_loop): a safety net for users who don't
  make REST calls yet are still hit by WS broadcast / Web Push / auto position
  management, all of which read User.plan straight from the DB (not via
  get_current_user); it also keeps the admin panel and metrics truthful.

Each auto-downgrade writes an AdminAuditLog row. That table's admin_user_id is
non-null and FKs to a user, but an automatic downgrade has no admin actor — we
follow the existing convention (stand in the user's own id, disambiguated by
field="plan:auto_expire"), same as the platform-settings audit in admin.py.
"""
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import AdminAuditLog, User
from app.services.plans import is_plan_expired

logger = logging.getLogger(__name__)

# 后台兜底扫描间隔（秒）。会员按天计费，无需秒级精度；15 分钟把"在线但不发
# 请求的用户在 DB 里仍是付费"的窗口压到足够小。
# Background sweep interval (s). Memberships are billed by the day, so no
# sub-second precision is needed; 15 minutes keeps the window in which an
# "online but request-less" user still reads as paid in the DB small enough.
SWEEP_INTERVAL_SECONDS = 15 * 60


def downgrade_if_expired(db: Session, user: User) -> bool:
    """付费等级已到期则就地降级为 FREE、写审计日志并清空到期时间，返回是否发生降级。
    只改动 session 中的对象与新增审计行，**由调用方负责 commit**。

    清空 plan_expires_at 是有意为之：避免管理员之后重新升级却忘了更新到期时间时，
    过去的到期时间立刻把用户再次判为过期。降级发生的时刻由审计日志记录。

    Downgrade an expired paid plan to FREE in place (write an audit row and
    clear the expiry), returning whether a downgrade happened. Only mutates the
    session object and adds an audit row — **the caller must commit**.

    Clearing plan_expires_at is deliberate: it prevents a stale past expiry from
    immediately re-expiring the user if an admin later re-upgrades them without
    setting a fresh expiry. When the downgrade happened is recorded in the audit
    log.
    """
    if not is_plan_expired(user.plan, user.plan_expires_at):
        return False
    old_plan = user.plan
    db.add(
        AdminAuditLog(
            admin_user_id=user.id,
            target_user_id=user.id,
            field="plan:auto_expire",
            old_value=old_plan,
            new_value="FREE",
        )
    )
    user.plan = "FREE"
    user.plan_expires_at = None
    # 试用与付费到期共用这条路径，无条件清理是安全的（非试用用户本就是 False）。
    # Trial and paid expiry share this path; clearing unconditionally is safe
    # (non-trial users are already False).
    user.plan_is_trial = False
    return True


def sweep_expired_plans(now: datetime | None = None) -> int:
    """一趟扫描：把所有已到期的付费用户落库降级为 FREE，返回降级人数。
    同步、开自己的 session；由 plan_expiry_sweep_loop 放进线程池调用。
    One sweep: persist every expired paid user down to FREE, returning the count.
    Synchronous with its own session; the loop runs it in the thread pool."""
    now = now or datetime.now(timezone.utc)
    db = SessionLocal()
    try:
        # 付费用户很少，取出所有设了到期时间的非 FREE 用户，由纯判定逐个复核，
        # 避免不同数据库上 naive/aware 时间比较的坑（signal_expiry_loop 同思路）。
        # Paid users are few; pull all non-FREE users with an expiry set
        # and let the pure predicate re-check each, sidestepping naive/
        # aware datetime comparison quirks across DBs (same approach as
        # signal_expiry_loop).
        rows = (
            db.query(User)
            .filter(User.plan != "FREE", User.plan_expires_at.isnot(None))
            .all()
        )
        count = 0
        for user in rows:
            if is_plan_expired(user.plan, user.plan_expires_at, now) and downgrade_if_expired(db, user):
                count += 1
        if count:
            db.commit()
            logger.info("plan_expiry_sweep_loop: downgraded %d user(s) to FREE", count)
        return count
    finally:
        db.close()


async def plan_expiry_sweep_loop() -> None:
    """定时把所有已到期的付费用户落库降级为 FREE（启动即先跑一次，再按间隔循环）。

    扫描本身是同步 DB 操作，必须放进线程池：直接跑在事件循环上会把 WS 推送、
    bridge 轮询、gateway 事件泵一起卡住，付费用户多了之后每 15 分钟卡一次。
    与 gamification_loop / candle_retention_sweep_loop 的做法一致。
    Periodically persist every expired paid user down to FREE. The sweep is
    synchronous DB work and runs in the thread pool — on the event loop it would
    stall WS pushes, bridge polling and the gateway event pump every 15 minutes
    once there are enough paid users. Same pattern as the other loops."""
    while True:
        try:
            await run_in_threadpool(sweep_expired_plans)
        except Exception:
            logger.exception("plan_expiry_sweep_loop error")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
