import pytest
from fastapi import HTTPException
from app.models import User, UserBadge
from app.routers.account import _apply_profile_patch
from app.schemas import ProfilePatchIn


def _user(db):
    u = User(email="pp@t.co", api_token="tok_pp"); db.add(u); db.commit(); return u


def test_nickname_set_and_validate(db_session):
    u = _user(db_session)
    _apply_profile_patch(db_session, u, ProfilePatchIn(nickname="  Trader  "))
    assert u.nickname == "Trader"
    with pytest.raises(HTTPException):
        _apply_profile_patch(db_session, u, ProfilePatchIn(nickname="x"))       # 太短
    with pytest.raises(HTTPException):
        _apply_profile_patch(db_session, u, ProfilePatchIn(nickname="PRISMX官方"))  # 保留词


def test_equip_requires_ownership(db_session):
    u = _user(db_session)
    with pytest.raises(HTTPException):
        _apply_profile_patch(db_session, u, ProfilePatchIn(equippedBadge="first_close"))
    db_session.add(UserBadge(user_id=u.id, badge_id="first_close")); db_session.commit()
    _apply_profile_patch(db_session, u, ProfilePatchIn(equippedBadge="first_close"))
    assert u.equipped_badge == "first_close"
    _apply_profile_patch(db_session, u, ProfilePatchIn(equippedBadge=None))
    assert u.equipped_badge is None  # 显式 null = 卸下


def test_partial_patch_only_touches_sent_fields(db_session):
    u = _user(db_session)
    _apply_profile_patch(db_session, u, ProfilePatchIn(nickname="Trader"))
    _apply_profile_patch(db_session, u, ProfilePatchIn(leaderboardOptOut=True))
    assert u.nickname == "Trader" and u.leaderboard_opt_out is True
