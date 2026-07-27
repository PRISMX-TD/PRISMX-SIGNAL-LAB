"""覆盖度统计与断档检测测试。
Coverage statistics and gap-detection tests."""
from app.models import Candle
from app.services import quotes_store
from app.services.strategy import coverage as cv


def _seed(db, symbol="XAUUSD", interval="15", start_t=0, count=10, step=900, skip=()):
    for i in range(count):
        if i in skip:
            continue
        db.add(Candle(
            symbol=symbol, interval=interval, t=start_t + i * step,
            o=100.0, h=101.0, l=99.0, c=100.5, v=1.0,
        ))
    db.commit()


def test_reports_bar_count_and_earliest_time(db):
    _seed(db, count=10, start_t=90_000)
    c = cv.coverage_for(db, "XAUUSD", "15")
    assert c["bars"] == 10
    assert c["earliestT"] == 90_000
    assert c["latestT"] == 90_000 + 9 * 900


def test_empty_series_reports_zero_and_nulls(db):
    c = cv.coverage_for(db, "NOSUCHSYM", "15")
    assert c["bars"] == 0
    assert c["earliestT"] is None
    assert c["latestT"] is None
    assert c["spanDays"] == 0.0
    assert c["gapCount"] == 0
    assert c["missingSeconds"] == 0


def test_contiguous_series_has_no_gaps(db):
    _seed(db, count=20)
    c = cv.coverage_for(db, "XAUUSD", "15")
    assert c["gapCount"] == 0
    assert c["missingSeconds"] == 0


def test_single_missing_bar_is_detected_as_one_gap(db):
    # 20 根里挖掉第 5 根：第 4 到第 6 之间跨了 2 个周期，缺 1 根 = 900 秒
    # One bar removed from 20: the step spans 2 intervals, 1 bar = 900s missing
    _seed(db, count=20, skip=(5,))
    c = cv.coverage_for(db, "XAUUSD", "15")
    assert c["bars"] == 19
    assert c["gapCount"] == 1
    assert c["missingSeconds"] == 900


def test_multiple_gaps_are_summed(db):
    _seed(db, count=30, skip=(5, 6, 15))
    c = cv.coverage_for(db, "XAUUSD", "15")
    assert c["gapCount"] == 2
    assert c["missingSeconds"] == 3 * 900


def test_weekend_sized_gap_is_reported_not_hidden(db):
    """周末休市也会被记为断档：本端点报的是"数据有多完整"这一事实，不替用户
    判断哪些缺失是正常的——前端按缺失时长自行呈现。
    A weekend shows up as a gap too: this endpoint reports how complete the data
    is, it doesn't decide which absences are normal."""
    _seed(db, count=5, start_t=0)
    _seed(db, count=5, start_t=5 * 900 + 2 * 86_400)
    c = cv.coverage_for(db, "XAUUSD", "15")
    assert c["gapCount"] == 1
    assert c["missingSeconds"] > 86_400


def test_span_days_reflects_earliest_to_latest(db):
    _seed(db, count=2, start_t=0, step=86_400)
    c = cv.coverage_for(db, "XAUUSD", "15")
    assert c["spanDays"] == 1.0


def test_feed_active_reflects_quotes_store(db):
    quotes_store._quotes.clear()
    assert cv.coverage_for(db, "XAUUSD", "15")["feedActive"] is False
    quotes_store._quotes["XAUUSD"] = {"symbol": "XAUUSD", "bid": 2400.0, "ask": 2400.5, "digits": 2}
    quotes_store._updated_at["XAUUSD"] = __import__("time").time()
    assert cv.coverage_for(db, "XAUUSD", "15")["feedActive"] is True
    quotes_store._quotes.clear()
    quotes_store._updated_at.clear()


def test_matrix_covers_every_combination(db):
    _seed(db, symbol="XAUUSD", interval="15", count=5)
    _seed(db, symbol="EURUSD", interval="60", count=5, step=3600)
    rows = cv.coverage_matrix(db, ["XAUUSD", "EURUSD"], ["15", "60"])
    assert len(rows) == 4
    by_key = {(r["symbol"], r["interval"]): r for r in rows}
    assert by_key[("XAUUSD", "15")]["bars"] == 5
    assert by_key[("XAUUSD", "60")]["bars"] == 0
    assert by_key[("EURUSD", "60")]["bars"] == 5


def test_unknown_interval_raises_value_error(db):
    import pytest

    with pytest.raises(ValueError):
        cv.coverage_for(db, "XAUUSD", "7")


# ---------- 端点 / endpoint ----------

def test_coverage_endpoint_returns_rows(client, db, auth_headers, user):
    user.plan = "PRO"
    db.commit()
    _seed(db, count=8)
    res = client.get("/api/strategies/coverage?symbols=XAUUSD&intervals=15", headers=auth_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["coverage"][0]["bars"] == 8
    assert "activeSymbols" in body


def test_coverage_endpoint_rejects_unknown_interval(client, db, auth_headers, user):
    user.plan = "PRO"
    db.commit()
    res = client.get("/api/strategies/coverage?symbols=XAUUSD&intervals=7", headers=auth_headers)
    assert res.status_code == 400


def test_coverage_endpoint_requires_auth(client, db):
    assert client.get("/api/strategies/coverage").status_code in (401, 403)


def test_coverage_endpoint_defaults_to_all_active_symbols(client, db, auth_headers, user, monkeypatch):
    """不传 symbols 时必须能查全部已接入品种，即使数量超过单条策略的品种上限。

    生产上线时这里 400 了：平台接入 7 个品种，而端点拿 MAX_SYMBOLS（单条策略最多
    盯 5 个品种，用途是控制实时评估的计算量）去卡这个只读聚合查询，导致默认分支
    在品种数 > 5 时永远失败。覆盖度的用途正是"把未接入品种置灰"，天然要看全部。
    原有端点测试全部显式传 symbols=XAUUSD，从未走到这条默认分支。

    Omitting symbols must return every fed symbol, even when there are more than
    one strategy may watch. This 400'd in production: with 7 fed symbols, the
    endpoint applied MAX_SYMBOLS (a per-strategy watch cap that exists to bound
    live-evaluation cost) to a read-only aggregate, so the default branch always
    failed past 5 symbols. Greying out unfed symbols inherently needs them all.
    The pre-existing endpoint tests all passed symbols=XAUUSD explicitly and
    never reached this branch.
    """
    user.plan = "PRO"
    db.commit()
    seven = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD", "EURGBP", "AUDUSD"]
    monkeypatch.setattr("app.routers.strategies.active_symbols", lambda: seven)
    _seed(db, count=8)
    res = client.get("/api/strategies/coverage?intervals=15", headers=auth_headers)
    assert res.status_code == 200
    assert {r["symbol"] for r in res.json()["coverage"]} == set(seven)


def test_coverage_endpoint_still_caps_an_explicit_symbol_list(client, db, auth_headers, user):
    """放开默认分支后，显式传入的清单仍要有防滥用上限。
    The anti-abuse cap must still apply to an explicitly requested list."""
    user.plan = "PRO"
    db.commit()
    too_many = ",".join(f"SYM{i}" for i in range(cv.MAX_COVERAGE_SYMBOLS + 1))
    res = client.get(f"/api/strategies/coverage?symbols={too_many}", headers=auth_headers)
    assert res.status_code == 400
    assert str(cv.MAX_COVERAGE_SYMBOLS) in res.json()["detail"]


# ---------- 缺口容差边界 / gap tolerance boundary ----------
# 缺口判定是"间隔严格大于 1.5 个周期"。这个边界在断档检测下推到 SQL 时最容易被
# 写错（严格大于写成大于等于、或整数运算被翻译成浮点），而上面的测试都用整倍数
# 的间隔，跨不到边界上。两条测试把边界的两侧各钉一次。
# The gap rule is "a step strictly greater than 1.5 intervals". This boundary is
# the easiest thing to get wrong when the check runs in SQL (strict > becoming
# >=, or integer arithmetic compiled to floating point), and the tests above all
# use whole-multiple steps that never land on it. These two pin either side.

def test_step_exactly_at_tolerance_is_not_a_gap(db):
    """步长恰好等于 1.5 个周期（900 × 1.5 = 1350 秒）：严格大于的判定下不算缺口。
    A step of exactly 1.5 intervals (900 × 1.5 = 1350s): not a gap under strict
    greater-than."""
    db.add_all([
        Candle(symbol="XAUUSD", interval="15", t=0, o=1.0, h=1.0, l=1.0, c=1.0, v=1.0),
        Candle(symbol="XAUUSD", interval="15", t=1350, o=1.0, h=1.0, l=1.0, c=1.0, v=1.0),
    ])
    db.commit()
    cov = cv.coverage_for(db, "XAUUSD", "15")
    assert cov["gapCount"] == 0
    assert cov["missingSeconds"] == 0


def test_step_one_second_past_tolerance_is_a_gap(db):
    """步长比 1.5 个周期多 1 秒：算一个缺口，缺失时长按整数根计为 900 秒。
    One second past 1.5 intervals: one gap, and missing time floors to one whole
    bar (900s)."""
    db.add_all([
        Candle(symbol="XAUUSD", interval="15", t=0, o=1.0, h=1.0, l=1.0, c=1.0, v=1.0),
        Candle(symbol="XAUUSD", interval="15", t=1351, o=1.0, h=1.0, l=1.0, c=1.0, v=1.0),
    ])
    db.commit()
    cov = cv.coverage_for(db, "XAUUSD", "15")
    assert cov["gapCount"] == 1
    # 整数除法向下取整：1351 // 900 = 1，减 1 得 0，再乘 900 得 0 秒。这个 0 正是
    # 断言的重点——若整数除法被翻译成浮点，会得到 451 之类的非整数结果。
    # Integer division floors: 1351 // 900 = 1, minus 1 is 0, times 900 is 0s. That
    # zero is the point of the assertion — compiled to floating point it would
    # yield a fractional result instead.
    assert cov["missingSeconds"] == 0


def test_matrix_evaluates_active_symbols_once(db, monkeypatch):
    """一次矩阵调用只问一次"哪些品种在推"。

    此前每个 (品种, 周期) 组合各问一次（7 品种 × 6 周期 = 42 次）。省开销是次要的，
    要紧的是一致性：同一份响应里的 42 行必须对"这个品种是否在推"给出同一个答案，
    否则 30 秒判定窗口正好在遍历中途翻转时，响应内部会自相矛盾。

    One matrix call asks "which symbols are fed" exactly once. It used to ask per
    (symbol, interval) pair — 42 times for 7 symbols by 6 intervals. Saving the
    work is secondary to consistency: all 42 rows in one response must agree on
    whether a symbol is fed, or a 30-second window flipping mid-iteration would
    make the response contradict itself.
    """
    calls = []
    monkeypatch.setattr(cv, "active_symbols", lambda: calls.append(1) or ["XAUUSD"])
    rows = cv.coverage_matrix(db, ["XAUUSD", "EURUSD"], ["15", "60"])
    assert len(rows) == 4
    assert len(calls) == 1
    # 判定结果本身仍要正确：只有 XAUUSD 在推。
    # The verdict itself must still be right: only XAUUSD is fed.
    assert all(r["feedActive"] is (r["symbol"] == "XAUUSD") for r in rows)


# ---------- 品种名单（候选集）/ symbol candidates ----------

def test_symbols_with_history_lists_distinct_symbols(db):
    cv.invalidate_symbols_cache()
    _seed(db, symbol="XAUUSD", interval="15", count=3)
    _seed(db, symbol="XAUUSD", interval="60", count=3, step=3600)
    _seed(db, symbol="EURUSD", interval="15", count=3)
    assert cv.symbols_with_history(db) == ["EURUSD", "XAUUSD"]


def test_symbols_with_history_empty_table(db):
    cv.invalidate_symbols_cache()
    assert cv.symbols_with_history(db) == []


def test_symbols_with_history_is_cached_within_ttl(db):
    """TTL 内不重复查库：这个端点在每次进入策略页时都会被调用。
    No repeat query within the TTL: this is hit on every visit to the page."""
    cv.invalidate_symbols_cache()
    _seed(db, symbol="XAUUSD", interval="15", count=3)
    assert cv.symbols_with_history(db) == ["XAUUSD"]
    # 缓存生效期间新写入的品种不应出现——正是"命中了缓存"的证据。
    # A symbol written while the cache is warm must not appear — that is the
    # evidence the cache was used.
    _seed(db, symbol="EURUSD", interval="15", count=3)
    assert cv.symbols_with_history(db) == ["XAUUSD"]
    cv.invalidate_symbols_cache()
    assert cv.symbols_with_history(db) == ["EURUSD", "XAUUSD"]
