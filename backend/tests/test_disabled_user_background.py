"""被管理员停用的账号（users.disabled_at 非空）在后台路径上的处理。

规则：停用账号不收任何推送（信号 Web Push / FCM、事件推送、WS 兜底、信号广播、
工单回复推送），其个人策略不再触发新信号；已有仓位不动，自动仓管照常保护；
恢复（清空 disabled_at）后立即照旧；正常用户不受影响。

Admin-disabled accounts on the background paths: no push of any kind, no new
strategy signals; existing positions untouched and auto-manage keeps protecting
them; re-enabling restores everything; normal users are unaffected.
"""
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import sessionmaker

from app.models import (
    Candle,
    NotificationPref,
    Order,
    PushSubscription,
    StrategySignal,
    StrategyWatch,
    User,
    UserStrategy,
)
from app.services import push_dispatch as pd

CAT = "MA5/MA20 金叉"
SYM = "XAUUSD"


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _user(db, uid, *, disabled=False, plan="PRO", sub=True):
    u = User(id=uid, email=f"{uid}@t.local", api_token=f"tok-{uid}", plan=plan,
             disabled_at=_now() if disabled else None)
    db.add(u)
    db.add(NotificationPref(user_id=uid, enabled=True, event_types=None,
                            selected_categories=json.dumps([CAT]),
                            selected_symbols=json.dumps([SYM])))
    if sub:
        db.add(PushSubscription(user_id=uid, endpoint=f"https://fcm.googleapis.com/x/{uid}",
                                keys_p256dh="p", keys_auth="a"))
    db.commit()
    return u


def _set_disabled(db, uid, disabled: bool):
    u = db.get(User, uid)
    u.disabled_at = _now() if disabled else None
    db.commit()


@pytest.fixture()
def push_env(db_session, monkeypatch):
    """把推送派发接到测试库上，拦下真实发送，记录 WS 兜底与实际发出的订阅。"""
    monkeypatch.setattr(pd, "SessionLocal", sessionmaker(bind=db_session.get_bind(), autoflush=False))
    monkeypatch.setattr(pd, "settings", SimpleNamespace(
        VAPID_SUBJECT="mailto:t@t.local", vapid_private_key="pem",
        VAPID_PUBLIC_KEY="pub", SIGNAL_EXPIRE_MINUTES=5,
    ))
    rec = SimpleNamespace(ws=[], sent=[])
    monkeypatch.setattr(pd, "_ws_fallback", lambda uids, *a, **k: rec.ws.append(sorted(set(uids))))

    def _fake_send_all(subs, *a, **k):
        rec.sent.append(sorted(s.user_id for s in subs))
        return [(True, False) for _ in subs]

    monkeypatch.setattr(pd, "_send_all", _fake_send_all)
    monkeypatch.setattr(pd, "_prune_subscriptions", lambda ids: None)
    return rec


# ---------------------------------------------------------------------------
# 信号推送 / signal push
# ---------------------------------------------------------------------------

def test_signal_push_skips_disabled_and_resumes_after_enable(db_session, push_env):
    _user(db_session, "ok")
    _user(db_session, "off", disabled=True)
    sig = SimpleNamespace(indicator=CAT, symbol=SYM, side="BUY")

    pd.dispatch_push(sig)
    assert push_env.ws == [["ok"]]
    assert push_env.sent == [["ok"]]

    _set_disabled(db_session, "off", False)
    pd.dispatch_push(sig)
    assert push_env.ws[-1] == ["off", "ok"]
    assert push_env.sent[-1] == ["off", "ok"]


def test_matched_user_ids_filters_disabled_in_query(db_session):
    _user(db_session, "ok")
    _user(db_session, "off", disabled=True)
    _user(db_session, "free", plan="FREE")
    assert pd._matched_user_ids(db_session, CAT, SYM) == {"ok"}


# ---------------------------------------------------------------------------
# 事件推送（账户 / 自动仓管 / 成就 / 掉线都走这里）/ event push
# ---------------------------------------------------------------------------

def test_event_push_skips_disabled_user(db_session, push_env):
    _user(db_session, "off", disabled=True)
    pd.dispatch_event_push("off", pd.EVENT_AUTO_MANAGE, "t", "b")
    assert push_env.ws == [] and push_env.sent == []

    _set_disabled(db_session, "off", False)
    pd.dispatch_event_push("off", pd.EVENT_AUTO_MANAGE, "t", "b")
    assert push_env.ws == [["off"]] and push_env.sent == [["off"]]


def test_event_push_normal_user_unaffected(db_session, push_env):
    _user(db_session, "ok")
    pd.dispatch_event_push("ok", pd.EVENT_STRATEGY_SIGNAL, "t", "b")
    assert push_env.ws == [["ok"]] and push_env.sent == [["ok"]]


def test_event_prefs_allow_and_bulk_agree_on_disabled(db_session):
    _user(db_session, "ok")
    _user(db_session, "off", disabled=True)
    assert pd._event_prefs_allow(db_session, "ok", pd.EVENT_ANNOUNCEMENT)
    assert not pd._event_prefs_allow(db_session, "off", pd.EVENT_ANNOUNCEMENT)
    assert pd._bulk_prefs_allow(db_session, ["ok", "off"], pd.EVENT_ANNOUNCEMENT) == ["ok"]
    assert not pd._event_prefs_allow(db_session, "ghost", pd.EVENT_ANNOUNCEMENT)


def test_announcement_push_skips_disabled(db_session, push_env, monkeypatch):
    _user(db_session, "ok")
    _user(db_session, "off", disabled=True)
    monkeypatch.setattr(pd, "_online_user_ids", lambda: {"ok", "off"})
    pd.dispatch_announcement_push("a1", "t", "b")
    assert push_env.ws == [["ok"]]
    assert push_env.sent == [["ok"]]


def test_ticket_reply_push_skips_disabled(db_session, push_env):
    _user(db_session, "off", disabled=True)
    pd.dispatch_ticket_reply("t1", "off", "admin@t.local")
    assert push_env.ws == [] and push_env.sent == []

    _set_disabled(db_session, "off", False)
    pd.dispatch_ticket_reply("t1", "off", "admin@t.local")
    assert push_env.ws == [["off"]] and push_env.sent == [["off"]]


# ---------------------------------------------------------------------------
# 信号 WS 广播 / signal WS broadcast
# ---------------------------------------------------------------------------

def test_signal_broadcast_targets_exclude_disabled(db_session, monkeypatch):
    from app.services import signal_broadcast as sb

    monkeypatch.setattr(sb, "SessionLocal", sessionmaker(bind=db_session.get_bind(), autoflush=False))
    _user(db_session, "ok")
    _user(db_session, "off", disabled=True)
    _user(db_session, "free", plan="FREE")
    _user(db_session, "free_off", plan="FREE", disabled=True)
    online = ["ok", "off", "free", "free_off"]
    now = _now()
    assert sb._plan_group_user_ids(online, False, now) == ["ok"]
    assert sb._plan_group_user_ids(online, True, now) == ["free"]

    _set_disabled(db_session, "off", False)
    assert sorted(sb._plan_group_user_ids(online, False, now)) == ["off", "ok"]


# ---------------------------------------------------------------------------
# 个人策略 / personal strategies
# ---------------------------------------------------------------------------

def _cross_bars(n_flat=30, jump=10.0):
    base = 1_700_000_000
    bars = [{"t": base + i * 3600, "o": 100, "h": 100.5, "l": 99.5, "c": 100} for i in range(n_flat)]
    t = base + n_flat * 3600
    bars.append({"t": t, "o": 100, "h": 100 + jump + 0.5, "l": 99.5, "c": 100 + jump})
    return bars


def test_strategy_of_disabled_user_fires_no_new_signal(db_session, monkeypatch):
    from app.services.strategy import live

    monkeypatch.setattr(live, "SessionLocal", sessionmaker(bind=db_session.get_bind(), autoflush=False))
    rules = {"logic": "AND", "interval": "60", "symbol": SYM, "conditions": [
        {"indicator": "ma", "usage": "ma.price_cross_above", "params": {"period": 5}}]}
    for uid, disabled in (("ok", False), ("off", True)):
        _user(db_session, uid, disabled=disabled)
        s = UserStrategy(user_id=uid, name=uid, symbol=SYM, interval="60",
                         rules=json.dumps(rules), enabled=True,
                         stop_loss_method="percent", stop_loss_value=1.0,
                         take_profit_method="rr", take_profit_value=1.0)
        db_session.add(s)
        db_session.commit()
        db_session.add(StrategyWatch(strategy_id=s.id, symbol=SYM, interval="60"))
    for b in _cross_bars():
        db_session.add(Candle(symbol=SYM, interval="60", t=b["t"], o=b["o"], h=b["h"],
                              l=b["l"], c=b["c"], v=1))
    db_session.commit()

    pushes = live._evaluate_sync(SYM, "60")
    assert [p[0] for p in pushes] == ["ok"]
    db_session.expire_all()
    assert {s.user_id for s in db_session.query(StrategySignal).all()} == {"ok"}


# ---------------------------------------------------------------------------
# 自动仓管对停用账号照常工作 / auto-manage still protects a disabled account
# ---------------------------------------------------------------------------

def test_auto_manage_still_runs_for_disabled_user(db_session, monkeypatch):
    from app.models import AutoManageSettings, MT5Account
    from app.services import auto_manage, gateway_execute

    uid = "am-off"
    db_session.add(User(id=uid, email="am@t.local", api_token="tok-am", plan="PRO",
                        disabled_at=_now()))
    db_session.add(MT5Account(user_id=uid, login="600144", server="", source="bridge"))
    db_session.add(AutoManageSettings(user_id=uid, enabled=True, be_enabled=True,
                                      be_trigger_r=1.0, trail_enabled=False, ptp_enabled=False))
    db_session.add(Order(user_id=uid, client_order_id="open-1", action="ORDER", status="FILLED",
                         symbol="XAUUSD.s", side="BUY", volume=1.0, mt5_login="600144",
                         mt5_ticket=111, mt5_position=111))
    db_session.commit()
    auto_manage.invalidate_eligibility(uid)
    monkeypatch.setattr(gateway_execute, "try_gateway_execute", lambda db, o: None)
    pushed = []
    monkeypatch.setattr(auto_manage, "dispatch_event_push", lambda *a, **k: pushed.append(a))

    position = {"ticket": 111, "symbol": "XAUUSD.s", "side": "BUY", "volume": 1.0,
                "profit": 100.0, "entryPrice": 4000.0, "currentPrice": 4010.0,
                "stopLoss": 3990.0, "takeProfit": 0.0, "login": "600144"}
    created = auto_manage.evaluate_positions(db_session, uid, [position])

    assert created == 1
    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.sl == pytest.approx(4000.0)
    # 通知仍经 dispatch_event_push 发起，由其内部判定按停用拦下（见上面的事件推送用例）。
    assert pushed and pushed[0][0] == uid
