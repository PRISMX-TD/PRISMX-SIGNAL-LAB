"""自定义策略 API 的端到端测试：**当前所有端点都是 require_admin**（功能内部
试用中，见 routers/strategies.py 顶部说明）、PRO 专属门槛、每用户数量上限、
CRUD、回测端点、我的策略信号列表，以及"新 K 线收盘时自动评估已启用策略"这条
实时链路（该链路走 /feed/candles，与 require_admin 无关，鉴权是 EA Token）。

End-to-end tests for the custom-strategy API: **every endpoint is currently
require_admin** (the feature is in internal trial, see the header comment in
routers/strategies.py), the PRO-exclusive gate, the per-user strategy count
limit, CRUD, the backtest endpoint, the "my strategy signals" list, and the
live "evaluate enabled strategies whenever a bar closes" path (that path goes
through /feed/candles, which is EA-Token-authenticated and unrelated to
require_admin).
"""
from datetime import datetime, timedelta, timezone

from app.core.config import settings
from app.models import Candle, StrategySignal, UserStrategy
import app.services.strategy_engine as strategy_engine


def _make_pro(db, user):
    user.plan = "PRO"
    db.add(user)
    db.commit()


def _make_admin(db, user):
    user.role = "admin"
    db.add(user)
    db.commit()


def _make_admin_pro(db, user):
    user.role = "admin"
    user.plan = "PRO"
    db.add(user)
    db.commit()


def test_non_admin_blocked_regardless_of_plan(client, db, auth_headers, user):
    """非管理员一律拿不到,即便已经是 PRO——功能先内部试用,管理员门槛在 PRO
    门槛之前。Non-admins are refused regardless of plan — the admin gate sits
    in front of the PRO gate while the feature is in internal trial."""
    _make_pro(db, user)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"template": "ma_cross", "symbol": "XAUUSD", "interval": "15", "params": {}},
    )
    assert res.status_code == 403


def test_admin_but_free_blocked_by_pro_only_gate(client, db, auth_headers, user):
    """管理员身份不能替代 PRO 专属门槛——两道闸门各司其职。
    Being an admin doesn't substitute for the PRO-exclusive gate — the two
    gates are independent."""
    _make_admin(db, user)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"template": "ma_cross", "symbol": "XAUUSD", "interval": "15", "params": {}},
    )
    assert res.status_code == 403


def test_admin_and_pro_can_create_list_update_delete(client, db, auth_headers, user):
    _make_admin_pro(db, user)
    create = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"template": "rsi_reversal", "symbol": "XAUUSD", "interval": "15", "params": {"period": 14}},
    )
    assert create.status_code == 200
    body = create.json()
    assert body["template"] == "rsi_reversal"
    assert body["enabled"] is False
    strategy_id = body["id"]

    listed = client.get("/api/strategies", headers=auth_headers).json()["strategies"]
    assert len(listed) == 1

    enabled = client.patch(f"/api/strategies/{strategy_id}", headers=auth_headers, json={"enabled": True})
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True

    deleted = client.delete(f"/api/strategies/{strategy_id}", headers=auth_headers)
    assert deleted.status_code == 200
    assert client.get("/api/strategies", headers=auth_headers).json()["strategies"] == []


def test_max_strategies_per_user_enforced(client, db, auth_headers, user):
    _make_admin_pro(db, user)
    for i in range(3):
        res = client.post(
            "/api/strategies", headers=auth_headers,
            json={"template": "ma_cross", "symbol": "XAUUSD", "interval": "15", "params": {}},
        )
        assert res.status_code == 200, f"strategy #{i} should succeed"
    fourth = client.post(
        "/api/strategies", headers=auth_headers,
        json={"template": "ma_cross", "symbol": "XAUUSD", "interval": "15", "params": {}},
    )
    assert fourth.status_code == 400


def test_cannot_update_or_delete_another_users_strategy(client, db, auth_headers, user):
    _make_admin_pro(db, user)
    other = UserStrategy(user_id="someone-else", template="ma_cross", symbol="XAUUSD", interval="15", params="{}")
    db.add(other)
    db.commit()
    db.refresh(other)

    assert client.patch(f"/api/strategies/{other.id}", headers=auth_headers, json={"enabled": True}).status_code == 404
    assert client.delete(f"/api/strategies/{other.id}", headers=auth_headers).status_code == 404


def test_backtest_reports_insufficient_data_with_no_candle_history(client, db, auth_headers, user):
    _make_admin_pro(db, user)
    res = client.post(
        "/api/strategies/backtest", headers=auth_headers,
        json={"template": "ma_cross", "symbol": "XAUUSD", "interval": "15", "params": {}},
    )
    assert res.status_code == 200
    assert res.json()["insufficientData"] is True


def test_backtest_runs_against_seeded_candle_history(client, db, auth_headers, user):
    _make_admin_pro(db, user)
    now = datetime.now(timezone.utc)
    for i in range(60):
        t = int((now - timedelta(minutes=15 * (60 - i))).timestamp())
        db.add(Candle(symbol="XAUUSD", interval="15", t=t, o=100, h=101, l=99, c=100 + (i % 5), v=1))
    db.commit()

    res = client.post(
        "/api/strategies/backtest", headers=auth_headers,
        json={"template": "ma_cross", "symbol": "XAUUSD", "interval": "15", "params": {"fastPeriod": 3, "slowPeriod": 8}},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["insufficientData"] is False
    assert "summary" in body and "points" in body and "trades" in body


def test_list_my_signals_only_returns_current_user_rows(client, db, auth_headers, user):
    _make_admin(db, user)
    strat = UserStrategy(user_id=user.id, template="ma_cross", symbol="XAUUSD", interval="15", params="{}")
    db.add(strat)
    db.commit()
    db.refresh(strat)
    db.add(StrategySignal(strategy_id=strat.id, user_id=user.id, symbol="XAUUSD", side="BUY", entry=100, stop_loss=99, take_profit=102, bar_t=1))
    db.add(StrategySignal(strategy_id="other-strat", user_id="someone-else", symbol="XAUUSD", side="BUY", entry=100, stop_loss=99, take_profit=102, bar_t=1))
    db.commit()

    res = client.get("/api/strategies/signals", headers=auth_headers)
    signals = res.json()["signals"]
    assert len(signals) == 1
    assert signals[0]["strategyId"] == strat.id


def test_clear_my_signals_only_deletes_current_user_rows(client, db, auth_headers, user):
    _make_admin(db, user)
    strat = UserStrategy(user_id=user.id, template="ma_cross", symbol="XAUUSD", interval="15", params="{}")
    db.add(strat)
    db.commit()
    db.refresh(strat)
    db.add(StrategySignal(strategy_id=strat.id, user_id=user.id, symbol="XAUUSD", side="BUY", entry=100, stop_loss=99, take_profit=102, bar_t=1))
    db.add(StrategySignal(strategy_id="other-strat", user_id="someone-else", symbol="XAUUSD", side="BUY", entry=100, stop_loss=99, take_profit=102, bar_t=1))
    db.commit()

    res = client.delete("/api/strategies/signals", headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["ok"] is True

    remaining = db.query(StrategySignal).all()
    assert len(remaining) == 1
    assert remaining[0].user_id == "someone-else"

    # 策略本身不受影响,仍然存在且保留原有的启用状态
    # The strategy itself is untouched — still exists with its original enabled state
    still_there = db.query(UserStrategy).filter(UserStrategy.id == strat.id).first()
    assert still_there is not None


def test_new_closed_candle_triggers_enabled_strategy_and_fires_personal_signal(client, db, auth_headers, user, monkeypatch):
    """完整链路：启用一个策略 → EA 推 K 线到 /feed/candles → 最新一根收盘 K 线
    满足入场条件 → 生成一条只属于这个用户的策略信号。

    Full path: enable a strategy → EA pushes candles to /feed/candles → the
    latest closed bar satisfies the entry condition → a personal strategy
    signal is created for that user only.
    """
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    _make_pro(db, user)
    strat = UserStrategy(
        user_id=user.id, template="ma_cross", symbol="XAUUSD", interval="1",
        params='{"maType": "SMA", "fastPeriod": 2, "slowPeriod": 4, "direction": "both"}',
        enabled=True,
    )
    db.add(strat)
    db.commit()
    db.refresh(strat)

    # 命中时应像平台信号一样可推送通知,但只发给触发它的这一个用户
    # (event 类通知,见 push_dispatch.py 的 EVENT_STRATEGY_SIGNAL)。
    # A hit should be pushable just like a platform signal, but only to the
    # one user who triggered it (event-type notification, see push_dispatch.py's
    # EVENT_STRATEGY_SIGNAL).
    push_calls = []

    async def _fake_dispatch(user_id, event_type, title, body):
        push_calls.append((user_id, event_type, title, body))

    monkeypatch.setattr(strategy_engine, "dispatch_event_push_async", _fake_dispatch)

    # 收盘价序列在最后一根才发生金叉(见测试文件旁的推导脚本);每根间隔 60 秒,
    # 最后一根的收盘时间刚好是"现在减 60 秒"，满足"已走完"的判定。
    # The close sequence crosses only at the very last bar; bars are 60s
    # apart, and the last bar's close time is exactly "now minus 60s" — just
    # closed.
    closes = [100.0] * 10 + [100.0, 170.0]
    now = int(datetime.now(timezone.utc).timestamp())
    n = len(closes)
    bars = [{"t": now - (n - i) * 60, "o": c, "h": c, "l": c, "c": c, "v": 1} for i, c in enumerate(closes)]

    res = client.post(
        "/api/feed/candles",
        headers={"X-EA-Token": "test-ea-token"},
        json={"mode": "backfill", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": bars}]},
    )
    assert res.status_code == 200

    db.expire_all()
    signals = db.query(StrategySignal).filter(StrategySignal.user_id == user.id).all()
    assert len(signals) == 1
    assert signals[0].side == "BUY"
    refreshed = db.query(UserStrategy).filter(UserStrategy.id == strat.id).first()
    assert refreshed.last_signal_bar_t == bars[-1]["t"]

    assert len(push_calls) == 1
    pushed_user_id, event_type, _title, _body = push_calls[0]
    assert pushed_user_id == user.id
    assert event_type == strategy_engine.EVENT_STRATEGY_SIGNAL


def test_disabled_strategy_never_fires(client, db, auth_headers, user, monkeypatch):
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    _make_pro(db, user)
    strat = UserStrategy(
        user_id=user.id, template="ma_cross", symbol="XAUUSD", interval="1",
        params='{"maType": "SMA", "fastPeriod": 2, "slowPeriod": 4, "direction": "both"}',
        enabled=False,
    )
    db.add(strat)
    db.commit()

    closes = [100.0] * 10 + [100.0, 170.0]
    now = int(datetime.now(timezone.utc).timestamp())
    n = len(closes)
    bars = [{"t": now - (n - i) * 60, "o": c, "h": c, "l": c, "c": c, "v": 1} for i, c in enumerate(closes)]

    client.post(
        "/api/feed/candles",
        headers={"X-EA-Token": "test-ea-token"},
        json={"mode": "backfill", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": bars}]},
    )
    assert db.query(StrategySignal).count() == 0
