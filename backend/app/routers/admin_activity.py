"""管理后台「操作日志」页的两个只读端点（设计 2026-10-09 §5.1 / §5.2）。

逻辑全在 services/activity_feed.py（纯函数为主、SQLite 可测），这里只做参数解析与错误
映射：参数不合法 400，详情找不到 404，Postgres 语句超时（SET LOCAL statement_timeout）503。

和 gamification / competitions 的管理 router 一样，require_admin 挂在 router 自己身上，
main.py 挂载时再挂一层——单独 include 这个对象也不会裸奔（test_admin_router_guards 的
同一条规矩）。

Two read-only endpoints for the admin "activity log" page (design 2026-10-09
§5.1 / §5.2). All logic lives in services/activity_feed.py; this module only
parses parameters and maps errors (bad input 400, unknown detail 404, a
Postgres statement timeout 503).
require_admin sits on the router itself as well as on main.py's mount, so
including this router anywhere else still guards it.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services import activity_feed
from app.services.deps import require_admin

router = APIRouter(prefix="/admin/activity", tags=["admin"], dependencies=[Depends(require_admin)])

# Postgres 取消语句的 SQLSTATE（query_canceled）：activity_feed 每个请求 SET LOCAL 的
# statement_timeout 到点就是它，SQLAlchemy 包成 OperationalError。
# Postgres SQLSTATE query_canceled: what the per-request SET LOCAL statement_timeout
# in activity_feed raises when it fires (wrapped by SQLAlchemy as OperationalError).
_QUERY_CANCELED = "57014"


def _raise_if_timed_out(e: OperationalError) -> None:
    """语句超时 → 503 + 提示缩小范围，而不是裸 500；别的数据库错误原样抛。
    A statement timeout -> 503 with a hint to narrow the query instead of a bare
    500; any other database error is re-raised by the caller."""
    if getattr(e.orig, "pgcode", None) == _QUERY_CANCELED:
        raise HTTPException(
            status_code=503,
            detail="查询超时，请缩小时间范围或加筛选条件后重试 / Query timed out; narrow the time range or add filters and retry",
            headers={"Retry-After": "2"},
        ) from e


@router.get("", response_model=dict)
def list_activity(
    cat: str = Query("all", max_length=16),
    sub: str = Query("all", max_length=16),
    abnormal: int = Query(0, ge=0, le=1),
    q: str | None = Query(None, max_length=100),
    user_id: str | None = Query(None, max_length=64),
    login: str | None = Query(None, max_length=32),
    since: str | None = Query(None, max_length=40),
    until: str | None = Query(None, max_length=40),
    cursor: str | None = Query(None, max_length=4096),
    limit: int = Query(activity_feed.LIMIT_DEFAULT, ge=1, le=activity_feed.LIMIT_MAX),
    db: Session = Depends(get_db),
):
    """操作日志列表：五个源按时间倒序合并，游标翻页，不返回总数。
    返回 {"items": Item[], "next": 游标 | null}；Item 的形状见契约文档
    docs/superpowers/specs/2026-10-09-admin-activity-log-contract.md。

    Activity list: five sources merged newest first, keyset paged, no totals.
    Returns {"items": Item[], "next": cursor | null}; see the contract doc."""
    try:
        return activity_feed.list_activity(
            db, cat=cat, sub=sub, abnormal=bool(abnormal), q=q, user_id=user_id, login=login,
            since=since, until=until, cursor=cursor, limit=limit,
        )
    except activity_feed.FeedError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OperationalError as e:
        _raise_if_timed_out(e)
        raise


@router.get("/item", response_model=dict)
def activity_item(
    key: str = Query(..., min_length=3, max_length=200),
    cat: str | None = Query(None, max_length=16),
    abnormal: int = Query(0, ge=0, le=1),
    q: str | None = Query(None, max_length=100),
    user_id: str | None = Query(None, max_length=64),
    db: Session = Depends(get_db),
):
    """详情抽屉：{item, user, account, raw, position}。只在打开抽屉时调。
    cat / abnormal / q / user_id 可选，传列表当时的筛选：合并行（审计组、追踪止损）按它还原，
    抽屉与被点的那一行一致。

    Detail drawer: {item, user, account, raw, position}; called on open only.
    Optional cat / abnormal / q / user_id carry the list's filters so merged rows
    (audit groups, trailing runs) are rebuilt exactly as the list showed them."""
    try:
        out = activity_feed.get_item(db, key, cat=cat, abnormal=bool(abnormal), q=q, user_id=user_id)
    except activity_feed.FeedError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OperationalError as e:
        _raise_if_timed_out(e)
        raise
    if out is None:
        raise HTTPException(status_code=404, detail="记录不存在 / Activity item not found")
    return out
