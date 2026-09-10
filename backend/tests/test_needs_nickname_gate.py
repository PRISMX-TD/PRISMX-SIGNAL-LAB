"""昵称全员必填的守卫标记（2026-09-10）。

前端的 Protected 只读 needsNickname 一个字段就决定拦不拦人，所以这里盯死它的
口径：**没有豁免列**——手机号那次靠 phone_required 放过了存量用户，昵称这次是
「空即是欠」，老账号一样要补。以及空白不算填过，否则敲三个空格就能绕过守卫。

The guard flag behind "everyone must set a nickname". The frontend's Protected
gates on this single field, so its definition is pinned here: unlike the phone
rollout there is no grandfathering column — empty simply means owed — and
whitespace doesn't count as set, or three spaces would walk past the guard.
"""
from app.models import User
from app.routers.account import _apply_profile_patch
from app.routers.auth import _user_out
from app.schemas import ProfilePatchIn


def test_user_without_nickname_owes_one(db_session):
    u = User(email="nn1@t.co", api_token="tok_nn1")
    db_session.add(u); db_session.commit()
    assert _user_out(u).needsNickname is True


def test_whitespace_nickname_still_owes_one(db_session):
    u = User(email="nn2@t.co", api_token="tok_nn2", nickname="   ")
    db_session.add(u); db_session.commit()
    assert _user_out(u).needsNickname is True


def test_setting_a_nickname_clears_the_flag(db_session):
    u = User(email="nn3@t.co", api_token="tok_nn3")
    db_session.add(u); db_session.commit()
    _apply_profile_patch(db_session, u, ProfilePatchIn(nickname="Kestrel"))
    assert _user_out(u).needsNickname is False


def test_no_grandfathering_column(db_session):
    """存量用户不豁免：phone_required=False 的老账号照样欠昵称。

    这条是防回归的——如果哪天有人照抄手机号那套给昵称加豁免，这里会红。
    """
    u = User(email="nn4@t.co", api_token="tok_nn4", phone_required=False, phone="+60123456789")
    db_session.add(u); db_session.commit()
    out = _user_out(u)
    assert out.needsPhone is False and out.needsNickname is True
