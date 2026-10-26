"""2026-10-26 审计 C 组：策略。

· 自定义策略的 PRO 闸门：PRO 到期后不能再改策略（停用、改名除外），旧策略也不再出新信号。
· 回测允许持仓重叠时，出场查找不再逐根扫描（O(n²)），结果与逐根扫描逐字相同。
· 用户端「策略分析」不统计还能下单的信号（按品种、按方向的 pending 会泄露给 FREE）。

2026-10-26 audit, group C: strategies — the PRO gate covers edits and live
evaluation; overlapping-trade backtests no longer scan quadratically; the user-facing
analysis leaves still-tradeable signals out.
"""
import json
import random
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import sessionmaker

from app.models import Candle, Signal, StrategySignal, StrategyWatch, User, UserStrategy
from app.services.strategy import backtest as bt

SYM = "XAUUSD"
RULES = {"logic": "AND", "interval": "60", "symbol": SYM, "conditions": [
    {"indicator": "ma", "usage": "ma.price_cross_above", "params": {"period": 5}}]}


def _now():
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# 1. PRO 闸门 / the PRO gate
# ---------------------------------------------------------------------------

def _user(db, uid, plan="PRO", expires_at=None):
    u = User(id=uid, email=f"{uid}@t.local", api_token=f"tok-{uid}", plan=plan, plan_expires_at=expires_at)
    db.add(u)
    db.commit()
    return u


def _strategy(db, user):
    s = UserStrategy(user_id=user.id, name="s", symbol=SYM, interval="60", rules=json.dumps(RULES),
                     enabled=True, stop_loss_method="percent", stop_loss_value=1.0,
                     take_profit_method="rr", take_profit_value=1.0)
    db.add(s)
    db.commit()
    db.add(StrategyWatch(strategy_id=s.id, symbol=SYM, interval="60"))
    db.commit()
    return s


def _patch(db, user, sid, **fields):
    from app.routers.strategies import update_strategy
    from app.schemas import StrategyUpdate

    return update_strategy.__wrapped__(request=None, strategy_id=sid, body=StrategyUpdate(**fields),
                                       db=db, user=user)


@pytest.mark.parametrize("fields", [
    {"interval": "60"},
    {"rules": RULES},
    {"stopLossValue": 2.0},
    {"exitTimeoutBars": 5},
    {"cooldownMinutes": 30},
    {"enabled": True},
    {"enabled": False, "stopLossValue": 2.0},
])
def test_downgraded_user_cannot_edit_strategy(db_session, fields):
    user = _user(db_session, "lapsed", plan="FREE")
    s = _strategy(db_session, user)
    with pytest.raises(HTTPException) as exc:
        _patch(db_session, user, s.id, **fields)
    assert exc.value.status_code == 403
    db_session.refresh(s)
    assert s.stop_loss_value == 1.0 and s.exit_timeout_bars is None


def test_downgraded_user_can_still_disable_or_rename(db_session):
    user = _user(db_session, "lapsed", plan="FREE")
    s = _strategy(db_session, user)
    out = _patch(db_session, user, s.id, name="renamed")
    assert out.name == "renamed"
    out = _patch(db_session, user, s.id, enabled=False)
    assert out.enabled is False


def test_pro_user_can_still_edit(db_session):
    user = _user(db_session, "pro")
    s = _strategy(db_session, user)
    out = _patch(db_session, user, s.id, stopLossValue=2.0)
    assert out.stopLossValue == 2.0


def _seed_cross(db):
    base = 1_700_000_000
    bars = [{"t": base + i * 3600, "o": 100, "h": 100.5, "l": 99.5, "c": 100} for i in range(30)]
    bars.append({"t": base + 30 * 3600, "o": 100, "h": 110.5, "l": 99.5, "c": 110})
    for b in bars:
        db.add(Candle(symbol=SYM, interval="60", t=b["t"], o=b["o"], h=b["h"], l=b["l"], c=b["c"], v=1))
    db.commit()


def test_lapsed_users_strategies_fire_no_new_signal(db_session, monkeypatch):
    from app.services.strategy import live

    monkeypatch.setattr(live, "SessionLocal", sessionmaker(bind=db_session.get_bind(), autoflush=False))
    for uid, plan, exp in (
        ("pro", "PRO", _now() + timedelta(days=3)),
        ("forever", "PRO", None),
        ("expired", "PRO", _now() - timedelta(minutes=1)),   # 过期但还没被清扫
        ("free", "FREE", None),                              # 已降级
    ):
        _strategy(db_session, _user(db_session, uid, plan, exp))
    _seed_cross(db_session)

    pushes = live._evaluate_sync(SYM, "60")
    assert sorted(p[0] for p in pushes) == ["forever", "pro"]
    db_session.expire_all()
    assert {s.user_id for s in db_session.query(StrategySignal).all()} == {"forever", "pro"}


def test_open_feature_setting_lets_free_strategies_fire(db_session, monkeypatch):
    """管理员关掉 PRO 专属后，FREE 的策略照常出信号。"""
    from app.services import settings_store
    from app.services.strategy import live

    monkeypatch.setattr(live, "SessionLocal", sessionmaker(bind=db_session.get_bind(), autoflush=False))
    settings_store.save_strategy_settings(db_session, {"pro_only": False})
    db_session.commit()
    monkeypatch.setattr(live, "get_strategy_settings", lambda db: {"pro_only": False})
    _strategy(db_session, _user(db_session, "free", "FREE"))
    _seed_cross(db_session)
    assert [p[0] for p in live._evaluate_sync(SYM, "60")] == ["free"]


# ---------------------------------------------------------------------------
# 2. 回测出场查找 / backtest exit search
# ---------------------------------------------------------------------------

def _random_bars(n, seed):
    rnd = random.Random(seed)
    bars, price = [], 100.0
    for i in range(n):
        o = price
        c = o + rnd.uniform(-1, 1)
        h = max(o, c) + rnd.uniform(0, 1)
        lo = min(o, c) - rnd.uniform(0, 1)
        bars.append({"t": 1_700_000_000 + i * 900, "o": o, "h": h, "l": lo, "c": c})
        price = c
    return bars


@pytest.mark.parametrize("seed", range(5))
def test_indexed_resolution_matches_the_linear_scan(seed):
    rnd = random.Random(seed)
    bars = _random_bars(300, seed)
    index = bt._TouchIndex(bars)
    for _ in range(400):
        i = rnd.randrange(len(bars))
        side = rnd.choice(["BUY", "SELL"])
        entry = bars[i]["c"]
        d_sl, d_tp = rnd.uniform(0.1, 6), rnd.uniform(0.1, 6)
        sl, tp = (entry - d_sl, entry + d_tp) if side == "BUY" else (entry + d_sl, entry - d_tp)
        timeout = rnd.choice([None, 1, 2, 5, 30, 1000])
        assert bt.resolve_trade_indexed(index, i, side, sl, tp, timeout) == \
            bt.resolve_trade(bars, i, side, sl, tp, timeout), (i, side, sl, tp, timeout)


def test_indexed_resolution_handles_double_touch_and_edges():
    bars = [{"t": 0, "o": 100, "h": 100, "l": 100, "c": 100},
            {"t": 1, "o": 100, "h": 110, "l": 90, "c": 100},    # 同根双触 → 止损
            {"t": 2, "o": 100, "h": 100, "l": 100, "c": 100}]
    index = bt._TouchIndex(bars)
    for args in ((0, "BUY", 95, 105, None), (0, "SELL", 105, 95, None), (2, "BUY", 95, 105, None),
                 (1, "BUY", 50, 150, 1), (1, "BUY", 50, 150, 5), (0, "BUY", 50, 150, None)):
        assert bt.resolve_trade_indexed(index, *args) == bt.resolve_trade(bars, *args)


def _rising_bars(n):
    return [{"t": 1_700_000_000 + i * 900, "o": 100 + i, "h": 100.5 + i, "l": 99.5 + i, "c": 100 + i}
            for i in range(n)]


def test_overlapping_backtest_does_no_per_signal_linear_scan(monkeypatch):
    """出场永远够不着、又不设超时：原来每根信号都往后扫到底，工作量随 n² 增长。
    修复后允许重叠时不再调用逐根扫描的 resolve_trade，每笔只做两次对数查询。"""
    rules = {"logic": "AND", "symbol": SYM, "interval": "15", "conditions": [
        {"indicator": "ma", "usage": "ma.price_above", "params": {"maType": "SMA", "period": 2}}]}
    spec = bt.ExitSpec(sl_method="percent", sl_value=1_000_000, tp_method="rr", tp_value=1_000_000,
                       timeout_bars=None)
    scanned = {"bars": 0}
    real = bt.resolve_trade

    def _counting(bars, entry_i, *a):
        scanned["bars"] += len(bars) - entry_i - 1
        return real(bars, entry_i, *a)

    monkeypatch.setattr(bt, "resolve_trade", _counting)
    from app.services.strategy import costs as ct

    zero = ct.SymbolCosts(0.0, 0.0, 0.0)
    monkeypatch.setattr(ct, "symbol_costs", lambda *a, **k: zero, raising=False)

    probes = []
    real_first = bt._TouchIndex._first

    def _counting_first(self, *a):
        probes.append(1)
        return real_first(self, *a)

    monkeypatch.setattr(bt._TouchIndex, "_first", _counting_first)

    counts = {}
    for n in (500, 1000, 2000):
        scanned["bars"] = 0
        probes.clear()
        res = bt.run_backtest(_rising_bars(n), rules, spec, symbol=SYM, risk_pct=1.0, capital=10_000,
                              mode="compound", one_trade_at_a_time=False, costs=zero)
        assert len(res["openPositions"]) >= n - 10
        assert scanned["bars"] == 0, "允许重叠时仍在逐根扫描"
        counts[n] = len(probes)
    # 查询次数与信号数成正比（线性），不是 n²
    assert counts[2000] <= counts[500] * 4 * 1.1


def test_overlapping_backtest_results_match_the_linear_scan(monkeypatch):
    """整套回测结果与「索引换回逐根扫描」逐字相同。"""
    bars = _random_bars(400, 7)
    rules = {"logic": "AND", "symbol": SYM, "interval": "15", "conditions": [
        {"indicator": "ma", "usage": "ma.price_above", "params": {"maType": "SMA", "period": 2}}]}
    spec = bt.ExitSpec(sl_method="percent", sl_value=0.5, tp_method="rr", tp_value=1.5, timeout_bars=20)
    from app.services.strategy import costs as ct

    zero = ct.SymbolCosts(0.0, 0.0, 0.0)

    def _run():
        return bt.run_backtest(bars, rules, spec, symbol=SYM, risk_pct=1.0, capital=10_000,
                               mode="compound", one_trade_at_a_time=False, costs=zero)

    fast = _run()

    class _Scan:
        def __init__(self, b):
            self.bars = b

    real = bt.resolve_trade
    monkeypatch.setattr(bt, "_TouchIndex", _Scan)
    monkeypatch.setattr(bt, "resolve_trade_indexed",
                        lambda idx, i, side, sl, tp, t: real(idx.bars, i, side, sl, tp, t))
    slow = _run()
    assert fast == slow
    assert fast["summary"]["wins"] + fast["summary"]["losses"] > 0


# ---------------------------------------------------------------------------
# 3. 策略分析不统计还能下单的信号 / analysis leaves live signals out
# ---------------------------------------------------------------------------

def _analysis(db, user):
    from app.routers.signals import strategy_analysis

    return strategy_analysis(_user=user, db=db)


def _side_counts(payload, strategy, symbol):
    payload = json.loads(json.dumps(payload, default=str))
    for row in payload["strategies"]:
        if row["strategy"] == strategy:
            for sym in row["symbols"]:
                if sym["symbol"] == symbol:
                    return {k: v["samples"] for k, v in sym["sides"].items()}
    return {"BUY": 0, "SELL": 0}


@pytest.fixture()
def analysis_env(db_session, monkeypatch):
    from app.services import settings_store, shared_cache, strategy_winrate

    settings_store.save_winrate_settings(db_session, {"public_strategies": ["AIFT"]})
    db_session.commit()
    strategy_winrate.reset_row_cache()
    shared_cache.clear_for_tests()
    yield db_session
    strategy_winrate.reset_row_cache()


def _signal(db, created_at, **kw):
    naive = created_at.astimezone(timezone.utc).replace(tzinfo=None)
    s = Signal(source="tradingview", indicator="AIFT", symbol=SYM, side="BUY",
               created_at=naive, expire_at=naive + timedelta(minutes=10), **kw)
    db.add(s)
    db.commit()
    return s


@pytest.mark.parametrize("row_cache", [False, True])
def test_active_signal_is_not_counted_in_analysis(analysis_env, monkeypatch, row_cache):
    from app.services import shared_cache, strategy_winrate

    db = analysis_env
    monkeypatch.setattr(strategy_winrate, "_ROW_CACHE_ENABLED", row_cache)
    free = _user(db, "free", plan="FREE")
    _signal(db, _now(), status="ACTIVE", result=None)

    counts = _side_counts(_analysis(db, free), "AIFT", SYM)
    assert counts.get("BUY", 0) == 0, "还能下单的信号进了按方向的统计"

    # 过了有效期之后照常计入
    _signal(db, _now() - timedelta(minutes=20), status="EXPIRED", result=None)
    shared_cache.clear_for_tests()
    strategy_winrate.reset_row_cache()
    counts = _side_counts(_analysis(db, free), "AIFT", SYM)
    assert counts.get("BUY", 0) == 1


def test_admin_view_still_sees_everything(analysis_env):
    from app.services.strategy_winrate import compute_strategy_session_winrate

    db = analysis_env
    _signal(db, _now(), status="ACTIVE", result=None)
    data = compute_strategy_session_winrate(db, 30)
    assert _side_counts(data, "AIFT", SYM).get("BUY", 0) == 1
