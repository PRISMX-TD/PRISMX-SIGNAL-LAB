"""页面访问埋点上报与管理后台聚合统计的单测。

重点覆盖两处容易写错、且错了不会报错只会给出错误数字的地方：
1. 平均停留时长必须按访问量加权（SUM/SUM），不能对各小时桶的平均值再求平均；
2. path 白名单必须真的拦住未知路径，否则表体积失去上界。

Tests for page-view telemetry and the admin-side aggregation.
Focused on the two things that fail silently with wrong numbers rather than
errors: (1) the average must be view-weighted (SUM/SUM), not a mean of
per-bucket means; (2) the path whitelist must actually reject unknown paths,
or the table loses its size bound.
"""
from datetime import datetime, timedelta, timezone

from app.core.security import create_access_token, generate_api_token, hash_api_token
from app.models import PageViewStat, User


def _admin_headers(db):
    admin = User(email="admin@example.com", password_hash="x", api_token=hash_api_token(generate_api_token()), role="admin")
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return {"Authorization": f"Bearer {create_access_token(admin.id)}"}


def test_pageview_accumulates_into_one_hourly_row(client, db, auth_headers):
    """同一小时同一页多次上报只累加一行，不产生明细行。"""
    for _ in range(3):
        res = client.post("/api/telemetry/pageview", headers=auth_headers,
                          json={"path": "/orders", "seconds": 10})
        assert res.status_code == 204

    rows = db.query(PageViewStat).filter(PageViewStat.path == "/orders").all()
    assert len(rows) == 1
    assert rows[0].views == 3
    assert rows[0].total_seconds == 30


def test_pageview_rejects_unknown_path_without_writing(client, db, auth_headers):
    """白名单外的 path 静默忽略：返回 204 但不落库。

    返回 204 是刻意的——埋点失败不该让前端弹错误；但必须确认它真的没写进去，
    否则伪造 path 就能让行数无上界增长。
    """
    res = client.post("/api/telemetry/pageview", headers=auth_headers,
                      json={"path": "/../etc/passwd", "seconds": 5})
    assert res.status_code == 204
    assert db.query(PageViewStat).count() == 0


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
    """没有任何数据时不能因为除零而 500。"""
    body = client.get("/api/admin/page-stats", headers=_admin_headers(db)).json()
    assert body["totalViews"] == 0
    assert body["avgSecondsOverall"] == 0.0
    assert body["pages"] == []


def test_page_stats_requires_admin(client, db, auth_headers):
    assert client.get("/api/admin/page-stats", headers=auth_headers).status_code == 403
