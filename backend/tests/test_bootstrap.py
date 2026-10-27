"""/api/bootstrap：各段与单独接口逐字相同；一段失败只置空该段并列入 failed。
Each section equals its standalone endpoint; a failing section is null and listed."""
import asyncio

import pytest

from app.models import MT5Account, Signal, User
from app.routers import bootstrap as bs
from app.routers import bridge, signals, trends


@pytest.fixture(autouse=True)
def _inline_threadpool(monkeypatch):
    async def _inline(fn, *a, **k):        # 内存 SQLite 不能跨线程 / in-memory SQLite is per-thread
        return fn(*a, **k)
    monkeypatch.setattr(bs, "run_in_threadpool", _inline)


def _seed(db):
    u = User(email="bs@t.co", api_token="tok_bs", plan="pro")
    db.add(u)
    db.commit()
    db.add(MT5Account(user_id=u.id, login="1001", server="s", balance=100.0))
    db.commit()
    return u


def _quotes_async(monkeypatch, quotes, symbols):
    async def _q():
        return quotes

    async def _s():
        return symbols

    monkeypatch.setattr(bs.quotes_store, "get_all_async", _q)
    monkeypatch.setattr(bs.quotes_store, "get_active_symbols_async", _s)


def test_bootstrap_sections_match_standalone_endpoints(db_session, monkeypatch):
    u = _seed(db_session)
    _quotes_async(monkeypatch, [{"symbol": "XAUUSD"}], ["XAUUSD"])
    out = asyncio.run(bs.get_bootstrap(user=u, db=db_session))
    assert out["failed"] == []
    assert out["signals"] == signals.list_signals(user=u, db=db_session)
    assert out["accounts"] == bridge.list_accounts(user=u, db=db_session)
    assert out["accounts"]["accounts"][0]["login"] == "1001"
    assert out["trends"] == trends.list_trends(user=u, db=db_session)
    assert out["quotes"] == {"quotes": [{"symbol": "XAUUSD"}]}
    assert out["symbols"] == {"symbols": ["XAUUSD"]}


def test_bootstrap_partial_failure_nulls_only_that_section(db_session, monkeypatch):
    u = _seed(db_session)
    _quotes_async(monkeypatch, [], [])

    def _boom(**kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(bs.trends_router, "list_trends", _boom)
    out = asyncio.run(bs.get_bootstrap(user=u, db=db_session))
    assert out["trends"] is None and out["failed"] == ["trends"]
    assert out["accounts"]["accounts"] and out["signals"] == {"signals": []}


# ---- ?extras=1：首屏其它组件的请求一并算好（2026-10-11）----

def test_without_flag_response_is_unchanged(db_session, monkeypatch):
    u = _seed(db_session)
    _quotes_async(monkeypatch, [], [])
    out = asyncio.run(bs.get_bootstrap(user=u, db=db_session))
    assert "extras" not in out, "旧前端不带参数，响应必须与以前一样"


def test_extras_match_standalone_endpoints(db_session, monkeypatch):
    from fastapi.encoders import jsonable_encoder

    from app.routers import account, announcements, notifications, orders, sentiment
    from app.schemas import NotificationFeedOut

    u = _seed(db_session)
    _quotes_async(monkeypatch, [], [])
    out = asyncio.run(bs.get_bootstrap(extras=True, user=u, db=db_session))
    ex = out["extras"]
    assert set(ex) == {
        "/orders", "/auth/me", "/orders/winrate",
        "/announcements/popup", "/notifications/feed?limit=4", "/sentiment",
        "/notifications/prefs", "/announcements", "/site/social", "/signals/strategy-analysis",
    }
    assert ex["/orders"] == jsonable_encoder(orders.list_orders(
        limit=100, offset=0, since=None, until=None, login=None, user=u, db=db_session))
    assert ex["/orders/winrate"] == jsonable_encoder(orders.order_winrate(login=None, user=u, db=db_session))
    me = account.get_account(db=db_session, current_user=u)
    assert ex["/auth/me"] == jsonable_encoder(account.AccountInfoOut.model_validate(me) if not isinstance(me, account.AccountInfoOut) else me)
    assert ex["/auth/me"]["email"] == "bs@t.co"
    feed = notifications.notification_feed(limit=4, db=db_session, current_user=u)
    assert ex["/notifications/feed?limit=4"] == jsonable_encoder(NotificationFeedOut.model_validate(feed) if not isinstance(feed, NotificationFeedOut) else feed)
    assert ex["/announcements/popup"] == jsonable_encoder(announcements.get_popup_announcement(db=db_session, user=u))
    assert ex["/sentiment"] == jsonable_encoder(sentiment.get_sentiment(user_id=u.id))
    from app.routers import site
    from app.schemas import AdminStrategyWinRateOut, AnnouncementListOut
    prefs = notifications.get_prefs(db=db_session, current_user=u)
    assert ex["/notifications/prefs"] == jsonable_encoder(notifications.NotificationPrefsOut.model_validate(prefs) if not isinstance(prefs, notifications.NotificationPrefsOut) else prefs)
    ann = announcements.list_announcements(db=db_session, user=u, limit=100)
    assert ex["/announcements"] == jsonable_encoder(AnnouncementListOut.model_validate(ann) if not isinstance(ann, AnnouncementListOut) else ann)
    assert ex["/site/social"] == jsonable_encoder(site.get_social_links(db=db_session))
    sa = signals.strategy_analysis(_user=u, db=db_session)
    assert ex["/signals/strategy-analysis"] == jsonable_encoder(AdminStrategyWinRateOut.model_validate(sa) if not isinstance(sa, AdminStrategyWinRateOut) else sa)


def test_extras_failure_only_drops_that_entry(db_session, monkeypatch):
    u = _seed(db_session)
    _quotes_async(monkeypatch, [], [])

    def _boom(**kw):
        raise RuntimeError("boom")

    from app.routers import announcements
    monkeypatch.setattr(announcements, "get_popup_announcement", _boom)
    out = asyncio.run(bs.get_bootstrap(extras=True, user=u, db=db_session))
    assert "/announcements/popup" not in out["extras"], "失败的那份不放进来，前端照常单独请求"
    assert "/orders" in out["extras"] and out["failed"] == []
