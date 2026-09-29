"""趋势推送顺带做的信号判定，其提交时机的回归测试。

钉的是一个已经在生产上静默跑了六周的互锁：_trend_db_work 原本写
`if resolved: db.commit()`，而 resolve_signals_with_price 会给**扫到的每一条**
PENDING 信号写价格基线、返回值里却只有判出结果的那几条。于是没判出结果的轮次
（几乎全部）基线写入被 finally 的 db.close() 丢掉；而基线又是判定的前提，
三者互相等待，任何信号都永远判不出胜负。

失败方式是纯静默的：webhook 照常 200、趋势照常更新、日志一行不报，只是
signals.result 永远停在 PENDING，5 天后被保险丝清扫成 STALE。线上表现为
19703 条 TradingView 信号 baseline_high 全为 NULL、64% 是 STALE。

单元测 resolve_signals_with_price 本身抓不到这个——它在内存里的行为完全正确，
错的是调用方有没有把它的写入落库。所以这里必须走 _trend_db_work 整条路径，
并且**跨会话**重新读取，才能验证到"确实写进了数据库"。

Regression tests for when the trend push's opportunistic signal resolution
commits.

Pins a deadlock that ran silently in production for six weeks: _trend_db_work
used to say `if resolved: db.commit()`, while resolve_signals_with_price writes
a price baseline to EVERY pending signal it scans and returns only the ones that
resolved. Rounds that resolved nothing — nearly all of them — had their baseline
writes discarded by the db.close() in `finally`; since a baseline is the
precondition for resolving, all three waited on each other and nothing could
ever resolve.

The failure is entirely silent: the webhook still returns 200, trends still
update, nothing is logged — signals.result simply stays PENDING until the 5-day
safety net sweeps it to STALE. In production: all 19703 TradingView signals with
a NULL baseline_high and 64% STALE.

Unit-testing resolve_signals_with_price cannot catch this — its in-memory
behaviour is correct; what was wrong is whether the caller persisted those
writes. So these go through the whole _trend_db_work path and re-read across a
fresh session to prove the writes actually reached the database.
"""
import json
import os
import tempfile
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import Signal
import app.routers.webhook as wh


@pytest.fixture()
def env(monkeypatch):
    """临时文件库 + 把 webhook 的会话工厂指过去。

    刻意用文件而非内存库：_trend_db_work 每次调用都自己开一个新会话，内存库会
    让每个连接拿到各自独立的空库，恰好把"跨会话是否真落库"这件事测没了。

    A temp file DB with webhook's session factory pointed at it. A file rather
    than an in-memory database on purpose: _trend_db_work opens its own session
    per call, and in-memory SQLite would hand each connection a separate empty
    database — silently voiding the very thing under test.
    """
    path = os.path.join(tempfile.gettempdir(), f"prismx-test-{uuid.uuid4().hex}.db")
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(wh, "SessionLocal", maker)
    try:
        yield maker
    finally:
        engine.dispose()
        try:
            os.unlink(path)
        except OSError:
            pass


def _add_signal(maker, *, side: str, sl: float, tp: float) -> str:
    db = maker()
    sig = Signal(
        symbol="XAUUSD", side=side, entry=2000.0, stop_loss=sl, take_profit=tp,
        indicator="Test", source="tradingview", status="ACTIVE",
        created_at=datetime.now(timezone.utc).replace(tzinfo=None), result="PENDING",
    )
    db.add(sig)
    db.commit()
    sid = sig.id
    db.close()
    return sid


def _push(maker, low: float, high: float) -> None:
    wh._trend_db_work("XAUUSD", {"M5": "UP"}, datetime.now(timezone.utc), low, high)


def _read(maker, sid: str) -> Signal:
    db = maker()
    try:
        return db.query(Signal).filter(Signal.id == sid).first()
    finally:
        db.close()


def test_baseline_survives_a_round_that_resolved_nothing(env):
    """判不出结果的那一轮，基线也必须落库——这正是原来丢掉的写入。
    A round that resolves nothing must still persist the baseline — exactly the
    write the old code threw away."""
    sid = _add_signal(env, side="BUY", sl=1990.0, tp=2010.0)

    # 这一轮价格离止盈止损都很远，必然判不出结果 / nowhere near TP or SL
    _push(env, 1999.8, 2000.4)

    row = _read(env, sid)
    assert row.result == "PENDING"
    assert row.baseline_high == 2000.4, "基线没落库 / baseline was not persisted"
    assert row.baseline_low == 1999.8


def test_signal_eventually_resolves_across_pushes(env):
    """连续推送下价格穿过止盈，信号必须真的判成 HIT_TP。

    原实现在这里会一直 PENDING：每次推送都因为基线为空而退化成"首次观测"。

    Across successive pushes the price crosses take-profit and the signal must
    actually resolve. The old implementation stayed PENDING forever here, every
    push degrading into a "first observation" because the baseline was empty.
    """
    sid = _add_signal(env, side="BUY", sl=1990.0, tp=2010.0)

    for low, high in [(1999.8, 2000.4), (2000.2, 2001.5), (2001.0, 2004.0), (2007.5, 2012.0)]:
        _push(env, low, high)

    row = _read(env, sid)
    assert row.result == "HIT_TP"
    assert row.resolved_at is not None


def test_sell_side_resolves_to_stop_loss(env):
    """做空侧走同一条路径：价格上穿止损应判 HIT_SL。
    The short side goes through the same path: price crossing the stop resolves
    to HIT_SL."""
    sid = _add_signal(env, side="SELL", sl=2010.0, tp=1990.0)

    _push(env, 1999.8, 2000.4)
    _push(env, 2007.5, 2012.0)

    assert _read(env, sid).result == "HIT_SL"


def test_trend_only_push_without_prices_leaves_signal_untouched(env):
    """载荷不带 high/low 时整段判定跳过，信号与基线都不该被动过。
    A payload without high/low skips resolution entirely; neither the result nor
    the baseline should be touched."""
    sid = _add_signal(env, side="BUY", sl=1990.0, tp=2010.0)

    wh._trend_db_work("XAUUSD", {"M5": "UP"}, datetime.now(timezone.utc), None, None)

    row = _read(env, sid)
    assert row.result == "PENDING"
    assert row.baseline_high is None and row.baseline_low is None


def test_trend_row_is_written_even_with_no_pending_signals(env):
    """没有任何待判信号时趋势仍要更新——修复不能把趋势 upsert 也搭进去。
    The trend still updates when there are no pending signals: the fix must not
    make the trend upsert conditional on there being work to do."""
    from app.models import Trend

    _push(env, 1999.8, 2000.4)

    db = env()
    try:
        assert db.query(Trend).filter(Trend.symbol == "XAUUSD").first() is not None
    finally:
        db.close()


# ---- 趋势没变：不写库、不广播，信号判定照跑 / unchanged trend: no write, no broadcast ----

def _trend_row(maker):
    from app.models import Trend
    db = maker()
    try:
        row = db.query(Trend).filter(Trend.symbol == "XAUUSD").first()
        return None if row is None else (row.timeframes, row.updated_at)
    finally:
        db.close()


def test_unchanged_trend_skips_write_but_still_resolves_signals(env):
    wh.reset_trend_state_for_tests()
    t1 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    t2 = datetime(2026, 1, 1, 0, 0, 5, tzinfo=timezone.utc)
    d1 = wh._trend_db_work("XAUUSD", {"M5": "UP"}, t1, None, None)
    assert d1["_changed"] is True
    first = _trend_row(env)
    assert first is not None
    # 第二帧同趋势：不写（updated_at 不动）、标记未变
    d2 = wh._trend_db_work("XAUUSD", {"M5": "UP"}, t2, None, None)
    assert d2["_changed"] is False
    assert _trend_row(env) == first
    # 有高低点时信号判定仍照跑：先记基线，再用穿过 TP 的价格判出 HIT_TP
    sid = _add_signal(env, side="BUY", sl=1900.0, tp=2100.0)
    d3 = wh._trend_db_work("XAUUSD", {"M5": "UP"}, t2, 2001.0, 2002.0)
    assert d3["_changed"] is False
    assert _trend_row(env) == first
    d4 = wh._trend_db_work("XAUUSD", {"M5": "UP"}, t2, 2001.0, 2150.0)
    assert d4["_changed"] is False
    assert _read(env, sid).result == "HIT_TP"
    # 趋势变了：写库并标记 changed
    d5 = wh._trend_db_work("XAUUSD", {"M5": "DOWN"}, t2, None, None)
    assert d5["_changed"] is True
    assert "DOWN" in _trend_row(env)[0]


def test_unchanged_trend_refreshes_after_interval(env, monkeypatch):
    wh.reset_trend_state_for_tests()
    t1 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    t2 = datetime(2026, 1, 1, 0, 6, tzinfo=timezone.utc)
    wh._trend_db_work("XAUUSD", {"M5": "UP"}, t1, None, None)
    monkeypatch.setattr(wh, "_TREND_REFRESH_SECONDS", 0.0)
    d = wh._trend_db_work("XAUUSD", {"M5": "UP"}, t2, None, None)
    assert d["_changed"] is True


def test_route_broadcasts_only_changed_symbols(env, monkeypatch):
    import asyncio
    wh.reset_trend_state_for_tests()
    monkeypatch.setattr(wh, "_valid_trend_secret", lambda s: True)
    sent = []

    async def _bc(msg):
        sent.append(msg)

    monkeypatch.setattr(wh.manager, "broadcast_to_clients", _bc)

    class _Req:
        def __init__(self, body):
            self._b = body
            self.client = None
            self.headers = {}

        async def body(self):
            return self._b

    def _post(trends):
        body = json.dumps({"secret": "x", "items": [
            {"symbol": "XAUUSD", "trends": trends["XAUUSD"]},
            {"symbol": "EURUSD", "trends": trends["EURUSD"]},
        ]}).encode()
        return asyncio.run(wh.tradingview_trend.__wrapped__(_Req(body)) if hasattr(wh.tradingview_trend, "__wrapped__") else wh.tradingview_trend(_Req(body)))

    _post({"XAUUSD": {"M5": "UP"}, "EURUSD": {"M5": "UP"}})
    assert sorted(m["data"]["symbol"] for m in sent) == ["EURUSD", "XAUUSD"]
    sent.clear()
    _post({"XAUUSD": {"M5": "UP"}, "EURUSD": {"M5": "DOWN"}})
    assert [m["data"]["symbol"] for m in sent] == ["EURUSD"]
    assert all("_changed" not in m["data"] for m in sent)
