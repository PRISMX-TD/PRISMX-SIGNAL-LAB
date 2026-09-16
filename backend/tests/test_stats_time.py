"""看板的时区与时间范围口径。全部按 STATS_TZ 切天，预设由后端解析。"""
from datetime import date, datetime, timezone

import pytest

from app.core.config import settings
from app.services.stats_time import (
    MAX_RANGE_DAYS, RangeError, RangeSpec, day_start_utc, local_day, resolve_range,
)


@pytest.fixture(autouse=True)
def _beijing(monkeypatch):
    monkeypatch.setattr(settings, "STATS_TZ", "Asia/Shanghai")


def test_local_day_shifts_late_utc_into_next_day():
    # UTC 9/15 23:30 = 北京 9/16 07:30
    assert local_day(datetime(2026, 9, 15, 23, 30, tzinfo=timezone.utc)) == date(2026, 9, 16)
    # naive 视为 UTC
    assert local_day(datetime(2026, 9, 15, 23, 30)) == date(2026, 9, 16)
    assert local_day(datetime(2026, 9, 15, 10, 0)) == date(2026, 9, 15)


def test_day_start_utc_is_naive_utc_of_local_midnight():
    # 北京 9/16 00:00 = UTC 9/15 16:00
    assert day_start_utc(date(2026, 9, 16)) == datetime(2026, 9, 15, 16, 0)
    assert day_start_utc(date(2026, 9, 16)).tzinfo is None


TODAY = date(2026, 9, 16)  # 周三


@pytest.mark.parametrize("preset,start,end", [
    ("week", date(2026, 9, 14), TODAY),            # 周一起
    ("month", date(2026, 9, 1), TODAY),
    ("last_month", date(2026, 8, 1), date(2026, 8, 31)),
    ("quarter", date(2026, 7, 1), TODAY),
    ("year", date(2026, 1, 1), TODAY),
])
def test_presets(preset, start, end):
    spec = resolve_range(preset, None, None, TODAY)
    assert (spec.start, spec.end) == (start, end)


def test_last_month_across_new_year():
    spec = resolve_range("last_month", None, None, date(2026, 1, 5))
    assert (spec.start, spec.end) == (date(2025, 12, 1), date(2025, 12, 31))


def test_week_on_a_monday_is_a_single_day():
    spec = resolve_range("week", None, None, date(2026, 9, 14))
    assert (spec.start, spec.end) == (date(2026, 9, 14), date(2026, 9, 14))
    assert spec.days == 1


def test_compare_period_is_same_length_immediately_before():
    spec = resolve_range("month", None, None, TODAY)  # 9/1..9/16 共 16 天
    assert spec.days == 16
    assert (spec.compare_start, spec.compare_end) == (date(2026, 8, 16), date(2026, 8, 31))


def test_custom_range_wins_over_preset_and_default_is_month():
    spec = resolve_range("year", date(2026, 9, 10), date(2026, 9, 12), TODAY)
    assert (spec.start, spec.end) == (date(2026, 9, 10), date(2026, 9, 12))
    assert resolve_range(None, None, None, TODAY).start == date(2026, 9, 1)


def test_day_keys_are_contiguous_iso_dates():
    spec = RangeSpec(date(2026, 9, 14), date(2026, 9, 16), date(2026, 9, 11), date(2026, 9, 13))
    assert spec.day_keys() == ["2026-09-14", "2026-09-15", "2026-09-16"]


@pytest.mark.parametrize("start,end", [
    (date(2026, 9, 12), date(2026, 9, 10)),       # 起晚于止
    (date(2026, 9, 10), date(2026, 9, 17)),       # 止在未来
    (date(2025, 8, 1), date(2026, 9, 16)),        # 超过 400 天
])
def test_invalid_custom_ranges_raise(start, end):
    with pytest.raises(RangeError):
        resolve_range(None, start, end, TODAY)


def test_exactly_max_days_is_allowed():
    end = TODAY
    start = date.fromordinal(end.toordinal() - (MAX_RANGE_DAYS - 1))
    assert resolve_range(None, start, end, TODAY).days == MAX_RANGE_DAYS


def test_unknown_preset_raises():
    with pytest.raises(RangeError):
        resolve_range("fortnight", None, None, TODAY)
