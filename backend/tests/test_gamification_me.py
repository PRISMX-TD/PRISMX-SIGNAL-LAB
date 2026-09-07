import pytest
from fastapi import HTTPException
from app.models import User, UserBadge
from app.routers.gamification import build_me_payload, _check_visible
from app.services.gamification.badges import BADGES
from app.services.settings_store import save_gamification_settings, invalidate_gamification_cache


def _user(db, role="user"):
    u = User(email=f"{role}@t.co", api_token="tok_" + role, role=role)
    db.add(u); db.commit(); return u


def test_payload_shape(db_session):
    u = _user(db_session)
    p = build_me_payload(db_session, u, judge=True)
    assert p["level"] == 1 and p["title"] == "novice"
    assert len(p["groups"]) == 5
    assert len(p["badges"]) == len(BADGES)        # 改制后：四枚进阶 + 两枚独立（后续任务再加五枚）
    by_id = {b["id"]: b for b in p["badges"]}
    assert by_id["founder_2026"]["shelf"] == "limited" and by_id["founder_2026"]["closesAt"].startswith("2027-01-01")
    assert by_id["starter"]["shelf"] == "tiered" and by_id["starter"]["closesAt"] is None
    assert p["winRate"]["windowDays"] == 365


def test_badge_owners_and_population(db_session):
    """详情层「全站拥有 N 人」：两个用户拥有 profile_complete，一个拥有
    first_close——owners 按勋章分别计数，未获得的勋章补零；population 是
    users 表总行数，不受 badge 归属影响。
    Detail-layer "N holders sitewide": two users own profile_complete, one
    owns first_close — owners is counted per badge, unowned badges zero-fill;
    population is the users table's row count, independent of badge ownership.
    """
    u1 = _user(db_session, role="u1")
    u2 = _user(db_session, role="u2")
    u3 = _user(db_session, role="u3")
    db_session.add_all([
        UserBadge(user_id=u1.id, badge_id="starter", tier=1),
        UserBadge(user_id=u2.id, badge_id="starter", tier=3),
        UserBadge(user_id=u3.id, badge_id="evergreen", tier=1),
    ])
    db_session.commit()

    p = build_me_payload(db_session, u1, judge=False)
    by_id = {b["id"]: b for b in p["badges"]}
    assert by_id["starter"]["owners"] == 2 and by_id["starter"]["tierOwners"] == [1, 0, 1]
    assert by_id["evergreen"]["owners"] == 1
    assert by_id["founder_2026"]["owners"] == 0 and by_id["founder_2026"]["tierOwners"] == []  # 未获得：0，不是缺键
    assert by_id["starter"]["tier"] == 1 and by_id["starter"]["earned"] and by_id["starter"]["maxTier"] == 3
    assert by_id["evergreen"]["tier"] == 0 and not by_id["evergreen"]["earned"]
    assert p["population"] == 3


def test_judge_throttled(db_session, monkeypatch):
    import app.routers.gamification as G
    calls = []
    monkeypatch.setattr(G, "judge_and_record_conditions",
                        lambda db, uid: calls.append(uid) or [])
    monkeypatch.setattr(G, "judge_and_award_badges", lambda db, uid: [])
    u = _user(db_session, role="t2")
    build_me_payload(db_session, u, judge=True)
    build_me_payload(db_session, u, judge=True)   # 60 秒内第二次：只读
    assert len(calls) == 1


def test_visibility_gate(db_session):
    invalidate_gamification_cache()
    u = _user(db_session, role="plain")
    with pytest.raises(HTTPException) as e:
        _check_visible(db_session, u)
    assert e.value.status_code == 403
    admin = _user(db_session, role="admin")
    _check_visible(db_session, admin)             # admin 直通不抛
    save_gamification_settings(db_session, {"user_visible": True})
    db_session.commit(); invalidate_gamification_cache()
    _check_visible(db_session, u)                 # 开关开了不抛
