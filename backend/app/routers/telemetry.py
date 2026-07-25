"""页面访问上报：把「某页面被看了一次、停留 N 秒」累加进小时桶。

**不记录是哪个用户**——见 PageViewStat 模型的说明。这里仍然要求登录，
理由不是为了知道"谁"，而是为了不让这个端点变成任何人都能往库里写数据的
开放写入口；user 拿到后即丢弃，不落库。

两条硬约束，都是为了防止这个端点被用来把表写爆：
1. path 必须在白名单里。表体积之所以恒定，前提是 path 的取值集合有限；
   若照抄客户端传来的任意字符串，伪造几万个不同 path 就能让行数无上限增长。
2. 停留秒数封顶。用户开着页面去吃饭会上报几小时，这种值会把平均停留时长
   彻底拉歪，所以超过上限按上限计。

Page-view reporting: accumulates "this page was viewed once, for N seconds"
into an hourly bucket.

NO user identity is stored — see the PageViewStat model docstring. Login is
still required, not to learn *who*, but to keep this from being an open
write endpoint anyone can push rows through; the user is discarded, never
persisted.

Two hard limits, both to stop this endpoint from being used to bloat the table:
1. path must be in a whitelist. Constant table size depends on path having a
   bounded value set; echoing arbitrary client strings would let a few thousand
   forged paths grow the row count without limit.
2. Dwell seconds are capped. A user who leaves a tab open over lunch reports
   hours, which would skew the average dwell time badly, so anything above the
   cap counts as the cap.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import PageViewStat, User
from app.schemas import PageViewIn
from app.services.deps import get_current_user

router = APIRouter(prefix="/telemetry", tags=["telemetry"])

# 允许上报的前端路由，与 App.tsx 的受保护路由一一对应。新增页面时要同步加，
# 否则该页的访问不会被统计（宁可漏统计，也不放开任意 path 写入）。
# Reportable frontend routes, mirroring the protected routes in App.tsx. Add
# here when adding a page, otherwise its views go uncounted — under-counting is
# preferable to accepting arbitrary paths.
ALLOWED_PATHS = frozenset({
    "/dashboard",
    "/app",
    "/charts",
    "/bind",
    "/orders",
    "/strategies",
    "/upgrade",
    "/account",
    "/download",
    "/admin",
    "/simulator",
})

# 单次停留上限（秒）：30 分钟。超过基本可以断定是挂着页面没在看。
# Per-visit dwell cap (seconds): 30 minutes. Beyond that it's almost certainly
# an abandoned open tab rather than actual reading.
MAX_DWELL_SECONDS = 1800.0


@router.post("/pageview", status_code=204)
def report_pageview(
    payload: PageViewIn,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """累加一次页面访问。返回 204，前端不需要任何响应体。

    不在白名单的 path 静默忽略（照样返回 204）——这是埋点上报，不是业务操作，
    为一个统计问题给用户弹错误没有意义，也免得前端为此写错误处理分支。

    Accumulates one page view. Returns 204; the client needs no response body.
    Unknown paths are silently ignored (still 204) — this is telemetry, not a
    business action; surfacing an error to the user over a stats issue serves
    no one and would force the client to handle a failure it can't act on.
    """
    if payload.path not in ALLOWED_PATHS:
        return

    seconds = min(max(payload.seconds, 0.0), MAX_DWELL_SECONDS)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    bucket = now.replace(minute=0, second=0, microsecond=0)

    # 先尝试更新已有桶，没有再插。并发下两个请求可能都发现"没有"然后同时插，
    # 唯一约束会让后到的那个报 IntegrityError——回滚后改成更新即可，行为等价。
    # Try updating an existing bucket first, insert if absent. Under concurrency
    # both requests may find none and insert; the unique constraint makes the
    # loser raise IntegrityError — roll back and update instead, which is
    # equivalent.
    row = (
        db.query(PageViewStat)
        .filter(PageViewStat.path == payload.path, PageViewStat.time_bucket == bucket)
        .one_or_none()
    )
    if row is None:
        db.add(PageViewStat(
            path=payload.path,
            time_bucket=bucket,
            views=1,
            total_seconds=seconds,
        ))
        try:
            db.commit()
            return
        except IntegrityError:
            db.rollback()
            row = (
                db.query(PageViewStat)
                .filter(PageViewStat.path == payload.path, PageViewStat.time_bucket == bucket)
                .one()
            )

    row.views = (row.views or 0) + 1
    row.total_seconds = (row.total_seconds or 0.0) + seconds
    db.commit()
