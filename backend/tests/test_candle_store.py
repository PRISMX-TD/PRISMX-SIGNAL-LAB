"""K 线历史入库的单测：只落库已收盘的 K 线、去重、按周期清理过期数据。

Unit tests for candle-history persistence: only closed bars get written,
duplicate writes are skipped, and expired rows are pruned per-interval.
"""
from datetime import datetime, timedelta, timezone

from app.models import Candle
from app.services.candle_store import (
    cleanup_inactive_bars,
    cleanup_old_m1,
    persist_closed_bars,
)


def _epoch(minutes_ago: float) -> int:
    return int((datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).timestamp())


def test_only_closed_bars_are_persisted(db):
    # 一根 5 分钟前收盘的(1 分钟线,已走完)+ 一根刚开始形成的(未走完)
    # One bar closed 5 minutes ago (M1, finished) + one still forming.
    bars = [
        {"t": _epoch(5), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
        {"t": _epoch(0), "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
    ]
    n = persist_closed_bars(db, "XAUUSD", "1", bars)
    assert n == 1
    rows = db.query(Candle).filter(Candle.symbol == "XAUUSD", Candle.interval == "1").all()
    assert len(rows) == 1
    assert rows[0].t == bars[0]["t"]


def test_repeated_persist_does_not_duplicate(db):
    bars = [{"t": _epoch(10), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}]
    first = persist_closed_bars(db, "XAUUSD", "1", bars)
    second = persist_closed_bars(db, "XAUUSD", "1", bars)
    assert first == 1
    assert second == 0
    assert db.query(Candle).count() == 1


def test_unknown_interval_is_ignored(db):
    bars = [{"t": _epoch(10), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}]
    n = persist_closed_bars(db, "XAUUSD", "not-a-real-interval", bars)
    assert n == 0
    assert db.query(Candle).count() == 0


def test_earlier_bar_persists_even_when_feed_clock_runs_far_ahead(db):
    """真实事故复现：喂价端(EA)的时钟比服务器快了约 11 小时,导致每一根 bar
    的绝对收盘判定(bar.t + 周期秒数 <= 服务器当前时间)永远为假——但同一批
    里能看到一根晚 60 秒的 bar,足以证明前一根已经走完,不需要等绝对时钟追
    上来。这正是 ②(相对判定)存在的意义:喂价端内部的相对顺序没坏,坏的只是
    跟服务器时钟的绝对差值,而这个差值在真实场景里往往两边都不方便/不允许
    改动(经纪商服务器时间改不了、本地系统时间本身是对的也不该为此去改)。

    Reproduces the real incident: the feed's (EA) clock ran ~11h ahead of the
    server's, so the absolute "closed" check was permanently false for every
    bar — but seeing a bar 60s later in the same batch is enough to prove the
    earlier one already finished, without waiting for the absolute clock to
    catch up. This is exactly why the relative check (②) exists: the feed's
    internal ordering isn't broken, only its absolute offset from the server
    clock is — and in the real scenario neither clock could reasonably be
    adjusted (the broker's server time isn't user-adjustable; the local
    system clock was already correct and shouldn't be touched just for this).
    """
    skew_seconds = 11 * 3600
    now = int(datetime.now(timezone.utc).timestamp())
    older_t = now + skew_seconds
    newer_t = older_t + 60
    bars = [
        {"t": older_t, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
        {"t": newer_t, "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
    ]
    n = persist_closed_bars(db, "XAUUSD", "1", bars)
    assert n == 1
    rows = db.query(Candle).filter(Candle.symbol == "XAUUSD", Candle.interval == "1").all()
    assert len(rows) == 1
    assert rows[0].t == older_t


def test_warns_when_entire_batch_is_not_yet_closed(db, caplog):
    """一批里一根都没被判定为"已收盘"要打 WARNING——有了②(相对判定)之后,
    只有批次里连"更晚的邻居"都没有(实际就一根独一无二的时间戳)且它本身还
    没到绝对收盘门槛时才会触发,比引入②之前更少见,但仍是真实事故复现过的
    场景(喂价端时钟算错、数据库安静地停止增长直到三天后才被发现)。

    A batch where nothing is judged "closed" must log a WARNING — with ② (the
    relative check) in place, this now only fires when the batch doesn't even
    have a "later neighbor" (effectively a single unique timestamp) that also
    misses the absolute-clock threshold. Rarer than before ② existed, but
    still reproduces a real incident (a skewed feed clock silently halting the
    database for three days before anyone noticed)."""
    future_bar = [{"t": _epoch(-60), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}]  # 1 小时后 / 1h from now
    with caplog.at_level("WARNING"):
        n = persist_closed_bars(db, "XAUUSD", "1", future_bar)
    assert n == 0
    assert db.query(Candle).count() == 0
    assert any("none are closed yet" in r.message for r in caplog.records)
    assert any("XAUUSD/1" in r.message for r in caplog.records)


def test_no_warning_when_at_least_one_bar_is_closed(db, caplog):
    """正常情况(至少有一根已收盘)不该打这条 WARNING——避免稳态运行时刷屏。
    Normal operation (at least one closed bar) must not trigger this WARNING
    — avoids flooding the logs during steady-state runs."""
    bars = [
        {"t": _epoch(5), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
        {"t": _epoch(0), "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
    ]
    with caplog.at_level("WARNING"):
        persist_closed_bars(db, "XAUUSD", "1", bars)
    assert not any("none are closed yet" in r.message for r in caplog.records)


def test_inactive_bars_during_market_close_are_not_persisted(db):
    """休市期间喂价端仍在推 bar,报价冻结在收盘价(o==h==l==c、量为 0),这些不是
    行情,不该进库——否则回测图上休市段会被一长串完全平坦的蜡烛填满、真实跳空被
    抹平,而且 BOLL 这类指标的标准差在这段里趋近 0,一到开盘必然触发穿越,凭空造
    出入场信号。

    Over a market close the feed keeps pushing bars with the quote frozen at the
    session close (o==h==l==c, zero volume). Those aren't market data and must
    not be stored — otherwise the backtest chart fills the closed session with
    perfectly flat candles, flattening the real gap, and stddev-based indicators
    like Bollinger collapse there, fabricating a cross on the next open."""
    real = {"t": _epoch(30), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}
    frozen = [
        {"t": _epoch(m), "o": 1.5, "h": 1.5, "l": 1.5, "c": 1.5, "v": 0}
        for m in (25, 20, 15)
    ]
    n = persist_closed_bars(db, "XAUUSD", "1", [real, *frozen])
    assert n == 1
    rows = db.query(Candle).filter(Candle.symbol == "XAUUSD", Candle.interval == "1").all()
    assert [r.t for r in rows] == [real["t"]]


def test_flat_bar_with_volume_is_kept(db):
    """只有 o==h==l==c 但有成交量的 bar 是真实行情(流动性极低的时段确实会出现),
    必须保留——判定要两个条件同时成立才丢弃。

    A flat bar that still reports volume is genuine market data (it does happen
    in very thin liquidity) and must be kept — both conditions are required
    before discarding."""
    bars = [
        {"t": _epoch(20), "o": 1.5, "h": 1.5, "l": 1.5, "c": 1.5, "v": 4},
        {"t": _epoch(15), "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 7},
    ]
    n = persist_closed_bars(db, "XAUUSD", "1", bars)
    assert n == 2


def test_fully_inactive_batch_does_not_warn_about_clock_skew(db, caplog):
    """整批都是休市空转 bar 时,不该误报那条"一根都没收盘"的时钟告警——那条告警
    诊断的是喂价端时钟异常,而这里是周末的正常现象。混在一起会让本该罕见的告警
    每个周末都刷,真出时钟问题时反而被埋掉。

    A batch that is entirely inactive must not trigger the "nothing closed"
    clock-skew WARNING — that alert diagnoses a feed clock problem, while this
    is just what a weekend looks like. Conflating them would fire the alert
    every weekend and bury the real thing."""
    frozen = [
        {"t": _epoch(m), "o": 1.5, "h": 1.5, "l": 1.5, "c": 1.5, "v": 0}
        for m in (20, 15)
    ]
    with caplog.at_level("DEBUG"):
        n = persist_closed_bars(db, "XAUUSD", "1", frozen)
    assert n == 0
    assert db.query(Candle).count() == 0
    assert not any("none are closed yet" in r.message for r in caplog.records)
    assert any("no market activity" in r.message for r in caplog.records)


def test_cleanup_removes_stored_inactive_bars_only(db):
    """清掉过滤上线之前已落库的空转 bar,真实行情与"平坦但有量"的 bar 都不能动。
    判定必须与写入侧一致,否则两边会对同一根 bar 给出不同答案。

    Clears inactive bars persisted before the filter existed, leaving real bars
    and flat-but-with-volume bars untouched. The predicate must match the write
    path, or the two would disagree about the same bar."""
    real = _epoch(60)
    flat_with_v = _epoch(50)
    frozen = [_epoch(40), _epoch(35)]
    db.add(Candle(symbol="XAUUSD", interval="15", t=real, o=1, h=2, l=0.5, c=1.5, v=9))
    db.add(Candle(symbol="XAUUSD", interval="15", t=flat_with_v, o=1.5, h=1.5, l=1.5, c=1.5, v=3))
    for t in frozen:
        db.add(Candle(symbol="XAUUSD", interval="15", t=t, o=1.5, h=1.5, l=1.5, c=1.5, v=0))
    db.commit()

    deleted = cleanup_inactive_bars(db)
    assert deleted == 2
    remaining = sorted(r.t for r in db.query(Candle).all())
    assert remaining == sorted([real, flat_with_v])
    # 幂等：写入侧修好之后再跑一次应该无事可做。
    # Idempotent: with the write path fixed, a second run has nothing to do.
    assert cleanup_inactive_bars(db) == 0


def test_cleanup_only_deletes_expired_m1(db):
    old_m1 = _epoch(60 * 24 * 40)  # 40 天前 / 40 days ago
    fresh_m1 = _epoch(60 * 24 * 5)  # 5 天前 / 5 days ago
    old_d1 = _epoch(60 * 24 * 400)  # 400 天前的日线,不该被清 / 400-day-old daily bar, must survive
    db.add(Candle(symbol="XAUUSD", interval="1", t=old_m1, o=1, h=1, l=1, c=1))
    db.add(Candle(symbol="XAUUSD", interval="1", t=fresh_m1, o=1, h=1, l=1, c=1))
    db.add(Candle(symbol="XAUUSD", interval="D", t=old_d1, o=1, h=1, l=1, c=1))
    db.commit()

    deleted = cleanup_old_m1(db, retention_days=30)
    assert deleted == 1
    remaining_m1 = [r.t for r in db.query(Candle).filter(Candle.interval == "1").all()]
    assert remaining_m1 == [fresh_m1]
    assert db.query(Candle).filter(Candle.interval == "D").count() == 1
