"""badge_awarded 推送事件：2026-09-07 起与账户 / 交易事件同一待遇——通知总开关
开了就推，不看事件白名单（push_dispatch.ALWAYS_ON_EVENTS）；此前是 opt-in。
badge_awarded push event: since 2026-09-07 it fires whenever notifications are
on, bypassing the per-event whitelist like the account/trading events (it used
to be opt-in)."""
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.gamification.badges import BADGES, award_badge
from app.models import NotificationPref
from app.services.push_dispatch import (
    ALWAYS_ON_EVENTS,
    EVENT_BADGE_AWARDED,
    EVENT_ORDER_FILLED,
    EVENT_STRATEGY_SIGNAL,
    EVENT_TYPES,
    _event_prefs_allow,
    _parse_event_types,
)


def test_null_means_every_event_on():
    assert EVENT_BADGE_AWARDED in EVENT_TYPES
    assert _parse_event_types(None) == set(EVENT_TYPES)


def test_empty_list_still_all_off_for_the_whitelist():
    assert _parse_event_types("[]") == set()


def test_always_on_events_are_everything_but_strategy_signal():
    assert ALWAYS_ON_EVENTS == set(EVENT_TYPES) - {EVENT_STRATEGY_SIGNAL}
    assert EVENT_BADGE_AWARDED in ALWAYS_ON_EVENTS and EVENT_ORDER_FILLED in ALWAYS_ON_EVENTS


def test_unticked_account_and_badge_events_still_push(db_session):
    """老用户以前勾掉的账户 / 成就事件照推；strategy_signal 仍看白名单。
    Events unticked back when the toggles existed still push; strategy_signal
    still honours the whitelist."""
    from app.models import User
    user = User(email="always-on@example.com", api_token="tok_always_on", plan="PRO")
    db_session.add(user)
    db_session.commit()
    db_session.add(NotificationPref(user_id=user.id, enabled=True, event_types='["order_rejected"]'))
    db_session.commit()
    with patch("app.services.push_dispatch.can_use_push", return_value=True):
        assert _event_prefs_allow(db_session, user.id, EVENT_ORDER_FILLED) is True
        assert _event_prefs_allow(db_session, user.id, EVENT_BADGE_AWARDED) is True
        assert _event_prefs_allow(db_session, user.id, EVENT_STRATEGY_SIGNAL) is False

    pref = db_session.query(NotificationPref).filter(NotificationPref.user_id == user.id).one()
    pref.enabled = False
    db_session.commit()
    with patch("app.services.push_dispatch.can_use_push", return_value=True):
        assert _event_prefs_allow(db_session, user.id, EVENT_ORDER_FILLED) is False, "总开关关了就全关 / master switch off"


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

    badge_id = "starter"
    expected_name = BADGES[badge_id]["name"] + " · 银"      # 进阶勋章的推送名带档位

    with patch("app.services.push_dispatch.dispatch_event_push") as mock_push:
        assert award_badge(db_session, user.id, badge_id, 2) is True

    assert mock_push.call_count == 1
    args = mock_push.call_args[0]
    title, body = args[2], args[3]
    assert expected_name in body
    assert badge_id not in body
    assert badge_id not in title
