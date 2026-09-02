import pytest
from fastapi import HTTPException
from app.models import User
from app.routers.gamification import build_me_payload, _check_visible
from app.services.settings_store import save_gamification_settings, invalidate_gamification_cache


def _user(db, role="user"):
    u = User(email=f"{role}@t.co", api_token="tok_" + role, role=role)
    db.add(u); db.commit(); return u


def test_payload_shape(db_session):
    u = _user(db_session)
    p = build_me_payload(db_session, u, judge=True)
    assert p["level"] == 1 and p["title"] == "novice"
    assert len(p["groups"]) == 5
    assert len(p["badges"]) == 17
    assert p["winRate"]["windowDays"] == 365


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
