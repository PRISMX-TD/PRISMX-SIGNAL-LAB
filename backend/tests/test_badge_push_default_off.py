"""badge_awarded 推送事件：NULL 偏好行默认关闭，需显式 opt-in。
badge_awarded push event: a NULL prefs row defaults it OFF, requiring
explicit opt-in (unlike every other event type, which stays default-on)."""
from app.services.push_dispatch import _parse_event_types, EVENT_TYPES, EVENT_BADGE_AWARDED


def test_null_means_all_on_except_badge():
    allowed = _parse_event_types(None)
    assert EVENT_BADGE_AWARDED in EVENT_TYPES
    assert EVENT_BADGE_AWARDED not in allowed
    assert allowed == set(EVENT_TYPES) - {EVENT_BADGE_AWARDED}


def test_empty_list_still_all_off():
    assert _parse_event_types("[]") == set()


def test_explicit_opt_in_works():
    assert EVENT_BADGE_AWARDED in _parse_event_types(f'["{EVENT_BADGE_AWARDED}"]')
