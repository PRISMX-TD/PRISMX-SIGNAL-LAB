"""页面访问埋点上报与管理后台聚合统计的单测。

重点覆盖几处容易写错、且错了不会报错只会给出错误数字的地方：
1. 平均停留时长必须按访问量加权（SUM/SUM），不能对各小时桶的平均值再求平均；
2. path 白名单必须真的拦住未知路径，否则表体积失去上界；
3. 访问人数必须去重，且窗口汇总人数不能等于各天人数相加；
4. 折线图的日期轴必须连续，没数据的日期要补 0 而不是跳过。

Tests for page-view telemetry and the admin-side aggregation.
Focused on things that fail silently with wrong numbers rather than errors:
(1) the average must be view-weighted (SUM/SUM), not a mean of per-bucket means;
(2) the path whitelist must actually reject unknown paths, or the table loses
its size bound; (3) visitor counts must dedup, and the window total must not be
the sum of daily figures; (4) the chart's date axis must be contiguous, with
zero-filled gaps rather than skipped days.
"""
from datetime import datetime, timedelta, timezone

from app.core.security import create_access_token, generate_api_token, hash_api_token
from app.models import PageVisitorDay, PageViewStat, User


def _admin_headers(db):
    admin = User(email="admin@example.com", password_hash="x", api_token=hash_api_token(generate_api_token()), role="admin")
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return {"Authorization": f"Bearer {create_access_token(admin.id)}"}


def test_pageview_accumulates_into_one_hourly_row(client, db, auth_headers):
    """同一小时同一页多次上报只累加一行，不产生明细行。

    同时确认人数标记也只有一行：同一个人当天来 3 次是 3 次访问、1 个人。
    """
    for _ in range(3):
        res = client.post("/api/telemetry/pageview", headers=auth_headers,
                          json={"path": "/orders", "seconds": 10})
        assert res.status_code == 204

    rows = db.query(PageViewStat).filter(PageViewStat.path == "/orders").all()
    assert len(rows) == 1
    assert rows[0].views == 3
    assert rows[0].total_seconds == 30
    assert db.query(PageVisitorDay).filter(PageVisitorDay.path == "/orders").count() == 1


def test_pageview_rejects_unknown_path_without_writing(client, db, auth_headers):
    """白名单外的 path 静默忽略：返回 204 但不落库。

    返回 204 是刻意的——埋点失败不该让前端弹错误；但必须确认它真的没写进去，
    否则伪造 path 就能让行数无上界增长。
    """
    res = client.post("/api/telemetry/pageview", headers=auth_headers,
                      json={"path": "/../etc/passwd", "seconds": 5})
    assert res.status_code == 204
    assert db.query(PageViewStat).count() == 0
    # 人数标记同样不能写：否则伪造 path 依然能把这张表撑大
    assert db.query(PageVisitorDay).count() == 0


def test_pageview_clamps_dwell_and_floors_negative(client, db, auth_headers):
    """超长停留按上限计（挂着页面没看），负数归零。"""
    client.post("/api/telemetry/pageview", headers=auth_headers,
                json={"path": "/charts", "seconds": 99999})
    row = db.query(PageViewStat).filter(PageViewStat.path == "/charts").one()
    assert row.total_seconds == 1800.0

    client.post("/api/telemetry/pageview", headers=auth_headers,
                json={"path": "/charts", "seconds": -50})
    db.refresh(row)
    assert row.views == 2
    assert row.total_seconds == 1800.0


def test_pageview_requires_login(client, db):
    assert client.post("/api/telemetry/pageview", json={"path": "/orders", "seconds": 1}).status_code == 401


def test_page_stats_average_is_view_weighted_across_buckets(client, db):
    """平均停留必须按访问量加权，不是对桶平均值再平均。

    造两个小时桶：一个 1 次访问停留 600 秒（冷清时段的极端值），另一个 99 次
    共停留 990 秒（每次 10 秒）。正确答案是 (600+990)/100 = 15.9 秒；若错误地
    对两个桶的平均值等权平均，会得到 (600+10)/2 = 305 秒——差了 20 倍。
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    db.add(PageViewStat(path="/dashboard", time_bucket=now, views=1, total_seconds=600.0))
    db.add(PageViewStat(path="/dashboard", time_bucket=now - timedelta(hours=1), views=99, total_seconds=990.0))
    db.commit()

    res = client.get("/api/admin/page-stats?days=7", headers=_admin_headers(db))
    assert res.status_code == 200
    body = res.json()
    assert body["totalViews"] == 100
    assert body["pages"][0]["path"] == "/dashboard"
    assert body["pages"][0]["views"] == 100
    assert body["pages"][0]["avgSeconds"] == 15.9
    assert body["avgSecondsOverall"] == 15.9


def test_page_stats_ranks_by_views_and_honours_window(client, db):
    """按访问次数降序；窗口外的桶不计入。"""
    now = datetime.now(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    db.add(PageViewStat(path="/orders", time_bucket=now, views=5, total_seconds=50.0))
    db.add(PageViewStat(path="/charts", time_bucket=now, views=20, total_seconds=400.0))
    # 30 天前：days=7 的窗口应排除它
    db.add(PageViewStat(path="/account", time_bucket=now - timedelta(days=30), views=999, total_seconds=9990.0))
    db.commit()

    body = client.get("/api/admin/page-stats?days=7", headers=_admin_headers(db)).json()
    paths = [p["path"] for p in body["pages"]]
    assert paths == ["/charts", "/orders"]
    assert "/account" not in paths
    assert body["totalViews"] == 25


def test_page_stats_empty_returns_zeros_not_error(client, db):
    """没有任何数据时不能因为除零而 500，且日期轴仍要给全。"""
    body = client.get("/api/admin/page-stats?days=7", headers=_admin_headers(db)).json()
    assert body["totalViews"] == 0
    assert body["totalVisitors"] == 0
    assert body["avgSecondsOverall"] == 0.0
    assert body["pages"] == []
    # 没数据也要有日期轴，否则前端画不出空图只能显示错误
    assert len(body["dates"]) == 7


def test_page_stats_counts_distinct_visitors_not_views(client, db, auth_headers, user):
    """人数是去重的：一个人看 5 次是 5 次访问、1 个人。

    这是本轮改动的核心——旧版只有次数，无法区分"1 个人看 5 次"和"5 个人各看
    1 次"。若人数错误地取了次数，这个断言会立刻失败。
    """
    for _ in range(5):
        client.post("/api/telemetry/pageview", headers=auth_headers,
                    json={"path": "/charts", "seconds": 8})
    other = User(email="second@example.com", password_hash="x",
                 api_token=hash_api_token(generate_api_token()))
    db.add(other)
    db.commit()
    db.refresh(other)
    client.post("/api/telemetry/pageview",
                headers={"Authorization": f"Bearer {create_access_token(other.id)}"},
                json={"path": "/charts", "seconds": 8})

    page = client.get("/api/admin/page-stats?days=7", headers=_admin_headers(db)).json()["pages"][0]
    assert page["path"] == "/charts"
    assert page["views"] == 6
    assert page["visitors"] == 2


def test_page_stats_window_visitors_are_not_sum_of_days(client, db, user):
    """窗口汇总人数是整段去重，不是各天人数相加。

    同一个用户连续 3 天访问：按天各算 1 人（3 天都有人来），但窗口内只有 1 个人。
    若把各天相加会得到 3，这正是最容易写错的地方。
    """
    today = datetime.now(timezone.utc).date()
    now = datetime.now(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    for i in range(3):
        db.add(PageVisitorDay(path="/orders", day=today - timedelta(days=i), user_id=user.id))
        db.add(PageViewStat(path="/orders", time_bucket=now - timedelta(days=i),
                            views=1, total_seconds=10.0))
    db.commit()

    body = client.get("/api/admin/page-stats?days=7", headers=_admin_headers(db)).json()
    assert body["totalVisitors"] == 1
    page = body["pages"][0]
    assert page["visitors"] == 1
    assert page["views"] == 3
    # 但按天看，这 3 天各有 1 人
    non_zero = [d for d in page["daily"] if d["visitors"] > 0]
    assert len(non_zero) == 3
    assert all(d["visitors"] == 1 for d in non_zero)


def test_page_stats_daily_series_is_contiguous_and_zero_filled(client, db, user):
    """日期轴连续、无数据的日期补 0，且按日期升序。

    折线图若拿到不连续的序列，会把"这天没人来"画成直线跨过去，读起来像访问量
    从没掉过。
    """
    today = datetime.now(timezone.utc).date()
    now = datetime.now(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
    # 只在今天和 4 天前各造一条，中间三天刻意留空
    db.add(PageViewStat(path="/app", time_bucket=now, views=2, total_seconds=40.0))
    db.add(PageViewStat(path="/app", time_bucket=now - timedelta(days=4), views=1, total_seconds=5.0))
    db.commit()

    body = client.get("/api/admin/page-stats?days=7", headers=_admin_headers(db)).json()
    daily = body["pages"][0]["daily"]
    assert len(daily) == 7
    assert [d["date"] for d in daily] == body["dates"]
    assert [d["date"] for d in daily] == sorted(d["date"] for d in daily)
    assert daily[-1]["date"] == today.isoformat()
    assert daily[-1]["views"] == 2
    assert daily[-1]["avgSeconds"] == 20.0
    # 中间空档必须是 0，不能缺项
    assert daily[-2]["views"] == 0
    assert daily[-2]["avgSeconds"] == 0.0


def test_prune_visitor_days_drops_only_expired_markers(db, user):
    """保留期清理只删过期标记，窗口内的不动。

    这张表没有体积上界，不清理会无限长大；但清多了会把还要用的数据删掉。
    """
    from app.services.page_stats import VISITOR_RETENTION_DAYS, prune_visitor_days

    today = datetime.now(timezone.utc).date()
    db.add(PageVisitorDay(path="/orders", day=today, user_id=user.id))
    db.add(PageVisitorDay(path="/orders", day=today - timedelta(days=VISITOR_RETENTION_DAYS + 5),
                          user_id=user.id))
    db.commit()

    assert prune_visitor_days(db) == 1
    remaining = db.query(PageVisitorDay).all()
    assert len(remaining) == 1
    assert remaining[0].day == today


def test_page_stats_requires_admin(client, db, auth_headers):
    assert client.get("/api/admin/page-stats", headers=auth_headers).status_code == 403
