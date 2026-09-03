import pytest
from fastapi import HTTPException

from app.models import User
from app.routers.gamification import admin_get_settings, admin_patch_settings, admin_leaderboard
from app.schemas import GamificationSettingsPatchIn
from app.services.settings_store import get_gamification_settings, invalidate_gamification_cache


def test_settings_roundtrip_partial(db_session):
    # 进程级设置缓存 30 秒 TTL，跨测试文件共享——先失效一次，避免读到别的用例
    # 留下的残值（同其它设置测试文件的一贯写法）。
    # The settings cache is process-global with a 30s TTL, shared across test
    # files — invalidate first so we don't read a value left behind by
    # another test (same convention every other settings test file follows).
    invalidate_gamification_cache()
    s = admin_get_settings(db=db_session)
    assert s == {"userVisible": False, "leaderboardVisible": False,
                 "competitionsVisible": False, "minBaselineUsd": 500.0,
                 "minTradesReturn": 5, "minTradesWinrate": 20}
    admin_patch_settings(GamificationSettingsPatchIn(leaderboardVisible=True), db=db_session)
    invalidate_gamification_cache()
    got = get_gamification_settings(db_session)
    assert got["leaderboard_visible"] is True and got["user_visible"] is False
    assert got["min_baseline_usd"] == 500.0        # 未传字段不动
    assert got["min_trades_return"] == 5 and got["min_trades_winrate"] == 20


def test_min_baseline_validation(db_session):
    with pytest.raises(HTTPException):
        admin_patch_settings(GamificationSettingsPatchIn(minBaselineUsd=0), db=db_session)


def test_min_trades_validation(db_session):
    with pytest.raises(HTTPException):
        admin_patch_settings(GamificationSettingsPatchIn(minTradesReturn=0), db=db_session)
    with pytest.raises(HTTPException):
        admin_patch_settings(GamificationSettingsPatchIn(minTradesWinrate=0), db=db_session)


def test_min_trades_roundtrip(db_session):
    invalidate_gamification_cache()
    admin_patch_settings(GamificationSettingsPatchIn(minTradesReturn=1, minTradesWinrate=2),
                          db=db_session)
    invalidate_gamification_cache()
    got = get_gamification_settings(db_session)
    assert got["min_trades_return"] == 1 and got["min_trades_winrate"] == 2


def test_admin_preview_ignores_user_gate(db_session):
    a = User(email="ap@t.co", api_token="tok_ap", role="admin")
    db_session.add(a); db_session.commit()
    p = admin_leaderboard(board="return_pct", period="week", db=db_session, admin=a)
    assert p["rows"] == [] and "periodKey" in p     # 开关关着也能预览
