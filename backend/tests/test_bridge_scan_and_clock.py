"""桥接侧两处修复：离线缺口补扫，以及成交时间换算成真 UTC。

两者都在 bridge/mt5_worker.py 里，但被测的是纯函数，不需要装 MetaTrader5
（该模块对缺包是容错的），所以直接把 bridge 目录挂进 sys.path 来测。

**为什么值得测**：
- 补扫窗口决定了"桥接离线期间的平仓还能不能补回来"。原来固定回看 15 分钟，
  离线更久就永久漏报——而漏报的仓位会被后端整笔剔除，那笔盈亏凭空消失。
  这一条还能被主动利用（关桥接 → 手动平掉亏损单 → 再开）。
- 时间换算决定了周/月边界与比赛起止的落窗。MT5 的时间戳是按**服务器墙钟**算的
  epoch，直接当 UTC 落库会整体偏几小时。

Bridge-side fixes: offline catch-up scanning and true-UTC deal timestamps. Both
are pure functions in bridge/mt5_worker.py, tested by putting the bridge dir on
sys.path (the module tolerates a missing MetaTrader5 package).
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_BRIDGE_DIR = Path(__file__).resolve().parents[2] / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

import mt5_worker  # noqa: E402


NOW = datetime(2026, 8, 26, 12, 0, 0)
LOGIN = "500123"


# ---------- 离线缺口补扫 / catch-up scanning ----------

def test_first_scan_of_the_process_backfills():
    """进程刚起（没有游标）：必须按补扫窗口回看，而不是只看 15 分钟。

    桥接重启前那段离线时间正是最容易漏平仓的地方。
    """
    since, catching_up = mt5_worker._scan_window(NOW, None)

    assert catching_up is True
    assert since == NOW - mt5_worker._BACKFILL_WINDOW


def test_steady_state_keeps_the_narrow_window():
    """正常轮询（上次扫描就在几秒前）：保持固定 15 分钟窗口，不做多余的重扫。"""
    since, catching_up = mt5_worker._scan_window(NOW, NOW - timedelta(seconds=2))

    assert catching_up is False
    assert since == NOW - mt5_worker._TRADE_SCAN_WINDOW


def test_short_gap_within_the_window_is_not_a_catch_up():
    """缺口没超过常规窗口 → 固定窗口本来就盖得住，不必补扫。"""
    since, catching_up = mt5_worker._scan_window(NOW, NOW - timedelta(minutes=14))

    assert catching_up is False
    assert since == NOW - mt5_worker._TRADE_SCAN_WINDOW


def test_gap_longer_than_the_window_triggers_a_catch_up_with_margin():
    """离线 3 小时：从上次扫到的点再往前留一个常规窗口的安全边距开始扫。"""
    last = NOW - timedelta(hours=3)

    since, catching_up = mt5_worker._scan_window(NOW, last)

    assert catching_up is True
    assert since == last - mt5_worker._TRADE_SCAN_WINDOW
    assert since <= last, "补扫起点必须早于上次扫描点，否则中间那段仍会漏"


def test_very_long_outage_is_capped_at_the_backfill_window():
    """离线一个月：回看量必须封顶，不能让首轮扫描无限重。"""
    since, catching_up = mt5_worker._scan_window(NOW, NOW - timedelta(days=30))

    assert catching_up is True
    assert since == NOW - mt5_worker._BACKFILL_WINDOW


def test_clock_jumping_backwards_does_not_explode():
    """服务器时间回跳（夏令时/校时）：走常规路径即可，不能算成负缺口。"""
    since, catching_up = mt5_worker._scan_window(NOW, NOW + timedelta(minutes=5))

    assert catching_up is False
    assert since == NOW - mt5_worker._TRADE_SCAN_WINDOW


# ---------- 服务器时间 → UTC / server clock to UTC ----------

@pytest.fixture(autouse=True)
def _clean_offset_samples():
    """每个用例独立的观测状态。"""
    mt5_worker._utc_offset_samples.clear()
    yield
    mt5_worker._utc_offset_samples.clear()


def _epoch_now() -> float:
    return datetime.now(timezone.utc).timestamp()


def test_no_observation_falls_back_to_previous_behaviour():
    """还没有任何观测时偏移为 0——拿不准就不猜，维持旧语义。"""
    assert mt5_worker._utc_offset_seconds(LOGIN) == 0.0

    epoch = _epoch_now()
    assert mt5_worker._server_epoch_to_utc(epoch, LOGIN) == datetime.fromtimestamp(epoch, tz=timezone.utc)


def test_fresh_quote_reveals_the_broker_offset():
    """券商服务器跑在 UTC+3：一条新鲜报价就能把偏移定出来。"""
    mt5_worker._observe_utc_offset(_epoch_now() + 3 * 3600, LOGIN)

    assert mt5_worker._utc_offset_seconds(LOGIN) == 3 * 3600


def test_offset_is_rounded_to_half_hours():
    """报价有秒级抖动，取整到半小时后应当落在整点偏移上。"""
    mt5_worker._observe_utc_offset(_epoch_now() + 2 * 3600 + 7, LOGIN)

    assert mt5_worker._utc_offset_seconds(LOGIN) == 2 * 3600


def test_stale_quotes_cannot_drag_the_offset_down():
    """陈旧报价只会让时间戳偏小，所以取当日最大值——一条新鲜样本足以定调。

    这是整个换算的关键性质：没有它，停盘时段的陈旧报价会把偏移越拉越小。
    """
    mt5_worker._observe_utc_offset(_epoch_now() + 3 * 3600, LOGIN)          # 新鲜
    mt5_worker._observe_utc_offset(_epoch_now() + 3 * 3600 - 7200, LOGIN)   # 陈旧 2 小时

    assert mt5_worker._utc_offset_seconds(LOGIN) == 3 * 3600


def test_absurd_offsets_are_ignored():
    """周末停盘那种"陈旧到不可能是时区"的样本必须整体丢弃。"""
    mt5_worker._observe_utc_offset(_epoch_now() - 2 * 86400, LOGIN)

    assert mt5_worker._utc_offset_seconds(LOGIN) == 0.0


def test_deal_timestamp_is_shifted_back_to_real_utc():
    """成交时间换算：服务器 12:00（UTC+3）应当落成 UTC 09:00。

    没有这一步，月末最后几小时的平仓会被算进下个月，比赛起止也会错位。
    """
    mt5_worker._observe_utc_offset(_epoch_now() + 3 * 3600, LOGIN)

    server_noon = datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc).timestamp()
    got = mt5_worker._server_epoch_to_utc(server_noon, LOGIN)

    assert got == datetime(2026, 8, 26, 9, 0, tzinfo=timezone.utc)


def test_offsets_are_tracked_per_account():
    """一个进程连多个终端时，不同券商的时区不能互相串。

    合并统计会把偏移大的那家的时区套到另一家头上，把本来正确的时间改错。
    """
    other = "700999"
    mt5_worker._observe_utc_offset(_epoch_now() + 3 * 3600, LOGIN)   # 券商 A：UTC+3
    mt5_worker._observe_utc_offset(_epoch_now(), other)              # 券商 B：UTC+0

    assert mt5_worker._utc_offset_seconds(LOGIN) == 3 * 3600
    assert mt5_worker._utc_offset_seconds(other) == 0.0
