"""策略信号判定测试：baseline 机制、全量 PENDING、一次一单无关性、TIMEOUT/STALE，
以及"平台信号既有行为不变"的回归保护。

Strategy-signal resolution tests: the baseline mechanism, resolving every
PENDING row, independence from one_trade_at_a_time, TIMEOUT/STALE — plus a
regression guard that the platform-signal path behaves exactly as before.
"""
import json
from datetime import datetime, timedelta, timezone

from app.core.config import settings
from app.models import StrategySignal, UserStrategy
from app.services import signal_resolution as sr
from app.services.strategy import resolution as res
from app.services.strategy.presets import preset_payload
from tests.conftest import make_signal


def _strategy(db, user, **kw):
    symbol = kw.get("symbol", "XAUUSD")
    interval = kw.get("interval", "15")
    row = UserStrategy(
        user_id=user.id,
        template="rsi_reversal",
        symbol=symbol,
        interval=interval,
        rules=json.dumps(preset_payload("rsi_reversal", symbol, interval)),
        one_trade_at_a_time=kw.get("one_trade_at_a_time", True),
        exit_timeout_bars=kw.get("exit_timeout_bars"),
        enabled=True,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _signal(db, strat, user, **kw):
    sig = StrategySignal(
        strategy_id=strat.id,
        user_id=user.id,
        symbol=kw.get("symbol", "XAUUSD"),
        interval=kw.get("interval", "15"),
        side=kw.get("side", "BUY"),
        entry=kw.get("entry", 100.0),
        stop_loss=kw.get("stop_loss", 99.0),
        take_profit=kw.get("take_profit", 102.0),
        bar_t=kw.get("bar_t", 1000),
        baseline_high=kw.get("baseline_high"),
        baseline_low=kw.get("baseline_low"),
        bars_held=kw.get("bars_held", 0),
        created_at=kw.get("created_at", datetime.now(timezone.utc)),
    )
    db.add(sig)
    db.commit()
    db.refresh(sig)
    return sig


def _bar(t=2000, o=100.0, h=100.0, l=100.0, c=100.0):
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": 1.0}


# ---------- baseline 机制 / baseline mechanism ----------

def test_first_observation_only_records_baseline(db, user):
    strat = _strategy(db, user)
    sig = _signal(db, strat, user)
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(h=105.0, l=95.0))
    db.commit()
    db.refresh(sig)
    # 首次观测这根 K 线的高低点足以同时触及 TP 与 SL，但只应记基线、不判定
    assert sig.result == "PENDING"
    assert sig.baseline_high == 105.0
    assert sig.baseline_low == 95.0


def test_price_action_before_the_signal_is_not_counted_as_a_hit(db, user):
    """基线之内的波动不算命中——这正是旧实现系统性高估胜率的成因。
    Movement inside the baseline isn't a hit — the exact flaw that made the old
    implementation overstate win rates."""
    strat = _strategy(db, user)
    sig = _signal(db, strat, user, baseline_high=105.0, baseline_low=95.0)
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(h=103.0, l=98.0))
    db.commit()
    db.refresh(sig)
    assert sig.result == "PENDING"


def test_new_extreme_beyond_baseline_resolves(db, user):
    strat = _strategy(db, user)
    sig = _signal(db, strat, user, baseline_high=101.0, baseline_low=99.5)
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(h=103.0, l=99.6))
    db.commit()
    db.refresh(sig)
    assert sig.result == "HIT_TP"
    assert sig.resolved_at is not None


def test_same_report_double_touch_counts_as_stop_loss(db, user):
    strat = _strategy(db, user)
    sig = _signal(db, strat, user, baseline_high=100.5, baseline_low=99.5)
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(h=103.0, l=98.0))
    db.commit()
    db.refresh(sig)
    assert sig.result == "HIT_SL"


def test_sell_side_baseline_is_mirrored(db, user):
    strat = _strategy(db, user)
    sig = _signal(
        db, strat, user, side="SELL", entry=100.0, stop_loss=101.0, take_profit=98.0,
        baseline_high=100.5, baseline_low=99.5,
    )
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(h=100.4, l=97.0))
    db.commit()
    db.refresh(sig)
    assert sig.result == "HIT_TP"


# ---------- 全量判定与一次一单无关性 / resolve all, regardless of one-trade-at-a-time ----------

def test_all_pending_signals_are_resolved_not_only_the_latest(db, user):
    """旧实现只判定最新一条，历史 PENDING 永不回溯。
    The old implementation resolved only the newest row, leaving history
    permanently PENDING."""
    strat = _strategy(db, user)
    sigs = [
        _signal(db, strat, user, bar_t=1000 + i, baseline_high=100.5, baseline_low=99.5)
        for i in range(3)
    ]
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(h=103.0, l=99.6))
    db.commit()
    for s in sigs:
        db.refresh(s)
        assert s.result == "HIT_TP"


def test_signals_are_resolved_when_one_trade_at_a_time_is_off(db, user):
    """关闭一次一单的策略，其信号同样会被判定出结果（spec 验收标准第 6 条）。
    Signals from a strategy with one_trade_at_a_time off still get resolved."""
    strat = _strategy(db, user, one_trade_at_a_time=False)
    sig = _signal(db, strat, user, baseline_high=100.5, baseline_low=99.5)
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(h=103.0, l=99.6))
    db.commit()
    db.refresh(sig)
    assert sig.result == "HIT_TP"


def test_only_the_matching_symbol_and_interval_are_touched(db, user):
    strat = _strategy(db, user)
    other = _signal(
        db, strat, user, symbol="EURUSD", baseline_high=100.5, baseline_low=99.5
    )
    other_interval = _signal(
        db, strat, user, interval="60", baseline_high=100.5, baseline_low=99.5
    )
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(h=103.0, l=99.6))
    db.commit()
    db.refresh(other)
    db.refresh(other_interval)
    assert other.result == "PENDING"
    assert other_interval.result == "PENDING"


# ---------- 超时与 STALE / timeout and stale ----------

def test_bars_held_increments_on_every_pass(db, user):
    strat = _strategy(db, user)
    sig = _signal(db, strat, user, baseline_high=100.5, baseline_low=99.5)
    for t in (2000, 2900, 3800):
        res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(t=t))
        db.commit()
    db.refresh(sig)
    assert sig.bars_held == 3


def test_timeout_closes_at_the_bar_close_and_records_timeout(db, user):
    strat = _strategy(db, user, exit_timeout_bars=2)
    sig = _signal(db, strat, user, baseline_high=100.5, baseline_low=99.5)
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(t=2000, c=100.2))
    db.commit()
    db.refresh(sig)
    assert sig.result == "PENDING"
    res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(t=2900, c=100.4))
    db.commit()
    db.refresh(sig)
    assert sig.result == "TIMEOUT"
    assert sig.bars_held == 2
    assert sig.resolved_at is not None


def test_timeout_does_not_apply_when_not_configured(db, user):
    strat = _strategy(db, user, exit_timeout_bars=None)
    sig = _signal(db, strat, user, baseline_high=100.5, baseline_low=99.5)
    for t in (2000, 2900, 3800, 4700):
        res.resolve_strategy_signals(db, "XAUUSD", "15", _bar(t=t))
        db.commit()
    db.refresh(sig)
    assert sig.result == "PENDING"


def test_stale_sweep_marks_long_unresolved_signals(db, user):
    strat = _strategy(db, user)
    old = _signal(
        db, strat, user,
        created_at=datetime.now(timezone.utc) - timedelta(days=settings.SIGNAL_STALE_DAYS + 1),
    )
    fresh = _signal(db, strat, user)
    stale = res.sweep_stale_strategy_signals(db)
    db.commit()
    db.refresh(old)
    db.refresh(fresh)
    assert [s.id for s in stale] == [old.id]
    assert old.result == "STALE"
    assert fresh.result == "PENDING"


# ---------- 平台信号回归保护 / platform-signal regression guard ----------

def test_platform_signal_first_observation_still_only_records_baseline(db):
    sig = make_signal(db)
    sr.resolve_signals_with_price(db, "XAUUSD", low=2300.0, high=2400.0)
    db.commit()
    db.refresh(sig)
    assert sig.result == "PENDING"
    assert sig.baseline_high == 2400.0
    assert sig.baseline_low == 2300.0


def test_platform_signal_resolves_on_new_extreme(db):
    sig = make_signal(db)
    sig.baseline_high = 2355.0
    sig.baseline_low = 2345.0
    db.commit()
    resolved = sr.resolve_signals_with_price(db, "XAUUSD", low=2346.0, high=2375.0)
    db.commit()
    db.refresh(sig)
    assert [s.id for s in resolved] == [sig.id]
    assert sig.result == "HIT_TP"


def test_platform_signal_rejects_inverted_low_high(db):
    sig = make_signal(db)
    assert sr.resolve_signals_with_price(db, "XAUUSD", low=2400.0, high=2300.0) == []
    db.refresh(sig)
    assert sig.result == "PENDING"


def test_platform_signal_without_levels_is_skipped(db):
    sig = make_signal(db)
    sig.stop_loss = None
    sig.take_profit = None
    db.commit()
    assert sr.resolve_signals_with_price(db, "XAUUSD", low=2300.0, high=2400.0) == []
