import pytest
from fastapi import HTTPException
from app.models import User, UserBadge
from app.routers.account import _apply_profile_patch
from app.schemas import ProfilePatchIn
from app.services.gamification import EQUIP_SLOTS, equipped_list, set_equipped_list


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


def _own(db, u, *ids):
    for b in ids:
        db.add(UserBadge(user_id=u.id, badge_id=b))
    db.commit()


def test_equip_three_badges_first_is_default(db_session):
    u = _user(db_session)
    _own(db_session, u, "first_close", "first_real", "profile_done")
    _apply_profile_patch(db_session, u, ProfilePatchIn(
        equippedBadges=["first_real", "profile_done", "first_close"]))
    assert equipped_list(u) == ["first_real", "profile_done", "first_close"]
    assert u.equipped_badge == "first_real"          # 首枚 = 榜单上那枚默认
    # 换默认 = 换顺序，不改集合 / changing the default is a reorder, not a set change
    _apply_profile_patch(db_session, u, ProfilePatchIn(
        equippedBadges=["profile_done", "first_real", "first_close"]))
    assert u.equipped_badge == "profile_done"


def test_equip_list_limits_and_ownership(db_session):
    u = _user(db_session)
    _own(db_session, u, "first_close", "first_real", "profile_done")
    with pytest.raises(HTTPException):                # 超过槽位
        _apply_profile_patch(db_session, u, ProfilePatchIn(
            equippedBadges=["first_close", "first_real", "profile_done", "founder"]))
    with pytest.raises(HTTPException):                # 其中一枚未获得
        _apply_profile_patch(db_session, u, ProfilePatchIn(
            equippedBadges=["first_close", "founder"]))
    assert equipped_list(u) == []                     # 整条请求失败，一枚都没戴上
    _apply_profile_patch(db_session, u, ProfilePatchIn(equippedBadges=["first_close"]))
    _apply_profile_patch(db_session, u, ProfilePatchIn(equippedBadges=[]))
    assert equipped_list(u) == [] and u.equipped_badge is None   # 空列表 = 全部卸下


def test_legacy_single_field_still_equips_one(db_session):
    """旧前端只发 equippedBadge，语义等价于「列表里只有这一枚」。
    An old client sends only equippedBadge; it means a one-item list."""
    u = _user(db_session)
    _own(db_session, u, "first_close", "first_real")
    _apply_profile_patch(db_session, u, ProfilePatchIn(
        equippedBadges=["first_close", "first_real"]))
    _apply_profile_patch(db_session, u, ProfilePatchIn(equippedBadge="first_real"))
    assert equipped_list(u) == ["first_real"] and u.equipped_badge == "first_real"
    _apply_profile_patch(db_session, u, ProfilePatchIn(equippedBadge=None))
    assert equipped_list(u) == [] and u.equipped_badge is None


def test_equipped_list_falls_back_to_legacy_column(db_session):
    """迁移回填跑之前（新列为空、旧列有值）也要读出正确结果。
    Rows read correctly before the backfill runs: new column empty, old one set."""
    u = _user(db_session)
    u.equipped_badges = None
    u.equipped_badge = "founder"
    assert equipped_list(u) == ["founder"]


def test_set_equipped_list_dedupes_and_caps(db_session):
    u = _user(db_session)
    kept = set_equipped_list(u, ["a", "a", "b", "c", "d", "", "e"])
    assert kept == ["a", "b", "c"] and len(kept) == EQUIP_SLOTS
    assert u.equipped_badges == "a,b,c" and u.equipped_badge == "a"
