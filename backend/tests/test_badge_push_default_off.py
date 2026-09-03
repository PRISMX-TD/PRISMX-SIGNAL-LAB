"""badge_awarded 推送事件：NULL 偏好行默认关闭，需显式 opt-in。
badge_awarded push event: a NULL prefs row defaults it OFF, requiring
explicit opt-in (unlike every other event type, which stays default-on)."""
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.gamification.badges import BADGES, award_badge
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


def test_all_badges_have_a_display_name():
    """每个 BADGES 条目都要有非空 name，否则推送正文会回落成原始 id
    （见 award_badge 的 fallback），用户根本看不懂"你解锁了勋章「first_close」"。
    Every BADGES entry needs a non-empty name — otherwise push copy falls back
    to the raw id (see award_badge's fallback), leaving a user staring at
    something like "you unlocked badge 'first_close'"."""
    for badge_id, meta in BADGES.items():
        assert meta.get("name"), f"{badge_id} missing a display name"


def test_badge_names_mirror_zh_json():
    """BADGES 的中文 name 与 zh.json 的 gamification.badges.<id>.name 必须字字
    一致——推送正文（award_badge）用的是 BADGES['name']，前端页面用的是 i18n
    key，两处各改各的很容易改岔。缺文件（例如独立跑 backend 测试、没有拉全
    仓库）就跳过而不是判失败。
    BADGES' Chinese name must mirror zh.json's gamification.badges.<id>.name
    byte-for-byte — push copy (award_badge) reads BADGES['name'] while the
    frontend reads the i18n key, and the two are easy to edit independently
    and let drift. Skip (not fail) when the file is absent, e.g. running the
    backend tests standalone without the full monorepo checkout."""
    zh_path = Path(__file__).resolve().parents[2] / "frontend" / "src" / "i18n" / "zh.json"
    if not zh_path.exists():
        pytest.skip(f"frontend/src/i18n/zh.json not found at {zh_path}; skipping mirror check")

    zh = json.loads(zh_path.read_text(encoding="utf-8"))
    zh_badges = zh["gamification"]["badges"]

    assert set(BADGES.keys()) == set(zh_badges.keys()), "badge id set diverged between BADGES and zh.json"
    for badge_id, meta in BADGES.items():
        assert meta.get("name") == zh_badges[badge_id]["name"], (
            f"{badge_id}: BADGES name {meta.get('name')!r} != zh.json name {zh_badges[badge_id]['name']!r}"
        )


def test_award_badge_push_uses_display_name_not_raw_id(db_session):
    """award_badge 推送正文要含勋章中文名，不能含原始 badge_id。"""
    from app.models import User

    user = User(email="badge-push@example.com", api_token="tok_badge_push")
    db_session.add(user)
    db_session.commit()

    badge_id = "first_close"
    expected_name = BADGES[badge_id]["name"]

    with patch("app.services.push_dispatch.dispatch_event_push") as mock_push:
        assert award_badge(db_session, user.id, badge_id) is True

    assert mock_push.call_count == 1
    args = mock_push.call_args[0]
    title, body = args[2], args[3]
    assert expected_name in body
    assert badge_id not in body
    assert badge_id not in title
