from datetime import datetime, timezone
from app.services.gamification.periods import (
    week_key, month_key, period_bounds, active_period_keys)

UTC = timezone.utc


def test_keys():
    dt = datetime(2026, 9, 2, 12, 0, tzinfo=UTC)      # 2026-09-02 是周三
    assert week_key(dt) == "2026-W36"
    assert month_key(dt) == "2026-09"
    # ISO 年边界：2027-01-01 是周五，属 2026 年第 53 周
    assert week_key(datetime(2027, 1, 1, tzinfo=UTC)) == "2026-W53"


def test_bounds_roundtrip():
    ws, we = period_bounds("2026-W36")
    assert ws == datetime(2026, 8, 31, tzinfo=UTC)     # 周一 00:00 UTC
    assert we == datetime(2026, 9, 7, tzinfo=UTC)
    ms, me = period_bounds("2026-09")
    assert ms == datetime(2026, 9, 1, tzinfo=UTC)
    assert me == datetime(2026, 10, 1, tzinfo=UTC)


def test_active_keys_include_grace_window():
    # 周一 10:00：上一周结束 10 小时，仍在 48h 重算窗
    now = datetime(2026, 9, 7, 10, 0, tzinfo=UTC)
    keys = active_period_keys(now)
    assert "2026-W37" in keys and "2026-W36" in keys and "2026-09" in keys
    # 周四：上一周已出窗
    now2 = datetime(2026, 9, 10, 10, 0, tzinfo=UTC)
    keys2 = active_period_keys(now2)
    assert "2026-W36" not in keys2 and "2026-W37" in keys2
    # 月界 + 48h：10-01 20:00 时 2026-09 仍在窗
    now3 = datetime(2026, 10, 1, 20, 0, tzinfo=UTC)
    assert "2026-09" in active_period_keys(now3) and "2026-10" in active_period_keys(now3)
