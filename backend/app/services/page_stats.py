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

from sqlalchemy.orm import Session

from app.models import PageVisitorDay

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
