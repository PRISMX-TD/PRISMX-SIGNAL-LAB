"""K 线历史入库的单测：只落库已收盘的 K 线、去重、按周期清理过期数据。

Unit tests for candle-history persistence: only closed bars get written,
duplicate writes are skipped, and expired rows are pruned per-interval.
"""
from datetime import datetime, timedelta, timezone

from app.models import Candle
from app.services.candle_store import (
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


# 生产实测的重放形态(XAUUSD/15,2026-07-24 周五收盘后):收盘前最后两根真实 bar
# 的 OHLCV 被整根复制、只换时间戳,两个模板来回交替直到周一开盘。一涨一跌交替,
# 所以图上呈现为红绿相间的平带,而不是一条纯色平线。
# The replay shape observed in production (XAUUSD/15 after the 2026-07-24 Friday
# close): the OHLCV of the last two real bars copied verbatim with only new
# timestamps, the two templates alternating until the Monday open. One is up and
# one is down, which is why the chart shows a red/green band rather than a
# single-colour flat line.
_TEMPLATE_A = {"o": 4053.36, "h": 4055.70, "l": 4051.30, "c": 4055.12, "v": 1002}
_TEMPLATE_B = {"o": 4055.12, "h": 4055.77, "l": 4051.82, "c": 4052.66, "v": 795}


def test_replayed_bars_during_market_close_are_not_persisted(db):
    """休市后喂价端把收盘前的真实 bar 整根复制、只换时间戳来回重放。这些不是行情,
    不该进库——否则回测图上休市段被这条来回重复的平带填满、真实跳空被抹平,而且
    同一段价格被反复喂给指标,一到开盘必然触发穿越,凭空造出入场信号。

    注意这些 bar 有真实的高低差(h != l)也有成交量,所以"o==h==l==c 且量为 0"那
    类冻结报价判定完全抓不到它们——这是生产上实测出来的形态。

    After a close the feed replays the last real bars verbatim with only new
    timestamps. They aren't market data and must not be stored — otherwise the
    backtest chart fills the closed session with that repeating band, erasing
    the real gap, and feeding the same stretch of price to the indicators makes
    a cross at the open inevitable, fabricating entries.

    Note these bars have a real high/low spread (h != l) and non-zero volume, so
    a "o==h==l==c with zero volume" frozen-quote predicate cannot see them at
    all — this is the shape actually observed in production."""
    real_a = {"t": _epoch(60), **_TEMPLATE_A}
    real_b = {"t": _epoch(45), **_TEMPLATE_B}
    replays = [
        {"t": _epoch(m), **(_TEMPLATE_B if i % 2 == 0 else _TEMPLATE_A)}
        for i, m in enumerate((30, 25, 20, 15))
    ]
    n = persist_closed_bars(db, "XAUUSD", "15", [real_a, real_b, *replays])
    assert n == 2
    rows = db.query(Candle).filter(Candle.symbol == "XAUUSD", Candle.interval == "15").all()
    assert sorted(r.t for r in rows) == sorted([real_a["t"], real_b["t"]])


def test_replay_is_detected_against_already_stored_bars(db):
    """休市后的第一根副本要跟库里收盘前那根真实 bar 比才能认出来——分批推送时,
    真实 bar 已经入库、不在当前这一批里,所以比对基准必须查库。

    The first replay after a close is only recognisable against the real
    pre-close bar already in the database, which is not part of the current
    batch when the feed pushes incrementally — so the baseline must be queried
    from storage."""
    assert persist_closed_bars(db, "XAUUSD", "15", [
        {"t": _epoch(60), **_TEMPLATE_A},
        {"t": _epoch(45), **_TEMPLATE_B},
    ]) == 2
    # 后一批全是副本,基准只存在于库里。
    # The later batch is all replays; the baseline exists only in storage.
    assert persist_closed_bars(db, "XAUUSD", "15", [
        {"t": _epoch(30), **_TEMPLATE_A},
        {"t": _epoch(15), **_TEMPLATE_B},
    ]) == 0
    assert db.query(Candle).count() == 2


def test_genuine_bars_with_similar_prices_are_kept(db):
    """价格接近但不完全相同的 bar 是真实行情,必须保留。只有五个字段全部逐一相同
    才算副本——真实行情里几乎不可能出现,所以不会误伤。

    Bars with close but not identical prices are genuine and must be kept. Only
    all five fields matching exactly counts as a replay, which effectively
    cannot happen in live data, so nothing real gets dropped."""
    bars = [
        {"t": _epoch(45), **_TEMPLATE_A},
        # 只差一分钱 / off by one cent
        {"t": _epoch(30), **{**_TEMPLATE_A, "c": _TEMPLATE_A["c"] + 0.01}},
        # OHLC 全同但成交量不同：真实行情,不是整根复制
        # Same OHLC, different volume: genuine, not a verbatim copy
        {"t": _epoch(15), **{**_TEMPLATE_A, "v": _TEMPLATE_A["v"] + 1}},
    ]
    assert persist_closed_bars(db, "XAUUSD", "15", bars) == 3


def test_repeated_perfectly_flat_bars_are_kept(db):
    """完全平坦的 bar(h == l)重复出现不算重放:这种 bar 没有可被复制的内部结构,
    连续出现只说明价格确实没动(极低流动性或合成数据)。把它们当副本丢掉会切断策略
    需要的历史长度——真实行情里也确实存在平盘。

    Repeated perfectly flat bars (h == l) are not replays: such a bar has no
    internal structure to copy, so a run of them only means the price genuinely
    didn't move (thin liquidity or synthetic data). Discarding them would cut the
    history a strategy needs, and flat markets do occur for real."""
    flat = {"o": 100.0, "h": 100.0, "l": 100.0, "c": 100.0, "v": 1}
    # 时间戳全部取过去：未收盘的 bar 会被另一条规则挡掉，会掩盖这里要验的行为。
    # All timestamps are in the past: unclosed bars are rejected by a different
    # rule, which would mask the behaviour under test here.
    bars = [{"t": _epoch(30 - i), **flat} for i in range(11)]
    assert persist_closed_bars(db, "XAUUSD", "1", bars) == len(bars)
    # 再喂一批同样平坦、时间更晚的 bar：仍应全部落库，不被当成副本丢掉。
    # Another batch of equally flat, later bars must still all persist rather than
    # being dropped as replays.
    more = [{"t": _epoch(18 - i), **flat} for i in range(3)]
    assert persist_closed_bars(db, "XAUUSD", "1", more) == len(more)
    assert db.query(Candle).count() == len(bars) + len(more)


def test_fully_replayed_batch_does_not_warn_about_clock_skew(db, caplog):
    """整批都是副本时,不该误报那条"一根都没收盘"的时钟告警——那条诊断的是喂价端
    时钟异常,而这里是周末的正常现象。混在一起会让本该罕见的告警每个周末都刷,真
    出时钟问题时反而被埋掉。

    A batch that is entirely replays must not trigger the "nothing closed"
    clock-skew WARNING — that alert diagnoses a feed clock problem, while this is
    just what a weekend looks like. Conflating them would fire the alert every
    weekend and bury the real thing."""
    assert persist_closed_bars(db, "XAUUSD", "15", [{"t": _epoch(60), **_TEMPLATE_A}]) == 1
    with caplog.at_level("DEBUG"):
        n = persist_closed_bars(db, "XAUUSD", "15", [{"t": _epoch(30), **_TEMPLATE_A}])
    assert n == 0
    assert not any("none are closed yet" in r.message for r in caplog.records)
    assert any("replayed bar" in r.message for r in caplog.records)


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
