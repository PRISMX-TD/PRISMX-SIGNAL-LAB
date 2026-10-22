"""推送点开的落点：url 必须在负载**顶层**。

网页 sw.js 的 push 处理只读负载顶层 url（缺省 /app），App 的 pushBridge 也是顶层优先、
data.url 兜底。2026-10-18 文档核对发现测试推送把地址放在嵌套的 data.url、工单回复只带
data.ticketId，网页上点开都落到 /app。

Where a tapped push lands: the url must be top-level in the payload. sw.js only reads the
top-level url (default /app) and the App's pushBridge prefers it over data.url. Found on
2026-10-18: the test push nested it under data.url and ticket replies carried only
data.ticketId, so both landed on /app on the web.
"""
import json
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import sessionmaker

from app.models import NotificationPref, PushSubscription, User
from app.services import push_dispatch as pd


@pytest.fixture()
def push_env(db_session, monkeypatch):
    """接到测试库、拦下真实发送，记录发出去的负载与 WS 兜底的 url。"""
    monkeypatch.setattr(pd, "SessionLocal", sessionmaker(bind=db_session.get_bind(), autoflush=False))
    monkeypatch.setattr(pd, "settings", SimpleNamespace(
        VAPID_SUBJECT="mailto:t@t.local", vapid_private_key="pem", VAPID_PUBLIC_KEY="pub",
    ))
    rec = SimpleNamespace(payloads=[], ws_urls=[])
    monkeypatch.setattr(pd, "_ws_fallback", lambda uids, *a, **k: rec.ws_urls.append(k.get("url")))

    def _fake_send_all(subs, payload, *a, **k):
        rec.payloads.append(json.loads(payload))
        return [(True, False) for _ in subs]

    monkeypatch.setattr(pd, "_send_all", _fake_send_all)
    monkeypatch.setattr(pd, "_prune_subscriptions", lambda ids: None)
    return rec


def _user(db, uid):
    db.add(User(id=uid, email=f"{uid}@t.local", api_token=f"tok-{uid}", plan="PRO"))
    db.add(PushSubscription(user_id=uid, endpoint=f"https://fcm.googleapis.com/x/{uid}",
                            keys_p256dh="p", keys_auth="a"))
    db.commit()


def test_test_push_has_top_level_url(db_session, push_env):
    _user(db_session, "u1")
    result = pd.dispatch_test_push("u1")
    assert result["sent"] == 1
    (payload,) = push_env.payloads
    assert payload["url"] == "/account#notifications"
    # 旧版 App 包只认 data.url，留着 / older App bundles only read data.url
    assert payload["data"]["url"] == "/account#notifications"


def test_ticket_reply_push_deep_links_to_the_ticket(db_session, push_env):
    _user(db_session, "u2")
    pd.dispatch_ticket_reply("tk-123", "u2")
    (payload,) = push_env.payloads
    assert payload["url"] == "/support?ticket=tk-123"
    assert payload["data"]["ticketId"] == "tk-123"
    # WS 兜底（大陆设备那条路）落到同一个地方 / the WS fallback lands on the same page
    assert push_env.ws_urls == ["/support?ticket=tk-123"]


def test_ticket_id_is_url_encoded(db_session, push_env):
    _user(db_session, "u3")
    pd.dispatch_ticket_reply("a&b c", "u3")
    assert push_env.payloads[0]["url"] == "/support?ticket=a%26b%20c"


def test_users_push_puts_url_top_level(db_session, push_env):
    """幸运轮盘发券推送：url 在顶层，WS 兜底落到同一页 / lucky-wheel ticket push, top-level url."""
    _user(db_session, "lw1")
    db_session.add(NotificationPref(user_id="lw1", enabled=True))
    db_session.commit()
    pd.dispatch_users_push(["lw1"], pd.EVENT_LUCKY_WHEEL, "获得抽奖券", "去转一转",
                           url="/lucky", tag="prismx-lucky")
    assert push_env.payloads and push_env.payloads[0]["url"] == "/lucky"
    assert push_env.payloads[0]["tag"] == "prismx-lucky"
    assert push_env.ws_urls == ["/lucky"]
