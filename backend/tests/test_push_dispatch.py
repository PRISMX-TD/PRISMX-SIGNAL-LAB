"""推送派发与诊断接口测试 / push dispatch and diagnostics endpoint tests.

全部 mock pywebpush.webpush，不发真实网络请求。
VAPID 配置由 conftest.py 用假值注入（密钥为空时派发逻辑会提前 return，mock 触达不到）。
All tests mock pywebpush.webpush; no real network calls. VAPID config is
injected with fake values by conftest.py — with empty keys the dispatch logic
returns early and the mock is never reached.
"""
from unittest.mock import patch

from app.models import PushSubscription


def _sub(db, user, endpoint, p256dh="k" * 20, auth="a" * 10):
    s = PushSubscription(user_id=user.id, endpoint=endpoint, keys_p256dh=p256dh, keys_auth=auth)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def test_push_test_endpoint_no_subscription_returns_zero(client, db, user, auth_headers):
    """没有任何订阅时返回 sent=0，而不是报错。
    No subscriptions → sent=0, not an error."""
    user.plan = "PRO"
    db.commit()
    with patch("app.services.push_dispatch.webpush") as mock_push:
        r = client.post("/api/notifications/push/test", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"sent": 0, "failed": 0, "pruned": 0}
    mock_push.assert_not_called()


def test_push_test_endpoint_sends_to_all_subscriptions(client, db, user, auth_headers):
    """向本账号的每个订阅各发一条。/ One push per subscription on the account."""
    user.plan = "PRO"
    db.commit()
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    _sub(db, user, "https://web.push.apple.com/bbb")
    with patch("app.services.push_dispatch.webpush") as mock_push:
        r = client.post("/api/notifications/push/test", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"sent": 2, "failed": 0, "pruned": 0}
    assert mock_push.call_count == 2


def test_push_test_endpoint_ignores_prefs(client, db, user, auth_headers):
    """绕过通知偏好：偏好关闭时测试推送依然发送（这是链路探针，不是业务通知）。
    Bypasses prefs: still sends with notifications disabled — it's a pipeline
    probe, not a business notification."""
    user.plan = "PRO"
    db.commit()
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    # 不创建 NotificationPref，等价于 enabled=False
    with patch("app.services.push_dispatch.webpush") as mock_push:
        r = client.post("/api/notifications/push/test", headers=auth_headers)
    assert r.json()["sent"] == 1
    assert mock_push.call_count == 1


def test_push_test_endpoint_rejects_free_plan(client, db, user, auth_headers):
    """保留订阅等级检查，FREE 不得借此绕过付费边界。
    Plan check retained: FREE must not bypass the paywall through this."""
    user.plan = "FREE"
    db.commit()
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    with patch("app.services.push_dispatch.webpush") as mock_push:
        r = client.post("/api/notifications/push/test", headers=auth_headers)
    assert r.status_code == 403
    mock_push.assert_not_called()


def test_push_status_reports_count_and_current_endpoint(client, db, user, auth_headers):
    """订阅数与"当前 endpoint 是否在库"分别可查。
    Subscription count and whether the given endpoint is registered."""
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    _sub(db, user, "https://web.push.apple.com/bbb")

    r = client.get(
        "/api/notifications/push/status",
        params={"endpoint": "https://web.push.apple.com/bbb"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json() == {"count": 2, "current_endpoint_registered": True}

    r = client.get(
        "/api/notifications/push/status",
        params={"endpoint": "https://fcm.googleapis.com/fcm/send/zzz"},
        headers=auth_headers,
    )
    assert r.json() == {"count": 2, "current_endpoint_registered": False}


def test_push_status_without_endpoint_param(client, db, user, auth_headers):
    """endpoint 参数可选，未传时 current_endpoint_registered 为 False。
    The endpoint param is optional; absent → False."""
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    r = client.get("/api/notifications/push/status", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"count": 1, "current_endpoint_registered": False}
