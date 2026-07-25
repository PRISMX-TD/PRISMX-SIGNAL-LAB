"""页面统计的保留期清理。

两张统计表只有一张需要清理：PageViewStat 按「页面 × 小时」聚合，行数有硬上界
（12 个路由 × 24 小时 = 一天最多 288 行），放着不管也不会出问题；
PageVisitorDay 随「活跃用户数 × 其访问的页面数 × 天数」增长，没有上界，
不清理就会成为全库唯一一张无限长大的统计表。

Retention pruning for page stats.

Only one of the two stats tables needs pruning: PageViewStat aggregates per
(page, hour) and is bounded by construction (12 routes × 24 hours = at most 288
rows/day), so it can be left alone. PageVisitorDay grows with active users ×
pages visited × days with no ceiling, and would otherwise be the one stats table
that grows forever.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import PageVisitorDay, User

# 保留天数。后台查询窗口上限是 90 天（见 admin.page_stats 的 Query 约束），
# 留一点余量后，更早的行对任何查询都已无用。
# Retention window. The admin query caps at 90 days (see the Query constraint on
# admin.page_stats); with some slack, older rows serve no query.
VISITOR_RETENTION_DAYS = 100


def prune_visitor_days(db: Session) -> int:
    """删掉超过保留期的去重标记，返回删除行数。

    Deletes dedup markers past the retention window; returns rows deleted.
    """
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=VISITOR_RETENTION_DAYS)
    deleted = (
        db.query(PageVisitorDay)
        .filter(PageVisitorDay.day < cutoff)
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()
    return deleted


def purge_admin_visitors(db: Session) -> int:
    """删掉管理员的人数标记，返回删除行数。

    上报侧已经不再写管理员的访问，但改之前累积的行还在表里，人数会一直把管理员
    算进去。同一个 sweep 里顺带清掉。

    做成每次 sweep 都跑、而不是一次性脚本，是因为角色会变：某个已有用户之后被
    提为管理员，他之前留下的标记同样要清。让它成为一条持续成立的不变式，比依赖
    "记得再跑一次脚本"可靠。

    Deletes admin visitor markers; returns rows deleted.

    Reporting no longer records admin visits, but rows accumulated before that
    change remain and would keep folding the admin into visitor counts.

    This runs on every sweep rather than as a one-off script because roles
    change: if an existing user is promoted to admin later, their earlier markers
    need clearing too. A continuously enforced invariant beats remembering to
    re-run a script.
    """
    admin_ids = select(User.id).where(User.role == "admin").scalar_subquery()
    deleted = (
        db.query(PageVisitorDay)
        .filter(PageVisitorDay.user_id.in_(admin_ids))
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()
    return deleted
