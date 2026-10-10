"""重启后整趟 pass 不急着补：上一趟（同一套规则）不到一小时就接着原来的节奏等。
After a restart the hourly pass keeps its rhythm instead of running 25s in, unless
there is no watermark under the current rules."""
from datetime import datetime, timedelta, timezone

from app.services.gamification import loop as gloop


def test_recent_pass_waits_out_the_rest_of_the_hour(monkeypatch):
    now = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(gloop, "_load_watermarks", lambda: (now - timedelta(minutes=10), None))
    assert gloop._seconds_until_due(now) == gloop.LOOP_INTERVAL_SECONDS - 600


def test_no_watermark_runs_now(monkeypatch):
    monkeypatch.setattr(gloop, "_load_watermarks", lambda: (None, None))
    assert gloop._seconds_until_due() == 0.0


def test_clock_stepped_back_never_waits_more_than_one_interval(monkeypatch):
    now = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(gloop, "_load_watermarks", lambda: (now + timedelta(hours=3), None))
    assert gloop._seconds_until_due(now) == gloop.LOOP_INTERVAL_SECONDS


def test_overdue_pass_runs_now(monkeypatch):
    now = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(gloop, "_load_watermarks", lambda: (now - timedelta(hours=2), None))
    assert gloop._seconds_until_due(now) == 0.0
