"""自定义策略引擎：指标数学、条件求值、回测撮合、信号判定、实时求值。

**为什么要测。** services/strategy/ 整套此前零测试，而它直接决定用户看到的回测
胜率与实时信号。indicators.cmp_with_tol 的 docstring 说"本仓库测试实测 period=30
会中招"，但那份测试已不在仓库里——这里把它补回来，并把每个模块最容易静默出错
的点各钉一条：

  · indicators：SMA/EMA/RSI/布林/MACD/ATR/唐奇安的预热期与口径；平盘序列布林
    不抛 ValueError；大价格小波动下布林精度；EMA 残差不被判成穿越。
  · conditions：参数校验与默认值；镜像（RSI 阈值翻 100-level，ATR 无镜像）；
    空条件全 False；两侧同时成立取多头；memo 只算一次；穿越只在越过那根触发。
  · backtest：出场价各方法；同根双触按止损；超时不抢真实出场；零成本时净值
    等于旧公式；含成本更差；一次一单不重叠；样本不足不判过拟合。
  · resolution：首次观测只记基线；此后只认新极值；双触按止损。
  · live：时段过滤（UTC+8、跨零点、脏数据放行）；冷却与日上限；一根 K 线收盘
    真的落一条信号且同根不重复。

The strategy engine had no tests at all; it decides the backtest numbers and
live signals users act on. Each module gets its most silent-failure-prone
behaviour pinned.
"""
import json
import statistics
from datetime import datetime, timedelta, timezone

import pytest

from app.models import Candle, StrategySignal, StrategyWatch, User, UserStrategy
from app.services.strategy import backtest as bt
from app.services.strategy import conditions as cond
from app.services.strategy import costs as ct
from app.services.strategy import indicators as ind
from app.services.strategy import live
from app.services.strategy.resolution import apply_baseline, resolve_strategy_signals


# =============================== indicators ===================================

def test_sma_and_ema_warmup_and_values():
    v = [1.0, 2.0, 3.0, 4.0, 5.0]
    assert ind.sma(v, 3) == [None, None, 2.0, 3.0, 4.0]
    e = ind.ema(v, 3)
    assert e[:2] == [None, None] and e[2] == 2.0
    assert e[3] == pytest.approx(3.0) and e[4] == pytest.approx(4.0)
    assert ind.ema([1.0, 2.0], 3) == [None, None]


def test_rsi_extremes_and_length():
    up = [float(i) for i in range(20)]
    r = ind.rsi(up, 14)
    assert r[:14] == [None] * 14 and all(x == 100.0 for x in r[14:])
    down = up[::-1]
    assert all(x == 0.0 for x in ind.rsi(down, 14)[14:])
    assert ind.rsi([1.0] * 5, 14) == [None] * 5


def test_bollinger_flat_series_does_not_raise_and_collapses():
    upper, middle, lower = ind.bollinger([2000.0] * 30, 20, 2.0)
    assert upper[-1] == middle[-1] == lower[-1] == 2000.0


def test_bollinger_precision_on_large_price_small_moves():
    """金价 2000 上下、窗口内只走几毛钱：与 pstdev 逐窗口精确值比，误差远小于 tick。"""
    closes = [2000.0 + (i % 7) * 0.1 for i in range(60)]
    upper, middle, _ = ind.bollinger(closes, 20, 2.0)
    for i in range(19, 60):
        window = closes[i - 19: i + 1]
        exact = statistics.mean(window) + 2.0 * statistics.pstdev(window)
        assert abs(upper[i] - exact) < 1e-9
        assert abs(middle[i] - statistics.mean(window)) < 1e-9


def test_macd_head_is_none_then_signal_follows():
    v = [float(i) for i in range(60)]
    line, sig = ind.macd(v, 12, 26, 9)
    assert line[24] is None and line[25] is not None
    assert sig[25 + 8] is not None and sig[25 + 7] is None


def test_atr_first_bar_and_wilder_recursion():
    h = [10.0, 12.0, 11.0]
    l = [8.0, 9.0, 9.5]
    c = [9.0, 11.0, 10.0]
    a = ind.atr(h, l, c, 2)
    # TR: 2, max(3, |12-9|=3, |9-9|=0)=3, max(1.5, |11-11|=0, |9.5-11|=1.5)=1.5
    assert a[0] is None and a[1] == 2.5 and a[2] == pytest.approx((2.5 + 1.5) / 2)


def test_donchian_excludes_current_bar():
    highs = [1.0, 5.0, 2.0, 3.0]
    assert ind.donchian_high(highs, 2) == [None, None, 5.0, 5.0]
    assert ind.donchian_low([1.0, 5.0, 2.0, 3.0], 2) == [None, None, 1.0, 2.0]


def test_cmp_with_tol_absorbs_ema_residue_period_30():
    """常数序列上两条 EMA(30) 理论相等；递推残差不能被判成穿越。"""
    const = [100.0] * 200
    a = ind.ema(const, 30)[-1]
    assert ind.cmp_with_tol(a, 100.0) == 0
    assert ind.cmp_with_tol(100.001, 100.0) == 1
    assert ind.cmp_with_tol(99.999, 100.0) == -1


# =============================== conditions ===================================

def _rules(usage, params=None, logic="AND", interval="60", symbol="XAUUSD"):
    ind_name = usage.split(".")[0]
    return {"logic": logic, "interval": interval, "symbol": symbol,
            "conditions": [{"indicator": ind_name, "usage": usage, "params": params or {}}]}


@pytest.mark.parametrize("bad, msg", [
    ({"logic": "XOR", "interval": "60", "symbol": "X", "conditions": [{"indicator": "ma", "usage": "ma.rising"}]}, "logic"),
    ({"logic": "AND", "interval": "7", "symbol": "X", "conditions": [{"indicator": "ma", "usage": "ma.rising"}]}, "周期"),
    ({"logic": "AND", "interval": "60", "symbol": "", "conditions": [{"indicator": "ma", "usage": "ma.rising"}]}, "品种"),
    ({"logic": "AND", "interval": "60", "symbol": "X", "conditions": []}, "至少"),
    ({"logic": "AND", "interval": "60", "symbol": "X", "conditions": [{"indicator": "ma", "usage": "ma.nope"}]}, "未知用法"),
    ({"logic": "AND", "interval": "60", "symbol": "X", "conditions": [{"indicator": "rsi", "usage": "ma.rising"}]}, "属于指标"),
    ({"logic": "AND", "interval": "60", "symbol": "X", "conditions": [{"indicator": "ma", "usage": "ma.rising", "params": {"period": 1}}]}, "不能小于"),
    ({"logic": "AND", "interval": "60", "symbol": "X", "conditions": [{"indicator": "ma", "usage": "ma.rising", "params": {"period": 2.5}}]}, "整数"),
    ({"logic": "AND", "interval": "60", "symbol": "X", "conditions": [{"indicator": "ma", "usage": "ma.rising", "params": {"maType": "WMA"}}]}, "只能是"),
    ({"logic": "AND", "interval": "60", "symbol": "X", "conditions": [{"indicator": "ma", "usage": "ma.rising", "params": {"foo": 1}}]}, "不接受"),
    ({"logic": "AND", "interval": "60", "symbol": "X", "extra": 1, "conditions": [{"indicator": "ma", "usage": "ma.rising"}]}, "不认识"),
])
def test_validate_conditions_rejects(bad, msg):
    with pytest.raises(cond.ConditionError, match=msg):
        cond.validate_conditions(bad)


def test_validate_conditions_caps_count_and_accepts_valid():
    ok = _rules("rsi.below_level", {"period": 14, "level": 30})
    cond.validate_conditions(ok)
    too_many = dict(ok, conditions=ok["conditions"] * (cond.MAX_CONDITIONS + 1))
    with pytest.raises(cond.ConditionError, match="最多"):
        cond.validate_conditions(too_many)


def test_resolve_params_fills_defaults_and_coerces():
    assert cond.resolve_params("ma.rising", {}) == {"maType": "EMA", "period": 20}
    assert cond.resolve_params("rsi.below_level", {"period": "7", "level": 25.0}) == {"period": 7, "level": 25}
    assert cond.resolve_params("bollinger.break_upper", {"mult": 3}) == {"period": 20, "mult": 3.0}


def test_mirror_flips_rsi_level_and_keeps_atr():
    m = cond.mirror_condition({"indicator": "rsi", "usage": "rsi.below_level", "params": {"level": 30}})
    assert m["usage"] == "rsi.above_level" and m["params"]["level"] == 70
    assert cond.mirror_condition({"indicator": "atr", "usage": "atr.volatility_above_average"}) is None
    payload = {"conditions": [
        {"indicator": "ma", "usage": "ma.price_above"},
        {"indicator": "atr", "usage": "atr.volatility_above_average"},
    ]}
    shorts = cond.mirror_conditions(payload)
    assert [c["usage"] for c in shorts] == ["ma.price_below", "atr.volatility_above_average"]


def _cross_bars(n_flat=30, jump=10.0):
    """前 n_flat 根平在 100，最后一根跳到 100+jump：EMA(5) 被价格上穿一次。"""
    bars = [{"t": i * 3600, "o": 100.0, "h": 100.5, "l": 99.5, "c": 100.0, "v": 1} for i in range(n_flat)]
    bars.append({"t": n_flat * 3600, "o": 100.0, "h": 100 + jump, "l": 100.0, "c": 100 + jump, "v": 1})
    return bars


def test_price_cross_above_fires_only_on_the_crossing_bar():
    bars = _cross_bars()
    out = cond.evaluate_conditions(bars, _rules("ma.price_cross_above", {"period": 5, "maType": "EMA"}))
    assert out[-1] == "BUY" and out[:-1].count("BUY") == 0 and "SELL" not in out
    # 再加一根仍在均线上方：不再是"穿越"，只是"在上方"
    bars.append(dict(bars[-1], t=bars[-1]["t"] + 3600))
    out2 = cond.evaluate_conditions(bars, _rules("ma.price_cross_above", {"period": 5}))
    assert out2[-1] is None
    out3 = cond.evaluate_conditions(bars, _rules("ma.price_above", {"period": 5}))
    assert out3[-1] == "BUY"


def test_mirror_gives_sell_on_downward_cross():
    bars = _cross_bars(jump=-10.0)
    out = cond.evaluate_conditions(bars, _rules("ma.price_cross_above", {"period": 5}))
    assert out[-1] == "SELL"


def test_empty_side_is_all_false_and_long_wins_ties():
    bars = _cross_bars()
    assert cond.evaluate_side(bars, [], "AND") == [False] * len(bars)
    # ATR 条件无镜像 → 两侧判定完全一致 → 必须取多头
    n = 80
    bars = [{"t": i, "o": 1.0, "h": 1.0 + (0.5 if i > 60 else 0.1), "l": 1.0, "c": 1.0, "v": 1} for i in range(n)]
    out = cond.evaluate_conditions(bars, _rules("atr.volatility_above_average", {"period": 5, "mult": 1.0}))
    assert "SELL" not in out and "BUY" in out


def test_memo_computes_each_usage_once_per_batch(monkeypatch):
    calls = []
    real = cond._EVALUATORS["rsi.below_level"]
    monkeypatch.setitem(cond._EVALUATORS, "rsi.below_level", lambda b, p: calls.append(1) or real(b, p))
    bars = _cross_bars()
    memo: dict = {}
    r = _rules("rsi.below_level", {"period": 14, "level": 30})
    cond.evaluate_conditions(bars, r, memo=memo)
    cond.evaluate_conditions(bars, r, memo=memo)
    # 多头一次 + 镜像（level=70 是不同键）一次；第二条策略全部命中 memo
    assert len(calls) == 1
    assert ("rsi.below_level", (("level", 30), ("period", 14))) in memo


def test_donchian_new_high_requires_strictly_above_prior_extreme():
    bars = [{"t": i, "o": 1, "h": 10.0, "l": 1, "c": 5.0, "v": 1} for i in range(25)]
    bars.append({"t": 25, "o": 5, "h": 10.0, "l": 1, "c": 10.0, "v": 1})     # 等于前高：不算
    bars.append({"t": 26, "o": 5, "h": 11.0, "l": 1, "c": 10.5, "v": 1})     # 超过：算
    out = cond.evaluate_conditions(bars, _rules("donchian.new_high", {"period": 20}))
    assert out[-2] is None and out[-1] == "BUY"


# =============================== backtest =====================================

def test_exit_prices_by_method():
    spec = bt.ExitSpec("percent", 1.0, "rr", 2.0)
    assert bt.exit_prices("BUY", 2000.0, "XAUUSD", spec) == (1980.0, 2040.0)
    assert bt.exit_prices("SELL", 2000.0, "XAUUSD", spec) == (2020.0, 1960.0)
    steps = bt.ExitSpec("steps", 50, "steps", 100)
    assert bt.exit_prices("BUY", 2000.0, "XAUUSD", steps) == (1999.5, 2001.0)   # 100 以上一点=0.01
    atr = bt.ExitSpec("atr", 1.5, "atr", 3.0)
    assert bt.exit_prices("BUY", 2000.0, "XAUUSD", atr, atr_value=2.0) == (1997.0, 2006.0)
    with pytest.raises(ValueError, match="ATR"):
        bt.exit_prices("BUY", 2000.0, "XAUUSD", atr)
    with pytest.raises(ValueError, match="止损"):
        bt.exit_prices("BUY", 2000.0, "XAUUSD", bt.ExitSpec("fixed", 1, "rr", 2))


def _b(t, o, h, l, c):
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": 1}


def test_resolve_trade_stop_wins_double_touch_and_timeout_is_fallback():
    bars = [_b(0, 100, 101, 99, 100), _b(1, 100, 100.5, 99.5, 100), _b(2, 100, 110, 90, 100)]
    assert bt.resolve_trade(bars, 0, "BUY", 95, 105, None) == ("HIT_SL", 2)
    up = [_b(0, 100, 101, 99, 100), _b(1, 100, 106, 99.5, 105)]
    assert bt.resolve_trade(up, 0, "BUY", 95, 105, None) == ("HIT_TP", 1)
    assert bt.resolve_trade(up, 0, "SELL", 105.5, 95, None) == ("HIT_SL", 1)
    quiet = [_b(i, 100, 100.2, 99.8, 100) for i in range(6)]
    assert bt.resolve_trade(quiet, 0, "BUY", 95, 105, timeout_bars=3) == ("TIMEOUT", 3)
    assert bt.resolve_trade(quiet, 0, "BUY", 95, 105, None) == (None, None)
    # 同根既触及止损又到超时：触及优先
    both = [_b(0, 100, 101, 99, 100), _b(1, 100, 100.2, 99.8, 100), _b(2, 100, 100.2, 99.8, 100), _b(3, 100, 100.2, 94, 95)]
    assert bt.resolve_trade(both, 0, "BUY", 95, 105, timeout_bars=3) == ("HIT_SL", 3)


def _trend_bars(n=200):
    """一段先平后涨的行情：EMA(5) 被上穿后一路上行，能触发止盈。"""
    bars = [_b(i * 3600, 100, 100.5, 99.5, 100) for i in range(40)]
    p = 100.0
    for i in range(40, n):
        p += 0.6
        bars.append(_b(i * 3600, p - 0.6, p + 0.3, p - 0.7, p))
    return bars


def test_run_backtest_zero_costs_matches_fixed_formula_and_costs_hurt():
    bars = _trend_bars()
    rules = _rules("ma.price_above", {"period": 5})
    spec = bt.ExitSpec("percent", 1.0, "rr", 2.0)
    free = bt.run_backtest(bars, rules, spec, symbol="XAUUSD", risk_pct=1.0, capital=1000.0,
                           mode="fixed", costs=ct.SymbolCosts(0, 0, 0))
    assert free["summary"]["wins"] >= 1 and free["totalCost"] == pytest.approx(0.0, abs=1e-6)
    # 零成本：赢 = +risk×rr，输 = -risk（旧公式）。SL/TP 经 round_price 取到分，
    # 出场价相对止损距离有千分之几的量化误差，容差放到 1%。
    for tr in free["trades"]:
        expect = 2.0 if tr["result"] == "HIT_TP" else -1.0
        assert tr["pnlPct"] == pytest.approx(expect, abs=0.01)
    paid = bt.run_backtest(bars, rules, spec, symbol="XAUUSD", risk_pct=1.0, capital=1000.0,
                           mode="fixed", costs=ct.SymbolCosts(spread=0.4, commission_per_lot=0.1, slippage=0.1))
    assert paid["totalCost"] > 0
    assert paid["summary"]["finalEquity"] < paid["withoutCosts"]["summary"]["finalEquity"]
    assert paid["barsUsed"] == len(bars)
    assert paid["inSample"]["barsUsed"] + paid["outOfSample"]["barsUsed"] == len(bars)


def test_run_backtest_one_trade_at_a_time_never_overlaps():
    bars = _trend_bars()
    rules = _rules("ma.price_above", {"period": 5})
    spec = bt.ExitSpec("percent", 0.5, "rr", 1.0)
    r = bt.run_backtest(bars, rules, spec, symbol="XAUUSD", risk_pct=1.0, capital=1000.0,
                        mode="compound", costs=ct.SymbolCosts(0, 0, 0))
    trades = r["trades"]
    assert len(trades) >= 2
    for a, b_ in zip(trades, trades[1:]):
        assert b_["entryTime"] > a["exitTime"]
    many = bt.run_backtest(bars, rules, spec, symbol="XAUUSD", risk_pct=1.0, capital=1000.0,
                           mode="compound", one_trade_at_a_time=False, costs=ct.SymbolCosts(0, 0, 0))
    assert len(many["trades"]) > len(trades)


def test_run_backtest_empty_and_overfit_gate():
    r = bt.run_backtest([], _rules("ma.rising"), bt.ExitSpec("percent", 1, "rr", 2),
                        symbol="X", risk_pct=1, capital=100, mode="fixed")
    assert r["barsUsed"] == 0 and r["overfitRisk"]["insufficientSample"] is True
    small = {"wins": 3, "losses": 2, "winRate": 0.6, "returnPct": 5.0}
    assert bt._overfit_verdict(small, small)["insufficientSample"] is True
    big_in = {"wins": 8, "losses": 2, "winRate": 0.8, "returnPct": 20.0}
    big_out = {"wins": 5, "losses": 5, "winRate": 0.5, "returnPct": 1.0}
    assert bt._overfit_verdict(big_in, big_out) == {"flagged": True, "reason": "winRateDrop", "insufficientSample": False}
    # 胜率只掉 0.10（未到 0.15）但收益翻负 → returnFlip
    flip = {"wins": 7, "losses": 3, "winRate": 0.7, "returnPct": -2.0}
    assert bt._overfit_verdict(big_in, flip)["reason"] == "returnFlip"
    fine = {"wins": 7, "losses": 3, "winRate": 0.7, "returnPct": 3.0}
    assert bt._overfit_verdict(big_in, fine) == {"flagged": False, "reason": None, "insufficientSample": False}


def test_costs_asymmetry_and_rounding():
    c = ct.SymbolCosts(spread=0.2, commission_per_lot=0.0, slippage=0.05)
    assert ct.entry_fill("BUY", 100.0, c) == pytest.approx(100.15)
    assert ct.entry_fill("SELL", 100.0, c) == pytest.approx(99.85)
    assert ct.exit_fill("BUY", 90.0, c, is_stop=True) == pytest.approx(89.95)
    assert ct.exit_fill("BUY", 110.0, c, is_stop=False) == 110.0
    assert ct.round_price(63619.50399999999) == 63619.5
    assert ct.round_price(1.234567891) == 1.2346
    assert ct.round_price(0.12345678) == 0.123457


# =============================== resolution ====================================

class _Sig:
    def __init__(self, side, sl, tp):
        self.side, self.stop_loss, self.take_profit = side, sl, tp
        self.baseline_high = self.baseline_low = None


def test_apply_baseline_first_observation_only_records():
    s = _Sig("BUY", 95.0, 105.0)
    assert apply_baseline(s, 90.0, 110.0) is None        # 双触也不判：这根可能早于信号
    assert (s.baseline_low, s.baseline_high) == (90.0, 110.0)
    assert apply_baseline(s, 91.0, 109.0) is None        # 没有新极值
    assert apply_baseline(s, 91.0, 111.0) == "HIT_TP"


def test_apply_baseline_double_touch_is_stop_and_sell_side():
    s = _Sig("BUY", 95.0, 105.0)
    apply_baseline(s, 99.0, 101.0)
    assert apply_baseline(s, 94.0, 106.0) == "HIT_SL"
    sell = _Sig("SELL", 105.0, 95.0)
    apply_baseline(sell, 99.0, 101.0)
    assert apply_baseline(sell, 94.0, 101.0) == "HIT_TP"
    assert apply_baseline(_Sig("BUY", None, 105.0), 1, 2) is None


# =============================== live =========================================

def _hour_utc8(h):
    """UTC+8 当地 h 点对应的 epoch 秒（2026-07-22）。"""
    return int(datetime(2026, 7, 22, h, tzinfo=live.SESSION_TZ).timestamp())


def test_session_allows_windows_midnight_and_malformed():
    day = json.dumps({"startHour": 9, "endHour": 17})
    assert live.session_allows(day, _hour_utc8(9)) and live.session_allows(day, _hour_utc8(16))
    assert not live.session_allows(day, _hour_utc8(17)) and not live.session_allows(day, _hour_utc8(3))
    night = json.dumps({"startHour": 22, "endHour": 4})
    assert live.session_allows(night, _hour_utc8(23)) and live.session_allows(night, _hour_utc8(3))
    assert not live.session_allows(night, _hour_utc8(12))
    assert live.session_allows(None, 0) and live.session_allows("not json", 0)
    assert live.session_allows(json.dumps({"startHour": 9, "endHour": 9}), _hour_utc8(3))
    assert live.session_allows(json.dumps({"startHour": 30, "endHour": 9}), _hour_utc8(3))


def _user(db):
    u = User(email="s@t.co", api_token="tok_s"); db.add(u); db.commit(); return u


def _strategy(db, u, rules, **kw):
    s = UserStrategy(user_id=u.id, name="t", symbol="XAUUSD", interval="60",
                     rules=json.dumps(rules), enabled=True, **kw)
    db.add(s); db.commit()
    db.add(StrategyWatch(strategy_id=s.id, symbol="XAUUSD", interval="60")); db.commit()
    return s


def test_cooldown_and_daily_cap(db_session):
    u = _user(db_session)
    s = _strategy(db_session, u, _rules("ma.rising"), cooldown_minutes=30, daily_signal_cap=2)
    now = datetime.now(timezone.utc)
    assert not live.cooldown_blocks(db_session, s, now)
    db_session.add(StrategySignal(strategy_id=s.id, user_id=u.id, symbol="XAUUSD", interval="60",
                                  side="BUY", entry=1, stop_loss=0.9, take_profit=1.2, bar_t=1,
                                  created_at=(now - timedelta(minutes=10)).replace(tzinfo=None)))
    db_session.commit()
    assert live.cooldown_blocks(db_session, s, now)
    assert not live.cooldown_blocks(db_session, s, now + timedelta(minutes=25))
    assert not live.daily_cap_reached(db_session, s, now)
    db_session.add(StrategySignal(strategy_id=s.id, user_id=u.id, symbol="XAUUSD", interval="60",
                                  side="BUY", entry=1, stop_loss=0.9, take_profit=1.2, bar_t=2,
                                  created_at=(now - timedelta(minutes=5)).replace(tzinfo=None)))
    db_session.commit()
    assert live.daily_cap_reached(db_session, s, now)


def test_live_evaluation_emits_signal_once_and_resolves(monkeypatch, db_session):
    """一根 K 线收盘：策略触发 → 落一条 StrategySignal + 一条推送；同根再评估不重复；
    下一根摸到止盈 → 判定 HIT_TP。"""
    from sqlalchemy.orm import sessionmaker
    monkeypatch.setattr(live, "SessionLocal", sessionmaker(bind=db_session.get_bind(), autoflush=False))
    u = _user(db_session)
    s = _strategy(db_session, u, _rules("ma.price_cross_above", {"period": 5}),
                  stop_loss_method="percent", stop_loss_value=1.0,
                  take_profit_method="rr", take_profit_value=1.0)
    bars = _cross_bars(n_flat=30, jump=10.0)
    for b in bars:
        db_session.add(Candle(symbol="XAUUSD", interval="60", t=b["t"], o=b["o"], h=b["h"], l=b["l"], c=b["c"], v=1))
    db_session.commit()

    pushes = live._evaluate_sync("XAUUSD", "60")
    assert len(pushes) == 1
    uid, payload, title, body = pushes[0]
    assert uid == u.id and payload["type"] == "STRATEGY_SIGNAL" and payload["data"]["side"] == "BUY"
    db_session.expire_all()
    sigs = db_session.query(StrategySignal).all()
    assert len(sigs) == 1 and sigs[0].bar_t == bars[-1]["t"] and sigs[0].result == "PENDING"
    assert db_session.get(UserStrategy, s.id).last_signal_bar_t == bars[-1]["t"]

    assert live._evaluate_sync("XAUUSD", "60") == []                 # 同根不重复
    db_session.expire_all()
    assert db_session.query(StrategySignal).count() == 1

    # 下一根：先记基线（首次观测），再下一根冲过止盈 → HIT_TP
    sig = db_session.query(StrategySignal).one()
    last_t = bars[-1]["t"]
    db_session.add(Candle(symbol="XAUUSD", interval="60", t=last_t + 3600, o=110, h=110.5, l=109.5, c=110, v=1))
    db_session.commit()
    live._evaluate_sync("XAUUSD", "60")
    db_session.expire_all()
    sig = db_session.query(StrategySignal).one()
    assert sig.result == "PENDING" and sig.baseline_high == 110.5
    db_session.add(Candle(symbol="XAUUSD", interval="60", t=last_t + 7200, o=110, h=sig.take_profit + 1, l=109.5, c=111, v=1))
    db_session.commit()
    live._evaluate_sync("XAUUSD", "60")
    db_session.expire_all()
    assert db_session.query(StrategySignal).one().result == "HIT_TP"


def test_resolve_strategy_signals_timeout_needs_a_prior_observation(db_session):
    u = _user(db_session)
    s = _strategy(db_session, u, _rules("ma.rising"), exit_timeout_bars=2)
    sig = StrategySignal(strategy_id=s.id, user_id=u.id, symbol="XAUUSD", interval="60",
                         side="BUY", entry=100, stop_loss=90, take_profit=120, bar_t=1)
    db_session.add(sig); db_session.commit()
    quiet = {"l": 99.0, "h": 101.0, "c": 100.0}
    assert resolve_strategy_signals(db_session, "XAUUSD", "60", quiet) == []    # 首次观测只记基线，不判超时
    got = resolve_strategy_signals(db_session, "XAUUSD", "60", quiet)          # 第 2 根：bars_held=2 ≥ 2
    assert [g.result for g in got] == ["TIMEOUT"]
    assert resolve_strategy_signals(db_session, "XAUUSD", "60", {"l": 200, "h": 100, "c": 1}) == []  # low>high 跳过
