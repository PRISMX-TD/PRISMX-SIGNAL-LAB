"""手机通知「时好时坏」排查（2026-10-24）留下的两处后端修补。

1. 死订阅不再被前端「复活」：派发时 410/404 清掉的行，浏览器那边 getSubscription()
   还会照旧返回（iOS 与多数 Chromium 不发 pushsubscriptionchange）。前端以前每次回前台
   把它原样重报，后端插回去，下次推送再清掉——这台设备永远收不到。现在前端带上
   previously_reported=True，库里没有这一行就回 stale=True、不插回去，前端据此换新订阅。
2. FCM（安卓 App）消息带上与 Web Push 一致的 TTL / 优先级：以前不带 ttl，FCM 默认排队
   4 周，连不上 Google 的设备一连上就把过期信号一股脑弹出来。

Two backend fixes from the 2026-10-24 "mobile notifications are flaky" investigation:
dead subscriptions are no longer resurrected by the frontend's foreground re-report, and
FCM messages carry the same TTL / priority as the Web Push request.
"""
import json
from types import SimpleNamespace

import pytest

from app.models import PushSubscription, User
from app.routers.notifications import PushSubscribeIn, push_subscribe
from app.services import push_dispatch

REAL_P256DH = "B" + "A" * 86
REAL_AUTH = "C" * 22
APPLE_ENDPOINT = "https://web.push.apple.com/QGx-some-device-token"
FCM_TOKEN = "cZx9" + "A" * 60 + ":APA91bH" + "_" * 20 + "-xyz"
FCM_ENDPOINT = push_dispatch.FCM_SCHEME + FCM_TOKEN
PLACEHOLDER = push_dispatch.FCM_PLACEHOLDER_KEY


def _mk_user(db, email="stale@example.com", plan="PRO"):
    user = User(email=email, password_hash="x", api_token=f"tok-{email}", plan=plan)
    db.add(user)
    db.commit()
    return user


def _report(db, user, endpoint, previously_reported, p256dh=REAL_P256DH, auth=REAL_AUTH):
    body = PushSubscribeIn(
        endpoint=endpoint,
        keys={"p256dh": p256dh, "auth": auth},
        previously_reported=previously_reported,
    )
    return push_subscribe(body, db=db, current_user=user)


def _rows(db, user):
    return [r.endpoint for r in db.query(PushSubscription).filter(PushSubscription.user_id == user.id).all()]


# ---------------------------------------------------------------------------
# 1. previously_reported / stale
# ---------------------------------------------------------------------------


def test_old_frontend_without_the_flag_behaves_exactly_as_before(db_session):
    """老前端不带字段：照旧入库、照旧只回 ok。/ Old frontends: unchanged."""
    user = _mk_user(db_session)
    body = PushSubscribeIn(endpoint=APPLE_ENDPOINT, keys={"p256dh": REAL_P256DH, "auth": REAL_AUTH})
    assert body.previously_reported is False
    assert push_subscribe(body, db=db_session, current_user=user) == {"ok": True}
    assert _rows(db_session, user) == [APPLE_ENDPOINT]


def test_first_report_inserts_even_when_flag_false(db_session):
    user = _mk_user(db_session)
    assert _report(db_session, user, APPLE_ENDPOINT, previously_reported=False) == {"ok": True}
    assert _rows(db_session, user) == [APPLE_ENDPOINT]


def test_re_report_of_a_live_row_is_a_plain_refresh(db_session):
    """行还在：照常刷新密钥，不报 stale。/ Row still there: refresh, no stale."""
    user = _mk_user(db_session)
    _report(db_session, user, APPLE_ENDPOINT, previously_reported=False)
    res = _report(db_session, user, APPLE_ENDPOINT, previously_reported=True, p256dh="B" + "D" * 86)
    assert res == {"ok": True}
    row = db_session.query(PushSubscription).filter(PushSubscription.user_id == user.id).one()
    assert row.keys_p256dh == "B" + "D" * 86


def test_pruned_row_is_not_resurrected_and_reports_stale(db_session):
    """派发清掉的行，前端带着 previously_reported 再报：不插回去，回 stale。
    A row pruned by dispatch and re-reported with the flag stays gone; stale=True."""
    user = _mk_user(db_session)
    _report(db_session, user, APPLE_ENDPOINT, previously_reported=False)
    # 派发时推送服务回 410 → 清理 / dispatch got a 410 and pruned it
    db_session.query(PushSubscription).delete()
    db_session.commit()

    res = _report(db_session, user, APPLE_ENDPOINT, previously_reported=True)
    assert res == {"ok": True, "stale": True}
    assert _rows(db_session, user) == [], "死订阅不能被插回去 / the dead row must not come back"


def test_fresh_endpoint_after_stale_is_accepted(db_session):
    """前端换了新订阅（previously_reported=False）照常入库。/ The replacement stores normally."""
    user = _mk_user(db_session)
    assert _report(db_session, user, APPLE_ENDPOINT, previously_reported=True) == {"ok": True, "stale": True}
    fresh = APPLE_ENDPOINT + "-fresh"
    assert _report(db_session, user, fresh, previously_reported=False) == {"ok": True}
    assert _rows(db_session, user) == [fresh]


def test_stale_check_is_per_account(db_session):
    """同一 endpoint 在另一个账号名下存在，不算本账号「还在」。/ Scoped to the caller's account."""
    a = _mk_user(db_session, email="a@example.com")
    b = _mk_user(db_session, email="b@example.com")
    _report(db_session, a, APPLE_ENDPOINT, previously_reported=False)
    assert _report(db_session, b, APPLE_ENDPOINT, previously_reported=True) == {"ok": True, "stale": True}
    assert _rows(db_session, a) == [APPLE_ENDPOINT]
    assert _rows(db_session, b) == []


def test_app_fcm_rows_get_the_same_stale_treatment(db_session):
    """App 的 fcm:// 行（FCM UNREGISTERED 被清）同样回 stale。/ Same for app fcm:// rows."""
    user = _mk_user(db_session)
    res = _report(db_session, user, FCM_ENDPOINT, previously_reported=True, p256dh=PLACEHOLDER, auth=PLACEHOLDER)
    assert res == {"ok": True, "stale": True}
    assert _rows(db_session, user) == []


def test_validation_still_runs_before_the_stale_shortcut(db_session):
    """stale 分支不能成为绕过校验的旁路：非白名单地址照旧 400。
    The stale shortcut must not bypass validation."""
    from fastapi import HTTPException

    user = _mk_user(db_session)
    with pytest.raises(HTTPException) as e:
        _report(db_session, user, "https://evil.example/push", previously_reported=True)
    assert e.value.status_code == 400


# ---------------------------------------------------------------------------
# 2. FCM android ttl / priority
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_fcm_process_state(monkeypatch):
    monkeypatch.setattr(push_dispatch, "_fcm_ctx", None, raising=False)
    monkeypatch.setattr(push_dispatch, "_fcm_warned", set(), raising=False)
    yield
    push_dispatch._fcm_ctx = None
    push_dispatch._fcm_warned = set()


class _FakeHttpClient:
    def __init__(self):
        self.posts = []

    def post(self, url, json=None, headers=None):
        self.posts.append({"url": url, "json": json, "headers": headers})
        return SimpleNamespace(status_code=200, json=lambda: {"name": "projects/p/messages/1"})


def _configure_fcm(monkeypatch):
    client = _FakeHttpClient()
    creds = SimpleNamespace(valid=True, token="ya29.fake", project_id="prismx-app")
    monkeypatch.setattr(push_dispatch, "_fcm_ctx", (creds, client, "prismx-app"), raising=False)
    return client


def _app_sub():
    return SimpleNamespace(id="app-1", endpoint=FCM_ENDPOINT, keys_p256dh=PLACEHOLDER, keys_auth=PLACEHOLDER)


@pytest.mark.parametrize("headers,expected", [
    ({"Urgency": "high", "TTL": "600"}, {"priority": "high", "ttl": "600s"}),
    ({"Urgency": "high", "TTL": "3600"}, {"priority": "high", "ttl": "3600s"}),
    ({"Urgency": "normal", "TTL": "86400"}, {"priority": "normal", "ttl": "86400s"}),
    ({"urgency": "low", "ttl": 60}, {"priority": "normal", "ttl": "60s"}),
    (None, {"priority": "high"}),
    ({"Urgency": "high", "TTL": "garbage"}, {"priority": "high"}),
])
def test_android_options_follow_the_web_push_headers(headers, expected):
    assert push_dispatch._fcm_android_options(headers) == expected


def test_send_one_hands_the_dispatch_headers_to_fcm(monkeypatch):
    """派发循环给的 Urgency / TTL 经 _send_one 一路带进 FCM 消息体。
    The dispatch loop's Urgency / TTL reach the FCM message through _send_one."""
    client = _configure_fcm(monkeypatch)
    payload = json.dumps({"title": "新信号 XAUUSD", "body": "BUY · AIFT"}, ensure_ascii=False)
    assert push_dispatch._send_one(_app_sub(), payload, "pem", {"sub": "mailto:x@y.z"},
                                   {"Urgency": "high", "TTL": "600"}) == (True, False)
    android = client.posts[0]["json"]["message"]["android"]
    assert android == {"priority": "high", "ttl": "600s"}


def test_fcm_one_without_headers_keeps_the_old_shape(monkeypatch):
    """不传头（老调用点）：仍是 priority=high、不设 ttl。/ No headers: the old shape."""
    client = _configure_fcm(monkeypatch)
    assert push_dispatch._fcm_one(_app_sub(), json.dumps({"title": "t", "body": "b"})) == (True, False)
    assert client.posts[0]["json"]["message"]["android"] == {"priority": "high"}
