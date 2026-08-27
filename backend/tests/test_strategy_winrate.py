"""策略 × 交易时段胜率的分桶测试。

这里钉住的都是"静默算错"型的失败：时段边界写反、夏令时按固定 UTC 偏移算、
STALE/PENDING 混进分母——任何一条错了接口都照常 200，只是数字不对，而胜率
恰恰是最没人会去手工复核的那种数字。

Tests for the strategy x session win-rate bucketing.

Every case here pins a silent-miscount failure: an inverted session boundary,
DST handled as a fixed UTC offset, STALE/PENDING leaking into the denominator.
All of those still return 200 with merely wrong numbers — and a win rate is
exactly the sort of figure nobody hand-checks.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import Signal
from app.services import strategy_winrate as strategy_winrate_module
from app.services.strategy_winrate import (
    OUTSIDE_KEY,
    compute_strategy_session_winrate,
    session_keys_for,
)


def _frozen_datetime(instant: datetime) -> type:
    """构造一个 `.now()` 恒返回 `instant` 的 `datetime` 替身类，用来 monkeypatch
    掉 strategy_winrate 模块里的 `datetime`，冻结它内部算窗口边界用的
    `datetime.now(timezone.utc)`。不冻结的话，DB insert/commit 之间流逝的真实
    时间会让函数内部第二次取到的"现在"比测试捕获的晚几毫秒，24h 桶边界这种
    要求 elapsed 精确等于 k*86400 的用例就测不准。

    Build a `datetime` stand-in whose `.now()` always returns `instant`, used to
    monkeypatch strategy_winrate's `datetime` so the `datetime.now(timezone.utc)`
    it uses to compute the window boundary is frozen. Without freezing it, the
    real time elapsing between a DB insert/commit and the function's own second
    `datetime.now()` call pushes "now" a few milliseconds later than what the
    test captured, which makes 24h-bucket-boundary cases — which need elapsed to
    equal exactly k*86400 — impossible to pin down precisely."""

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return instant if tz is None else instant.astimezone(tz)

    return _Frozen


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _add(db, *, at: datetime, result: str, strategy: str = "Alpha", source: str = "tradingview",
         resolved_at: datetime | None = None, symbol: str = "XAUUSD",
         side: str = "BUY"):
    """在指定 UTC 时刻插入一条信号。created_at 列是 naive UTC，与生产写入一致。
    Insert a signal at a UTC instant; created_at is naive UTC as in production."""
    db.add(
        Signal(
            symbol=symbol,
            side=side,
            entry=2000.0,
            stop_loss=1990.0,
            take_profit=2010.0,
            indicator=strategy,
            source=source,
            result=result,
            created_at=at.astimezone(timezone.utc).replace(tzinfo=None),
            resolved_at=(
                resolved_at.astimezone(timezone.utc).replace(tzinfo=None)
                if resolved_at is not None else None
            ),
        )
    )
    db.commit()


# ---------- 时段归属 / session assignment ----------

def test_sessions_use_local_hours_not_fixed_utc_offsets():
    """同一个 UTC 小时，冬夏归属不同的时段——这正是"注意夏令时"的那一条。

    12:30 UTC：一月的伦敦是 12:30 GMT（欧洲盘内），纽约是 07:30 EST（纽约盘
    08:00 还没开）；七月的伦敦是 13:30 BST（仍在欧洲盘），纽约是 08:30 EDT
    （纽约盘已开）。按固定 UTC 区间算的实现会在两个日期给出同一个答案，因此
    必然挂在这条。

    The same UTC hour lands in different sessions in winter and summer — the
    DST case. At 12:30 UTC: in January London is 12:30 GMT (European session)
    while New York is 07:30 EST (not open yet); in July London is 13:30 BST
    (still European) and New York is 08:30 EDT (open). An implementation using
    fixed UTC ranges gives the same answer on both dates and fails here.
    """
    winter = datetime(2026, 1, 15, 12, 30, tzinfo=timezone.utc)
    summer = datetime(2026, 7, 15, 12, 30, tzinfo=timezone.utc)

    assert session_keys_for(winter) == ["europe"]
    assert set(session_keys_for(summer)) == {"europe", "newyork"}


def test_overlap_counts_in_both_sessions():
    """伦敦与纽约的重叠时段同时计入两边，不做互斥切分。
    The London/New York overlap counts toward both sessions."""
    # 2026-07-15 14:00 UTC = 伦敦 15:00 BST，纽约 10:00 EDT / London 15:00, NY 10:00
    keys = session_keys_for(datetime(2026, 7, 15, 14, 0, tzinfo=timezone.utc))
    assert set(keys) == {"europe", "newyork"}


def test_boundaries_are_half_open():
    """开始小时计入、结束小时不计入。写成闭区间会让 18:00 的东京信号被算进亚洲盘。
    Start hour in, end hour out; a closed range would file an 18:00 Tokyo signal
    under the Asian session."""
    # 东京 09:00 JST = 00:00 UTC（日本无夏令时）/ Tokyo 09:00 JST = 00:00 UTC
    assert "asia" in session_keys_for(datetime(2026, 3, 10, 0, 0, tzinfo=timezone.utc))
    # 东京 18:00 JST = 09:00 UTC，已在窗口外 / Tokyo 18:00 JST, outside the window
    assert "asia" not in session_keys_for(datetime(2026, 3, 10, 9, 0, tzinfo=timezone.utc))


def test_signals_in_no_session_go_to_outside():
    """三个时段之间的空档单列一桶，不丢弃。
    The gaps between sessions get their own bucket rather than being dropped."""
    # 2026-01-15 22:00 UTC：东京 07:00（未开）、伦敦 22:00、纽约 17:00（刚收）
    # Tokyo 07:00 (not open), London 22:00, New York 17:00 (just closed)
    assert session_keys_for(datetime(2026, 1, 15, 22, 0, tzinfo=timezone.utc)) == [OUTSIDE_KEY]


def test_naive_timestamps_are_read_as_utc():
    """created_at 列是 naive 的，必须按 UTC 解读而不是服务器本地时区。
    The created_at column is naive and must be read as UTC, not server-local."""
    aware = datetime(2026, 7, 15, 14, 0, tzinfo=timezone.utc)
    assert session_keys_for(aware.replace(tzinfo=None)) == session_keys_for(aware)


# ---------- 聚合 / aggregation ----------

def test_winrate_denominator_excludes_pending_and_stale(db):
    """PENDING 与 STALE 不进分母，但如实出现在计数里——与 /signals/winrate 同口径。
    PENDING and STALE stay out of the denominator but are still reported —
    the same definition as /signals/winrate."""
    now = datetime.now(timezone.utc)
    at = now - timedelta(hours=2)
    for result in ("HIT_TP", "HIT_TP", "HIT_SL", "PENDING", "STALE"):
        _add(db, at=at, result=result)

    out = compute_strategy_session_winrate(db, days=7)
    total = out["overall"]["total"]
    assert total["resolved"] == 3
    assert total["winRate"] == pytest.approx(2 / 3)
    assert total["pending"] == 1 and total["stale"] == 1
    assert total["samples"] == 5


def test_unknown_result_values_never_count_as_wins(db):
    """历史遗留的 WIN/LOSS 等未知状态并入 pending，绝不当成胜。
    Legacy WIN/LOSS and other unknown states fall into pending, never a win."""
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="WIN")
    _add(db, at=at, result="LOSS")

    total = compute_strategy_session_winrate(db, days=7)["overall"]["total"]
    assert total["resolved"] == 0
    assert total["winRate"] is None
    assert total["pending"] == 2


def test_only_tradingview_signals_are_counted(db):
    """mock 引擎的信号不进统计：它的 indicator 是拼了参数值的描述文本。
    Mock-engine signals are excluded; their indicator is parameter-laden text."""
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", source="mock", strategy="MA5/MA20, RSI=34.7")
    _add(db, at=at, result="HIT_SL")

    out = compute_strategy_session_winrate(db, days=7)
    assert [s["strategy"] for s in out["strategies"]] == ["Alpha"]
    assert out["overall"]["total"]["samples"] == 1


def test_window_excludes_older_signals(db):
    """窗口按 created_at 滚动，窗口外的信号不参与。
    The window rolls on created_at; anything older is out."""
    now = datetime.now(timezone.utc)
    _add(db, at=now - timedelta(days=1), result="HIT_TP")
    _add(db, at=now - timedelta(days=8), result="HIT_SL")

    out = compute_strategy_session_winrate(db, days=7)
    assert out["overall"]["total"]["samples"] == 1
    assert out["overall"]["total"]["winRate"] == 1.0


def test_strategies_are_split_and_session_buckets_add_up(db):
    """按策略分组；每个格子的 samples 之和（含 outside）不小于总数，重叠算两次。
    Grouped per strategy; per-session samples (incl. outside) sum to at least the
    total, since overlaps count twice."""
    now = datetime.now(timezone.utc)
    # 用固定时刻而不是 now-偏移，避免用例在一天中的某些时刻落进不同时段。
    # Fixed instants rather than offsets from now, so the case can't drift into a
    # different session depending on when it runs.
    at = now - timedelta(hours=1)
    _add(db, at=at, result="HIT_TP", strategy="Alpha")
    _add(db, at=at, result="HIT_SL", strategy="Alpha")
    _add(db, at=at, result="HIT_TP", strategy="Beta")

    out = compute_strategy_session_winrate(db, days=7)
    by_name = {s["strategy"]: s for s in out["strategies"]}
    assert by_name["Alpha"]["total"]["winRate"] == pytest.approx(0.5)
    assert by_name["Beta"]["total"]["winRate"] == 1.0
    # Alpha 样本多，排前面 / Alpha has more samples and sorts first
    assert out["strategies"][0]["strategy"] == "Alpha"

    for row in out["strategies"]:
        summed = sum(b["samples"] for b in row["sessions"].values())
        assert summed >= row["total"]["samples"] >= 1


def test_missing_strategy_name_becomes_empty_key(db):
    """没带 strategy 字段的信号仍然计入，归到空串键。
    Signals with no strategy field still count, under the empty-string key."""
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", strategy=None)

    out = compute_strategy_session_winrate(db, days=7)
    assert [s["strategy"] for s in out["strategies"]] == [""]
    assert out["overall"]["total"]["samples"] == 1


# ---------- 判定链路健康读数 / resolution-pipeline health ----------

def test_last_resolved_at_is_not_limited_by_the_window(db):
    """最近一次判定的时间必须能看到窗口之外。

    判定链路断掉时表格会满屏"0 笔"，而窗口内的任何数字都区分不了"最近没走出
    结果"和"判定坏了几周"。这个时间戳是唯一能区分的读数，所以它绝不能跟着
    days 一起被裁掉。

    The last-resolved timestamp must see outside the window. When the pipeline
    breaks the table fills with zeros, and nothing inside the window separates
    "nothing resolved lately" from "resolution died weeks ago". This timestamp is
    the only readout that can, so it must not be clipped by `days`.
    """
    now = datetime.now(timezone.utc)
    long_ago = now - timedelta(days=40)
    _add(db, at=long_ago, result="HIT_TP", resolved_at=long_ago)
    _add(db, at=now - timedelta(hours=2), result="PENDING")

    out = compute_strategy_session_winrate(db, days=7)
    # 窗口内一条都没判定……
    assert out["overall"]["total"]["resolved"] == 0
    assert out["overall"]["total"]["pending"] == 1
    # ……但仍然看得到 40 天前那次判定，据此可知链路是何时停的。
    assert out["lastResolvedAt"] is not None
    assert (now - out["lastResolvedAt"].replace(tzinfo=timezone.utc)).days >= 39


def test_last_resolved_at_is_none_when_nothing_ever_resolved(db):
    """从来没判定成功过时给 None——与"曾经工作过、现在停了"是两回事。
    None when resolution never once succeeded — a different situation from
    "it used to work and has stopped"."""
    _add(db, at=datetime.now(timezone.utc) - timedelta(hours=2), result="PENDING")
    assert compute_strategy_session_winrate(db, days=7)["lastResolvedAt"] is None


def test_stalled_pipeline_shows_pending_not_an_empty_cell(db):
    """判定链路停摆时，格子必须还能区分"没有信号"和"有信号但没判定"。
    A stalled pipeline must still leave "no signals" distinguishable from
    "signals nobody resolved"."""
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    for _ in range(12):
        _add(db, at=at, result="PENDING")

    total = compute_strategy_session_winrate(db, days=7)["overall"]["total"]
    assert total["samples"] == 12 and total["resolved"] == 0 and total["pending"] == 12
    assert total["winRate"] is None


# ---------- Wilson 置信下限 / Wilson lower bound ----------

from app.services.strategy_winrate import wilson_lower_bound


def test_wilson_known_values():
    """已知样本手算对照（z=1.96）。2/3 ≈ 0.2077，20/32 ≈ 0.4526。"""
    assert wilson_lower_bound(2, 3) == pytest.approx(0.2077, abs=1e-3)
    assert wilson_lower_bound(20, 32) == pytest.approx(0.4526, abs=1e-3)


def test_wilson_empty_denominator_is_none():
    assert wilson_lower_bound(0, 0) is None


def test_wilson_prefers_large_stable_samples():
    """55% × 40 笔要排在 80% × 5 笔前面——这就是推荐榜存在的意义。"""
    assert wilson_lower_bound(22, 40) > wilson_lower_bound(4, 5)


def test_wilson_stays_in_unit_interval():
    assert wilson_lower_bound(0, 5) == 0.0
    assert 0.0 <= wilson_lower_bound(5, 5) < 1.0


# ---------- 桶扩展字段 / extended bucket fields ----------

def test_weekly_signals_is_normalized_to_seven_days(db):
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    for _ in range(14):
        _add(db, at=at, result="PENDING")
    out = compute_strategy_session_winrate(db, days=7)
    assert out["overall"]["total"]["weeklySignals"] == 14.0
    out14 = compute_strategy_session_winrate(db, days=14)
    assert out14["overall"]["total"]["weeklySignals"] == 7.0


def test_avg_resolve_seconds_only_counts_resolved_rows(db):
    now = datetime.now(timezone.utc)
    _add(db, at=now - timedelta(hours=3), result="HIT_TP",
         resolved_at=now - timedelta(hours=2))          # 3600s
    _add(db, at=now - timedelta(hours=4), result="HIT_SL",
         resolved_at=now - timedelta(hours=2))          # 7200s
    _add(db, at=now - timedelta(hours=5), result="PENDING")
    _add(db, at=now - timedelta(hours=6), result="HIT_TP")  # resolved_at 缺失，跳过不崩

    total = compute_strategy_session_winrate(db, days=7)["overall"]["total"]
    assert total["avgResolveSeconds"] == pytest.approx(5400.0)


def test_avg_resolve_seconds_none_when_nothing_resolved(db):
    _add(db, at=datetime.now(timezone.utc) - timedelta(hours=2), result="PENDING")
    total = compute_strategy_session_winrate(db, days=7)["overall"]["total"]
    assert total["avgResolveSeconds"] is None


def test_daily_samples_length_and_sum(db):
    now = datetime.now(timezone.utc)
    _add(db, at=now - timedelta(hours=2), result="PENDING")       # 最后一桶
    _add(db, at=now - timedelta(days=6, hours=12), result="PENDING")  # 第一桶
    total = compute_strategy_session_winrate(db, days=7)["overall"]["total"]
    assert len(total["daily"]) == 7
    assert sum(total["daily"]) == total["samples"] == 2
    assert total["daily"][-1] == 1 and total["daily"][0] == 1


def test_daily_samples_bucket_boundary_exact_multiple_floors_into_next_bucket(db, monkeypatch):
    """elapsed 精确等于 k*86400 时归下标 k 的桶（floor 语义：边界值属于它开始的
    那一桶），而不是前一桶。

    旧版这条用真实 `datetime.now()`：测试捕获 `now` 之后要经过 DB insert +
    commit，函数内部才第二次调 `datetime.now()`，中间流逝的真实时间总是让
    elapsed 略小于精确的 6*86400，floor 结果被压成 5——测试碰巧是绿的，但没有
    真正钉住"恰好落在边界"这个精确行为：把 `//` 换成四舍五入之类的改动，这条
    测试大概率还是绿的。这里冻结时钟消掉那几毫秒漂移，让 elapsed 精确等于
    6 天，从而精确验证边界值归下标 6（7 天窗口的最后一桶，即"最近 24 小时"）
    而不是下标 5。

    When elapsed exactly equals k*86400, the signal goes into bucket k (floor
    semantics: a boundary value belongs to the bucket that starts there), not
    the bucket before it.

    The old version of this test drove elapsed off a real `datetime.now()`:
    after the test captured `now`, the DB insert + commit took real time before
    the function called `datetime.now()` a second time internally, which always
    pushed elapsed just under exactly 6*86400 — floor landed on 5 and the test
    stayed green, but it never actually pinned down the exact-boundary case: a
    change from `//` to rounding would likely still pass it. Freezing the clock
    here removes that drift so elapsed is exactly 6 days, precisely proving the
    boundary value lands in bucket index 6 (the last bucket of a 7-day window,
    i.e. "the last 24 hours") rather than index 5.
    """
    frozen_now = datetime(2026, 1, 10, 12, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(strategy_winrate_module, "datetime", _frozen_datetime(frozen_now))
    _add(db, at=frozen_now - timedelta(days=1), result="PENDING")  # elapsed == 6*86400 精确
    total = compute_strategy_session_winrate(db, days=7)["overall"]["total"]
    assert sum(total["daily"]) == 1
    assert total["daily"][6] == 1


def test_daily_samples_bucket_boundary_window_edge_is_clamped(db, monkeypatch):
    """elapsed 精确等于 days*86400（信号创建时刻等于函数内部算出的"现在"）时，
    未 clamp 的 floor 结果是 `days`，越过 `_daily`（长度 = days）的末尾一位；
    clamp 必须把它按回最后一桶，而不是抛 IndexError。这条钉住的正是 clamp
    本身的存在意义——去掉 `min(days - 1, ...)` 会让这条测试立刻炸。

    When elapsed exactly equals days*86400 (the signal's created_at coincides
    with the function's own computed "now"), the unclamped floor is `days`, one
    past the end of `_daily` (length == days); the clamp must fold it back into
    the last bucket instead of raising IndexError. This pins down the reason the
    clamp exists at all — removing `min(days - 1, ...)` makes this test blow up
    immediately.
    """
    frozen_now = datetime(2026, 1, 10, 12, 0, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(strategy_winrate_module, "datetime", _frozen_datetime(frozen_now))
    _add(db, at=frozen_now, result="PENDING")  # elapsed == 7*86400 精确（窗口最末尾）
    total = compute_strategy_session_winrate(db, days=7)["overall"]["total"]
    assert sum(total["daily"]) == 1
    assert total["daily"][6] == 1


# ---------- 品种子分层 / per-symbol sub-layer ----------

def test_symbols_sublayer_reconciles_with_strategy_buckets(db):
    """各品种桶逐字段加总必须恒等于策略桶——对账断言，钉住双重计数或漏计。"""
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", symbol="XAUUSD")
    _add(db, at=at, result="HIT_SL", symbol="XAUUSD")
    _add(db, at=at, result="HIT_TP", symbol="GBPUSD")
    _add(db, at=at, result="PENDING", symbol="GBPUSD")

    row = compute_strategy_session_winrate(db, days=7)["strategies"][0]
    assert [s["symbol"] for s in row["symbols"]] == ["XAUUSD", "GBPUSD"]  # resolved 降序
    for field in ("hitTp", "hitSl", "pending", "stale", "samples"):
        assert sum(s["total"][field] for s in row["symbols"]) == row["total"][field]
        for sess in row["sessions"]:
            assert (sum(s["sessions"][sess][field] for s in row["symbols"])
                    == row["sessions"][sess][field])


def test_symbol_total_ships_hourly_but_not_daily(db):
    """品种层带 `hourly` 不带 `daily`，且 `hourly` 只在 total 上。

    详情区要回答"这个策略**在这个品种上**，一天里哪个小时更准"，所以品种层的
    total 必须带钟点序列（2026-08-26 加）。`daily` 仍然不带——那条喂的是策略层的
    活跃度柱图，品种层没人画。时段桶与方向桶两条都不带：页面读的是 `total.hourly`，
    而品种 × 时段 × 24 格的样本已经薄到没有意义，下发了也只是白撑大响应体。

    The symbol layer ships `hourly` but not `daily`, and only on `total`.

    The detail view answers "which hour is this strategy best at *on this
    symbol*", so the symbol layer's total needs the hour series (added
    2026-08-26). `daily` stays off — it feeds the strategy-level activity
    sparkline, which the symbol layer never draws. Session and side buckets carry
    neither: the UI reads `total.hourly`, and a symbol x session x 24-cell sample
    is meaninglessly thin, so shipping it would only bloat the response.
    """
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", symbol="XAUUSD")
    out = compute_strategy_session_winrate(db, days=7)
    sym = out["strategies"][0]["symbols"][0]

    assert sym["total"]["daily"] is None
    assert sym["total"]["hourly"] is not None
    assert len(sym["total"]["hourly"]) == 24
    # 那一笔止盈必须真的落在它自己的 UTC 钟点里，不能只是分配了一个全零数组。
    # The one win must actually land in its own UTC hour, not merely allocate zeros.
    assert sum(c["tp"] for c in sym["total"]["hourly"]) == 1
    assert sym["total"]["hourly"][at.astimezone(timezone.utc).hour]["tp"] == 1

    # 时段桶与方向桶都不带 / neither on session nor side buckets
    for sess in sym["sessions"].values():
        assert sess["hourly"] is None and sess["daily"] is None
    for side in sym["sides"].values():
        assert side["hourly"] is None and side["daily"] is None

    # 全平台品种层同一套规则 / the platform-wide symbol layer follows the same rule
    assert out["overall"]["symbols"][0]["total"]["hourly"] is not None
    assert out["overall"]["symbols"][0]["total"]["daily"] is None

    # 策略层不受影响 / the strategy layer is unchanged
    assert out["strategies"][0]["total"]["daily"] is not None
    assert out["strategies"][0]["total"]["hourly"] is not None


def test_side_buckets_ship_neither_series(db):
    """方向桶两条序列都不下发——重构成"分配即开关"后这条最容易被顺手改掉。

    此前方向桶是照常分配 `_hr`、照常累加、就是不下发（纯空转）。现在改成不分配，
    所以"不下发"这件事从"`_finalize` 记得传 False"变成了"桶里压根没有"。行为没变，
    但保障它的机制变了，因此这条断言要单独留着。

    Side buckets ship neither series — the case most easily broken by the
    "allocation is the switch" refactor. They used to allocate `_hr`, accumulate
    into it, and simply not ship it (dead work); now they do not allocate at all,
    so "not shipped" moved from "`_finalize` remembered to pass False" to "the
    bucket never had one". The behaviour is unchanged but its guarantee is not,
    which is why this assertion stands on its own.
    """
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", side="BUY")
    _add(db, at=at, result="HIT_SL", side="SELL")

    row = compute_strategy_session_winrate(db, days=7)["strategies"][0]
    for key in ("BUY", "SELL"):
        assert row["sides"][key]["hourly"] is None
        assert row["sides"][key]["daily"] is None
        # 方向桶本身的计数仍然照常 / the side counts themselves still work
        assert row["sides"][key]["resolved"] == 1


def test_overall_symbols_are_platform_wide_not_per_strategy(db):
    """overall.symbols 是**全平台**的品种分布，跨策略合并。

    这份聚合不能由前端把各策略的 symbols 加起来求得——胜率不是可加量。同一个
    品种被两个策略各发一批信号时，正确答案是把两批原始行合起来算一个胜率，
    而不是把两个胜率平均。本用例用"两个策略在同一品种上胜率不同"的构造钉住
    这一点：若实现改成前端可推导的形式，加总会得到别的数字。

    overall.symbols is the platform-wide distribution merged across strategies.
    The UI cannot derive it by summing each strategy's symbols — a win rate is
    not additive. When two strategies fire on one symbol, the right answer pools
    the raw rows into a single rate rather than averaging two rates. This case
    pins that with two strategies posting different rates on the same symbol.
    """
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    # A 在 XAUUSD 上 2 胜 0 负；B 在 XAUUSD 上 0 胜 2 负 —— 合并应是 2/4 = 50%
    _add(db, at=at, result="HIT_TP", strategy="A", symbol="XAUUSD")
    _add(db, at=at, result="HIT_TP", strategy="A", symbol="XAUUSD")
    _add(db, at=at, result="HIT_SL", strategy="B", symbol="XAUUSD")
    _add(db, at=at, result="HIT_SL", strategy="B", symbol="XAUUSD")
    _add(db, at=at, result="HIT_TP", strategy="A", symbol="GBPUSD")

    out = compute_strategy_session_winrate(db, days=7)
    syms = {s["symbol"]: s for s in out["overall"]["symbols"]}
    assert set(syms) == {"XAUUSD", "GBPUSD"}
    assert syms["XAUUSD"]["total"]["resolved"] == 4
    assert syms["XAUUSD"]["total"]["winRate"] == pytest.approx(0.5)   # 不是 (100%+0%)/2 的巧合值
    assert syms["GBPUSD"]["total"]["resolved"] == 1
    # 与策略层的品种子分层各自独立、互不覆盖
    per_strategy = {r["strategy"]: r for r in out["strategies"]}
    a_xau = next(x for x in per_strategy["A"]["symbols"] if x["symbol"] == "XAUUSD")
    assert a_xau["total"]["winRate"] == 1.0


# ---------- 钟点胜负 / hour-of-day win-loss ----------

def test_hourly_has_24_slots_resolved_only(db):
    """钟点序列长度恒为 24，且**只含已判定**——未判定的不进这张图。
    The hourly series is always length 24 and holds resolved signals only;
    unresolved ones stay off this chart."""
    now = datetime.now(timezone.utc)
    at = now - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP")
    _add(db, at=at, result="HIT_SL")
    _add(db, at=at, result="PENDING")
    _add(db, at=at, result="STALE")

    total = compute_strategy_session_winrate(db, days=7)["overall"]["total"]
    hr = total["hourly"]
    assert len(hr) == 24
    assert sum(d["tp"] for d in hr) == 1
    assert sum(d["sl"] for d in hr) == 1
    # PENDING/STALE 一条都没进去：钟点图上总笔数 == 已判定数
    assert sum(d["tp"] + d["sl"] for d in hr) == total["resolved"] == 2
    assert total["samples"] == 4          # 但它们仍计入总样本


def test_hourly_index_is_utc_hour_of_day(db):
    """索引是 UTC 的第几个小时（0–23）。用固定时刻钉死，避免"跑的时候恰好对"，
    并特意选一个换算到常见本地时区会落到别的钟点的值。

    Index is the UTC hour of day (0-23), pinned to fixed instants so the case
    can't pass by coincidence; the values are chosen to land on a different hour
    in any common local zone."""
    three_utc = datetime(2026, 8, 17, 3, 30, tzinfo=timezone.utc)
    twenty_utc = datetime(2026, 8, 18, 20, 5, tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    days = (now - three_utc).days + 2
    _add(db, at=three_utc, result="HIT_TP")
    _add(db, at=twenty_utc, result="HIT_SL")

    hr = compute_strategy_session_winrate(db, days=days)["overall"]["total"]["hourly"]
    assert hr[3]["tp"] == 1 and hr[3]["sl"] == 0
    assert hr[20]["sl"] == 1 and hr[20]["tp"] == 0
    # 分钟被丢掉：03:30 归入第 3 格，不是第 4 格
    assert sum(d["tp"] + d["sl"] for d in hr) == 2


def test_hourly_aggregates_across_days(db):
    """同一个钟点跨多天累加到同一格——这正是按钟点分组的意义：一天只有一条
    样本时什么都看不出，窗口越长每格越厚。
    The same clock hour across several days lands in one slot — the point of
    grouping by hour: one day gives one sample per slot, and the longer window
    is what makes each slot thick enough to read."""
    base = datetime(2026, 8, 17, 9, 0, tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    for d in (0, 1, 2, 3):
        _add(db, at=base - timedelta(days=d), result="HIT_TP")
    days = (now - (base - timedelta(days=3))).days + 2

    hr = compute_strategy_session_winrate(db, days=days)["overall"]["total"]["hourly"]
    assert hr[9]["tp"] == 4
    assert sum(d["tp"] + d["sl"] for d in hr) == 4


def test_daily_is_plain_volume_counts(db):
    """daily 退回纯信号数数组（含未判定），供推荐卡的活跃度柱图用——与钟点图
    分别回答两个问题，不共用分桶。
    daily is a plain volume series including unresolved rows, feeding the
    recommendation card's sparkline — a different question from the hourly
    chart, deliberately not sharing its bucketing."""
    now = datetime.now(timezone.utc)
    _add(db, at=now - timedelta(hours=2), result="PENDING")
    _add(db, at=now - timedelta(days=6, hours=12), result="HIT_TP")

    total = compute_strategy_session_winrate(db, days=7)["overall"]["total"]
    assert len(total["daily"]) == 7
    assert all(isinstance(n, int) for n in total["daily"])
    assert sum(total["daily"]) == total["samples"] == 2


# ---------- 做多/做空 / long-short breakdown ----------

def test_sides_split_buy_and_sell(db):
    """按方向拆分，且两侧口径与总计一致。
    Split by direction, with the same denominator rule as the total."""
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", side="BUY")
    _add(db, at=at, result="HIT_TP", side="BUY")
    _add(db, at=at, result="HIT_SL", side="BUY")
    _add(db, at=at, result="HIT_SL", side="SELL")
    _add(db, at=at, result="HIT_SL", side="SELL")

    sides = compute_strategy_session_winrate(db, days=7)["overall"]["sides"]
    assert sides["BUY"]["hitTp"] == 2 and sides["BUY"]["hitSl"] == 1
    assert sides["BUY"]["winRate"] == pytest.approx(2 / 3)
    assert sides["SELL"]["winRate"] == 0.0        # 真实 0%，不是 None
    assert sides["SELL"]["resolved"] == 2


def test_unknown_side_joins_neither_bucket(db):
    """方向认不出的历史行不进任何一侧，宁可两侧之和小于总数也不硬塞。

    把方向不明的信号硬归到某一侧，会让"做多更赚还是做空更赚"这个结论建立在
    猜测上——那正是这个图表要回答的问题。

    A row with an unrecognized side joins neither bucket: better that the two
    sum to less than the total than to guess a direction, since the guess would
    corrupt the very question this chart answers.
    """
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", side="BUY")
    _add(db, at=at, result="HIT_TP", side="LONG")      # 历史遗留写法 / legacy
    _add(db, at=at, result="HIT_TP", side="")

    out = compute_strategy_session_winrate(db, days=7)["overall"]
    assert out["total"]["samples"] == 3                 # 三条都进总计
    assert out["sides"]["BUY"]["samples"] == 1
    assert out["sides"]["SELL"]["samples"] == 0
    assert (out["sides"]["BUY"]["samples"]
            + out["sides"]["SELL"]["samples"]) < out["total"]["samples"]


def test_side_lowercase_is_normalized(db):
    """摄入侧虽已 upper()，但历史行可能是小写——按大写归一后再分桶。
    Ingest upper-cases the side, but legacy rows may be lowercase; normalize."""
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", side="buy")
    assert compute_strategy_session_winrate(db, days=7)["overall"]["sides"]["BUY"]["samples"] == 1


def test_sides_omit_daily_distribution(db):
    """方向桶不下发每日分布：按天再切一刀样本更薄，而方向是跨窗口的问题。
    Side buckets ship no per-day distribution — slicing by day on top of by
    direction thins the sample further, and direction is a whole-window question."""
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", side="BUY")
    out = compute_strategy_session_winrate(db, days=7)["overall"]
    assert out["sides"]["BUY"]["daily"] is None and out["sides"]["BUY"]["hourly"] is None
    assert out["total"]["daily"] is not None


def test_symbol_layer_also_has_sides(db):
    """品种层同样带方向拆分——下钻到某个品种时也要能看做多/做空。
    The symbol layer carries the side split too, so drilling into one symbol
    still answers the long/short question."""
    at = datetime.now(timezone.utc) - timedelta(hours=2)
    _add(db, at=at, result="HIT_TP", side="BUY", symbol="XAUUSD")
    _add(db, at=at, result="HIT_SL", side="SELL", symbol="XAUUSD")

    sym = compute_strategy_session_winrate(db, days=7)["strategies"][0]["symbols"][0]
    assert sym["sides"]["BUY"]["hitTp"] == 1
    assert sym["sides"]["SELL"]["hitSl"] == 1
    assert sym["sides"]["BUY"]["daily"] is None and sym["sides"]["BUY"]["hourly"] is None


# ---------- 钟点格的对账 / hour-cell reconciliation ----------

def test_hourly_totals_reconcile_with_overall_resolved(db):
    """24 格加总必须等于整体已判定数——同一批数据的两条聚合路径（钟点格 vs
    总计桶）必须对得上，否则其中一条在静默漏计。
    Summing all 24 hour slots must equal the overall resolved count: two
    aggregation paths over the same rows must agree, or one is silently
    miscounting."""
    now = datetime.now(timezone.utc)
    for h, res, sd in [(2, "HIT_TP", "BUY"), (30, "HIT_SL", "BUY"), (54, "HIT_TP", "SELL"),
                       (78, "HIT_SL", "SELL"), (102, "HIT_TP", "BUY"), (126, "PENDING", "BUY")]:
        _add(db, at=now - timedelta(hours=h), result=res, side=sd)

    out = compute_strategy_session_winrate(db, days=7)["overall"]
    hr = out["total"]["hourly"]
    assert sum(c["tp"] for c in hr) == out["total"]["hitTp"]
    assert sum(c["sl"] for c in hr) == out["total"]["hitSl"]
    assert sum(c["tp"] + c["sl"] for c in hr) == out["total"]["resolved"]


def test_hourly_ignores_direction(db):
    """钟点格不按方向拆——只有胜负两个数。方向是详情区另一块的问题，
    24 × 2 个格子读不过来。
    Hour slots carry a win/loss pair only, with no direction split: direction is
    a separate block's question, and 24 x 2 cells is more than anyone reads."""
    at = datetime(2026, 8, 17, 9, 0, tzinfo=timezone.utc)
    days = (datetime.now(timezone.utc) - at).days + 2
    _add(db, at=at, result="HIT_TP", side="BUY")
    _add(db, at=at, result="HIT_SL", side="SELL")
    _add(db, at=at, result="HIT_TP", side="LONG")      # 历史遗留写法，方向认不出

    cell = compute_strategy_session_winrate(db, days=days)["overall"]["total"]["hourly"][9]
    assert set(cell) == {"tp", "sl"}
    # 方向认不出的那条照样进钟点格：这张图不问方向，就没有"猜不猜"的问题
    assert (cell["tp"], cell["sl"]) == (2, 1)


def test_hourly_slots_fill_evenly_over_a_full_day_sweep(db):
    """每小时一条铺满整个窗口时，24 格应当均匀——某一格明显多出来就说明分桶
    用错了字段（比如按滚动天而不是钟点）。
    With one signal per hour across the window, the 24 slots come out even; a
    slot bulging would mean the bucketing keyed off the wrong field (a rolling
    day rather than the clock hour)."""
    now = datetime.now(timezone.utc)
    for h in range(1, 169):
        _add(db, at=now - timedelta(hours=h), result="HIT_TP")

    hr = compute_strategy_session_winrate(db, days=7)["overall"]["total"]["hourly"]
    counts = [c["tp"] for c in hr]
    assert len(counts) == 24
    # 168 条铺 24 格 = 每格 7 条，允许 ±1 的边界浮动
    assert max(counts) - min(counts) <= 1, counts
