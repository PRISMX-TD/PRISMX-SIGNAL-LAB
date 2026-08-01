"""K 线历史入库的单测：只落库已收盘的 K 线、去重、按周期清理过期数据。

Unit tests for candle-history persistence: only closed bars get written,
duplicate writes are skipped, and expired rows are pruned per-interval.
"""
from datetime import datetime, timedelta, timezone

from app.models import Candle
from app.services.candle_store import (
    STALLED_CLOSE_BARS,
    cleanup_old_m1,
    persist_closed_bars,
)
from tests.conftest import trading_session_now


# 所有相对时间戳的基准。模块加载时求值一次,保证同一次运行里所有测试共用同一个
# 基准——否则跨越午夜或收盘边界时,同一个测试里先后取的时间戳可能落在不同时段。
# 基准函数放在 conftest 里,因为多个测试文件都需要它(见 trading_session_now()
# 的说明:为什么不能直接用 datetime.now())。
# Single anchor for every relative timestamp, evaluated once at import so all
# tests in a run share it — otherwise a run crossing midnight or the close could
# have timestamps within one test landing in different sessions. The helper lives
# in conftest since several test files need it; see trading_session_now() for why
# datetime.now() can't be used directly.
_ANCHOR = trading_session_now()


def _epoch(minutes_ago: float) -> int:
    return int((_ANCHOR - timedelta(minutes=minutes_ago)).timestamp())


# 验"收盘判定"的测试一律用 BTCUSD:那些断言的语义是"相对服务器当前时间刚形成/
# 已走完",必须用真实的 now 而不是 _ANCHOR(挪到周五的基准相对现在早就收盘了,
# "仍在形成中"这个前提会被破坏)。BTCUSD 7x24 交易、豁免周末闸门,于是无论哪天跑
# 都只考验收盘判定这一件事。
# Tests covering the closed-bar check use BTCUSD: their assertions mean "still
# forming / already finished relative to the server's current time", so they need
# the real now rather than _ANCHOR (a Friday anchor is long closed by now, which
# would break the "still forming" premise). BTCUSD trades 7x24 and is exempt from
# the weekend gate, so they exercise only the closed-bar logic whatever day it is.
def _now_epoch(minutes_ago: float) -> int:
    return int((datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).timestamp())


def test_only_closed_bars_are_persisted(db):
    # 一根 5 分钟前收盘的(1 分钟线,已走完)+ 一根刚开始形成的(未走完)
    # One bar closed 5 minutes ago (M1, finished) + one still forming.
    bars = [
        {"t": _now_epoch(5), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
        {"t": _now_epoch(0), "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
    ]
    n = persist_closed_bars(db, "BTCUSD", "1", bars)
    assert n == 1
    rows = db.query(Candle).filter(Candle.symbol == "BTCUSD", Candle.interval == "1").all()
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
    # 用 BTCUSD:时钟快 11 小时会把时间戳推到未来,可能正好落进周末闸门的窗口里,
    # 那样拦下它的就是闸门而不是收盘判定,这个测试也就验不到它要验的东西了。
    # BTCUSD: an 11h-fast clock pushes timestamps into the future, which can land
    # inside the weekend gate's window — then the gate, not the closed-bar check,
    # would be what rejects them and this test would no longer test its subject.
    skew_seconds = 11 * 3600
    now = int(datetime.now(timezone.utc).timestamp())
    older_t = now + skew_seconds
    newer_t = older_t + 60
    bars = [
        {"t": older_t, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
        {"t": newer_t, "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
    ]
    n = persist_closed_bars(db, "BTCUSD", "1", bars)
    assert n == 1
    rows = db.query(Candle).filter(Candle.symbol == "BTCUSD", Candle.interval == "1").all()
    assert len(rows) == 1
    assert rows[0].t == older_t


def test_forming_bar_with_sub_interval_neighbour_is_not_persisted(db):
    """仍在形成中的 bar 不能因为有个"只晚一点、自己也没收盘"的邻居就入库。

    真实事故:tick 模式固定推最新 2 根,这 2 根都还没收盘。原先的判定只要
    b["t"] < latest_t 就放行,于是较早那根被当成已收盘写进库;而
    persist_closed_bars() 对已存在的时间戳一律跳过,那根就被永久定格在形成
    初期的半成品上。实测 XAUUSD 20:55 的 5 分钟线锁死在 C=4055.14,而它后
    4 分钟真实跌到 4043.82——存下来的收盘价比这根 bar 自己后来的真实最低价
    还高,指标和策略拿到的是一根不可能存在的 K 线。

    A still-forming bar must not be admitted just because a slightly later
    bar — itself also unfinished — shares the batch. Real incident: tick mode
    always sends the latest 2 bars, neither closed. The old `b["t"] <
    latest_t` test admitted the earlier one, and since persist_closed_bars()
    skips timestamps that already exist, the row froze at that half-formed
    snapshot (XAUUSD 20:55 M5 stuck at C=4055.14 while price went on to
    4043.82 inside the same bar, storing a close above the bar's own later
    low).
    """
    # BTCUSD 豁免周末闸门,确保拦下它的是收盘判定而不是休市窗口。
    # BTCUSD is exempt from the weekend gate, so the closed-bar check is what
    # rejects these bars rather than the closure window.
    now = int(datetime.now(timezone.utc).timestamp())
    seconds = 300  # 5 分钟线 / M5
    forming_t = now - (now % seconds)          # 当前这根,尚未收盘 / current, unfinished
    neighbour_t = forming_t + 60               # 只晚 60 秒,不足一个周期 / only 60s later
    bars = [
        {"t": forming_t, "o": 4055.81, "h": 4056.11, "l": 4053.95, "c": 4055.14, "v": 527},
        {"t": neighbour_t, "o": 4055.14, "h": 4055.2, "l": 4043.8, "c": 4043.82, "v": 120},
    ]
    assert persist_closed_bars(db, "BTCUSD", "5", bars) == 0
    assert db.query(Candle).filter(Candle.symbol == "BTCUSD", Candle.interval == "5").count() == 0


def test_bar_persists_once_neighbour_is_a_full_interval_ahead(db):
    """邻居跨过一个完整周期时,这一根确实已经走完,应当入库。

    与上一个测试成对:证明修复收紧的只是"邻居不足一个周期"这一种情况,②本身
    (不依赖绝对时钟的相对判定)照旧有效。

    Pairs with the test above: the fix narrows only the sub-interval case; ②
    (the clock-independent relative check) still works.
    """
    now = int(datetime.now(timezone.utc).timestamp())
    seconds = 300
    closed_t = now - (now % seconds)
    neighbour_t = closed_t + seconds  # 整整一个周期后 / a full interval later
    bars = [
        {"t": closed_t, "o": 4055.81, "h": 4056.11, "l": 4043.8, "c": 4043.82, "v": 647},
        {"t": neighbour_t, "o": 4043.82, "h": 4044.9, "l": 4043.5, "c": 4044.81, "v": 88},
    ]
    assert persist_closed_bars(db, "BTCUSD", "5", bars) == 1
    rows = db.query(Candle).filter(Candle.symbol == "BTCUSD", Candle.interval == "5").all()
    assert len(rows) == 1
    assert rows[0].t == closed_t
    assert rows[0].c == 4043.82


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
    # 用 BTCUSD 与真实 now:这条 WARNING 的前提是"这一根相对服务器当前时间还没收盘",
    # 必须挂在真实时钟上;同时要确保拦下它的是收盘判定而不是周末闸门。
    # BTCUSD with the real now: this WARNING's premise is "this bar hasn't closed
    # relative to the server's current time", which has to hang off the real clock —
    # and the rejection must come from the closed-bar check, not the weekend gate.
    future_bar = [{"t": _now_epoch(-60), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}]  # 1 小时后 / 1h from now
    with caplog.at_level("WARNING"):
        n = persist_closed_bars(db, "BTCUSD", "1", future_bar)
    assert n == 0
    assert db.query(Candle).count() == 0
    assert any("none are closed yet" in r.message for r in caplog.records)
    assert any("BTCUSD/1" in r.message for r in caplog.records)


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


def test_repeated_perfectly_flat_bars_are_not_treated_as_replays(db):
    """完全平坦的 bar(h == l)重复出现**不算重放副本**:这种 bar 没有可被复制的内部
    结构,连续出现不构成"整根复制"的证据,所以重放判定必须放过它们。

    但它们会被另一道闸门拦下——连续不动的价格正是休市的特征(见
    _stalled_tail_length())。所以这里只断言"阈值之内的那几根会落库",也就是重放判定
    确实没插手;超过阈值之后由停滞闸门接管,由 test_frozen_quote_* 覆盖。

    原先这个测试断言 11 根平坦 bar 全部保留,理由是"真实行情里存在平盘,丢弃会切断策略
    历史"。加入停滞判定后这个主张被推翻:连续 6 根收盘价一动不动在主要品种上不是平盘
    而是休市,而放这类数据进来会凭空造出指标和信号。取舍已确认——宁可误伤极罕见的真实
    平盘,也不让伪造行情污染库。

    Repeated perfectly flat bars (h == l) are **not replay copies**: such a bar has
    no internal structure to copy, so a run of them isn't evidence of verbatim
    copying and the replay check must let them through.

    They are, however, stopped by a different gate — a price that doesn't move is the
    signature of a closed market (see _stalled_tail_length()). So this only asserts
    that the bars within the threshold persist, i.e. the replay check kept its hands
    off; beyond the threshold the stall gate takes over, covered by
    test_frozen_quote_*.

    This test used to assert all 11 flat bars survived, on the grounds that "flat
    markets occur for real and discarding them cuts strategy history". The stall gate
    overrides that: six consecutive unchanged closes on a major symbol is a closure,
    not a flat market, and admitting such data fabricates indicators and signals. The
    trade-off is settled — better to misfire on a vanishingly rare genuine flat
    market than to let fabricated bars pollute the store.
    """
    flat = {"o": 100.0, "h": 100.0, "l": 100.0, "c": 100.0, "v": 1}
    # 时间戳全部取过去：未收盘的 bar 会被另一条规则挡掉，会掩盖这里要验的行为。
    # All timestamps are in the past: unclosed bars are rejected by a different
    # rule, which would mask the behaviour under test here.
    bars = [{"t": _epoch(30 - i), **flat} for i in range(11)]
    accepted = persist_closed_bars(db, "XAUUSD", "1", bars)
    # 落库数由停滞阈值决定,而不是 0:若重放判定也插手,结果会是 0。
    # The count is set by the stall threshold, not 0 — the replay check joining in
    # would have made it 0.
    assert accepted == STALLED_CLOSE_BARS - 1
    assert db.query(Candle).count() == STALLED_CLOSE_BARS - 1


def _utc(year: int, month: int, day: int, hour: int, minute: int = 0) -> int:
    """绝对 UTC 时间戳。周末闸门的测试必须用绝对时间,不能用相对偏移——要断言的正是
    "落在某个具体钟点算不算休市",相对时间会让断言随运行日漂移。
    Absolute UTC timestamp. Weekend-gate tests need absolute times rather than
    relative offsets: the assertion is about whether a specific wall-clock moment
    counts as closed, which would drift with the run date otherwise."""
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp())


# 2026-07-24 是周五,07-25 周六,07-26 周日,07-27 周一。
# 选这一周而不是更晚的日期:时间戳必须落在过去,否则会先被"未收盘"判定拦掉,
# 测试就验不到周末闸门本身了。
# 2026-07-24 is a Friday; 07-25 Saturday, 07-26 Sunday, 07-27 Monday. This week is
# chosen because the timestamps must lie in the past — otherwise the not-yet-closed
# check rejects them first and the weekend gate never gets exercised.
def test_weekend_bars_are_rejected_for_non_crypto_symbols(db):
    """周末休市窗口内的 bar 一律不收,哪怕内容全新、不重复任何历史。

    这是与重放判定独立的一道闸门:重放判定的前提是"副本必须与某根真实 bar 完全相同",
    而生产上出现过整段平移穿过滑动窗口的情况。按时间拦不依赖对伪造手法的任何假设,
    所以哪怕 EA 换一种伪造方式,周末数据也进不来。

    Bars stamped inside the weekend close are rejected outright, even when their
    content is novel and duplicates nothing.

    This gate is independent of the replay check, whose premise — that a copy
    matches some real bar exactly — was defeated in production by whole-stretch
    shifting. Judging by time assumes nothing about the fabrication's shape, so
    weekend data stays out however the EA fabricates it."""
    # 每根 OHLCV 都不同,确保被拦下的原因是时间而不是内容重复。
    # Every bar has distinct OHLCV so the rejection is unambiguously about time.
    weekend_bars = [
        {
            "t": _utc(2026, 7, 25, 4, i * 5),
            "o": 4050.0 + i, "h": 4055.0 + i, "l": 4045.0 + i, "c": 4052.0 + i,
            "v": 500 + i,
        }
        for i in range(12)
    ]
    assert persist_closed_bars(db, "XAUUSD", "5", weekend_bars) == 0
    assert db.query(Candle).count() == 0


def test_weekend_bars_are_kept_for_btcusd(db):
    """BTCUSD 7x24 交易,周末有真实行情,不能被闸门拦掉。
    BTCUSD trades 7x24 with genuine weekend data and must pass the gate."""
    weekend_bars = [
        {
            "t": _utc(2026, 7, 25, 4, i * 5),
            "o": 68000.0 + i, "h": 68100.0 + i, "l": 67900.0 + i, "c": 68050.0 + i,
            "v": 30 + i,
        }
        for i in range(12)
    ]
    assert persist_closed_bars(db, "BTCUSD", "5", weekend_bars) == 12


def test_weekend_gate_boundaries(db):
    """闸门边界:周五 21:00 UTC 起算休市,周日 21:00 UTC 起算开盘。

    钉住这四个点是因为差一小时要么漏进一段伪造数据、要么拦掉真实行情,而两者都不
    容易在日常使用中被发现。

    Gate boundaries: closed from Friday 21:00 UTC, open from Sunday 21:00 UTC.
    Pinning all four points matters because being an hour off either admits a
    stretch of fabricated data or drops real bars, neither of which is easy to
    notice in day-to-day use."""
    # 每次调用都用不同的价格:若所有 bar 的 OHLCV 相同,先入库的那根会成为重放判定
    # 的基线,后面的会被当副本拦掉——那样这个测试就分不清"被闸门拦"和"被重放判定拦",
    # 断言失去意义。用调用序号扰动价格,保证唯一被考验的是时间判定。
    # Each call uses distinct prices: with identical OHLCV the first stored bar
    # becomes the replay baseline and later ones are dropped as copies, so the test
    # couldn't tell a weekend-gate rejection from a replay rejection. Perturbing by
    # call index keeps the time check as the only thing under test.
    counter = iter(range(1, 1000))

    def one(t: int) -> int:
        i = next(counter)
        return persist_closed_bars(
            db, "EURUSD", "60",
            [{
                "t": t,
                "o": 1.15 + i * 0.001, "h": 1.16 + i * 0.001,
                "l": 1.14 + i * 0.001, "c": 1.155 + i * 0.001,
                "v": 100 + i,
            }],
        )

    # 周五 20:00 仍在交易时段 / Friday 20:00 is still open
    assert one(_utc(2026, 7, 24, 20)) == 1
    # 周五 21:00 起休市 / closed from Friday 21:00
    assert one(_utc(2026, 7, 24, 21)) == 0
    # 周六全天休市 / Saturday closed all day
    assert one(_utc(2026, 7, 25, 12)) == 0
    # 周日 20:00 仍休市 / Sunday 20:00 still closed
    assert one(_utc(2026, 7, 26, 20)) == 0
    # 周日 21:00 起开盘 / open from Sunday 21:00
    assert one(_utc(2026, 7, 26, 21)) == 1
    # 周一全天交易 / Monday trades all day
    assert one(_utc(2026, 7, 27, 4)) == 1


def test_whole_stretch_shifted_replay_is_rejected(db):
    """休市期间喂价端还会把**整段行情原样平移**,不只是两三个模板来回交替。

    这是生产上漏过滤的真实形态(XAUUSD/5,2026-08-01 周六):04:00–06:00 那 24 根
    5 分钟线被整段搬到 06:00–08:00,偏移固定 2 小时,一根不差。

    这种形态能穿过"最近 N 根"的滑动窗口:每根副本的原件都在 24 根之前,而滑动窗口
    每接受一根就把它推进基线、挤掉最老的一根,原件早已不在基线里。所以基线必须按
    时间跨度取,不能按根数——这个测试就是钉住这一点的。

    While the market is closed the feed also **replays whole stretches shifted in
    time**, not just a couple of alternating templates.

    This is the shape that slipped through in production (XAUUSD/5, Saturday
    2026-08-01): the 24 five-minute bars of 04:00–06:00 moved verbatim onto
    06:00–08:00, a fixed 2-hour offset, every single one.

    It defeats a "last N bars" sliding window: each copy's original sits 24 bars
    back, and a sliding window pushes every accepted bar onto the baseline while
    evicting the oldest, so the originals are long gone. The baseline therefore
    has to span time rather than count bars — which is what this test pins."""
    # 24 根互不相同的真实 bar,每根都有真实高低差(不能是平坦 bar,那类被豁免)。
    # 24 distinct real bars, each with a genuine range (flat bars are exempt).
    stretch = [
        {
            "t": _epoch(24 * 5 - i * 5),
            "o": 4050.0 + i * 0.37,
            "h": 4052.5 + i * 0.37,
            "l": 4048.1 + i * 0.37,
            "c": 4051.2 + i * 0.37,
            "v": 400 + i * 7,
        }
        for i in range(24)
    ]
    assert persist_closed_bars(db, "XAUUSD", "5", stretch) == 24

    # 整段平移:同样的 OHLCV,时间戳统一往后挪 2 小时(24 根 5 分钟线)。
    # The same OHLCV shifted forward by 2 hours (24 five-minute bars).
    shifted = [{**b, "t": b["t"] + 24 * 5 * 60} for b in stretch]
    assert persist_closed_bars(db, "XAUUSD", "5", shifted) == 0
    assert db.query(Candle).filter(Candle.symbol == "XAUUSD").count() == 24


def test_replay_detected_in_backfill_of_older_history(db):
    """基线的时间下界要以"这批里最早那根"为锚,不能以服务器当前时间为锚。

    backfill 可能一次送来几天前的历史。若基线按"当前时间往前 N 小时"取,那批 bar
    的原件根本不在基线里,判定对整批失效。

    The baseline's lower bound must be anchored on the earliest bar of the batch,
    not on the server's current time. A backfill can deliver history from days
    ago; anchoring on "now" would leave those bars' originals outside the
    baseline and the check would do nothing for that batch."""
    # 一批"几天前"的历史,内部就含重放:后半段是前半段的整段平移。
    #
    # 往前退整数个 7 天,让这批时间戳落在与 _ANCHOR 相同的星期几和钟点上,从而必然
    # 在交易时段内——退任意天数会让它可能跨进周末窗口,那样拦下它的就是周末闸门,
    # 这个测试要验的"基线锚点"就被掩盖了。
    #
    # A batch of history from "days ago" that already contains a replay: the second
    # half is the first half shifted.
    #
    # Stepping back whole weeks keeps these timestamps on the same weekday and hour
    # as _ANCHOR, so they're necessarily inside a session. An arbitrary number of
    # days could land in the weekend window, and then the weekend gate — not the
    # baseline anchoring this test is about — would be what rejects them.
    base_min = 60 * 24 * 7 * 2
    real = [
        {
            "t": _epoch(base_min - i * 15),
            "o": 4100.0 + i * 0.51,
            "h": 4103.0 + i * 0.51,
            "l": 4097.2 + i * 0.51,
            "c": 4101.4 + i * 0.51,
            "v": 900 + i * 11,
        }
        for i in range(10)
    ]
    replays = [{**b, "t": b["t"] + 10 * 15 * 60} for b in real]
    n = persist_closed_bars(db, "XAUUSD", "15", [*real, *replays])
    assert n == 10
    rows = db.query(Candle).filter(Candle.interval == "15").all()
    assert sorted(r.t for r in rows) == sorted(b["t"] for b in real)


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


# ---------- 节假日/临时休市:价格停滞判定 ----------
# ---------- Holiday / unscheduled closures: stall detection ----------
def _drifting(count: int, start_minutes_ago: float, step_min: int = 5,
              base: float = 4000.0, drift: float = 1.7) -> list[dict]:
    """价格持续变动的真实行情,每根 OHLC 各不相同。
    Real bars with a continuously moving price, each OHLC distinct.
    """
    return [
        {
            "t": _epoch(start_minutes_ago - i * step_min),
            "o": base + i * drift - 0.5,
            "h": base + i * drift + 4.0,
            "l": base + i * drift - 4.0,
            "c": base + i * drift,
            "v": 700 + i,
        }
        for i in range(count)
    ]


def test_frozen_quote_is_rejected_even_when_bars_are_not_replayed_copies(db):
    """突发临时休市:报价冻结,但每根 h/l/v 都不同,因此与历史没有任何一根全等。

    这是重放判定拦不住的形态——它要求整根 OHLCV 与近期某根完全相同。也不在周末窗口内。
    只剩"价格不再变动"这一个可观测特征,正是这道闸门存在的理由:节假日和券商临时停某个
    品种都不在任何日历里,按日期判必然漏掉。

    An unscheduled closure: the quote freezes, but each bar's h/l/v differ, so no bar
    exactly matches any stored one. That shape defeats the replay check (which demands
    a full OHLCV match) and falls outside the weekend window. The only observable trait
    left is that the price stopped moving — the reason this gate exists, since holidays
    and a broker halting one symbol appear in no calendar.
    """
    real = _drifting(10, start_minutes_ago=200)
    assert persist_closed_bars(db, "XAUUSD", "5", real) == 10

    frozen_price = real[-1]["c"]
    frozen = [
        {
            "t": _epoch(145 - i * 5),
            "o": frozen_price,
            # h/l/v 每根都不同 -> 与历史任何一根都不全等 / never an exact match
            "h": frozen_price + 3.0 + i * 0.1,
            "l": frozen_price - 3.0 - i * 0.1,
            "c": frozen_price,
            "v": 900 + i,
        }
        for i in range(10)
    ]
    accepted = persist_closed_bars(db, "XAUUSD", "5", frozen)

    # 凑够阈值之前的那几根必须放行:那一刻"价格没动"与清淡盘无法区分。之后的全部拦掉。
    #
    # 这里是 阈值-2 而不是 阈值-1:冻结价格正是真实段最后一根的收盘价(休市时报价停在
    # 最后成交价,这才是真实形态),所以库里已经有 1 根同价 bar,游程跨批次连续累计,
    # 提前一根达标。这正是带上 previous_closes 的意义——否则每批都从 1 重新数,喂价端
    # 只要把批次切小就能一直绕过阈值。
    #
    # The bars before the threshold is reached must pass: at that moment "the price
    # hasn't moved" is indistinguishable from a thin session. Everything after is cut.
    #
    # This is threshold-2, not threshold-1: the frozen price is the real segment's last
    # close (a quote stalls at the last traded price — the realistic shape), so one
    # matching bar is already stored and the run carries across the batch boundary,
    # reaching the threshold a bar earlier. That's precisely why previous_closes is
    # consulted; without it every batch would restart at 1 and the feed could evade the
    # threshold indefinitely just by sending smaller batches.
    assert accepted == STALLED_CLOSE_BARS - 2
    stored = [r.c for r in db.query(Candle).order_by(Candle.t).all()]
    # 库里同价 bar = 真实段那 1 根 + 放行的这几根
    # Stored bars at that price = the 1 from the real segment + the ones let through
    assert stored.count(frozen_price) == STALLED_CLOSE_BARS - 1


def test_thin_but_moving_market_is_not_mistaken_for_a_closure(db):
    """清淡但真实的行情(如亚洲时段)必须全部放行。

    这是停滞判定最需要防的误伤方向:阈值取太小就会把真实的清淡盘当成休市丢掉。价格
    每根只动一分钱,但一直在动。
    A thin yet real session (e.g. Asian hours) must pass in full. This is the
    misfire direction the threshold guards against: too small a value would discard a
    genuinely quiet session. The price moves only a cent per bar, but it keeps moving.
    """
    thin = _drifting(12, start_minutes_ago=200, drift=0.01)
    assert persist_closed_bars(db, "XAUUSD", "5", thin) == 12


def test_market_reopening_after_a_closure_is_accepted(db):
    """休市结束、价格跳变后重开的行情必须放行,不能被前面的停滞连累。

    重开的 bar 以新批次进来,游程从 1 重新起算。若这里判错,休市结束后图表会一直不更新。
    Bars from a reopen (after a price jump) must be accepted and not tainted by the
    preceding stall: they arrive in a new batch where the run restarts at 1. Getting
    this wrong would leave the chart frozen after the closure ends.
    """
    frozen = [
        {"t": _epoch(200 - i * 5), "o": 4000.0, "h": 4000.0, "l": 4000.0,
         "c": 4000.0, "v": 500 + i}
        for i in range(8)
    ]
    persist_closed_bars(db, "XAUUSD", "5", frozen)

    reopened = _drifting(6, start_minutes_ago=150, base=4025.0, drift=2.5)
    assert persist_closed_bars(db, "XAUUSD", "5", reopened) == 6


def test_holiday_replay_is_rejected_across_a_multi_day_gap(db):
    """长假重放:原件与副本相隔两天以上,仍必须被认出来。

    重放基线原先固定取 26 小时,理由是"周末最长也就一天出头"。节假日连休(圣诞、元旦)
    把间隔拉到两三天,原件就落在基线之外,判定会像当初的滑动窗口那样整段失效——实测
    48 小时间隔时 24 根副本有 23 根被放行。现在短周期的基线跨度覆盖数日。
    A holiday replay whose original sits more than two days back must still be caught.
    The baseline used to be a fixed 26 hours, justified by "a weekend is at most a bit
    over a day". Multi-day holiday closures push the gap to two or three days, putting
    the original outside the baseline and failing wholesale as the old sliding window
    did — measured at 48 hours, 23 of 24 copies were accepted. Short intervals now span
    several days.
    """
    two_days = 60 * 24 * 2
    real = _drifting(12, start_minutes_ago=two_days + 200)
    assert persist_closed_bars(db, "XAUUSD", "5", real) == 12

    # 整段原样搬到两天后,OHLCV 逐字不变,只换时间戳。
    # The same stretch verbatim two days later; only the timestamps change.
    replay = [
        {**b, "t": b["t"] + two_days * 60}
        for b in real
    ]
    assert persist_closed_bars(db, "XAUUSD", "5", replay) == 0
