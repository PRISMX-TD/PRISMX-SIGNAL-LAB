import pytest
from fastapi import HTTPException

from app.models import User
from app.routers.gamification import admin_inspect_user, admin_set_visibility
from app.schemas import VisibilityPatchIn
from app.services.settings_store import get_gamification_settings, invalidate_gamification_cache


def test_inspector_returns_target_payload(db_session):
    t = User(email="target@t.co", api_token="tok_t"); db_session.add(t); db_session.commit()
    p = admin_inspect_user(t.id, db=db_session)
    assert p["email"] == "target@t.co" and p["level"] == 1 and len(p["badges"]) == 17


def test_inspector_404_when_user_missing(db_session):
    with pytest.raises(HTTPException) as e:
        admin_inspect_user("does-not-exist", db=db_session)
    assert e.value.status_code == 404


def test_visibility_toggle(db_session):
    admin_set_visibility(VisibilityPatchIn(userVisible=True), db=db_session)
    invalidate_gamification_cache()
    assert get_gamification_settings(db_session)["user_visible"] is True
