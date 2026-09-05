"""candle_store 四道闸门的回归测试。

**为什么要测。** 这是全仓库启发式最多、生产事故最多的模块（EA 时钟偏 11 小时、
周末重放伪造 K 线污染回测、时区换算错位 30 万行、休市冻结报价），此前却没有
任何测试 import 它。每道闸门对应过一次真实事故，这里逐一钉住：

  ① 周期网格：时间戳不在 gcd(周期, 半小时) 网格上 → 拒（半小时时区的小时线要放行）；
  ② 收盘判定：绝对时钟 或 同批有晚一整周期的邻居 → 算收盘（抗 EA 时钟快 11 小时）；
  ③ 周末窗口：UTC 周五 21:00 至周日 21:00 拒，BTCUSD/ETHUSD 豁免；
  ④ 价格停滞：连续 6 根收盘价不动，从第 6 根起丢尾段，库里的前序收盘价要接上；
  ⑤ 重放副本：OHLCV 五字段与回看窗口内某根全等 → 拒，平坦 bar 豁免，volume 必须参与。

外加：include_forming 只放宽收盘判定、persist 去重、M1 清理不碰其它周期。

Regression tests for the four candle gates. The module has more heuristics and
more production incidents than any other (EA clock 11h ahead, weekend replay
corrupting backtests, 300k misaligned rows, frozen quotes) and had zero tests.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import Candle
from app.services import candle_store as cs

SYM = "XAUUSD"


@pytest.fixture(autouse=True)
def _clear_baseline_cache():
    cs._baseline_cache.clear()
    yield
    cs._baseline_cache.clear()


def _ts(y, mo, d, h=0, mi=0):
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp())


def _bar(t, o=2000.0, h=2005.0, l=1995.0, c=2002.0, v=100):
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": v}


def _seed(db, interval, bars, symbol=SYM):
    for b in bars:
        db.add(Candle(symbol=symbol, interval=interval, t=b["t"],
                      o=b["o"], h=b["h"], l=b["l"], c=b["c"], v=b.get("v", 0)))
    db.commit()


# 2026-07-22 是周三，远在过去，收盘判定不受干扰 / a Wednesday well in the past
WED = _ts(2026, 7, 22, 10, 0)


def _walk(start, n, seconds, step=0.5):
    """n 根价格单调上行的 bar，互不重复。"""
    return [_bar(start + i * seconds, o=2000 + i * step, h=2001 + i * step,
                 l=1999 + i * step, c=2000.3 + i * step, v=100 + i) for i in range(n)]


# ---- ① 周期网格 / interval grid -----------------------------------------------------

def test_grid_seconds_is_gcd_with_half_hour():
    assert cs._grid_seconds(60) == 60
    assert cs._grid_seconds(300) == 300
    assert cs._grid_seconds(900) == 900
    assert cs._grid_seconds(3600) == 1800
    assert cs._grid_seconds(4 * 3600) == 1800
    assert cs._grid_seconds(86400) == 1800


def test_grid_rejects_off_grid_bars_but_keeps_half_hour_broker(db_session):
    good = _bar(WED)                       # 整点
    half = _bar(WED + 1800, c=2003, v=101)  # GMT+5:30 券商的小时线换算后落在 :30（OHLCV 不同，免得撞重放闸门）
    bad = _bar(WED + 3600 + 60, c=2004, v=102)  # 换算错位一分钟
    got = cs.filter_tradeable_bars(db_session, SYM, "60", [bad, half, good])
    assert [b["t"] for b in got] == [WED, WED + 1800]


def test_grid_rejects_minute_misalignment_on_five_minute(db_session):
    got = cs.filter_tradeable_bars(db_session, SYM, "5", [_bar(WED + 60), _bar(WED + 300)])
    assert [b["t"] for b in got] == [WED + 300]


def test_unknown_interval_or_empty_returns_nothing(db_session):
    assert cs.filter_tradeable_bars(db_session, SYM, "7", [_bar(WED)]) == []
    assert cs.filter_tradeable_bars(db_session, SYM, "60", []) == []


# ---- ② 收盘判定 / closed-or-forming -----------------------------------------------

def test_forming_bar_dropped_unless_include_forming(db_session):
    now = int(datetime.now(timezone.utc).timestamp())
    cur = now - now % 3600                              # 本小时（仍在形成）
    prev = cur - 3600
    # 用周三风格的时间避免撞上周末：若现在恰好是周末，换成 BTCUSD 豁免品种
    sym = "BTCUSD"
    got = cs.filter_tradeable_bars(db_session, sym, "60", [_bar(prev), _bar(cur, h=2010, c=2003)])
    assert [b["t"] for b in got] == [prev]
    got2 = cs.filter_tradeable_bars(db_session, sym, "60", [_bar(prev), _bar(cur, h=2010, c=2003)],
                                    include_forming=True)
    assert [b["t"] for b in got2] == [prev, cur]


def test_fast_feed_clock_still_closes_bars_with_later_neighbour(db_session):
    """EA 时钟快 11 小时：整批都在"未来"，但批内有晚一整周期的邻居的 bar 算收盘。
    只有最新那根（没有邻居）被拒，而不是整批清空——这是 2026-07-21 M1 三天不增长
    事故的根因之一。"""
    now = int(datetime.now(timezone.utc).timestamp())
    base = now + 11 * 3600
    base -= base % 60
    bars = [_bar(base, c=1.0), _bar(base + 60, c=2.0, h=3.0), _bar(base + 120, c=3.0, h=4.0)]
    got = cs.filter_tradeable_bars(db_session, "BTCUSD", "1", bars)
    assert [b["t"] for b in got] == [base, base + 60]


def test_batch_with_only_forming_bar_returns_empty(db_session):
    now = int(datetime.now(timezone.utc).timestamp())
    cur = now - now % 60
    assert cs.filter_tradeable_bars(db_session, "BTCUSD", "1", [_bar(cur)]) == []


# ---- ③ 周末窗口 / weekend window ---------------------------------------------------

@pytest.mark.parametrize("when, closed", [
    ((2026, 7, 24, 20, 59), False),   # 周五 20:59 还在交易
    ((2026, 7, 24, 21, 0), True),     # 周五 21:00 起休市
    ((2026, 7, 25, 12, 0), True),     # 周六
    ((2026, 7, 26, 20, 59), True),    # 周日 20:59 未开
    ((2026, 7, 26, 21, 0), False),    # 周日 21:00 开盘
    ((2026, 7, 27, 3, 0), False),     # 周一
])
def test_market_closed_window(when, closed):
    assert cs._is_market_closed(_ts(*when), SYM) is closed


def test_crypto_trades_through_weekend():
    assert cs._is_market_closed(_ts(2026, 7, 25, 12, 0), "BTCUSD") is False
    assert cs._is_market_closed(_ts(2026, 7, 25, 12, 0), "ethusd") is False


def test_weekend_bars_rejected_for_fx_but_not_crypto(db_session):
    fri = _ts(2026, 7, 24, 20, 0)
    sat = _ts(2026, 7, 25, 12, 0)
    fx = cs.filter_tradeable_bars(db_session, SYM, "60", [_bar(fri), _bar(sat, c=2003, h=2006)])
    assert [b["t"] for b in fx] == [fri]
    btc = cs.filter_tradeable_bars(db_session, "BTCUSD", "60", [_bar(fri), _bar(sat, c=2003, h=2006)])
    assert [b["t"] for b in btc] == [fri, sat]


# ---- ④ 价格停滞 / stalled price -----------------------------------------------------

def test_stalled_tail_needs_six_equal_closes_and_drops_from_the_sixth():
    same = [_bar(i, c=5.0) for i in range(8)]
    # 第 6 根（索引 5）起判停滞：8 根里丢最后 3 根
    assert cs._stalled_tail_length(same, []) == 3
    # 5 根凑不够阈值，全部放行（休市初期与清淡盘无法区分）
    assert cs._stalled_tail_length(same[:5], []) == 0


def test_stalled_tail_uses_stored_closes_before_the_batch():
    batch = [_bar(i, c=5.0) for i in range(3)]
    # 库里已有 4 根相同收盘价：批内第 2 根成为第 6 根 → 丢 2 根
    assert cs._stalled_tail_length(batch, [5.0] * 4) == 2
    # 库里的最后一根价格不同 → 游程从批内重新数，3 根不够
    assert cs._stalled_tail_length(batch, [5.0, 5.0, 5.0, 4.0]) == 0


def test_stalled_run_resets_on_price_change():
    bars = [_bar(i, c=5.0) for i in range(5)] + [_bar(5, c=6.0)] + [_bar(6 + i, c=6.0) for i in range(3)]
    assert cs._stalled_tail_length(bars, []) == 0


def test_stalled_gate_integration_reads_previous_closes(db_session):
    stored = [_bar(WED - (5 - i) * 60, c=7.0, h=7.5, l=6.5, v=i) for i in range(5)]
    _seed(db_session, "1", stored)
    batch = [_bar(WED, c=7.0, h=7.5, l=6.5, v=50), _bar(WED + 60, c=7.0, h=7.5, l=6.5, v=51)]
    assert cs.filter_tradeable_bars(db_session, SYM, "1", batch) == []


# ---- ⑤ 重放副本 / replayed copies ---------------------------------------------------

def test_replay_key_quantises_float_noise_and_includes_volume():
    a = _bar(1, o=4053.36, h=4055.70, l=4051.30, c=4055.12, v=1002)
    b = dict(a, o=4053.36 + 1e-9, t=2)
    assert cs._replay_key(a) == cs._replay_key(b)
    assert cs._replay_key(a) != cs._replay_key(dict(a, v=1003))
    assert cs._replay_key(a) != cs._replay_key(dict(a, c=4055.13))


def test_flat_bar_is_never_a_replay():
    flat = _bar(1, o=5, h=5, l=5, c=5, v=0)
    assert cs._is_replayed_duplicate(flat, {cs._replay_key(flat)}) is False


def test_replay_copy_of_stored_bar_rejected_but_different_volume_passes(db_session):
    real = _bar(WED - 900, o=4053.36, h=4055.70, l=4051.30, c=4055.12, v=1002)
    _seed(db_session, "15", [real])
    copy = dict(real, t=WED)                      # 同 OHLCV，新时间戳（周五收盘后的形态）
    near = dict(real, t=WED + 900, v=1003)        # 只差 volume → 真实行情
    got = cs.filter_tradeable_bars(db_session, SYM, "15", [copy, near])
    assert [b["t"] for b in got] == [WED + 900]


def test_replay_within_same_batch_rejected(db_session):
    a = _bar(WED, o=1.0, h=2.0, l=0.5, c=1.5, v=9)
    b = _bar(WED + 300, o=1.2, h=2.1, l=0.6, c=1.7, v=10)
    a_copy = dict(a, t=WED + 600)
    got = cs.filter_tradeable_bars(db_session, SYM, "5", [a, b, a_copy])
    assert [b_["t"] for b_ in got] == [WED, WED + 300]


def test_replay_baseline_respects_lookback_window(db_session):
    """H4 回看 26 小时：更早的原件不在基线里，同 OHLCV 的 bar 放行（不是重放）。"""
    old = _bar(WED - 30 * 3600, o=1.0, h=2.0, l=0.5, c=1.5, v=9)
    _seed(db_session, "240", [old])
    got = cs.filter_tradeable_bars(db_session, SYM, "240", [dict(old, t=WED)])
    assert [b["t"] for b in got] == [WED]
    cs._baseline_cache.clear()
    recent = _bar(WED - 8 * 3600, o=1.0, h=2.0, l=0.5, c=1.5, v=9)
    _seed(db_session, "240", [recent])
    assert cs.filter_tradeable_bars(db_session, SYM, "240", [dict(old, t=WED + 4 * 3600)]) == []


# ---- 组合 / combined -----------------------------------------------------------------

def test_gate_order_grid_before_everything_and_result_sorted(db_session):
    bars = _walk(WED, 4, 300)
    shuffled = [bars[2], bars[0], _bar(WED + 30), bars[3], bars[1]]   # 一根错位混进去
    got = cs.filter_tradeable_bars(db_session, SYM, "5", shuffled)
    assert [b["t"] for b in got] == [b["t"] for b in bars]


def test_filter_both_splits_forming_from_closed(db_session):
    now = int(datetime.now(timezone.utc).timestamp())
    cur = now - now % 300
    bars = [_bar(cur - 600, c=1.0), _bar(cur - 300, c=2.0, h=3.0), _bar(cur, c=3.0, h=4.0)]
    cacheable, tradeable = cs.filter_tradeable_bars_both(db_session, "BTCUSD", "5", bars)
    assert [b["t"] for b in cacheable] == [cur - 600, cur - 300, cur]
    assert [b["t"] for b in tradeable] == [cur - 600, cur - 300]
    assert cs.filter_tradeable_bars_both(db_session, "BTCUSD", "5", []) == ([], [])


def test_persist_skips_existing_and_reports_new_count(db_session):
    bars = _walk(WED, 3, 60)
    _seed(db_session, "1", bars[:1])
    assert cs.persist_closed_bars(db_session, SYM, "1", bars) == 2
    assert cs.persist_closed_bars(db_session, SYM, "1", bars) == 0
    assert db_session.query(Candle).filter_by(symbol=SYM, interval="1").count() == 3
    # prefiltered 直接落库，不再过闸门 / prefiltered bypasses the gates
    assert cs.persist_closed_bars(db_session, SYM, "1", [], prefiltered=[_bar(WED + 999)]) == 1


def test_cleanup_old_m1_touches_only_old_minute_bars(db_session):
    now = datetime.now(timezone.utc)
    old = int((now - timedelta(days=40)).timestamp())
    fresh = int((now - timedelta(days=5)).timestamp())
    _seed(db_session, "1", [_bar(old), _bar(fresh)])
    _seed(db_session, "5", [_bar(old)])
    assert cs.cleanup_old_m1(db_session, 30) == 1
    left = {(c.interval, c.t) for c in db_session.query(Candle)}
    assert left == {("1", fresh), ("5", old)}


def test_replay_baseline_cache_is_not_reused_for_an_older_batch(db_session):
    """先来一批实时 bar，60 秒内再来一批更早的回填：回填不能借用前者的基线——那份
    基线里的 bar 比回填自己还晚，与"只和更早的比"相反。同批 floor 相同才复用。"""
    real = _bar(WED, o=1.0, h=2.0, l=0.5, c=1.5, v=9)
    _seed(db_session, "5", [real])
    live = [_bar(WED + 3600, o=1.1, h=2.1, l=0.6, c=1.6, v=10)]
    assert len(cs.filter_tradeable_bars(db_session, SYM, "5", live)) == 1
    assert cs._baseline_cache[(SYM, "5")][2] == WED + 3600
    # 回填批：floor 在 real 之前，若复用上面的基线会把 real 当"更早的副本"误杀
    backfill = [dict(real, t=WED - 300)]
    got = cs.filter_tradeable_bars(db_session, SYM, "5", backfill)
    assert [b["t"] for b in got] == [WED - 300]
    assert cs._baseline_cache[(SYM, "5")][2] == WED - 300
