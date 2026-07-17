"""历史信号回放（模拟器）的单测：净值算法、汇总口径、取样过滤、参数校验、
缓存的本金线性缩放。

Unit tests for the historical signal replay (simulator): the equity algorithm,
summary metrics, sampling filters, parameter validation, and the cache's
capital linear-scaling.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.core.security import create_access_token, generate_api_token, hash_api_token
from app.models import Signal, User
from app.routers import signals as signals_router


@pytest.fixture(autouse=True)
def _reset_sim_cache():
    """回放缓存是进程级全局变量，不随每个测试的 `db` fixture（drop_all + 重建）
    一起清空；显式清掉，避免上一个测试的结果被下一个测试命中。
    The replay cache is a process-wide global, not reset by each test's `db`
    fixture (drop_all + recreate); clear it explicitly so one test's result
    can't be served to the next.
    """
    signals_router._sim_cache.clear()
    yield
    signals_router._sim_cache.clear()


def _admin_headers(db):
    admin = User(
        email="simadmin@example.com",
        password_hash="x",
        api_token=hash_api_token(generate_api_token()),
        role="admin",
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return {"Authorization": f"Bearer {create_access_token(admin.id)}"}


def _signal(db, result, rr=2.0, minutes_ago=60, source="tradingview",
            entry=100.0, stop_loss=99.0, symbol="XAUUSD"):
    """造一条已判定的信号。rr 通过止盈距离表达：|tp-entry| = rr × |entry-sl|。
    Build one resolved signal; rr is expressed via the TP distance."""
    created = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    risk_dist = abs(entry - stop_loss)
    s = Signal(
        symbol=symbol,
        side="BUY",
        entry=entry,
        stop_loss=stop_loss,
        take_profit=entry + rr * risk_dist if risk_dist else None,
        indicator="test",
        source=source,
        status="EXPIRED",
        created_at=created,
        expire_at=created + timedelta(minutes=10),
        result=result,
        resolved_at=created + timedelta(minutes=30),
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _run(client, headers, **params):
    qs = {"days": 90, "risk": 1.0, "capital": 10000, "mode": "compound", **params}
    query = "&".join(f"{k}={v}" for k, v in qs.items())
    return client.get(f"/api/signals/simulate?{query}", headers=headers)


def test_empty_data(client, db):
    headers = _admin_headers(db)
    res = _run(client, headers)
    assert res.status_code == 200
    body = res.json()
    assert body["points"] == []
    assert body["trades"] == []
    s = body["summary"]
    assert s["wins"] == 0 and s["losses"] == 0 and s["skipped"] == 0
    assert s["winRate"] is None and s["avgRr"] is None
    assert s["finalEquity"] == 10000  # 没有交易 → 净值 = 本金 / no trades → equity = capital
    assert s["busted"] is False


def test_compound_equity_math(client, db):
    headers = _admin_headers(db)
    # 时间顺序：TP(rr=2) → TP(rr=2) → SL；risk=1% → +2%, +2%, -1%
    _signal(db, "HIT_TP", rr=2.0, minutes_ago=300)
    _signal(db, "HIT_TP", rr=2.0, minutes_ago=200)
    _signal(db, "HIT_SL", rr=2.0, minutes_ago=100)

    body = _run(client, headers, mode="compound").json()
    expected = 10000 * 1.02 * 1.02 * 0.99
    assert body["summary"]["finalEquity"] == pytest.approx(expected)
    assert body["summary"]["wins"] == 2
    assert body["summary"]["losses"] == 1
    assert body["summary"]["winRate"] == pytest.approx(2 / 3)
    assert body["summary"]["avgRr"] == pytest.approx(2.0)
    assert len(body["points"]) == 3
    assert body["points"][0]["equity"] == pytest.approx(10000 * 1.02)


def test_flat_equity_math(client, db):
    headers = _admin_headers(db)
    _signal(db, "HIT_TP", rr=2.0, minutes_ago=300)
    _signal(db, "HIT_TP", rr=2.0, minutes_ago=200)
    _signal(db, "HIT_SL", rr=2.0, minutes_ago=100)

    body = _run(client, headers, mode="flat").json()
    # 等额：每单按初始本金算 → +200, +200, -100
    expected = 10000 * (1 + 0.02 + 0.02 - 0.01)
    assert body["summary"]["finalEquity"] == pytest.approx(expected)


def test_drawdown_and_loss_streak(client, db):
    headers = _admin_headers(db)
    # 顺序 TP, SL, SL, SL, TP —— 峰值出现在第一单后，之后连亏三单
    _signal(db, "HIT_TP", rr=2.0, minutes_ago=500)
    _signal(db, "HIT_SL", rr=2.0, minutes_ago=400)
    _signal(db, "HIT_SL", rr=2.0, minutes_ago=300)
    _signal(db, "HIT_SL", rr=2.0, minutes_ago=200)
    _signal(db, "HIT_TP", rr=2.0, minutes_ago=100)

    body = _run(client, headers, mode="compound").json()
    assert body["summary"]["maxLossStreak"] == 3
    # 峰值 1.02，谷底 1.02×0.99³ → 回撤 = 1 - 0.99³
    expected_dd = (1 - 0.99 ** 3) * 100
    assert body["summary"]["maxDrawdownPct"] == pytest.approx(expected_dd)


def test_incomplete_signal_skipped(client, db):
    headers = _admin_headers(db)
    _signal(db, "HIT_TP", rr=2.0, minutes_ago=200)
    # entry == stop_loss → 风险距离为 0，无法算盈亏比 → 跳过
    _signal(db, "HIT_TP", entry=100.0, stop_loss=100.0, minutes_ago=100)

    body = _run(client, headers).json()
    assert body["summary"]["skipped"] == 1
    assert body["summary"]["wins"] == 1
    assert len(body["trades"]) == 1


def test_unresolved_and_mock_signals_excluded(client, db):
    headers = _admin_headers(db)
    _signal(db, "PENDING", minutes_ago=300)
    _signal(db, "STALE", minutes_ago=200)
    _signal(db, "HIT_TP", minutes_ago=100, source="mock")

    body = _run(client, headers).json()
    assert body["trades"] == []
    assert body["summary"]["wins"] == 0
    assert body["summary"]["skipped"] == 0


def test_signals_outside_window_excluded(client, db):
    headers = _admin_headers(db)
    _signal(db, "HIT_TP", minutes_ago=60 * 24 * 100)  # 100 天前，窗口 90 天之外
    _signal(db, "HIT_TP", minutes_ago=60)

    body = _run(client, headers, days=90).json()
    assert len(body["trades"]) == 1


@pytest.mark.parametrize("params", [
    {"risk": 5},          # 超过上限 3.0
    {"risk": 0.05},       # 低于下限 0.1
    {"days": 5},          # 低于下限 7
    {"days": 400},        # 超过上限 365
    {"mode": "martingale"},
    {"capital": 0},
])
def test_param_validation(client, db, params):
    headers = _admin_headers(db)
    assert _run(client, headers, **params).status_code == 422


def test_capital_scales_linearly_from_cache(client, db):
    headers = _admin_headers(db)
    _signal(db, "HIT_TP", rr=2.0, minutes_ago=200)
    _signal(db, "HIT_SL", rr=2.0, minutes_ago=100)

    a = _run(client, headers, capital=10000).json()
    b = _run(client, headers, capital=50000).json()  # 同参数不同本金 → 命中同一份缓存

    assert b["summary"]["finalEquity"] == pytest.approx(a["summary"]["finalEquity"] * 5)
    assert b["points"][0]["equity"] == pytest.approx(a["points"][0]["equity"] * 5)
    assert b["trades"][0]["equityAfter"] == pytest.approx(a["trades"][0]["equityAfter"] * 5)
    # 与本金无关的指标不缩放 / capital-independent metrics are not scaled
    assert b["summary"]["returnPct"] == pytest.approx(a["summary"]["returnPct"])
    assert b["summary"]["maxDrawdownPct"] == pytest.approx(a["summary"]["maxDrawdownPct"])
    assert b["summary"]["winRate"] == a["summary"]["winRate"]


def test_cache_serves_second_request_without_requery(client, db, monkeypatch):
    headers = _admin_headers(db)
    _signal(db, "HIT_TP", rr=2.0, minutes_ago=100)

    calls = {"n": 0}
    original = signals_router._simulate_normalized

    def counted(*args, **kwargs):
        calls["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(signals_router, "_simulate_normalized", counted)

    _run(client, headers, capital=10000)
    _run(client, headers, capital=20000)
    assert calls["n"] == 1  # 第二次命中缓存，不重新计算


def test_requires_admin(client, db, auth_headers):
    """普通用户拿不到：功能先内部试用，未对外开放。
    Regular users are refused — the feature is in internal trial, not released."""
    assert _run(client, auth_headers).status_code == 403
    assert client.get("/api/signals/simulate").status_code == 401
