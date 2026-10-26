"""2026-10-26 审计 C 组：推送。

· endpoint 白名单与真正发请求的 urllib3 对主机的判断必须一致：反斜杠、userinfo、端口、
  空白 / 控制 / 非 ASCII 一律拒绝；pywebpush 用不跟随重定向的会话。
· 推送权益看到期时间：已过期、还没被清扫改成 FREE 的付费行不再收新信号 / 事件推送。
不发任何真实网络请求：HTTP 适配器被替换成记录器。

2026-10-26 audit, group C: push — the endpoint allowlist must agree with urllib3 on
the host, redirects are never followed, and push entitlement honours plan expiry.
No real network calls: the HTTP adapter is replaced by a recorder.
"""
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import requests
from sqlalchemy.orm import sessionmaker

from app.models import NotificationPref, PushSubscription, Signal, User
from app.services import push_dispatch as pd
from app.services.plans import can_use_push
from app.utils.indicator import indicator_category

BACKSLASH_EP = "https://attacker.example\\@fcm.googleapis.com/x"


# ---------------------------------------------------------------------------
# 1. 白名单与 urllib3 一致 / allowlist agrees with urllib3
# ---------------------------------------------------------------------------

def test_backslash_authority_is_rejected():
    from urllib3.util import parse_url

    # 前提：两个解析器在这条 URL 上确实分歧
    assert parse_url(BACKSLASH_EP).host == "attacker.example"
    assert not pd.is_allowed_push_endpoint(BACKSLASH_EP)


@pytest.mark.parametrize("endpoint", [
    "https://attacker.example\\@fcm.googleapis.com/x",
    "https://attacker.example\\.fcm.googleapis.com/x",
    "https://127.0.0.1:9\\@fcm.googleapis.com/x",
    "https://u:p@fcm.googleapis.com/x",                 # userinfo
    "https://@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",               # 显式端口
    "https://fcm.googleapis.com:443/x",
    "https://fcm.googleapis.com/x y",                  # 空白
    "https://fcm.googleapis.com/x\ty",
    "https://fcm.googleapis.com/x\r\nHost: evil",       # 控制字符
    "https://fcm.googleapis.com/é",               # 非 ASCII
    "https://fcm.googleapis.com。attacker.example/x",
    " https://fcm.googleapis.com/x",
])
def test_parser_differential_forms_are_rejected(endpoint):
    assert not pd.is_allowed_push_endpoint(endpoint)


@pytest.mark.parametrize("endpoint", [
    "https://fcm.googleapis.com/fcm/send/abc123:APA91b-_xyz",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk-abc_def=",
    "https://web.push.apple.com/QGx-abc_123",
    "https://xyz.notify.windows.com/w/?token=abc%2Bdef",
])
def test_real_endpoints_still_pass(endpoint):
    assert pd.is_allowed_push_endpoint(endpoint)


class _Recorder:
    """替换 requests 的 HTTPAdapter.send：记录 URL，按脚本回应，绝不出网。"""

    def __init__(self, statuses):
        self.urls: list[str] = []
        self._statuses = list(statuses)

    def __call__(self, adapter, request, **kwargs):
        self.urls.append(request.url)
        status, headers = self._statuses.pop(0) if self._statuses else (201, {})
        resp = requests.Response()
        resp.status_code = status
        resp.headers.update(headers)
        resp.url = request.url
        resp.request = request
        resp._content = b""
        return resp


def _patch_adapter(monkeypatch, rec):
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send",
                        lambda self, request, **kw: rec(self, request, **kw))


def _vapid_pem() -> str:
    """py_vapid.from_string 认的格式：去掉头尾的 base64url DER。"""
    import base64

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    der = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    return base64.urlsafe_b64encode(der).decode().rstrip("=")


def _browser_keys() -> tuple[str, str]:
    import base64
    import os

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    pub = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")  # noqa: E731
    return b64(pub), b64(os.urandom(16))


def _sub(endpoint):
    p256dh, auth = _browser_keys()
    return SimpleNamespace(id="s1", endpoint=endpoint, keys_p256dh=p256dh, keys_auth=auth)


def test_stored_backslash_row_is_pruned_without_any_request(monkeypatch):
    rec = _Recorder([])
    _patch_adapter(monkeypatch, rec)
    ok, prune = pd._webpush_one(_sub(BACKSLASH_EP), "{}", _vapid_pem(),
                                {"sub": "mailto:t@t.local"}, {"TTL": "60"})
    assert (ok, prune) == (False, True)
    assert rec.urls == []


def test_redirects_are_not_followed(monkeypatch):
    """推送服务回 302 指向内网：不跟随，只发出那一个请求。"""
    rec = _Recorder([(302, {"Location": "http://127.0.0.1:9/"})])
    _patch_adapter(monkeypatch, rec)
    ok, prune = pd._webpush_one(_sub("https://fcm.googleapis.com/fcm/send/abc"), "{}", _vapid_pem(),
                                {"sub": "mailto:t@t.local"}, {"TTL": "60"})
    assert ok is False and prune is False
    assert len(rec.urls) == 1 and rec.urls[0].startswith("https://fcm.googleapis.com/")
    assert not any("127.0.0.1" in u for u in rec.urls)


def test_normal_delivery_still_goes_to_the_push_service(monkeypatch):
    rec = _Recorder([(201, {})])
    _patch_adapter(monkeypatch, rec)
    ok, prune = pd._webpush_one(_sub("https://fcm.googleapis.com/fcm/send/abc"), "{}", _vapid_pem(),
                                {"sub": "mailto:t@t.local"}, {"TTL": "60"})
    assert (ok, prune) == (True, False)
    assert rec.urls == ["https://fcm.googleapis.com/fcm/send/abc"]


def test_subscribe_route_rejects_backslash_endpoint(db_session):
    from fastapi import HTTPException

    from app.routers.notifications import PushSubscribeIn, push_subscribe

    user = User(email="p@example.com", api_token="tok-p", plan="PRO")
    db_session.add(user)
    db_session.commit()
    p256dh, auth = _browser_keys()
    with pytest.raises(HTTPException) as exc:
        push_subscribe(body=PushSubscribeIn(endpoint=BACKSLASH_EP, keys={"p256dh": p256dh, "auth": auth}),
                       db=db_session, current_user=user)
    assert exc.value.status_code == 400
    assert db_session.query(PushSubscription).count() == 0


# ---------------------------------------------------------------------------
# 2. 推送权益看到期时间 / push entitlement honours plan expiry
# ---------------------------------------------------------------------------

def _now():
    return datetime.now(timezone.utc)


def test_can_use_push_honours_expiry():
    now = _now()
    assert can_use_push("PRO")
    assert not can_use_push("FREE")
    assert can_use_push("PRO", now + timedelta(days=1), now)
    assert can_use_push("PRO", None, now)               # 永久
    assert not can_use_push("PRO", now - timedelta(minutes=1), now)
    # naive（SQLite 读回来的）按 UTC 处理
    assert not can_use_push("PRO", (now - timedelta(minutes=1)).replace(tzinfo=None), now)


CAT_IND = "AIFT"


@pytest.fixture()
def push_env(db_session, monkeypatch):
    monkeypatch.setattr(pd, "SessionLocal", sessionmaker(bind=db_session.get_bind(), autoflush=False))
    monkeypatch.setattr(pd, "settings", SimpleNamespace(
        VAPID_SUBJECT="mailto:t@t.local", vapid_private_key="pem",
        VAPID_PUBLIC_KEY="pub", SIGNAL_EXPIRE_MINUTES=10,
    ))
    rec = SimpleNamespace(ws=[], sent=[])
    monkeypatch.setattr(pd, "_ws_fallback", lambda uids, *a, **k: rec.ws.extend(uids))

    def _send_all(subs, *a, **k):
        rec.sent.extend(s.user_id for s in subs)
        return [(True, False) for _ in subs]

    monkeypatch.setattr(pd, "_send_all", _send_all)
    monkeypatch.setattr(pd, "_prune_subscriptions", lambda ids: None)
    return rec


def _push_user(db, uid, expires_at):
    db.add(User(id=uid, email=f"{uid}@t.local", api_token=f"tok-{uid}", plan="PRO",
                plan_expires_at=expires_at))
    db.add(NotificationPref(user_id=uid, enabled=True, event_types=None,
                            selected_categories=json.dumps(["__ALL__"]),
                            selected_symbols=json.dumps(["__ALL__"])))
    db.add(PushSubscription(user_id=uid, endpoint=f"https://fcm.googleapis.com/x/{uid}",
                            keys_p256dh="p", keys_auth="a"))
    db.commit()


def test_signal_push_skips_expired_but_unswept_plan(db_session, push_env):
    _push_user(db_session, "lapsed", _now() - timedelta(minutes=1))
    _push_user(db_session, "active", _now() + timedelta(days=1))

    ids = pd._matched_user_ids(db_session, indicator_category(CAT_IND), "XAUUSD")
    assert ids == {"active"}

    pd.dispatch_push(Signal(symbol="XAUUSD", side="BUY", indicator=CAT_IND))
    assert "lapsed" not in push_env.sent and "lapsed" not in push_env.ws
    assert "active" in push_env.sent


def test_event_push_skips_expired_but_unswept_plan(db_session, push_env):
    _push_user(db_session, "lapsed", _now() - timedelta(minutes=1))
    _push_user(db_session, "active", _now() + timedelta(days=1))

    pd.dispatch_event_push("lapsed", pd.EVENT_ORDER_REJECTED, "t", "b")
    pd.dispatch_event_push("active", pd.EVENT_ORDER_REJECTED, "t", "b")
    assert push_env.sent == ["active"]

    assert pd._bulk_prefs_allow(db_session, ["lapsed", "active"], pd.EVENT_ORDER_REJECTED) == ["active"]
