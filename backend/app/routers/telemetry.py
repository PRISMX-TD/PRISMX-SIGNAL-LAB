"""页面访问上报：把「某页面被看了一次、停留 N 秒」累加进小时桶，
并按天登记一次「这个用户今天来过这一页」用于算访问人数。

访问次数与停留时长进 PageViewStat（不含任何身份）；访问人数靠
PageVisitorDay 的「页面 × 天 × 用户」去重标记算 COUNT(DISTINCT)。
两张表的分工与隐私边界见各自的模型说明——简单说：能答"周二有几个人
看过图表页"，不能答"某人几点看了多久"。

两条硬约束，都是为了防止这个端点被用来把表写爆：
1. path 必须在白名单里。表体积之所以恒定，前提是 path 的取值集合有限；
   若照抄客户端传来的任意字符串，伪造几万个不同 path 就能让行数无上限增长。
2. 停留秒数封顶。用户开着页面去吃饭会上报几小时，这种值会把平均停留时长
   彻底拉歪，所以超过上限按上限计。

Page-view reporting: accumulates "this page was viewed once, for N seconds"
into an hourly bucket, and registers "this user visited this page today" once
per day for visitor counts.

View counts and dwell time go to PageViewStat (identity-free); visitor counts
come from COUNT(DISTINCT) over PageVisitorDay's (page, day, user) dedup
markers. See each model's docstring for the split and its privacy boundary —
in short: it can answer "how many people opened the chart page on Tuesday",
not "who was there at what time for how long".

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
from app.models import PageVisitorDay, PageViewStat, User
from app.schemas import PageViewIn
from app.services.deps import get_current_user

router = APIRouter(prefix="/telemetry", tags=["telemetry"])

# 允许上报的前端路由，与 App.tsx 的受保护路由一一对应。新增页面时要同步加，
# 否则该页的访问不会被统计（宁可漏统计，也不放开任意 path 写入）。
#
# 刻意排除 /admin：后台只有管理员自己会进，统计它等于统计自己看统计的次数，
# 反而会在排行里占一席、把真实用户页面挤下去。
#
# Reportable frontend routes, mirroring the protected routes in App.tsx. Add
# here when adding a page, otherwise its views go uncounted — under-counting is
# preferable to accepting arbitrary paths.
#
# /admin is deliberately excluded: only admins ever open it, so counting it just
# measures how often you check your own stats while taking a slot in the ranking
# away from real user-facing pages.
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
    user: User = Depends(get_current_user),
):
    """累加一次页面访问。返回 204，前端不需要任何响应体。

    不在白名单的 path 静默忽略（照样返回 204）——这是埋点上报，不是业务操作，
    为一个统计问题给用户弹错误没有意义，也免得前端为此写错误处理分支。

    管理员的访问一概不计（见下方注释），同样静默返回。

    Accumulates one page view. Returns 204; the client needs no response body.
    Unknown paths are silently ignored (still 204) — this is telemetry, not a
    business action; surfacing an error to the user over a stats issue serves
    no one and would force the client to handle a failure it can't act on.
    Admin visits are never counted (see the comment below), also silently.
    """
    if payload.path not in ALLOWED_PATHS:
        return

    # 管理员的访问不计入统计。这里过滤的是"人"而不是"某个页面"：管理员为了
    # 检查功能会把每个页面都点一遍，那不是用户行为，会把每个页面的数字都抬高
    # 一点。在总人数只有个位数的阶段，一个人的噪声占比大到足以看错趋势。
    #
    # 放在这里（而不是查询侧）是因为这是唯一能判断"谁在访问"的地方——统计表
    # 里的 page_view_stats 刻意不存 user_id，聚合之后就再也分不出哪几次是
    # 管理员的了。宁可不写进去，也不能指望事后过滤。
    #
    # Admin visits are excluded. This filters a person, not a page: an admin
    # clicking through every page to check things isn't user behaviour, and it
    # inflates every page's numbers. While the user count is in single digits,
    # one person's noise is enough to misread a trend.
    #
    # It belongs here rather than in the query because this is the only place
    # that knows *who* is visiting — page_view_stats deliberately stores no
    # user_id, so once aggregated the admin's views can never be separated out.
    # Better to never write them than to hope for a later filter.
    if user.role == "admin":
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
            # 新桶已建好，计数部分到此结束；人数登记仍要走，别在这里直接 return。
            # Bucket created, counting done; the visitor marker still needs
            # writing — don't return early here.
            _mark_visitor(db, payload.path, bucket.date(), user.id)
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
    _mark_visitor(db, payload.path, bucket.date(), user.id)


def _mark_visitor(db: Session, path: str, day, user_id: str) -> None:
    """登记「该用户当天来过该页」，重复登记是无操作。

    用 INSERT 撞唯一约束来判重，而不是先 SELECT 再 INSERT：后者在并发下
    两个请求可能都查到"没有"然后都插，多出来的那行会让人数被重复计算。
    这里让数据库的唯一约束做唯一裁判，撞了就回滚忽略。

    Registers "this user visited this page today"; repeats are no-ops.

    Dedup is done by letting an INSERT hit the unique constraint rather than
    SELECT-then-INSERT: under concurrency the latter lets two requests both see
    "absent" and both insert, and the extra row would double-count a visitor.
    The DB constraint is the single arbiter; on conflict we roll back and ignore.
    """
    db.add(PageVisitorDay(path=path, day=day, user_id=user_id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
