"""推送时段与事件白名单默认值的单元测试。
Unit tests for the push time-window and the event-whitelist defaults.

_within_push_window 是纯函数式判定（传入 pref 行 + 固定的 now），不需要数据库；
_parse_event_types 同理。涉及偏好行的用例用 conftest 的内存 SQLite。
_within_push_window is a pure check (pref row + a pinned "now"), no DB needed;
same for _parse_event_types. Cases touching pref rows use conftest's in-memory
SQLite.
"""
from datetime import datetime, timezone

from app.models import NotificationPref
from app.services.push_dispatch import (
    EVENT_TYPES,
    _event_prefs_allow,
    _parse_event_types,
    _within_push_window,
)


def _pref(start=None, end=None, tz=None) -> NotificationPref:
    return NotificationPref(
        user_id="u1",
        enabled=True,
        push_window_start=start,
        push_window_end=end,
        push_window_tz=tz,
    )


# UTC 2026-08-19 12:30 —— 上海时间 20:30 / Shanghai 20:30
NOON_UTC = datetime(2026, 8, 19, 12, 30, tzinfo=timezone.utc)


class TestWithinPushWindow:
    def test_no_window_means_unrestricted(self):
        assert _within_push_window(_pref(), NOON_UTC)

    def test_half_set_window_is_unrestricted(self):
        assert _within_push_window(_pref(start="08:00"), NOON_UTC)
        assert _within_push_window(_pref(end="22:00"), NOON_UTC)

    def test_malformed_values_are_unrestricted(self):
        assert _within_push_window(_pref(start="8:00", end="22:00"), NOON_UTC)
        assert _within_push_window(_pref(start="08:00", end="25:00"), NOON_UTC)
        assert _within_push_window(_pref(start="abc", end="def"), NOON_UTC)

    def test_equal_bounds_are_unrestricted(self):
        assert _within_push_window(_pref(start="09:00", end="09:00"), NOON_UTC)

    def test_normal_range_utc(self):
        # 12:30 UTC 在 08:00–22:00 内 / inside
        assert _within_push_window(_pref(start="08:00", end="22:00"), NOON_UTC)
        # 12:30 UTC 在 13:00–22:00 外 / outside
        assert not _within_push_window(_pref(start="13:00", end="22:00"), NOON_UTC)

    def test_range_respects_timezone(self):
        # 上海 20:30：08:00–21:00 内，08:00–20:00 外。
        # Shanghai 20:30: inside 08:00–21:00, outside 08:00–20:00.
        assert _within_push_window(
            _pref(start="08:00", end="21:00", tz="Asia/Shanghai"), NOON_UTC
        )
        assert not _within_push_window(
            _pref(start="08:00", end="20:00", tz="Asia/Shanghai"), NOON_UTC
        )

    def test_invalid_timezone_falls_back_to_utc(self):
        # 12:30 UTC 在 08:00–22:00 内；时区无效时按 UTC 判定而不是抛异常。
        # Invalid tz falls back to UTC instead of raising.
        assert _within_push_window(
            _pref(start="08:00", end="22:00", tz="Not/AZone"), NOON_UTC
        )

    def test_overnight_wrap(self):
        # 22:00–07:00：上海 20:30 在时段外，23:30（UTC 15:30）在时段内。
        # Overnight 22:00–07:00: Shanghai 20:30 is outside, 23:30 inside.
        pref = _pref(start="22:00", end="07:00", tz="Asia/Shanghai")
        assert not _within_push_window(pref, NOON_UTC)
        late = datetime(2026, 8, 19, 15, 30, tzinfo=timezone.utc)  # 上海 23:30
        assert _within_push_window(pref, late)
        early = datetime(2026, 8, 19, 22, 0, tzinfo=timezone.utc)  # 上海次日 06:00
        assert _within_push_window(pref, early)

    def test_boundaries_start_inclusive_end_exclusive(self):
        pref = _pref(start="12:30", end="13:00")
        assert _within_push_window(pref, NOON_UTC)  # 恰好 start / exactly start
        at_end = datetime(2026, 8, 19, 13, 0, tzinfo=timezone.utc)
        assert not _within_push_window(pref, at_end)  # 恰好 end / exactly end


class TestParseEventTypes:
    def test_null_means_all_on(self):
        # NULL = 从未配置 → 默认全部开启 / never configured → all on
        assert _parse_event_types(None) == set(EVENT_TYPES)

    def test_empty_list_means_all_off(self):
        assert _parse_event_types("[]") == set()

    def test_unknown_entries_dropped(self):
        assert _parse_event_types('["order_filled", "bogus"]') == {"order_filled"}

    def test_garbage_means_all_off(self):
        assert _parse_event_types("not json") == set()
        assert _parse_event_types('{"a": 1}') == set()


class TestEventPrefsAllow:
    def _user(self, db_session, plan="PRO"):
        from app.models import User

        u = User(email="t@example.com", password_hash="x", api_token="tok-t", plan=plan)
        db_session.add(u)
        db_session.commit()
        return u

    def test_null_event_types_allows_all(self, db_session):
        u = self._user(db_session)
        db_session.add(NotificationPref(user_id=u.id, enabled=True, event_types=None))
        db_session.commit()
        assert _event_prefs_allow(db_session, u.id, "order_filled")
        assert _event_prefs_allow(db_session, u.id, "strategy_signal")

    def test_explicit_empty_blocks(self, db_session):
        u = self._user(db_session)
        db_session.add(NotificationPref(user_id=u.id, enabled=True, event_types="[]"))
        db_session.commit()
        assert not _event_prefs_allow(db_session, u.id, "order_filled")

    def test_window_blocks_event_push(self, db_session):
        u = self._user(db_session)
        # 只允许 00:00–00:01 推送，"现在"几乎必然在时段外。
        # A 00:00–00:01 window is all but guaranteed to exclude "now".
        db_session.add(
            NotificationPref(
                user_id=u.id,
                enabled=True,
                event_types=None,
                push_window_start="00:00",
                push_window_end="00:01",
                push_window_tz="UTC",
            )
        )
        db_session.commit()
        now = datetime.now(timezone.utc)
        inside = now.hour == 0 and now.minute == 0
        assert _event_prefs_allow(db_session, u.id, "order_filled") == inside
