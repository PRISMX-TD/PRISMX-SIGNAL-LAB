"""/api/feed/candles 的单测：喂价端(EA)时钟跑偏时的纠偏逻辑。

真实事故背景：EA 那台机器的时钟比服务器快了约 11 小时,导致 K 线时间戳被
打成"未来",1 分钟线永远摸不到"已收盘"的门槛(见 candle_store.py 的相对
判定修复)。但即便写库成功了,存进去/显示出来的时间本身依然是错的——用户
两边时钟都不方便/不允许调整(经纪商服务器时间改不了,本地系统时间本身
是对的也不该为此去改),所以只能在这个入口把偏差识别出来并纠正回去。

这个纠偏功能本身上线当天又复现过一次真实回归：纠偏量如果每次请求都现算,
同一根还在形成中的 bar 会被纠正到不停变化的时间点(bar 自己的时间戳不变、
服务器时钟一直在走,两者差值持续缩小),chart_store 把每次都当成一根新
bar,图表看起来像"每次请求都冒出一根新蜡烛"。改成带迟滞的"同一挡位内取
最小值"缓存后修复,本文件同时覆盖这两轮问题的回归测试。

Unit tests for /api/feed/candles: the skew-correction logic for when the
feed's (EA) clock runs fast.

Real-incident background: the EA's host machine ran ~11h ahead of the
server, stamping bar timestamps into the "future" so 1-minute bars never hit
the "closed" threshold (see candle_store.py's relative-check fix). But even
once persistence started succeeding, the stored/displayed timestamps
themselves were still wrong — neither clock could reasonably be adjusted
(the broker's server time isn't user-adjustable; the local system clock was
already correct and shouldn't be touched just for this) — so the skew has to
be detected and corrected right at this ingestion boundary instead.

This correction feature itself regressed the same day it shipped: if the
correction amount were re-derived from scratch on every request, the same
still-forming bar would get corrected to a different point in time each time
(its own timestamp doesn't change while the server clock keeps advancing, so
the gap between them keeps shrinking), and chart_store would treat every one
as a brand-new bar — the chart appeared to spawn a fresh candle on every
request. Fixed with a hysteresis-and-minimum cache; this file covers
regression tests for both rounds.
"""
from datetime import datetime, timezone

import pytest

from app.core.config import settings
from app.models import Candle
from app.routers import chart as chart_module
from app.routers.chart import FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS, _correct_future_skew

M1_SECONDS = 60


@pytest.fixture(autouse=True)
def _reset_skew_cache():
    """`_skew_cache` 与 chart_store 的内存缓存都是模块级全局状态,不清空会在测试
    用例之间互相污染。
    `_skew_cache` and chart_store's in-memory cache are both module-level global
    state; must be cleared between tests or they'll contaminate each other."""
    chart_module._skew_cache.clear()
    chart_module.chart_store._candles.clear()
    yield
    chart_module._skew_cache.clear()
    chart_module.chart_store._candles.clear()


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


# ---------- _correct_future_skew() 纯函数单测 / pure-function unit tests ----------
def test_no_correction_when_within_threshold():
    now = _now()
    bars = [{"t": int(now) - 60, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    corrected, skew, is_new = _correct_future_skew(bars, now, ("XAUUSD", "1"), M1_SECONDS)
    assert skew == 0
    assert is_new is False
    assert corrected == bars


def test_corrects_bars_when_clock_runs_far_ahead():
    """复现事故量级：喂价端时钟超前约 11 小时。
    Reproduces the incident's magnitude: the feed's clock runs ~11h ahead."""
    now = _now()
    skew_seconds = 11 * 3600
    bars = [
        {"t": int(now) + skew_seconds, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
        {"t": int(now) + skew_seconds + 60, "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
    ]
    corrected, skew, is_new = _correct_future_skew(bars, now, ("XAUUSD", "1"), M1_SECONDS)
    assert skew > FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS
    assert is_new is True
    # 纠正后最新一根应该落在服务器"现在"附近(容差内),彼此的相对间隔(60秒)
    # 保持不变。/ After correction the newest bar should land near the
    # server's "now" (within tolerance); the 60s relative spacing is preserved.
    assert abs(max(b["t"] for b in corrected) - now) < 5
    assert corrected[1]["t"] - corrected[0]["t"] == 60


def test_does_not_correct_when_feed_is_behind_not_ahead():
    """喂价端时钟偏慢、或者收市期间最新一根天然落在过去,都不该被"纠正"——
    那样等于瞎猜着把旧数据往前挪。
    A feed clock running slow, or a market-closed period where the newest bar
    is genuinely in the past, must never be "corrected" — that would just be
    guessing and shifting old data forward."""
    now = _now()
    bars = [{"t": int(now) - 12 * 3600, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    corrected, skew, is_new = _correct_future_skew(bars, now, ("XAUUSD", "1"), M1_SECONDS)
    assert skew == 0
    assert is_new is False
    assert corrected == bars


def test_empty_bars_is_a_noop():
    corrected, skew, is_new = _correct_future_skew([], _now(), ("XAUUSD", "1"), M1_SECONDS)
    assert corrected == []
    assert skew == 0
    assert is_new is False


def test_same_forming_bar_gets_identical_correction_across_repeated_calls():
    """回归测试：同一根仍在形成中的 bar,在它形成期间被反复请求(tick 模式
    每几秒一次)时,纠正后的时间戳必须每次都一样——不能因为现算的偏差值
    随服务器时钟推进而"越纠越少",导致同一根 bar 每次都被纠正到不同时刻。

    Regression test: the same still-forming bar, repeatedly requested while
    it's forming (tick mode fires every few seconds), must always be
    corrected to the identical timestamp — it must not drift because the
    freshly-computed skew keeps shrinking as the server clock advances,
    correcting the same bar to a different instant each time.
    """
    base_now = _now()
    skew_seconds = 11 * 3600
    forming_bar_t = int(base_now) + skew_seconds  # bar 自己的时间戳全程不变 / this bar's own timestamp never changes

    corrected_ts: set[int] = set()
    # 模拟同一根 bar 形成期间的 6 次 tick 请求,服务器时钟从 0 走到 50 秒
    # (现算偏差从 skew_seconds 缩小到 skew_seconds - 50)。
    # Simulate 6 tick requests while the same bar is forming, the server
    # clock advancing from 0 to 50s (the raw skew shrinking accordingly).
    for elapsed in (0, 8, 17, 26, 35, 50):
        now = base_now + elapsed
        bars = [{"t": forming_bar_t, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
        corrected, _skew, _is_new = _correct_future_skew(bars, now, ("XAUUSD", "1"), M1_SECONDS)
        corrected_ts.add(corrected[0]["t"])

    assert len(corrected_ts) == 1, f"same bar corrected to different timestamps across calls: {corrected_ts}"


def test_cache_converges_to_maximum_within_a_regime_not_a_later_smaller_snapshot():
    """同一挡位内,后到的、偏差量更小的观测(bar 形成越久,现算偏差越小,见
    _correct_future_skew 内的锯齿说明)不该把纠偏量拉小——缓存要收敛到区间
    内观测到的最大值(最接近真实基准偏差,因为只有刚好在某根 bar 开始形成、
    刚被观测到时采样到的偏差,才最贴近真实基准)。

    Within the same regime, a later observation with a smaller raw skew (the
    longer a bar has been forming, the smaller the raw gap — see the sawtooth
    explanation inside _correct_future_skew) must not pull the cached
    correction down — it should converge to the maximum observed value
    (closest to the true base offset, since only a sample taken right as a
    bar is first observed, just as it starts forming, approaches that true
    value)."""
    now = _now()
    key = ("XAUUSD", "1")
    large = 11 * 3600  # 采样时刚好是某根 bar 刚开始形成 / sampled right as a bar starts forming
    small = large - 45  # 同一根 bar 形成 45 秒后再采样,现算偏差变小,仍在同一挡位 / same bar, 45s later, still same regime

    bars_large_skew = [{"t": int(now) + large, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    _corrected, skew1, _ = _correct_future_skew(bars_large_skew, now, key, M1_SECONDS)
    assert skew1 == pytest.approx(large, abs=1)

    bars_small_skew = [{"t": int(now) + small, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    _corrected, skew2, is_new2 = _correct_future_skew(bars_small_skew, now, key, M1_SECONDS)
    assert is_new2 is False  # 仍在同一挡位,不是"换挡" / still the same regime, not a "new regime"
    assert skew2 == pytest.approx(large, abs=1)  # 缓存仍锁定在更大(更接近真实基准)的观测值 / cache stays pinned to the larger (closer-to-true) observation

    # 再喂一个比缓存值更小的观测(比如同一根 bar 形成更久了),缓存不应该被
    # 拉小回去。/ Feeding a smaller observation again (the same bar having
    # formed even longer) must not pull the cache back down.
    _corrected, skew3, is_new3 = _correct_future_skew(bars_small_skew, now, key, M1_SECONDS)
    assert is_new3 is False
    assert skew3 == pytest.approx(large, abs=1)


def test_genuine_regime_change_beyond_hysteresis_reanchors():
    """偏差量真的跳变了(超出这个周期一整根 bar 的自然漂移范围,比如喂价端
    断线重连、DST 切换)才应该重新起算,而不是继续沿用旧挡位的缓存值。

    A genuine jump in the skew (beyond this interval's own natural drift
    range — e.g. the feed reconnecting, a DST transition) must re-anchor the
    cache, not keep reusing the old regime's cached value."""
    now = _now()
    key = ("XAUUSD", "1")
    first_skew = 11 * 3600
    bars1 = [{"t": int(now) + first_skew, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    _corrected, skew1, is_new1 = _correct_future_skew(bars1, now, key, M1_SECONDS)
    assert is_new1 is True
    assert skew1 == pytest.approx(first_skew, abs=1)

    # 跳变到一个明显不同的偏差量级(相差 2 小时,远超 1 分钟线一整根 bar
    # 的自然漂移上限)。/ Jump to a clearly different skew magnitude (2h away,
    # far beyond a single M1 bar's natural drift ceiling).
    second_skew = first_skew + 2 * 3600
    bars2 = [{"t": int(now) + second_skew, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    _corrected, skew2, is_new2 = _correct_future_skew(bars2, now, key, M1_SECONDS)
    assert is_new2 is True
    assert skew2 == pytest.approx(second_skew, abs=1)


def test_correction_preserves_the_bars_own_period_grid():
    """回归测试：纠偏量必须是周期长度的整数倍,否则同一根 bar 在纠偏缓存
    随后续请求微调(比如从"刚换挡"到"收敛到最大值")时,会被反复纠正到
    网格上不同的残数位置——存进数据库后每次都是不同的 t,造出好几行,图表
    上表现为错位/重复的蜡烛。真实场景里时钟偏差几乎不可能刚好是周期长度
    的整数倍(这里特意用一个不整除的偏差量,此前的测试全部凑巧用了能整除
    的 11 小时,掩盖了这个问题)。

    Regression test: the correction must be a whole multiple of the bar's own
    period length, or the same bar gets corrected to a different residue on
    the grid as the cached skew gets nudged across requests (e.g. "just
    re-anchored" vs "converged to the maximum") — each producing a different
    stored t, i.e. multiple rows for what should be one bar, rendering as a
    duplicate/misaligned candle on the chart. Real-world clock skew is
    essentially never an exact multiple of the interval (this test
    deliberately picks a skew that doesn't divide evenly — every earlier test
    happened to use 11h, which divides every interval here cleanly, masking
    this)."""
    interval_seconds = 300  # 5 分钟线 / M5
    now = _now()
    aligned_t = int(now // interval_seconds) * interval_seconds  # 已对齐网格的原始时间戳 / already grid-aligned
    skew_seconds = 39623  # 不是 300 的整数倍 / not a multiple of 300
    bars = [{"t": aligned_t + skew_seconds, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]

    corrected, _skew, _is_new = _correct_future_skew(bars, now, ("XAUUSD", "5"), interval_seconds)

    # 纠正只应该挪动整数根周期,不改变 bar 落在自己网格里的残数位置。
    # Correction must shift by whole periods only, never changing which slot
    # within the period the bar's own timestamp falls into.
    assert corrected[0]["t"] % interval_seconds == bars[0]["t"] % interval_seconds


def test_large_interval_tolerates_its_own_full_bar_duration_of_drift():
    """周期越长,同一根仍在形成中的 bar 天然能漂移的范围越大(比如日线最长
    24 小时)——迟滞阈值必须按周期本身的秒数放大,不能对所有周期用同一个
    固定阈值,否则大周期会被误判成"换挡"而不必要地重新起算。

    Larger intervals naturally allow more drift while the same bar is still
    forming (e.g. up to 24h for a daily bar) — the hysteresis threshold must
    scale with the interval's own duration, not use one fixed threshold for
    every interval, or large intervals would be misclassified as a "regime
    change" and needlessly re-anchored."""
    now = _now()
    key = ("XAUUSD", "D")
    day_seconds = 24 * 3600
    base_skew = 11 * 3600  # 采样时刚好是这根日线 bar 刚开始形成 / sampled right as this daily bar starts forming
    bars1 = [{"t": int(now) + base_skew, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    _corrected, skew1, is_new1 = _correct_future_skew(bars1, now, key, day_seconds)
    assert is_new1 is True

    # 同一根日线 bar 形成了 5 小时后再采样,现算偏差变小了(远超 1 分钟线的
    # 迟滞阈值,但完全在日线自己的自然漂移范围内),不该被判成"换挡"。
    # The same daily bar sampled again 5 hours into its own formation, the
    # raw skew having shrunk (way beyond M1's hysteresis, but well within a
    # daily bar's own natural drift range) must not be misread as a "regime
    # change".
    drifted_skew = base_skew - 5 * 3600
    bars2 = [{"t": int(now) + drifted_skew, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    _corrected, skew2, is_new2 = _correct_future_skew(bars2, now, key, day_seconds)
    assert is_new2 is False
    assert skew2 == pytest.approx(base_skew, abs=1)  # 仍锁定在较大(更早期采样)的那个观测值 / still pinned to the larger (earlier-sampled) observation


# ---------- /api/feed/candles 端到端:纠正后的时间戳才是落库的时间戳 ----------
# ---------- End-to-end: the corrected timestamp is what actually lands in the DB ----------
def test_future_skewed_bars_are_corrected_before_persisting(client, db, monkeypatch):
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    now = _now()
    skew_seconds = 11 * 3600
    bars = [
        {"t": int(now) + skew_seconds, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
        {"t": int(now) + skew_seconds + 60, "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
    ]
    res = client.post(
        "/api/feed/candles",
        headers={"X-EA-Token": "test-ea-token"},
        json={"mode": "tick", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": bars}]},
    )
    assert res.status_code == 200

    rows = db.query(Candle).filter(Candle.symbol == "XAUUSD", Candle.interval == "1").all()
    assert len(rows) == 1
    # 落库的那根是"较早"的一根(比另一根早 60 秒;那一根仍在形成中,还没收盘),
    # 它的 t 应该已经被纠正到贴近真实"现在减 60 秒",而不是原始的、超前 11
    # 小时的那个值。
    # The persisted row is the "earlier" bar (60s before the other one, which
    # is still forming); its t should already be corrected to near the real
    # "now minus 60s", not the original ~11h-ahead value.
    assert abs(rows[0].t - (int(now) - 60)) < 5
    assert rows[0].t != bars[0]["t"]


def test_repeated_tick_requests_for_same_forming_bar_do_not_spam_new_rows(client, db, monkeypatch):
    """回归测试：同一根仍在形成中的 bar 被连续多次 tick 请求上报时,不应该
    在数据库里造出好几行不同时间戳的记录(它压根不该被当成"已收盘"插进去,
    但即便判定逻辑有变化,至少不能因为纠偏量抖动而各次都产生不同的落库
    时间)。这里直接复现"图表变成每秒冒一根新蜡烛"的真实场景。

    Regression test: the same still-forming bar, reported across several
    consecutive tick requests, must not produce multiple differently-timed
    rows in the database (it shouldn't be treated as "closed" and inserted at
    all, but even setting that aside, repeated correction must never itself
    produce a different timestamp each time). Directly reproduces the real
    "chart spawns a new candle every second" scenario.
    """
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    skew_seconds = 11 * 3600
    base_now = _now()
    forming_t = int(base_now) + skew_seconds
    prev_closed_t = forming_t - 60  # 上一根已经收盘的 bar / the previous, already-closed bar

    for _ in range(5):
        bars = [
            {"t": prev_closed_t, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
            {"t": forming_t, "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
        ]
        res = client.post(
            "/api/feed/candles",
            headers={"X-EA-Token": "test-ea-token"},
            json={"mode": "tick", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": bars}]},
        )
        assert res.status_code == 200

    rows = db.query(Candle).filter(Candle.symbol == "XAUUSD", Candle.interval == "1").all()
    # 5 次请求里,只有那根"已收盘"的 bar 该被插入,且只插入一次(去重);仍在
    # 形成中的那根全程不该落库。
    # Across the 5 requests, only the already-closed bar should ever be
    # inserted, and only once (de-duplicated); the still-forming one must
    # never land in the database.
    assert len(rows) == 1


# ---------- mode=history:一次性历史回填 / one-off history seeding ----------
def _history_bars(count: int, end_t: int, step: int = 900) -> list[dict]:
    """生成 count 根真实感的 bar,时间升序,结束于 end_t。

    每根的 OHLC 都不同——candle_store 会把"整根 OHLCV 与近期某根完全相同"的
    bar 判定为休市重放并丢弃,全用同一个价格会让这些 bar 根本插不进去。
    Generate `count` realistic ascending bars ending at end_t. Each has distinct
    OHLC values: candle_store drops any bar whose entire OHLCV matches a recent
    one as a market-closed replay, so reusing one price would prevent insertion.
    """
    return [
        {
            "t": end_t - (count - 1 - i) * step,
            "o": 100.0 + i,
            "h": 101.0 + i,
            "l": 99.0 + i,
            "c": 100.5 + i,
            "v": 10 + i,
        }
        for i in range(count)
    ]


def test_history_mode_persists_bars_without_touching_the_live_cache(client, db, monkeypatch):
    """mode=history 只落库,不写内存缓存。

    历史批次推的是很久以前的一段,如果走 replace_series 整段替换内存缓存,实时
    图表会突然显示两年前的蜡烛,直到下一次日常 backfill 才恢复。
    mode=history persists only, never writing the in-memory cache: a history batch
    carries a stretch from long ago, and replacing the cache with it would make
    the live chart display two-year-old candles until the next routine backfill.
    """
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    chart_module.chart_store.replace_series("XAUUSD", "15", [{"t": 1, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}])

    end_t = int(_now()) - 30 * 86400  # 一个月前,确保全部已收盘 / a month ago, all closed
    bars = _history_bars(50, end_t)
    res = client.post(
        "/api/feed/candles",
        headers={"X-EA-Token": "test-ea-token"},
        json={"mode": "history", "series": [{"symbol": "XAUUSD", "interval": "15", "bars": bars}]},
    )
    assert res.status_code == 200

    rows = db.query(Candle).filter(Candle.symbol == "XAUUSD", Candle.interval == "15").all()
    assert len(rows) == 50

    # 内存缓存必须还是原来那一根,没有被历史批次覆盖。
    # The cache must still hold the original single bar, untouched by the batch.
    cached = chart_module.chart_store.get_history("XAUUSD", "15", 500)
    assert len(cached) == 1
    assert cached[0]["t"] == 1


def test_history_mode_does_not_evaluate_strategies(client, db, monkeypatch):
    """mode=history 不触发策略求值。

    策略求值的语义是"刚有一根新 K 线收盘",会写信号、推送通知、并推进去重游标。
    历史回填时每一批都被当成"刚收盘"就会凭空产生成千上万条历史信号并给用户
    发推送,游标也会被推到历史某个点、让真实的新 K 线被误判为已处理。
    mode=history must not trigger strategy evaluation: it means "a bar just
    closed" and writes signals, sends pushes and advances the dedup cursor.
    Treating each seeded batch as just-closed would fabricate thousands of
    historical signals, push them to users, and drag the cursor into the past so
    genuinely new bars get judged already-handled.
    """
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    calls: list[tuple[str, str]] = []

    async def _spy(symbol: str, interval: str):
        calls.append((symbol, interval))

    monkeypatch.setattr(chart_module.strategy_live, "evaluate_new_candle", _spy)

    end_t = int(_now()) - 30 * 86400
    payload = {"mode": "history", "series": [{"symbol": "XAUUSD", "interval": "15", "bars": _history_bars(20, end_t)}]}
    assert client.post("/api/feed/candles", headers={"X-EA-Token": "test-ea-token"}, json=payload).status_code == 200
    assert calls == []

    # 对照:同样的数据走 backfill 就应该求值,证明上面的空结果不是因为数据本身
    # 没插进去。/ Control: the same data via backfill must evaluate, proving the
    # empty result above isn't just "nothing got inserted".
    payload["mode"] = "backfill"
    payload["series"][0]["interval"] = "60"
    assert client.post("/api/feed/candles", headers={"X-EA-Token": "test-ea-token"}, json=payload).status_code == 200
    assert calls == [("XAUUSD", "60")]


def test_history_mode_is_idempotent_across_reruns(client, db, monkeypatch):
    """重复回填同一段不产生重复行——EA 重启会从头再跑一遍回填,靠的就是这个。
    Re-seeding the same stretch creates no duplicate rows; the EA restarting and
    re-running the whole seed relies on this."""
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    end_t = int(_now()) - 30 * 86400
    payload = {"mode": "history", "series": [{"symbol": "XAGUSD", "interval": "15", "bars": _history_bars(30, end_t)}]}

    for _ in range(3):
        assert client.post("/api/feed/candles", headers={"X-EA-Token": "test-ea-token"}, json=payload).status_code == 200

    rows = db.query(Candle).filter(Candle.symbol == "XAGUSD", Candle.interval == "15").all()
    assert len(rows) == 30


def test_history_batch_does_not_wipe_the_live_skew_cache(client, db, monkeypatch):
    """回归测试：历史批次不能擦掉实时链路已经收敛出来的纠偏量。

    _correct_future_skew 用"这一批最新一根 vs 服务器当前时间"探测偏差,而历史
    批次最新的一根本来就在很久以前,算出来必然为负,那个函数会把缓存整条 pop
    掉。若历史回填走那条路,每灌一批就会把实时链路的纠偏量清零,下一批实时
    bar 得从头重新起算——时钟跑偏的喂价端会因此反复出现错位蜡烛。
    Regression test: a history batch must not wipe the skew the live path
    converged on. _correct_future_skew detects the offset from "this batch's
    newest bar vs now", and a history batch's newest bar is old by definition, so
    the computed skew is negative and the function pops the cache entry. Routing
    seeding through it would zero the live correction on every batch, forcing a
    re-anchor each time — producing recurring misaligned candles for a
    clock-skewed feed."""
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    key = ("XAUUSD", "15")
    chart_module._skew_cache[key] = 11 * 3600

    end_t = int(_now()) - 30 * 86400
    res = client.post(
        "/api/feed/candles",
        headers={"X-EA-Token": "test-ea-token"},
        json={"mode": "history", "series": [{"symbol": "XAUUSD", "interval": "15", "bars": _history_bars(10, end_t)}]},
    )
    assert res.status_code == 200
    assert chart_module._skew_cache.get(key) == 11 * 3600

    # 而且纠偏要真的被应用到历史 bar 上,否则它们会和实时链路存进去的 bar
    # 在时间轴上错开一截。/ And the correction must actually be applied, or these
    # bars would sit offset from the ones the live path stored.
    rows = db.query(Candle).filter(Candle.symbol == "XAUUSD", Candle.interval == "15").order_by(Candle.t).all()
    assert len(rows) == 10
    assert rows[-1].t == end_t - 11 * 3600


# ---------- GET /api/chart/history:读库 + before 游标分页 ----------
# ---------- Reads the database, paginated with the `before` cursor ----------
def _seed_candles(db, symbol: str, interval: str, count: int, end_t: int, step: int = 900) -> None:
    for b in _history_bars(count, end_t, step):
        db.add(Candle(symbol=symbol, interval=interval, **b))
    db.commit()


def test_chart_history_reads_the_database_not_the_memory_cache(client, db, auth_headers):
    """图表历史必须来自数据库,与策略回测同源。

    以前读的是 chart_store 内存缓存:硬上限 500 根、进程重启即空,而回测一直读
    Candle 表。两边时间范围不同,用户在图上看到的和策略据以计算的可能不是同一批
    数据——这正是回测图标记错位那次事故的同类问题。
    Chart history must come from the database, the same source as the backtest.
    It used to read the chart_store cache (capped at 500 bars, emptied on
    restart) while the backtest always read the Candle table; different ranges
    meant what the user saw and what strategies computed on could differ — the
    same class of bug as the misaligned backtest-chart markers.
    """
    end_t = int(_now()) - 86400
    _seed_candles(db, "XAUUSD", "15", 20, end_t)
    # 内存缓存里放一根完全不同的 bar:如果接口还在读缓存,断言会抓到它。
    # Put a distinct bar in the cache: if the endpoint still reads it, this catches it.
    chart_module.chart_store.replace_series("XAUUSD", "15", [{"t": 999, "o": 9, "h": 9, "l": 9, "c": 9, "v": 9}])

    res = client.get("/api/chart/history?symbol=XAUUSD&interval=15", headers=auth_headers)
    assert res.status_code == 200
    bars = res.json()["bars"]
    assert len(bars) == 20
    assert [b["t"] for b in bars] == sorted(b["t"] for b in bars)  # 升序返回 / ascending
    assert all(b["t"] != 999 for b in bars)


def test_chart_history_returns_the_newest_page_when_more_exist_than_the_limit(client, db, auth_headers):
    """超过 limit 时返回的必须是"最新"那一页,而不是最早那一页。

    正序 limit 会永远返回库里最早的那些,新数据再多也追不上,图表看起来卡在某个
    历史日期(与 _load_backtest_bars 记录的是同一个坑)。
    When more rows exist than `limit`, the newest page must come back, not the
    oldest: an ascending limit would forever return the earliest rows no matter
    how much new data arrives, leaving the chart stuck at some past date (the
    same trap documented in _load_backtest_bars).
    """
    end_t = int(_now()) - 86400
    _seed_candles(db, "XAUUSD", "15", 50, end_t)

    res = client.get("/api/chart/history?symbol=XAUUSD&interval=15&limit=10", headers=auth_headers)
    bars = res.json()["bars"]
    assert len(bars) == 10
    assert bars[-1]["t"] == end_t  # 最新那根在页尾 / newest bar ends the page
    assert res.json()["hasMore"] is True


def test_chart_history_before_cursor_pages_backwards_without_gaps_or_overlap(client, db, auth_headers):
    """用 before 游标连续往左翻,必须严格衔接:不重复、不跳过。
    Paging left with the `before` cursor must join up exactly: no duplicates, no
    skipped bars."""
    end_t = int(_now()) - 86400
    _seed_candles(db, "XAUUSD", "15", 30, end_t)

    first = client.get("/api/chart/history?symbol=XAUUSD&interval=15&limit=10", headers=auth_headers).json()
    second = client.get(
        f"/api/chart/history?symbol=XAUUSD&interval=15&limit=10&before={first['bars'][0]['t']}",
        headers=auth_headers,
    ).json()

    assert len(second["bars"]) == 10
    # 第二页整体早于第一页,且两页拼起来正好是连续的 20 根。
    # The second page is entirely older, and the two join into 20 contiguous bars.
    assert second["bars"][-1]["t"] < first["bars"][0]["t"]
    joined = [b["t"] for b in second["bars"] + first["bars"]]
    assert joined == sorted(joined)
    assert len(set(joined)) == 20
    assert all(joined[i + 1] - joined[i] == 900 for i in range(len(joined) - 1))


def test_chart_history_reports_no_more_pages_at_the_oldest_bar(client, db, auth_headers):
    """翻到最早一根之后 hasMore 必须为 false,否则前端会无限往左请求空页。
    Past the oldest bar hasMore must be false, or the client would keep
    requesting empty pages forever."""
    end_t = int(_now()) - 86400
    _seed_candles(db, "XAUUSD", "15", 5, end_t)

    full = client.get("/api/chart/history?symbol=XAUUSD&interval=15&limit=10", headers=auth_headers).json()
    assert len(full["bars"]) == 5
    assert full["hasMore"] is False

    beyond = client.get(
        f"/api/chart/history?symbol=XAUUSD&interval=15&limit=10&before={full['bars'][0]['t']}",
        headers=auth_headers,
    ).json()
    assert beyond["bars"] == []
    assert beyond["hasMore"] is False


def test_chart_history_limit_can_exceed_the_old_500_bar_cap(client, db, auth_headers):
    """回归测试：单次请求不再被旧的 500 根内存缓存上限卡住。

    500 这个数原本是 chart_store.MAX_BARS,接口把它当成 limit 的上界,于是即便
    库里存着两年历史也只能取到 500 根。
    Regression test: a single request is no longer capped by the old 500-bar
    in-memory limit. That number was chart_store.MAX_BARS, used as the `limit`
    ceiling, so only 500 bars were reachable even with two years stored.
    """
    end_t = int(_now()) - 86400
    _seed_candles(db, "XAUUSD", "15", 600, end_t)

    res = client.get("/api/chart/history?symbol=XAUUSD&interval=15&limit=600", headers=auth_headers)
    assert res.status_code == 200
    assert len(res.json()["bars"]) == 600


def test_chart_history_rejects_an_unknown_interval(client, auth_headers):
    res = client.get("/api/chart/history?symbol=XAUUSD&interval=30", headers=auth_headers)
    assert res.status_code == 400
