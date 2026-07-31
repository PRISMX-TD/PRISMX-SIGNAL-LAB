"""推送派发与诊断接口测试 / push dispatch and diagnostics endpoint tests.

全部 mock pywebpush.webpush，不发真实网络请求。
VAPID 配置由 conftest.py 用假值注入（密钥为空时派发逻辑会提前 return，mock 触达不到）。
All tests mock pywebpush.webpush; no real network calls. VAPID config is
injected with fake values by conftest.py — with empty keys the dispatch logic
returns early and the mock is never reached.
"""
from unittest.mock import patch

from app.models import PushSubscription
from app.services.push_dispatch import (
    ALL_SENTINEL,
    EVENT_ORDER_FILLED,
    dispatch_event_push,
    dispatch_push,
)
from tests.conftest import make_signal


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


# ---------- 派发逻辑 / dispatch logic ----------


def _pref(db, user, enabled=True, cats=None, syms=None, events=None):
    """造一行通知偏好。白名单以 JSON 文本存储。
    Create a notification-prefs row; whitelists are stored as JSON text."""
    import json

    from app.models import NotificationPref

    p = NotificationPref(
        user_id=user.id,
        enabled=enabled,
        selected_categories=json.dumps(cats if cats is not None else [ALL_SENTINEL]),
        selected_symbols=json.dumps(syms if syms is not None else [ALL_SENTINEL]),
        event_types=json.dumps(events if events is not None else []),
    )
    db.add(p)
    db.commit()
    return p


def test_vapid_claims_not_shared_across_subscriptions(db, user):
    """每个订阅必须拿到独立的 vapid_claims 字典。

    pywebpush 会把 aud（按 endpoint 的推送服务域名推导）原地写进传入的 claims
    字典且此后不再覆盖。复用同一个字典时，第一个订阅落在哪家推送服务，aud 就
    永远是哪家，后续其它服务的订阅全部 403 BadJwtToken——而 403 不在清理名单里，
    会一直静默失败。典型触发场景：用户同时有桌面 Chrome 与 iPhone。
    该 bug 已在生产日志中实锤，此测试钉死修复。

    Each subscription must get its own vapid_claims dict. pywebpush writes aud
    (derived from the endpoint's push-service origin) into the caller's dict in
    place and never overwrites it, so reusing one dict across a loop pins aud to
    whichever service came first — every later subscription on another service
    gets 403 BadJwtToken, and 403 isn't pruned, so it fails silently forever.
    Confirmed in production logs; this test nails the fix down.
    """
    user.plan = "PRO"
    db.commit()
    _pref(db, user)
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    _sub(db, user, "https://web.push.apple.com/bbb")
    sig = make_signal(db)

    seen = []

    def fake_webpush(**kwargs):
        # 记录对象身份，而不是内容——内容此刻还都是 {"sub": ...}，
        # 真正的问题是"同一个对象被复用"。
        # Record object identity rather than contents: contents are still just
        # {"sub": ...} at this point; the bug is the object being reused.
        seen.append(id(kwargs["vapid_claims"]))

    with patch("app.services.push_dispatch.webpush", side_effect=fake_webpush):
        dispatch_push(sig)

    assert len(seen) == 2
    assert seen[0] != seen[1], "vapid_claims 字典在订阅之间被复用了 / dict reused across subscriptions"


def test_symbol_whitelist_anded_with_category(db, user):
    """类别与品种是两条独立白名单，按"与"关系联合：只命中一边不推送。
    Category and symbol are independent whitelists ANDed together: matching
    only one side sends nothing."""
    user.plan = "PRO"
    db.commit()
    # 品种白名单只放 EURUSD，信号是 XAUUSD
    _pref(db, user, cats=[ALL_SENTINEL], syms=["EURUSD"])
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    sig = make_signal(db, symbol="XAUUSD")

    with patch("app.services.push_dispatch.webpush") as mock_push:
        dispatch_push(sig)

    mock_push.assert_not_called()


def test_all_sentinel_matches_any_symbol(db, user):
    """哨兵值放行任意品种，包括此刻还不存在、以后才出现的。
    The sentinel admits any symbol, including ones that don't exist yet."""
    user.plan = "PRO"
    db.commit()
    _pref(db, user, cats=[ALL_SENTINEL], syms=[ALL_SENTINEL])
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    sig = make_signal(db, symbol="SOMETHINGNEW")

    with patch("app.services.push_dispatch.webpush") as mock_push:
        dispatch_push(sig)

    assert mock_push.call_count == 1


def test_free_plan_filtered_even_with_enabled_pref(db, user):
    """降级为 FREE 的账号即使残留 enabled=True 也不推送。

    偏好行的 enabled 不会因降级自动清空。新信号此刻仍是 ACTIVE，FREE 要等它过期
    后才能在 REST/WS 里看到——若这里不同步过滤，一个曾开过推送、后被降级的账号
    会靠推送绕过延迟机制提前拿到信号。

    A downgraded FREE account must not receive pushes even with a leftover
    enabled=True: the pref row isn't cleared on downgrade, and since the signal
    is still ACTIVE, FREE would otherwise bypass the delay it's supposed to have.
    """
    user.plan = "FREE"
    db.commit()
    _pref(db, user, enabled=True)
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    sig = make_signal(db)

    with patch("app.services.push_dispatch.webpush") as mock_push:
        dispatch_push(sig)

    mock_push.assert_not_called()


def test_410_prunes_subscription_but_403_does_not(db, user):
    """410/404 表示订阅已失效，应清理；403 可能是配置或 JWT 问题，不能清理
    ——把 403 也当失效会在密钥配错时把全部订阅删光。
    410/404 mean the subscription is gone and should be pruned; 403 may be a
    config or JWT issue and must not be — pruning on 403 would wipe every
    subscription the moment a key is misconfigured."""
    from pywebpush import WebPushException

    user.plan = "PRO"
    db.commit()
    _pref(db, user)
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/gone")
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/forbidden")
    sig = make_signal(db)

    def fake_webpush(**kwargs):
        # 按 endpoint 分别模拟 410 与 403
        # Simulate 410 vs 403 per endpoint
        class _Resp:
            def __init__(self, code):
                self.status_code = code
                self.text = f"status {code}"

        if "gone" in kwargs["subscription_info"]["endpoint"]:
            raise WebPushException("gone", response=_Resp(410))
        raise WebPushException("forbidden", response=_Resp(403))

    with patch("app.services.push_dispatch.webpush", side_effect=fake_webpush):
        dispatch_push(sig)

    from app.models import PushSubscription

    remaining = [s.endpoint for s in db.query(PushSubscription).filter(PushSubscription.user_id == user.id).all()]
    assert not any("gone" in e for e in remaining), "410 的订阅应被清理 / 410 should be pruned"
    assert any("forbidden" in e for e in remaining), "403 的订阅不该被清理 / 403 must not be pruned"


def test_event_push_respects_event_type_whitelist(db, user):
    """事件类通知走独立的 event_types 白名单，未勾选的事件类型不推送。
    Event notifications use the separate event_types whitelist; unchecked types
    are not sent."""
    user.plan = "PRO"
    db.commit()
    # 白名单为空，即什么事件都不要
    _pref(db, user, events=[])
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")

    with patch("app.services.push_dispatch.webpush") as mock_push:
        dispatch_event_push(user.id, EVENT_ORDER_FILLED, "标题 / Title", "正文 / Body")

    mock_push.assert_not_called()
