"""自定义策略 API 的端到端测试：所有端点对登录用户开放，写操作端点前挡着
PRO 专属门槛、每用户数量上限、CRUD、回测端点、我的策略信号列表，以及"新
K 线收盘时自动评估已启用策略"这条实时链路（该链路走 /feed/candles，鉴权是
EA Token，与用户登录态无关）。

End-to-end tests for the custom-strategy API: every endpoint is open to any
logged-in user, with the PRO-exclusive gate in front of the write endpoints,
the per-user strategy count limit, CRUD, the backtest endpoint, the "my
strategy signals" list, and the live "evaluate enabled strategies whenever a
bar closes" path (that path goes through /feed/candles, EA-Token-authenticated,
unrelated to the calling user's login).
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.models import Candle, StrategySignal, StrategyWatch, UserStrategy
from app.routers import strategies as strategies_router
from app.services.strategy import live as strategy_live
from app.services.strategy import presets
from app.services.strategy.conditions import validate_conditions


@pytest.fixture(autouse=True)
def _no_user_rate_limit():
    """限流值在装饰器求值时固化，运行期改配置无效，只能整体关掉限流器。
    本文件测的是端点行为本身，不该被按用户限流的计数干扰（限流本身由
    test_strategy_limits.py 覆盖）。
    Limits are baked in when the decorator is evaluated, so patching settings at
    runtime does nothing — the limiter itself has to be switched off. This file
    tests endpoint behaviour, not throttling (that's test_strategy_limits.py)."""
    from app.core.strategy_limits import user_limiter

    user_limiter.enabled = False
    yield
    user_limiter.enabled = True


@pytest.fixture(autouse=True)
def _clean_backtest_cache():
    """回测结果缓存是进程级的，而每个测试各自重建库：不清空会让上一个测试的
    结果被下一个测试命中（键里的"最新 bar 时间"可能恰好相同）。
    The backtest cache is process-global while each test rebuilds the DB: without
    clearing, one test can hit the previous test's entry (the "latest bar time"
    in the key may coincide)."""
    from app.core.strategy_limits import cache_clear

    cache_clear()
    yield
    cache_clear()


def _rules(symbol="XAUUSD", interval="15", logic="AND"):
    """一份最小的合法条件配置：单条「收盘价在 SMA5 上方」。

    条件列表是固定形态：logic + 品种 + 周期 + conditions，每个条件是
    (indicator, usage, params) 三元组，空头侧由 usage 的镜像自动推出，不入参。
    rules 里的品种/周期必须与请求顶层一致，故这里参数化。

    A minimal valid condition payload: one "close is above SMA5" condition. The
    shape is fixed — logic + symbol + interval + conditions, each condition an
    (indicator, usage, params) triple, with the short side derived from the
    usage's mirror rather than passed in. The symbol/interval inside `rules` must
    match the top-level request, hence the parameters.
    """
    return {
        "logic": logic,
        "symbol": symbol,
        "interval": interval,
        "conditions": [
            {"indicator": "ma", "usage": "ma.price_above", "params": {"maType": "SMA", "period": 5}},
        ],
    }


def _feed(monkeypatch, symbols=("XAUUSD",)):
    """把"哪些品种有行情"打桩掉——测试环境没有 EA 在推报价。
    Stub out "which symbols are fed"; no EA pushes quotes in tests."""
    monkeypatch.setattr(strategies_router, "active_symbols", lambda: list(symbols))


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


def test_pro_non_admin_user_can_create_strategy(client, db, auth_headers, user, monkeypatch):
    """功能已对全体用户开放：普通(非管理员) PRO 用户能正常创建策略——不再
    需要管理员身份。Feature is open to everyone now: an ordinary (non-admin)
    PRO user can create a strategy — admin status is no longer required."""
    _make_pro(db, user)
    _feed(monkeypatch)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"template": "ma_trend", "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 200


def test_free_non_admin_user_blocked_by_pro_only_gate(client, db, auth_headers, user):
    """普通(非管理员) FREE 用户被 PRO 专属门槛挡下——管理员身份从未参与这道
    判断，门槛只看订阅等级。An ordinary (non-admin) FREE user is blocked by
    the PRO-exclusive gate — admin status was never part of this check; it's
    plan-only."""
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"template": "ma_trend", "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 403


def test_admin_and_pro_can_create_list_update_delete(client, db, auth_headers, user, monkeypatch):
    _make_admin_pro(db, user)
    _feed(monkeypatch)
    create = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"template": "rsi_reversal", "symbol": "XAUUSD", "interval": "15"},
    )
    assert create.status_code == 200, create.text
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


def test_max_strategies_per_user_enforced(client, db, auth_headers, user, monkeypatch):
    _make_admin_pro(db, user)
    _feed(monkeypatch)
    for i in range(3):
        res = client.post(
            "/api/strategies", headers=auth_headers,
            json={"template": "ma_trend", "symbol": "XAUUSD", "interval": "15"},
        )
        assert res.status_code == 200, f"strategy #{i} should succeed"
    fourth = client.post(
        "/api/strategies", headers=auth_headers,
        json={"template": "ma_trend", "symbol": "XAUUSD", "interval": "15"},
    )
    assert fourth.status_code == 400


def test_cannot_update_or_delete_another_users_strategy(client, db, auth_headers, user):
    _make_admin_pro(db, user)
    other = UserStrategy(user_id="someone-else", template="ma_trend", symbol="XAUUSD", interval="15",
                         rules=json.dumps(presets.preset_payload("ma_trend", "XAUUSD", "15")), params="{}")
    db.add(other)
    db.commit()
    db.refresh(other)

    assert client.patch(f"/api/strategies/{other.id}", headers=auth_headers, json={"enabled": True}).status_code == 404
    assert client.delete(f"/api/strategies/{other.id}", headers=auth_headers).status_code == 404


def test_backtest_reports_insufficient_data_with_no_candle_history(client, db, auth_headers, user, monkeypatch):
    _make_admin_pro(db, user)
    _feed(monkeypatch)
    res = client.post(
        "/api/strategies/backtest", headers=auth_headers,
        json={"template": "ma_trend", "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 200
    assert res.json()["insufficientData"] is True


def test_backtest_runs_against_seeded_candle_history(client, db, auth_headers, user, monkeypatch):
    _make_admin_pro(db, user)
    _feed(monkeypatch)
    now = datetime.now(timezone.utc)
    for i in range(60):
        t = int((now - timedelta(minutes=15 * (60 - i))).timestamp())
        db.add(Candle(symbol="XAUUSD", interval="15", t=t, o=100, h=101, l=99, c=100 + (i % 5), v=1))
    db.commit()

    res = client.post(
        "/api/strategies/backtest", headers=auth_headers,
        json={"template": "ma_trend", "symbol": "XAUUSD", "interval": "15"},
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
    _feed(monkeypatch)
    now = datetime.now(timezone.utc)
    # 插 120 根,是容量上限(40)的 3 倍——全部已收盘、全部落在 90 天默认窗口内。
    # Insert 120 bars, 3x the cap — all closed, all within the default 90-day window.
    all_times = [int((now - timedelta(minutes=15 * (120 - i))).timestamp()) for i in range(120)]
    for t in all_times:
        db.add(Candle(symbol="XAUUSD", interval="15", t=t, o=100, h=101, l=99, c=100, v=1))
    db.commit()

    # 响应不再回传 bars（体积），改为截获真正交给回测引擎的那一段——被测的截取
    # 逻辑本身没变，只是观测点从响应体挪到了引擎入参。
    # The response no longer echoes bars (size), so capture the slice actually
    # handed to the engine: the slicing logic under test is unchanged, only the
    # observation point moved from the body to the engine's argument.
    from app.services.strategy import backtest as bt

    seen = {}
    real = bt.run_backtest

    def _capturing(bars, *a, **kw):
        seen["times"] = [b["t"] for b in bars]
        return real(bars, *a, **kw)

    monkeypatch.setattr(strategies_router, "run_backtest", _capturing)

    res = client.post(
        "/api/strategies/backtest", headers=auth_headers,
        json={"template": "ma_trend", "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["insufficientData"] is False
    returned_times = seen["times"]
    assert len(returned_times) == 40
    assert body["barsUsed"] == 40
    # 必须是最新的 40 根(最接近"现在"),不是最早插入的那 40 根。
    # Must be the newest 40 bars (closest to "now"), not the earliest 40 inserted.
    assert returned_times == sorted(all_times)[-40:]
    # 依然按时间升序交给前端/回测引擎,不是仅仅"不丢数据"但顺序倒了。
    # Still handed over in ascending order, not just "no data lost" with the order flipped.
    assert returned_times == sorted(returned_times)


def test_backtest_bars_endpoint_returns_same_window_as_backtest(client, db, auth_headers, user, monkeypatch):
    """回归测试：回测图的 K 线接口必须与回测引擎吃到的是同一段。

    此前图走 GET /chart/history,读的是内存缓存(chart_store,硬上限 500 根、
    只保留最近的),而回测读 Candle 表按 days 窗口取。两者时间范围不同,回测
    算出的入场/出场时间戳大量落在图上的蜡烛范围之外,表现为标记被挤到边缘、
    成交连线在空白处悬着——也就是用户报的"进出场标记线不准确"。

    Regression test: the backtest chart's candle endpoint must serve the exact
    slice the engine consumed. The chart used to call GET /chart/history, which
    reads the in-memory cache (chart_store: hard cap of 500, newest only), while
    the backtest reads the Candle table over the `days` window. Different ranges
    meant most computed entry/exit timestamps fell outside the charted candles —
    markers pinned to the edge, trade lines floating over blank space. That was
    the reported "entry/exit markers are inaccurate".
    """
    _make_admin_pro(db, user)
    _feed(monkeypatch)
    now = datetime.now(timezone.utc)
    all_times = [int((now - timedelta(minutes=15 * (120 - i))).timestamp()) for i in range(120)]
    for t in all_times:
        db.add(Candle(symbol="XAUUSD", interval="15", t=t, o=100, h=101, l=99, c=100, v=1))
    db.commit()

    from app.services.strategy import backtest as bt

    seen = {}
    real = bt.run_backtest

    def _capturing(bars, *a, **kw):
        seen["times"] = [b["t"] for b in bars]
        return real(bars, *a, **kw)

    monkeypatch.setattr(strategies_router, "run_backtest", _capturing)

    run = client.post(
        "/api/strategies/backtest", headers=auth_headers,
        json={"template": "ma_trend", "symbol": "XAUUSD", "interval": "15", "days": 90},
    )
    assert run.status_code == 200

    res = client.get(
        "/api/strategies/backtest/bars",
        headers=auth_headers,
        params={"symbol": "XAUUSD", "interval": "15", "days": 90},
    )
    assert res.status_code == 200
    charted = [b["t"] for b in res.json()["bars"]]
    # 逐个时间戳相同,不只是"数量差不多"——错位一根就是一次画错的标记。
    # Timestamp-for-timestamp identical, not merely a similar count: one bar of
    # drift is one mis-drawn marker.
    assert charted == seen["times"]


def test_backtest_bars_endpoint_rejects_out_of_range_days(client, db, auth_headers, user, monkeypatch):
    """days 的边界必须与 StrategyBacktestRequest.days（7-730）一致：两边不同
    就又会出现"图能取到的区间"与"回测算过的区间"分叉。
    The `days` bounds must match StrategyBacktestRequest.days (7-730); differing
    bounds would re-introduce a charted window that diverges from the computed one."""
    _make_admin_pro(db, user)
    _feed(monkeypatch)
    for bad in (1, 731):
        res = client.get(
            "/api/strategies/backtest/bars",
            headers=auth_headers,
            params={"symbol": "XAUUSD", "interval": "15", "days": bad},
        )
        assert res.status_code == 400


def test_list_my_signals_only_returns_current_user_rows(client, db, auth_headers, user):
    _make_admin(db, user)
    strat = UserStrategy(user_id=user.id, template="ma_trend", symbol="XAUUSD", interval="15",
                         rules=json.dumps(presets.preset_payload("ma_trend", "XAUUSD", "15")), params="{}")
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
    strat = UserStrategy(user_id=user.id, template="ma_trend", symbol="XAUUSD", interval="15",
                         rules=json.dumps(presets.preset_payload("ma_trend", "XAUUSD", "15")), params="{}")
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
        user_id=user.id, template="ma_trend", symbol="XAUUSD", interval="1",
        params="{}",
        rules=json.dumps(_rules("XAUUSD", "1")),
        enabled=True,
    )
    db.add(strat)
    db.commit()
    db.refresh(strat)
    # 实时评估的候选来自 strategy_watch，不补这行策略永远不会被选中。
    # Live candidates come from strategy_watch; without this row the strategy is
    # never picked up.
    db.add(StrategyWatch(strategy_id=strat.id, symbol="XAUUSD", interval="1"))
    db.commit()

    # 命中时应像平台信号一样可推送通知,但只发给触发它的这一个用户
    # (event 类通知,见 push_dispatch.py 的 EVENT_STRATEGY_SIGNAL)。
    # A hit should be pushable just like a platform signal, but only to the
    # one user who triggered it (event-type notification, see push_dispatch.py's
    # EVENT_STRATEGY_SIGNAL).
    push_calls = []

    async def _fake_dispatch(user_id, event_type, title, body):
        push_calls.append((user_id, event_type, title, body))

    monkeypatch.setattr(strategy_live, "dispatch_event_push_async", _fake_dispatch)

    # 收盘价一路走平,只有最后一根跳上去,所以「收盘价在 SMA5 上方」只在最后
    # 一根成立(走平时收盘价等于均线,不是严格大于);每根间隔 60 秒,最后一根的
    # 收盘时间刚好是"现在减 60 秒"，满足"已走完"的判定。
    # The closes are flat until the last bar jumps, so "close above SMA5" only
    # holds on that final bar (a flat series has close equal to the MA, not
    # strictly above). Bars are 60s apart, and the last bar's close time is
    # exactly "now minus 60s" — just closed.
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
    assert event_type == strategy_live.EVENT_STRATEGY_SIGNAL


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
        user_id=user.id, template="ma_trend", symbol="XAUUSD", interval="1",
        params='{}', rules=json.dumps(_rules("XAUUSD", "1")),
        enabled=True,
        stop_loss_method="percent", stop_loss_value=1.0,
        take_profit_method="rr", take_profit_value=2.0,
        one_trade_at_a_time=True,
    )
    db.add(strat)
    db.commit()
    db.refresh(strat)
    db.add(StrategyWatch(strategy_id=strat.id, symbol="XAUUSD", interval="1"))
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
    # bar1 的历史；这一步用真实(未打桩)的求值——全平走势不会满足
    # 条件，不会意外触发。/ evaluate_new_candle requires at least 5 closed
    # bars in the DB before it evaluates anything — seed a few older bars
    # ahead of bar1; this step uses the real (unstubbed) evaluation — a flat
    # series never puts close strictly above the MA, so it won't fire
    # unexpectedly.
    warmup = [{"t": now - 240 - (5 - i) * 60, "o": 100, "h": 100, "l": 100, "c": 100, "v": 1} for i in range(5)]
    res = client.post(
        "/api/feed/candles",
        headers={"X-EA-Token": "test-ea-token"},
        json={"mode": "backfill", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": warmup}]},
    )
    assert res.status_code == 200
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.user_id == user.id).count() == 0

    # 打桩成"最后一根永远是 BUY"，隔离掉指标条件的具体数学，只测一次一单
    # 的门槛逻辑本身——只在垫完历史之后才打桩，避免连历史回填那一步都被
    # 当成信号触发。/ Stub "the last bar is always BUY" to isolate the
    # one-trade-at-a-time gate from the actual indicator math — only applied
    # after the warmup backfill, so that step itself isn't mistaken for a
    # signal trigger too.
    # 打桩落在 live 模块自己的名字上：live.py 用的是 from-import，打 conditions 不生效。
    # Patch live's own name: live.py from-imports evaluate_conditions, so
    # patching conditions has no effect.
    monkeypatch.setattr(
        strategy_live, "evaluate_conditions",
        lambda bars, rules, memo=None: [None] * (len(bars) - 1) + ["BUY"],
    )

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
        user_id=user.id, template="ma_trend", symbol="XAUUSD", interval="1",
        params='{}', rules=json.dumps(_rules("XAUUSD", "1")),
        enabled=True,
        stop_loss_method="percent", stop_loss_value=1.0,
        take_profit_method="rr", take_profit_value=2.0,
        one_trade_at_a_time=False,
    )
    db.add(strat)
    db.commit()
    db.refresh(strat)
    db.add(StrategyWatch(strategy_id=strat.id, symbol="XAUUSD", interval="1"))
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

    monkeypatch.setattr(
        strategy_live, "evaluate_conditions",
        lambda bars, rules, memo=None: [None] * (len(bars) - 1) + ["BUY"],
    )

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
        user_id=user.id, template="ma_trend", symbol="XAUUSD", interval="1",
        params="{}",
        rules=json.dumps(_rules("XAUUSD", "1")),
        enabled=False,
    )
    db.add(strat)
    db.commit()
    db.refresh(strat)
    # 有 watch 行但 enabled=False：测的是启用开关本身，而不是"根本没被盯着"。
    # Watched but disabled: this tests the enabled gate itself, not "nothing
    # watches this combo".
    db.add(StrategyWatch(strategy_id=strat.id, symbol="XAUUSD", interval="1"))
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


# ---------- 模板清单单一来源 / single source of truth for the template list ----------

def test_schema_template_list_is_engine_owned():
    """schemas 不再自己抄一份模板清单——它引用引擎侧的 TEMPLATE_KEYS。
    schemas no longer keeps its own copy of the template list; it references the
    engine-side TEMPLATE_KEYS."""
    from app import schemas

    assert schemas.STRATEGY_TEMPLATES is presets.TEMPLATE_KEYS


def test_unknown_template_rejected_by_schema(client, db, auth_headers, user):
    _make_pro(db, user)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"template": "not_a_template", "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 422


@pytest.mark.parametrize(
    "field,value",
    [
        ("stopLossValue", 0),
        ("stopLossValue", 5_000_000),
        ("takeProfitValue", 0),
        ("takeProfitValue", 5_000_000),
    ],
)
def test_out_of_range_sl_tp_value_rejected_not_clamped(
    client, db, auth_headers, user, monkeypatch, field, value
):
    """越界的止损/止盈数值必须被 Pydantic 直接拒绝（422），而不是像旧引擎那样
    夹取到边界后照常落库——夹取会让用户以为自己填的值生效了。
    Out-of-range SL/TP values must be rejected outright (422) instead of being
    silently clamped to the bound the way the old engine did: clamping leaves the
    user believing the value they typed took effect."""
    _make_pro(db, user)
    _feed(monkeypatch)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules(), "symbol": "XAUUSD", "interval": "15", field: value},
    )
    assert res.status_code == 422, res.text
    assert db.query(UserStrategy).count() == 0


# ---------- 条件列表形态的 CRUD / condition-list-shaped CRUD ----------

def test_create_with_explicit_conditions(client, db, auth_headers, user, monkeypatch):
    _make_pro(db, user)
    _feed(monkeypatch)
    rules = _rules("XAUUSD", "60")
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"name": "自定义", "rules": rules, "symbol": "XAUUSD", "interval": "60"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rules"] == rules
    assert body["symbol"] == "XAUUSD"
    assert body["interval"] == "60"
    assert body["template"] is None


def test_create_from_template_fills_preset_conditions(client, db, auth_headers, user, monkeypatch):
    """只传 template 不传 rules 时，服务端用该模板的预设条件落库（并把选中的
    品种/周期拼进去）——模板降级为"条件列表的一组预设值"，落库后与手搭的条件
    列表无区别。
    Passing only a template stores that template's preset conditions with the
    chosen symbol/interval spliced in: a template is just a set of preset values
    for the rules column."""
    _make_pro(db, user)
    _feed(monkeypatch)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"template": "ma_trend", "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["rules"] == presets.preset_payload("ma_trend", "XAUUSD", "15")


def test_create_syncs_strategy_watch_rows(client, db, auth_headers, user, monkeypatch):
    _make_pro(db, user)
    _feed(monkeypatch, ("XAUUSD", "EURUSD"))
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules("EURUSD", "60"), "symbol": "EURUSD", "interval": "60"},
    )
    assert res.status_code == 200, res.text
    sid = res.json()["id"]
    pairs = {
        (w.symbol, w.interval)
        for w in db.query(StrategyWatch).filter(StrategyWatch.strategy_id == sid).all()
    }
    assert pairs == {("EURUSD", "60")}


def test_update_replaces_strategy_watch_rows(client, db, auth_headers, user, monkeypatch):
    _make_pro(db, user)
    _feed(monkeypatch, ("XAUUSD", "EURUSD"))
    sid = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules(), "symbol": "XAUUSD", "interval": "15"},
    ).json()["id"]
    res = client.patch(
        f"/api/strategies/{sid}",
        headers=auth_headers,
        json={"rules": _rules("EURUSD", "60"), "symbol": "EURUSD", "interval": "60"},
    )
    assert res.status_code == 200, res.text
    pairs = {
        (w.symbol, w.interval)
        for w in db.query(StrategyWatch).filter(StrategyWatch.strategy_id == sid).all()
    }
    assert pairs == {("EURUSD", "60")}


def test_legacy_ast_rules_are_served_as_empty_conditions(client, db, auth_headers, user, monkeypatch):
    """旧 AST 结构的策略必须以合法条件结构发出，否则客户端读 conditions 会崩。

    迁移只停用这类策略、不重写它们的 rules，所以库里会长期留着 {long, short} 这种
    形状。此前接口把它原样发出，前端一点「编辑」就白屏。

    A legacy-AST strategy must be served as a valid condition structure, or a
    client reading `conditions` crashes. The migration only disables such
    strategies without rewriting their rules, so shapes like {long, short} stay in
    the database indefinitely. The endpoint used to serve them verbatim, blanking
    the frontend the moment "edit" was clicked.
    """
    _make_pro(db, user)
    _feed(monkeypatch)
    sid = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules(), "symbol": "XAUUSD", "interval": "15"},
    ).json()["id"]
    # 绕过接口直接写回旧结构：接口本身会拒绝它，而要复现的正是「库里已经存在」。
    # Write the legacy shape straight to the row: the endpoint rejects it on the
    # way in, and what's being reproduced is a row that already holds it.
    row = db.query(UserStrategy).filter(UserStrategy.id == sid).one()
    row.rules = json.dumps({
        "long": {"logic": "AND", "children": [{"left": {"kind": "indicator"}, "op": "gt"}]},
        "short": None,
    })
    db.commit()

    for payload in (
        client.get("/api/strategies", headers=auth_headers).json()["strategies"][0],
        client.patch(f"/api/strategies/{sid}", headers=auth_headers, json={"name": "x"}).json(),
    ):
        rules = payload["rules"]
        assert rules["conditions"] == []
        assert rules["symbol"] == "XAUUSD"
        assert rules["interval"] == "15"
        # 发出的形状必须是新引擎认得的，只是没有条件——否则客户端仍要自己判形状。
        # The shape served has to be one the new engine recognises, merely without
        # conditions; otherwise clients still have to sniff the shape themselves.
        assert rules["logic"] in ("AND", "OR")

    # 库里的原始 rules 不被读接口改写：保留可读痕迹，也不做不可逆改动。
    # Reading doesn't rewrite the stored rules: the trace stays readable and no
    # irreversible change is made.
    db.refresh(row)
    assert "long" in json.loads(row.rules)


def test_delete_strategy_removes_watch_rows(client, db, auth_headers, user, monkeypatch):
    _make_pro(db, user)
    _feed(monkeypatch)
    sid = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules(), "symbol": "XAUUSD", "interval": "15"},
    ).json()["id"]
    assert client.delete(f"/api/strategies/{sid}", headers=auth_headers).status_code == 200
    assert db.query(StrategyWatch).filter(StrategyWatch.strategy_id == sid).count() == 0


# ---------- 400 错误的具体性 / specificity of the 400s ----------

def test_unknown_usage_returns_400_naming_the_violation(client, db, auth_headers, user, monkeypatch):
    """用法不在枚举表里：400 并点名那个用法，而不是笼统的"参数错误"。
    A usage outside the enum table 400s and names it, rather than a generic
    "bad payload"."""
    _make_pro(db, user)
    _feed(monkeypatch)
    bad = _rules()
    bad["conditions"] = [{"indicator": "ma", "usage": "ma.no_such_usage", "params": {}}]
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": bad, "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 400
    assert "ma.no_such_usage" in res.json()["detail"]


def test_out_of_range_condition_param_returns_400_naming_the_bound(client, db, auth_headers, user, monkeypatch):
    """参数越界：400 并点名参数与边界，让用户知道改哪个数字。参数不被夹取到
    边界后照常落库——夹取会让用户以为自己填的值生效了。
    An out-of-range param 400s and names the param and the bound, so the user
    knows which number to change. It is not clamped and stored: clamping leaves
    the user believing the value they typed took effect."""
    _make_pro(db, user)
    _feed(monkeypatch)
    bad = _rules()
    # period 上限 300 / period caps at 300
    bad["conditions"] = [
        {"indicator": "ma", "usage": "ma.price_above", "params": {"maType": "SMA", "period": 9999}},
    ]
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": bad, "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "period" in detail and "300" in detail
    assert db.query(UserStrategy).count() == 0


def test_rules_interval_disagreeing_with_request_returns_400(client, db, auth_headers, user, monkeypatch):
    """rules 里的周期与请求顶层不一致：400 并点名两者，而不是上线后按一个周期
    订阅、按另一个周期判定。
    A `rules` interval diverging from the top-level one 400s and names both,
    instead of subscribing by one interval and deciding by another once live."""
    _make_pro(db, user)
    _feed(monkeypatch)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules("XAUUSD", "240"), "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "240" in detail and "15" in detail


def test_rules_symbol_disagreeing_with_request_returns_400(client, db, auth_headers, user, monkeypatch):
    """品种同理：rules 与顶层必须是同一个品种。
    Same for the symbol: `rules` and the top level must name the same one."""
    _make_pro(db, user)
    _feed(monkeypatch, ("XAUUSD", "EURUSD"))
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules("EURUSD", "15"), "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "EURUSD" in detail and "XAUUSD" in detail


def test_unfed_symbol_returns_400_not_empty_result(client, db, auth_headers, user, monkeypatch):
    """未接入品种直接 400 并点名该品种，而不是照样建好、等回测时才吐
    insufficientData。An unfed symbol 400s and names the symbol, instead of
    saving fine and only surfacing insufficientData at backtest time."""
    _make_pro(db, user)
    _feed(monkeypatch, ("XAUUSD",))
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules("NOPE", "15"), "symbol": "NOPE", "interval": "15"},
    )
    assert res.status_code == 400
    assert "NOPE" in res.json()["detail"]


def test_missing_symbol_returns_422(client, db, auth_headers, user, monkeypatch):
    """一条策略只能有一个品种，且必填：不传直接被 schema 拒（422），不会建出
    一条永远不会被评估的策略。多选与"一个都不选"在新形态下结构上不可能出现。
    A strategy carries exactly one required symbol: omitting it is rejected by
    the schema (422) rather than saving a strategy that can never be evaluated.
    Multi-select and "none selected" are structurally impossible now."""
    _make_pro(db, user)
    _feed(monkeypatch)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules(), "interval": "15"},
    )
    assert res.status_code == 422, res.text
    assert db.query(UserStrategy).count() == 0


def test_blank_symbol_returns_422(client, db, auth_headers, user, monkeypatch):
    """空白品种同样被 schema 拒——空串不是"未选"的合法表达。
    A blank symbol is rejected by the schema too; an empty string isn't a valid
    way to say "unset"."""
    _make_pro(db, user)
    _feed(monkeypatch)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules(), "symbol": "   ", "interval": "15"},
    )
    assert res.status_code == 422, res.text
    assert db.query(UserStrategy).count() == 0


def test_unsupported_interval_returns_400_naming_the_options(client, db, auth_headers, user, monkeypatch):
    """周期只能是六档之一：不支持的周期 400 并列出可选值，而不是建出一条永远
    等不到 K 线的策略。
    The interval must be one of the six: an unsupported one 400s and lists the
    options instead of saving a strategy that never sees a bar."""
    _make_pro(db, user)
    _feed(monkeypatch)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"rules": _rules("XAUUSD", "7"), "symbol": "XAUUSD", "interval": "7"},
    )
    assert res.status_code == 400, res.text
    assert "7" in res.json()["detail"]
    assert db.query(UserStrategy).count() == 0


def test_neither_rules_nor_template_returns_400(client, db, auth_headers, user, monkeypatch):
    _make_pro(db, user)
    _feed(monkeypatch)
    res = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={"symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 400


# ---------- 回测端点 / backtest endpoint ----------

def _seed_candles(db, symbol="XAUUSD", interval="15", count=200):
    """种一段单调上行的 K 线，够指标预热也够样本内外都出交易。
    Seed a monotonically rising series: enough for indicator warm-up and for
    both samples to produce trades."""
    base = int((datetime.now(timezone.utc) - timedelta(days=10)).timestamp())
    for i in range(count):
        px = 2000.0 + i * 0.5
        db.add(Candle(
            symbol=symbol, interval=interval, t=base + i * 900,
            o=px, h=px + 0.4, l=px - 0.4, c=px + 0.2, v=10,
        ))
    db.commit()


def test_backtest_accepts_conditions_and_returns_both_samples(client, db, auth_headers, user, monkeypatch):
    _make_pro(db, user)
    _feed(monkeypatch)
    _seed_candles(db)
    res = client.post(
        "/api/strategies/backtest",
        headers=auth_headers,
        json={"rules": _rules(), "symbol": "XAUUSD", "interval": "15", "days": 30},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    for key in ("summary", "inSample", "outOfSample", "overfitRisk", "totalCost", "withoutCosts", "coverage"):
        assert key in body


def test_backtest_response_omits_full_bars(client, db, auth_headers, user, monkeypatch):
    """响应不再原样回传全部 bars——只回绘图所需的净值点与交易点。
    The response no longer echoes every bar; only equity/trade points needed for
    the chart."""
    _make_pro(db, user)
    _feed(monkeypatch)
    _seed_candles(db)
    body = client.post(
        "/api/strategies/backtest",
        headers=auth_headers,
        json={"rules": _rules(), "symbol": "XAUUSD", "interval": "15", "days": 30},
    ).json()
    assert "bars" not in body


def test_backtest_includes_coverage_and_actual_range(client, db, auth_headers, user, monkeypatch):
    """请求 365 天但库里只有 10 天时，响应里能看出实际用到多少。
    Asking for 365 days with only 10 in store: the response says what was
    actually used."""
    _make_pro(db, user)
    _feed(monkeypatch)
    _seed_candles(db)
    body = client.post(
        "/api/strategies/backtest",
        headers=auth_headers,
        json={"rules": _rules(), "symbol": "XAUUSD", "interval": "15", "days": 365},
    ).json()
    assert body["requestedDays"] == 365
    assert body["coverage"]["spanDays"] < 365
    assert body["barsUsed"] > 0


def test_backtest_on_unfed_symbol_returns_400(client, db, auth_headers, user, monkeypatch):
    _make_pro(db, user)
    _feed(monkeypatch, ("XAUUSD",))
    res = client.post(
        "/api/strategies/backtest",
        headers=auth_headers,
        json={"rules": _rules("NOPE", "15"), "symbol": "NOPE", "interval": "15", "days": 30},
    )
    assert res.status_code == 400
    assert "NOPE" in res.json()["detail"]


def test_backtest_second_identical_request_is_cached(client, db, auth_headers, user, monkeypatch):
    """同一 (条件配置, 品种, 周期, 天数, 成本版本) 的重复请求直接吃缓存，不再
    算一遍。
    A repeat of the same (conditions, symbol, interval, days, cost version) is
    served from cache instead of recomputed."""
    from app.core import strategy_limits as sl
    from app.services.strategy import backtest as bt

    _make_pro(db, user)
    _feed(monkeypatch)
    _seed_candles(db)
    sl.cache_clear()
    calls = {"n": 0}
    real = bt.run_backtest

    def _counting(*a, **kw):
        calls["n"] += 1
        return real(*a, **kw)

    monkeypatch.setattr(strategies_router, "run_backtest", _counting)
    payload = {"rules": _rules(), "symbol": "XAUUSD", "interval": "15", "days": 30}
    first = client.post("/api/strategies/backtest", headers=auth_headers, json=payload)
    second = client.post("/api/strategies/backtest", headers=auth_headers, json=payload)
    assert first.status_code == second.status_code == 200
    assert calls["n"] == 1
    assert second.json()["cached"] is True


def test_backtest_over_cost_cap_returns_400(client, db, auth_headers, user, monkeypatch):
    """bars 数 × 条件数超硬上限时 400，不让单次请求占满 CPU。
    400 when bars x conditions exceeds the hard cap, so one request can't peg
    the CPU."""
    _make_pro(db, user)
    _feed(monkeypatch)
    _seed_candles(db)
    monkeypatch.setattr(settings, "MAX_BACKTEST_COST_UNITS", 1)
    res = client.post(
        "/api/strategies/backtest",
        headers=auth_headers,
        json={"rules": _rules(), "symbol": "XAUUSD", "interval": "15", "days": 30},
    )
    assert res.status_code == 400


# ---------- 绩效端点 / performance endpoint ----------

def _seed_signals(db, user, strategy_id, results):
    base = int(datetime.now(timezone.utc).timestamp())
    for i, r in enumerate(results):
        db.add(StrategySignal(
            strategy_id=strategy_id, user_id=user.id, symbol="XAUUSD", interval="15",
            side="BUY", entry=2000.0, stop_loss=1990.0, take_profit=2020.0,
            bar_t=base + i * 900, result=r,
            resolved_at=None if r == "PENDING" else datetime.now(timezone.utc),
        ))
    db.commit()


def _new_strategy(client, auth_headers):
    res = client.post(
        "/api/strategies", headers=auth_headers,
        json={"rules": _rules(), "symbol": "XAUUSD", "interval": "15"},
    )
    assert res.status_code == 200, res.text
    return res.json()["id"]


def test_performance_hides_percentages_below_sample_threshold(client, db, auth_headers, user, monkeypatch):
    """1 胜 0 负不能呈现为 100%——不足 10 笔一律不给百分比。
    1-0 must not read as 100%: no percentages below 10 resolved trades."""
    _make_pro(db, user)
    _feed(monkeypatch)
    sid = _new_strategy(client, auth_headers)
    _seed_signals(db, user, sid, ["HIT_TP"])
    body = client.get(f"/api/strategies/{sid}/performance", headers=auth_headers).json()
    assert body["resolved"] == 1
    assert body["insufficientSample"] is True
    assert body["winRate"] is None
    assert body["avgRr"] is None
    assert body["sampleThreshold"] == 10


def test_performance_reports_win_rate_at_threshold(client, db, auth_headers, user, monkeypatch):
    _make_pro(db, user)
    _feed(monkeypatch)
    sid = _new_strategy(client, auth_headers)
    _seed_signals(db, user, sid, ["HIT_TP"] * 6 + ["HIT_SL"] * 4)
    body = client.get(f"/api/strategies/{sid}/performance", headers=auth_headers).json()
    assert body["resolved"] == 10
    assert body["insufficientSample"] is False
    assert body["winRate"] == pytest.approx(0.6)
    assert body["maxLossStreak"] == 4


def test_performance_excludes_pending_and_stale_counts_timeout(client, db, auth_headers, user, monkeypatch):
    """PENDING 与 STALE 不进分母，TIMEOUT 进分母但单列计数（无出场价可判方向）。
    PENDING and STALE stay out of the denominator; TIMEOUT counts in it but is
    tallied separately (no exit price to judge direction)."""
    _make_pro(db, user)
    _feed(monkeypatch)
    sid = _new_strategy(client, auth_headers)
    _seed_signals(db, user, sid, ["HIT_TP", "HIT_SL", "TIMEOUT", "STALE", "PENDING"])
    body = client.get(f"/api/strategies/{sid}/performance", headers=auth_headers).json()
    assert (body["wins"], body["losses"], body["timeouts"]) == (1, 1, 1)
    assert body["resolved"] == 3
    assert body["pending"] == 1


def test_performance_404_for_another_users_strategy(client, db, auth_headers, user):
    """跨用户读绩效返回 404 而不是 403：403 会确认"这个 id 确实存在"。
    Reading another user's performance is a 404, not a 403 — a 403 would confirm
    the id exists."""
    other = UserStrategy(user_id="someone-else", symbol="XAUUSD", interval="15",
                         template="ma_trend", rules=json.dumps(_rules()), params="{}")
    db.add(other)
    db.commit()
    db.refresh(other)
    assert client.get(f"/api/strategies/{other.id}/performance", headers=auth_headers).status_code == 404


def test_another_users_token_cannot_read_or_mutate_my_strategy(client, db, auth_headers, user, monkeypatch):
    """用真实的第二个用户的 token 访问用户 A 的策略：读绩效/改/删一律 404，
    且不会误删 A 的 watch 行。
    With a real second user's token, every access to user A's strategy 404s and
    A's watch rows survive."""
    from app.core.security import create_access_token, generate_api_token, hash_api_token
    from app.models import User

    _make_pro(db, user)
    _feed(monkeypatch)
    sid = _new_strategy(client, auth_headers)

    intruder = User(
        email="intruder@example.com", password_hash="x", plan="PRO",
        api_token=hash_api_token(generate_api_token()),
    )
    db.add(intruder)
    db.commit()
    db.refresh(intruder)
    intruder_headers = {"Authorization": f"Bearer {create_access_token(intruder.id)}"}

    assert client.get(f"/api/strategies/{sid}/performance", headers=intruder_headers).status_code == 404
    assert client.patch(f"/api/strategies/{sid}", headers=intruder_headers, json={"enabled": True}).status_code == 404
    assert client.delete(f"/api/strategies/{sid}", headers=intruder_headers).status_code == 404
    # 入侵者的策略列表里看不到这条，A 的 watch 行也还在。
    # The intruder's list doesn't contain it, and A's watch rows are intact.
    assert client.get("/api/strategies", headers=intruder_headers).json()["strategies"] == []
    assert db.query(StrategyWatch).filter(StrategyWatch.strategy_id == sid).count() == 1
    assert db.query(UserStrategy).filter(UserStrategy.id == sid).first() is not None


def test_performance_only_counts_this_strategys_signals(client, db, auth_headers, user, monkeypatch):
    """同一用户的另一条策略的信号不能算进本策略的绩效。
    Signals from the same user's other strategy mustn't count here."""
    _make_pro(db, user)
    _feed(monkeypatch)
    mine = _new_strategy(client, auth_headers)
    other = _new_strategy(client, auth_headers)
    _seed_signals(db, user, mine, ["HIT_TP", "HIT_SL"])
    _seed_signals(db, user, other, ["HIT_SL"] * 5)
    body = client.get(f"/api/strategies/{mine}/performance", headers=auth_headers).json()
    assert (body["wins"], body["losses"]) == (1, 1)


def _seed_signals_at(db, user, strategy_id, pairs):
    """按 (bar_t 序号, 结果) 显式落库：插入顺序与 bar_t 顺序可以故意不一致，
    用来验证统计是按 bar_t 而不是按 created_at 排序的。
    Insert with an explicit (bar_t index, result) pair so insertion order can
    deliberately differ from bar_t order — that's what pins the ordering key."""
    base = int(datetime.now(timezone.utc).timestamp())
    for idx, r in pairs:
        db.add(StrategySignal(
            strategy_id=strategy_id, user_id=user.id, symbol="XAUUSD", interval="15",
            side="BUY", entry=2000.0, stop_loss=1990.0, take_profit=2020.0,
            bar_t=base + idx * 900, result=r,
            resolved_at=None if r == "PENDING" else datetime.now(timezone.utc),
        ))
    db.commit()


def test_performance_streak_follows_bar_t_not_insertion_order(client, db, auth_headers, user, monkeypatch):
    """连亏按 bar_t 的时间顺序算，不按写库顺序。批量写入时 created_at 会拿到
    相同时间戳，用它排序等于用插入顺序——本例四笔亏损连着插入但在时间上是隔开的，
    按 created_at 排会算出 4，按 bar_t 排才是 1。
    The loss streak follows bar_t, not insertion order. Bulk inserts share a
    created_at timestamp, so ordering by it is really ordering by insertion: here
    the four losses are inserted together but interleaved in time, which reads as
    4 by created_at and 1 by bar_t."""
    _make_pro(db, user)
    _feed(monkeypatch)
    sid = _new_strategy(client, auth_headers)
    _seed_signals_at(db, user, sid, [(i, "HIT_SL") for i in (0, 2, 4, 6)] + [(i, "HIT_TP") for i in (1, 3, 5, 7)])
    body = client.get(f"/api/strategies/{sid}/performance", headers=auth_headers).json()
    assert (body["wins"], body["losses"]) == (4, 4)
    assert body["maxLossStreak"] == 1


def test_performance_streak_only_scans_recent_window(client, db, auth_headers, user, monkeypatch):
    """连亏只扫最近 STREAK_WINDOW 笔已判定信号：窗口之外那段更长的连亏不计入。
    这是明确的口径变更（响应里的 streakWindow 就是为了告知），换来的是绩效查询
    不再随策略历史无界增长。
    The streak scans only the most recent STREAK_WINDOW resolved signals, so an
    older, longer streak outside the window is not counted. That's a deliberate
    change of definition (hence streakWindow in the response) which keeps the
    query from growing without bound as history accumulates."""
    from app.routers.strategies import STREAK_WINDOW

    _make_pro(db, user)
    _feed(monkeypatch)
    sid = _new_strategy(client, auth_headers)
    # 最老 6 笔连亏在窗口之外；窗口内 STREAK_WINDOW 笔的最长连亏是 2。
    # The oldest 6 losses sit outside the window; inside it the longest run is 2.
    old = [(i, "HIT_SL") for i in range(6)]
    recent = [(6 + i, ["HIT_SL", "HIT_SL", "HIT_TP"][i % 3]) for i in range(STREAK_WINDOW)]
    _seed_signals_at(db, user, sid, old + recent)
    body = client.get(f"/api/strategies/{sid}/performance", headers=auth_headers).json()
    assert body["resolved"] == STREAK_WINDOW + 6
    assert body["maxLossStreak"] == 2
    assert body["streakWindow"] == STREAK_WINDOW


def test_performance_exposes_streak_window(client, db, auth_headers, user, monkeypatch):
    """streakWindow 必须出现在响应里：连亏的统计范围有限，不告知等于让前端把
    一个有窗口的数字读成全历史。
    streakWindow must be in the response: the streak is windowed, and hiding that
    lets the frontend read a bounded number as an all-history one."""
    from app.routers.strategies import STREAK_WINDOW

    _make_pro(db, user)
    _feed(monkeypatch)
    sid = _new_strategy(client, auth_headers)
    _seed_signals(db, user, sid, ["HIT_SL", "HIT_SL"])
    body = client.get(f"/api/strategies/{sid}/performance", headers=auth_headers).json()
    assert body["streakWindow"] == STREAK_WINDOW
    assert body["maxLossStreak"] == 2


def test_bulk_performance_returns_every_strategy_of_mine(client, db, auth_headers, user, monkeypatch):
    """批量端点一次返回当前用户的全部策略，口径与单策略端点一致。
    The bulk endpoint returns all of the caller's strategies in one response,
    with the same numbers as the per-strategy endpoint."""
    _make_pro(db, user)
    _feed(monkeypatch)
    a = _new_strategy(client, auth_headers)
    b = _new_strategy(client, auth_headers)
    _seed_signals(db, user, a, ["HIT_TP", "HIT_SL", "TIMEOUT", "STALE", "PENDING"])
    _seed_signals(db, user, b, ["HIT_SL"] * 3)
    res = client.get("/api/strategies/performance", headers=auth_headers)
    assert res.status_code == 200, res.text
    items = {p["strategyId"]: p for p in res.json()["performance"]}
    assert set(items) == {a, b}
    assert (items[a]["wins"], items[a]["losses"], items[a]["timeouts"]) == (1, 1, 1)
    assert (items[a]["resolved"], items[a]["pending"]) == (3, 1)
    assert (items[b]["losses"], items[b]["maxLossStreak"]) == (3, 3)
    assert items[b]["streakWindow"] == 200
    single = client.get(f"/api/strategies/{a}/performance", headers=auth_headers).json()
    for k in ("resolved", "wins", "losses", "timeouts", "pending", "winRate", "avgRr", "maxLossStreak"):
        assert items[a][k] == single[k]


def test_bulk_performance_excludes_other_users_strategies(client, db, auth_headers, user, monkeypatch):
    """批量端点不能带出别人的策略——一个漏掉 user_id 过滤的聚合会把全站绩效
    发给任何一个登录用户。
    The bulk endpoint must not leak other users' strategies: an aggregate missing
    the user_id filter would hand site-wide performance to any logged-in user."""
    _make_pro(db, user)
    _feed(monkeypatch)
    mine = _new_strategy(client, auth_headers)
    other = UserStrategy(user_id="someone-else", symbol="XAUUSD", interval="15",
                         template="ma_trend", rules=json.dumps(_rules()), params="{}")
    db.add(other)
    db.commit()
    db.refresh(other)
    _seed_signals(db, user, mine, ["HIT_TP"])
    _seed_signals(db, user, other.id, ["HIT_SL"] * 4)
    body = client.get("/api/strategies/performance", headers=auth_headers).json()
    assert [p["strategyId"] for p in body["performance"]] == [mine]


# ---------- 预设 AST 暴露与时段过滤清空 / preset exposure & clearing the session filter ----------

def test_templates_endpoint_exposes_preset_conditions(client, auth_headers):
    """前端「从预设起步」要的是预设的条件列表，不是参数定义——参数表单已被条件
    构建器取代。键集合必须与 TEMPLATE_KEYS 一致。

    响应里只有 logic + conditions，没有 symbol / interval：预设与品种周期无关，
    那两项由用户在表单里选，前端补齐后才成为一份完整的 rules。

    The frontend's "start from a preset" needs the preset condition lists, not
    param schemas (the param form is gone, replaced by the condition builder),
    and the key set must match TEMPLATE_KEYS. The response carries only
    logic + conditions: presets are symbol/interval-agnostic, the user picks
    those in the form, and the frontend fills them in to make a complete `rules`.
    """
    res = client.get("/api/strategies/templates", headers=auth_headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body["presets"]) == set(presets.TEMPLATE_KEYS)
    # 补上品种周期后即为合法配置，构建器可直接编辑。
    # Valid once symbol/interval are added, editable by the builder as-is.
    for key in presets.TEMPLATE_KEYS:
        preset = body["presets"][key]
        assert set(preset) == {"logic", "conditions"}
        validate_conditions({**preset, "symbol": "XAUUSD", "interval": "15"})


def test_update_can_clear_session_filter(client, db, auth_headers, user, monkeypatch):
    """显式传 sessionFilter: null 必须真的清掉——「不限制」是前端的一个正常状态，
    用 `is not None` 判断写入会让它永远清不回去。
    An explicit sessionFilter: null must actually clear the column: "no
    restriction" is a normal state in the UI, and an `is not None` write guard
    would make it unreachable once set."""
    _make_pro(db, user)
    _feed(monkeypatch)
    sid = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={
            "rules": _rules(),
            "symbol": "XAUUSD",
            "interval": "15",
            "sessionFilter": {"startHour": 22, "endHour": 2},
        },
    ).json()["id"]
    row = db.query(UserStrategy).filter(UserStrategy.id == sid).first()
    assert json.loads(row.session_filter) == {"startHour": 22, "endHour": 2}

    res = client.patch(f"/api/strategies/{sid}", headers=auth_headers, json={"sessionFilter": None})
    assert res.status_code == 200, res.text
    assert res.json()["sessionFilter"] is None
    db.expire_all()
    assert db.query(UserStrategy).filter(UserStrategy.id == sid).first().session_filter is None


def test_update_without_session_filter_key_keeps_it(client, db, auth_headers, user, monkeypatch):
    """不传该字段时保持原值——清空必须是显式动作，改个名字不该顺手抹掉时段。
    Omitting the field keeps the stored value: clearing has to be explicit, and
    renaming a strategy must not wipe its session."""
    _make_pro(db, user)
    _feed(monkeypatch)
    sid = client.post(
        "/api/strategies",
        headers=auth_headers,
        json={
            "rules": _rules(),
            "symbol": "XAUUSD",
            "interval": "15",
            "sessionFilter": {"startHour": 9, "endHour": 17},
        },
    ).json()["id"]
    client.patch(f"/api/strategies/{sid}", headers=auth_headers, json={"name": "改个名"})
    db.expire_all()
    row = db.query(UserStrategy).filter(UserStrategy.id == sid).first()
    assert json.loads(row.session_filter) == {"startHour": 9, "endHour": 17}
