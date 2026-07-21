"""K 线历史入库的单测：只落库已收盘的 K 线、去重、按周期清理过期数据。

Unit tests for candle-history persistence: only closed bars get written,
duplicate writes are skipped, and expired rows are pruned per-interval.
"""
from datetime import datetime, timedelta, timezone

from app.models import Candle
from app.services.candle_store import cleanup_old_m1, persist_closed_bars


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


def test_warns_when_entire_batch_is_not_yet_closed(db, caplog):
    """一批里一根都没被判定为"已收盘"要打 WARNING——复现真实事故场景：喂价端
    (EA)时钟算错、把 K 线时间戳打进了"未来"，导致这个判断永远为假、数据库
    安静地停止增长，直到三天后才被发现。

    A batch where nothing is judged "closed" yet must log a WARNING —
    reproduces the real incident where the feed's (EA) clock was off and
    stamped bars into the "future", making this check permanently false and
    silently halting the database for three days before anyone noticed."""
    future_bars = [
        {"t": _epoch(-60), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},   # 1 小时后 / 1h from now
        {"t": _epoch(-120), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},  # 2 小时后 / 2h from now
    ]
    with caplog.at_level("WARNING"):
        n = persist_closed_bars(db, "XAUUSD", "1", future_bars)
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
