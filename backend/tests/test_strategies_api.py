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
from app.routers import strategies as strategies_router
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


def test_backtest_returns_most_recent_bars_when_history_exceeds_cap(client, db, auth_headers, user, monkeypatch):
    """回归测试：`days` 窗口内的实际行数超过 MAX_BACKTEST_BARS 时,必须拿最新
    的一段,不能拿最早的一段——否则窗口里不管之后再插入多少新数据,回测永远
    卡在最早那一段,看起来就像"数据不再更新"(真实场景:K 线历史入库刚上线
    没几天,1 分钟线单一品种几天内就能攒够 5000+ 根)。用一个很小的容量上限
    复现,不用真插 5000+ 行。

    Regression test: when the `days` window actually holds more rows than
    MAX_BACKTEST_BARS, the backtest must fetch the newest slice, not the
    oldest — otherwise no matter how much new data arrives afterward, the
    backtest stays pinned to the earliest slice forever, looking exactly like
    "data stopped updating" (real scenario: candle-history ingestion only
    just launched, and a single 1-minute symbol can accumulate 5000+ rows
    within days). Reproduced with a tiny cap instead of actually inserting
    5000+ rows.
    """
    # 上限必须仍然 >= 30(路由的"数据不足"判定阈值),否则会先撞上
    # insufficientData 分支,测不到真正想验证的截取逻辑。
    # The cap must stay >= 30 (the router's own "insufficient data"
    # threshold), otherwise the insufficientData branch trips first and the
    # slicing logic under test is never reached.
    monkeypatch.setattr(strategies_router, "MAX_BACKTEST_BARS", 40)
    _make_admin_pro(db, user)
    now = datetime.now(timezone.utc)
    # 插 120 根,是容量上限(40)的 3 倍——全部已收盘、全部落在 90 天默认窗口内。
    # Insert 120 bars, 3x the cap — all closed, all within the default 90-day window.
    all_times = [int((now - timedelta(minutes=15 * (120 - i))).timestamp()) for i in range(120)]
    for t in all_times:
        db.add(Candle(symbol="XAUUSD", interval="15", t=t, o=100, h=101, l=99, c=100, v=1))
    db.commit()

    res = client.post(
        "/api/strategies/backtest", headers=auth_headers,
        json={"template": "ma_cross", "symbol": "XAUUSD", "interval": "15", "params": {}},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["insufficientData"] is False
    returned_times = [b["t"] for b in body["bars"]]
    assert len(returned_times) == 40
    # 必须是最新的 40 根(最接近"现在"),不是最早插入的那 40 根。
    # Must be the newest 40 bars (closest to "now"), not the earliest 40 inserted.
    assert returned_times == sorted(all_times)[-40:]
    # 依然按时间升序交给前端/回测引擎,不是仅仅"不丢数据"但顺序倒了。
    # Still handed over in ascending order, not just "no data lost" with the order flipped.
    assert returned_times == sorted(returned_times)


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


def test_one_trade_at_a_time_blocks_new_signal_until_previous_resolves(client, db, auth_headers, user, monkeypatch):
    """一次一单(默认开启):上一笔信号还没摸到止损/止盈,新的一根 K 线哪怕仍然
    满足入场条件也不再开新仓;真的平仓那一根同样不开新仓(平仓与开新仓不
    共用一根 K 线);再下一根才重新允许开仓。

    One trade at a time (default on): a new bar doesn't fire a fresh signal
    while the previous one hasn't hit SL/TP yet, even if the entry condition
    is still (nominally) true; the bar that actually resolves it also doesn't
    open a new one (exit and entry never share a bar); the bar after that is
    free to fire again.
    """
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    _make_pro(db, user)
    strat = UserStrategy(
        user_id=user.id, template="ma_cross", symbol="XAUUSD", interval="1",
        params='{}', enabled=True,
        stop_loss_method="percent", stop_loss_value=1.0,
        take_profit_method="rr", take_profit_value=2.0,
        one_trade_at_a_time=True,
    )
    db.add(strat)
    db.commit()

    now = int(datetime.now(timezone.utc).timestamp())

    def _feed(t_offset, c, h=None, l=None):
        bar = {"t": now - t_offset, "o": c, "h": h if h is not None else c, "l": l if l is not None else c, "c": c, "v": 1}
        res = client.post(
            "/api/feed/candles",
            headers={"X-EA-Token": "test-ea-token"},
            json={"mode": "tick", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": [bar]}]},
        )
        assert res.status_code == 200

    # evaluate_new_candle 要求库里至少有 5 根收盘 K 线才会求值,先垫几根早于
    # bar1 的历史；这一步用真实(未打桩)的 entry_signals——全平走势不会有
    # 交叉，不会意外触发。/ evaluate_new_candle requires at least 5 closed
    # bars in the DB before it evaluates anything — seed a few older bars
    # ahead of bar1; this step uses the real (unstubbed) entry_signals — a
    # flat series never crosses, so it won't fire unexpectedly.
    warmup = [{"t": now - 240 - (5 - i) * 60, "o": 100, "h": 100, "l": 100, "c": 100, "v": 1} for i in range(5)]
    res = client.post(
        "/api/feed/candles",
        headers={"X-EA-Token": "test-ea-token"},
        json={"mode": "backfill", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": warmup}]},
    )
    assert res.status_code == 200
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.user_id == user.id).count() == 0

    # 打桩成"最后一根永远是 BUY"，隔离掉均线交叉的具体数学，只测一次一单
    # 的门槛逻辑本身——只在垫完历史之后才打桩，避免连历史回填那一步都被
    # 当成信号触发。/ Stub "the last bar is always BUY" to isolate the
    # one-trade-at-a-time gate from the actual MA-cross math — only applied
    # after the warmup backfill, so that step itself isn't mistaken for a
    # signal trigger too.
    monkeypatch.setattr(strategy_engine, "entry_signals", lambda b, t, p: [None] * (len(b) - 1) + ["BUY"])

    # bar1: 没有正在跟踪的仓位,正常开仓 entry=100 → sl=99, tp=102
    # bar1: nothing pending yet, fires normally — entry=100 → sl=99, tp=102
    _feed(240, 100)
    db.expire_all()
    sigs = db.query(StrategySignal).filter(StrategySignal.user_id == user.id).all()
    assert len(sigs) == 1
    assert sigs[0].result == "PENDING"

    # bar2: 价格仍在 [99, 102] 区间内,上一笔还没平仓 → 门槛拦下,不开新仓
    # bar2: price still inside [99, 102], previous trade still open — gated, no new signal
    _feed(180, 100)
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.user_id == user.id).count() == 1

    # bar3: 摸到止盈(104>=102) → 上一笔就地判定为 HIT_TP,但这一根本身不开新仓
    # bar3: touches TP (104>=102) — resolves the previous trade as HIT_TP, but this bar itself still doesn't open a new one
    _feed(120, 104, h=104, l=104)
    db.expire_all()
    sigs = db.query(StrategySignal).filter(StrategySignal.user_id == user.id).order_by(StrategySignal.created_at.asc()).all()
    assert len(sigs) == 1
    assert sigs[0].result == "HIT_TP"

    # bar4: 上一笔已平仓,重新允许开仓 → 第二笔信号
    # bar4: previous trade is resolved, allowed to fire again — second signal
    _feed(60, 100)
    db.expire_all()
    sigs = db.query(StrategySignal).filter(StrategySignal.user_id == user.id).order_by(StrategySignal.created_at.asc()).all()
    assert len(sigs) == 2
    assert sigs[1].result == "PENDING"


def test_one_trade_at_a_time_off_fires_every_bar(client, db, auth_headers, user, monkeypatch):
    """关闭一次一单:哪怕上一笔还没平仓,只要新收盘的 K 线满足入场条件就照样
    触发新信号。
    One trade at a time off: fires a new signal on every bar meeting the
    entry condition, even while the previous one is still open."""
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    _make_pro(db, user)
    strat = UserStrategy(
        user_id=user.id, template="ma_cross", symbol="XAUUSD", interval="1",
        params='{}', enabled=True,
        stop_loss_method="percent", stop_loss_value=1.0,
        take_profit_method="rr", take_profit_value=2.0,
        one_trade_at_a_time=False,
    )
    db.add(strat)
    db.commit()

    now = int(datetime.now(timezone.utc).timestamp())
    warmup = [{"t": now - 240 - (5 - i) * 60, "o": 100, "h": 100, "l": 100, "c": 100, "v": 1} for i in range(5)]
    res = client.post(
        "/api/feed/candles",
        headers={"X-EA-Token": "test-ea-token"},
        json={"mode": "backfill", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": warmup}]},
    )
    assert res.status_code == 200
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.user_id == user.id).count() == 0

    monkeypatch.setattr(strategy_engine, "entry_signals", lambda b, t, p: [None] * (len(b) - 1) + ["BUY"])

    for offset in (180, 120, 60):
        bar = {"t": now - offset, "o": 100, "h": 100, "l": 100, "c": 100, "v": 1}
        res = client.post(
            "/api/feed/candles",
            headers={"X-EA-Token": "test-ea-token"},
            json={"mode": "tick", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": [bar]}]},
        )
        assert res.status_code == 200

    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.user_id == user.id).count() == 3


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
