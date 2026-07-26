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
