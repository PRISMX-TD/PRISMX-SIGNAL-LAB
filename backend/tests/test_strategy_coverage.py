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


# ---------- 新旧实现对照（迁移期临时测试，验证通过后删除）----------
# Old-vs-new parity (temporary, delete once verified).

def _coverage_for_python(db, symbol: str, interval: str) -> dict:
    """迁移前的 Python 实现，原样保留作为精度参照。
    The pre-migration Python implementation, kept verbatim as the accuracy
    reference."""
    from app.models import Candle
    from app.services.candle_store import INTERVAL_SECONDS

    seconds = INTERVAL_SECONDS[interval]
    times = [
        row[0]
        for row in db.query(Candle.t)
        .filter(Candle.symbol == symbol, Candle.interval == interval)
        .order_by(Candle.t.asc())
        .all()
    ]
    if not times:
        return {"bars": 0, "earliestT": None, "latestT": None,
                "spanDays": 0.0, "gapCount": 0, "missingSeconds": 0}
    threshold = seconds * cv.GAP_TOLERANCE_MULTIPLIER
    gap_count = 0
    missing_seconds = 0
    for prev, cur in zip(times, times[1:]):
        step = cur - prev
        if step > threshold:
            gap_count += 1
            missing_seconds += (step // seconds - 1) * seconds
    return {
        "bars": len(times), "earliestT": times[0], "latestT": times[-1],
        "spanDays": (times[-1] - times[0]) / 86_400,
        "gapCount": gap_count, "missingSeconds": int(missing_seconds),
    }


COMPARED_FIELDS = ("bars", "earliestT", "latestT", "spanDays", "gapCount", "missingSeconds")


def _assert_parity(db, symbol="XAUUSD", interval="15"):
    new = cv.coverage_for(db, symbol, interval)
    old = _coverage_for_python(db, symbol, interval)
    for field in COMPARED_FIELDS:
        assert new[field] == old[field], f"{field}: SQL={new[field]!r} Python={old[field]!r}"


def test_parity_contiguous(db):
    _seed(db, count=50)
    _assert_parity(db)


def test_parity_single_missing_bar(db):
    _seed(db, count=50, skip=(7,))
    _assert_parity(db)


def test_parity_many_scattered_gaps(db):
    _seed(db, count=200, skip=(3, 4, 5, 40, 41, 99, 150, 151, 152, 153))
    _assert_parity(db)


def test_parity_weekend_sized_gap(db):
    _seed(db, count=20, start_t=0)
    _seed(db, count=20, start_t=20 * 900 + 2 * 86_400)
    _assert_parity(db)


def test_parity_empty_series(db):
    _assert_parity(db, symbol="NOSUCHSYM")


def test_parity_single_bar(db):
    """只有一根：没有相邻对，缺口必须为 0，span 为 0.0。
    A single bar: no adjacent pair, so zero gaps and a 0.0 span."""
    _seed(db, count=1)
    _assert_parity(db)


def test_parity_exactly_at_tolerance_boundary(db):
    """步长恰好等于 1.5 个周期：严格大于的判定下不算缺口。这是整个迁移最容易
    写错的一处，单独立测。
    A step of exactly 1.5 intervals: not a gap under strict greater-than. The
    single easiest thing to get wrong in this migration, so it gets its own test.
    """
    db.add_all([
        Candle(symbol="XAUUSD", interval="15", t=0, o=1.0, h=1.0, l=1.0, c=1.0, v=1.0),
        Candle(symbol="XAUUSD", interval="15", t=1350, o=1.0, h=1.0, l=1.0, c=1.0, v=1.0),
    ])
    db.commit()
    assert cv.coverage_for(db, "XAUUSD", "15")["gapCount"] == 0
    _assert_parity(db)


def test_parity_just_past_tolerance_boundary(db):
    """步长比 1.5 个周期多 1 秒：算一个缺口。与上一条共同钉住边界。
    One second past 1.5 intervals: one gap. Pins the boundary with the test
    above."""
    db.add_all([
        Candle(symbol="XAUUSD", interval="15", t=0, o=1.0, h=1.0, l=1.0, c=1.0, v=1.0),
        Candle(symbol="XAUUSD", interval="15", t=1351, o=1.0, h=1.0, l=1.0, c=1.0, v=1.0),
    ])
    db.commit()
    assert cv.coverage_for(db, "XAUUSD", "15")["gapCount"] == 1
    _assert_parity(db)


def test_parity_all_intervals(db):
    """六档周期各跑一遍：周期秒数进了 SQL 的算式，逐档验证。
    All six intervals: the interval's second count enters the SQL arithmetic, so
    verify each one."""
    from app.services.candle_store import INTERVAL_SECONDS

    for itv, secs in INTERVAL_SECONDS.items():
        _seed(db, symbol="EURUSD", interval=itv, count=30, step=secs, skip=(4, 9, 10))
        _assert_parity(db, symbol="EURUSD", interval=itv)
