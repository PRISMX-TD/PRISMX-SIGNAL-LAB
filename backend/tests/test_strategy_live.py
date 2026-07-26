"""实时评估测试：候选选取、时段/冷却/每日上限过滤、判定与开仓分离、
单次提交、指标共享。

Live evaluation tests: candidate selection, session/cooldown/daily-cap filters,
separation of resolution from entry, single commit, shared indicators.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

from app.core.database import SessionLocal
from app.models import Candle, StrategySignal, StrategyWatch, UserStrategy
from app.services.strategy import live

# 时段测试统一用 UTC+8 构造小时，与 live.SESSION_TZ 一致。
# Session tests build hours directly in UTC+8, matching live.SESSION_TZ.
TZ8 = timezone(timedelta(hours=8))


def _always_long():
    """恒真的多头规则：收盘价大于 0。
    Always-true long rule: close > 0."""
    return {
        "long": {
            "logic": "AND",
            "children": [
                {
                    "left": {"kind": "price", "field": "close"},
                    "op": "gt",
                    "right": {"kind": "const", "value": 0.0},
                }
            ],
        },
        "short": None,
    }


def _strategy(db, user, rules=None, symbols=("XAUUSD",), intervals=("15",), **kw):
    row = UserStrategy(
        user_id=user.id,
        template="ma_cross",
        symbol=symbols[0],
        interval=intervals[0],
        rules=json.dumps(rules if rules is not None else _always_long()),
        symbols=json.dumps(list(symbols)),
        intervals=json.dumps(list(intervals)),
        stop_loss_method=kw.get("stop_loss_method", "percent"),
        stop_loss_value=kw.get("stop_loss_value", 1.0),
        take_profit_method=kw.get("take_profit_method", "rr"),
        take_profit_value=kw.get("take_profit_value", 2.0),
        one_trade_at_a_time=kw.get("one_trade_at_a_time", True),
        exit_timeout_bars=kw.get("exit_timeout_bars"),
        session_filter=kw.get("session_filter"),
        daily_signal_cap=kw.get("daily_signal_cap"),
        cooldown_minutes=kw.get("cooldown_minutes"),
        enabled=kw.get("enabled", True),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    for s in symbols:
        for i in intervals:
            db.add(StrategyWatch(strategy_id=row.id, symbol=s, interval=i))
    db.commit()
    return row


def _seed_candles(db, symbol="XAUUSD", interval="15", count=60, start_t=1_700_000_000, step=900, price=100.0):
    for i in range(count):
        db.add(Candle(
            symbol=symbol, interval=interval, t=start_t + i * step,
            o=price, h=price + 0.5, l=price - 0.5, c=price, v=1.0,
        ))
    db.commit()
    return start_t + (count - 1) * step


def _run(symbol="XAUUSD", interval="15"):
    asyncio.run(live.evaluate_new_candle(symbol, interval))


# ---------- 时段过滤 / session filter ----------

def test_session_allows_inside_window():
    # UTC+8 的 9 点 = UTC 1 点
    bar_t = int(datetime(2026, 7, 26, 1, 0, tzinfo=timezone.utc).timestamp())
    assert live.session_allows(json.dumps({"startHour": 9, "endHour": 17}), bar_t) is True


def test_session_blocks_outside_window():
    bar_t = int(datetime(2026, 7, 26, 20, 0, tzinfo=timezone.utc).timestamp())  # UTC+8 的 4 点
    assert live.session_allows(json.dumps({"startHour": 9, "endHour": 17}), bar_t) is False


def test_session_window_over_midnight():
    """startHour > endHour 表示跨零点，如 22-04。
    startHour > endHour means the window crosses midnight, e.g. 22-04."""
    f = json.dumps({"startHour": 22, "endHour": 4})
    inside = int(datetime(2026, 7, 26, 15, 0, tzinfo=timezone.utc).timestamp())  # UTC+8 23 点
    outside = int(datetime(2026, 7, 26, 4, 0, tzinfo=timezone.utc).timestamp())  # UTC+8 12 点
    assert live.session_allows(f, inside) is True
    assert live.session_allows(f, outside) is False


def test_session_window_over_midnight_covers_exactly_the_four_hours():
    """22:00-02:00 是左闭右开的 22、23、00、01 四个小时：21 点与 2 点都在窗口外。
    半闭区间写错一端就会多放行或少放行一整个小时，逐小时钉死。

    22:00-02:00 is the half-open set {22, 23, 00, 01}: both 21:00 and 02:00 sit
    outside. Getting either end wrong leaks or mutes a whole hour, so pin every
    hour down."""
    f = json.dumps({"startHour": 22, "endHour": 2})
    allowed = set()
    for hour in range(24):
        bar_t = int(datetime(2026, 7, 26, hour, 0, tzinfo=TZ8).timestamp())
        if live.session_allows(f, bar_t):
            allowed.add(hour)
    assert allowed == {22, 23, 0, 1}


def test_no_session_filter_allows_everything():
    assert live.session_allows(None, 0) is True


def test_malformed_session_filter_allows_everything():
    """脏数据不该静默屏蔽所有信号——那是最难排查的一类"策略不出信号"。
    Dirty data mustn't silently mute every signal: that's the hardest kind of
    "my strategy never fires" to diagnose."""
    assert live.session_allows("not json", 0) is True
    assert live.session_allows(json.dumps({"startHour": "x"}), 0) is True


def test_session_filter_blocks_a_signal_end_to_end(db, user):
    """时段过滤真的挡住整条链路，而不只是纯函数返回 False。
    The filter really gates the whole path, not just the pure function."""
    # 种出的最后一根 K 线开盘时间落在 UTC+8 的哪个小时，就把窗口设成别的小时。
    # Pick a window that excludes whatever UTC+8 hour the last seeded bar opens in.
    last_t = _seed_candles(db)
    bar_hour = datetime.fromtimestamp(last_t, tz=TZ8).hour
    start = (bar_hour + 2) % 24
    end = (bar_hour + 4) % 24
    strat = _strategy(db, user, session_filter=json.dumps({"startHour": start, "endHour": end}))
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 0


# ---------- 候选选取 / candidate selection ----------

def test_fires_a_signal_for_a_watching_enabled_strategy(db, user):
    strat = _strategy(db, user)
    _seed_candles(db)
    _run()
    db.expire_all()
    sigs = db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).all()
    assert len(sigs) == 1
    assert sigs[0].side == "BUY"
    assert sigs[0].interval == "15"
    assert sigs[0].symbol == "XAUUSD"


def test_disabled_strategy_never_fires(db, user):
    strat = _strategy(db, user, enabled=False)
    _seed_candles(db)
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 0


def test_strategy_watching_another_combo_is_not_evaluated(db, user):
    strat = _strategy(db, user, symbols=("EURUSD",), intervals=("60",))
    _seed_candles(db)
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 0


def test_multi_symbol_strategy_fires_per_symbol_independently(db, user):
    """一条策略盯两个品种时，每个品种各自出信号。

    两点必须注意，都是既有 schema 的直接后果，不是本测试的偷懒：
    last_signal_bar_t 是策略级单列（不分品种），所以两个品种的最后一根 K 线
    时间必须不同，否则第二个品种会被去重游标当成"同一根"跳过；一次一单同样
    是策略级开关，开着时第一个品种的 PENDING 会挡住第二个品种。

    One strategy watching two symbols fires on each. Two constraints, both
    direct consequences of the existing schema rather than test shortcuts:
    last_signal_bar_t is a single strategy-level column (not per symbol), so the
    two symbols' last bars must differ in time or the de-dup cursor treats the
    second as "the same bar"; and one-trade-at-a-time is likewise
    strategy-level, so the first symbol's PENDING row would gate the second.
    """
    strat = _strategy(db, user, symbols=("XAUUSD", "EURUSD"), intervals=("15",),
                      one_trade_at_a_time=False)
    _seed_candles(db, symbol="XAUUSD")
    _seed_candles(db, symbol="EURUSD", start_t=1_700_000_000 + 60)
    _run("XAUUSD", "15")
    _run("EURUSD", "15")
    db.expire_all()
    sigs = db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).all()
    assert {s.symbol for s in sigs} == {"XAUUSD", "EURUSD"}


def test_no_watch_rows_means_no_work(db, user):
    """没有任何策略盯这个组合时直接返回，不做多余查询（旧实现的同一保护）。
    Returns immediately when nothing watches this combo (same guard as before)."""
    _seed_candles(db)
    _run()
    db.expire_all()
    assert db.query(StrategySignal).count() == 0


# ---------- 冷却与每日上限 / cooldown and daily cap ----------

def test_cooldown_blocks_a_second_signal_within_the_window(db, user):
    strat = _strategy(db, user, cooldown_minutes=60, one_trade_at_a_time=False)
    last_t = _seed_candles(db, count=60)
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 1
    # 再来一根新收盘 K 线，仍在冷却窗口内
    # Another freshly closed bar, still inside the cooldown window
    db.add(Candle(
        symbol="XAUUSD", interval="15", t=last_t + 900,
        o=100.0, h=100.5, l=99.5, c=100.0, v=1.0,
    ))
    db.commit()
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 1


def test_daily_cap_stops_after_the_configured_count(db, user):
    strat = _strategy(db, user, daily_signal_cap=1, one_trade_at_a_time=False)
    last_t = _seed_candles(db, count=60)
    _run()
    db.add(Candle(
        symbol="XAUUSD", interval="15", t=last_t + 900,
        o=100.0, h=100.5, l=99.5, c=100.0, v=1.0,
    ))
    db.commit()
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 1


def test_same_bar_never_fires_twice(db, user):
    """既有的去重游标：同一根 K 线重复评估不会重复发信号。
    The existing de-dup cursor: re-evaluating one bar never re-fires."""
    strat = _strategy(db, user, one_trade_at_a_time=False)
    _seed_candles(db)
    _run()
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 1


# ---------- 判定与开仓分离 / resolution decoupled from entry ----------

def test_pending_signals_are_resolved_even_when_one_trade_at_a_time_is_off(db, user):
    """关掉一次一单的策略，其信号照样被判定——旧实现把判定嵌在一次一单分支
    里，这类信号会永久 PENDING。

    要两根后续 K 线：resolution.apply_baseline 的首次观测只记录基线、不判定
    （那根 K 线可能早于信号就在形成，高低点不可信），第二根才可能命中。

    A strategy with one-trade-at-a-time off still gets its signals resolved; the
    old code nested resolution inside that branch, leaving them PENDING forever.
    Two follow-up bars are needed: apply_baseline's first observation only
    records the baseline (that bar may predate the signal, so its extremes are
    untrustworthy) and only the second can register a hit.
    """
    strat = _strategy(db, user, one_trade_at_a_time=False)
    last_t = _seed_candles(db, count=60)
    _run()
    db.expire_all()
    sig = db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).first()
    tp = sig.take_profit
    # 第一根只建立基线，第二根直接打穿止盈
    # The first bar only sets the baseline; the second blows through TP
    db.add(Candle(
        symbol="XAUUSD", interval="15", t=last_t + 900,
        o=100.0, h=100.5, l=99.9, c=100.0, v=1.0,
    ))
    db.commit()
    _run()
    db.add(Candle(
        symbol="XAUUSD", interval="15", t=last_t + 1800,
        o=100.0, h=tp + 1.0, l=99.9, c=tp + 0.5, v=1.0,
    ))
    db.commit()
    _run()
    db.expire_all()
    db.refresh(sig)
    assert sig.result == "HIT_TP"


def test_one_trade_at_a_time_blocks_new_entry_while_pending(db, user):
    strat = _strategy(db, user, one_trade_at_a_time=True)
    last_t = _seed_candles(db, count=60)
    _run()
    db.add(Candle(
        symbol="XAUUSD", interval="15", t=last_t + 900,
        o=100.0, h=100.5, l=99.5, c=100.0, v=1.0,
    ))
    db.commit()
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 1


# ---------- 事务与推送 / transaction and push ----------

def _count_commits(monkeypatch, counter):
    """把 live 用的会话工厂换成"统计 commit 次数"的版本。
    Swap live's session factory for one that counts commits."""
    real_factory = live.SessionLocal

    def factory():
        session = real_factory()
        real_commit = session.commit

        def commit(*a, **kw):
            counter["n"] += 1
            return real_commit(*a, **kw)

        session.commit = commit
        return session

    monkeypatch.setattr(live, "SessionLocal", factory)


def test_one_evaluation_commits_exactly_once(db, user, monkeypatch):
    """三条策略同时触发也只提交一次：信号与游标更新必须是同一个事务，否则
    中途异常会留下"信号已写、游标未更新"的半状态（下一根重复触发）。

    Three strategies firing at once still commit once: the signals and their
    cursor updates have to be one transaction, otherwise a mid-loop failure
    leaves "signal written, cursor not" behind and the next bar re-fires."""
    commits = {"n": 0}
    _count_commits(monkeypatch, commits)
    for _ in range(3):
        _strategy(db, user, one_trade_at_a_time=False)
    _seed_candles(db)
    _run()
    db.expire_all()
    assert db.query(StrategySignal).count() == 3
    assert commits["n"] == 1


def test_pushes_happen_after_the_commit(db, user, monkeypatch):
    """推送时信号必须已经落库：用另一个连接（新会话）去查，看得到才算已提交。
    未提交的写在别的会话里读不到，所以这条断言真正锁死了"提交在推送之前"。

    By push time the signal must already be committed: a *separate* session can
    only see it if the transaction closed. Uncommitted writes are invisible to
    other sessions, so this pins the commit-before-push ordering."""
    seen: list[int] = []

    async def _record_ws(user_id, payload):
        probe = SessionLocal()
        try:
            seen.append(probe.query(StrategySignal).count())
        finally:
            probe.close()

    async def _record_event(user_id, event_type, title, body):
        probe = SessionLocal()
        try:
            seen.append(probe.query(StrategySignal).count())
        finally:
            probe.close()

    monkeypatch.setattr(live.manager, "push_to_client", _record_ws)
    monkeypatch.setattr(live, "dispatch_event_push_async", _record_event)
    strat = _strategy(db, user)
    _seed_candles(db)
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 1
    # 两次推送（WebSocket + 事件通知）都在提交之后发生
    # Both pushes (WebSocket + event notification) happened after the commit
    assert seen == [1, 1]


def test_a_failing_push_does_not_roll_back_the_signal(db, user, monkeypatch):
    """推送失败不回滚：信号已落库，用户仍能在页面看到。
    A failed push doesn't roll back: the signal is stored and still visible."""
    async def _boom(*a, **kw):
        raise RuntimeError("push down")

    monkeypatch.setattr(live.manager, "push_to_client", _boom)
    strat = _strategy(db, user)
    _seed_candles(db)
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == strat.id).count() == 1


def test_a_failing_websocket_push_still_sends_the_notification(db, user, monkeypatch):
    """两条推送互不影响：WebSocket 挂了，通知照发。
    The two pushes are independent: a dead WebSocket doesn't mute the
    notification."""
    events: list[str] = []

    async def _boom(*a, **kw):
        raise RuntimeError("push down")

    async def _record_event(user_id, event_type, title, body):
        events.append(event_type)

    monkeypatch.setattr(live.manager, "push_to_client", _boom)
    monkeypatch.setattr(live, "dispatch_event_push_async", _record_event)
    _strategy(db, user)
    _seed_candles(db)
    _run()
    assert events == [live.EVENT_STRATEGY_SIGNAL]


def test_one_strategy_raising_does_not_prevent_others_from_firing(db, user, monkeypatch):
    """一条策略的脏数据不该拖垮同组合下其他策略。
    One strategy's dirty data mustn't take down the others on the same combo."""
    bad = _strategy(db, user)
    bad.rules = "not json"
    db.commit()
    good = _strategy(db, user)
    _seed_candles(db)
    _run()
    db.expire_all()
    assert db.query(StrategySignal).filter(StrategySignal.strategy_id == good.id).count() == 1


def test_indicator_results_are_shared_across_strategies(db, user, monkeypatch):
    """同 (品种, 周期) 下多策略用同一套指标参数时只算一次。
    Strategies on the same (symbol, interval) sharing indicator params compute
    once."""
    from app.services.strategy import rules as rl

    calls = {"n": 0}
    real_ema = rl.ind.ema

    def counting_ema(values, period):
        calls["n"] += 1
        return real_ema(values, period)

    # 打桩点是 rules.ind（指标真正被调用的地方），不是 live 自己的引用。
    # Patch rules.ind — where the indicator is actually called — not live's own
    # reference.
    monkeypatch.setattr(rl.ind, "ema", counting_ema)
    rules = {
        "long": {
            "logic": "AND",
            "children": [
                {
                    "left": {"kind": "indicator", "fn": "ema", "params": {"period": 5}},
                    "op": "gt",
                    "right": {"kind": "const", "value": 0.0},
                }
            ],
        },
        "short": None,
    }
    for _ in range(3):
        _strategy(db, user, rules=rules)
    _seed_candles(db)
    _run()
    assert calls["n"] == 1
